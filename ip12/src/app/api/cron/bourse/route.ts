import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { variable } from "@/lib/settings";
import { passageBourse } from "@/lib/bourse-base";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Les cours de la BRVM, chaque soir de semaine a 19 h GMT : brvm.org publie
 * la seance vers 18 h 15. Le portefeuille du club est valorise dans la foulee.
 */
export async function GET(requete: Request) {
  const attendu = variable("CRON_SECRET", "");
  if (attendu === "") {
    return NextResponse.json({ erreur: "CRON_SECRET n'est pas définie : passage désactivé." }, { status: 503 });
  }
  const fourni = Buffer.from(requete.headers.get("authorization") ?? "");
  const reference = Buffer.from(`Bearer ${attendu}`);
  if (fourni.length !== reference.length || !timingSafeEqual(fourni, reference)) {
    return NextResponse.json({ erreur: "Non autorisé" }, { status: 401 });
  }
  try {
    return NextResponse.json(await passageBourse());
  } catch (e) {
    return NextResponse.json({ erreur: String(e) }, { status: 502 });
  }
}
