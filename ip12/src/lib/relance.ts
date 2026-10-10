import "server-only";
import { db } from "@/lib/db";
import {
  avancesExigees, circuitReglementsPret, penalitesDuesDetaillees, plansRedressement,
  reglesImminentes, reglesParMembre, situationsClub,
  type AvanceExigee, type DetteMembre, type PlanRedressement, type RegleMembre,
  type SituationClub,
} from "@/lib/queries";
import { cotisationsARegler, phaseSeuilR5 } from "@/lib/penalites";
import { penalitesNonInscrites } from "@/lib/constat";
import { envoyerCourriel, transportConfigure } from "@/lib/courriel";
import {
  CLUB, EFFET, REGLES, accorde, dateCourte, deMois, debutMois, etatEcheance, fcfa,
  joursAvantEcheance, lienDuSite, moisLong, texteLisible,
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
   * Les regles individuelles en vigueur pour ce membre.
   *
   * Elles pesent sur les calculs sans que le courrier en dise rien : un membre
   * voyait ses penalites doublees sans savoir pourquoi, un autre une cotisation
   * qui n'est pas celle de l'article 6. Et celui qui n'avait rien a se
   * reprocher n'etait destinataire d'aucun courrier : la mesure votee en
   * assemblee ne lui etait jamais rappelee.
   */
  regles: RegleMembre[];
  /**
   * Les regles qui entreront en vigueur sous peu.
   *
   * Une mesure datee s'annonce avant sa date : l'assemblee en impose une « a
   * compter du 10/10 » en exigeant qu'elle soit « regularisee avant le 10
   * octobre », et le site n'en disait rien jusqu'au 10. Le membre devait reunir
   * quinze mille francs sans qu'on le lui rappelle.
   */
  reglesAVenir: RegleMembre[];
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
  /**
   * Avance tenue, mais au minimum : la prochaine echeance la ferait passer
   * dessous sans nouveau versement. C'est le preavis -- le seul courrier qu'une
   * avance tenue declenche.
   */
  avanceAuSeuil: AvanceExigee | null;
  /**
   * Mesure d'avance dans sa derniere periode : les mois qui restent jusqu'au
   * terme n'excedent plus les mois imposes. C'est la que la fin s'annonce.
   */
  avanceFinissante: AvanceExigee | null;
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
  const regles = await reglesParMembre().catch(() => new Map<string, RegleMembre[]>());
  const aVenir = await reglesImminentes(maintenant).catch(
    () => new Map<string, RegleMembre[]>(),
  );

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
        regles: regles.get(situation.membreId) ?? [],
        reglesAVenir: aVenir.get(situation.membreId) ?? [],
        arrieres: situation.moisEnRetard.filter((m) => m !== moisCourant),
        echeanceDuJour,
        dette: dettes.get(situation.membreId) ?? {
          nb: 0, montant: 0, nbRetard: 0, montantRetard: 0,
        },
        avanceManquante: avance && !avance.respectee ? avance : null,
        avanceAuSeuil: avance && avance.respectee && avance.auSeuil ? avance : null,
        avanceFinissante:
          avance && avance.moisRestants !== null && avance.moisRestants <= avance.mois
            ? avance
            : null,
      };
    })
    .filter((d) => doitRecevoir(d, maintenant));
}

/**
 * L'annonce de la fin d'une mesure d'avance.
 *
 * DECISION DU BUREAU : le membre est informe de la fin quand tout est en
 * ordre, et a l'avance de la duree meme de la mesure -- trois mois avant pour
 * une avance de trois mois. C'est le moment ou les mois qui restent jusqu'au
 * terme sont exactement ceux qu'il detient : il n'a plus rien a constituer, et
 * doit le savoir pour ne pas payer d'avance des mois que la mesure n'exige
 * plus.
 *
 * Une seule fois : le mois ou les mois restants egalent les mois imposes, avec
 * le courrier de l'echeance, comme le rappel de regime. Hors de ce moment, ou
 * si tout n'est pas en ordre, la fin se dit dans le courrier qu'il recoit de
 * toute facon.
 */
export function annonceFinAvance(d: Destinataire, maintenant: Date): boolean {
  const a = d.avanceFinissante;
  return Boolean(
    a && a.respectee && a.moisRestants === a.mois && etatEcheance(maintenant) !== "a_venir",
  );
}

