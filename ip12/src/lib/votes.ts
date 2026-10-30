import "server-only";
import { db } from "./db";
import { avecTables } from "./tables-auto";
import { envoyerAlertes } from "./alertes";
import { envoyerCourriel } from "./courriel";
import { listerMembres, situationsClub, synthese, type MembreListe } from "./queries";
import { CLUB, lienDuSite } from "./settings";
import { alerterParFuseau } from "./sondage";
import { momentEnClair } from "./calendrier-reunions";
import {
  MAJORITES,
  RELANCE_VOTE_AVANT_MS,
  STATUT_VOTE,
  alerteAnnulation,
  alerteInvitation,
  alerteRelanceVote,
  alerteResultat,
  depouiller,
  electeurs,
  phraseResultat,
  poidsDesPersonnes,
  pourcent,
  type Bulletin,
  type Choix,
  type Electeur,
  type Majorite,
  type StatutVote,
} from "./scrutin";

/** Le meme texte que scripts/migration-votes.sql. */
const TABLES = [
  `create table if not exists votes (
    id            uuid primary key default gen_random_uuid(),
    question      text not null,
    details       text,
    majority      text not null,
    closes_at     timestamptz not null,
    target_member uuid references members(id) on delete set null,
    status        text not null default 'ouvert',
    created_by    uuid not null references members(id),
    created_at    timestamptz not null default now(),
    reminded_at   timestamptz,
    closed_at     timestamptz,
    snapshot      text,
    cancel_reason text,
    cancelled_by  uuid references members(id),
    cancelled_at  timestamptz
  )`,
  `create table if not exists vote_ballots (
    vote_id   uuid not null references votes(id) on delete cascade,
    member_id uuid not null references members(id) on delete cascade,
    choice    text not null,
    cast_at   timestamptz not null default now(),
    primary key (vote_id, member_id)
  )`,
];

function avecLesTables<T>(f: () => Promise<T>): Promise<T> {
  return avecTables(TABLES, f);
}

/* ------------------------------------------------------------------ lecture */

export type Vote = {
  id: string;
  question: string;
  details: string | null;
  majorite: Majorite;
  cloture: Date;
  vise: string | null;
  viseNom: string | null;
  statut: StatutVote;
  auteurId: string;
  auteurNom: string;
  creeLe: Date;
  closLe: Date | null;
  /** Les electeurs et leur poids, figes a la cloture ; null tant que le vote court. */
  fige: Electeur[] | null;
  motifAnnulation: string | null;
  annulePar: string | null;
};

const CHAMPS_VOTE = `
  v.id::text as id, v.question, v.details, v.majority as majorite,
  to_char(v.closes_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as cloture,
  v.target_member::text as vise, t.full_name as vise_nom, v.status as statut,
  v.created_by::text as auteur, a.full_name as auteur_nom,
  to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as cree_le,
  to_char(v.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as clos_le,
  v.snapshot, v.cancel_reason as motif, c.full_name as annule_par
`;

function versVote(r: Record<string, unknown>): Vote {
  let fige: Electeur[] | null = null;
  try {
    fige = r.snapshot ? (JSON.parse(String(r.snapshot)) as Electeur[]) : null;
  } catch {
    fige = null;
  }
  return {
    id: String(r.id),
    question: String(r.question),
    details: (r.details as string | null) ?? null,
    majorite: String(r.majorite) as Majorite,
    cloture: new Date(String(r.cloture)),
    vise: (r.vise as string | null) ?? null,
    viseNom: (r.vise_nom as string | null) ?? null,
    statut: String(r.statut) as StatutVote,
    auteurId: String(r.auteur),
    auteurNom: String(r.auteur_nom),
    creeLe: new Date(String(r.cree_le)),
    closLe: r.clos_le ? new Date(String(r.clos_le)) : null,
    fige,
    motifAnnulation: (r.motif as string | null) ?? null,
    annulePar: (r.annule_par as string | null) ?? null,
  };
}

export async function listerVotes(): Promise<Vote[]> {
  const sql = db();
  const rows = await avecLesTables(() => sql`
    select ${sql.unsafe(CHAMPS_VOTE)}
    from votes v join members a on a.id = v.created_by
    left join members t on t.id = v.target_member left join members c on c.id = v.cancelled_by
    order by v.created_at desc limit 60
  `);
  return rows.map(versVote);
}

export async function voteParId(id: string): Promise<Vote | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const sql = db();
  const rows = await avecLesTables(() => sql`
    select ${sql.unsafe(CHAMPS_VOTE)}
    from votes v join members a on a.id = v.created_by
    left join members t on t.id = v.target_member left join members c on c.id = v.cancelled_by
    where v.id = ${id}::uuid
  `);
  return rows[0] ? versVote(rows[0]) : null;
}

export type BulletinDate = Bulletin & { voteId: string; le: Date };

