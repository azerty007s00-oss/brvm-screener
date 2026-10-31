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
  /**
   * Penalites dues et non reglees, inscrites ou qui courent : une dette envers le
   * club, retranchee de sa part a son montant.
   */
  dues: number;
  /** Pour une part rachetee : le poids recu du sortant et le prix paye (voir `ApportMembre`). */
  rachat?: { poids: number; prix: number };
  /**
   * Tout ce qu'il a verse : acquis + avance, le prix paye au rachat tenant lieu du
   * poids recu pour une part rachetee. Sert a mesurer la plus-value.
   */
  verse: number;
  /** Sa quote-part du pot a partager, hors avances. */
  part: number;
  /** Ce qu'il detient : son avance au nominal, plus sa quote-part, moins ses penalites. */
  valeur: number;
  plusValue: number;
};

export type ApportMembre = {
  membreId: string;
  nom: string;
  acquis: number;
  avance: number;
  dues: number;
  /**
   * Pour une part rachetee : le poids recu du sortant, compris dans `acquis`, et
   * le prix que son detenteur a paye au sortant. Le poids fixe sa part du pot ;
   * le prix est ce que le detenteur y a mis, et c'est sur lui que se mesure sa
   * plus-value. Absent pour une personne.
   */
  rachat?: { poids: number; prix: number };
};

/**
 * Le pot que se partagent les membres, et ce qui le compose.
 *
 * Exporte a part parce que le courrier de sortie l'ecrit ligne a ligne : le
 * sortant doit pouvoir refaire l'addition, et elle doit tomber sur le chiffre
 * dont sa part est tiree. Une seule fonction, donc un seul calcul.
 */
export function potAPartager(
  apports: ApportMembre[],
  valeurTotale: number,
): { avances: number; creances: number; aPartager: number; cotisations: number } {
  const avances = apports.reduce((t, m) => t + m.avance, 0);
  const creances = apports.reduce((t, m) => t + Math.max(0, m.dues), 0);
  /*
   * Les avances sortent du pot avant partage ; les penalites dues y entrent,
   * comme creances du club. Le plancher a zero couvre le cas limite ou les
   * avances excederaient l'avoir constate -- un releve de portefeuille en retard
   * sur un gros versement d'avance : mieux vaut ne rien partager que repartir un
   * montant negatif.
   */
  const aPartager = Math.max(0, valeurTotale + creances - avances);
  /* Le poids de chacun : ses cotisations des mois echus, jamais negatives. */
  const cotisations = apports.reduce((t, m) => t + Math.max(0, m.acquis), 0);
  return { avances, creances, aPartager, cotisations };
}

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
 * 3. La penalite impayee est une dette du membre envers le club, a son montant
 *    (art. 9 : elle est acquise au benefice du club). Le club la detient comme
 *    une creance : elle s'ajoute au pot a partager, et se retranche de la part du
 *    membre qui la doit. Son poids, lui, ne change pas.
 *
 *    DECISION DU BUREAU (octobre 2026), sur deux audits independants. La regle
 *    precedente retirait la penalite du capital du membre : elle diluait son
 *    poids, et une penalite de 500 FCFA lui en coutait environ 850, selon la
 *    performance du club. Payee, la meme penalite lui coutait 450. Desormais,
 *    payer ou ne pas payer ne change rien a la valeur nette de sa part : la
 *    penalite coute son montant, ni plus ni moins.
 *
 * `valeurTotale` est l'avoir du club, portefeuille et caisse reunis : une avance
 * versee ce mois-ci dort d'abord en caisse, et la retrancher du seul portefeuille
 * la prendrait ou elle ne se trouve pas encore.
 */
