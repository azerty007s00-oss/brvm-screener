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
  /*
   * Ouverture du compte-titres chez la SGI.
   *
   * Les premiers virements portent la date a laquelle l'argent a quitte la
   * caisse, plusieurs semaines avant que le compte existe : il a dormi en
   * transit, il n'etait pas place. Le TRI les ramene a cette date -- compter le
   * capital comme investi avant qu'il ne le soit allonge la periode et abaisse
   * le taux annualise, qui annoncerait alors moins que ce que le club a
   * reellement obtenu.
   *
   * Les ecritures, elles, gardent leur date : c'est bien ce jour-la que la
   * caisse s'est videe.
   */
  ouvertureCompteTitres: "2023-07-17",
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
  /* L'unite ne quitte pas son montant : « 3 857 845 » sur une ligne et
   * « FCFA » sur la suivante se lit comme deux informations. */
  return `${nombre(montant)} FCFA`;
}

/**
 * Le nombre seul : 5000 -> "5 000".
 *
 * Reserve aux couples ou l'unite vaut pour les deux : « 2 500 sur 5 000 FCFA »
 * tient sur une ligne la ou « 2 500 FCFA sur 5 000 FCFA » passe a la suivante,
 * et le premier FCFA n'apprend rien.
 *
 * LES ESPACES DE GROUPEMENT SONT INSECABLES.
 *
 * La premiere version les remplacait par des espaces ordinaires, pour que la
 * chaine se compare et se cherche comme on l'ecrit. Le navigateur y a vu des
 * points de coupure : « Dernier releve : 3 / 857 845 FCFA » dans le panneau,
 * « gain 1 / 005 751 » dans le bandeau sur telephone. Un montant coupe en deux
 * ne se lit plus comme un montant -- il se lit comme deux nombres. On garde
 * donc l'insecable, en ramenant l'etroit (U+202F) sur l'ordinaire (U+00A0) :
 * les deux ne se coupent pas, mais U+202F manque a beaucoup de polices
 * systeme, et s'y affiche en rectangle vide.
 */
export function nombre(montant: number): string {
  return Math.round(montant).toLocaleString("fr-FR").replace(/ /g, " ");
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

/**
 * Les jours qui restent avant l'echeance du mois : negatif une fois passee.
 *
 * Vit ici, et non dans `relance.ts`, pour etre verifiable : ce fichier se
 * compile sans base ni `server-only`, et la regle qui decide du ton d'un
 * courrier envoye a dix personnes merite un controle.
 */
/**
 * Accorde un mot a un nombre.
 *
 * « 1 penalite(s) impayee(s) » est une facilite de developpeur, et elle se
 * lisait en tete d'un courrier adresse a dix personnes. Le nombre est toujours
 * connu au moment d'ecrire la phrase ; rien ne justifie de laisser le lecteur
 * choisir.
 *
 * Les accords irreguliers ne sont pas du ressort de cette fonction : on lui
 * donne la forme plurielle quand elle differe d'un simple « s ».
 */
export function accorde(n: number, singulier: string, pluriel?: string): string {
  return n > 1 ? (pluriel ?? `${singulier}s`) : singulier;
}

/**
 * Nettoie un texte saisi par le bureau avant de l'envoyer par courriel.
 *
 * Les notes des regles individuelles sont collees depuis WhatsApp, et en
 * portent le balisage : « *Resolutions :* *Mesure disciplinaire concernant...* ».
 * WhatsApp en fait du gras ; un courriel en texte brut affiche les etoiles. Le
 * membre lisait donc la ponctuation d'un autre outil au milieu d'une mesure
 * disciplinaire.
 *
 * On retire le balisage plutot que de le traduire : le courrier est en texte
 * brut, il n'a pas de gras a offrir. Les retours a la ligne multiples se
 * reduisent a un seul -- un texte colle en traine souvent.
 */
export function texteLisible(brut: string | null): string {
  if (!brut) return "";
  return brut
    /* *gras*, _italique_, ~barre~ et `code` de WhatsApp, autour d'un mot ou d'une phrase. */
    .replace(/(^|[\s(])[*_~`]+([^*_~`\n]+?)[*_~`]+(?=[\s).,:;!?]|$)/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export function joursAvantEcheance(maintenant: Date): number {
  return REGLES.jourEcheance - maintenant.getUTCDate();
}

/**
 * Ou l'on en est de l'echeance du mois.
 *
 * TROIS ETATS, ET NON DEUX. Le code n'en connaissait que deux -- avant le 10,
 * et tout le reste -- et ecrivait donc « est du aujourd'hui, dernier jour de
 * l'echeance statutaire » aussi bien le 10 que le 30. Le 30 septembre, un
 * membre en retard de vingt jours, penalise pour ce retard, lisait dans le
 * meme courrier qu'il avait une penalite impayee ET que son versement etait du
 * du jour meme. La phrase le dedouanait de ce que la ligne suivante lui
 * reprochait.
 */
export function etatEcheance(maintenant: Date): "a_venir" | "aujourdhui" | "passee" {
  const reste = joursAvantEcheance(maintenant);
  if (reste > 0) return "a_venir";
  return reste === 0 ? "aujourdhui" : "passee";
}

/** Un mois est exigible des que son echeance (le 10) est passee. */
export function estExigible(isoMois: string, aujourdhui: Date = new Date()): boolean {
  const echeance = new Date(`${isoMois.slice(0, 8)}${String(REGLES.jourEcheance).padStart(2, "0")}T23:59:59Z`);
  return aujourdhui > echeance;
}
