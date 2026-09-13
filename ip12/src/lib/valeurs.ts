/**
 * Valeurs textuelles attendues par les colonnes a contrainte de la base.
 *
 * Toutes relevees depuis les contraintes CHECK de la base le 13/09/2026 : ce ne
 * sont plus des suppositions. Les valeurs autorisees mais inutilisees par
 * l'application sont citees en commentaire, pour que l'etendue reelle de chaque
 * colonne reste lisible d'ici.
 */

export const STATUT_VERSEMENT = {
  enAttente: "en_attente",
  valide: "valide",
  rejete: "rejete",
} as const;

export const STATUT_PENALITE = {
  due: "due",
  payee: "payee",
  annulee: "annulee",
} as const;

/** La base accepte aussi 'penalite' : un reglement de penalite passe par la meme table. */
export const KIND_VERSEMENT = {
  cotisation: "cotisation",
  penalite: "penalite",
} as const;

/** 'absence' sanctionne le defaut de presence en reunion (table attendances). */
export const KIND_PENALITE = {
  retard: "retard",
  absence: "absence",
  autre: "autre",
} as const;

export const METHODE = {
  mobileMoney: "mobile_money",
  especes: "especes",
  virement: "virement",
  cheque: "cheque",
} as const;

/** securities_transfers.direction : apport vers la SGI ou retrait. */
export const SENS_TRANSFERT = {
  entree: "vers_titres",
  sortie: "retrait",
} as const;

/** member_rules.kind : regles datees attachees a un membre. */
export const REGLE_MEMBRE = {
  cotisationParticuliere: "cotisation",
  multiplicateurPenalite: "penalite_multiplicateur",
  avanceMinimale: "avance_min",
  planRedressement: "plan_redressement",
  note: "note",
} as const;

export const MODES_AFFICHES: { valeur: string; libelle: string }[] = [
  { valeur: METHODE.mobileMoney, libelle: "Mobile Money" },
  { valeur: METHODE.especes, libelle: "Especes" },
  { valeur: METHODE.virement, libelle: "Virement" },
  { valeur: METHODE.cheque, libelle: "Cheque" },
];

export function libelleMode(mode: string): string {
  return MODES_AFFICHES.find((m) => m.valeur === mode)?.libelle ?? mode.replace(/_/g, " ");
}