export function repartirParts(
  apports: ApportMembre[],
  valeurTotale: number,
): PartMembre[] {
  const { aPartager, cotisations } = potAPartager(apports, valeurTotale);
  const poids = (m: ApportMembre) => Math.max(0, m.acquis);

  return apports
    .map((m) => {
      const part = cotisations > 0 ? poids(m) / cotisations : 0;
      /*
       * Peut etre negative : un membre dont les penalites depassent sa part doit
       * au club plus qu'il n'y detient. La somme des parts reste l'avoir.
       */
      const valeur = m.avance + part * aPartager - Math.max(0, m.dues);
      /*
       * CE QU'IL Y A MIS, NON CE QU'IL A RECU.
       *
       * Une part rachetee porte le poids des cotisations du sortant : compte comme
       * verse, il affichait au detenteur le gain de ces cotisations depuis leur
       * paiement, des annees avant son rachat. Ce qu'il a mis, c'est le prix paye
       * au sortant, puis ses propres cotisations sur la part.
       */
      const verse = m.acquis - (m.rachat?.poids ?? 0) + (m.rachat?.prix ?? 0) + m.avance;
      return { ...m, verse, part, valeur, plusValue: valeur - verse };
    })
    .sort((a, b) => b.valeur - a.valeur);
}

/**
 * Ce que le sortant emporte : le decompte d'une sortie.
 *
 * DECISIONS DU BUREAU (octobre 2026), apres deux audits independants.
 *
 * - Sa part est arretee au releve : le releve, la caisse, les cotisations et les
 *   virements de ce jour-la (voir `synthese(…, arrete)`). Ses penalites y sont
 *   deja retranchees, a leur montant.
 * - Une provision pour frais de cession, au bareme de la SGI (1,4 %), porte sur
 *   sa quote-part des actions du releve. Elle reste acquise au club, qu'il vende
 *   ou non : les membres restants gardent ces titres et paieront ce cout le jour
 *   ou ils les vendront.
 * - Sa quote-part des frais de garde courus depuis le debut de l'annee, que la
 *   SGI n'a pas encore preleves.
 * - Les frais de transfert vers son compte, estimes a 2 % (art. 20) et
 *   remplaces par les frais reels quand ils sont connus. Ils ne touchent pas son
 *   avance, rendue intacte.
 */
export function decompteSortie(
  p: { valeur: number; avance: number; part: number },
  club: { actions: number; fraisGardeCourus: number },
  taux: { venteActions: number; transfert: number },
): { pocheActions: number; fraisVente: number; fraisGarde: number; fraisTransfert: number; net: number } {
  /*
   * Au franc pres d'abord : le courrier de sortie detaille chaque retenue, et le
   * sortant qui refait le calcul a la calculatrice doit retomber sur les memes
   * chiffres, sans centimes d'arrondi entre deux lignes.
   */
  const valeur = Math.round(p.valeur);
  const cessible = Math.max(0, valeur - Math.max(0, p.avance));
  const pocheActions = Math.min(cessible, Math.round(p.part * Math.max(0, club.actions)));
  const fraisVente = Math.round(pocheActions * taux.venteActions);
  const fraisGarde = Math.min(
    cessible - fraisVente,
    Math.round(p.part * Math.max(0, club.fraisGardeCourus)),
  );
  const fraisTransfert = Math.round(Math.max(0, cessible - fraisVente - fraisGarde) * taux.transfert);
  return {
    pocheActions,
    fraisVente,
    fraisGarde,
    fraisTransfert,
    net: Math.max(0, valeur - fraisVente - fraisGarde - fraisTransfert),
  };
}

/** Un membre qui rachete une partie des parts du sortant, au prix convenu entre eux. */
export type Rachat = { membreId: string; fraction: number; prix: number };

/**
 * Le partage d'une sortie entre le club et les membres qui rachetent ses parts.
 *
 * DECISIONS DU BUREAU (octobre 2026). Un ou plusieurs membres peuvent racheter
 * tout ou partie des parts du sortant, a un prix convenu entre eux ; le club
 * rachete le reste, au calcul de `decompteSortie`.
 *
 * - Ce qu'un membre rachete ne coute rien a la caisse et ne vend aucune action :
 *   aucun frais n'y est retenu. Le poids des cotisations rachetees passe a
 *   l'acheteur, et les parts des autres membres n'en bougent pas.
 * - Le club rend l'avance et paie la fraction qu'il rachete, frais deduits.
 * - Le prix convenu est ce que recoit le sortant. Les penalites du sortant
 *   suivent ce qui est rachete : le club retient sa part des siennes sur ce
 *   qu'il verse, chaque acheteur verse la sienne au club en plus du prix. Les
 *   cotisations impayees, l'acheteur les verse aussi (voir `enregistrerSortie`).
 *
 * Sans acheteur, le resultat est exactement celui de `decompteSortie`.
 */
