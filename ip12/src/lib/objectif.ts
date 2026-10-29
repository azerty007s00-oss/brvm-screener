/**
 * L'OBJECTIF DU CLUB : UN CAP, ET LE CHEMIN QUI Y MENE.
 *
 * Le president fixe un montant de portefeuille et un mois pour l'atteindre ;
 * l'accueil montre a chacun ou en est le club. La mesure est la valeur du
 * dernier releve, celle de la tuile « Portefeuille du club » juste au-dessus :
 * deux chiffres differents pour la meme chose, cote a cote, se contrediraient.
 *
 * Tout ce qui suit est un calcul pur, sans base ni horloge : les dates arrivent
 * en arguments, pour que la verification puisse le rejouer a l'identique.
 */

export type Objectif = {
  /** Le portefeuille vise, en FCFA. */
  montant: number;
  /** Le mois de l'echeance, AAAA-MM-01 : l'objectif vaut jusqu'a sa fin. */
  echeance: string;
  /** « 5 millions fin 2027 » ; a defaut, l'accueil dit « Objectif du club ». */
  intitule: string | null;
  /** Le jour ou il a ete fixe, AAAA-MM-JJ. */
  fixeLe: string;
  /** La valeur du portefeuille ce jour-la : le depart du chemin attendu. */
  depart: number | null;
};

/** Les cles de la table `settings`. Des codes : sans accent, compares tels quels. */
export const CLES_OBJECTIF = {
  montant: "objectif_montant",
  echeance: "objectif_echeance",
  intitule: "objectif_intitule",
  fixeLe: "objectif_fixe_le",
  depart: "objectif_depart",
} as const;

/** L'objectif en vigueur, lu dans les reglages ; null s'il n'y en a pas ou s'il est illisible. */
export function lireObjectif(table: Map<string, string>): Objectif | null {
  const montant = Number(table.get(CLES_OBJECTIF.montant));
  const echeance = table.get(CLES_OBJECTIF.echeance) ?? "";
  const fixeLe = table.get(CLES_OBJECTIF.fixeLe) ?? "";
  if (!Number.isFinite(montant) || montant <= 0) return null;
  if (!/^\d{4}-\d{2}-01$/.test(echeance) || !/^\d{4}-\d{2}-\d{2}$/.test(fixeLe)) return null;
  const depart = Number(table.get(CLES_OBJECTIF.depart));
  const intitule = (table.get(CLES_OBJECTIF.intitule) ?? "").trim();
  return {
    montant,
    echeance,
    intitule: intitule || null,
    fixeLe,
    depart: table.has(CLES_OBJECTIF.depart) && Number.isFinite(depart) && depart >= 0 ? depart : null,
  };
}

/** Nombre de mois de `de` a `a`, deux mois AAAA-MM : 0 pour le meme mois. */
export function ecartMois(de: string, a: string): number {
  const [a1, m1] = de.split("-").map(Number);
  const [a2, m2] = a.split("-").map(Number);
  return (a2 - a1) * 12 + (m2 - m1);
}

