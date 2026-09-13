/**
 * Regles du club, transcrites des statuts et des resolutions R1-R5.
 * Toute valeur chiffree du metier vit ici : aucun nombre magique ailleurs.
 */

export const CLUB = {
  nom: "Investment Pioneers",
  sigle: "IP12",
  ville: "Abidjan, Cote d'Ivoire",
  sgi: "Phoenix Capital Management",
  dateCreation: "2023-05-22",
  dureeAnnees: 10,
  membresMin: 5,
  membresMax: 20,
} as const;

export const REGLES = {
  /** Art. 6 - versement mensuel par membre, en FCFA. */
  cotisationMensuelle: 5_000,
  /** Art. 8 - le versement est du au plus tard le 10 du mois. */
  jourEcheance: 10,
  /** Art. 9 - penalite de 10 % du versement du, versee a l'actif du club. */
  tauxPenalite: 0.1,
  /** R2 - droit de vote suspendu des 30 jours de retard, jusqu'a regularisation. */
  suspensionVoteApresJours: 30,
  /** R3 - declaration WhatsApp obligatoire a l'entree dans le 2e mois de retard. */
  declarationObligatoireApresMois: 2,
  /** R4 - a partir de 3 mois de retard, les penalites des 3 derniers mois doublent (30 % -> 60 %). */
  doublementApresMois: 3,
  moisPenalitesDoublees: 3,
  /** Art. 20 / R5 - exclusion envisageable a 3 mois de retard. */
  exclusionApresMois: 3,
  /** Art. 20 - majorite des 3/4 pour prononcer l'exclusion. */
  majoriteExclusion: 0.75,
  /** Art. 20 - remboursement au cours de cession diminue de 2 % de frais. */
  fraisCession: 0.02,
  /** R5 - remboursement sous 4 mois en cas d'exclusion de plein droit. */
  delaiRemboursementMois: 4,
  /** Le president releve la valeur du compte-titres tous les 2 mois. */
  periodiciteValorisationMois: 2,
} as const;

/**
 * Lit une variable d'environnement en traitant la chaine vide comme une absence.
 *
 * Une variable declaree mais laissee vide dans l'interface d'hebergement est un cas
 * courant : `??` la laisserait passer telle quelle, ce qui donnerait un expediteur
 * d'e-mail vide ou un membre cree sans nom.
 */
export function variable(nom: string, repli: string): string {
  const brut = process.env[nom];
  return brut && brut.trim() !== "" ? brut.trim() : repli;
}

export type Role = "president" | "vice_president" | "tresorier" | "secretaire" | "membre";

export const ROLES: Record<Role, string> = {
  president: "President",
  vice_president: "Vice-president",
  tresorier: "Tresorier",
  secretaire: "Secretaire",
  membre: "Membre",
};

/** Postes du bureau : un seul titulaire a la fois, contrairement a "membre". */
export const POSTES_UNIQUES: Role[] = ["president", "vice_president", "tresorier", "secretaire"];

/** Montant en FCFA, sans decimale : 5000 -> "5 000 FCFA". */
export function fcfa(montant: number): string {
  return `${Math.round(montant).toLocaleString("fr-FR").replace(/ | /g, " ")} FCFA`;
}

/** "2026-09-01" -> "septembre 2026" */
export function moisLong(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(`${iso.slice(0, 10)}T00:00:00Z`) : iso;
  return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function dateCourte(iso: string | Date | null): string {
  if (!iso) return "--";
  const d = typeof iso === "string" ? new Date(`${iso.slice(0, 10)}T00:00:00Z`) : iso;
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

/** Premier jour du mois, au format AAAA-MM-01. */
export function debutMois(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Decale un mois ISO de n mois. */
export function decalerMois(isoMois: string, n: number): string {
  const [a, m] = isoMois.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return debutMois(d);
}

/** Liste des mois du club, du plus ancien au mois courant. */
export function moisDuClub(jusqua: string = debutMois()): string[] {
  const out: string[] = [];
  let m = debutMois(new Date(`${CLUB.dateCreation}T00:00:00Z`));
  while (m <= jusqua) {
    out.push(m);
    m = decalerMois(m, 1);
  }
  return out;
}

/** Un mois est exigible des que son echeance (le 10) est passee. */
export function estExigible(isoMois: string, aujourdhui: Date = new Date()): boolean {
  const echeance = new Date(`${isoMois.slice(0, 8)}${String(REGLES.jourEcheance).padStart(2, "0")}T23:59:59Z`);
  return aujourdhui > echeance;
}
