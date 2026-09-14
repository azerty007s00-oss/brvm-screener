import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { debutMois } from "@/lib/settings";
import { destinatairesDuJour, envoyerRelances } from "@/lib/relance";
import { avertirLeBureau } from "@/lib/avis";
import { transportConfigure } from "@/lib/courriel";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Relance des retardataires, declenchee par le cron Vercel le 10 de chaque mois.
 *
 * Le courrier part le matin du 10, alors que l'art. 8 laisse jusqu'a la fin de
 * cette journee pour payer : le mois courant n'est donc pas encore en retard. On
 * le rappelle quand meme, mais comme echeance du jour et sans penalite -- c'est le
 * sens d'une relance.
 *
 * La fabrique des courriers vit dans `lib/relance` : le bureau peut declencher la
 * meme relance a la main, et les deux doivent dire exactement la meme chose.
 *
 * L'envoi est facultatif : sans transport configure, le site continue d'afficher
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
   * reclame. Sans ce recapitulatif il devrait ouvrir le site pour savoir ce qui
   * l'attend -- et le 10 est precisement le jour ou il ne faut pas l'oublier.
   */
  const avis = await avertirLeBureau(destinataires, maintenant);

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
    bureauAverti: avis,
    transport: transportConfigure(),
  });
}
