import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { situationsClub, type SituationClub } from "@/lib/queries";
import { CLUB, REGLES, debutMois, fcfa, moisLong, variable } from "@/lib/settings";
import { envoyerCourriel, transportConfigure } from "@/lib/courriel";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Destinataire = {
  situation: SituationClub;
  /** Mois echus et impayes : penalisables (art. 9). */
  arrieres: string[];
  /** Mois courant non encore couvert : echeance du jour, pas encore penalisable. */
  echeanceDuJour: string | null;
};

/**
 * Relance des retardataires, declenchee par le cron Vercel le 10 de chaque mois.
 *
 * Le courrier part le matin du 10, alors que l'art. 8 laisse jusqu'a la fin de cette
 * journee pour payer : le mois courant n'est donc pas encore en retard. On le rappelle
 * quand meme, mais comme echeance du jour et sans penalite -- c'est le sens d'une relance.
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

  const destinataires: Destinataire[] = situations
    .map((situation) => {
      const cellule = situation.cellules.find((c) => c.mois === moisCourant);
      const echeanceDuJour =
        cellule && (cellule.statut === "a_venir" || cellule.statut === "retard") ? moisCourant : null;
      return {
        situation,
        arrieres: situation.moisEnRetard.filter((m) => m !== moisCourant),
        echeanceDuJour,
      };
    })
    .filter((d) => d.arrieres.length > 0 || d.echeanceDuJour !== null);

  const envoyes: string[] = [];
  const echecs: string[] = [];
  const transport = transportConfigure();

  if (transport !== "aucun") {
    const siteUrl = variable("NEXT_PUBLIC_SITE_URL", "");
    for (const d of destinataires) {
      const { ok: parti } = await envoyerCourriel({
        destinataire: d.situation.email,
        sujet:
          d.arrieres.length > 0
            ? `${CLUB.sigle} — versement en retard (${d.arrieres.length} mois)`
            : `${CLUB.sigle} — votre versement de ${moisLong(moisCourant)} est du aujourd'hui`,
        texte: texteRelance(d, siteUrl),
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
    emailsEnvoyes: envoyes.length,
    echecs: echecs.length,
    transport,
  });
}

function texteRelance({ situation, arrieres, echeanceDuJour }: Destinataire, siteUrl: string): string {
  const lignes: string[] = [`Bonjour ${situation.nom},`, ""];

  if (echeanceDuJour) {
    lignes.push(
      `Votre versement de ${fcfa(REGLES.cotisationMensuelle)} pour ${moisLong(echeanceDuJour)} ` +
        `est du aujourd'hui, dernier jour de l'echeance statutaire (art. 8).`,
      "",
    );
  }

  if (arrieres.length > 0) {
    lignes.push(
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

  if (siteUrl) lignes.push("", `Regulariser : ${siteUrl}`);
  lignes.push("", `Le bureau — ${CLUB.nom}`);
  return lignes.join("\n");
}
