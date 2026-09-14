import { cache } from "react";
import "server-only";
import { db } from "./db";
import { CLUB, REGLES, debutMois, estExigible, moisDuClub, tauxNormalise } from "./settings";
import type { Role } from "./settings";
import { situationMembre, type ReglesMembre, type SituationMembre } from "./penalites";
import {
  KIND_PENALITE,
  REGLE_MEMBRE,
  STATUT_PENALITE,
  STATUT_VERSEMENT,
  SENS_TRANSFERT,
} from "./valeurs";
import { dietzModifie, dureeEnAnnees, repartirParts, tri, type Flux, type PartMembre } from "./perf";

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
  /** Part retenue par la SGI a l'arrivee : le net investi vaut montant - frais. */
  frais: number;
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

/** Applique la convention du code a une valeur lue en base, ou la rejette. */
function normaliser(champ: keyof Reglages, valeur: number): number | null {
  if (champ === "tauxPenalite") return tauxNormalise(valeur);
  return Number.isFinite(valeur) && valeur > 0 ? valeur : null;
}

/**
 * Reglages effectifs : les constantes des statuts, surchargees par la table
 * `settings` quand elle porte la cle correspondante. Permet de changer le montant
 * de la cotisation sans toucher au code, comme le prevoyait le schema d'origine.
 */
