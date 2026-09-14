import "server-only";
import { db } from "@/lib/db";
import { avancesExigees, situationsClub, type AvanceExigee, type SituationClub } from "@/lib/queries";
import { envoyerCourriel, transportConfigure } from "@/lib/courriel";
import {
  CLUB,
  EFFET,
  REGLES,
  dateCourte,
  debutMois,
  deMois,
  fcfa,
  moisLong,
  variable,
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

  return situations
    .map((situation) => {
      const cellule = situation.cellules.find((c) => c.mois === moisCourant);
      const echeanceDuJour =
        cellule && (cellule.statut === "a_venir" || cellule.statut === "retard") ? moisCourant : null;
      const avance = avances.find((a) => a.membreId === situation.membreId);
      return {
        situation,
        arrieres: situation.moisEnRetard.filter((m) => m !== moisCourant),
        echeanceDuJour,
        avanceManquante: avance && !avance.respectee ? avance : null,
      };
    })
    .filter(
      (d) =>
        d.arrieres.length > 0 ||
        d.echeanceDuJour !== null ||
        d.situation.nbPenalitesImpayees > 0 ||
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
  const siteUrl = variable("NEXT_PUBLIC_SITE_URL", "");
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
export function joursAvantEcheance(maintenant: Date): number {
  return REGLES.jourEcheance - maintenant.getUTCDate();
}

/*
 * L'objet nomme le motif le plus grave. Une mesure disciplinaire assortie d'une
 * date prime sur un simple rappel d'echeance : c'est elle qu'il faut lire.
 */
export function sujetRelance(d: Destinataire, moisCourant: string, maintenant: Date): string {
  if (d.avanceManquante) return `${CLUB.sigle} — avance obligatoire non constituee`;
  if (d.arrieres.length > 0) return `${CLUB.sigle} — versement en retard (${d.arrieres.length} mois)`;
  if (d.situation.nbPenalitesImpayees > 0) {
    return `${CLUB.sigle} — ${d.situation.nbPenalitesImpayees} penalite(s) de retard impayee(s)`;
  }
  const reste = joursAvantEcheance(maintenant);
  return reste > 0
    ? `${CLUB.sigle} — versement ${deMois(moisCourant)} attendu le ${REGLES.jourEcheance}`
    : `${CLUB.sigle} — votre versement ${deMois(moisCourant)} est du aujourd'hui`;
}

export function texteRelance(
  { situation, arrieres, echeanceDuJour, avanceManquante }: Destinataire,
  siteUrl: string,
  maintenant: Date,
): string {
  // Le blanc qui suit l'appel n'a de sens que s'il precede un paragraphe.
  const lignes: string[] = [`Bonjour ${situation.nom},`];

  if (echeanceDuJour) {
    const reste = joursAvantEcheance(maintenant);
    lignes.push(
      "",
      reste > 0
        ? `Votre versement de ${fcfa(REGLES.cotisationMensuelle)} pour ` +
          `${moisLong(echeanceDuJour)} est attendu au plus tard le ${REGLES.jourEcheance} ` +
          `(art. 8) : il vous reste ${reste} jour${reste > 1 ? "s" : ""}.`
        : `Votre versement de ${fcfa(REGLES.cotisationMensuelle)} pour ` +
          `${moisLong(echeanceDuJour)} est du aujourd'hui, dernier jour de l'echeance ` +
          "statutaire (art. 8).",
    );
  }

  if (arrieres.length > 0) {
    lignes.push(
      "",
      "Versements encore manquants :",
      arrieres.map((m) => `  - ${moisLong(m)}`).join("\n"),
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
  if (situation.nbPenalitesImpayees > 0) {
    const seuil = REGLES.penalitesImpayeesAvantExclusion;
    const effet = EFFET.penalitesIndissociables;
    const enVigueur = maintenant.toISOString().slice(0, 10) >= effet;

    lignes.push("");
    /*
     * Le total des penalites a deja ete dit plus haut a qui a des arrieres :
     * le repeter donnerait deux chiffres identiques a trois lignes d'intervalle,
     * et ferait douter qu'ils parlent de la meme chose.
     */
    lignes.push(
      arrieres.length > 0
        ? `Ces penalites sont au nombre de ${situation.nbPenalitesImpayees}, toutes impayees.`
        : `Penalites de retard impayees : ${situation.nbPenalitesImpayees}, pour un total de ` +
          `${fcfa(situation.totalPenalites)}.`,
    );

    /*
     * La regle ne mord qu'a sa date d'effet. Annoncer une exclusion « encourue de
     * plein droit depuis » une date a venir serait faux, et alarmerait a tort.
     */
    if (situation.nbPenalitesImpayees >= seuil && enVigueur) {
      lignes.push(
        `Ce nombre atteint le seuil de ${seuil} fixe par l'assemblee : les penalites etant ` +
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
        `A partir de ${seuil} penalites impayees, l'exclusion sera encourue de plein droit ` +
          `(R5) meme cotisations a jour — regle applicable le ${dateCourte(effet)}.`,
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

  if (siteUrl) lignes.push("", `Regulariser : ${siteUrl}`);
  /*
   * La date distingue les passages du mois. Trois courriers au texte identique
   * sont replies par la messagerie sous « messages precedents masques », et le
   * dernier parait vide -- l'ecueil deja rencontre sur les courriers d'essai.
   */
  lignes.push("", `Relance du ${dateCourte(maintenant.toISOString().slice(0, 10))}.`);
  lignes.push("", `Le bureau — ${CLUB.nom}`);
  return lignes.join("\n");
}
