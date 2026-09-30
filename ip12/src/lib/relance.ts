import "server-only";
import { db } from "@/lib/db";
import {
  avancesExigees, circuitReglementsPret, penalitesDuesDetaillees, plansRedressement,
  situationsClub,
  type AvanceExigee, type DetteMembre, type PlanRedressement, type SituationClub,
} from "@/lib/queries";
import { phaseSeuilR5 } from "@/lib/penalites";
import { penalitesNonInscrites } from "@/lib/constat";
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
   * La penalite que l'art. 9 fait courir sur les mois impayes et que le registre
   * ne porte PAS encore.
   *
   * LES DEUX SONT DUES, ET ELLES NE SE RECOUVRENT PAS. Le registre porte ce que
   * le tresorier a constate -- souvent des mois anciens, dont la cotisation a
   * fini par etre versee sans que la penalite le soit. L'art. 9, lui, court des
   * l'echeance passee, avant tout constat. Un membre doit donc les deux, et le
   * courrier les additionne.
   *
   * Mais il ne peut pas annoncer le calcul theorique en bloc : des que le
   * tresorier constate, les memes mois entrent au registre, et les deux chiffres
   * porteraient alors sur la meme realite. Seuls comptent ici les mois que le
   * registre ne porte pas -- exactement le rapprochement que la page Penalites
   * fait pour savoir ce qu'il reste a constater.
   */
  nonInscrites: { nb: number; montant: number; mois: string[] };
  /**
   * Le plan de redressement accorde au membre, s'il en beneficie d'un.
   *
   * R5 le reserve au retard declare et ne l'accorde qu'une fois sur la duree du
   * club. Le bureau pouvait l'inscrire, et la relance l'ignorait : elle
   * reclamait a un membre sous plan exactement comme a tout autre, sans un mot
   * sur la mesure ni sur son terme. Une mesure que l'outil ignore vaut une
   * mesure non prise -- et le membre qui la respecte doit le lire.
   */
  plan: PlanRedressement | null;
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
  /*
   * Ce qui court sans etre encore inscrit, calcule par `lib/constat` : la meme
   * lecture sert le recapitulatif du bureau et la page « Mon compte », pour que
   * les trois annoncent la meme somme.
   */
  const courues = await penalitesNonInscrites(situations);
  const plans = await plansRedressement().catch(() => new Map<string, PlanRedressement>());

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
        nonInscrites: courues?.get(situation.membreId) ?? { nb: 0, montant: 0, mois: [] },
        plan: plans.get(situation.membreId) ?? null,
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
        /*
         * Une penalite courue suffit. Un membre qui a fini par verser ses mois
         * en retard doit encore la penalite de l'art. 9, acquise a l'echeance :
         * plus d'arriere, rien au registre tant que le constat n'a pas eu lieu,
         * et il ne recevait donc aucun courrier a son sujet.
         */
        d.nonInscrites.montant > 0 ||
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
  /* Lu une fois pour tout le lot : la table ne nait pas au milieu d'un envoi. */
  const circuit = await circuitReglementsPret();
  for (const d of destinataires) {
    const { ok } = await envoyerCourriel({
      destinataire: d.situation.email,
      sujet: sujetRelance(d, moisCourant, maintenant),
      texte: texteRelance(d, siteUrl, maintenant, circuit),
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
  /*
   * Le plan vient apres l'avance non tenue -- celle-ci est un manquement, celui-la
   * une mesure que le membre respecte peut-etre -- mais avant le simple retard :
   * c'est le courrier qu'il faut ouvrir.
   */
  if (d.plan && d.arrieres.length > 0) {
    return `${CLUB.sigle} — plan de redressement : ${d.arrieres.length} mois a regulariser`;
  }
  /*
   * LE COMPTE DES MOIS EN RETARD, PAS CELUI DES MOIS ANTERIEURS.
   *
   * L'objet annoncait `arrieres.length`, qui exclut le mois courant : au
   * 30 septembre, un membre devant aout ET septembre lisait « versement en
   * retard (1 mois) » sur un courrier qui lui en reclamait deux. `moisEnRetard`
   * est le compte juste -- il ne retient que les mois dont l'echeance est
   * passee, un mois encore a venir n'y entre pas.
   */
  if (d.arrieres.length > 0) {
    const n = d.situation.moisEnRetard.length;
    return `${CLUB.sigle} — versement en retard (${n} mois)`;
  }
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
  {
    situation, arrieres, echeanceDuJour, avanceManquante, dette, nonInscrites, plan,
  }: Destinataire,
  siteUrl: string,
  maintenant: Date,
  /* Faux tant que la migration n'a pas cree `penalty_settlements`. */
  circuitReglements = true,
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
      /*
       * « Encore manquants » promettait la liste entiere, et n'en portait que la
       * part anterieure : le mois courant est traite au paragraphe du dessus,
       * `arrieres` l'exclut. Un membre a qui il manque aout ET septembre lisait
       * un seul mois sous un titre qui disait les contenir tous, et pouvait
       * croire septembre solde.
       */
      echeanceDuJour ? "Mois anterieurs encore manquants :" : "Versements encore manquants :",
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
    /*
     * LA SUSPENSION EST ACQUISE, ET LA PHRASE DOIT LE DIRE.
     *
     * Le test ne se declenche qu'une fois les trente jours passes, mais la
     * phrase restait au conditionnel implicite : « passe 30 jours, votre droit
     * de vote est suspendu » se lit comme un avertissement, alors que c'est un
     * constat. Nommer le nombre de jours leve du meme coup la seconde
     * ambiguite : le paragraphe d'ouverture parle du retard du mois courant
     * (vingt jours), celui-ci du plus ancien mois impaye (cinquante et un), et
     * deux chiffres de retard sans explication dans un meme courrier faisaient
     * douter des deux.
     */
    if (situation.joursDeRetard >= REGLES.suspensionVoteApresJours) {
      lignes.push(
        "",
        `Rappel R2 : votre plus ancien mois impaye date de ${situation.joursDeRetard} jours. ` +
          `Au-dela de ${REGLES.suspensionVoteApresJours} jours de retard, le droit de vote est ` +
          "suspendu : le votre l'est donc des a present, jusqu'a regularisation complete.",
      );
    }
  }

  /*
   * Les penalites se rappellent meme sans aucun mois en retard : c'est tout
   * l'objet de la resolution qui les a rendues indissociables des cotisations.
   */
  if (dette.nb > 0 || nonInscrites.montant > 0) {
    const seuil = REGLES.penalitesImpayeesAvantExclusion;
    const effet = EFFET.penalitesIndissociables;
    /*
     * Le seuil se juge sur le nombre que la ligne du dessus vient d'annoncer, et
     * sur lui seul. Il se lisait auparavant sur `situation.nbPenalitesImpayees`,
     * une autre grandeur : le courrier annoncait quinze penalites de retard,
     * puis enchainait sur « a partir de 3 ..., l'exclusion sera encourue »,
     * c'est-a-dire la phrase reservee a qui est sous le seuil.
     */
    const phase = phaseSeuilR5(dette.nbRetard, maintenant);

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
    if (dette.nb > 0) {
      lignes.push(
        autres > 0
          ? `Penalites impayees inscrites a votre compte : ${dette.nb}, pour un total de ` +
            `${fcfa(dette.montant)} — dont ${dette.nbRetard} de retard ` +
            `(${fcfa(dette.montantRetard)}) et ${autres} d'absence ou autre ` +
            `(${fcfa(dette.montant - dette.montantRetard)}).`
          : `Penalites de retard impayees, inscrites a votre compte : ${dette.nbRetard}, ` +
            `pour un total de ${fcfa(dette.montantRetard)}.`,
      );
    }

    /*
     * LES DEUX SONT DUES, ET LE COURRIER LES ADDITIONNE.
     *
     * Il annoncait « Penalites dues a ce jour (art. 9) : 1 000 FCFA », puis, deux
     * paragraphes plus loin, « Penalites de retard impayees : 15, pour un total
     * de 7 500 FCFA » -- deux chiffres separes par un rappel de R2, sans un mot
     * sur leur rapport. Les taire l'un ou l'autre serait pire : le registre porte
     * les penalites constatees, l'art. 9 court sur les mois encore impayes, et le
     * membre doit la somme.
     *
     * `nonInscrites` ne retient que les mois absents du registre : des que le
     * tresorier constate, cette ligne fond, et le total reste juste sans jamais
     * compter deux fois le meme mois.
     */
    if (nonInscrites.montant > 0) {
      const combien =
        nonInscrites.nb > 1
          ? `${nonInscrites.nb} mois encore impayes`
          : "un mois encore impaye";
      /*
       * « PAS ENCORE PORTEE A VOTRE COMPTE » NE REGARDE PAS LE MEMBRE.
       *
       * La phrase decrivait un retard de l'outil -- le registre attendait un
       * clic -- et invitait la seule question qu'elle ne pouvait pas repondre :
       * comment ca, pas encore porte ? Depuis que la relance constate avant
       * d'ecrire, cette ligne ne parait plus que si le constat a echoue, et elle
       * dit alors ce qui est vrai dans tous les cas : la penalite est due au
       * titre de l'art. 9. L'etat du registre est affaire du bureau.
       */
      lignes.push(
        dette.nb > 0
          ? `S'y ajoute la penalite de l'art. 9 sur ${combien} : ` +
            `${fcfa(nonInscrites.montant)}.`
          : `Penalite de l'art. 9 sur ${combien} : ${fcfa(nonInscrites.montant)}.`,
      );
      if (dette.nb > 0) {
        lignes.push(
          `Total des penalites dues a ce jour : ${fcfa(dette.montant + nonInscrites.montant)}.`,
        );
      }
    }

    /*
     * La regle ne mord qu'a sa date d'effet. Annoncer une exclusion « encourue de
     * plein droit depuis » une date a venir serait faux, et alarmerait a tort.
     */
    /*
     * LE PLAN COUVRE CETTE DETTE-LA AUSSI.
     *
     * Le courrier annoncait le seuil atteint et l'exclusion de plein droit, puis
     * expliquait vingt lignes plus bas qu'un plan de redressement l'ecarte. Les
     * deux paragraphes se contredisaient dans le meme courrier. `issueR5` a
     * toujours dit le contraire : « le plan porte sur l'ensemble de sa dette,
     * ses penalites impayees en font partie, celles-ci etant indissociables des
     * cotisations ».
     */
    if (plan && phase !== "sous_le_seuil") {
      lignes.push(
        `Vos ${dette.nbRetard} penalites de retard impayees atteignent le seuil de ${seuil} ` +
          "fixe par l'assemblee. Elles entrent dans le plan de redressement detaille " +
          "plus bas : l'exclusion de plein droit est ecartee tant que vous en tenez " +
          "les termes.",
      );
    } else if (phase === "atteint_en_vigueur") {
      lignes.push(
        `Vos penalites de retard atteignent le seuil de ${seuil} fixe par l'assemblee : ` +
          "les penalites etant " +
          `indissociables des cotisations depuis le ${dateCourte(effet)}, l'exclusion est ` +
          "encourue de plein droit (R5), meme si vos cotisations sont a jour.",
      );
    } else if (phase === "atteint_avant_effet") {
      lignes.push(
        /*
         * « Ce nombre » ne designait rien de sur quand la ligne precedente en
         * porte trois -- le total, les retards, les absences -- et que le seuil
         * ne compte que les retards. On le nomme.
         */
        `Vos ${dette.nbRetard} penalites de retard impayees atteignent deja le seuil de ` +
          `${seuil} fixe par l'assemblee. A compter du ` +
          `${dateCourte(effet)}, les penalites deviendront indissociables des cotisations et ` +
          "ce cumul emportera l'exclusion de plein droit (R5), meme si vos cotisations sont " +
          "a jour. Vous avez jusque-la pour regulariser.",
      );
    } else if (dette.nb > 0) {
      /*
       * L'avertissement ne vaut que si quelque chose est deja inscrit.
       *
       * Le paragraphe s'ouvre desormais aussi pour une penalite qui court sans
       * etre encore constatee : annoncer l'exclusion a qui doit cinq cents francs
       * depuis vingt jours, et rien au registre, alarmerait sans motif.
       */
      lignes.push(
        /*
         * « DE RETARD », en toutes lettres. Le seuil ne compte que celles-la, et
         * la ligne precedente peut annoncer un nombre plus grand quand des
         * absences s'y ajoutent : sans ce mot, le membre lirait qu'il atteint un
         * seuil qu'il n'atteint pas.
         */
        `A partir de ${seuil} penalites de retard impayees, l'exclusion sera encourue de ` +
          "plein droit (R5) meme si vos cotisations sont a jour — regle applicable le " +
          `${dateCourte(effet)}.`,
      );
    }
  }

  /*
   * LES MESURES DISCIPLINAIRES, TOUTES, ET AVANT LE MODE D'EMPLOI.
   *
   * Le courrier n'en connaissait qu'une : l'avance obligatoire. Le plan de
   * redressement, que le bureau peut accorder depuis Administration et que R5
   * ne donne qu'une fois sur la duree du club, n'etait relu par personne -- ni
   * ici, ni par `issueR5`, qui le prend pourtant en parametre. Un membre sous
   * plan recevait donc la meme relance que tout autre, sans un mot sur la mesure
   * qui le protege ni sur son terme. Il pouvait le croire oublie, ou le croire
   * caduc.
   */
  if (plan) {
    lignes.push(
      "",
      "MESURE DISCIPLINAIRE — plan de redressement (R5).",
      "L'assemblee vous a accorde un plan de redressement : votre retard declare " +
        "au groupe (R3) vous en a ouvert le benefice, et l'exclusion de plein droit " +
        "est ecartee tant que vous en tenez les termes.",
      plan.note ? `Termes convenus : ${plan.note}` : "Les termes sont ceux convenus en assemblee.",
      plan.fin
        ? `Le plan court jusqu'au ${dateCourte(plan.fin)}. Passe ce terme, le regime ` +
          "commun s'applique de nouveau."
        : "Le plan est sans terme fixe.",
      /*
       * La phrase qui compte. R5 n'accorde le plan qu'une fois : un membre qui
       * le laisse expirer sans regulariser ne retrouve pas le droit commun, il
       * tombe sous le vote de l'art. 20.
       */
      "Ce plan ne s'accorde qu'une fois sur la duree du club : s'il devait ne pas " +
        "etre tenu, l'exclusion serait soumise au vote de l'assemblee (art. 20).",
    );
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
      "COMMENT ENREGISTRER VOTRE COTISATION",
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

    /*
     * LE CHEMIN DES PENALITES, PUISQUE LE COURRIER EN RECLAME.
     *
     * Les cinq etapes ci-dessus ne valent que pour une cotisation : elles
     * demandent « le mois couvert », qu'une penalite n'a pas. Un membre a qui ce
     * courrier reclamait sept mille francs de penalites n'avait donc rien a
     * toucher -- il ecrivait au groupe, et le tresorier saisissait a sa place,
     * ce que ces lignes servent justement a eviter.
     */
    if (dette.nb > 0 && circuitReglements) {
      lignes.push(
        "",
        "COMMENT ENREGISTRER LE REGLEMENT D'UNE PENALITE",
        "  Le chemin n'est pas le meme : une penalite ne couvre aucun mois.",
        "  1. Touchez « Penalites », puis « Declarer un reglement ».",
        "  2. Choisissez la penalite reglee, la date et le moyen de paiement,",
        "     et joignez la capture de votre transfert.",
        "  3. Le tresorier verifie l'encaissement et solde la ligne.",
        "",
        "La penalite reste due jusqu'a cette verification : si une relance vous",
        "parvient entre-temps et la reclame encore, ce n'est pas une erreur.",
      );
    }
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
