import { CLUB, REGLES, dateCourte, fcfa, nombre } from "./settings";

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
  nom: string;
  dateSortie: string;
  motif: string;
  /** Le releve auquel la sortie est arretee (AAAA-MM-JJ). */
  arrete: string;
  club: ContexteSortie;
  /** Ses cotisations des mois echus : le numerateur de sa part. */
  cotisations: number;
  avance: number;
  /** Sa part du pot plus son avance, avant penalites et frais : ce qu'enregistre la sortie. */
  droits: number;
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
  const part = c.cotisations > 0 ? d.cotisations / c.cotisations : 0;
  const quotePart = d.droits - d.avance;
  const frais = d.fraisVente + d.fraisGarde + d.fraisTransfert;
  const retire = d.compensees + frais;
  const reste = Math.max(0, d.penalites - d.compensees);
  const limite = echeanceRemboursement(d.dateSortie, REGLES.delaiRemboursementMois);
  /*
   * L'assiette des 2 % : ce qui lui revient hors avance, apres penalites, cession
   * et garde. C'est celle de `decompteSortie`, recomposee a partir des montants
   * enregistres.
   */
  const baseTransfert = Math.max(0, quotePart - d.compensees - d.fraisVente - d.fraisGarde);
  const enCours =
    d.penalitesEnCours > 0
      ? `, dont ${fcfa(d.penalitesEnCours)} qui courent sans être encore inscrites au registre`
      : "";

  const lignes: string[] = [
    `Bonjour ${d.nom},`,
    "",
    `Votre sortie du club ${CLUB.nom} prend effet au ${dateCourte(d.dateSortie)}, ` +
      `pour le motif suivant : ${d.motif.trim().replace(/[\s.…]+$/, "")}.`,
    "Ce courriel explique, étape par étape, comment le montant qui vous revient a été " +
      "calculé. Chaque chiffre se vérifie avec une simple calculatrice.",
    "",
    d.net > 0
      ? `En bref : ${fcfa(d.net)} vous reviennent, à vous verser au plus tard le ${dateCourte(limite)}.`
      : reste > 0
        ? `En bref : rien ne vous revient, et il reste ${fcfa(reste)} de pénalités que vous devez au club.`
        : "En bref : rien ne vous revient.",
    "",
    `1. CE QUE LE CLUB POSSÉDAIT : au relevé du ${dateCourte(d.arrete)}`,
    `Le calcul part du dernier relevé de ${CLUB.sgi}, la société de bourse qui garde les ` +
      "titres du club. C'est la dernière valeur connue et vérifiable du portefeuille : ce qui " +
      "se passe après cette date ne change plus votre montant, ni en plus ni en moins.",
    `  - Compte chez ${CLUB.sgi} (les actions, et l'argent pas encore investi) : ` +
      fcfa(c.compteTitres),
  ];
  if (c.enTransit > 0) {
    lignes.push(`  - Virements partis vers ${CLUB.sgi} après le relevé : ${fcfa(c.enTransit)}`);
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
    lignes.push(
      "Les pénalités dues comptent dans ce que possède le club : c'est de l'argent qu'on lui doit.",
    );
  }
  if (c.avances > 0) {
    lignes.push(
      "Les avances sont des cotisations payées pour des mois qui ne sont pas encore arrivés : " +
        "elles appartiennent à chacun, ne rapportent rien, ne perdent rien, et sont rendues à part.",
    );
  }

  lignes.push(
    "",
    "2. VOTRE PART : dans la proportion de vos cotisations",
    "Chaque membre a droit à une part du total, dans la proportion de ce qu'il a cotisé.",
    `  - Vos cotisations : ${fcfa(d.cotisations)}`,
    `  - Cotisations de l'ensemble des membres, vous compris : ${fcfa(c.cotisations)}`,
  );
  if (c.cotisations > 0) {
    lignes.push(
      `  - Votre proportion : ${nombre(d.cotisations)} ÷ ${nombre(c.cotisations)}, soit ${taux(part)}`,
      `  - Votre part du total : ${nombre(c.aPartager)} × ${nombre(d.cotisations)} ÷ ` +
        `${nombre(c.cotisations)} = ${fcfa(quotePart)}`,
    );
  }
  if (d.avance > 0) {
    lignes.push(
      `  - Votre avance, rendue en entier et sans frais : ${fcfa(d.avance)}`,
      `Vos droits, part et avance réunies : ${fcfa(d.droits)}`,
    );
  } else {
    lignes.push(`Vos droits : ${fcfa(d.droits)}`);
  }

  lignes.push("", "3. CE QUI EN EST RETIRÉ");
  if (d.penalites <= 0) {
    lignes.push("  - Pénalités : aucune.");
  } else if (reste > 0) {
    lignes.push(
      `  - Vos pénalités : ${fcfa(d.penalites)}${enCours}.`,
      `    Elles dépassent vos droits : ${fcfa(d.compensees)} en sont retirés, et il reste ` +
        `${fcfa(reste)} que vous devez au club.`,
    );
  } else {
    lignes.push(
      `  - Vos pénalités : ${fcfa(d.compensees)}${enCours}.`,
      "    Elles sont retirées de vos droits et comptent comme réglées : vous ne les devez plus.",
    );
  }
  if (d.fraisVente > 0) {
    lignes.push(
      `  - Frais de vente de vos actions : ${taux(REGLES.fraisVenteActions)} de ` +
        `${fcfa(d.pocheActions)} = ${fcfa(d.fraisVente)}.`,
      `    Votre part des actions du club vaut ${fcfa(d.pocheActions)}. Les vendre coûte ` +
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
        "encore payés. Votre part, dans la même proportion que ci-dessus : " +
        `${fcfa(d.fraisGarde)}.`,
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

  lignes.push(
    "",
    "4. CE QUI VOUS REVIENT",
    `  - Vos droits : ${fcfa(d.droits)}`,
    `  - Moins le total retiré : ${fcfa(retire)}`,
    `Montant à vous verser : ${fcfa(d.net)}`,
  );
  if (d.net > 0) {
    lignes.push(
      `Le club dispose de ${REGLES.delaiRemboursementMois} mois pour vous le verser (R5), ` +
        `soit au plus tard le ${dateCourte(limite)}.`,
    );
  }

  lignes.push(
    "",
    "Pour toute question sur ce décompte, répondez à ce courriel : le bureau est en copie.",
    "",
    `Le bureau d'${CLUB.nom}`,
  );

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
    "Les frais réels de votre sortie du club sont connus : ils remplacent les frais " +
      "estimés de votre premier décompte.",
    `  - Frais retenus dans le premier décompte : ${fcfa(d.fraisAvant)}`,
    `  - Frais réels : ${fcfa(d.fraisApres)} (${d.raison})`,
    "",
    `Montant à vous verser : ${fcfa(d.netApres)}, au lieu de ${fcfa(d.netAvant)}.`,
    "Le reste du décompte est inchangé" +
      (d.netApres > 0 ? `, et le paiement reste dû au plus tard le ${dateCourte(limite)}.` : "."),
    "",
    "Pour toute question, répondez à ce courriel : le bureau est en copie.",
    "",
    `Le bureau d'${CLUB.nom}`,
  ];
  return {
    sujet: `${CLUB.sigle} : frais réels de votre sortie du club`,
    texte: lignes.join("\n"),
  };
}
