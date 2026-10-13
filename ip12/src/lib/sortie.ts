import { CLUB, REGLES, dateCourte, fcfa, moisLong, nombre } from "./settings";

/**
 * Le courrier qui explique sa sortie au membre qui s'en va.
 *
 * POURQUOI UN COURRIER, ET POURQUOI CELUI-LA. Le sortant recevait un chiffre :
 * « 324 520 FCFA a vous verser ». Il n'avait aucun moyen de savoir d'ou il
 * venait, et un chiffre qu'on ne peut pas refaire se conteste. Ce courrier
 * deroule le calcul dans l'ordre ou le site le fait, avec des mots plutot que
 * des formules : ce que le club possedait, la part qui lui en revient, ce qui en
 * est retire et pourquoi, ce qui reste. Chaque ligne se verifie a la
 * calculatrice, et les lignes tombent juste : ce sont les montants enregistres,
 * au franc pres.
 *
 * Fonction pure, sans base ni envoi : `verif.mjs` la rejoue sur des cas
 * construits.
 */

/** Ce que possedait le club au releve, et comment s'en tire le pot a partager. */
export type ContexteSortie = {
  /** Le compte-titres au releve, actions et liquidites. */
  compteTitres: number;
  /** Dont les actions : ce qui coute a vendre. */
  actions: number;
  /** Vire a la SGI apres le releve, compte au nominal. */
  enTransit: number;
  /** La caisse, hors ce qui est du a des membres deja sortis. */
  caisse: number;
  /** Les penalites que les membres doivent encore, celles du sortant comprises. */
  creances: number;
  /** Les avances des membres, rendues a part. */
  avances: number;
  aPartager: number;
  /** Les cotisations des mois echus de tous les membres : le denominateur des parts. */
  cotisations: number;
  /** Les frais de garde de l'annee, courus pour tout le club. */
  fraisGardeCourus: number;
};

export type DonneesCourrielSortie = {
  /** A qui le courrier s'adresse : le sortant, ou le detenteur de la part qui sort. */
  nom: string;
  /** Quand c'est une part rachetee qui sort : son nom. Le courrier va alors a son detenteur. */
  part?: string;
  dateSortie: string;
  motif: string;
  /** Le releve qui donne la valeur du portefeuille au jour de la sortie (AAAA-MM-JJ). */
  releve: string;
  club: ContexteSortie;
  /** Ses cotisations des mois echus : le numerateur de sa part. */
  cotisations: number;
  avance: number;
  /** Sa part du pot, avance a part : ce qui se rachete. */
  quotePart: number;
  /**
   * Ce que le club lui doit, avant penalites et frais : son avance, et la part
   * que le club rachete. Sans acheteur, son avance et toute sa part.
   */
  droits: number;
  /** Les membres qui rachetent ses parts ; vide si le club rachete tout. */
  rachats: RachatCourriel[];
  /** Ses penalites dues, inscrites ou qui courent. */
  penalites: number;
  /** Dont celles qui courent sans etre encore inscrites. */
  penalitesEnCours: number;
  /** Celles retirees de ses droits ; moins que `penalites` si elles les depassent. */
  compensees: number;
  pocheActions: number;
  fraisVente: number;
  fraisGarde: number;
  fraisTransfert: number;
  net: number;
};

export type RachatCourriel = {
  nom: string;
  /** La fraction de ses parts rachetee, entre 0 et 1. */
  fraction: number;
  /** Ce que vaut cette fraction au jour de la sortie. */
  valeur: number;
  /** Le prix convenu entre eux : ce que recoit le sortant. */
  prix: number;
  /** Ce que l'acheteur verse au club, en plus du prix, pour les penalites de ce qu'il rachete. */
  auClub: number;
  /** Ce que l'acheteur verse au sortant : le prix convenu. */
  auSortant: number;
  /** Les cotisations impayees de ce qu'il rachete, qu'il verse au club en plus du prix. */
  arrieres: number;
};

/**
 * Le droit de contester, dit dans chaque courrier de sortie.
 *
 * Tous les membres sont en copie : le decompte du sortant deplace aussi leurs
 * parts, et chacun peut le relire. Une contestation se tranche sur pieces ; et
 * celui a qui il manque une piece pour verifier doit pouvoir la demander.
 */
const CONTESTER = [
  "CONTESTER CE DÉCOMPTE : preuve à l'appui",
  "Un chiffre vous paraît faux ? Répondez à ce courriel, preuve à l'appui (reçu, relevé de " +
    "la SGI). Chaque membre en copie peut en faire autant.",
  "Il vous manque une information pour vérifier ? N'hésitez pas à la demander en répondant : " +
    "le bureau vous la communiquera.",
];

/** 0,014 -> « 1,4 % ». */
function taux(x: number, decimales = 2): string {
  return `${(x * 100).toLocaleString("fr-FR", { maximumFractionDigits: decimales })} %`;
}

