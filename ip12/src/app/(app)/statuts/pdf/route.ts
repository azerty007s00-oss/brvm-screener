import { NextResponse } from "next/server";
import { membreCourant } from "@/lib/auth";
import { pdfDesStatuts } from "@/lib/statuts-base";

export const dynamic = "force-dynamic";

/** Le PDF signe des statuts, pour les seuls membres connectes (art. 5). */
export async function GET(requete: Request) {
  if (!(await membreCourant())) return NextResponse.redirect(new URL("/login", requete.url));
  const pdf = await pdfDesStatuts();
  if (!pdf) return new NextResponse("Les statuts ne sont pas encore importés.", { status: 404 });
  return new NextResponse(new Uint8Array(pdf.octets), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="statuts-ip12.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