/**
 * Qui recoit un courrier ce jour-la.
 *
 * Isole et exporte parce que c'est ici que se decide qu'un membre est ecrit ou
 * non -- la question la plus sensible du courrier, et la seule qu'aucun
 * controle ne verifiait, enfouie qu'elle etait dans une lecture de la base.
 */
export function doitRecevoir(d: Destinataire, maintenant: Date): boolean {
  return (
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
    d.avanceManquante !== null ||
    /*
     * L'AVANCE TENUE NE DECLENCHE QUE LE PREAVIS.
     *
     * Le membre tenu a une avance minimale recevait chaque 10 un rappel de son
     * regime, meme confortablement au-dessus du minimum. Le bureau a tranche :
     * rien tant qu'il a plus que le minimum, un preavis des qu'il n'en a plus
     * que le minimum, la mesure disciplinaire une fois en defaut.
     */
    Boolean(d.avanceAuSeuil) ||
    annonceFinAvance(d, maintenant) ||
    /*
     * UNE REGLE INDIVIDUELLE VAUT COURRIER, MEME A JOUR DE TOUT -- sauf
     * l'avance, qui a ses propres declencheurs juste au-dessus.
     *
     * Un membre sous cotisation particuliere, penalites majorees ou plan de
     * redressement, et qui ne doit rien, n'etait destinataire d'aucun
     * courrier : la mesure decidee en assemblee ne lui etait jamais rappelee,
     * et ses penalites tombaient doublees sans explication. Une seule fois par
     * mois, cependant : les rappels des 7 et 9 s'adressent a qui doit quelque
     * chose ; celui-ci part avec le courrier de l'echeance.
     */
    (d.regles.some((r) => r.nature !== "avance_min") && etatEcheance(maintenant) !== "a_venir")
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
  /*
   * Rien a reclamer : l'objet ne doit pas annoncer une relance. Un membre a jour
   * qui lit « versement en retard » ouvre le site pour verifier, ou ecrit au
   * groupe -- et la prochaine relance, meritee, se lira comme celle-ci.
   */
  const rienDu =
    d.arrieres.length === 0 &&
    d.echeanceDuJour === null &&
    d.dette.nb === 0 &&
    d.nonInscrites.montant === 0 &&
    d.avanceManquante === null &&
    !d.avanceAuSeuil;
  if (rienDu && d.avanceFinissante?.fin && annonceFinAvance(d, maintenant)) {
    return `${CLUB.sigle} : fin de votre mesure d'avance le ${dateCourte(d.avanceFinissante.fin)}`;
  }
  if (rienDu && d.regles.length > 0) {
    return `${CLUB.sigle} : rappel de votre régime particulier`;
  }
  if (d.avanceManquante) return `${CLUB.sigle} : avance obligatoire non constituée`;
  /*
   * Le preavis passe apres tout ce qui est du : un membre en retard lit
   * d'abord son retard. Seul, il dit ce qu'il est -- un avertissement, non un
   * reproche.
   */
  if (
    d.avanceAuSeuil &&
    d.arrieres.length === 0 &&
    d.echeanceDuJour === null &&
    d.dette.nb === 0
  ) {
    return `${CLUB.sigle} : votre avance obligatoire arrive au minimum`;
  }
  /*
   * Le plan vient apres l'avance non tenue -- celle-ci est un manquement, celui-la
   * une mesure que le membre respecte peut-etre -- mais avant le simple retard :
   * c'est le courrier qu'il faut ouvrir.
   */
  if (d.plan && d.arrieres.length > 0) {
    return `${CLUB.sigle} : plan de redressement : ${d.arrieres.length} mois à régulariser`;
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
    return `${CLUB.sigle} : versement en retard (${n} mois)`;
  }
  /*
   * L'objet annonce la dette inscrite, toutes natures, et non le seul decompte
   * des retards : un membre penalise pour deux absences recevait un objet muet
   * a leur sujet, puis les decouvrait dans le corps du message.
   */
  if (d.dette.nb > 0) {
    /*
     * « 1 penalite(s) impayee(s) » : la parenthese est une facilite de
     * developpeur, et elle est en tete d'un courrier que dix personnes lisent.
     * Le nombre est connu au moment d'ecrire la phrase.
     */
    const n = d.dette.nb;
    return `${CLUB.sigle} : ${n} ${accorde(n, "pénalité")} ${accorde(n, "impayée")}`;
  }
  const ou = etatEcheance(maintenant);
  if (ou === "a_venir") {
    return `${CLUB.sigle} : versement ${deMois(moisCourant)} attendu le ${REGLES.jourEcheance}`;
  }
  return ou === "aujourdhui"
    ? `${CLUB.sigle} : votre versement ${deMois(moisCourant)} est dû aujourd'hui`
    : `${CLUB.sigle} : votre versement ${deMois(moisCourant)} est en retard`;
}

export function texteRelance(
  {
    situation, arrieres, echeanceDuJour, avanceManquante, avanceAuSeuil, avanceFinissante,
    dette, nonInscrites, plan, regles, reglesAVenir,
  }: Destinataire,
  siteUrl: string,
  maintenant: Date,
  /* Faux tant que la migration n'a pas cree `penalty_settlements`. */
  circuitReglements = true,
): string {
  // Le blanc qui suit l'appel n'a de sens que s'il precede un paragraphe.
  const lignes: string[] = [`Bonjour ${situation.nom},`];

  /*
   * RIEN A RECLAMER : LE COURRIER CHANGE DE NATURE.
   *
   * Un membre sous regle individuelle recoit desormais un courrier meme a jour
   * de tout. Lui servir l'ouverture d'une relance serait lui reprocher ce qu'il
   * n'a pas fait -- et la prochaine, meritee celle-la, ne se distinguerait plus.
   */
  const rienDu =
    arrieres.length === 0 &&
    echeanceDuJour === null &&
    dette.nb === 0 &&
    nonInscrites.montant === 0 &&
    avanceManquante === null &&
    !avanceAuSeuil;
  if (rienDu) {
    lignes.push(
      "",
      "Vous êtes à jour de vos versements et de vos pénalités : ce courrier ne vous " +
        "réclame rien. Il rappelle les règles particulières qui vous sont applicables, " +
        "pour qu'aucune ne vous surprenne.",
    );
  }

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
        ? ` Vous avez déjà versé ${fcfa(dejaVerse)} sur ${fcfa(cellule?.requis ?? 0)} : ` +
          "le mois n'est soldé qu'au dernier franc, et la pénalité de l'art. 9 porte " +
          "sur la cotisation entière."
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
            `${moisLong(echeanceDuJour)} est dû aujourd'hui, dernier jour de l'échéance ` +
            "statutaire (art. 8)."
          : `Votre versement de ${fcfa(du)} pour ` +
            `${moisLong(echeanceDuJour)} était dû le ${REGLES.jourEcheance} (art. 8) : ` +
            `il est en retard de ${-reste} jour${-reste > 1 ? "s" : ""}, et la pénalité ` +
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
      echeanceDuJour ? "Mois antérieurs encore manquants :" : "Versements encore manquants :",
      /*
       * Le detail du mois entame : dire « septembre » a qui a deja verse 2 000
       * le laisserait croire a une erreur du site. Le montant qui manque leve
       * l'ambiguite et evite un echange.
       */
      arrieres
        .map((m) => {
          const c = situation.cellules.find((x) => x.mois === m);
          return c && c.montant > 0
            ? `  - ${moisLong(m)} : ${fcfa(c.montant)} versés sur ${fcfa(c.requis)}, il manque ${fcfa(c.manque)}`
            : `  - ${moisLong(m)}`;
        })
        .join("\n"),
    );
    /*
     * LE TOTAL, COMME POUR LES PENALITES.
     *
     * Le courrier chiffrait le seul mois courant -- « votre versement de 5 000
     * FCFA » -- puis listait les mois anterieurs sans montant, quand les
     * penalites, elles, recevaient leur total. Le membre retenait 5 000 ; il
     * lui en fallait 20 000. Et depuis que l'argent eteint la dette la plus
     * ancienne d'abord, ces 5 000 iraient sur le premier mois de la liste, non
     * sur le mois courant : il croirait avoir regle octobre, et octobre
     * resterait ouvert.
     *
     * Le chiffre vient de `cotisationsARegler`, que l'accueil lit aussi : le
     * site et le courrier ne peuvent plus annoncer deux montants differents.
     */
    const aJour = cotisationsARegler(situation.cellules);
    if (aJour.total > 0) {
      lignes.push(`Total des cotisations à régler pour être à jour : ${fcfa(aJour.total)}.`);
    }


    if (arrieres.length >= REGLES.declarationObligatoireApresMois) {
      lignes.push(
        "",
        "Rappel R3 : à partir du 2e mois de retard, vous devez déclarer votre situation sur le " +
          "groupe WhatsApp du club en taguant tous les membres, au plus tard le lendemain. " +
          "Cette déclaration conditionne votre droit au plan de redressement prévu par R5.",
      );
    }
    if (arrieres.length >= REGLES.doublementApresMois) {
      lignes.push(
        "",
        "Rappel R4 : au-delà de 3 mois de retard, les pénalités des 3 derniers mois sont doublées " +
          "(de 30 % à 60 % du versement dû).",
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
        `Rappel R2 : votre plus ancien mois impayé date de ${situation.joursDeRetard} jours. ` +
          `Au-delà de ${REGLES.suspensionVoteApresJours} jours de retard, le droit de vote est ` +
          "suspendu : le vôtre l'est donc dès à présent, jusqu'à régularisation complète.",
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
    const montantAutres = dette.montant - dette.montantRetard;
    if (dette.nb > 0) {
      /*
       * TROIS CAS, ET AUCUNE COMPOSANTE NULLE.
       *
       * Le detail ne se justifiait que par la presence des deux natures, et la
       * condition ne regardait que les absences : un membre n'ayant qu'une
       * penalite d'absence lisait « dont 0 de retard (0 FCFA) et 1 d'absence ».
       * Un zero annonce fait chercher ce qu'il cache.
       */
      lignes.push(
        autres > 0 && dette.nbRetard > 0
          ? `Pénalités impayées inscrites à votre compte : ${dette.nb}, pour un total de ` +
            `${fcfa(dette.montant)}, dont ${dette.nbRetard} de retard ` +
            `(${fcfa(dette.montantRetard)}) et ${autres} d'absence ou autre ` +
            `(${fcfa(montantAutres)}).`
          : autres > 0
            ? `${accorde(autres, "Pénalité")} d'absence ou autre, ` +
              `${accorde(autres, "inscrite")} à votre compte : ${autres}, ` +
              `pour un total de ${fcfa(montantAutres)}.`
            : `${accorde(dette.nbRetard, "Pénalité")} de retard ` +
              `${accorde(dette.nbRetard, "impayée")}, ` +
              `${accorde(dette.nbRetard, "inscrite")} à votre compte : ${dette.nbRetard}, ` +
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
          ? `${nonInscrites.nb} mois encore impayés`
          : "un mois encore impayé";
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
          ? `S'y ajoute la pénalité de l'art. 9 sur ${combien} : ` +
            `${fcfa(nonInscrites.montant)}.`
          : `Pénalité de l'art. 9 sur ${combien} : ${fcfa(nonInscrites.montant)}.`,
      );
      if (dette.nb > 0) {
        lignes.push(
          `Total des pénalités dues à ce jour : ${fcfa(dette.montant + nonInscrites.montant)}.`,
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
        `Vos ${dette.nbRetard} pénalités de retard impayées atteignent le seuil de ${seuil} ` +
          "fixé par l'assemblée. Elles entrent dans le plan de redressement détaillé " +
          "plus bas : l'exclusion de plein droit est écartée tant que vous en tenez " +
          "les termes.",
      );
    } else if (phase === "atteint_en_vigueur") {
      lignes.push(
        `Vos pénalités de retard atteignent le seuil de ${seuil} fixé par l'assemblée : ` +
          "les pénalités étant " +
          `indissociables des cotisations depuis le ${dateCourte(effet)}, l'exclusion est ` +
          "encourue de plein droit (R5), même si vos cotisations sont à jour.",
      );
    } else if (phase === "atteint_avant_effet") {
      lignes.push(
        /*
         * « Ce nombre » ne designait rien de sur quand la ligne precedente en
         * porte trois -- le total, les retards, les absences -- et que le seuil
         * ne compte que les retards. On le nomme.
         */
        `Vos ${dette.nbRetard} pénalités de retard impayées atteignent déjà le seuil de ` +
          `${seuil} fixé par l'assemblée. À compter du ` +
          `${dateCourte(effet)}, les pénalités deviendront indissociables des cotisations et ` +
          "ce cumul emportera l'exclusion de plein droit (R5), même si vos cotisations sont " +
          "à jour. Vous avez jusque-là pour régulariser.",
      );
    } else if (dette.nbRetard > 0) {
      /*
       * L'AVERTISSEMENT NE VAUT QUE POUR QUI A DEJA DES PENALITES DE RETARD.
       *
       * Il se declenchait des qu'une penalite existait, de quelque nature :
       * un membre n'ayant qu'une penalite d'absence lisait « a partir de 3
       * penalites DE RETARD impayees, l'exclusion sera encourue » juste sous
       * l'annonce de son unique penalite -- de quoi se croire au tiers d'un
       * seuil dont il est a zero. Le seuil ne compte que les retards : sans
       * retard inscrit, il n'y a rien a annoncer.
       */
      lignes.push(
        /*
         * « DE RETARD », en toutes lettres. Le seuil ne compte que celles-la, et
         * la ligne precedente peut annoncer un nombre plus grand quand des
         * absences s'y ajoutent : sans ce mot, le membre lirait qu'il atteint un
         * seuil qu'il n'atteint pas.
         */
        `À partir de ${seuil} pénalités de retard impayées, l'exclusion sera encourue de ` +
          "plein droit (R5) même si vos cotisations sont à jour. Règle applicable le " +
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
  /*
   * LES REGLES QUI PESENT SANS SE DIRE.
   *
   * L'avance et le plan ont leur propre bloc, ci-dessous : les repeter ici les
   * diluerait. Restent celles qui changent un montant sans jamais paraitre --
   * la cotisation particuliere et les penalites majorees -- et la note que le
   * bureau a pu attacher. Un membre dont les penalites sont doublees par une
   * decision d'assemblee les voyait tomber sans explication, et pouvait croire
   * a une erreur du site.
   */
  /*
   * CE QUI VA S'APPLIQUER, AVANT QUE CELA S'APPLIQUE.
   *
   * Une mesure datee ne se respecte que si on la connait avant sa date. Celle-ci
   * se lit donc a tous les passages, et non une fois par mois : c'est le delai
   * qui compte, pas la cadence.
   */
  if (reglesAVenir.length > 0) {
    lignes.push("", "MESURE À VENIR");
    for (const r of reglesAVenir) {
      const jours = r.debut
        ? Math.round(
            (new Date(`${r.debut}T00:00:00Z`).getTime() -
              new Date(`${maintenant.toISOString().slice(0, 10)}T00:00:00Z`).getTime()) /
              86_400_000,
          )
        : 0;
      /*
       * Le decompte ferme la phrase au lieu de la couper : « a compter du
       * 10/10/2026 — dans 10 jours, et jusqu'au 31/12/2027 » faisait buter sur
       * l'incise, et c'est le delai qu'on veut laisser en tete.
       */
      const quand = r.debut ? `à compter du ${dateCourte(r.debut)}` : "prochainement";
      const jusqua = r.fin ? ` et jusqu'au ${dateCourte(r.fin)}` : "";
      const delai = jours > 0 ? `, dans ${jours} ${accorde(jours, "jour")}` : "";
      if (r.nature === "avance_min" && r.valeur) {
        lignes.push(
          `  - Avance minimale : vous devrez détenir en permanence ${r.valeur} mois de ` +
            `cotisation d'avance, soit ${fcfa(r.valeur * REGLES.cotisationMensuelle)}, ` +
            `${quand}${jusqua}${delai}.`,
        );
      } else if (r.nature === "cotisation" && r.valeur) {
        lignes.push(
          `  - Cotisation particulière : ${fcfa(r.valeur)} par mois, ${quand}${jusqua}${delai}.`,
        );
      } else if (r.nature === "penalite_multiplicateur" && r.valeur) {
        lignes.push(
          `  - Pénalités majorées : vos pénalités de retard seront multipliées par ` +
            `${r.valeur}, ${quand}${jusqua}${delai}.`,
        );
      } else if (r.nature === "plan_redressement") {
        lignes.push(`  - Plan de redressement (R5), ${quand}${jusqua}${delai}.`);
      } else {
        lignes.push(`  - Mesure portée à votre dossier, ${quand}${jusqua}${delai}.`);
      }
      if (r.note) lignes.push(`    ${texteLisible(r.note)}`);
    }
    lignes.push(
      "Cette mesure n'est pas encore en vigueur. C'est avant sa date qu'il faut s'y " +
        "conformer : passé ce terme, le manquement se constate.",
    );
  }

  const aDire = regles.filter((r) => {
    if (r.nature === "cotisation" || r.nature === "penalite_multiplicateur" || r.nature === "note") {
      return true;
    }
    /*
     * L'AVANCE TENUE SE DIT AUSSI.
     *
     * Elle n'avait de bloc que lorsqu'elle etait EN DEFAUT : `avanceManquante`
     * n'est pose que si l'obligation n'est pas tenue. Un membre qui la respecte,
     * destinataire pour un simple retard de cotisation, ne lisait donc rien de
     * l'obligation qui pese sur lui -- et pouvait la croire levee, puis la
     * rompre en retirant son avance. La mesure n'existait pour lui qu'au moment
     * ou il y manquait.
     *
     * Quand elle est en defaut, le bloc « MESURE DISCIPLINAIRE » la detaille
     * plus bas : on ne la repete pas ici.
     */
    if (r.nature === "avance_min") {
      return avanceManquante === null && !avanceAuSeuil && !avanceFinissante;
    }
    /* Le plan a toujours son bloc, tenu ou non : il n'a rien a faire ici. */
    return false;
  });
  if (aDire.length > 0) {
    lignes.push("", "VOTRE RÉGIME PARTICULIER");
    for (const r of aDire) {
      const fenetre = [
        r.debut ? `à compter du ${dateCourte(r.debut)}` : null,
        r.fin ? `jusqu'au ${dateCourte(r.fin)}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const terme = fenetre ? ` (${fenetre})` : "";
      if (r.nature === "cotisation" && r.valeur) {
        lignes.push(
          `  - Cotisation particulière : ${fcfa(r.valeur)} par mois${terme}, en lieu et ` +
            "place du montant de l'article 6.",
        );
      } else if (r.nature === "penalite_multiplicateur" && r.valeur) {
        lignes.push(
          `  - Pénalités majorées : vos pénalités de retard sont multipliées par ` +
            `${r.valeur}${terme}. Le taux de l'art. 9 s'applique, puis cette majoration.`,
        );
      } else if (r.nature === "avance_min" && r.valeur) {
        lignes.push(
          `  - Avance minimale : vous devez détenir en permanence ${r.valeur} mois de ` +
            `cotisation d'avance${terme}. Cette obligation est tenue à ce jour ; la rompre ` +
            "exposerait à l'exclusion (R5).",
        );
      } else if (r.nature === "note") {
        lignes.push(`  - ${texteLisible(r.note) || "Mention portée à votre dossier"}${terme}.`);
      }
      /*
       * La note est collee depuis WhatsApp et en porte le balisage : sans
       * nettoyage, le membre lit « *Resolutions :* *Mesure disciplinaire...* »,
       * la ponctuation d'un autre outil au milieu d'une sanction.
       */
      if (r.note && r.nature !== "note") lignes.push(`    ${texteLisible(r.note)}`);
    }
    lignes.push(
      "Ces règles ont été décidées en assemblée et sont inscrites à votre dossier. " +
        "Le bureau peut vous en rappeler les termes.",
    );
  }

  if (plan) {
    lignes.push(
      "",
      "MESURE DISCIPLINAIRE : plan de redressement (R5).",
      "L'assemblée vous a accordé un plan de redressement : votre retard déclaré " +
        "au groupe (R3) vous en a ouvert le bénéfice, et l'exclusion de plein droit " +
        "est écartée tant que vous en tenez les termes.",
      plan.note ? `Termes convenus : ${plan.note}` : "Les termes sont ceux convenus en assemblée.",
      plan.fin
        ? `Le plan court jusqu'au ${dateCourte(plan.fin)}. Passé ce terme, le régime ` +
          "commun s'applique de nouveau."
        : "Le plan est sans terme fixe.",
      /*
       * La phrase qui compte. R5 n'accorde le plan qu'une fois : un membre qui
       * le laisse expirer sans regulariser ne retrouve pas le droit commun, il
       * tombe sous le vote de l'art. 20.
       */
      "Ce plan ne s'accorde qu'une fois sur la durée du club : s'il devait ne pas " +
        "être tenu, l'exclusion serait soumise au vote de l'assemblée (art. 20).",
    );
  }

  /*
   * LA FIN DE LA MESURE, DITE AVANT D'ETRE ATTEINTE.
   *
   * Dans sa derniere periode, la mesure n'exige plus que les mois qui restent
   * jusqu'au terme. Le membre doit le savoir, sans quoi il continuerait de
   * payer d'avance des mois qu'elle n'exige plus -- et ignorerait qu'apres le
   * terme, le regime commun reprend.
   */
  if (avanceFinissante?.fin) {
    const terme = dateCourte(avanceFinissante.fin);
    lignes.push(
      "",
      "FIN DE VOTRE MESURE D'AVANCE",
      `Votre mesure d'avance obligatoire prend fin le ${terme}.`,
      avanceFinissante.respectee
        ? "Votre avance couvre déjà vos cotisations jusqu'à cette date : vous n'avez plus " +
          "rien à constituer d'avance."
        : `D'ici là, elle n'exige plus que les mois qui restent jusqu'au terme : ` +
          `${avanceFinissante.moisRequis} mois, soit ${fcfa(avanceFinissante.montantExige)}.`,
      `Après le ${terme}, le régime commun reprend : la cotisation de chaque mois, au plus ` +
        `tard le ${REGLES.jourEcheance}.`,
    );
  }

  /*
   * LE PREAVIS : TENUE, MAIS AU MINIMUM.
   *
   * Chaque echeance consomme un mois d'avance. Au minimum, la prochaine la
   * ferait passer dessous sans nouveau versement -- et la mesure deviendrait
   * disciplinaire. Le courrier le dit avant, et chiffre ce qu'il faut verser :
   * un avertissement utile est celui qui donne le montant, pas le calcul.
   */
  if (avanceAuSeuil) {
    lignes.push(
      "",
      "VOTRE AVANCE OBLIGATOIRE ARRIVE AU MINIMUM",
      `L'assemblée vous impose de détenir en permanence ${avanceAuSeuil.mois} mois de ` +
        `cotisation d'avance, soit ${fcfa(avanceAuSeuil.montantExige)}. Vous en détenez ` +
        `${fcfa(avanceAuSeuil.avanceDetenue)} : l'obligation est tenue.`,
      "Mais chaque échéance consomme un mois de cette avance : sans nouveau versement, la " +
        `prochaine la fera passer sous le minimum. Versez au moins ` +
        `${fcfa(avanceAuSeuil.pourMaintenir)} pour la maintenir.`,
      avanceAuSeuil.fin
        ? `Cette obligation court jusqu'au ${dateCourte(avanceAuSeuil.fin)}.`
        : "Cette obligation est sans terme fixe.",
    );
  }

  if (avanceManquante) {
    lignes.push(
      "",
      "MESURE DISCIPLINAIRE : avance obligatoire.",
      /*
       * A l'approche du terme, l'exigence se limite aux mois qui restent :
       * annoncer « trois mois, soit 10 000 FCFA » se contredirait.
       */
      avanceManquante.moisRequis < avanceManquante.mois && avanceManquante.fin
        ? `L'assemblée vous impose ${avanceManquante.mois} mois de cotisation d'avance. ` +
          `La mesure prenant fin le ${dateCourte(avanceManquante.fin)}, il n'en reste ` +
          `que ${avanceManquante.moisRequis} à couvrir, soit ${fcfa(avanceManquante.montantExige)}.`
        : `L'assemblée vous impose de détenir en permanence ${avanceManquante.mois} mois de ` +
          `cotisation d'avance, soit ${fcfa(avanceManquante.montantExige)}.`,
      `Vous en détenez aujourd'hui ${fcfa(avanceManquante.avanceDetenue)} : il manque ` +
        `${fcfa(Math.max(0, avanceManquante.montantExige - avanceManquante.avanceDetenue))}.`,
      avanceManquante.fin
        ? `Cette obligation court jusqu'au ${dateCourte(avanceManquante.fin)}.`
        : "Cette obligation est sans terme fixe.",
      "À défaut de régularisation, l'exclusion est automatique (R5).",
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
  /*
   * LE MODE D'EMPLOI DES COTISATIONS NE SERT QU'A QUI EN DOIT UNE.
   *
   * Il paraissait des que le courrier reclamait quoi que ce soit. Un membre a
   * jour de ses versements et ne devant que des penalites recevait donc cinq
   * etapes sur la declaration d'un versement -- « indiquez le mois couvert » --
   * avant les trois qui le concernent. On lui expliquait longuement ce qu'il n'a
   * pas a faire.
   */
  /*
   * Qui doit maintenir ou reconstituer son avance doit verser, lui aussi : le
   * courrier qui le lui demande sans dire comment l'enverrait au groupe.
   */
  const doitUneCotisation =
    echeanceDuJour !== null ||
    arrieres.length > 0 ||
    avanceManquante !== null ||
    Boolean(avanceAuSeuil);
  /*
   * UN SEUL MODE D'EMPLOI, PARCE QU'IL N'Y A PLUS QU'UN CHEMIN.
   *
   * Le courrier en portait deux -- la cotisation, la penalite --, dix lignes
   * a qui devait les deux, parce que les deux se declaraient sur deux pages.
   * Les penalites se declarent desormais depuis Versements, en choisissant
   * « une penalite » : le chemin est le meme, seuls changent le choix a faire
   * au formulaire et la regle d'imputation.
   *
   * La partie penalites reste suspendue au circuit : tant que la migration n'a
   * pas cree la table, le courrier ne doit pas envoyer chercher un choix qui ne
   * mene nulle part.
   */
  const doitUnePenalite = dette.nb > 0 && circuitReglements;
  if (siteUrl && (doitUneCotisation || doitUnePenalite)) {
    const lesDeux = doitUneCotisation && doitUnePenalite;
    lignes.push(
      "",
      lesDeux
        ? "COMMENT ENREGISTRER VOS RÈGLEMENTS"
        : doitUnePenalite
          ? "COMMENT ENREGISTRER LE RÈGLEMENT DE VOS PÉNALITÉS"
          : "COMMENT ENREGISTRER VOTRE COTISATION",
      `  1. Ouvrez ${siteUrl} et connectez-vous.`,
      /*
       * Le tiroir a disparu avec la refonte : la navigation est en bas de
       * l'ecran sur telephone, dans une colonne a gauche sur ordinateur.
       */
      "  2. Touchez « Versements » : dans la barre du bas sur téléphone,",
      "     dans la colonne de gauche sur ordinateur.",
      ...(lesDeux
        ? [
            "  3. Ouvrez « Déclarer un versement », choisissez ce que vous réglez",
            "     (une cotisation ou une pénalité), puis indiquez le montant versé,",
            "     la date et le moyen de paiement. Si un même transfert couvre les",
            "     deux, déclarez chacun à part.",
          ]
        : doitUnePenalite
          ? [
              "  3. Ouvrez « Déclarer un versement », choisissez « une pénalité »,",
              "     puis indiquez le montant versé, la date et le moyen de paiement.",
            ]
          : [
              "  3. Ouvrez « Déclarer un versement » et indiquez le montant versé,",
              "     la date et le moyen de paiement.",
            ]),
      /*
       * LE MOIS NE SE SAISIT PLUS, IL S'ANNONCE. Les mois se reglent du plus
       * ancien au plus recent : le courrier nomme celui sur lequel l'argent
       * ira d'abord, sans quoi le membre croirait regler le mois courant.
       * `arrieres` exclut le mois courant et reste dans l'ordre.
       */
      ...(doitUneCotisation && arrieres.length > 0
        ? [
            `     ${lesDeux ? "Une cotisation" : "Votre versement"} s'impute sur ` +
              `${moisLong(arrieres[0])}, le plus ancien`,
            "     mois ouvert, puis sur les suivants s'il le dépasse.",
          ]
        : []),
      ...(doitUnePenalite
        ? ["     Une pénalité se règle entière, de la plus ancienne à la plus récente."]
        : []),
      "  4. Joignez la capture de votre transfert : elle épargne une question.",
      doitUneCotisation
        ? "  5. Le trésorier valide, et votre mois se marque d'une coche."
        : "  5. Le trésorier vérifie l'encaissement et solde la pénalité.",
    );
    if (doitUneCotisation) {
      lignes.push(
        "",
        /*
         * UN PARAGRAPHE, UNE LIGNE. Coupe a la main, il se recoupait sur un
         * telephone : quatre lignes longues alternant avec quatre moignons.
         */
        "Le trésorier est prévenu par courriel dès que vous déclarez, le président et " +
          "vous-même en copie : inutile d'écrire en plus, et vous gardez la trace de ce " +
          "que vous avez déclaré. Tant que la validation n'a pas eu lieu, votre " +
          "déclaration reste visible de tous, marquée « en attente » : rien ne se perd.",
      );
    }
    if (doitUnePenalite) {
      lignes.push(
        "",
        "La pénalité reste due jusqu'à cette vérification : si une relance vous " +
          "parvient entre-temps et la réclame encore, ce n'est pas une erreur.",
      );
    }
  }
  lignes.push(
    "",
    `${rienDu ? "Courrier" : "Relance"} du ${dateCourte(maintenant.toISOString().slice(0, 10))}.`,
  );
  lignes.push("", `Le bureau d'${CLUB.nom}`);
  return lignes.join("\n");
}
