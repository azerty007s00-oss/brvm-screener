import "server-only";
import { db } from "./db";

/** Types acceptes : photo de recu ou de transfert, ou bordereau en PDF. */
export const MIMES_JUSTIFICATIF = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

/** Plafond par fichier. Les photos sont reduites cote navigateur avant l'envoi. */
export const TAILLE_MAX_JUSTIFICATIF = 3 * 1024 * 1024;

export type Justificatif = {
  id: string;
  lot: string;
  membre_id: string;
  nom: string;
  mime: string;
  taille: number;
  depose_par: string | null;
  created_at: string;
};

/**
 * Enregistre le justificatif joint a une declaration, s'il y en a un.
 *
 * Le contenu arrive en base64 depuis le formulaire et Postgres le decode :
 * le pilote HTTP de Neon ne transporte pas d'octets bruts, et `decode()` evite
 * d'avoir a monter un stockage externe pour quelques photos par mois.
 *
 * Ne leve jamais : un justificatif refuse ne doit pas annuler le versement, qui
 * lui est bien reel. La declaration reste, le justificatif se rejoint apres coup.
 */
export async function enregistrerJustificatif(
  donnees: FormData,
  lot: string,
  membreId: string,
  deposePar: string,
): Promise<{ joint: boolean; motif?: string }> {
  const b64 = String(donnees.get("justificatif_b64") ?? "");
  if (!b64) return { joint: false };

  const nom = String(donnees.get("justificatif_nom") ?? "justificatif").slice(0, 200);
  const mime = String(donnees.get("justificatif_mime") ?? "");
  if (!MIMES_JUSTIFICATIF.includes(mime as (typeof MIMES_JUSTIFICATIF)[number])) {
    return { joint: false, motif: "format non accepte" };
  }

  // Longueur reelle des octets, deduite de l'encodage base64.
  const remplissage = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const taille = Math.floor((b64.length * 3) / 4) - remplissage;
  if (taille <= 0) return { joint: false, motif: "fichier vide" };
  if (taille > TAILLE_MAX_JUSTIFICATIF) return { joint: false, motif: "fichier trop lourd" };

  try {
    const sql = db();
    await sql`
      insert into payment_proofs (batch_id, member_id, filename, mime, byte_size, data, uploaded_by)
      values (${lot}::uuid, ${membreId}::uuid, ${nom}, ${mime}, ${taille},
              decode(${b64}, 'base64'), ${deposePar}::uuid)
    `;
    return { joint: true };
  } catch {
    return { joint: false, motif: "enregistrement impossible" };
  }
}

/** Justificatifs de tous les versements, indexes par lot. */
export async function justificatifsParLot(): Promise<Map<string, Justificatif[]>> {
  const index = new Map<string, Justificatif[]>();
  try {
    const sql = db();
    const rows = await sql`
      select p.id, p.batch_id as lot, p.member_id as membre_id, p.filename as nom,
             p.mime, p.byte_size as taille, m.full_name as depose_par,
             to_char(p.created_at, 'YYYY-MM-DD') as created_at
      from payment_proofs p
      left join members m on m.id = p.uploaded_by
      order by p.created_at
    `;
    for (const r of rows as Justificatif[]) {
      const lot = String(r.lot);
      if (!index.has(lot)) index.set(lot, []);
      index.get(lot)!.push(r);
    }
  } catch {
    // Table absente ou illisible : la page s'affiche sans les vignettes.
  }
  return index;
}

/** Contenu d'un justificatif, pour la route qui le sert. */
export async function contenuJustificatif(
  id: string,
): Promise<{ mime: string; nom: string; octets: Buffer } | null> {
  const sql = db();
  const rows = await sql`
    select mime, filename, encode(data, 'base64') as b64
    from payment_proofs where id = ${id}::uuid
  `;
  const r = rows[0];
  if (!r || !r.b64) return null;
  return {
    mime: String(r.mime),
    nom: String(r.filename),
    octets: Buffer.from(String(r.b64), "base64"),
  };
}
