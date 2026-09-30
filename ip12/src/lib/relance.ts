import "server-only";
import { db } from "@/lib/db";
import {
  avancesExigees, penalitesDuesDetaillees, situationsClub,
  type AvanceExigee, type DetteMembre, type SituationClub,
} from "@/lib/queries";
import { envoyerCourriel, transportConfigure } from "@/lib/courriel";
import {
  CLUB, EFFET, REGLES, dateCourte, deMois, debutMois, etatEcheance, fcfa,
  joursAvantEcheance, lienDuSite, moisLong,
} from "@/lib/settings";

/**
 * Fabrique et envoi des relances.
 *
 * Extraite de la route cron parce qu'elle sert desormais deux appelants : le
 * courrier du 10, et la relance que le bureau declenche a la main. Les deux
 * doivent dire exactement la meme chose -- deux redactions divergentes feraient
 * douter de celle qu'on a recue.
 */
export type Destinataire = {
  situation: SituationClub;
  /** Mois echus et impayes : penalisables (art. 9). */
  arrieres: string[];
  /** Mois courant non encore couvert : echeance du jour, pas encore penalisable. */
  echeanceDuJour: string | null;
  /**
   * La dette inscrite au registre, toutes natures. Le courrier l'annonce telle
   * quelle : le compte ET le montant sortent de la meme table, au lieu de coller
   * un decompte du registre a un total theorique qui ne voyait pas les absences.
   */
  dette: DetteMembre;
  /**
   * Avance minimale imposee au membre et non tenue.
   *
   * Une mesure disciplinaire assortie d'une date ne vaut que si l'interesse en est
   * averti. La seule relance automatique du club tombe le 10 : y taire l'obligation
   * reviendrait a laisser courir un delai dont il ne sait rien.
   */
  avanceManquante: AvanceExigee | null;
};



export type Releve = {
  mois: string;
  destinataires: Destinataire[];
  envoyes: string[];
  echecs: string[];
};

/** Qui doit etre relance aujourd'hui, et pourquoi. */
export async function destinatairesDuJour(maintenant = new Date()): Promise<Destinataire[]> {
  const moisCourant = debutMois(maintenant);
  const [situations, avances] = await Promise.all([
    situationsClub(maintenant),
    avancesExigees(maintenant).catch(() => [] as AvanceExigee[]),
  ]);
  const dettes = await penalitesDuesDetaillees().catch(() => new Map<string, DetteMembre>());

  return situations
    .map((situation) => {
      const cellule = situation.cellules.find((c) => c.mois === moisCourant);
      /*
       * « partiel » compte au meme titre que « retard » : un acompte ne solde
       * pas le mois, et l'oublier ici priverait de relance precisement celui qui
       * a commence a payer et croit en avoir fini.
       */
      const echeanceDuJour =
        cellule &&
        (cellule.statut === "a_venir" || cellule.statut === "retard" || cellule.statut === "partiel")
          ? moisCourant
          : null;
      const avance = avances.find((a) => a.membreId === situation.membreId);
      return {
        situation,
        arrieres: situation.moisEnRetard.filter((m) => m !== moisCourant),
        echeanceDuJour,
        dette: dettes.get(situation.membreId) ?? {
          nb: 0, montant: 0, nbRetard: 0, montantRetard: 0,
        },
        avanceManquante: avance && !avance.respectee ? avance : null,
      };
    })
    .filter(
      (d) =>
        d.arrieres.length > 0 ||
        d.echeanceDuJour !== null ||
        d.dette.nb > 0 ||
        d.avanceManquante !== null,
    );
}

/** Envoie une relance a chacun. Ne leve jamais : chaque echec est isole. */
export async function envoyerRelances(
  destinataires: Destinataire[],
  maintenant = new Date(),
): Promise<{ envoyes: string[]; echecs: string[] }> {
  const envoyes: string[] = [];
  const echecs: string[] = [];
  if (transportConfigure() === "aucun") return { envoyes, echecs };

  const moisCourant = debutMois(maintenant);
  const siteUrl = lienDuSite();
  for (const d of destinataires) {
    const { ok } = await envoyerCourriel({
      destinataire: d.situation.email,
      sujet: sujetRelance(d, moisCourant, maintenant),
      texte: texteRelance(d, siteUrl, maintenant),
    });
    (ok ? envoyes : echecs).push(d.situation.email);
  }
  return { envoyes, echecs };
}


/* ------------------------------------------------------------ idempotence */

