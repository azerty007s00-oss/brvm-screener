import { REGLES, decalerMois, estExigible } from "./settings";

export type StatutMois = "paye" | "en_attente" | "retard" | "a_venir" | "hors_periode";

export type CelluleMois = {
  mois: string;
  statut: StatutMois;
  montant: number;
  dateVersement: string | null;
};

export type SituationMembre = {
  membreId: string;
  cellules: CelluleMois[];
  moisEnRetard: string[];
  nbMoisRetard: number;
  /** Jours ecoules depuis l'echeance du plus ancien mois impaye. */
  joursDeRetard: number;
  /** R2 - droit de vote suspendu des 30 jours de retard. */
  voteSuspendu: boolean;
  /** R3 - la declaration WhatsApp devient obligatoire a l'entree dans le 2e mois. */
  declarationRequise: boolean;
  /** R5 - 3 mois de retard atteints. */
  exclusionEncourue: boolean;
  penalites: PenaliteCalculee[];
  totalPenalites: number;
};

export type PenaliteCalculee = {
  mois: string;
  taux: number;
  montant: number;
  doublee: boolean;
};

type VersementConnu = {
  mois_couvert: string;
  montant: number;
  statut: "en_attente" | "valide" | "rejete";
  date_versement: string | null;
};

/**
 * Construit la situation d'un membre mois par mois.
 *
 * Un versement en attente de validation compte comme honore : le membre a remis
 * l'argent, seule la contresignature du tresorier manque. Le penaliser pour le
 * delai de validation du bureau serait injuste.
 */
export function situationMembre(
  membreId: string,
  moisDuClub: string[],
  versements: VersementConnu[],
  moisDeclares: string[] = [],
  aujourdhui: Date = new Date(),
  moisAdhesion?: string,
): SituationMembre {
  const parMois = new Map<string, VersementConnu>();
  for (const v of versements) {
    if (v.statut === "rejete") continue;
    parMois.set(v.mois_couvert.slice(0, 10), v);
  }

  const cellules: CelluleMois[] = [];
  const moisEnRetard: string[] = [];

  for (const mois of moisDuClub) {
    if (moisAdhesion && mois < moisAdhesion) {
      cellules.push({ mois, statut: "hors_periode", montant: 0, dateVersement: null });
      continue;
    }
    const v = parMois.get(mois);
    if (v) {
      cellules.push({
        mois,
        statut: v.statut === "valide" ? "paye" : "en_attente",
        montant: v.montant,
        dateVersement: v.date_versement,
      });
      continue;
    }
    if (estExigible(mois, aujourdhui)) {
      cellules.push({ mois, statut: "retard", montant: 0, dateVersement: null });
      moisEnRetard.push(mois);
    } else {
      cellules.push({ mois, statut: "a_venir", montant: 0, dateVersement: null });
    }
  }

  const nbMoisRetard = moisEnRetard.length;
  const joursDeRetard = nbMoisRetard === 0 ? 0 : joursDepuisEcheance(moisEnRetard[0], aujourdhui);
  const penalites = calculerPenalites(moisEnRetard);

  return {
    membreId,
    cellules,
    moisEnRetard,
    nbMoisRetard,
    joursDeRetard,
    voteSuspendu: joursDeRetard >= REGLES.suspensionVoteApresJours,
    declarationRequise:
      nbMoisRetard >= REGLES.declarationObligatoireApresMois &&
      !moisEnRetard.every((m) => moisDeclares.includes(m)),
    exclusionEncourue: nbMoisRetard >= REGLES.exclusionApresMois,
    penalites,
    totalPenalites: penalites.reduce((total, p) => total + p.montant, 0),
  };
}

function joursDepuisEcheance(mois: string, aujourdhui: Date): number {
  const echeance = new Date(
    `${mois.slice(0, 8)}${String(REGLES.jourEcheance).padStart(2, "0")}T23:59:59Z`,
  );
  return Math.max(0, Math.floor((aujourdhui.getTime() - echeance.getTime()) / 86_400_000));
}

/**
 * Art. 9 : 10 % du versement du par mois de retard.
 * R4 : des 3 mois de retard, les penalites des 3 mois les plus recents doublent
 *      (le cumul de ces 3 mois passe de 30 % a 60 % du versement du).
 */
export function calculerPenalites(moisEnRetard: string[]): PenaliteCalculee[] {
  if (moisEnRetard.length === 0) return [];
  const tries = [...moisEnRetard].sort();
  const doublement = tries.length >= REGLES.doublementApresMois;
  const seuilDoublement = tries.slice(-REGLES.moisPenalitesDoublees);

  return tries.map((mois) => {
    const doublee = doublement && seuilDoublement.includes(mois);
    const taux = doublee ? REGLES.tauxPenalite * 2 : REGLES.tauxPenalite;
    return {
      mois,
      taux,
      montant: Math.round(REGLES.cotisationMensuelle * taux),
      doublee,
    };
  });
}

/**
 * R5 : au 3e mois de retard, l'issue depend du respect de R3.
 * Retard non declare -> exclusion de plein droit ; declare -> plan de redressement.
 */
export function issueR5(
  nbMoisRetard: number,
  retardDeclare: boolean,
  planDejaUtilise: boolean,
): { applicable: boolean; voie: "exclusion_plein_droit" | "plan_redressement" | "vote_art20" | null; texte: string } {
  if (nbMoisRetard < REGLES.exclusionApresMois) {
    return { applicable: false, voie: null, texte: "" };
  }
  if (!retardDeclare) {
    return {
      applicable: true,
      voie: "exclusion_plein_droit",
      texte:
        `Retard de ${nbMoisRetard} mois non declare au groupe (R3 non respectee) : ` +
        `exclusion de plein droit, remboursement sous ${REGLES.delaiRemboursementMois} mois ` +
        `au cours de cession diminue de ${(REGLES.fraisCession * 100).toFixed(0)} % de frais.`,
    };
  }
  if (planDejaUtilise) {
    return {
      applicable: true,
      voie: "vote_art20",
      texte:
        "Le plan de redressement a deja ete accorde a ce membre. " +
        `Exclusion soumise au vote des ${(REGLES.majoriteExclusion * 100).toFixed(0)} % (art. 20).`,
    };
  }
  return {
    applicable: true,
    voie: "plan_redressement",
    texte:
      "Retard declare au groupe : le membre garde le benefice d'un plan de redressement, " +
      "accordable une seule fois sur la duree du club.",
  };
}

/** Mois pour lequel la relance du 10 doit partir. */
export function moisARelancer(aujourdhui: Date = new Date()): string {
  const mois = `${aujourdhui.getUTCFullYear()}-${String(aujourdhui.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return estExigible(mois, aujourdhui) ? mois : decalerMois(mois, -1);
}
