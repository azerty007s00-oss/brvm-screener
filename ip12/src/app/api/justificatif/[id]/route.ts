import { membreCourant } from "@/lib/auth";
import { contenuJustificatif } from "@/lib/justificatifs";

export const dynamic = "force-dynamic";

/**
 * Sert un justificatif. Reserve aux membres connectes : ces pieces montrent des
 * references de transfert et des noms, elles n'ont rien a faire en acces libre.
 */
export async function GET(_requete: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await membreCourant())) {
    return new Response("Connexion requise.", { status: 401 });
  }

  const { id } = await params;
  let piece;
  try {
    piece = await contenuJustificatif(id);
  } catch {
    return new Response("Justificatif illisible.", { status: 500 });
  }
  if (!piece) return new Response("Justificatif introuvable.", { status: 404 });

  return new Response(new Uint8Array(piece.octets), {
    headers: {
      "content-type": piece.mime,
      "content-disposition": `inline; filename="${piece.nom.replace(/"/g, "")}"`,
      "cache-control": "private, max-age=3600",
    },
  });
}
