import { NextResponse } from "next/server";
import { membreCourant } from "@/lib/auth";
import { fichierIcs } from "@/lib/agenda";
import { invitationReunion, sondageParId } from "@/lib/sondage";

export const dynamic = "force-dynamic";

/**
 * La reunion fixee, en fichier d'agenda : l'iPhone l'ouvre sur « Ajouter au
 * calendrier ». Un evenement a ajouter (PUBLISH), et non une invitation : il
 * n'y a personne a qui repondre depuis la page.
 */
export async function GET(requete: Request) {
  if (!(await membreCourant())) return NextResponse.redirect(new URL("/login", requete.url));
  const id = new URL(requete.url).searchParams.get("s") ?? "";
  const s = /^[0-9a-f-]{36}$/i.test(id) ? await sondageParId(id) : null;
  const invitation = s ? invitationReunion(s, null, new Date()) : null;
  if (!s || !invitation) return new NextResponse("Réunion introuvable.", { status: 404 });
  return new NextResponse(fichierIcs(invitation), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="reunion-ip12-${s.jourChoisi}.ics"`,
      "cache-control": "private, no-store",
    },
  });
}