export function partagerSortie(
  p: { avance: number; quotePart: number; part: number; acquis: number; penalites: number },
  club: { actions: number; fraisGardeCourus: number },
  taux: { venteActions: number; transfert: number },
  rachats: Rachat[],
): {
  fractionClub: number;
  droitsClub: number;
  pocheActions: number;
  fraisVente: number;
  fraisGarde: number;
  fraisTransfert: number;
  compensees: number;
  netClub: number;
  acheteurs: (Rachat & { poids: number; valeur: number; auClub: number; auSortant: number })[];
  resteDu: number;
} {
  const rachete = rachats.reduce((t, r) => t + r.fraction, 0);
  /* 70 % + 20 % + 10 % font 0,9999999999999999 en virgule flottante : on arrondit. */
  const fractionClub = Math.max(0, Math.round((1 - rachete) * 1e9) / 1e9);
  /*
   * AU FRANC PRES : les valeurs rachetees et la part du club font exactement la
   * part du sortant. Arrondies chacune de leur cote, deux moities d'une part
   * impaire depasseraient d'un franc ; le club prend donc le reste exact, et un
   * rachat total donne l'arrondi au dernier acheteur.
   */
  const valeurs = rachats.map((r, i) =>
    fractionClub === 0 && i === rachats.length - 1
      ? p.quotePart - rachats.slice(0, -1).reduce((t, x) => t + Math.round(x.fraction * p.quotePart), 0)
      : Math.round(r.fraction * p.quotePart),
  );
  const partClub =
    fractionClub === 0 ? 0 : Math.max(0, p.quotePart - valeurs.reduce((t, v) => t + v, 0));

  /*
   * QUI RACHETE PAIE LES PENALITES DE CE QU'IL RACHETE, a proportion. Le club
   * retient les siennes sur ce qu'il verse ; chaque acheteur verse les siennes
   * au club, en plus du prix convenu, qui va entier au sortant. Au franc pres :
   * le club prend le reste, ou le dernier acheteur si le club ne rachete rien.
   */
  const penalitesAcheteurs = rachats.map((r, i) =>
    fractionClub === 0 && i === rachats.length - 1
      ? p.penalites - rachats.slice(0, -1).reduce((t, x) => t + Math.round(x.fraction * p.penalites), 0)
      : Math.round(r.fraction * p.penalites),
  );
  const penalitesClub = Math.max(0, p.penalites - penalitesAcheteurs.reduce((t, x) => t + x, 0));

  const d = decompteSortie(
    { valeur: p.avance + partClub - penalitesClub, avance: p.avance, part: fractionClub * p.part },
    club,
    taux,
  );
  const frais = d.fraisVente + d.fraisGarde + d.fraisTransfert;
  const droitsClub = p.avance + partClub;
  const compensees = Math.max(0, Math.min(penalitesClub, droitsClub - frais));
  const netClub = Math.max(0, droitsClub - compensees - frais);

  let repartiPoids = 0;
  const acheteurs = rachats.map((r, i) => {
    /* Tout rachete : le dernier acheteur prend l'arrondi, pour qu'aucun poids ne se perde. */
    const poids =
      fractionClub === 0 && i === rachats.length - 1
        ? p.acquis - repartiPoids
        : Math.round(r.fraction * p.acquis);
    repartiPoids += poids;
    return {
      ...r,
      poids,
      valeur: valeurs[i],
      auClub: penalitesAcheteurs[i],
      auSortant: Math.max(0, r.prix),
    };
  });

  return {
    fractionClub,
    droitsClub,
    pocheActions: d.pocheActions,
    fraisVente: d.fraisVente,
    fraisGarde: d.fraisGarde,
    fraisTransfert: d.fraisTransfert,
    compensees,
    netClub,
    acheteurs,
    resteDu: penalitesClub - compensees,
  };
}

