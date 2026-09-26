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

/** cash_movements.direction : sortie ou entree d'argent en caisse. */
export const SENS_CAISSE = {
  depense: "depense",
  recette: "recette",
} as const;

export const STATUT_CAISSE = {
  enAttente: "en_attente",
  valide: "valide",
  rejete: "rejete",
} as const;

/**
 * cash_movements.category : texte libre en base, propose ici sous forme de liste
 * pour que le journal reste exploitable plutot que de se remplir de variantes.
 */
export const CATEGORIES_DEPENSE = [
  { valeur: "transport", libelle: "Transport" },
  { valeur: "impressions", libelle: "Impressions et fournitures" },
  { valeur: "frais_bancaires", libelle: "Frais bancaires" },
  { valeur: "frais_sgi", libelle: "Frais SGI" },
  { valeur: "regularisation", libelle: "Regularisation de caisse" },
  { valeur: "autre", libelle: "Autre depense" },
];

export const CATEGORIES_RECETTE = [
  { valeur: "versements_acquis", libelle: "Versements acquis au club (art. 18)" },
  { valeur: "penalites_anterieures", libelle: "Penalites anterieures, detail non disponible" },
  { valeur: "interets", libelle: "Interets et produits" },
  { valeur: "regularisation", libelle: "Regularisation de caisse" },
  { valeur: "autre", libelle: "Autre recette" },
];

export function libelleCategorie(categorie: string): string {
  return (
    [...CATEGORIES_DEPENSE, ...CATEGORIES_RECETTE].find((c) => c.valeur === categorie)?.libelle ??
    categorie.replace(/_/g, " ")
  );
}
