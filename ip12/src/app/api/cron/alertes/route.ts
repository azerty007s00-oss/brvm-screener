import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { debutMois, deMois, fcfa, variable } from "@/lib/settings";
import { reglagesEffectifs, situationsClub } from "@/lib/queries";
import { envoyerAlertes } from "@/lib/alertes";
import { passageSerie } from "@/lib/serie-alertes";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * L'alerte de la veille de l'echeance, chaque soir a 18 h.
 *
 * Le passage est quotidien et ne fait rien les autres jours : la date de
 * l'echeance est un reglage du president (art. 8), et un horaire fige au 9 se
 * tromperait le jour ou elle changerait. N'est prevenu que qui doit encore
 * quelque chose sur le mois en cours ; un versement declare et en attente de
 * visa compte comme fait.
 *
 * L'alerte double la relance du 9 sans la remplacer : le courrier reste la
 * trace, l'alerte est ce qu'on voit en sortant du travail.
 */
export async function GET(requete: Request) {
  /* Meme garde que la relance : sans secret, personne ne declenche rien. */
  const attendu = variable("CRON_SECRET", "");
  if (attendu === "") {
    return NextResponse.json({ erreur: "CRON_SECRET n'est pas définie : alertes désactivées." }, { status: 503 });
  }
  const fourni = Buffer.from(requete.headers.get("authorization") ?? "");
  const reference = Buffer.from(`Bearer ${attendu}`);
  if (fourni.length !== reference.length || !timingSafeEqual(fourni, reference)) {
    return NextResponse.json({ erreur: "Non autorisé" }, { status: 401 });
  }

  /* Une horloge choisie, pour les essais seulement : la variable n'existe pas en production. */
  const horloge = variable("HORLOGE_DE_TEST", "") === "1" ? requete.headers.get("x-horloge") : null;
  const maintenant = horloge ? new Date(horloge) : new Date();
  /* La serie de ponctualite : trois jours avant, le jour meme, et le lendemain de l'echeance. */
  const serie = await passageSerie(maintenant).catch(() => null);
  const demain = new Date(maintenant.getTime() + 86_400_000);
  const reglages = await reglagesEffectifs();
  if (demain.getUTCDate() !== reglages.jourEcheance) {
    return NextResponse.json({ rien: true, echeance: reglages.jourEcheance, demain: demain.getUTCDate(), serie });
  }

  const mois = debutMois(maintenant);
  const situations = await situationsClub();
  let envoyees = 0;
  let concernes = 0;
  for (const x of situations) {
    const c = x.cellules.find((m) => m.mois === mois);
    if (!c || c.statut === "hors_periode" || c.statut === "en_attente" || c.manque <= 0) continue;
    concernes++;
    /* Une part rachetee non fusionnee : c'est son detenteur qui recoit l'alerte. */
    const personne = x.titulaireId ?? x.membreId;
    const de = x.titulaireId ? ` pour la part de ${x.nom}` : "";
    const bilan = await envoyerAlertes([personne], {
      titre: "Échéance demain",
      corps: `Votre cotisation ${deMois(mois)}${de} (${fcfa(c.manque)}) est attendue le ${reglages.jourEcheance}. Touchez pour la déclarer.`,
      corpsVoile: `Votre cotisation ${deMois(mois)}${de} est attendue le ${reglages.jourEcheance}. Touchez pour la déclarer.`,
      url: "/versements",
      etiquette: `echeance-${mois}`,
    });
    envoyees += bilan.envoyees;
  }
  return NextResponse.json({ mois, concernes, envoyees, serie });
}
