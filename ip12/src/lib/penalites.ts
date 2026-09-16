import { EFFET, REGLES, decalerMois, estExigible } from "./settings";

export type StatutMois =
  | "paye"
  | "paye_en_retard"
  | "en_attente"
  /** Echeance passee, quelque chose a ete verse, mais pas tout. */
  | "partiel"
  | "retard"
  | "a_venir"
  | "hors_periode";

export type CelluleMois = {
  mois: string;
  statut: StatutMois;
  /** Tout ce qui est connu pour ce mois, validations en attente comprises. */
  montant: number;
  /** La cotisation attendue ce mois-la, taux particulier compris. */
  requis: number;
  /** Ce qui manque pour solder le mois. Zero des qu'il est couvert. */
  manque: number;
  /** Date du versement qui a complete le mois, non du premier acompte. */
  dateVersement: string | null;
};

/** Vrai si le versement est intervenu apres l'echeance du mois qu'il couvre. */
export function verseEnRetard(mois: string, dateVersement: string | null): boolean {
  if (!dateVersement) return false;
  const echeance = `${mois.slice(0, 8)}${String(REGLES.jourEcheance).padStart(2, "0")}`;
  return dateVersement.slice(0, 10) > echeance;
}

export type SituationMembre = {
  membreId: string;
  cellules: CelluleMois[];
  moisEnRetard: string[];
  /** Mois regles, mais apres le 10 : la penalite reste due (art. 9). */
  moisRegularisesEnRetard: string[];
  nbMoisRetard: number;
  /** Jours ecoules depuis l'echeance du plus ancien mois impaye. */
  joursDeRetard: number;
  /** R2 - droit de vote suspendu des 30 jours de retard. */
  voteSuspendu: boolean;
  /** R3 - la declaration WhatsApp devient obligatoire a l'entree dans le 2e mois. */
  declarationRequise: boolean;
  /** R5 - 3 mois de retard atteints, ou 3 penalites impayees une fois la regle en vigueur. */
  exclusionEncourue: boolean;
  /** Penalites de retard constatees et non reglees. */
  nbPenalitesImpayees: number;
  /** Vrai quand c'est le cumul de penalites, non les cotisations, qui l'expose. */
  exclusionParPenalites: boolean;
  penalites: PenaliteCalculee[];
  totalPenalites: number;
};

