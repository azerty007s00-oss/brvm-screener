/**
 * Valeurs textuelles attendues par les colonnes a contrainte de la base.
 *
 * Elles sont rassemblees ici parce que le schema a ete releve depuis la console
 * Neon sans ses contraintes CHECK : seules les valeurs par defaut etaient
 * visibles. Celles marquees (defaut) sont certaines, les autres deduites.
 * Si une insertion est refusee par une contrainte, c'est ce seul fichier
 * qu'il faut corriger.
 */

export const STATUT_VERSEMENT = {
  enAttente: "en_attente", // (defaut)
  valide: "valide",
  rejete: "rejete",
} as const;

export const STATUT_PENALITE = {
  due: "due", // (defaut)
  payee: "payee",
  annulee: "annulee",
} as const;

export const KIND_VERSEMENT = {
  cotisation: "cotisation", // (defaut)
} as const;

export const KIND_PENALITE = {
  retard: "retard", // (defaut)
} as const;

export const METHODE = {
  mobileMoney: "mobile_money", // (defaut)
  especes: "especes",
  virement: "virement",
  cheque: "cheque",
} as const;

/** securities_transfers.direction : apport vers la SGI ou retrait. */
export const SENS_TRANSFERT = {
  entree: "in",
  sortie: "out",
} as const;

/** member_rules.kind : regles datees attachees a un membre. */
export const REGLE_MEMBRE = {
  planRedressement: "plan_redressement",
  cotisationParticuliere: "cotisation",
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