/**
 * Les membres a qui une relance automatique est deja partie aujourd'hui.
 *
 * Le cron passe trois fois par mois, mais rien ne garantit qu'il ne passe qu'une
 * fois par jour : un redeploiement, une reprise apres erreur, un declenchement
 * repete cote hebergeur, et dix membres recoivent le meme courrier deux fois.
 * Une relance repetee le meme jour ne dit rien de plus et abime la seule chose
 * qu'elle doit obtenir -- qu'on la lise.
 *
 * Seuls les envois reussis comptent : un echec doit pouvoir etre retente au
 * passage suivant.
 *
 * La date est comparee en UTC, comme l'horaire du cron, pour qu'un fuseau de
 * serveur different ne decale pas la journee.
 *
 * Reserve : deux passages strictement simultanes liraient tous deux une liste
 * vide et enverraient deux fois. L'hebergeur ne declenche pas un meme horaire en
 * parallele ; s'en premunir demanderait une contrainte d'unicite sur une
 * expression de date, que PostgreSQL n'indexe pas sur un timestamptz.
 */
export async function dejaRelancesAujourdhui(maintenant = new Date()): Promise<Set<string>> {
  const jour = maintenant.toISOString().slice(0, 10);
  const sql = db();
  const lignes = (await sql`
    select distinct member_id
    from reminder_log
    where channel = 'email'
      and ok = true
      and (sent_at at time zone 'UTC')::date = ${jour}::date
  `) as { member_id: string }[];
  return new Set(lignes.map((l) => l.member_id));
}

/** Inscrit au registre l'issue d'un envoi, membre par membre. */
export async function tracerRelances(
  destinataires: Destinataire[],
  envoyes: string[],
  maintenant = new Date(),
  canal = "email",
): Promise<void> {
  if (destinataires.length === 0) return;
  const moisCourant = debutMois(maintenant);
  const sql = db();
  for (const d of destinataires) {
    const reussi = envoyes.includes(d.situation.email);
    await sql`
      insert into reminder_log (period, member_id, channel, ok, error)
      values (${moisCourant}::date, ${d.situation.membreId}::uuid, ${canal}, ${reussi},
              ${reussi ? null : "envoi impossible"})
    `;
  }
}


/**
 * Jours restants avant l'echeance du mois, negatif une fois passee.
 *
 * La relance part plusieurs fois avant le 10 : ecrire « du aujourd'hui » le 7
 * serait faux, et user la formule pour le jour ou elle compte vraiment.
 */
export { joursAvantEcheance };

/*
 * L'objet nomme le motif le plus grave. Une mesure disciplinaire assortie d'une
 * date prime sur un simple rappel d'echeance : c'est elle qu'il faut lire.
 */
export function sujetRelance(d: Destinataire, moisCourant: string, maintenant: Date): string {
  if (d.avanceManquante) return `${CLUB.sigle} — avance obligatoire non constituee`;
  if (d.arrieres.length > 0) return `${CLUB.sigle} — versement en retard (${d.arrieres.length} mois)`;
  /*
   * L'objet annonce la dette inscrite, toutes natures, et non le seul decompte
   * des retards : un membre penalise pour deux absences recevait un objet muet
   * a leur sujet, puis les decouvrait dans le corps du message.
   */
  if (d.dette.nb > 0) {
    return `${CLUB.sigle} — ${d.dette.nb} penalite(s) impayee(s)`;
  }
  const ou = etatEcheance(maintenant);
  if (ou === "a_venir") {
    return `${CLUB.sigle} — versement ${deMois(moisCourant)} attendu le ${REGLES.jourEcheance}`;
  }
  return ou === "aujourdhui"
    ? `${CLUB.sigle} — votre versement ${deMois(moisCourant)} est du aujourd'hui`
    : `${CLUB.sigle} — votre versement ${deMois(moisCourant)} est en retard`;
}

