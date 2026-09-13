import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { situationsClub, type SituationClub } from "@/lib/queries";
import { CLUB, REGLES, debutMois, fcfa, moisLong } from "@/lib/settings";

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
 * L'envoi d'e-mail est facultatif : sans RESEND_API_KEY le site continue d'afficher
 * les alertes, seul le courrier ne part pas.
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
  const cle = process.env.RESEND_API_KEY;

  if (cle && destinataires.length > 0) {
    const { Resend } = await import("resend");
    const resend = new Resend(cle);
    const expediteur = process.env.EMAIL_EXPEDITEUR ?? "onboarding@resend.dev";
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";

    for (const d of destinataires) {
      try {
        await resend.emails.send({
          from: `${CLUB.nom} <${expediteur}>`,
          to: d.situation.email,
          subject:
            d.arrieres.length > 0
              ? `${CLUB.sigle} — versement en retard (${d.arrieres.length} mois)`
              : `${CLUB.sigle} — votre versement de ${moisLong(moisCourant)} est du aujourd'hui`,
          text: texteRelance(d, siteUrl),
        });
        envoyes.push(d.situation.email);
      } catch {
        echecs.push(d.situation.email);
      }
    }
  }

  try {
    const sql = db();
    await sql`
      insert into relances (mois_concerne, destinataires, detail)
      values (${moisCourant}::date, ${envoyes.length},
              ${JSON.stringify({ envoyes, echecs, concernes: destinataires.length })})
      on conflict (mois_concerne) do update
        set envoye_le = now(), destinataires = excluded.destinataires, detail = excluded.detail
    `;
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
    emailActif: Boolean(cle),
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
