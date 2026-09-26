/**
 * Mesures de performance du portefeuille.
 *
 * Le club investit par versements reguliers : un simple "valeur finale / total verse"
 * surestime ou sous-estime la performance selon le calendrier des apports. On mesure
 * donc en flux ponderes -- Dietz modifie sur une periode, TRI (XIRR) depuis l'origine.
 */

export type Flux = { date: string; montant: number };


function jours(a: string, b: string): number {
  return (Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
}

/**
 * Duree en annees entre deux dates, sur le meme decompte que le TRI.
 *
 * Annualiser suppose une duree : l'afficher a cote du taux dit sur quoi il porte,
 * et un taux annuel tire de quelques mois ne se lit pas comme un taux tenu trois ans.
 */
export function dureeEnAnnees(debut: string, fin: string): number {
  return jours(debut, fin) / 365;
}

/** Valeur actuelle nette d'une serie de flux datee, au taux annuel donne. */
function van(flux: Flux[], taux: number): number {
  if (flux.length === 0) return 0;
  const origine = flux[0].date;
  return flux.reduce((somme, f) => {
    const annees = jours(origine, f.date) / 365;
    return somme + f.montant / Math.pow(1 + taux, annees);
  }, 0);
}

/**
 * TRI annualise sur dates reelles (equivalent XIRR).
 * Bisection sur [-0,9999 ; 10] : plus lent que Newton mais ne diverge jamais,
 * ce qui compte davantage ici que la vitesse.
 */
export function tri(flux: Flux[]): number | null {
  if (flux.length < 2) return null;
  const tries = [...flux].sort((a, b) => a.date.localeCompare(b.date));
  const positifs = tries.some((f) => f.montant > 0);
  const negatifs = tries.some((f) => f.montant < 0);
  if (!positifs || !negatifs) return null;

  let bas = -0.9999;
  let haut = 10;
  let vBas = van(tries, bas);
  let vHaut = van(tries, haut);
  if (vBas * vHaut > 0) return null;

  for (let i = 0; i < 200; i++) {
    const milieu = (bas + haut) / 2;
    const vMilieu = van(tries, milieu);
    if (Math.abs(vMilieu) < 1e-7 || haut - bas < 1e-9) return milieu;
    if (vBas * vMilieu < 0) {
      haut = milieu;
      vHaut = vMilieu;
    } else {
      bas = milieu;
      vBas = vMilieu;
    }
  }
  return (bas + haut) / 2;
}

/**
 * Dietz modifie : rendement d'une periode, corrige du calendrier des apports.
 * R = (V1 - V0 - C) / (V0 + somme(wi x Ci)), wi = (T - ti) / T
 */
export function dietzModifie(
  valeurDebut: number,
  valeurFin: number,
  apports: Flux[],
  dateDebut: string,
  dateFin: string,
): { rendement: number | null; capitalMoyen: number; gain: number; apportsPeriode: number } {
  const T = jours(dateDebut, dateFin);
  const dansLaPeriode = apports.filter(
    (f) => f.date.slice(0, 10) > dateDebut.slice(0, 10) && f.date.slice(0, 10) <= dateFin.slice(0, 10),
  );
  const C = dansLaPeriode.reduce((s, f) => s + f.montant, 0);
  const gain = valeurFin - valeurDebut - C;

  if (T <= 0) {
    return { rendement: null, capitalMoyen: valeurDebut, gain, apportsPeriode: C };
  }

  const pondere = dansLaPeriode.reduce((s, f) => {
    const ti = jours(dateDebut, f.date);
    return s + ((T - ti) / T) * f.montant;
  }, 0);

  const capitalMoyen = valeurDebut + pondere;
  return {
    rendement: capitalMoyen > 0 ? gain / capitalMoyen : null,
    capitalMoyen,
    gain,
    apportsPeriode: C,
  };
}

/* ------------------------------------------------------------------ les parts */

export type PartMembre = {
  membreId: string;
  nom: string;
  /** Versements valides des mois echus : le seul capital qui donne des droits. */
  acquis: number;
  /** Versements valides de mois a venir : capital en depot, rendu au nominal. */
  avance: number;
  /** Penalites constatees et non reglees : elles quittent son capital. */
  dues: number;
  /** Tout ce qu'il a verse : acquis + avance. Sert a mesurer la plus-value. */
  verse: number;
  /** Sa quote-part du pot a partager, hors avances. */
  part: number;
  /** Ce qu'il detient : son avance au nominal, plus sa quote-part. */
  valeur: number;
  plusValue: number;
};

export type ApportMembre = {
  membreId: string;
  nom: string;
  acquis: number;
  avance: number;
  dues: number;
};

/**
 * Repartition de l'avoir du club entre ses membres.
 *
 * Trois principes, decides par le club :
 *
 * 1. L'avance est volontaire, donc elle ne rapporte rien. Elle est retiree du pot
 *    avant partage et rendue a son auteur au nominal. Sans quoi celui qui a la
 *    tresorerie pour payer six mois d'avance capterait une part des gains au
 *    detriment de celui qui paie chaque mois -- alors que les statuts exigent
 *    la meme chose des deux.
 *
 * 2. Le mois venu, l'avance rejoint d'elle-meme le capital acquis : ni perte,
 *    ni gain. C'est a l'appelant de faire ce classement, selon l'echeance.
 *
 * 3. La penalite constatee et impayee quitte le capital du membre (art. 9 : elle
 *    est acquise au benefice du club). Elle dilue son poids, et ce poids perdu se
 *    reporte sur tous les autres sans qu'aucun montant n'ait a etre deplace.
 *
 * `valeurTotale` est l'avoir du club, portefeuille et caisse reunis : une avance
 * versee ce mois-ci dort d'abord en caisse, et la retrancher du seul portefeuille
 * la prendrait ou elle ne se trouve pas encore.
 */
export function repartirParts(
  apports: ApportMembre[],
  valeurTotale: number,
): PartMembre[] {
  const avances = apports.reduce((t, m) => t + m.avance, 0);

  /*
   * Les avances sortent du pot avant partage. Le plancher a zero couvre le cas
   * limite ou elles excederaient l'avoir constate -- un releve de portefeuille
   * en retard sur un gros versement d'avance : mieux vaut ne rien partager que
   * repartir un montant negatif.
   */
  const aPartager = Math.max(0, valeurTotale - avances);

  const net = (m: ApportMembre) => Math.max(0, m.acquis - m.dues);
  const totalNet = apports.reduce((t, m) => t + net(m), 0);

  return apports
    .map((m) => {
      const part = totalNet > 0 ? net(m) / totalNet : 0;
      const valeur = m.avance + part * aPartager;
      const verse = m.acquis + m.avance;
      return { ...m, verse, part, valeur, plusValue: valeur - verse };
    })
    .sort((a, b) => b.valeur - a.valeur);
}

/** Une duree en annees, dite comme on la dit : « 2 ans et 3 mois ». */
export function dureeEnClair(annees: number): string {
  const mois = Math.max(0, Math.round(annees * 12));
  if (mois < 12) return `${mois} mois`;
  const ans = Math.floor(mois / 12);
  const reste = mois % 12;
  const debut = `${ans} an${ans > 1 ? "s" : ""}`;
  return reste === 0 ? debut : `${debut} et ${reste} mois`;
}

export function pourcent(x: number | null, decimales = 1): string {
  if (x === null || !Number.isFinite(x)) return "--";
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(decimales).replace(".", ",")} %`;
}
