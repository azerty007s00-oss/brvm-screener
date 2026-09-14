import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { debutMois, variable } from "@/lib/settings";
import {
  dejaRelancesAujourdhui,
  destinatairesDuJour,
  envoyerRelances,
  joursAvantEcheance,
  tracerRelances,
} from "@/lib/relance";
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

  /*
   * Qui a deja recu la relance du jour n'est pas relance une seconde fois. Le
   * registre fait foi : c'est la seule memoire qui survive a un redemarrage.
   * En cas d'echec de lecture on n'ecrit a personne -- deux courriers valent
   * pire qu'un courrier en retard, et le passage suivant rattrapera.
   */
  let dejaVus: Set<string>;
  try {
    dejaVus = await dejaRelancesAujourdhui(maintenant);
  } catch (e) {
    return NextResponse.json(
      { erreur: `Registre des relances illisible, aucun courrier envoye : ${String(e)}` },
      { status: 500 },
    );
  }
  const aRelancer = destinataires.filter((d) => !dejaVus.has(d.situation.membreId));
  const ignores = destinataires.length - aRelancer.length;

  const { envoyes, echecs } = await envoyerRelances(aRelancer, maintenant);

  try {
    await tracerRelances(aRelancer, envoyes, maintenant);
  } catch {
    // La trace de relance ne doit pas faire echouer le traitement.
  }

  /*
   * Le tresorier tient la caisse : c'est lui qui encaisse ce que la relance
   * reclame. Le recapitulatif ne part qu'au jour de l'echeance : les passages
   * anterieurs sont des rappels adresses aux membres, et trois courriers par
   * mois au bureau useraient l'attention qu'on veut obtenir le 10.
   */
  /*
   * Le recapitulatif suit le meme sort : il ne part que si au moins une relance
   * nouvelle est partie ce jour. Un second passage le meme jour ne relance
   * personne, donc n'a rien de neuf a resumer. Le detail, lui, porte sur tous
   * les concernes et pas seulement sur les nouveaux : c'est l'etat de la caisse
   * que le tresorier lit, pas la liste des courriers.
   */
  const jourDEcheance = joursAvantEcheance(maintenant) <= 0;
  const avis =
    jourDEcheance && aRelancer.length > 0 ? await avertirLeBureau(destinataires, maintenant) : 0;

  return NextResponse.json({
    mois: moisCourant,
    jour: maintenant.getUTCDate(),
    jourDEcheance,
    concernes: destinataires.length,
    // Deja relances aujourd'hui, donc laisses tranquilles.
    ignores,
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