export async function bulletinsDes(voteIds: string[]): Promise<BulletinDate[]> {
  if (voteIds.length === 0) return [];
  const sql = db();
  const rows = await avecLesTables(() => sql`
    select vote_id::text as vote, member_id::text as membre, choice as choix,
           to_char(cast_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as le
    from vote_ballots where vote_id = any(${voteIds}::uuid[])
  `);
  return rows.map((r) => ({
    voteId: String(r.vote),
    membreId: String(r.membre),
    choix: String(r.choix) as Choix,
    le: new Date(String(r.le)),
  }));
}

/** Les personnes en activite : qui recoit les invitations et les resultats. */
export async function personnes(): Promise<MembreListe[]> {
  return (await listerMembres()).filter((m) => m.actif && !m.titulaireId);
}

/**
 * Les electeurs a cet instant, avec leur poids : la part de chacun dans le
 * club (art. 12), ses parts rachetees comprises. R2 suspend qui a plus de 30
 * jours de retard, sur sa part ou sur une part qu'il detient.
 */
export async function electeursActuels(vise: string | null): Promise<Electeur[]> {
  const [s, membres, situations] = await Promise.all([synthese(), listerMembres(), situationsClub()]);
  const titulaires = new Map(membres.map((m) => [m.id, m.titulaireId]));
  const poids = poidsDesPersonnes(
    s.parts.map((p) => ({ membreId: p.membreId, part: p.part })),
    titulaires,
  );
  const suspendus = new Set(situations.filter((x) => x.voteSuspendu).map((x) => titulaires.get(x.membreId) ?? x.membreId));
  return electeurs(
    membres.filter((m) => m.actif && !m.titulaireId),
    poids,
    suspendus,
    vise,
  );
}

/** Les electeurs d'un vote : figes s'il est clos, ceux du moment sinon. */
export async function electeursDu(v: Vote): Promise<Electeur[]> {
  return v.fige ?? electeursActuels(v.vise);
}

/* ---------------------------------------------------------------- ecriture */

export async function creerVote(p: {
  question: string;
  details: string | null;
  majorite: Majorite;
  cloture: Date;
  vise: string | null;
  auteurId: string;
}): Promise<string> {
  const sql = db();
  const rows = await avecLesTables(() => sql`
    insert into votes (question, details, majority, closes_at, target_member, created_by)
    values (${p.question}, ${p.details}, ${p.majorite}, ${p.cloture.toISOString()}::timestamptz,
            ${p.vise}::uuid, ${p.auteurId}::uuid)
    returning id::text as id
  `);
  return String(rows[0].id);
}

export async function deposerBulletin(voteId: string, membreId: string, choix: Choix): Promise<void> {
  const sql = db();
  await avecLesTables(() => sql`
    insert into vote_ballots (vote_id, member_id, choice, cast_at) values (${voteId}::uuid, ${membreId}::uuid, ${choix}, now())
    on conflict (vote_id, member_id) do update set choice = excluded.choice, cast_at = now()
  `);
}

/** Annule un vote ouvert ; rend false s'il ne l'etait plus. */
export async function annulerVote(voteId: string, motif: string, parId: string): Promise<boolean> {
  const sql = db();
  const rows = await avecLesTables(() => sql`
    update votes set status = ${STATUT_VOTE.annule}, cancel_reason = ${motif}, cancelled_by = ${parId}::uuid, cancelled_at = now()
    where id = ${voteId}::uuid and status = ${STATUT_VOTE.ouvert} returning id
  `);
  return rows.length > 0;
}

/* ------------------------------------------------------------------ avis */

/** « dimanche 15/11 à 20 h GMT, heure d'Abidjan ». */
export function clotureEnClair(cloture: Date): string {
  return `${momentEnClair(cloture)}, heure d'Abidjan`;
}

function lienVote(id: string): string {
  const site = lienDuSite();
  return site ? `${site}/votes/${id}` : "la page Votes du site";
}

async function ecrire(destinataires: MembreListe[], sujet: string, corps: (m: MembreListe) => string[]): Promise<number> {
  let partis = 0;
  for (const m of destinataires) {
    if (!m.email) continue;
    const { ok } = await envoyerCourriel({
      destinataire: m.email,
      sujet,
      texte: [...corps(m), "", `Le suivi du club ${CLUB.nom}`].join("\n"),
    }).catch(() => ({ ok: false }));
    if (ok) partis++;
  }
  return partis;
}

/** L'invitation a voter : une alerte et un courriel a chaque membre. */
export async function inviterAuVote(v: Vote): Promise<void> {
  const gens = await personnes();
  const cloture = momentEnClair(v.cloture);
  await alerterParFuseau(
    gens.map((m) => m.id),
    v.cloture,
    (local) => alerteInvitation(v.question, cloture, local),
    `vote-${v.id}`,
    `/votes/${v.id}`,
  );
  const liste = await electeursActuels(v.vise);
  await ecrire(gens, `${CLUB.sigle} : vote ouvert, « ${v.question} »`, (m) => {
    const e = liste.find((x) => x.membreId === m.id);
    return [
      `Bonjour ${m.nom},`,
      "",
      `${v.auteurNom} soumet une question au vote du club :`,
      "",
      `« ${v.question} »`,
      ...(v.details ? ["", v.details] : []),
      "",
      `Majorité requise : ${MAJORITES[v.majorite].regle}, comptées au prorata des parts (art. 12).`,
      `Clôture : ${clotureEnClair(v.cloture)}.`,
      "",
      e?.exclu === "vise"
        ? "Ce vote vous concerne directement : vous ne votez pas."
        : e?.exclu === "suspendu"
          ? "Votre droit de vote est suspendu (R2, plus de 30 jours de retard) : régularisez vos cotisations pour le retrouver avant la clôture."
          : `Votre voix pèse ${pourcent(e?.poids ?? 0)}. Le vote est public, et vous pouvez changer d'avis jusqu'à la clôture.`,
      "",
      `Voter : ${lienVote(v.id)}`,
    ];
  });
}

