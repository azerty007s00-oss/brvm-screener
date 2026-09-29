/**
 * Les horizons de temps du graphique : quels releves on trace.
 *
 * Separe du dessin parce que la regle se verifie sans navigateur, et qu'elle a
 * deux pieges qu'un coup d'oeil ne voit pas : trois mois en arriere depuis le
 * 31 mars, et un exercice dont le premier releve tombe le 1er janvier.
 *
 * Rien n'est interpole : une periode retient les releves dont la date tombe
 * apres sa borne, et l'on ne dessine pas un point qui n'existe pas. C'est
 * pourquoi une periode peut n'en porter aucun, ou un seul -- auquel cas elle ne
 * se trace pas, et l'ecran le dit au lieu de montrer une ligne inventee.
 */

export type Horizon = "trimestre" | "exercice" | "origine";

export type Releve = { date: string; valeur: number };

/**
 * La borne basse d'un horizon, a partir de la date du dernier releve.
 *
 * `null` pour « depuis l'origine » : elle n'en a pas.
 *
 * Trois mois en arriere se compte en mois, non en 90 jours : depuis le
 * 31 mars, c'est le 31 decembre, et non le 31 ou le 30 selon l'annee. Un mois
 * plus court fait deborder la date sur le mois suivant -- le 31 mai moins trois
 * mois donnerait le 2 mars -- et l'on ramene alors au dernier jour du mois vise,
 * seule lecture qui corresponde a ce qu'on entend par « trois mois ».
 */
export function borne(horizon: Horizon, fin: string): string | null {
  if (horizon === "origine") return null;
  if (horizon === "exercice") return `${fin.slice(0, 4)}-01-01`;

  const annee = Number(fin.slice(0, 4));
  const mois = Number(fin.slice(5, 7));
  const jour = Number(fin.slice(8, 10));

  const cible = mois - 3;
  const anneeVisee = cible <= 0 ? annee - 1 : annee;
  const moisVise = cible <= 0 ? cible + 12 : cible;
  const dernierJour = new Date(Date.UTC(anneeVisee, moisVise, 0)).getUTCDate();
  const jourVise = Math.min(jour, dernierJour);

  return `${anneeVisee}-${String(moisVise).padStart(2, "0")}-${String(jourVise).padStart(2, "0")}`;
}

/** Les releves que l'horizon retient, dans l'ordre ou ils arrivent. */
export function retenus<T extends Releve>(releves: T[], horizon: Horizon): T[] {
  if (releves.length === 0) return [];
  const fin = releves[releves.length - 1].date;
  const b = borne(horizon, fin);
  return b === null ? releves : releves.filter((r) => r.date >= b);
}

/** Vrai si l'horizon porte de quoi tracer : deux points au moins. */
export function tracable(releves: Releve[], horizon: Horizon): boolean {
  return retenus(releves, horizon).length >= 2;
}
