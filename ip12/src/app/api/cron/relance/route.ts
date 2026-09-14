import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { avancesExigees, situationsClub, type AvanceExigee, type SituationClub } from "@/lib/queries";
import { CLUB, EFFET, REGLES, dateCourte, debutMois, fcfa, moisLong, variable } from "@/lib/settings";
import { envoyerCourriel, transportConfigure } from "@/lib/courriel";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Destinataire = {
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

/**
 * Relance des retardataires, declenchee par le cron Vercel le 10 de chaque mois.
 *
 * Le courrier part le matin du 10, alors que l'art. 8 laisse jusqu'a la fin de cette
 * journee pour payer : le mois courant n'est donc pas encore en retard. On le rappelle
 * quand meme, mais comme echeance du jour et sans penalite -- c'est le sens d'une relance.
 *
 * Trois motifs y conduisent, et non plus un seul :
 *   - l'echeance du jour ou des mois impayes ;
 *   - des penalites impayees, meme cotisations a jour -- depuis que l'assemblee les
 *     a rendues indissociables, ce profil mene a l'exclusion sans qu'aucun mois ne
 *     soit en retard, donc sans qu'aucune relance ne partait ;
 *   - une avance minimale imposee et non tenue.
 *
 * L'envoi d'e-mail est facultatif : sans transport configure -- SMTP ou Resend --
 * le site continue d'afficher les alertes, seul le courrier ne part pas.
 */
export async function GET(requete: Request) {
  const attendu = process.env.CRON_SECRET;
  const recu = requete.headers.get("authorization");
  if (attendu && recu !== `Bearer ${attendu}`) {
    return NextResponse.json({ erreur: "Non autorise" }, { status: 401 });
  }

  const maintenant = new Date();
  const moisCourant = debutMois(maintenant);

  let situations: SituationClub[];
  try {
    situations = await situationsClub(maintenant);
  } catch (e) {
    return NextResponse.json({ erreur: String(e) }, { status: 500 });
  }

  const avances = await avancesExigees(maintenant).catch(() => [] as AvanceExigee[]);

  const destinataires: Destinataire[] = situations
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

  const envoyes: string[] = [];
  const echecs: string[] = [];
  const transport = transportConfigure();

  if (transport !== "aucun") {
    const siteUrl = variable("NEXT_PUBLIC_SITE_URL", "");
    for (const d of destinataires) {
      const { ok: parti } = await envoyerCourriel({
        destinataire: d.situation.email,
        sujet: sujetRelance(d, moisCourant),
        texte: texteRelance(d, siteUrl, maintenant),
      });
      (parti ? envoyes : echecs).push(d.situation.email);
    }
  }

  // reminder_log porte une ligne par membre et par periode : on trace chaque envoi.
  try {
    const sql = db();
    for (const d of destinataires) {
      const reussi = envoyes.includes(d.situation.email);
      await sql`
        insert into reminder_log (period, member_id, channel, ok, error)
        values (${moisCourant}::date, ${d.situation.membreId}::uuid, 'email', ${reussi},
                ${reussi ? null : "envoi impossible"})
      `;
    }
  } catch {
    // La trace de relance ne doit pas faire echouer le traitement.
  }

  return NextResponse.json({
    mois: moisCourant,
    concernes: destinataires.length,
    enRetard: destinataires.filter((d) => d.arrieres.length > 0).length,
    echeanceDuJour: destinataires.filter((d) => d.echeanceDuJour && d.arrieres.length === 0).length,
    // Cotisations a jour, mais penalites en souffrance : le profil vise par l'assemblee.
    penalitesSeules: destinataires.filter(
      (d) => d.arrieres.length === 0 && d.situation.nbPenalitesImpayees > 0,
    ).length,
    avancesNonTenues: destinataires.filter((d) => d.avanceManquante !== null).length,
    emailsEnvoyes: envoyes.length,
    echecs: echecs.length,
    transport,
  });
}

/*
 * L'objet nomme le motif le plus grave. Une mesure disciplinaire assortie d'une
 * date prime sur un simple rappel d'echeance : c'est elle qu'il faut lire.
 */
function sujetRelance(d: Destinataire, moisCourant: string): string {
  if (d.avanceManquante) return `${CLUB.sigle} — avance obligatoire non constituee`;
  if (d.arrieres.length > 0) return `${CLUB.sigle} — versement en retard (${d.arrieres.length} mois)`;
  if (d.situation.nbPenalitesImpayees > 0) {
    return `${CLUB.sigle} — ${d.situation.nbPenalitesImpayees} penalite(s) de retard impayee(s)`;
  }
  return `${CLUB.sigle} — votre versement de ${moisLong(moisCourant)} est du aujourd'hui`;
}

function texteRelance(
  { situation, arrieres, echeanceDuJour, avanceManquante }: Destinataire,
  siteUrl: string,
  maintenant: Date,
): string {
  // Le blanc qui suit l'appel n'a de sens que s'il precede un paragraphe.
  const lignes: string[] = [`Bonjour ${situation.nom},`];

  if (echeanceDuJour) {
    lignes.push(
      "",
      `Votre versement de ${fcfa(REGLES.cotisationMensuelle)} pour ${moisLong(echeanceDuJour)} ` +
        `est du aujourd'hui, dernier jour de l'echeance statutaire (art. 8).`,
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
  lignes.push("", `Le bureau — ${CLUB.nom}`);
  return lignes.join("\n");
}
