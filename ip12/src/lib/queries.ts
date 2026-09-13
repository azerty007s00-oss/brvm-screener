import "server-only";
import { db } from "./db";
import { CLUB, REGLES, debutMois, moisDuClub } from "./settings";
import type { Role } from "./settings";
import { situationMembre, type SituationMembre } from "./penalites";
import { STATUT_VERSEMENT, SENS_TRANSFERT } from "./valeurs";
import { dietzModifie, repartirParts, tri, type Flux, type PartMembre } from "./perf";

/** bigint et numeric reviennent en chaine avec le pilote Postgres : on normalise. */
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export type MembreListe = {
  id: string;
  nom: string;
  email: string;
  telephone: string | null;
  titre: string | null;
  role: Role;
  actif: boolean;
  date_adhesion: string;
  must_change_password: boolean;
};

export type Versement = {
  id: string;
  membre_id: string;
  membre_nom: string;
  mois: string;
  montant: number;
  date_versement: string;
  mode: string;
  reference: string | null;
  statut: string;
  lot: string;
  saisi_par_nom: string | null;
  valide_par_nom: string | null;
  note: string | null;
  motif_rejet: string | null;
};

export type Apport = {
  id: string;
  date_transfert: string;
  montant: number;
  sens: string;
  note: string | null;
  saisi_par_nom: string | null;
};

export type Valorisation = {
  id: string;
  date_valo: string;
  total: number;
  liquidites: number;
  actions: number;
  note: string | null;
};

/* ------------------------------------------------------------------ reglages */

export type Reglages = typeof REGLES;

const CLES_REGLAGES: Partial<Record<keyof Reglages, string[]>> = {
  cotisationMensuelle: ["cotisation_mensuelle", "monthly_contribution", "cotisation"],
  jourEcheance: ["jour_echeance", "due_day"],
  tauxPenalite: ["taux_penalite", "penalty_rate"],
};

/**
 * Reglages effectifs : les constantes des statuts, surchargees par la table
 * `settings` quand elle porte la cle correspondante. Permet de changer le montant
 * de la cotisation sans toucher au code, comme le prevoyait le schema d'origine.
 */
export async function reglagesEffectifs(): Promise<Reglages> {
  try {
    const sql = db();
    const rows = await sql`select key, value from settings`;
    const table = new Map(rows.map((r) => [String(r.key), String(r.value)]));
    const sortie: Reglages = { ...REGLES };
    for (const [champ, cles] of Object.entries(CLES_REGLAGES) as [keyof Reglages, string[]][]) {
      for (const cle of cles) {
        const brut = table.get(cle);
        if (brut === undefined) continue;
        const valeur = Number(brut);
        if (Number.isFinite(valeur) && valeur > 0) {
          (sortie as Record<string, number>)[champ] = valeur;
          break;
        }
      }
    }
    return sortie;
  } catch {
    return REGLES;
  }
}

/* ------------------------------------------------------------------- membres */

const CHAMPS_MEMBRE = `
  id, full_name as nom, email, phone as telephone, title as titre, role,
  is_active as actif, must_change_password,
  to_char(joined_on, 'YYYY-MM-DD') as date_adhesion
`;

export async function listerMembres(inclureInactifs = false): Promise<MembreListe[]> {
  const sql = db();
  const rows = await sql`
    select ${sql.unsafe(CHAMPS_MEMBRE)}
    from members
    where ${inclureInactifs} or is_active = true
    order by case role
      when 'president' then 0
      when 'vice_president' then 1
      when 'tresorier' then 2
      when 'secretaire' then 3
      else 4
    end, full_name
  `;
  return rows as MembreListe[];
}

/* ---------------------------------------------------------------- versements */

const CHAMPS_VERSEMENT = `
  c.id, c.member_id as membre_id, m.full_name as membre_nom,
  to_char(c.period, 'YYYY-MM-DD') as mois,
  c.amount as montant,
  to_char(c.paid_on, 'YYYY-MM-DD') as date_versement,
  c.method as mode, c.reference, c.status as statut, c.batch_id as lot,
  c.note, c.review_note as motif_rejet,
  d.full_name as saisi_par_nom, r.full_name as valide_par_nom
`;

export async function listerVersements(filtre?: {
  membreId?: string;
  statut?: string;
}): Promise<Versement[]> {
  const sql = db();
  const membreId = filtre?.membreId ?? null;
  const statut = filtre?.statut ?? null;
  const rows = await sql`
    select ${sql.unsafe(CHAMPS_VERSEMENT)}
    from contributions c
    join members m on m.id = c.member_id
    left join members d on d.id = c.declared_by
    left join members r on r.id = c.reviewed_by
    where (${membreId}::uuid is null or c.member_id = ${membreId}::uuid)
      and (${statut}::text is null or c.status = ${statut}::text)
    order by c.period desc, m.full_name
  `;
  return (rows as Versement[]).map((r) => ({ ...r, montant: n(r.montant) }));
}

export async function versementsEnAttente(): Promise<Versement[]> {
  return listerVersements({ statut: STATUT_VERSEMENT.enAttente });
}

/* -------------------------------------------------------------- compte-titres */

export async function listerApports(): Promise<Apport[]> {
  const sql = db();
  const rows = await sql`
    select t.id, to_char(t.transfer_date, 'YYYY-MM-DD') as date_transfert,
           t.amount as montant, t.direction as sens, t.note,
           c.full_name as saisi_par_nom
    from securities_transfers t
    left join members c on c.id = t.created_by
    order by t.transfer_date desc, t.created_at desc
  `;
  return (rows as Apport[]).map((r) => ({ ...r, montant: n(r.montant) }));
}

