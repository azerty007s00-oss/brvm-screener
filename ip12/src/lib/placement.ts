/**
 * Le net place en bourse, et la decomposition d'une hausse.
 *
 * POURQUOI CE FICHIER EXISTE.
 *
 * Le graphique du portefeuille affichait, sous la courbe, la variation de la
 * valeur rapportee au premier releve de la periode : « +78,1 % » sur
 * l'exercice, « +2 657,6 % » depuis l'origine. Ces pourcentages ne mesuraient
 * rien. La valeur d'un club qui cotise monte d'abord parce que ses membres
 * versent : sur l'exercice 2026, 683 720 FCFA sont entres au compte-titres, et
 * les compter comme un gain multipliait la performance par deux. Le meme ecran
 * affichait pourtant, quelques centimetres plus haut, +40,4 % (Dietz modifie)
 * et +37,6 % (TRI). Un membre lisait le plus gros des trois.
 *
 * Une hausse de valeur se decompose en deux, et les deux se disent :
 *
 *     valeur fin - valeur debut  =  apports nets  +  gain de gestion
 *
 * Les apports nets sont ce que le club a mis de sa poche pendant la periode ;
 * le gain de gestion est ce que le marche a fait du capital. Seul le second est
 * une performance.
 *
 * C'est la meme soustraction que celle de Dietz modifie (`gain = V1 - V0 - C`),
 * a ceci pres qu'on ne la rapporte a aucun capital : ce fichier ne produit
 * aucun taux, et laisse le taux a `perf.ts`, qui sait le ponderer.
 */

/** Un mouvement vers le compte-titres, deja signe : negatif pour un retrait. */
export type FluxPlace = { date: string; net: number };

/**
 * Le net place a chaque date donnee : la somme des flux dates AU PLUS TARD ce
 * jour-la.
 *
 * Au plus tard, et non strictement avant : un virement du 28 septembre figure
 * dans le releve du 28 septembre, et l'exclure ferait apparaitre son montant
 * comme un gain du jour.
 */
export function netPlaceParDate(dates: string[], flux: FluxPlace[]): number[] {
  const tries = [...flux].sort((a, b) => a.date.localeCompare(b.date));
  return dates.map((d) => {
    const jour = d.slice(0, 10);
    let total = 0;
    for (const f of tries) {
      if (f.date.slice(0, 10) > jour) break;
      total += f.net;
    }
    return total;
  });
}

export type Trace = {
  date: string;
  valeur: number;
  netPlace: number;
  /** La part investie et la part liquide, pour le detail au survol. */
  actions?: number;
  liquidites?: number;
};

export type Decomposition = {
  /** V fin - V debut : ce que le releve a gagne en valeur affichee. */
  ecartValeur: number;
  /** Net place fin - net place debut : ce que le club y a verse entre-temps. */
  apportsNets: number;
  /** La difference : ce que la gestion a fait, et rien d'autre. */
  gain: number;
};

/** La decomposition d'une periode, de son premier releve a son dernier. */
export function decomposer(traces: Trace[]): Decomposition | null {
  if (traces.length < 2) return null;
  const debut = traces[0];
  const fin = traces[traces.length - 1];
  const ecartValeur = fin.valeur - debut.valeur;
  const apportsNets = fin.netPlace - debut.netPlace;
  return { ecartValeur, apportsNets, gain: ecartValeur - apportsNets };
}

/**
 * Le controle : le gain d'exercice calcule ici doit retomber sur celui que
 * l'accueil et le bandeau annoncent, calcule par Dietz modifie a partir des
 * memes releves et des memes apports.
 *
 * Les deux chemins sont independants -- l'un part des releves traces, l'autre
 * de la synthese -- et doivent donner le meme chiffre au franc pres. S'ils
 * divergent, c'est qu'une des deux lectures est fausse, et on prefere ne rien
 * annoncer qu'annoncer un chiffre de plus.
 *
 * La tolerance est d'un franc : les deux chemins arrondissent au meme endroit,
 * mais rien ne garantit que le total passe par les memes sommes partielles.
 */
export function gainConcorde(gain: number, reference: number | null): boolean {
  if (reference === null) return false;
  return Math.abs(gain - reference) <= 1;
}