async function reglagesEffectifsBrut(): Promise<Reglages> {
  try {
    const sql = db();
    const rows = await sql`select key, value from settings`;
    const table = new Map(rows.map((r) => [String(r.key), String(r.value)]));
    const sortie: Reglages = { ...REGLES };
    for (const [champ, cles] of Object.entries(CLES_REGLAGES) as [keyof Reglages, string[]][]) {
      for (const cle of cles) {
        const brut = table.get(cle);
        if (brut === undefined) continue;
        const valeur = normaliser(champ, Number(brut));
        if (valeur !== null) {
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

async function listerMembresBrut(inclureInactifs: boolean): Promise<MembreListe[]> {
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

async function versementsEnAttenteBrut(): Promise<Versement[]> {
  return listerVersements({ statut: STATUT_VERSEMENT.enAttente });
}

/* -------------------------------------------------------------- compte-titres */

async function listerApportsBrut(): Promise<Apport[]> {
  const sql = db();
  const projection = (avecFrais: boolean) => `
    t.id, to_char(t.transfer_date, 'YYYY-MM-DD') as date_transfert,
    t.amount as montant, ${avecFrais ? "t.fees" : "0"} as frais,
    t.direction as sens, t.note, c.full_name as saisi_par_nom
  `;
  /*
   * La colonne `fees` vient d'une migration : tant qu'elle n'est pas passee, le
   * site continue de fonctionner en considerant les frais comme nuls, plutot que
   * de tomber sur une page d'erreur.
   */
  const lire = (avecFrais: boolean) => sql`
    select ${sql.unsafe(projection(avecFrais))}
    from securities_transfers t
    left join members c on c.id = t.created_by
    order by t.transfer_date desc, t.created_at desc
  `;
  let rows;
  try {
    rows = await lire(true);
  } catch {
    rows = await lire(false);
  }
  return (rows as Apport[]).map((r) => ({ ...r, montant: n(r.montant), frais: n(r.frais) }));
}

async function listerValorisationsBrut(): Promise<Valorisation[]> {
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

async function derniereValorisationBrut(): Promise<Valorisation | null> {
  const toutes = await listerValorisations();
  return toutes.at(-1) ?? null;
}

/* ------------------------------------------------------------ declarations R3 */

/** La table est ajoutee par scripts/migration-r3.sql : son absence n'est pas une erreur. */
async function declarationsRetardBrut(): Promise<{ membre_id: string; mois: string }[]> {
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

/* ----------------------------------------------------------------- penalites */

export type Penalite = {
  id: string;
  membre_id: string;
  membre_nom: string;
  nature: string;
  quantite: number;
  montant_unitaire: number;
  montant: number;
  motif: string | null;
  date_constat: string;
  statut: string;
  date_reglement: string | null;
  note_reglement: string | null;
  source_key: string | null;
  auto: boolean;
  constate_par: string | null;
  resolu_par: string | null;
};

export async function listerPenalites(filtre?: {
  membreId?: string;
  statut?: string;
}): Promise<Penalite[]> {
  const sql = db();
  const membreId = filtre?.membreId ?? null;
  const statut = filtre?.statut ?? null;
  const rows = await sql`
    select p.id, p.member_id as membre_id, m.full_name as membre_nom,
           p.kind as nature, p.quantity as quantite, p.unit_amount as montant_unitaire,
           p.reason as motif,
           to_char(p.incurred_on, 'YYYY-MM-DD') as date_constat,
           p.status as statut,
           to_char(p.settled_on, 'YYYY-MM-DD') as date_reglement,
           p.settlement_note as note_reglement,
           p.source_key, p.auto,
           c.full_name as constate_par, r.full_name as resolu_par
    from penalties p
    join members m on m.id = p.member_id
    left join members c on c.id = p.created_by
    left join members r on r.id = p.resolved_by
    where (${membreId}::uuid is null or p.member_id = ${membreId}::uuid)
      and (${statut}::text is null or p.status = ${statut}::text)
    order by p.incurred_on desc, m.full_name
  `;
  return rows.map((r) => {
    const quantite = n(r.quantite);
    const unitaire = n(r.montant_unitaire);
    return {
      ...(r as unknown as Penalite),
      quantite,
      montant_unitaire: unitaire,
      montant: quantite * unitaire,
    };
  });
}

/**
 * Borne de reprise par membre : jusqu'a quel mois le tresorier a deja compte.
 *
 * La cle de source distingue la reprise du constat automatique, et la date portee
 * par la ligne de reprise dit ou s'arrete son decompte. Au-dela, le site prend le
 * relais ; en deca, il se tait, sous peine de compter deux fois la meme realite.
 */
async function bornesReprisePenalitesBrut(): Promise<Map<string, string>> {
  const bornes = new Map<string, string>();
  try {
    const sql = db();
    const rows = await sql`
      select member_id, to_char(incurred_on, 'YYYY-MM-DD') as borne
      from penalties where source_key like 'reprise_penalites:%'
    `;
    for (const r of rows) bornes.set(String(r.member_id), String(r.borne));
  } catch {
    // Table absente : aucune borne, le constat couvre tout.
  }
  return bornes;
}

/** Totaux par membre, sur les seules penalites encore dues. */
/**
 * Nombre de penalites de retard encore dues, par membre.
 *
 * Un compte, non un montant : la resolution parle de « 3 mois de penalites
 * impayees », et chaque ligne de retard porte sur un mois. Les penalites
 * d'absence en sont exclues -- la resolution vise les penalites de retard.
 */
async function nbPenalitesRetardDuesBrut(): Promise<Map<string, number>> {
  try {
    const sql = db();
    const rows = await sql`
      select member_id, count(*)::int as nb
      from penalties
      where status = ${STATUT_PENALITE.due} and kind = ${KIND_PENALITE.retard}
      group by member_id
    `;
    return new Map(rows.map((r) => [String(r.member_id), n(r.nb)]));
  } catch {
    return new Map();
  }
}

async function penalitesDuesParMembreBrut(): Promise<Map<string, number>> {
  const sql = db();
  const rows = await sql`
    select member_id, sum(quantity * unit_amount)::bigint as total
    from penalties where status = ${STATUT_PENALITE.due}
    group by member_id
  `;
  return new Map(rows.map((r) => [String(r.member_id), n(r.total)]));
}

/* ------------------------------------------------------------------ reunions */

export type Reunion = {
  id: string;
  date_reunion: string;
  titre: string | null;
  note: string | null;
  cree_par: string | null;
  presents: number;
  absents: number;
  excuses: number;
};

export type Presence = {
  membre_id: string;
  membre_nom: string;
  statut: string | null;
  note: string | null;
};

async function listerReunionsBrut(): Promise<Reunion[]> {
  const sql = db();
  const rows = await sql`
    select r.id, to_char(r.meeting_date, 'YYYY-MM-DD') as date_reunion,
           r.title as titre, r.note, c.full_name as cree_par,
           count(*) filter (where a.status = 'present')::int as presents,
           count(*) filter (where a.status = 'absent')::int  as absents,
           count(*) filter (where a.status = 'excuse')::int  as excuses
    from meetings r
    left join members c on c.id = r.created_by
    left join attendances a on a.meeting_id = r.id
    group by r.id, r.meeting_date, r.title, r.note, c.full_name
    order by r.meeting_date desc
  `;
  return rows as Reunion[];
}

/**
 * Toutes les presences pointees, indexees par reunion puis par membre.
 *
 * Une seule requete pour l'ensemble : la page affiche la feuille de chaque reunion,
 * et les interroger une par une multiplierait les allers-retours sans raison.
 */
export type AbsencesMembre = {
  membreId: string;
  nom: string;
  /** Absences sans justification : seules celles-la se penalisent. */
  injustifiees: number;
  /** Absences excusees par le secretaire : comptees, jamais penalisees. */
  excusees: number;
  /** Dates des absences injustifiees, dans l'ordre : datent les tranches. */
  datesInjustifiees: string[];
};

/**
 * Absences pointees par membre, l'injustifiee separee de l'excusee.
 *
 * Le decompte part de la feuille de presence et d'elle seule : justifier une absence
 * consiste a la passer en « excuse » sur la seance concernee, ce qui la retire
 * mecaniquement du compte penalisable.
 */
async function absencesParMembreBrut(): Promise<AbsencesMembre[]> {
  const sql = db();
  const rows = await sql`
    select m.id as membre_id, m.full_name as nom,
           count(*) filter (where a.status = 'absent') as injustifiees,
           count(*) filter (where a.status = 'excuse') as excusees,
           coalesce(
             array_agg(to_char(r.meeting_date, 'YYYY-MM-DD') order by r.meeting_date)
               filter (where a.status = 'absent'),
             '{}'
           ) as dates_injustifiees
    from members m
    left join attendances a on a.member_id = m.id
    left join meetings r on r.id = a.meeting_id
    where m.is_active
    group by m.id, m.full_name
    order by count(*) filter (where a.status = 'absent') desc, m.full_name
  `;
  return rows.map((r) => ({
    membreId: String(r.membre_id),
    nom: String(r.nom),
    injustifiees: n(r.injustifiees),
    excusees: n(r.excusees),
    datesInjustifiees: Array.isArray(r.dates_injustifiees)
      ? (r.dates_injustifiees as string[])
      : [],
  }));
}

async function presencesParReunionBrut(): Promise<Map<string, Map<string, string>>> {
  const sql = db();
  const rows = await sql`select meeting_id, member_id, status from attendances`;
  const index = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const reunion = String(r.meeting_id);
    if (!index.has(reunion)) index.set(reunion, new Map());
    index.get(reunion)!.set(String(r.member_id), String(r.status));
  }
  return index;
}

/* -------------------------------------------------------------------- caisse */

export type MouvementCaisse = {
  id: string;
  date_mouvement: string;
  sens: string;
  categorie: string;
  montant: number;
  note: string | null;
  statut: string;
  saisi_par: string | null;
  valide_par: string | null;
  motif_refus: string | null;
};

async function listerMouvementsCaisseBrut(): Promise<MouvementCaisse[]> {
  const sql = db();
  const rows = await sql`
    select c.id, to_char(c.movement_date, 'YYYY-MM-DD') as date_mouvement,
           c.direction as sens, c.category as categorie, c.amount as montant,
           c.note, c.status as statut, c.review_note as motif_refus,
           s.full_name as saisi_par, v.full_name as valide_par
    from cash_movements c
    left join members s on s.id = c.created_by
    left join members v on v.id = c.reviewed_by
    order by c.movement_date desc, c.created_at desc
  `;
  return (rows as MouvementCaisse[]).map((r) => ({ ...r, montant: n(r.montant) }));
}

/** Penalites effectivement encaissees : elles grossissent la caisse. */
async function penalitesEncaisseesBrut(): Promise<number> {
  try {
    const sql = db();
    const rows = await sql`
      select coalesce(sum(quantity * unit_amount), 0)::bigint as total
      from penalties where status = ${STATUT_PENALITE.payee}
    `;
    return n(rows[0]?.total);
  } catch {
    return 0;
  }
}

/* --------------------------------------------------------------- vue d'ensemble */

export type SituationClub = SituationMembre & {
  nom: string;
  role: Role;
  email: string;
  /** Tout ce qui est valide, avances comprises : c'est l'argent entre en caisse. */
  verse: number;
  /** La part echue de ce total : le capital qui donne des droits. */
  acquis: number;
  /** La part portant sur des mois a venir. */
  avance: number;
  retardDeclare: boolean;
};

export type RegleMembre = {
  id: string;
  membreId: string;
  membreNom: string;
  nature: string;
  valeur: number | null;
  debut: string | null;
  fin: string | null;
  note: string | null;
};

/**
 * Regles individuelles en vigueur : celles qui sont actives et dont la fenetre
 * couvre le jour considere.
 *
 * Une regle expiree n'est pas supprimee -- elle a produit ses effets et le
 * registre doit pouvoir le dire -- mais elle cesse de s'appliquer.
 */
async function reglesIndividuellesBrut(toutes: boolean): Promise<RegleMembre[]> {
  try {
    const sql = db();
    const rows = await sql`
      select r.id, r.member_id as membre_id, m.full_name as membre_nom,
             r.kind as nature, r.numeric_value as valeur,
             to_char(r.starts_on, 'YYYY-MM-DD') as debut,
             to_char(r.ends_on, 'YYYY-MM-DD') as fin,
             r.note, r.is_active as actif
      from member_rules r
      join members m on m.id = r.member_id
      order by m.full_name, r.created_at desc
    `;
    const aujourdhui = new Date().toISOString().slice(0, 10);
    return rows
      .filter((r) => {
        if (toutes) return true;
        if (!r.actif) return false;
        const debut = r.debut as string | null;
        const fin = r.fin as string | null;
        return (!debut || debut <= aujourdhui) && (!fin || fin >= aujourdhui);
      })
      .map((r) => ({
        id: String(r.id),
        membreId: String(r.membre_id),
        membreNom: String(r.membre_nom),
        nature: String(r.nature),
        valeur: r.valeur === null || r.valeur === undefined ? null : Number(r.valeur),
        debut: (r.debut as string | null) ?? null,
        fin: (r.fin as string | null) ?? null,
        note: (r.note as string | null) ?? null,
      }));
  } catch {
    // La table peut manquer d'une base a l'autre : son absence n'est pas une erreur.
    return [];
  }
}

export type AvanceExigee = {
  membreId: string;
  membreNom: string;
  /** Nombre de mois d'avance imposes au membre. */
  mois: number;
  /** Le montant correspondant, au tarif en vigueur. */
  montantExige: number;
  /** Ce qu'il detient effectivement en avance. */
  avanceDetenue: number;
  respectee: boolean;
  /** Terme de l'obligation, s'il en a ete fixe un. */
  fin: string | null;
};

/**
 * Ou en est chaque membre soumis a une avance minimale.
 *
 * L'obligation s'exprime en mois et non en francs : une cotisation revue en
 * assemblee ne doit pas alleger la mesure sans que personne l'ait voulu.
 */
async function avancesExigeesBrut(aujourdhui: Date): Promise<AvanceExigee[]> {
  const [regles, situations, reglages] = await Promise.all([
    reglesIndividuelles(),
    situationsClub(aujourdhui),
    reglagesEffectifs(),
  ]);
  return regles
    .filter((r) => r.nature === REGLE_MEMBRE.avanceMinimale && (r.valeur ?? 0) > 0)
    .map((r) => {
      const mois = r.valeur ?? 0;
      const montantExige = mois * reglages.cotisationMensuelle;
      const avanceDetenue = situations.find((x) => x.membreId === r.membreId)?.avance ?? 0;
      return {
        membreId: r.membreId,
        membreNom: r.membreNom,
        mois,
        montantExige,
        avanceDetenue,
        respectee: avanceDetenue >= montantExige,
        fin: r.fin,
      };
    });
}

/** Les derogations en vigueur, indexees par membre, pretes pour le calcul. */
async function derogationsParMembreBrut(): Promise<Map<string, ReglesMembre>> {
  const regles = await reglesIndividuelles();
  const index = new Map<string, ReglesMembre>();
  for (const r of regles) {
    if (r.valeur === null || !Number.isFinite(r.valeur) || r.valeur <= 0) continue;
    const courante = index.get(r.membreId) ?? {};
    if (r.nature === REGLE_MEMBRE.cotisationParticuliere) {
      courante.cotisationMensuelle = r.valeur;
    } else if (r.nature === REGLE_MEMBRE.multiplicateurPenalite) {
      courante.multiplicateurPenalite = r.valeur;
    } else {
      continue;
    }
    index.set(r.membreId, courante);
  }
  return index;
}

/* -------------------------------------------------------- sorties (art. 20) */

export type Sortie = {
  id: string;
  membreId: string;
  membreNom: string;
  date: string;
  motif: string | null;
  valeurBrute: number;
  frais: number;
  netVerse: number;
  acquisAuClub: number;
  note: string | null;
};

async function listerSortiesBrut(): Promise<Sortie[]> {
  try {
    const sql = db();
    const rows = await sql`
      select e.id, e.member_id as membre_id, m.full_name as membre_nom,
             to_char(e.exit_date, 'YYYY-MM-DD') as date, e.reason as motif,
             e.gross_value, e.fees, e.net_paid, e.forfeited, e.note
      from member_exits e
      join members m on m.id = e.member_id
      order by e.exit_date desc
    `;
    return rows.map((r) => ({
      id: String(r.id),
      membreId: String(r.membre_id),
      membreNom: String(r.membre_nom),
      date: String(r.date),
      motif: (r.motif as string | null) ?? null,
      valeurBrute: n(r.gross_value),
      frais: n(r.fees),
      netVerse: n(r.net_paid),
      acquisAuClub: n(r.forfeited),
      note: (r.note as string | null) ?? null,
    }));
  } catch {
    // La table peut manquer d'une base a l'autre : son absence n'est pas une erreur.
    return [];
  }
}

export type DecompteSortie = {
  membreId: string;
  nom: string;
  verse: number;
  part: number;
  /** Avance en depot : rendue au nominal, sans frais -- ce n'est pas une cession. */
  avance: number;
  /** Valeur totale de ses droits, avance comprise, penalites deja deduites. */
  valeurBrute: number;
  /** Art. 20 : 2 % retenus, sur la seule quote-part du portefeuille. */
  fraisIndicatifs: number;
  /** Penalites deja retranchees de son capital, pour memoire. */
  penalitesDeduites: number;
  netIndicatif: number;
};

/**
 * Ce que couterait la sortie de chaque membre, sur l'avoir connu du club.
 *
 * Purement indicatif : les frais reels de la SGI ne sont connus qu'apres coup, et
 * le club vote. Le calcul sert a ouvrir la discussion sur des chiffres, non a la
 * clore.
 *
 * Les penalites dues ne se retranchent pas ici : elles ont deja quitte le capital
 * du membre en diluant sa part. Les deduire une seconde fois les compterait deux
 * fois.
 */
async function decomptesSortieBrut(): Promise<DecompteSortie[]> {
  const [s, dues] = await Promise.all([
    synthese(),
    penalitesDuesParMembre().catch(() => new Map<string, number>()),
  ]);
  return s.parts.map((p) => {
    /*
     * Les frais de cession ne portent que sur la quote-part du portefeuille :
     * l'avance est un depot rendu, non un titre cede.
     */
    const cessible = Math.max(0, p.valeur - p.avance);
    const frais = Math.round(cessible * REGLES.fraisCession);
    return {
      membreId: p.membreId,
      nom: p.nom,
      verse: p.verse,
      part: p.part,
      avance: p.avance,
      valeurBrute: p.valeur,
      fraisIndicatifs: frais,
      penalitesDeduites: dues.get(p.membreId) ?? 0,
      netIndicatif: Math.max(0, p.valeur - frais),
    };
  });
}

async function situationsClubBrut(aujourdhui: Date): Promise<SituationClub[]> {
  const sql = db();
  const [membres, declarations, derogations, nbPenalites, reglages] = await Promise.all([
    listerMembres(),
    declarationsRetard(),
    derogationsParMembre(),
    nbPenalitesRetardDues(),
    reglagesEffectifs(),
  ]);
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
      // Le reglage du bureau vaut defaut ; la derogation individuelle le surcharge.
      { tauxPenalite: reglages.tauxPenalite, ...(derogations.get(m.id) ?? {}) },
      nbPenalites.get(m.id) ?? 0,
    );

    return {
      ...situation,
      nom: m.nom,
      role: m.role,
      email: m.email,
      verse: siens.filter((v) => v.statut === "valide").reduce((s, v) => s + v.montant, 0),
      /*
       * Le capital acquis s'arrete aux mois echus. Une avance ne donne aucun
       * droit tant que le mois qu'elle couvre n'est pas venu : elle est
       * volontaire, donc ni remuneree ni penalisee.
       */
      acquis: siens
        .filter((v) => v.statut === "valide" && estExigible(v.mois_couvert, aujourdhui))
        .reduce((s, v) => s + v.montant, 0),
      avance: siens
        .filter((v) => v.statut === "valide" && !estExigible(v.mois_couvert, aujourdhui))
        .reduce((s, v) => s + v.montant, 0),
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
  /** Penalites encaissees, recettes et depenses valides du journal de caisse. */
  penalitesEncaissees: number;
  recettes: number;
  depenses: number;
  parts: PartMembre[];
  tri: number | null;
  /** Sur quoi porte le TRI : du premier virement au dernier releve. */
  triPeriode: { debut: string; fin: string; annees: number } | null;
  exercice: ReturnType<typeof dietzModifie> | null;
  nbRetardataires: number;
  /** Ce que les statuts prevoient, calcule a partir des mois impayes. */
  totalPenalitesCalculees: number;
  /** Ce que le bureau a effectivement constate et qui reste du. */
  totalPenalitesDues: number;
  enAttenteValidation: number;
};

async function syntheseBrut(aujourdhui: Date): Promise<Synthese> {
  const [situations, apports, valos, enAttente, duesParMembre, encaissees, caisse] =
    await Promise.all([
      situationsClub(aujourdhui),
      listerApports(),
      listerValorisations(),
      versementsEnAttente(),
      penalitesDuesParMembre().catch(() => new Map<string, number>()),
      penalitesEncaissees(),
      listerMouvementsCaisse().catch(() => [] as MouvementCaisse[]),
    ]);

  const valides = caisse.filter((m) => m.statut === "valide");
  const recettes = valides.filter((m) => m.sens === "recette").reduce((t, m) => t + m.montant, 0);
  const depenses = valides.filter((m) => m.sens === "depense").reduce((t, m) => t + m.montant, 0);

  const valorisation = valos.at(-1) ?? null;
  const totalVerse = situations.reduce((s, m) => s + m.verse, 0);

  // direction distingue l'apport du retrait : le net investi est la difference.
  const net = (a: (typeof apports)[number]) =>
    a.sens === SENS_TRANSFERT.sortie ? -a.montant : a.montant;
  const totalApports = apports.reduce((s, a) => s + net(a), 0);

  /*
   * L'avoir du club, portefeuille et caisse reunis. Une avance versee ce mois-ci
   * dort d'abord en caisse : la retrancher du seul portefeuille la prendrait ou
   * elle ne se trouve pas encore, et diminuerait la part de tous les autres.
   */
  /*
   * Le disponible en caisse : ce qui est entre -- cotisations validees, penalites
   * encaissees, recettes -- diminue des depenses et du net vire au compte-titres.
   * Un retrait depuis la SGI revient en caisse, d'ou le net.
   */
  const totalEnCaisse = totalVerse + encaissees + recettes - depenses - totalApports;

  const avoirDuClub = (valorisation?.total ?? 0) + totalEnCaisse;

  const parts = repartirParts(
    situations.map((s) => ({
      membreId: s.membreId,
      nom: s.nom,
      acquis: s.acquis,
      avance: s.avance,
      dues: duesParMembre.get(s.membreId) ?? 0,
    })),
    avoirDuClub,
  );

  /*
   * TRI : apports vers le compte-titres en sortie de poche, valeur du releve en
   * entree finale. Le taux obtenu est annualise par construction, sur les dates
   * reelles de virement et sur toute la duree depuis le premier d'entre eux.
   *
   * Seuls comptent les flux anterieurs au dernier releve. Un virement posterieur
   * n'a pas encore de valeur en face : le compter en sortie sans contrepartie
   * ferait plonger le taux sans qu'aucune perte n'ait eu lieu -- d'autant plus
   * que le portefeuille n'est valorise que tous les deux mois, et qu'un ou deux
   * versements mensuels tombent donc toujours apres le dernier releve.
   */
  const flux: Flux[] = [];
  let triPeriode: Synthese["triPeriode"] = null;
  if (valorisation) {
    for (const a of apports) {
      if (a.date_transfert <= valorisation.date_valo) {
        flux.push({ date: a.date_transfert, montant: -net(a) });
      }
    }
    if (flux.length > 0) {
      const debut = flux.reduce((tot, f) => (f.date < tot ? f.date : tot), flux[0].date);
      flux.push({ date: valorisation.date_valo, montant: valorisation.total });
      triPeriode = {
        debut,
        fin: valorisation.date_valo,
        annees: dureeEnAnnees(debut, valorisation.date_valo),
      };
    }
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
    totalEnCaisse,
    totalApports,
    penalitesEncaissees: encaissees,
    recettes,
    depenses,
    parts,
    tri: flux.length >= 2 ? tri(flux) : null,
    triPeriode,
    exercice,
    nbRetardataires: situations.filter((s) => s.nbMoisRetard > 0).length,
    totalPenalitesCalculees: situations.reduce((s, m) => s + m.totalPenalites, 0),
    totalPenalitesDues: [...duesParMembre.values()].reduce((s, v) => s + v, 0),
    enAttenteValidation: enAttente.length,
  };
}

export const CONSTANTES = { CLUB, REGLES };


/* =========================================================== deduplication */

/*
 * Une meme page demande souvent deux fois la meme chose : la page d'accueil
 * appelle `synthese`, qui appelle `situationsClub`, puis rappelle
 * `situationsClub` pour son propre compte -- et `situationsClub` recharge a
 * chaque fois les membres, les declarations, les derogations et les reglages.
 * Dix-huit allers-retours vers Neon pour douze requetes distinctes. Chaque
 * aller-retour est une requete HTTP : sur le reseau mobile d'Abidjan, le tiers
 * de trop se voit.
 *
 * `cache` de React memorise le resultat pour la duree d'un rendu, et rien
 * au-dela : deux membres qui chargent la meme page ne partagent rien, et la
 * page suivante repart de la base. Ce n'est pas un cache de donnees, c'est la
 * suppression des doublons d'une seule requete.
 *
 * Hors rendu -- la route cron, une action serveur -- `cache` laisse passer
 * l'appel sans rien memoriser : le comportement y reste celui d'avant.
 *
 * Les lectures a filtre (`listerVersements`, `listerPenalites`) restent hors du
 * dispositif : leur argument est un objet, recree a chaque appel, qu'aucune
 * memorisation par identite ne saurait reconnaitre. Elles ne sont appelees
 * qu'une fois par page.
 */

/**
 * L'instant de la requete, fige.
 *
 * Sans lui, `situationsClub()` et `synthese()` appeles dans la meme page
 * recevraient chacun une Date differente, et `cache` les tiendrait pour deux
 * demandes distinctes. Accessoirement, tous les calculs d'une meme page se
 * rapportent desormais au meme instant, au lieu de deriver de quelques
 * millisecondes entre eux.
 */
const instantCourant = cache(() => new Date());

export const reglagesEffectifs = cache(reglagesEffectifsBrut);
export const versementsEnAttente = cache(versementsEnAttenteBrut);
export const listerApports = cache(listerApportsBrut);
export const listerValorisations = cache(listerValorisationsBrut);
export const derniereValorisation = cache(derniereValorisationBrut);
export const declarationsRetard = cache(declarationsRetardBrut);
export const bornesReprisePenalites = cache(bornesReprisePenalitesBrut);
export const nbPenalitesRetardDues = cache(nbPenalitesRetardDuesBrut);
export const penalitesDuesParMembre = cache(penalitesDuesParMembreBrut);
export const listerReunions = cache(listerReunionsBrut);
export const absencesParMembre = cache(absencesParMembreBrut);
export const presencesParReunion = cache(presencesParReunionBrut);
export const listerMouvementsCaisse = cache(listerMouvementsCaisseBrut);
export const penalitesEncaissees = cache(penalitesEncaisseesBrut);
export const derogationsParMembre = cache(derogationsParMembreBrut);
export const listerSorties = cache(listerSortiesBrut);
export const decomptesSortie = cache(decomptesSortieBrut);

/*
 * Les lectures a valeur par defaut passent par une enveloppe.
 *
 * `cache` distingue les appels par leurs arguments, et `f()` n'est pas `f(x)`
 * meme quand x est precisement la valeur par defaut de f : la page appelait
 * `situationsClub()` pendant que `synthese` appelait `situationsClub(jour)`, et
 * les deux s'executaient. Resoudre la valeur par defaut ici, en amont du cache,
 * fait arriver tous les appels avec la meme arite -- donc la meme cle.
 *
 * Le defaut ne se contente pas d'etre `new Date()` : c'est l'instant fige de la
 * requete, sans quoi deux Date differentes rouvriraient deux entrees.
 */
const situationsClubCache = cache(situationsClubBrut);
export function situationsClub(aujourdhui: Date = instantCourant()): Promise<SituationClub[]> {
  return situationsClubCache(aujourdhui);
}

const syntheseCache = cache(syntheseBrut);
export function synthese(aujourdhui: Date = instantCourant()): Promise<Synthese> {
  return syntheseCache(aujourdhui);
}

const avancesExigeesCache = cache(avancesExigeesBrut);
export function avancesExigees(aujourdhui: Date = instantCourant()): Promise<AvanceExigee[]> {
  return avancesExigeesCache(aujourdhui);
}

const listerMembresCache = cache(listerMembresBrut);
export function listerMembres(inclureInactifs = false): Promise<MembreListe[]> {
  return listerMembresCache(inclureInactifs);
}

const reglesIndividuellesCache = cache(reglesIndividuellesBrut);
export function reglesIndividuelles(toutes = false): Promise<RegleMembre[]> {
  return reglesIndividuellesCache(toutes);
}