export function texteRelance(
  { situation, arrieres, echeanceDuJour, avanceManquante, dette }: Destinataire,
  siteUrl: string,
  maintenant: Date,
): string {
  // Le blanc qui suit l'appel n'a de sens que s'il precede un paragraphe.
  const lignes: string[] = [`Bonjour ${situation.nom},`];

  if (echeanceDuJour) {
    const reste = joursAvantEcheance(maintenant);
    const ou = etatEcheance(maintenant);
    /*
     * Le montant annonce est ce qui reste a verser, non la cotisation entiere :
     * ecrire « votre versement de 5 000 est du » a quelqu'un qui en a deja verse
     * 2 000 lui ferait croire a une erreur du site, ou pire, le ferait payer deux
     * fois. La cellule connait le compte exact, taux particulier compris.
     */
    const cellule = situation.cellules.find((c) => c.mois === echeanceDuJour);
    const dejaVerse = cellule?.montant ?? 0;
    const du = cellule && cellule.requis > 0 ? cellule.manque : REGLES.cotisationMensuelle;
    const rappelAcompte =
      dejaVerse > 0
        ? ` Vous avez deja verse ${fcfa(dejaVerse)} sur ${fcfa(cellule?.requis ?? 0)} : ` +
          "le mois n'est solde qu'au dernier franc, et la penalite de l'art. 9 porte " +
          "sur la cotisation entiere."
        : "";
    lignes.push(
      "",
      /*
       * TROIS CAS, ET NON DEUX. « Est du aujourd'hui, dernier jour de
       * l'echeance » s'ecrivait aussi bien le 10 que le 30 : le 30 septembre,
       * un membre en retard de vingt jours lisait dans le meme courrier qu'il
       * avait une penalite impayee ET que son versement etait du du jour meme.
       * La phrase le dedouanait de ce que la ligne suivante lui reprochait.
       */
      (ou === "a_venir"
        ? `Votre versement de ${fcfa(du)} pour ` +
          `${moisLong(echeanceDuJour)} est attendu au plus tard le ${REGLES.jourEcheance} ` +
          `(art. 8) : il vous reste ${reste} jour${reste > 1 ? "s" : ""}.`
        : ou === "aujourdhui"
          ? `Votre versement de ${fcfa(du)} pour ` +
            `${moisLong(echeanceDuJour)} est du aujourd'hui, dernier jour de l'echeance ` +
            "statutaire (art. 8)."
          : `Votre versement de ${fcfa(du)} pour ` +
            `${moisLong(echeanceDuJour)} etait du le ${REGLES.jourEcheance} (art. 8) : ` +
            `il est en retard de ${-reste} jour${-reste > 1 ? "s" : ""}, et la penalite ` +
            "de l'art. 9 court.") + rappelAcompte,
    );
  }

  if (arrieres.length > 0) {
    lignes.push(
      "",
      "Versements encore manquants :",
      /*
       * Le detail du mois entame : dire « septembre » a qui a deja verse 2 000
       * le laisserait croire a une erreur du site. Le montant qui manque leve
       * l'ambiguite et evite un echange.
       */
      arrieres
        .map((m) => {
          const c = situation.cellules.find((x) => x.mois === m);
          return c && c.montant > 0
            ? `  - ${moisLong(m)} : ${fcfa(c.montant)} verses sur ${fcfa(c.requis)}, il manque ${fcfa(c.manque)}`
            : `  - ${moisLong(m)}`;
        })
        .join("\n"),
      "",
      `Penalites dues a ce jour (art. 9) : ${fcfa(situation.totalPenalites)}.`,
    );

    if (arrieres.length >= REGLES.declarationObligatoireApresMois) {
      lignes.push(
        "",
        "Rappel R3 : a partir du 2e mois de retard, vous devez declarer votre situation sur le " +
          "groupe WhatsApp du club en taguant tous les membres, au plus tard le lendemain. " +
          "Cette declaration conditionne votre droit au plan de redressement prevu par R5.",
      );
    }
    if (arrieres.length >= REGLES.doublementApresMois) {
      lignes.push(
        "",
        "Rappel R4 : au-dela de 3 mois de retard, les penalites des 3 derniers mois sont doublees " +
          "(de 30 % a 60 % du versement du).",
      );
    }
    if (situation.joursDeRetard >= REGLES.suspensionVoteApresJours) {
      lignes.push(
        "",
        `Rappel R2 : passe ${REGLES.suspensionVoteApresJours} jours de retard, votre droit de vote ` +
          "est suspendu jusqu'a regularisation complete.",
      );
    }
  }

  /*
   * Les penalites se rappellent meme sans aucun mois en retard : c'est tout
   * l'objet de la resolution qui les a rendues indissociables des cotisations.
   */
  if (dette.nb > 0) {
    const seuil = REGLES.penalitesImpayeesAvantExclusion;
    const effet = EFFET.penalitesIndissociables;
    const enVigueur = maintenant.toISOString().slice(0, 10) >= effet;

    lignes.push("");
    /*
     * Le total des penalites a deja ete dit plus haut a qui a des arrieres :
     * le repeter donnerait deux chiffres identiques a trois lignes d'intervalle,
     * et ferait douter qu'ils parlent de la meme chose.
     */
    /*
     * LE COMPTE ET LE MONTANT SORTENT DE LA MEME TABLE.
     *
     * Le courrier collait un decompte du registre -- retards seuls -- a
     * `totalPenalites`, qui est la penalite THEORIQUE des mois impayes. Deux
     * mesures differentes dans une seule phrase, dont aucune ne voyait les
     * absences.
     *
     * Et quand la dette porte des natures differentes, on les detaille : le
     * seuil R5 ne compte que les retards, et le membre doit pouvoir rapprocher
     * le nombre annonce de la regle qui suit.
     */
    const autres = dette.nb - dette.nbRetard;
    lignes.push(
      autres > 0
        ? `Penalites impayees : ${dette.nb}, pour un total de ${fcfa(dette.montant)} — ` +
          `dont ${dette.nbRetard} de retard (${fcfa(dette.montantRetard)}) et ` +
          `${autres} d'absence ou autre (${fcfa(dette.montant - dette.montantRetard)}).`
        : `Penalites de retard impayees : ${dette.nbRetard}, pour un total de ` +
          `${fcfa(dette.montantRetard)}.`,
    );

    /*
     * La regle ne mord qu'a sa date d'effet. Annoncer une exclusion « encourue de
     * plein droit depuis » une date a venir serait faux, et alarmerait a tort.
     */
    if (dette.nbRetard >= seuil && enVigueur) {
      lignes.push(
        `Vos penalites de retard atteignent le seuil de ${seuil} fixe par l'assemblee : ` +
          "les penalites etant " +
          `indissociables des cotisations depuis le ${dateCourte(effet)}, l'exclusion est ` +
          "encourue de plein droit (R5), meme cotisations a jour.",
      );
    } else if (situation.nbPenalitesImpayees >= seuil) {
      lignes.push(
        `Ce nombre atteint deja le seuil de ${seuil} fixe par l'assemblee. A compter du ` +
          `${dateCourte(effet)}, les penalites deviendront indissociables des cotisations et ` +
          "ce cumul emportera l'exclusion de plein droit (R5), meme cotisations a jour. " +
          "Vous avez jusque-la pour regulariser.",
      );
    } else {
      lignes.push(
        /*
         * « DE RETARD », en toutes lettres. Le seuil ne compte que celles-la, et
         * la ligne precedente peut annoncer un nombre plus grand quand des
         * absences s'y ajoutent : sans ce mot, le membre lirait qu'il atteint un
         * seuil qu'il n'atteint pas.
         */
        `A partir de ${seuil} penalites de retard impayees, l'exclusion sera encourue de ` +
          `plein droit (R5) meme cotisations a jour — regle applicable le ${dateCourte(effet)}.`,
      );
    }
  }

  if (avanceManquante) {
    lignes.push(
      "",
      "MESURE DISCIPLINAIRE — avance obligatoire.",
      `L'assemblee vous impose de detenir en permanence ${avanceManquante.mois} mois de ` +
        `cotisation d'avance, soit ${fcfa(avanceManquante.montantExige)}.`,
      `Vous en detenez aujourd'hui ${fcfa(avanceManquante.avanceDetenue)} : il manque ` +
        `${fcfa(Math.max(0, avanceManquante.montantExige - avanceManquante.avanceDetenue))}.`,
      avanceManquante.fin
        ? `Cette obligation court jusqu'au ${dateCourte(avanceManquante.fin)}.`
        : "Cette obligation est sans terme fixe.",
      "A defaut de regularisation, l'exclusion est automatique (R5).",
    );
  }

  /*
   * Le chemin, pas seulement l'adresse.
   *
   * La relance donnait un lien et s'arretait la. Un membre qui ouvre le site
   * pour la premiere fois y arrive sans savoir ou declarer : il renvoie alors un
   * message au groupe, et le tresorier saisit a sa place -- ce que l'outil etait
   * cense supprimer. Cinq lignes suffisent a le rendre autonome.
   */
  if (siteUrl) {
    lignes.push(
      "",
      "COMMENT ENREGISTRER VOTRE VERSEMENT",
      `  1. Ouvrez ${siteUrl} et connectez-vous.`,
      /*
       * Le tiroir a disparu avec la refonte : la navigation est en bas de
       * l'ecran sur telephone, dans une colonne a gauche sur ordinateur. Le
       * courrier decrivait encore le menu d'avant -- et un membre qui suit une
       * consigne fausse ecrit au groupe, ce que ces cinq lignes servent
       * justement a eviter.
       */
      "  2. Touchez « Versements » : dans la barre du bas sur telephone,",
      "     dans la colonne de gauche sur ordinateur.",
      "  3. Ouvrez « Declarer un versement » et indiquez le mois couvert,",
      "     le montant, la date et le moyen de paiement.",
      "  4. Joignez la capture de votre transfert : elle epargne une question.",
      "  5. Le tresorier valide, et votre mois se marque d'une coche.",
      "",
      "Le tresorier est prevenu par courriel des que vous declarez, le president et",
      "vous-meme en copie : inutile d'ecrire en plus, et vous gardez la trace de ce",
      "que vous avez declare. Tant que la validation n'a pas eu lieu, votre",
      "declaration reste visible de tous, marquee « en attente » : rien ne se perd.",
    );
  }
  /*
   * La date distingue les passages du mois. Trois courriers au texte identique
   * sont replies par la messagerie sous « messages precedents masques », et le
   * dernier parait vide -- l'ecueil deja rencontre sur les courriers d'essai.
   */
  lignes.push("", `Relance du ${dateCourte(maintenant.toISOString().slice(0, 10))}.`);
  lignes.push("", `Le bureau — ${CLUB.nom}`);
  return lignes.join("\n");
}
