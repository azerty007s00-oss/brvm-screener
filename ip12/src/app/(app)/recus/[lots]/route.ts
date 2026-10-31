import { NextResponse } from "next/server";
import { membreCourant } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { donneesRecu } from "@/lib/recus";
import { recuPdf } from "@/lib/recu";

export const dynamic = "force-dynamic";

/**
 * Le recu PDF d'un versement valide. `lots` : le lot du versement, ou
 * plusieurs separes de virgules quand l'historique les montre en une ligne.
 */
export async function GET(requete: Request, { params }: { params: Promise<{ lots: string }> }) {
  const membre = await membreCourant();
  if (!membre) return NextResponse.redirect(new URL("/login", requete.url));
  const { lots } = await params;
  const d = await donneesRecu(decodeURIComponent(lots).split(","), {
    id: membre.id,
    peutValider: peut(membre, "validerVersement"),
  }).catch(() => null);
  if (!d) return new NextResponse("Reçu introuvable : ce versement n'est pas validé, ou il n'est pas le vôtre.", { status: 404 });
  const pdf = recuPdf(d);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="recu-ip12-${d.numero}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