export async function listerValorisations(): Promise<Valorisation[]> {
  const sql = db();
  const rows = await sql`
    select id, to_char(valued_on, 'YYYY-MM-DD') as date_valo,
           total_value, cash_part, note
    from portfolio_valuations
    order by valued_on asc
  `;
  return rows.map((r) => {
    const total = n(r.total_value);
    const liquidites = n(r.cash_part);
    return {
      id: String(r.id),
      date_valo: r.date_valo as string,
      total,
      liquidites,
      // La base stocke le total et la part liquide : la part titres s'en deduit.
      actions: Math.max(0, total - liquidites),
      note: (r.note as string) ?? null,
    };
  });
}

export async function derniereValorisation(): Promise<Valorisation | null> {
  const toutes = await listerValorisations();
  return toutes.at(-1) ?? null;
}

/* ------------------------------------------------------------ declarations R3 */

/** La table est ajoutee par scripts/migration-r3.sql : son absence n'est pas une erreur. */
export async function declarationsRetard(): Promise<{ membre_id: string; mois: string }[]> {
  try {
    const sql = db();
    const rows = await sql`
      select member_id as membre_id, to_char(period, 'YYYY-MM-DD') as mois
      from late_declarations
    `;
    return rows as { membre_id: string; mois: string }[];
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------- vue d'ensemble */

export type SituationClub = SituationMembre & {
  nom: string;
  role: Role;
  email: string;
  verse: number;
  retardDeclare: boolean;
};

export async function situationsClub(aujourdhui = new Date()): Promise<SituationClub[]> {
  const sql = db();
  const [membres, declarations] = await Promise.all([listerMembres(), declarationsRetard()]);
  const mois = moisDuClub(debutMois(aujourdhui));

  const versements = await sql`
    select member_id, to_char(period, 'YYYY-MM-DD') as mois,
           amount, status, to_char(paid_on, 'YYYY-MM-DD') as paid_on
    from contributions
    where status <> ${STATUT_VERSEMENT.rejete}
  `;

  return membres.map((m) => {
    const siens = versements
      .filter((v) => String(v.member_id) === m.id)
      .map((v) => ({
        mois_couvert: v.mois as string,
        montant: n(v.amount),
        statut: (v.status === STATUT_VERSEMENT.valide ? "valide" : "en_attente") as
          | "valide"
          | "en_attente",
        date_versement: (v.paid_on as string) ?? null,
      }));
    const declares = declarations.filter((d) => d.membre_id === m.id).map((d) => d.mois);

    const situation = situationMembre(
      m.id,
      mois,
      siens,
      declares,
      aujourdhui,
      `${m.date_adhesion.slice(0, 8)}01`,
    );

    return {
      ...situation,
      nom: m.nom,
      role: m.role,
      email: m.email,
      verse: siens.filter((v) => v.statut === "valide").reduce((s, v) => s + v.montant, 0),
      retardDeclare:
        situation.moisEnRetard.length > 0 &&
        situation.moisEnRetard.every((mo) => declares.includes(mo)),
    };
  });
}

export type Synthese = {
  valorisation: Valorisation | null;
  totalVerse: number;
  totalEnCaisse: number;
  totalApports: number;
  parts: PartMembre[];
  tri: number | null;
  exercice: ReturnType<typeof dietzModifie> | null;
  nbRetardataires: number;
  totalPenalites: number;
  enAttenteValidation: number;
};

export async function synthese(aujourdhui = new Date()): Promise<Synthese> {
  const [situations, apports, valos, enAttente] = await Promise.all([
    situationsClub(aujourdhui),
    listerApports(),
    listerValorisations(),
    versementsEnAttente(),
  ]);

  const valorisation = valos.at(-1) ?? null;
  const totalVerse = situations.reduce((s, m) => s + m.verse, 0);

  // direction distingue l'apport du retrait : le net investi est la difference.
  const net = (a: (typeof apports)[number]) =>
    a.sens === SENS_TRANSFERT.sortie ? -a.montant : a.montant;
  const totalApports = apports.reduce((s, a) => s + net(a), 0);

  const parts = repartirParts(
    situations.map((s) => ({ membreId: s.membreId, nom: s.nom, verse: s.verse })),
    valorisation?.total ?? 0,
  );

  // TRI : apports vers le compte-titres en sortie de poche, valeur actuelle en entree.
  const flux: Flux[] = apports.map((a) => ({ date: a.date_transfert, montant: -net(a) }));
  if (valorisation && flux.length > 0) {
    flux.push({ date: valorisation.date_valo, montant: valorisation.total });
  }

  const debutExercice = `${aujourdhui.getUTCFullYear()}-01-01`;
  const valoDebut = [...valos].reverse().find((v) => v.date_valo <= debutExercice) ?? valos[0] ?? null;
  const exercice =
    valorisation && valoDebut && valoDebut.date_valo < valorisation.date_valo
      ? dietzModifie(
          valoDebut.total,
          valorisation.total,
          apports.map((a) => ({ date: a.date_transfert, montant: net(a) })),
          valoDebut.date_valo,
          valorisation.date_valo,
        )
      : null;

  return {
    valorisation,
    totalVerse,
    totalEnCaisse: totalVerse - totalApports,
    totalApports,
    parts,
    tri: flux.length >= 2 ? tri(flux) : null,
    exercice,
    nbRetardataires: situations.filter((s) => s.nbMoisRetard > 0).length,
    totalPenalites: situations.reduce((s, m) => s + m.totalPenalites, 0),
    enAttenteValidation: enAttente.length,
  };
}

export const CONSTANTES = { CLUB, REGLES };
