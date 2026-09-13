import "server-only";
import { db } from "./db";
import { CLUB, REGLES, debutMois, moisDuClub } from "./settings";
import type { Role } from "./settings";
import { situationMembre, type SituationMembre } from "./penalites";
import { dietzModifie, repartirParts, tri, type Flux, type PartMembre } from "./perf";

/** int8/numeric reviennent en chaine avec le pilote Postgres : on normalise. */
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export type MembreListe = {
  id: number;
  nom: string;
  email: string;
  telephone: string | null;
  role: Role;
  actif: boolean;
  date_adhesion: string;
  must_change_password: boolean;
};

export type Versement = {
  id: number;
  membre_id: number;
  membre_nom: string;
  mois_couvert: string;
  montant: number;
  date_versement: string;
  mode: string;
  statut: "en_attente" | "valide" | "rejete";
  saisi_par_nom: string | null;
  valide_par_nom: string | null;
  note: string | null;
  motif_rejet: string | null;
};

export type Apport = {
  id: number;
  date_apport: string;
  montant: number;
  reference: string | null;
  statut: "en_attente" | "valide";
  saisi_par_nom: string | null;
  valide_par_nom: string | null;
  note: string | null;
};

export type Valorisation = {
  id: number;
  date_valo: string;
  valeur_actions: number;
  valeur_liquidites: number;
  total: number;
  note: string | null;
};

/* ------------------------------------------------------------------- membres */

export async function listerMembres(inclureInactifs = false): Promise<MembreListe[]> {
  const sql = db();
  const rows = await sql`
    select id, nom, email, telephone, role, actif, must_change_password,
           to_char(date_adhesion, 'YYYY-MM-DD') as date_adhesion
    from membres
    where ${inclureInactifs} or actif = true
    order by case role when 'president' then 0 when 'tresorier' then 1 else 2 end, nom
  `;
  return rows as MembreListe[];
}

export async function compterMembres(): Promise<number> {
  const sql = db();
  const rows = await sql`select count(*)::int as c from membres where actif = true`;
  return n(rows[0]?.c);
}

/* ---------------------------------------------------------------- versements */

export async function listerVersements(filtre?: {
  membreId?: number;
  statut?: "en_attente" | "valide" | "rejete";
}): Promise<Versement[]> {
  const sql = db();
  const rows = await sql`
    select v.id, v.membre_id, m.nom as membre_nom,
           to_char(v.mois_couvert, 'YYYY-MM-DD') as mois_couvert,
           v.montant,
           to_char(v.date_versement, 'YYYY-MM-DD') as date_versement,
           v.mode, v.statut, v.note, v.motif_rejet,
           s.nom as saisi_par_nom, a.nom as valide_par_nom
    from versements v
    join membres m on m.id = v.membre_id
    left join membres s on s.id = v.saisi_par
    left join membres a on a.id = v.valide_par
    where (${filtre?.membreId ?? null}::int is null or v.membre_id = ${filtre?.membreId ?? null}::int)
      and (${filtre?.statut ?? null}::text is null or v.statut = ${filtre?.statut ?? null}::text)
    order by v.mois_couvert desc, m.nom
  `;
  return (rows as Versement[]).map((r) => ({ ...r, montant: n(r.montant) }));
}

export async function versementsEnAttente(): Promise<Versement[]> {
  return listerVersements({ statut: "en_attente" });
}

/* -------------------------------------------------------------- compte-titres */

export async function listerApports(): Promise<Apport[]> {
  const sql = db();
  const rows = await sql`
    select a.id, to_char(a.date_apport, 'YYYY-MM-DD') as date_apport,
           a.montant, a.reference, a.statut, a.note,
           s.nom as saisi_par_nom, v.nom as valide_par_nom
    from apports_titres a
    left join membres s on s.id = a.saisi_par
    left join membres v on v.id = a.valide_par
    order by a.date_apport desc, a.id desc
  `;
  return (rows as Apport[]).map((r) => ({ ...r, montant: n(r.montant) }));
}

