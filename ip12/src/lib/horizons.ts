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

/* ------------------------------------------------------- reperes de temps */

const MOIS_COURTS = [
  "janv.", "févr.", "mars", "avr.", "mai", "juin",
  "juil.", "août", "sept.", "oct.", "nov.", "déc.",
];

export type Repere = { iso: string; libelle: string };

const enJours = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000;

/**
 * Les reperes a poser sous l'abscisse : le premier de chaque mois, ou de chaque
 * annee quand la periode en couvre plus de deux.
 *
 * L'axe ne portait que ses deux bouts. Rien ne disait alors ou tombait le
 * milieu : les cinq releves serres dans le seul mois de septembre 2026 se
 * lisaient comme une progression etalee sur l'annee, ce qui est exactement le
 * defaut qu'on avait corrige en passant l'abscisse au temps.
 *
 * DEUX REPERES NE SE CHEVAUCHENT PAS. On garde le premier et on laisse tomber
 * ceux qui tomberaient a moins de `ecartMini` pixels du precedent retenu --
 * une etiquette illisible vaut moins que pas d'etiquette. Les derniers
 * `reserve` pixels sont laisses a la date de fin, qui s'y tient a demeure.
 *
 * L'annee accompagne le premier repere et chaque mois de janvier : ailleurs
 * elle se repete pour rien.
 */
export function reperesTemps(
  debut: string,
  fin: string,
  largeur: number,
  ecartMini = 60,
  reserve = 110,
  /*
   * LA PREMIERE ETIQUETTE EST PLUS LARGE QUE LES AUTRES : elle porte l'annee,
   * « janv. 2026 » contre « mars ». Elle est aussi calee a gauche au lieu
   * d'etre centree, donc elle s'etend vers la droite sur toute sa largeur. Sur
   * un telephone, « mars » tombait a 71 px et passait dessous. On exige donc
   * davantage de place apres elle qu'entre deux mois ordinaires.
   */
  ecartApresPremier = 100,
): Repere[] {
  const t0 = enJours(debut);
  const t1 = enJours(fin);
  const duree = t1 - t0;
  if (duree <= 0 || largeur <= 0) return [];

  /* Au-dela de deux ans, trente-huit noms de mois n'entrent nulle part. */
  const parAnnee = duree > 730;

  const mois = (iso: string) => MOIS_COURTS[Number(iso.slice(5, 7)) - 1];
  /*
   * Le premier repere dit ou l'axe commence, avec son annee : rien ne la porte
   * avant lui, et les suivants ne la repetent qu'en janvier. Le jour n'y figure
   * pas -- l'etiquette est posee sous le point de depart, qui le dit lui-meme,
   * et « 30 juin 2026 » ne tient pas sous un graphique de telephone.
   */
  const candidats: Repere[] = [
    { iso: debut, libelle: `${mois(debut)} ${debut.slice(0, 4)}` },
  ];

  const a0 = Number(debut.slice(0, 4));
  const a1 = Number(fin.slice(0, 4));
  for (let a = a0; a <= a1; a++) {
    for (let m = 1; m <= 12; m++) {
      if (parAnnee && m !== 1) continue;
      const iso = `${a}-${String(m).padStart(2, "0")}-01`;
      if (enJours(iso) <= t0 || enJours(iso) > t1) continue;
      /* Janvier porte son annee : c'est la seule chose qu'il apprend. */
      candidats.push({ iso, libelle: m === 1 ? String(a) : mois(iso) });
    }
  }

  /*
   * DEUX ETIQUETTES NE SE CHEVAUCHENT PAS. On garde la premiere et l'on laisse
   * tomber celles qui suivent de trop pres : une etiquette illisible vaut moins
   * que pas d'etiquette. Les derniers pixels sont reserves a la date de fin,
   * qui s'y tient a demeure.
   */
  const gardes: Repere[] = [];
  let dernierX = -Infinity;
  for (const c of candidats) {
    const px = ((enJours(c.iso) - t0) / duree) * largeur;
    if (px > largeur - reserve) break;
    const exige = gardes.length === 1 ? ecartApresPremier : ecartMini;
    if (px - dernierX < exige) continue;
    gardes.push(c);
    dernierX = px;
  }
  return gardes;
}