export async function annoncerAnnulation(v: Vote, motif: string): Promise<void> {
  const gens = await personnes();
  await envoyerAlertes(
    gens.map((m) => m.id),
    { ...alerteAnnulation(v.question, motif), url: `/votes/${v.id}`, etiquette: `vote-${v.id}` },
  );
}

/* ------------------------------------------------------- passage quotidien */

export type BilanVotes = { relances: number; clos: number };

/**
 * Le passage de midi et du soir : relance la veille de la cloture ceux qui
 * n'ont pas vote, clot les votes dont l'heure est passee, fige les poids et
 * proclame le resultat. Chaque etape se pose par une mise a jour
 * conditionnelle : rien ne part deux fois.
 */
export async function passageVotes(maintenant: Date): Promise<BilanVotes> {
  const bilan: BilanVotes = { relances: 0, clos: 0 };
  const sql = db();
  const ouverts = (await listerVotes()).filter((v) => v.statut === STATUT_VOTE.ouvert);
  if (ouverts.length === 0) return bilan;
  const instant = maintenant.toISOString();

  for (const v of ouverts) {
    if (maintenant >= v.cloture) {
      const liste = await electeursActuels(v.vise);
      const pris = await sql`
        update votes set status = ${STATUT_VOTE.clos}, closed_at = ${instant}::timestamptz, snapshot = ${JSON.stringify(liste)}
        where id = ${v.id}::uuid and status = ${STATUT_VOTE.ouvert} returning id
      `;
      if (pris.length === 0) continue;
      bilan.clos++;
      const bulletins = await bulletinsDes([v.id]);
      const r = depouiller(liste, bulletins, v.majorite);
      /* Les parts de la base : les voix qui pouvaient voter, et non tout le club. */
      const part = (poids: number) => pourcent(r.base > 0 ? poids / r.base : 0);
      const gens = await personnes();
      await envoyerAlertes(
        gens.map((m) => m.id),
        { ...alerteResultat(v.question, r, v.majorite), url: `/votes/${v.id}`, etiquette: `vote-${v.id}` },
      );
      await ecrire(gens, `${CLUB.sigle} : ${r.adopte ? "adopté" : "rejeté"}, « ${v.question} »`, (m) => [
        `Bonjour ${m.nom},`,
        "",
        `Le vote « ${v.question} » est clos.`,
        "",
        `${r.adopte ? "Adopté" : "Rejeté"} : ${phraseResultat(r, v.majorite)}`,
        `Pour : ${part(r.pour)} · Contre : ${part(r.contre)} · Abstention : ${part(r.abstention)}` +
          (r.silence > 0.0005 ? ` · Sans vote : ${part(r.silence)}` : ""),
        `${r.votants} ${r.votants > 1 ? "votants" : "votant"} sur ${r.admis}.`,
        "",
        `Le détail, qui a voté quoi : ${lienVote(v.id)}`,
      ]);
    } else if (v.cloture.getTime() - maintenant.getTime() <= RELANCE_VOTE_AVANT_MS) {
      const pris = await sql`
        update votes set reminded_at = ${instant}::timestamptz where id = ${v.id}::uuid and reminded_at is null returning id
      `;
      if (pris.length === 0) continue;
      const liste = await electeursActuels(v.vise);
      const ont = new Set((await bulletinsDes([v.id])).map((b) => b.membreId));
      const muets = liste.filter((e) => e.exclu === null && !ont.has(e.membreId)).map((e) => e.membreId);
      bilan.relances += muets.length;
      const cloture = momentEnClair(v.cloture);
      await alerterParFuseau(muets, v.cloture, (local) => alerteRelanceVote(v.question, cloture, local), `vote-${v.id}`, `/votes/${v.id}`);
    }
  }
  return bilan;
}

/** Les votes ouverts ou ce membre n'a pas encore vote : l'accueil les lui rappelle. */
export async function votesEnAttenteDe(membreId: string, maintenant: Date): Promise<Vote[]> {
  const ouverts = (await listerVotes()).filter((v) => v.statut === STATUT_VOTE.ouvert && maintenant < v.cloture && v.vise !== membreId);
  if (ouverts.length === 0) return [];
  const faits = new Set(
    (await bulletinsDes(ouverts.map((v) => v.id))).filter((b) => b.membreId === membreId).map((b) => b.voteId),
  );
  return ouverts.filter((v) => !faits.has(v.id));
}
