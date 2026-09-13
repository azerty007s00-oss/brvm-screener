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
  verse: number;
  part: number;
  valeur: number;
  plusValue: number;
};

/**
 * La part d'un membre est le rapport de ses versements valides au total du club
 * (art. 12 : les votes sont proportionnels aux parts).
 */
export function repartirParts(
  versesParMembre: { membreId: string; nom: string; verse: number }[],
  valeurPortefeuille: number,
): PartMembre[] {
  const total = versesParMembre.reduce((s, m) => s + m.verse, 0);
  return versesParMembre
    .map((m) => {
      const part = total > 0 ? m.verse / total : 0;
      const valeur = part * valeurPortefeuille;
      return { ...m, part, valeur, plusValue: valeur - m.verse };
    })
    .sort((a, b) => b.part - a.part);
}

export function pourcent(x: number | null, decimales = 1): string {
  if (x === null || !Number.isFinite(x)) return "--";
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(decimales).replace(".", ",")} %`;
}