function moisPlus(mois: string, n: number): string {
  const [a, m] = mois.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Le dernier jour du mois, a minuit UTC, en millisecondes. */
function finDuMois(mois: string): number {
  const [a, m] = mois.split("-").map(Number);
  return Date.UTC(a, m, 0);
}

export type Avancement = {
  /** La part du chemin faite : 0,6 pour 60 %. Peut depasser 1. */
  atteint: number;
  /** Ce qui manque, jamais negatif. */
  reste: number;
  /** Les mois pleins entre le mois en cours et l'echeance, celle-ci comprise. */
  moisRestants: number;
  /**
   * Ou il faudrait en etre a la date du releve, sur une ligne droite du jour
   * ou l'objectif a ete fixe a son echeance. Null sans valeur de depart, ou
   * tant qu'aucun releve n'a suivi.
   */
  attendu: number | null;
  /**
   * Le mois ou le seul rythme des cotisations y mene, compte depuis le
   * releve. Null si rien ne rentre, ou si c'est deja fait.
   */
  arrivee: string | null;
  /** L'arrivee au rythme des cotisations tombe-t-elle avant la fin de l'echeance ? */
  aTemps: boolean;
  /** Ce qu'il faut gagner chaque mois jusqu'a l'echeance. */
  parMois: number;
  /** Le portefeuille a l'echeance si seules les cotisations y entrent. */
  cotisationsSeules: number;
  /** Ce qui doit venir de la bourse pour combler l'ecart. */
  partBourse: number;
  /**
   * Le rendement annuel que cela demande, sur un portefeuille moyen entre
   * aujourd'hui et la cible. Null quand l'echeance est deja la.
   */
  tauxRequis: number | null;
  /** L'echeance est passee sans que la cible soit atteinte. */
  echu: boolean;
};

/**
 * Le chemin parcouru et ce qu'il reste a faire.
 *
 * @param valeur      le portefeuille au dernier releve
 * @param dateValeur  la date de ce releve, AAAA-MM-JJ
 * @param rythme      ce que les cotisations apportent chaque mois
 * @param aujourdhui  AAAA-MM-JJ
 */
export function avancement(
  o: Objectif,
  valeur: number,
  dateValeur: string,
  rythme: number,
  aujourdhui: string,
): Avancement {
  const reste = Math.max(0, o.montant - valeur);
  const moisCourant = `${aujourdhui.slice(0, 7)}-01`;
  const moisRestants = Math.max(0, ecartMois(moisCourant, o.echeance));
  const echu = reste > 0 && moisCourant > o.echeance;

  /*
   * Pas de repere tant qu'aucun releve n'a suivi la fixation de l'objectif : la
   * valeur de depart EST le dernier releve, et le trait tomberait pile sur la
   * barre, sans rien apprendre a personne.
   */
  let attendu: number | null = null;
  if (o.depart !== null && dateValeur > o.fixeLe) {
    const t0 = Date.parse(`${o.fixeLe}T00:00:00Z`);
    const t1 = finDuMois(o.echeance);
    const t = Date.parse(`${dateValeur}T00:00:00Z`);
    const fraction = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1;
    attendu = (o.depart + fraction * (o.montant - o.depart)) / o.montant;
  }

  /*
   * Le rythme est celui des cotisations seules : la bourse monte et descend,
   * les versements tombent chaque mois. C'est la seule projection que le club
   * peut tenir pour acquise, et l'accueil le dit en toutes lettres.
   */
  const arrivee = reste === 0 || rythme <= 0 ? null : moisPlus(`${dateValeur.slice(0, 7)}-01`, Math.ceil(reste / rythme));
  const aTemps = reste === 0 || (arrivee !== null && arrivee <= o.echeance);

  const cotisationsSeules = valeur + rythme * moisRestants;
  const partBourse = Math.max(0, o.montant - cotisationsSeules);
  const moyenne = (valeur + o.montant) / 2;
  const tauxRequis =
    moisRestants === 0 || moyenne <= 0 ? null : partBourse / (moyenne * (moisRestants / 12));

  return {
    atteint: o.montant > 0 ? valeur / o.montant : 0,
    reste,
    moisRestants,
    attendu,
    arrivee,
    aTemps,
    parMois: moisRestants > 0 ? Math.ceil(reste / moisRestants) : reste,
    cotisationsSeules,
    partBourse,
    tauxRequis,
    echu,
  };
}

/** « 5 000 000 », « 5000000 », « 5.000.000 » : le montant saisi, ou null. */
export function lireMontant(saisie: string): number | null {
  const net = saisie.replace(/[\s  .]/g, "");
  if (!/^\d{1,13}$/.test(net)) return null;
  const n = Number(net);
  return n > 0 ? n : null;
}