/**
 * La date limite de paiement : `n` mois apres la sortie, le meme jour du mois,
 * ou le dernier si le mois d'arrivee est plus court (31 octobre + 4 mois = 28
 * fevrier).
 */
export function echeanceRemboursement(dateSortie: string, n: number): string {
  const [a, m, j] = dateSortie.slice(0, 10).split("-").map(Number);
  const dernierJour = new Date(Date.UTC(a, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(a, m - 1 + n, Math.min(j, dernierJour))).toISOString().slice(0, 10);
}

export function courrielSortie(d: DonneesCourrielSortie): { sujet: string; texte: string } {
  const c = d.club;
  const rachete = d.rachats.length > 0;
  const fractionClub = Math.max(0, 1 - d.rachats.reduce((t, r) => t + r.fraction, 0));
  const frais = d.fraisVente + d.fraisGarde + d.fraisTransfert;
  const retire = d.compensees + frais;
  const parAcheteurs = d.rachats.reduce((t, r) => t + r.auClub, 0);
  const reste = Math.max(0, d.penalites - d.compensees - parAcheteurs);
  const desAcheteurs = d.rachats.reduce((t, r) => t + r.auSortant, 0);
  const total = d.net + desAcheteurs;
  const limite = echeanceRemboursement(d.dateSortie, REGLES.delaiRemboursementMois);
  /*
   * L'assiette des 2 % : ce que le club lui verse hors avance, apres penalites,
   * cession et garde. C'est celle de `decompteSortie`, recomposee a partir des
   * montants enregistres.
   */
  const baseTransfert = Math.max(
    0,
    d.droits - d.avance - d.compensees - d.fraisVente - d.fraisGarde,
  );
  const enCours =
    d.penalitesEnCours > 0
      ? `, dont ${fcfa(d.penalitesEnCours)} qui courent sans être encore inscrites au registre`
      : "";
  let numero = 0;
  const section = (titre: string) => `${++numero}. ${titre}`;

  const enBref =
    total <= 0
      ? reste > 0
        ? `En bref : rien ne vous revient, et il reste ${fcfa(reste)} de pénalités que vous devez au club.`
        : "En bref : rien ne vous revient."
      : !rachete
        ? `En bref : ${fcfa(d.net)} vous reviennent, à vous verser au plus tard le ${dateCourte(limite)}.`
        : d.net > 0
          ? `En bref : ${fcfa(total)} vous reviennent au total : ${fcfa(d.net)} du club, au plus ` +
            `tard le ${dateCourte(limite)}, et ${fcfa(desAcheteurs)} des membres qui rachètent vos parts.`
          : `En bref : ${fcfa(total)} vous reviennent, versés par les membres qui rachètent vos parts.`;

  const lignes: string[] = [
    `Bonjour ${d.nom},`,
    "",
    (d.part
      ? `La sortie de la part rachetée que vous détenez (${d.part}) prend effet au ` +
        `${dateCourte(d.dateSortie)}, pour le motif suivant : `
      : `Votre sortie du club ${CLUB.nom} prend effet au ${dateCourte(d.dateSortie)}, ` +
        "pour le motif suivant : ") +
      `${d.motif.trim().replace(/[\s.…]+$/, "")}.`,
    ...(d.part
      ? [
          "Votre propre part n'est pas concernée. Dans ce décompte, « votre part » et « vos " +
            "cotisations » désignent celles de la part rachetée.",
        ]
      : []),
    "Ce courriel explique, étape par étape, comment le montant qui vous revient a été " +
      "calculé. Chaque chiffre se vérifie avec une simple calculatrice. Tous les membres du " +
      "club sont en copie.",
    "",
    enBref,
    "",
  ];
  lignes.push(...lignesValeurDeLaPart(d, section, true));

  if (rachete) {
    lignes.push("", section("QUI RACHÈTE VOS PARTS"));
    for (const r of d.rachats) {
      lignes.push(
        `  - ${r.nom} : ${taux(r.fraction)} de vos parts, d'une valeur de ${fcfa(r.valeur)} ` +
          `au jour de votre sortie, au prix convenu entre vous de ${fcfa(r.prix)}.`,
      );
    }
    if (fractionClub > 0) {
      lignes.push(
        `  - Le club : les ${taux(fractionClub)} restants, d'une valeur de ` +
          `${fcfa(d.droits - d.avance)}, au calcul du site, frais déduits (ci-dessous).`,
      );
    }
    const arrieres = d.rachats.reduce((t, r) => t + r.arrieres, 0);
    if (parAcheteurs > 0 || arrieres > 0) {
      lignes.push(
        "Le prix convenu vous revient en entier. Chaque acheteur paie en plus au club, pour ce " +
          "qu'il rachète, " +
          [
            parAcheteurs > 0 ? `vos pénalités (${fcfa(parAcheteurs)} en tout)` : "",
            arrieres > 0
              ? `vos cotisations impayées (${fcfa(arrieres)} en tout), qui comptent désormais dans la part qu'il rachète`
              : "",
          ]
            .filter(Boolean)
            .join(" et ") +
          ".",
      );
    }
    lignes.push(
      "Chaque acheteur détient désormais ce qu'il a racheté comme une part distincte de la " +
        "sienne, qui cotise chaque mois à proportion de sa taille. La caisse du club ne débourse " +
        "rien pour ces parts et aucune action n'est vendue, donc aucun frais n'y est retenu. Les " +
        "parts des autres membres ne changent pas.",
    );
  }

  lignes.push(
    "",
    section(rachete ? "CE QUE LE CLUB VOUS DOIT, ET CE QUI EN EST RETIRÉ" : "CE QUI EN EST RETIRÉ"),
  );
  if (rachete) {
    lignes.push(
      fractionClub > 0
        ? `Le club vous doit votre avance et la part qu'il rachète : ${fcfa(d.droits)}.`
        : `Le club vous doit votre avance : ${fcfa(d.droits)}.`,
    );
  }
  if (d.penalites <= 0) {
    lignes.push("  - Pénalités : aucune.");
  } else if (d.compensees < d.penalites) {
    lignes.push(
      `  - Vos pénalités : ${fcfa(d.penalites)}${enCours}.`,
      "   " +
        (d.compensees > 0 ? ` Le club en retient ${fcfa(d.compensees)} sur ce qu'il vous doit.` : "") +
        (parAcheteurs > 0
          ? d.compensees > 0
            ? ` Les acheteurs de vos parts lui paient les ${fcfa(parAcheteurs)} restants, en plus de leur prix.`
            : " Les acheteurs de vos parts les paient au club, en plus de leur prix."
          : "") +
        (reste > 0 ? ` Il reste ${fcfa(reste)} que vous devez au club.` : " Vous ne les devez plus."),
    );
  } else {
    lignes.push(
      `  - Vos pénalités : ${fcfa(d.compensees)}${enCours}.`,
      "    Elles sont retirées de ce que le club vous doit et comptent comme réglées : vous ne " +
        "les devez plus.",
    );
  }
  if (d.fraisVente > 0) {
    const poche = rachete ? "La part des actions que le club vous rachète" : "Votre part des actions du club";
    lignes.push(
      `  - Frais de vente de vos actions : ${taux(REGLES.fraisVenteActions)} de ` +
        `${fcfa(d.pocheActions)} = ${fcfa(d.fraisVente)}.`,
      `    ${poche} vaut ${fcfa(d.pocheActions)}. Les vendre coûte ` +
        `${taux(REGLES.fraisVenteActions)} chez ${CLUB.sgi} (commission, frais de bourse et ` +
        "taxe). Le club garde ces titres à votre place et paiera ces frais le jour où il les " +
        "vendra : ils sont donc à votre charge, et non à celle des membres qui restent.",
    );
  }
  if (d.fraisGarde > 0) {
    lignes.push(
      `  - Votre part des frais de garde de l'année : ${fcfa(d.fraisGarde)}.`,
      `    ${CLUB.sgi} facture chaque année la garde des titres : ` +
        `${taux(REGLES.conservationSGI)} de leur valeur, plus ${fcfa(REGLES.tenueCompteSGI)} de ` +
        `tenue de compte, plus ${taux(REGLES.taxeCommissionsSGI)} de taxe. Du 1er janvier au ` +
        `relevé, ces frais atteignent ${fcfa(c.fraisGardeCourus)} pour le club, qui ne les a pas ` +
        "encore payés. Votre part, dans la même proportion que ci-dessus" +
        (rachete ? ", pour ce que le club rachète" : "") +
        ` : ${fcfa(d.fraisGarde)}.`,
    );
  }
  if (d.fraisTransfert > 0) {
    lignes.push(
      `  - Frais de transfert vers votre compte : ${taux(REGLES.fraisTransfertSortie)} de ` +
        `${fcfa(baseTransfert)} = ${fcfa(d.fraisTransfert)}.`,
      "    C'est une estimation (art. 20) du coût du virement ou du retrait, calculée sur ce " +
        "qui vous revient hors avance, après les retenues ci-dessus. Dès que les frais réels " +
        "de la banque ou de la SGI seront connus, ils remplaceront cette estimation, et vous " +
        "en serez informé." +
        (d.avance > 0 ? " Votre avance n'en supporte aucun." : ""),
    );
  }
  lignes.push(`Total retiré : ${fcfa(retire)}`);

  lignes.push("", section("CE QUI VOUS REVIENT"));
  if (!rachete) {
    lignes.push(
      `  - Vos droits : ${fcfa(d.droits)}`,
      `  - Moins le total retiré : ${fcfa(retire)}`,
      `Montant à vous verser : ${fcfa(d.net)}`,
    );
  } else {
    lignes.push(
      `  - Du club : ${nombre(d.droits)} − ${nombre(retire)} = ${fcfa(d.net)}`,
      ...d.rachats.map(
        (r) => `  - De ${r.nom} : ${fcfa(r.auSortant)}, le prix convenu, à régler directement entre vous`,
      ),
      `Montant total qui vous revient : ${fcfa(total)}`,
    );
  }
  if (d.net > 0) {
    lignes.push(
      `Le club dispose de ${REGLES.delaiRemboursementMois} mois pour ` +
        (rachete ? "vous verser ce qu'il vous doit (R5), " : "vous le verser (R5), ") +
        `soit au plus tard le ${dateCourte(limite)}.`,
    );
  }

  lignes.push("", ...CONTESTER, "", `Le bureau d'${CLUB.nom}`);

  return {
    sujet: `${CLUB.sigle} : décompte de votre sortie du club`,
    texte: lignes.join("\n"),
  };
}

/**
 * Les frais reels remplacent les frais estimes : le sortant recoit le nouveau
 * montant, et ce qui l'a change. Le reste du decompte ne bouge pas.
 */
export function courrielCorrectionSortie(d: {
  nom: string;
  /** Quand c'est une part rachetee qui est sortie : son nom. */
  part?: string;
  dateSortie: string;
  fraisAvant: number;
  fraisApres: number;
  netAvant: number;
  netApres: number;
  raison: string;
}): { sujet: string; texte: string } {
  const limite = echeanceRemboursement(d.dateSortie, REGLES.delaiRemboursementMois);
  const lignes = [
    `Bonjour ${d.nom},`,
    "",
    (d.part
      ? `Les frais réels de la sortie de la part rachetée que vous détenez (${d.part}) sont connus : `
      : "Les frais réels de votre sortie du club sont connus : ") +
      "ils remplacent les frais estimés du premier décompte.",
    `  - Frais retenus dans le premier décompte : ${fcfa(d.fraisAvant)}`,
    `  - Frais réels : ${fcfa(d.fraisApres)} (${d.raison})`,
    "",
    `Montant à vous verser : ${fcfa(d.netApres)}, au lieu de ${fcfa(d.netAvant)}.`,
    "Le reste du décompte est inchangé" +
      (d.netApres > 0 ? `, et le paiement reste dû au plus tard le ${dateCourte(limite)}.` : "."),
    "Tous les membres du club sont en copie.",
    "",
    ...CONTESTER,
    "",
    `Le bureau d'${CLUB.nom}`,
  ];
  return {
    sujet: `${CLUB.sigle} : frais réels de votre sortie du club`,
    texte: lignes.join("\n"),
  };
}

/** Ce que le bureau doit savoir a jour avant d'enregistrer une sortie. */
export type FaitsSortie = {
  /** La date de sortie, a laquelle le calcul est arrete. */
  jour: string;
  /** Le releve qui donnera la valeur du portefeuille, ou null s'il n'y en a pas. */
  releve: { date: string; total: number } | null;
  enTransit: number;
  versementsEnAttente: { nb: number; total: number; siens: number };
  caisseEnAttente: number;
  /** Reglements de penalite declares par le sortant, que le tresorier n'a pas verifies. */
  reglementsEnAttente: number;
  penalites: number;
  penalitesEnCours: number;
};

/**
 * Ce que le calcul va utiliser, dit au bureau avant qu'il n'enregistre.
 *
 * Le site ne sait pas ce qui manque : un versement recu mais pas declare, des
 * cours qui ont bouge depuis le releve. Il montre ce qu'il a, en disant pour
 * chaque point ce qu'il faut faire s'il n'est pas a jour. Le bureau confirme,
 * ou saisit ce qui manque et revient.
 */
export function pointsAVerifier(f: FaitsSortie): string[] {
  const points: string[] = [];
  if (f.releve) {
    const ecart = Math.round(
      (Date.parse(`${f.jour}T00:00:00Z`) - Date.parse(`${f.releve.date}T00:00:00Z`)) / 86_400_000,
    );
    points.push(
      ecart === 0
        ? `Portefeuille : relevé du ${dateCourte(f.releve.date)} (${fcfa(f.releve.total)}), le jour même de la sortie.`
        : `Portefeuille : relevé du ${dateCourte(f.releve.date)} (${fcfa(f.releve.total)}), ` +
            `${ecart} ${ecart > 1 ? "jours" : "jour"} avant la sortie. Si les cours ont bougé depuis, ` +
            `saisissez d'abord un relevé daté du ${dateCourte(f.jour)}.`,
    );
  }
  if (f.enTransit > 0) {
    points.push(`Virements vers la SGI après ce relevé : ${fcfa(f.enTransit)}, comptés à leur montant.`);
  }
  const v = f.versementsEnAttente;
  points.push(
    v.nb === 0
      ? "Versements : aucun en attente de validation. Un versement reçu mais pas encore déclaré ne compte pas : faites-le saisir d'abord."
      : `Versements : ${v.nb} ${v.nb > 1 ? "déclarés attendent" : "déclaré attend"} validation ` +
          `(${fcfa(v.total)})` +
          (v.siens > 0
            ? `, dont ${v.siens} du sortant`
            : v.nb > 1
              ? ", tous d'autres membres"
              : ", d'un autre membre") +
          (v.nb > 1
            ? " : validez-les ou refusez-les d'abord, sinon ils ne comptent pas."
            : " : validez-le ou refusez-le d'abord, sinon il ne compte pas."),
  );
  points.push(
    f.caisseEnAttente === 0
      ? "Caisse : aucun mouvement en attente de validation."
      : `Caisse : ${f.caisseEnAttente} ${f.caisseEnAttente > 1 ? "mouvements attendent" : "mouvement attend"} ` +
          (f.caisseEnAttente > 1
            ? "validation : validez-les d'abord, sinon ils ne comptent pas."
            : "validation : validez-le d'abord, sinon il ne compte pas."),
  );
  if (f.reglementsEnAttente > 0) {
    points.push(
      `Pénalités : le sortant a déclaré ${f.reglementsEnAttente} ` +
        `${f.reglementsEnAttente > 1 ? "règlements" : "règlement"} que le trésorier n'a pas ` +
        `${f.reglementsEnAttente > 1 ? "vérifiés" : "vérifié"}. Sans validation, ces pénalités ` +
        "seront retenues sur sa part.",
    );
  }
  points.push(
    f.penalites === 0
      ? "Pénalités du sortant : aucune."
      : `Pénalités du sortant retenues : ${fcfa(f.penalites)}` +
          (f.penalitesEnCours > 0
            ? `, dont ${fcfa(f.penalitesEnCours)} qui courent sans être inscrites au registre. ` +
              "Si vous les avez déjà saisies à la main, elles compteraient deux fois : dites-le avant de confirmer."
            : "."),
  );
  return points;
}

/**
 * L'empreinte de ce que le bureau a verifie. Si quoi que ce soit change entre la
 * verification et la confirmation, l'empreinte change aussi, et le site redemande.
 */
export function empreinteSortie(
  membreId: string,
  f: FaitsSortie,
  rachats: { membreId: string; fraction: number; prix: number }[] = [],
): string {
  return [
    membreId,
    ...rachats.map((r) => `${r.membreId}:${r.fraction}:${r.prix}`),
    f.jour,
    f.releve?.date ?? "",
    f.releve?.total ?? "",
    f.enTransit,
    f.versementsEnAttente.nb,
    f.versementsEnAttente.total,
    f.caisseEnAttente,
    f.reglementsEnAttente,
    f.penalites,
  ].join("|");
}

/**
 * La valeur de la part d'un membre, avant toute decision : de quoi fixer un prix.
 *
 * Le bureau valorise d'abord, en parle aux membres, puis enregistre. Deux
 * reperes encadrent un rachat par un membre : ce que le club paierait pour la
 * part, frais deduits, et ce qu'elle vaut. Un prix entre les deux avantage le
 * sortant comme l'acheteur.
 */
export function lignesValorisation(v: {
  quotePart: number;
  /** Sa proportion du total a partager, entre 0 et 1. */
  part: number;
  avance: number;
  penalites: number;
  /** Si le club rachete tout : ce qu'il verse, et les frais retenus. */
  netClub: number;
  fraisClub: number;
  /** Ses cotisations impayees, qu'un acheteur verserait au club. */
  arrieres: number;
  /** Les mois qu'elles couvrent, nommes pour que le bureau les verifie. */
  moisArrieres?: string[];
}): string[] {
  /*
   * LE PRIX CONVENU EST CE QUE RECOIT LE SORTANT ; l'acheteur paie en plus ses
   * penalites et ses cotisations impayees, et le club lui rend son avance.
   *
   * En bas, le prix ou le sortant recoit autant que du club : l'offre du club,
   * avance mise a part. En haut, le prix ou l'acheteur paie autant que ce qu'il
   * recoit : la valeur de la part, moins les penalites qu'il paie en plus. Les
   * cotisations impayees ne comptent pas : elles entrent dans sa part.
   */
  const plancher = Math.max(0, v.netClub - v.avance);
  const plafond = Math.max(plancher, v.quotePart - v.penalites);
  const lignes = [
    `Valeur de sa part : ${fcfa(v.quotePart)} (${taux(v.part)} du total à partager).`,
  ];
  if (v.avance > 0) lignes.push(`Son avance, rendue par le club sans frais : ${fcfa(v.avance)}.`);
  if (v.penalites > 0) lignes.push(`Ses pénalités, payées au club dans tous les cas : ${fcfa(v.penalites)}.`);
  lignes.push(
    `Si le club rachète tout : il lui verse ${fcfa(v.netClub)}, après ${fcfa(v.fraisClub)} de ` +
      "frais (cession, garde, transfert)" +
      (v.penalites > 0 || v.avance > 0 ? ", avance et pénalités comprises." : "."),
    "Si des membres rachètent : le prix convenu va entier au sortant, sans frais pour personne" +
      (v.avance > 0 ? ", et le club lui rend son avance" : "") +
      "." +
      (v.penalites > 0 || v.arrieres > 0
        ? " L'acheteur verse en plus au club " +
          [
            v.penalites > 0 ? `ses pénalités (${fcfa(v.penalites)})` : "",
            v.arrieres > 0
              ? `ses cotisations impayées (${fcfa(v.arrieres)}` +
                (v.moisArrieres?.length ? ` : ${listeDesMois(v.moisArrieres)}` : "") +
                "), qui comptent dans la part rachetée"
              : "",
          ]
            .filter(Boolean)
            .join(" et ") +
          "."
        : "") +
      ` Repère : un prix entre ${fcfa(plancher)} (ce que le club lui verserait` +
      (v.avance > 0 ? ", avance mise à part" : "") +
      `) et ` +
      `${fcfa(plafond)} (la valeur de sa part` +
      (v.penalites > 0 ? ", moins ses pénalités payées par l'acheteur" : "") +
      ") avantage le sortant comme l'acheteur.",
  );
  return lignes;
}

/** Qui paie quoi, quand des membres rachetent : dit au bureau avant qu'il confirme. */
export function lignesPartage(p: {
  avance: number;
  acheteurs: RachatCourriel[];
  fractionClub: number;
  droitsClub: number;
  frais: number;
  compensees: number;
  netClub: number;
  resteDu: number;
}): string[] {
  const lignes = p.acheteurs.map(
    (r) =>
      `${r.nom} rachète ${taux(r.fraction)} de ses parts (valeur ${fcfa(r.valeur)}) : il verse ` +
      `${fcfa(r.prix)} au sortant` +
      (r.auClub > 0 || r.arrieres > 0
        ? ", et en plus au club " +
          [
            r.auClub > 0 ? `${fcfa(r.auClub)} de pénalités` : "",
            r.arrieres > 0 ? `${fcfa(r.arrieres)} de cotisations impayées` : "",
          ]
            .filter(Boolean)
            .join(" et ") +
          `, soit ${fcfa(r.prix + r.auClub + r.arrieres)} en tout.`
        : "."),
  );
  lignes.push(
    p.fractionClub > 0
      ? `Le club rachète les ${taux(p.fractionClub)} restants : il verse ${fcfa(p.netClub)} au ` +
          `sortant, avance comprise, après ${fcfa(p.frais)} de frais` +
          (p.compensees > 0 ? ` et ${fcfa(p.compensees)} de pénalités retenues.` : ".")
      : `Le club lui rend son avance : ${fcfa(p.netClub)}` +
          (p.compensees > 0 ? `, après ${fcfa(p.compensees)} de pénalités retenues.` : "."),
  );
  if (p.acheteurs.some((r) => r.auClub > 0 || r.arrieres > 0)) {
    lignes.push(
      "Ce que les acheteurs versent au club est inscrit en attente : les pénalités dans Caisse, " +
        "les cotisations impayées dans Versements, au nom de leur part rachetée. Validez-les à " +
        "réception de l'argent.",
    );
  }
  if (p.resteDu > 0) {
    lignes.push(`Il resterait ${fcfa(p.resteDu)} de pénalités que le sortant devrait encore au club.`);
  }
  return lignes;
}

/**
 * Le premier mois que doit une part rachetee : celui de la premiere echeance qui
 * suit le rachat. Rachetee le 5, elle doit le mois en cours, dont l'echeance
 * tombe le 10 ; rachetee le 10 ou apres, elle commence le mois suivant.
 */
export function premierMoisDeLaPart(dateRachat: string, jourEcheance: number): string {
  const [a, m, j] = dateRachat.slice(0, 10).split("-").map(Number);
  const debut = new Date(Date.UTC(a, m - 1 + (j < jourEcheance ? 0 : 1), 1));
  return debut.toISOString().slice(0, 10);
}

/**
 * Le nom d'une part rachetee dans les listes : son detenteur d'abord, pour
 * qu'elle se lise a cote de lui, puis ce qu'elle est.
 */
export function nomDeLaPart(titulaire: string, sortant: string, fraction: number): string {
  const ce = fraction >= 1 ? "part" : `${taux(fraction)} de la part`;
  return `${titulaire} · ${ce} de ${sortant}`;
}

/**
 * Ce que deviendra chaque part rachetee : une part distincte chez son acheteur,
 * qui cotise a proportion de sa taille des la premiere echeance qui suit.
 */
export function lignesNouvellesParts(
  parts: { nom: string; taille: number }[],
  cotisationCommune: number,
  premierMois: string,
): string[] {
  return parts.map(
    (x) =>
      `${x.nom} détiendra une part distincte de la sienne (${taux(x.taille)} d'une part) : ` +
      `${fcfa(Math.round(x.taille * cotisationCommune))} par mois à partir de ` +
      `${moisLong(premierMois)}, avec ses propres retards et pénalités.`,
  );
}

/** Ce qu'il faut pour dire ce que vaut une part, et comment. */
export type DonneesValeur = {
  dateSortie: string;
  releve: string;
  club: ContexteSortie;
  cotisations: number;
  avance: number;
  quotePart: number;
};

/**
 * Ce que possedait le club, et la part qui en revient au sortant : le coeur du
 * calcul, ecrit une seule fois. Le courrier de sortie, le courrier de
 * valorisation et l'ecran du bureau en lisent le meme texte, si bien qu'aucun ne
 * peut dire autre chose que les autres.
 */
export function lignesValeurDeLaPart(
  d: DonneesValeur,
  section: (titre: string) => string,
  releveConfirme: boolean,
): string[] {
  const c = d.club;
  const part = c.cotisations > 0 ? d.cotisations / c.cotisations : 0;
  const lignes: string[] = [
    section(`CE QUE LE CLUB POSSÉDAIT : au ${dateCourte(d.dateSortie)}, jour de votre sortie`),
    "Calcul arrêté au jour de votre sortie : ce qui suit ne change plus rien. Le portefeuille " +
      `est compté au relevé de ${CLUB.sgi} du ${dateCourte(d.releve)}, sa dernière valeur vérifiable.` +
      (d.releve < d.dateSortie.slice(0, 10)
        ? releveConfirme
          ? " Le bureau a confirmé qu'elle était toujours valable à la date de votre sortie."
          : " Si les cours ont bougé depuis, le bureau saisira un relevé plus récent avant " +
            "d'enregistrer la sortie."
        : ""),
    `  - Compte chez ${CLUB.sgi} (les actions, et l'argent pas encore investi) : ` +
      fcfa(c.compteTitres),
  ];
  if (c.enTransit > 0) {
    lignes.push(
      `  - Virements partis vers ${CLUB.sgi} entre ce relevé et votre sortie : ${fcfa(c.enTransit)}`,
    );
  }
  lignes.push(`  - Argent en caisse : ${fcfa(c.caisse)}`);
  if (c.creances > 0) {
    lignes.push(
      `  - Pénalités que les membres doivent encore au club, les vôtres comprises : ${fcfa(c.creances)}`,
    );
  }
  if (c.avances > 0) lignes.push(`  - Moins les avances des membres : ${fcfa(c.avances)}`);
  lignes.push(`Total à partager entre les membres : ${fcfa(c.aPartager)}`);
  if (c.creances > 0) {
    lignes.push("Les pénalités dues comptent : c'est de l'argent qu'on doit au club.");
  }
  if (c.avances > 0) {
    lignes.push("Les avances (mois payés d'avance) sont rendues à part, sans gain ni perte.");
  }

  lignes.push(
    "",
    section("VOTRE PART : dans la proportion de vos cotisations"),
    "Chacun a droit à une part du total, à proportion de ce qu'il a cotisé.",
    `  - Vos cotisations : ${fcfa(d.cotisations)}`,
    `  - Cotisations de l'ensemble des membres, vous compris : ${fcfa(c.cotisations)}`,
  );
  if (c.cotisations > 0) {
    lignes.push(
      `  - Votre proportion : ${nombre(d.cotisations)} ÷ ${nombre(c.cotisations)}, soit ${taux(part)}`,
      `  - Votre part du total : ${nombre(c.aPartager)} × ${nombre(d.cotisations)} ÷ ` +
        `${nombre(c.cotisations)} = ${fcfa(d.quotePart)}`,
    );
  }
  if (d.avance > 0) {
    lignes.push(
      `  - Votre avance, rendue en entier et sans frais : ${fcfa(d.avance)}`,
      `Vos droits, part et avance réunies : ${fcfa(d.quotePart + d.avance)}`,
    );
  } else {
    lignes.push(`Vos droits : ${fcfa(d.quotePart)}`);
  }
  return lignes;
}

/**
 * La valeur de sa part, envoyee au sortant AVANT que sa sortie soit enregistree.
 *
 * Il a le droit de la contester : il doit donc pouvoir la verifier tant qu'elle
 * peut encore changer, et non apprendre le calcul avec le decompte definitif.
 * Tous les membres sont en copie : ses parts peuvent etre rachetees par l'un
 * d'eux, qui doit connaitre la meme valeur et la meme logique.
 */
export function courrielValorisation(
  v: DonneesValeur & {
    nom: string;
    /** Quand c'est une part rachetee qui va sortir : son nom. */
    part?: string;
    penalites: number;
    penalitesEnCours: number;
    arrieres: number;
    moisArrieres?: string[];
    /** Si le club rachete tout. */
    netClub: number;
    compensees: number;
    fraisVente: number;
    fraisGarde: number;
    fraisTransfert: number;
  },
): { sujet: string; texte: string } {
  let numero = 0;
  const section = (titre: string) => `${++numero}. ${titre}`;
  const plancher = Math.max(0, v.netClub - v.avance);
  const plafond = Math.max(plancher, v.quotePart - v.penalites);
  const reste = Math.max(0, v.penalites - v.compensees);

  const lignes: string[] = [
    `Bonjour ${v.nom},`,
    "",
    (v.part ? `Voici la valeur de la part rachetée que vous détenez (${v.part})` : "Voici la valeur de votre part") +
      ` au ${dateCourte(v.dateSortie)}, et son calcul. Rien n'est encore enregistré : vous pouvez ` +
      "la contester. Tous les membres sont en copie, car ils peuvent racheter vos parts.",
    "",
    `En bref : votre part vaut ${fcfa(v.quotePart)}.`,
    "",
    ...lignesValeurDeLaPart(v, section, false),
    "",
    section("CE QUI VOUS REVIENDRAIT"),
    "Si le club rachète tout :",
    `  - Votre part${v.avance > 0 ? " et votre avance" : ""} : ${fcfa(v.quotePart + v.avance)}`,
  ];
  if (v.compensees > 0) {
    lignes.push(
      `  - Moins vos pénalités : ${fcfa(v.compensees)}` +
        (v.penalitesEnCours > 0 ? `, dont ${fcfa(v.penalitesEnCours)} pas encore inscrites` : ""),
    );
  }
  if (v.fraisVente > 0) {
    lignes.push(`  - Moins la vente de vos actions (${taux(REGLES.fraisVenteActions)}) : ${fcfa(v.fraisVente)}`);
  }
  if (v.fraisGarde > 0) lignes.push(`  - Moins vos frais de garde de l'année : ${fcfa(v.fraisGarde)}`);
  if (v.fraisTransfert > 0) {
    lignes.push(
      `  - Moins le transfert, estimé à ${taux(REGLES.fraisTransfertSortie)} : ${fcfa(v.fraisTransfert)}`,
    );
  }
  lignes.push(
    `Soit ${fcfa(v.netClub)}, versés sous ${REGLES.delaiRemboursementMois} mois (R5).` +
      (reste > 0 ? ` Il resterait ${fcfa(reste)} de pénalités dues au club.` : ""),
    "Si des membres rachètent : le prix convenu vous revient en entier, sans frais" +
      (v.avance > 0 ? ", avance rendue par le club" : "") +
      `. Repère : entre ${fcfa(plancher)} et ${fcfa(plafond)} pour la totalité.` +
      (v.penalites > 0 || v.arrieres > 0
        ? " Ils paient en plus au club " +
          [
            v.penalites > 0 ? `vos pénalités (${fcfa(v.penalites)})` : "",
            v.arrieres > 0
              ? `vos cotisations impayées (${fcfa(v.arrieres)}` +
                (v.moisArrieres?.length ? ` : ${listeDesMois(v.moisArrieres)}` : "") +
                ")"
              : "",
          ]
            .filter(Boolean)
            .join(" et ") +
          "."
        : ""),
    "",
    ...CONTESTER,
    "",
    `Le bureau d'${CLUB.nom}`,
  );
  return {
    sujet: `${CLUB.sigle} : valeur de ${v.part ? "la part rachetée que vous détenez" : "votre part"}, avant la sortie`,
    texte: lignes.join("\n"),
  };
}

/**
 * Les cotisations que le sortant doit encore : tous les mois echus jusqu'a sa
 * sortie, celui dont l'echeance tombe le jour meme compris.
 *
 * Le 10, jour de l'echeance, le mois n'est pas encore « en retard » : il ne le
 * devient que le lendemain. Le compter comme en retard laissait donc de cote le
 * mois de la sortie, que la part rachetee ne doit pas non plus, puisqu'elle
 * commence a l'echeance suivante. Ce mois-la, personne ne le payait. La borne
 * est donc exactement le premier mois de la part rachetee : rien avant elle
 * n'echappe, rien n'est compte deux fois.
 */
export function arrieresAvant(
  cellules: { mois: string; manque: number }[],
  premierMoisDeLaPart: string,
): { mois: string; manque: number }[] {
  return cellules
    .filter((c) => c.mois < premierMoisDeLaPart && c.manque > 0)
    .map((c) => ({ mois: c.mois, manque: c.manque }));
}

/** « août, septembre et octobre 2026 » : les mois nommes, l'annee une fois par annee. */
export function listeDesMois(mois: string[]): string {
  const parAnnee = new Map<string, string[]>();
  for (const m of [...mois].sort()) {
    const annee = m.slice(0, 4);
    const nom = new Date(`${m.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("fr-FR", {
      month: "long",
      timeZone: "UTC",
    });
    parAnnee.set(annee, [...(parAnnee.get(annee) ?? []), nom]);
  }
  const morceaux = [...parAnnee].map(([annee, noms]) =>
    noms.length === 1
      ? `${noms[0]} ${annee}`
      : `${noms.slice(0, -1).join(", ")} et ${noms.at(-1)} ${annee}`,
  );
  return morceaux.length <= 1 ? (morceaux[0] ?? "") : `${morceaux.slice(0, -1).join(", ")} et ${morceaux.at(-1)}`;
}