export type PenaliteCalculee = {
  mois: string;
  taux: number;
  montant: number;
  doublee: boolean;
  /**
   * Penalite d'un mois finalement regle, mais apres l'echeance. L'art. 9 la dit
   * "definitivement acquise au benefice du club" : elle reste due, et la
   * majoration R4 ne s'y applique pas puisque le retard a cesse.
   */
  figee: boolean;
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
/**
 * Ce qui, chez un membre, deroge au regime commun.
 *
 * Le club peut convenir d'une cotisation differente, ou majorer les penalites
 * d'un membre sous sanction. Un champ absent vaut « regime commun » : les
 * statuts restent la reference, la derogation l'exception nommee.
 */
export type ReglesMembre = {
  cotisationMensuelle?: number;
  /** Taux de l'art. 9, tel que regle par le bureau. Fraction, non pourcentage. */
  tauxPenalite?: number;
  /** Multiplie la penalite, par-dessus le doublement R4. 1 = regime commun. */
  multiplicateurPenalite?: number;
};

export function situationMembre(
  membreId: string,
  moisDuClub: string[],
  versements: VersementConnu[],
  moisDeclares: string[] = [],
  aujourdhui: Date = new Date(),
  moisAdhesion?: string,
  propres: ReglesMembre = {},
  nbPenalitesImpayees = 0,
): SituationMembre {
  /*
   * Un mois peut porter plusieurs versements : un acompte, puis le complement.
   * Ce n'est couvert que lorsque la somme atteint la cotisation attendue --
   * verser 2 000 sur 5 000 ne libere pas de l'obligation de l'art. 8.
   */
  const requis = propres.cotisationMensuelle ?? REGLES.cotisationMensuelle;
  const parMois = new Map<string, VersementConnu[]>();
  for (const v of versements) {
    if (v.statut === "rejete") continue;
    const cle = v.mois_couvert.slice(0, 10);
    const liste = parMois.get(cle);
    if (liste) liste.push(v);
    else parMois.set(cle, [v]);
  }

  /**
   * La date a laquelle un mois est solde : celle du versement qui le complete,
   * non celle du premier acompte. Un acompte le 5 et le solde le 15 font un mois
   * regularise en retard, avec la penalite que l'art. 9 y attache.
   */
  const dateDeSolde = (lignes: VersementConnu[]): string | null => {
    let cumul = 0;
    for (const v of [...lignes].sort((a, b) =>
      (a.date_versement ?? "").localeCompare(b.date_versement ?? ""),
    )) {
      cumul += v.montant;
      if (cumul >= requis) return v.date_versement;
    }
    return null;
  };

  const cellules: CelluleMois[] = [];
  const moisEnRetard: string[] = [];

  const moisRegularisesEnRetard: string[] = [];

  for (const mois of moisDuClub) {
    if (moisAdhesion && mois < moisAdhesion) {
      cellules.push({ mois, statut: "hors_periode", montant: 0, requis: 0, manque: 0, dateVersement: null });
      continue;
    }
    const lignes = parMois.get(mois) ?? [];
    const connu = lignes.reduce((t, v) => t + v.montant, 0);
    const valide = lignes.filter((v) => v.statut === "valide").reduce((t, v) => t + v.montant, 0);
    const manque = Math.max(0, requis - connu);

    /*
     * Couvert au sens strict : les versements valides suffisent. Si le compte n'y
     * est qu'en comptant les declarations non encore validees, le mois est en
     * attente -- c'est au tresorier de trancher, pas au declarant.
     */
    if (valide >= requis) {
      const tardif = verseEnRetard(mois, dateDeSolde(lignes.filter((v) => v.statut === "valide")));
      if (tardif) moisRegularisesEnRetard.push(mois);
      cellules.push({
        mois,
        statut: tardif ? "paye_en_retard" : "paye",
        montant: connu,
        requis,
        manque: 0,
        dateVersement: dateDeSolde(lignes.filter((v) => v.statut === "valide")),
      });
      continue;
    }
    if (connu >= requis) {
      cellules.push({
        mois,
        statut: "en_attente",
        montant: connu,
        requis,
        manque: 0,
        dateVersement: dateDeSolde(lignes),
      });
      continue;
    }

    /*
     * Le compte n'y est pas. Passe l'echeance, le mois est en retard, qu'il ait
     * recu un acompte ou rien du tout : la penalite de l'art. 9 porte sur
     * l'obligation, pas sur ce qui reste a payer. « Partiel » n'est qu'un mot
     * plus juste pour le membre, jamais un traitement plus doux.
     */
    if (estExigible(mois, aujourdhui)) {
      cellules.push({
        mois,
        statut: connu > 0 ? "partiel" : "retard",
        montant: connu,
        requis,
        manque,
        dateVersement: null,
      });
      moisEnRetard.push(mois);
    } else {
      cellules.push({ mois, statut: "a_venir", montant: connu, requis, manque, dateVersement: null });
    }
  }

  /*
   * Les penalites deviennent indissociables des cotisations : les laisser courir
   * en reglant sa cotisation ne protege plus. La regle ne vaut qu'a partir de sa
   * date d'effet -- une sanction ne retroagit pas sur des retards anterieurs a la
   * decision qui l'institue.
   */
  const exclusionParPenalites =
    aujourdhui.toISOString().slice(0, 10) >= EFFET.penalitesIndissociables &&
    nbPenalitesImpayees >= REGLES.penalitesImpayeesAvantExclusion;

  const nbMoisRetard = moisEnRetard.length;
  const joursDeRetard = nbMoisRetard === 0 ? 0 : joursDepuisEcheance(moisEnRetard[0], aujourdhui);
  const penalites = calculerPenalites(moisEnRetard, moisRegularisesEnRetard, propres);

  return {
    membreId,
    cellules,
    moisEnRetard,
    moisRegularisesEnRetard,
    nbMoisRetard,
    joursDeRetard,
    voteSuspendu: joursDeRetard >= REGLES.suspensionVoteApresJours,
    declarationRequise:
      nbMoisRetard >= REGLES.declarationObligatoireApresMois &&
      !moisEnRetard.every((m) => moisDeclares.includes(m)),
    exclusionEncourue: nbMoisRetard >= REGLES.exclusionApresMois || exclusionParPenalites,
    nbPenalitesImpayees,
    exclusionParPenalites,
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
 * Art. 9 : 10 % du versement du des lors que l'echeance du 10 est depassee.
 *
 * La penalite nait du depassement, pas de l'absence de paiement : un mois regle
 * en retard la conserve, "definitivement acquise au benefice du club". Regulariser
 * eteint la cotisation, jamais la penalite.
 *
 * R4 : des 3 mois encore impayes, les penalites des 3 mois les plus recents
 * doublent (leur cumul passe de 30 % a 60 % du versement du). La majoration ne
 * frappe que le retard en cours : un mois deja regle ne peut plus s'aggraver.
 */
export function calculerPenalites(
  moisEnRetard: string[],
  moisRegularisesEnRetard: string[] = [],
  propres: ReglesMembre = {},
): PenaliteCalculee[] {
  const cotisation = propres.cotisationMensuelle ?? REGLES.cotisationMensuelle;
  const tauxDeBase = propres.tauxPenalite ?? REGLES.tauxPenalite;
  const multiplicateur = propres.multiplicateurPenalite ?? 1;

  const impayes = [...moisEnRetard].sort();
  const doublement = impayes.length >= REGLES.doublementApresMois;
  const aDoubler = impayes.slice(-REGLES.moisPenalitesDoublees);

  const sur = (mois: string, doublee: boolean, figee: boolean): PenaliteCalculee => {
    const taux = (doublee ? tauxDeBase * 2 : tauxDeBase) * multiplicateur;
    return { mois, taux, montant: Math.round(cotisation * taux), doublee, figee };
  };

  return [
    ...impayes.map((mois) => sur(mois, doublement && aDoubler.includes(mois), false)),
    ...[...moisRegularisesEnRetard].sort().map((mois) => sur(mois, false, true)),
  ].sort((a, b) => a.mois.localeCompare(b.mois));
}

/**
 * R5 : au 3e mois de retard, l'issue depend du respect de R3.
 * Retard non declare -> exclusion de plein droit ; declare -> plan de redressement.
 */
export function issueR5(
  nbMoisRetard: number,
  retardDeclare: boolean,
  planDejaUtilise: boolean,
  nbPenalitesImpayees = 0,
  aujourdhui: Date = new Date(),
): { applicable: boolean; voie: "exclusion_plein_droit" | "plan_redressement" | "vote_art20" | null; texte: string } {
  /*
   * Les penalites sont devenues indissociables des cotisations. Un membre a jour
   * de ses cotisations mais laissant courir ses penalites est desormais expose :
   * c'est precisement l'abus que l'assemblee a voulu fermer.
   */
  const parPenalites =
    aujourdhui.toISOString().slice(0, 10) >= EFFET.penalitesIndissociables &&
    nbPenalitesImpayees >= REGLES.penalitesImpayeesAvantExclusion;

  if (nbMoisRetard < REGLES.exclusionApresMois) {
    if (!parPenalites) return { applicable: false, voie: null, texte: "" };
    return {
      applicable: true,
      voie: "exclusion_plein_droit",
      texte:
        `${nbPenalitesImpayees} penalites de retard impayees, alors que les cotisations ` +
        "sont a jour. Les penalites etant indissociables des cotisations depuis le " +
        `${EFFET.penalitesIndissociables.split("-").reverse().join("/")}, l'exclusion est ` +
        "acquise de plein droit (R5).",
    };
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
      "accordable une seule fois sur la duree du club." +
      (parPenalites
        ? ` Le plan porte sur l'ensemble de sa dette : ses ${nbPenalitesImpayees} penalites ` +
          "impayees en font partie, celles-ci etant indissociables des cotisations."
        : ""),
  };
}

/** Mois pour lequel la relance du 10 doit partir. */
export function moisARelancer(aujourdhui: Date = new Date()): string {
  const mois = `${aujourdhui.getUTCFullYear()}-${String(aujourdhui.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return estExigible(mois, aujourdhui) ? mois : decalerMois(mois, -1);
}

/* ------------------------------------------------------- absences en reunion */

export type TrancheAbsence = {
  /** Rang de la tranche : la premiere, la deuxieme… Sert de cle au constat. */
  rang: number;
  /** Rang de l'absence qui a ferme la tranche, pour dire a partir de quand elle est due. */
  absenceDeclenchante: number;
  montant: number;
};

/**
 * Tranches d'absences injustifiees penalisables.
 *
 * Le club sanctionne la repetition, non l'empechement ponctuel : seule une tranche
 * complete est due, et le reste court jusqu'a la suivante. Les absences excusees --
 * c'est au secretaire de les justifier -- ne comptent pas.
 *
 * Le rang rend le constat idempotent : une tranche deja portee au registre y reste
 * sous la meme cle, et un nouveau constat n'ajoute que celles qui manquent.
 */
export function tranchesAbsence(
  nbAbsencesInjustifiees: number,
  regles: { penaliteAbsence: number; absencesParTranche: number } = REGLES,
): TrancheAbsence[] {
  const parTranche = Math.floor(regles.absencesParTranche);
  if (parTranche <= 0 || nbAbsencesInjustifiees <= 0) return [];

  const completes = Math.floor(nbAbsencesInjustifiees / parTranche);
  return Array.from({ length: completes }, (_, i) => ({
    rang: i + 1,
    absenceDeclenchante: (i + 1) * parTranche,
    montant: regles.penaliteAbsence,
  }));
}

/* ------------------------------------------- rapprochement avec le registre */

/**
 * Une penalite deja portee au registre, telle que la page la connait.
 *
 * `cle` est la cle de rapprochement des versions actuelles ; elle manque sur
 * les lignes ecrites par une version anterieure, d'ou le second critere.
 */
export type PenaliteAuRegistre = {
  membreId: string;
  nature: string;
  dateConstat: string;
  cle: string | null;
};

/** La cle de rapprochement d'une penalite de retard. */
export function cleRetard(membreId: string, mois: string): string {
  return `retard:${membreId}:${mois}`;
}

/** L'echeance du mois : la date a laquelle la penalite est inscrite. */
export function echeanceDuMois(mois: string, jourEcheance = REGLES.jourEcheance): string {
  return `${mois.slice(0, 8)}${String(jourEcheance).padStart(2, "0")}`;
}

/**
 * Vrai si cette penalite de retard figure deja au registre.
 *
 * Le rapprochement se fait sur la cle, mais aussi sur le couple membre-echeance :
 * la base porte des lignes ecrites par une version anterieure, dont les cles
 * suivaient une autre convention. Ne chercher que les cles actuelles ferait
 * paraitre indefiniment « a constater » ce qui est deja inscrit -- le bureau
 * appuie sur le bouton, l'action reconnait la ligne et ne la recree pas, et la
 * liste ne desemplit jamais.
 *
 * La borne de reprise ecarte en outre ce que le tresorier a deja compte a la
 * main : au-dela, le constat automatique prend le relais.
 */
export function dejaAuRegistre(
  membreId: string,
  mois: string,
  registre: PenaliteAuRegistre[],
  borne?: string,
  jourEcheance = REGLES.jourEcheance,
): boolean {
  if (borne && mois <= borne) return true;
  const cle = cleRetard(membreId, mois);
  const echeance = echeanceDuMois(mois, jourEcheance);
  return registre.some(
    (p) =>
      p.cle === cle ||
      (p.membreId === membreId && p.nature === "retard" && p.dateConstat.slice(0, 10) === echeance),
  );
}
