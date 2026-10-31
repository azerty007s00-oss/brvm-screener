import { NextResponse } from "next/server";
import { membreCourant } from "@/lib/auth";
import { donneesRapport } from "@/lib/rapport-donnees";
import { nomFichierRapport, rapportPdf } from "@/lib/rapport-reunion";

export const dynamic = "force-dynamic";

/** Le rapport d'une seance en PDF, pour tout membre connecte. */
export async function GET(requete: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await membreCourant())) return NextResponse.redirect(new URL("/login", requete.url));
  const { id } = await params;
  const rapport = /^[0-9a-f-]{36}$/i.test(id) ? await donneesRapport(id) : null;
  if (!rapport) return new NextResponse("Réunion introuvable.", { status: 404 });
  return new NextResponse(new Uint8Array(rapportPdf(rapport.donnees)), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${nomFichierRapport(rapport.donnees.date)}"`,
      "cache-control": "private, no-store",
    },
  });
}
