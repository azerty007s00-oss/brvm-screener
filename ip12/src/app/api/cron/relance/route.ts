import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { debutMois, variable } from "@/lib/settings";
import { destinatairesDuJour, envoyerRelances, joursAvantEcheance } from "@/lib/relance";
import { avertirLeBureau } from "@/lib/avis";
import { transportConfigure } from "@/lib/courriel";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Relance des retardataires, trois fois par mois : les 7, 9 et 10.
 *
 * Le 10 est le dernier jour de l'echeance statutaire (art. 8) : le courrier part
 * le matin meme, et le mois courant n'est donc pas encore en retard. Les passages
 * des 7 et 9 previennent avant qu'il ne le devienne, en disant combien de jours
 * restent -- une relance qui arrive apres coup ne sert plus a rien.
 *
 * La liste est recalculee a chaque passage : qui a verse le 8 n'est pas relance
 * le 9. C'est la raison d'etre de ces rappels echelonnes.
 *
 * La fabrique des courriers vit dans `lib/relance` : le bureau peut declencher la
 * meme relance a la main, et les deux doivent dire exactement la meme chose.
 *
 * L'envoi est facultatif : sans transport configure, le site continue d'afficher
 * les alertes, seul le courrier ne part pas.
 */
export async function GET(requete: Request) {
  /*
   * Garde fermee par defaut. Sans secret configure, cette route etait appelable
   * par quiconque en connaissait l'adresse : dix membres relances autant de fois
   * que l'appelant le voulait. Refuser d'agir vaut mieux qu'agir pour un inconnu.
   */
  const attendu = variable("CRON_SECRET", "");
  if (attendu === "") {
    return NextResponse.json(
      {
        erreur:
          "CRON_SECRET n'est pas definie : la relance est desactivee pour empecher " +
          "un declenchement par un tiers. Renseignez-la dans les variables " +
          "d'environnement, puis redeployez.",
      },
      { status: 503 },
    );
  }
  const recu = requete.headers.get("authorization") ?? "";
  const fourni = Buffer.from(recu);
  const reference = Buffer.from(`Bearer ${attendu}`);
  if (fourni.length !== reference.length || !timingSafeEqual(fourni, reference)) {
    return NextResponse.json({ erreur: "Non autorise" }, { status: 401 });
  }

  const maintenant = new Date();
  const moisCourant = debutMois(maintenant);

  let destinataires;
  try {
    destinataires = await destinatairesDuJour(maintenant);
  } catch (e) {
    return NextResponse.json({ erreur: String(e) }, { status: 500 });
  }

  const { envoyes, echecs } = await envoyerRelances(destinataires, maintenant);

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

  /*
   * Le tresorier tient la caisse : c'est lui qui encaisse ce que la relance
   * reclame. Le recapitulatif ne part qu'au jour de l'echeance : les passages
   * anterieurs sont des rappels adresses aux membres, et trois courriers par
   * mois au bureau useraient l'attention qu'on veut obtenir le 10.
   */
  const jourDEcheance = joursAvantEcheance(maintenant) <= 0;
  const avis = jourDEcheance ? await avertirLeBureau(destinataires, maintenant) : 0;

  return NextResponse.json({
    mois: moisCourant,
    jour: maintenant.getUTCDate(),
    jourDEcheance,
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
    bureauAverti: avis,
    transport: transportConfigure(),
  });
}
