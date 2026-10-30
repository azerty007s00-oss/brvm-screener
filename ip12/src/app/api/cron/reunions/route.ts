import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { variable } from "@/lib/settings";
import { passageQuotidien } from "@/lib/sondage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Le passage du soir, a 21 h, pour le sondage de date de reunion.
 *
 * Il ouvre le sondage le 3 du mois de reunion, relance la veille de la
 * cloture ceux qui n'ont pas repondu, clot le 9 apres 20 h et sollicite le
 * president le soir meme, le rappelle une fois s'il n'a pas valide, et
 * previent tout le monde la veille de la seance. Les autres jours, il ne
 * fait rien.
 */
export async function GET(requete: Request) {
  /* Meme garde que la relance : sans secret, personne ne declenche rien. */
  const attendu = variable("CRON_SECRET", "");
  if (attendu === "") {
    return NextResponse.json({ erreur: "CRON_SECRET n'est pas définie : sondage désactivé." }, { status: 503 });
  }
  const fourni = Buffer.from(requete.headers.get("authorization") ?? "");
  const reference = Buffer.from(`Bearer ${attendu}`);
  if (fourni.length !== reference.length || !timingSafeEqual(fourni, reference)) {
    return NextResponse.json({ erreur: "Non autorisé" }, { status: 401 });
  }

  /*
   * Une horloge choisie, pour les essais seulement : la variable n'existe
   * pas en production, ou l'en-tete est alors ignore.
   */
  const horloge = variable("HORLOGE_DE_TEST", "") === "1" ? requete.headers.get("x-horloge") : null;
  const maintenant = horloge ? new Date(horloge) : new Date();
  if (Number.isNaN(maintenant.getTime())) return NextResponse.json({ erreur: "Horloge invalide" }, { status: 400 });

  return NextResponse.json(await passageQuotidien(maintenant));
}