/**
 * Les frais de garde que la SGI facture pour l'annee et n'a pas encore preleves,
 * courus du 1er janvier au jour du releve : commission de conservation sur la
 * valeur des titres, forfait de tenue de compte, et la taxe sur ses commissions.
 */
export function fraisGardeCourus(
  actions: number,
  jour: string,
  bareme: { conservation: number; tenueCompte: number; taxe: number },
): number {
  const debut = Date.UTC(Number(jour.slice(0, 4)), 0, 1);
  const fin = Date.parse(`${jour.slice(0, 10)}T00:00:00Z`);
  const jours = Math.max(0, Math.round((fin - debut) / 86_400_000));
  const annuel = (Math.max(0, actions) * bareme.conservation + bareme.tenueCompte) * (1 + bareme.taxe);
  return Math.round((annuel * jours) / 365);
}

/**
 * La caisse, et ce qu'il en reste a partager.
 *
 * Un membre sorti a verse : cet argent est entre et reste en caisse jusqu'a son
 * paiement. Ce que le club lui doit n'est pourtant plus aux autres : il sort de
 * l'avoir a partager des l'enregistrement de la sortie, et sort de la caisse le
 * jour ou la depense « remboursement d'un membre sorti » est validee. Ni avant,
 * ni deux fois.
 */
export function etatCaisse(e: {
  versementsActifs: number;
  versementsSortis: number;
  penalitesEncaissees: number;
  recettes: number;
  /** Toutes les depenses validees, remboursements de sortants compris. */
  depenses: number;
  apportsNets: number;
  /** Ce que les sorties enregistrees ont fixe a verser. */
  netDuAuxSortis: number;
  /** Les depenses « remboursement d'un membre sorti » validees. */
  remboursementsSortants: number;
}): { totalEnCaisse: number; duAuxSortants: number; aPartager: number } {
  const totalEnCaisse =
    e.versementsActifs + e.versementsSortis + e.penalitesEncaissees + e.recettes -
    e.depenses - e.apportsNets;
  const duAuxSortants = Math.max(0, e.netDuAuxSortis - e.remboursementsSortants);
  return { totalEnCaisse, duAuxSortants, aPartager: totalEnCaisse - duAuxSortants };
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
  /*
   * Le signe moins typographique, non le trait d'union.
   *
   * Dans une colonne de chiffres tabulaires, le trait d'union est plus court
   * et plus haut que le plus : « +2,6 % » et « -5,1 % » ne s'alignaient pas.
   * U+2212 a la largeur et la hauteur du plus, par construction.
   */
  const brut = (Math.abs(x) * 100).toFixed(decimales).replace(".", ",");
  return `${x >= 0 ? "+" : "\u2212"}${brut} %`;
}

/**
 * La couleur d'un montant de performance : vert s'il monte, rouge s'il baisse,
 * encre discrete s'il ne bouge pas.
 *
 * RESERVEE A LA PERFORMANCE, et nulle part ailleurs. Un gain de gestion, une
 * plus-value, une variation de valeur, un rendement : ce sont les seuls
 * endroits ou la couleur ajoute quelque chose que le signe ne dit pas deja.
 *
 * Jamais sur un mouvement d'argent. Une depense prevue n'est pas une perte, une
 * cotisation encaissee n'est pas un gain, et un solde n'est ni l'un ni l'autre.
 * Le site en sortait justement : recettes en vert et depenses en rouge sur une
 * page qui n'est faite que de recettes et de depenses, la couleur n'y signalait
 * plus rien. Elle ne revient que la ou elle signale.
 *
 * Le zero reste a l'encre : « 0 % » n'est ni une bonne ni une mauvaise
 * nouvelle, et le peindre en vert en ferait une.
 */
export function couleurSigne(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "var(--ink-2)";
  return v > 0 ? "var(--gain)" : "var(--perte)";
}
