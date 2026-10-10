import "server-only";
import { db } from "./db";

/**
 * Trace une action dans audit_log. Le nom de l'auteur est copie a cote de son
 * identifiant : la trace reste lisible meme si le membre est supprime plus tard.
 * Ne doit jamais faire echouer l'action metier.
 */
export async function journaliser(
  acteur: { id: string; nom: string } | null,
  action: string,
  cible?: { entite: string; id?: string },
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    const sql = db();
    await sql`
      insert into audit_log (actor_id, actor_name, action, entity, entity_id, details)
      values (${acteur?.id ?? null}::uuid, ${acteur?.nom ?? null}, ${action},
              ${cible?.entite ?? null}, ${cible?.id ?? null},
              ${JSON.stringify(details)}::jsonb)
    `;
  } catch {
    // Le journal est un confort, pas une condition de validite.
  }
}

export async function journalRecent(limite = 40) {
  const sql = db();
  const rows = await sql`
    select id, action, entity, entity_id, details, actor_name, created_at
    from audit_log
    order by created_at desc
    limit ${limite}
  `;
  return rows as {
    id: number;
    action: string;
    entity: string | null;
    entity_id: string | null;
    details: unknown;
    actor_name: string | null;
    created_at: string;
  }[];
}
