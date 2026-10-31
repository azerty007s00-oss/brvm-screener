import "server-only";
import { db } from "./db";
import { avecTables } from "./tables-auto";
import { reglagesEffectifs } from "./queries";
import { ROLES, type Role } from "./settings";
import { STATUT_VERSEMENT } from "./valeurs";
import { numeroRecu, payeALHeure, type DonneesRecu } from "./recu";

/** La note des lignes reprises de l'ancien registre : marquees payees, sans versement a recevoir. */
const REPRISE = "Reprise de l'historique";

/** Le meme texte que scripts/migration-recus.sql. */
const TABLES = [
  `create table if not exists receipt_numbers (
    lot        text primary key,
    year       int not null,
    rank       int not null,
    created_at timestamptz not null default now(),
    unique (year, rank)
  )`,
];

/**
 * Le numero de recu de chaque lot valide : son rang dans l'annee de sa
 * validation (a defaut, de sa saisie). Il est attribue une fois pour toutes,
 * aux lots qui n'en ont pas encore, dans l'ordre des validations : un recu
 * garde son numero, meme si un versement anterieur est annule ensuite. Les
 * lignes reprises de l'ancien registre n'ont pas de recu.
 */
export async function numerosRecus(lots: string[]): Promise<Map<string, string>> {
  if (lots.length === 0) return new Map();
  const sql = db();
  const attribuer = () => sql`
    insert into receipt_numbers (lot, year, rank)
    select v.lot, v.annee,
           coalesce((select max(r.rank) from receipt_numbers r where r.year = v.annee), 0)
             + row_number() over (partition by v.annee order by v.vise, v.lot)
    from (
      select coalesce(c.batch_id, c.id)::text as lot,
             extract(year from min(coalesce(c.reviewed_at, c.created_at)) at time zone 'UTC')::int as annee,
             min(coalesce(c.reviewed_at, c.created_at)) as vise
      from contributions c
      where c.status = ${STATUT_VERSEMENT.valide} and c.note is distinct from ${REPRISE}
        and not exists (select 1 from receipt_numbers r where r.lot = coalesce(c.batch_id, c.id)::text)
      group by 1
    ) v
    on conflict do nothing
  `;
  await avecTables(TABLES, attribuer).catch(() => attribuer());
  const rows = await sql`select lot, year, rank from receipt_numbers where lot = any(${lots}::text[])`;
  return new Map(rows.map((r) => [String(r.lot), numeroRecu(Number(r.year), Number(r.rank))]));
}

/**
 * Le recu de ces lots (un versement, ou plusieurs valides d'un geste), si
 * `lecteur` peut le lire : le membre, le detenteur de sa part, ou le bureau
 * qui valide. Null sinon, ou si rien n'est valide.
 */
export async function donneesRecu(
  lots: string[],
  lecteur: { id: string; peutValider: boolean },
): Promise<DonneesRecu | null> {
  if (lots.length === 0 || lots.length > 40 || !lots.every((l) => /^[0-9a-f-]{36}$/i.test(l))) return null;
  const sql = db();
  const rows = await sql`
    select c.member_id::text as membre_id, m.full_name as membre, m.holder_id::text as detenteur_id, h.full_name as detenteur,
           to_char(c.period, 'YYYY-MM-DD') as mois, c.amount as montant, to_char(c.paid_on, 'YYYY-MM-DD') as paye_le,
           c.method as mode, c.reference, c.note,
           to_char(coalesce(c.reviewed_at, c.created_at) at time zone 'UTC', 'YYYY-MM-DD') as vise_le, coalesce(batch_id, c.id)::text as lot,
           r.full_name as valide_par, r.role as role_valideur
    from contributions c
    join members m on m.id = c.member_id
    left join members h on h.id = m.holder_id
    left join members r on r.id = c.reviewed_by
    where coalesce(c.batch_id, c.id)::text = any(${lots}::text[]) and c.status = ${STATUT_VERSEMENT.valide}
    order by c.period
  `.catch(() => sql`
    select c.member_id::text as membre_id, m.full_name as membre, null as detenteur_id, null as detenteur,
           to_char(c.period, 'YYYY-MM-DD') as mois, c.amount as montant, to_char(c.paid_on, 'YYYY-MM-DD') as paye_le,
           c.method as mode, c.reference, c.note,
           to_char(coalesce(c.reviewed_at, c.created_at) at time zone 'UTC', 'YYYY-MM-DD') as vise_le, coalesce(batch_id, c.id)::text as lot,
           r.full_name as valide_par, r.role as role_valideur
    from contributions c
    join members m on m.id = c.member_id
    left join members r on r.id = c.reviewed_by
    where coalesce(c.batch_id, c.id)::text = any(${lots}::text[]) and c.status = ${STATUT_VERSEMENT.valide}
    order by c.period
  `);
  if (rows.length === 0 || rows.some((r) => r.note === REPRISE)) return null;
  /* Un recu ne couvre qu'un membre : des lots melanges ne font pas un recu. */
  const v = rows[0];
  if (rows.some((r) => r.membre_id !== v.membre_id)) return null;
  const lecteurAutorise = lecteur.peutValider || v.membre_id === lecteur.id || v.detenteur_id === lecteur.id;
  if (!lecteurAutorise) return null;

  const [numeros, reglages] = await Promise.all([numerosRecus([...new Set(rows.map((r) => String(r.lot)))].sort()), reglagesEffectifs()]);
  const premier = [...numeros.values()].sort()[0];
  if (!premier) return null;
  const mois = rows.map((r) => String(r.mois));
  const payeLe = rows.map((r) => String(r.paye_le)).sort().at(-1)!;
  return {
    numero: premier,
    valideLe: rows.map((r) => String(r.vise_le)).sort().at(-1)!,
    membre: String(v.membre),
    mois,
    montant: rows.reduce((t, r) => t + Number(r.montant), 0),
    payeLe,
    mode: String(v.mode),
    reference: v.reference === null ? null : String(v.reference),
    aLHeure: payeALHeure(mois, payeLe, reglages.jourEcheance),
    validePar: v.valide_par === null ? null : String(v.valide_par),
    qualite: v.role_valideur && v.role_valideur !== "membre" ? (ROLES[v.role_valideur as Role] ?? null) : null,
    detenteur: v.detenteur ? String(v.detenteur) : null,
  };
}
