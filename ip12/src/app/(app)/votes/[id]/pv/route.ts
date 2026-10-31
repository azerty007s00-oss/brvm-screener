import { NextResponse } from "next/server";
import { membreCourant } from "@/lib/auth";
import { bulletinsDes, electeursDu, voteParId } from "@/lib/votes";
import { STATUT_VOTE, depouiller } from "@/lib/scrutin";
import { pvVotePdf } from "@/lib/pv-vote";

export const dynamic = "force-dynamic";

/** Le proces-verbal d'un vote clos, pour tout membre connecte. */
export async function GET(requete: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await membreCourant())) return NextResponse.redirect(new URL("/login", requete.url));
  const { id } = await params;
  const v = await voteParId(id).catch(() => null);
  if (!v || v.statut === STATUT_VOTE.annule || (v.statut === STATUT_VOTE.ouvert && new Date() < v.cloture)) {
    return new NextResponse("Procès-verbal indisponible : le vote n'est pas clos.", { status: 404 });
  }
  const [electeurs, bulletins] = await Promise.all([electeursDu(v), bulletinsDes([v.id])]);
  const pdf = pvVotePdf({
    question: v.question,
    details: v.details,
    majorite: v.majorite,
    auteur: v.auteurNom,
    ouvertLe: v.creeLe.toISOString().slice(0, 10),
    closLe: (v.closLe ?? v.cloture).toISOString().slice(0, 10),
    vise: v.viseNom,
    electeurs,
    bulletins,
    resultat: depouiller(electeurs, bulletins, v.majorite),
  });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="pv-vote-ip12-${(v.closLe ?? v.cloture).toISOString().slice(0, 10)}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
