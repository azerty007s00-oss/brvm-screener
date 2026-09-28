import type { CelluleMois, StatutMois } from "./penalites";

/**
 * Le vocabulaire des etats : leurs noms, leur ordre, et la phrase qui resume
 * une ligne.
 *
 * Separe du dessin parce qu'il se verifie sans navigateur. La premiere version
 * vivait dans le composant, et une faute d'ordre y est passee : les mois en
 * retard etaient nommes avant les mois incomplets, ce qui donnait « Retard :
 * juin, avr. » -- deux mois justes, dans un ordre que personne ne lit. Un
 * controle l'aurait vue ; il en existe un, maintenant.
 */

export const LIBELLE_STATUT: Record<StatutMois, string> = {
  paye: "Paye",
  paye_en_retard: "Paye en retard",
  en_attente: "En attente",
  partiel: "Incomplet",
  retard: "En retard",
  a_venir: "A venir",
  hors_periode: "Hors periode",
};

/** Les six etats qui figurent en legende : « hors periode » n'est rien a montrer. */
export const STATUTS_LEGENDE: StatutMois[] = [
  "paye",
  "paye_en_retard",
  "en_attente",
  "partiel",
  "retard",
  "a_venir",
];

const MOIS_COURTS = [
  "janv.", "fevr.", "mars", "avr.", "mai", "juin",
  "juil.", "aout", "sept.", "oct.", "nov.", "dec.",
];

/** « sept. » plutot que « septembre 2026 » : une frise n'a pas la place. */
export function moisCourt(iso: string): string {
  return MOIS_COURTS[Number(iso.slice(5, 7)) - 1] ?? iso.slice(0, 7);
}

/** L'initiale du mois, pour l'echelle posee au-dessus des frises. */
export function initialeMois(iso: string): string {
  return moisCourt(iso).charAt(0).toUpperCase();
}

/**
 * L'etat d'une ligne, en toutes lettres.
 *
 * Douze glyphes cote a cote disent tout, mais seulement a qui les compte. La
 * phrase dit d'un coup ce qui reclame une action : « Retard : aout, sept. »
 *
 * Rien n'est recalcule ici : les etats sont ceux des cellules, l'ordre de
 * priorite est celui du reglement -- ce qui est du avant ce qui attend, et ce
 * qui attend avant ce qui est en regle.
 */
export function statutLigne(cellules: CelluleMois[]): {
  texte: string;
  encre: string;
} {
  /*
   * Les mois restent dans l'ordre du calendrier.
   *
   * Nommer d'abord les retards puis les mois incomplets donnait « Retard :
   * juin, avr. » -- deux mois justes, dans un ordre que personne ne lit. Les
   * cellules arrivent deja rangees : il suffit de ne pas les redistribuer.
   */
  const nomme = (...etats: StatutMois[]) =>
    cellules.filter((c) => etats.includes(c.statut)).map((c) => moisCourt(c.mois));

  /*
   * Deux mois nommes, pas davantage.
   *
   * « Retard : mai, juin, juil., aout » ne tenait pas a cote du nom : le
   * navigateur coupait la phrase en « Retard : mai, jui... », et le nom du
   * membre avec. Deux mois et un compte disent la meme chose en tenant sur la
   * ligne -- le detail complet est a un doigt, dans le depliant.
   */
  const liste = (mois: string[]) =>
    mois.length <= 2 ? mois.join(", ") : `${mois.slice(0, 2).join(", ")} +${mois.length - 2}`;

  const du = nomme("retard", "partiel");
  if (du.length > 0) {
    return { texte: `Retard : ${liste(du)}`, encre: "var(--rouge-encre)" };
  }

  const attente = nomme("en_attente");
  if (attente.length > 0) {
    return { texte: `En attente : ${liste(attente)}`, encre: "var(--ambre-encre)" };
  }

  /*
   * Une avance est un fait remarquable : elle n'ouvre aucun droit de plus sur
   * les benefices, mais son auteur merite de la voir portee a son credit.
   */
  const aujourdhui = new Date().toISOString().slice(0, 7);
  const avance = cellules
    .filter((c) => c.mois.slice(0, 7) > aujourdhui && (c.statut === "paye" || c.statut === "paye_en_retard"))
    .map((c) => moisCourt(c.mois));

  return {
    texte: avance.length > 0 ? `A jour, avance ${avance.at(-1)}` : "A jour",
    encre: "var(--vert-encre)",
  };
}

/** Le compte en toutes lettres, pour qui ecoute la page au lieu de la voir. */
export function resumeFrise(cellules: CelluleMois[], prefixe: string): string {
  const vus = cellules.filter((c) => c.statut !== "hors_periode");
  const parts = STATUTS_LEGENDE.map((s) => {
    const n = vus.filter((c) => c.statut === s).length;
    return n > 0 ? `${n} ${LIBELLE_STATUT[s].toLowerCase()}` : null;
  }).filter(Boolean);
  return `${prefixe}, ${vus.length} mois : ${parts.join(", ")}`;
}