export async function listerValorisations(): Promise<Valorisation[]> {
  const sql = db();
  const rows = await sql`
    select id, to_char(date_valo, 'YYYY-MM-DD') as date_valo,
           valeur_actions, valeur_liquidites, note
    from valorisations
    order by date_valo asc
  `;
  return rows.map((r) => ({
    id: n(r.id),
    date_valo: r.date_valo as string,
    valeur_actions: n(r.valeur_actions),
    valeur_liquidites: n(r.valeur_liquidites),
    total: n(r.valeur_actions) + n(r.valeur_liquidites),
    note: (r.note as string) ?? null,
  }));
}

export async function derniereValorisation(): Promise<Valorisation | null> {
  const toutes = await listerValorisations();
  return toutes.length ? toutes[toutes.length - 1] : null;
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
  const membres = await listerMembres();
  const mois = moisDuClub(debutMois(aujourdhui));

  const versements = await sql`
    select membre_id, to_char(mois_couvert, 'YYYY-MM-DD') as mois_couvert,
           montant, statut, to_char(date_versement, 'YYYY-MM-DD') as date_versement
    from versements where statut <> 'rejete'
  `;
  const declarations = await sql`
    select membre_id, to_char(mois_concerne, 'YYYY-MM-DD') as mois_concerne
    from declarations_retard
  `;

  return membres.map((m) => {
    const siens = versements
      .filter((v) => n(v.membre_id) === m.id)
      .map((v) => ({
        mois_couvert: v.mois_couvert as string,
        montant: n(v.montant),
        statut: v.statut as "en_attente" | "valide",
        date_versement: (v.date_versement as string) ?? null,
      }));
    const declares = declarations
      .filter((d) => n(d.membre_id) === m.id)
      .map((d) => d.mois_concerne as string);

    const situation = situationMembre(
      m.id,
      mois,
      siens,
      declares,
      aujourdhui,
      m.date_adhesion.slice(0, 8) + "01",
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
  semestre: ReturnType<typeof dietzModifie> | null;
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

  const valorisation = valos.length ? valos[valos.length - 1] : null;
  const totalVerse = situations.reduce((s, m) => s + m.verse, 0);
  const apportsValides = apports.filter((a) => a.statut === "valide");
  const totalApports = apportsValides.reduce((s, a) => s + a.montant, 0);

  const parts = repartirParts(
    situations.map((s) => ({ membreId: s.membreId, nom: s.nom, verse: s.verse })),
    valorisation?.total ?? 0,
  );

  // TRI : apports vers le compte-titres en sortie, valeur actuelle en entree.
  const flux: Flux[] = apportsValides.map((a) => ({ date: a.date_apport, montant: -a.montant }));
  if (valorisation && flux.length > 0) {
    flux.push({ date: valorisation.date_valo, montant: valorisation.total });
  }

  // Dietz : depuis le premier releve de l'exercice en cours.
  const debutExercice = `${aujourdhui.getUTCFullYear()}-01-01`;
  const valoDebut = [...valos].reverse().find((v) => v.date_valo <= debutExercice) ?? valos[0] ?? null;
  const semestre =
    valorisation && valoDebut && valoDebut.date_valo < valorisation.date_valo
      ? dietzModifie(
          valoDebut.total,
          valorisation.total,
          apportsValides.map((a) => ({ date: a.date_apport, montant: a.montant })),
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
    semestre,
    nbRetardataires: situations.filter((s) => s.nbMoisRetard > 0).length,
    totalPenalites: situations.reduce((s, m) => s + m.totalPenalites, 0),
    enAttenteValidation: enAttente.length,
  };
}

export async function journalRecent(limite = 40) {
  const sql = db();
  const rows = await sql`
    select j.id, j.action, j.details, j.created_at, m.nom as auteur
    from journal j left join membres m on m.id = j.membre_id
    order by j.created_at desc limit ${limite}
  `;
  return rows as { id: number; action: string; details: unknown; created_at: string; auteur: string | null }[];
}

export const CONSTANTES = { CLUB, REGLES };
