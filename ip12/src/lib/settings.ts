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
  /**
   * Nombre de penalites de retard impayees qui emporte l'exclusion.
   *
   * Resolution d'assemblee : les penalites deviennent indissociables des
   * cotisations. Regler sa cotisation en laissant courir ses penalites ne
   * protege plus -- c'est l'abus que l'assemblee a constate, jusqu'a quinze mois
   * de penalites en souffrance.
   */
  penalitesImpayeesAvantExclusion: 3,
  /** Penalite due par tranche d'absences injustifiees en reunion, en FCFA. */
  penaliteAbsence: 2_000,
  /**
   * Nombre d'absences injustifiees qui forment une tranche penalisable.
   *
   * Le club ne sanctionne pas l'empechement ponctuel mais sa repetition : une
   * absence isolee ne coute rien, la deuxieme fait naitre la penalite.
   */
  absencesParTranche: 2,
  /** Le president releve la valeur du compte-titres tous les 2 mois. */
  periodiciteValorisationMois: 2,
} as const;

/**
 * Dates d'effet des decisions d'assemblee.
 *
 * Separees de REGLES, qui ne porte que des valeurs numeriques surchargeables par
 * la table `settings`. Une sanction ne retroagit pas sur des faits anterieurs a
 * la decision qui l'institue : ces dates sont donc du metier, pas du reglage.
 */
export const EFFET = {
  /** Exclusion pour penalites impayees : applicable a partir de cette date. */
  penalitesIndissociables: "2027-01-10",
} as const;

/**
 * « de janvier », mais « d'avril » : l'elision devant voyelle.
 *
 * Trois mois commencent par une voyelle en francais -- avril, aout, octobre --
 * et « de octobre » saute aux yeux dans un courrier adresse a dix personnes.
 */
export function deMois(isoMois: string): string {
  const nom = moisLong(isoMois);
  return /^[aeiouyAEIOUY]/.test(nom) ? `d'${nom}` : `de ${nom}`;
}

/**
 * Ramene un taux lu en base a la convention du code, ou le rejette.
 *
 * Un taux se dit de deux facons : 0,1 ou 10 %. L'application precedente ecrivait
 * la seconde, celle-ci attend la premiere -- et rien ne les distinguait. Lu tel
 * quel, un taux de 10 valait 1 000 % : la penalite d'un mois serait passee de
 * 500 a 50 000 FCFA sans que rien ne s'en emeuve.
 *
 * Au-dela de 1, un taux ne peut etre qu'un pourcentage : aucun club ne penalise
 * au-dela de 100 % du versement du. On le ramene donc, plutot que d'ecarter un
 * reglage que le tresorier a bel et bien saisi. Au-dela de 100 apres conversion,
 * ce n'est plus un taux : on le rejette.
 */
export function tauxNormalise(valeur: number): number | null {
  if (!Number.isFinite(valeur) || valeur <= 0) return null;
  const taux = valeur > 1 ? valeur / 100 : valeur;
  return taux > 1 ? null : taux;
}

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

/**
 * L'adresse du site, sans barre oblique finale.
 *
 * Les courriers y accrochent des chemins -- `${lien}/versements` -- et une barre
 * de trop donnerait `https://site//versements`. La plupart des serveurs le
 * pardonnent, pas tous, et personne ne pense a l'enlever en collant une adresse
 * copiee depuis la barre du navigateur. Autant la retirer ici une fois pour
 * toutes que de compter sur la vigilance.
 */
export function lienDuSite(): string {
  return variable("NEXT_PUBLIC_SITE_URL", "").replace(/\/+$/, "");
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
/**
 * Le premier jour du mois saisi, ou null si la saisie n'en est pas un.
 *
 * Un `<input type="month">` envoie « 2026-08 », sept caracteres, tandis que la
 * base range les periodes au premier du mois. Exiger dix caracteres la ou le
 * navigateur en envoie sept rejetait toute saisie -- et le message « mois de
 * depart invalide » accusait l'utilisateur d'une faute qu'il n'avait pas
 * commise.
 *
 * Les deux formes sont acceptees : le champ mois du navigateur, et une date
 * complete dont seul le mois compte.
 */
export function premierDuMois(saisie: string): string | null {
  const net = saisie.trim();
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(net)) return null;
  const [annee, mois] = net.split("-").map(Number);
  if (mois < 1 || mois > 12) return null;
  return `${String(annee).padStart(4, "0")}-${String(mois).padStart(2, "0")}-01`;
}

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
