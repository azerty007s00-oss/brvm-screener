import "server-only";
import { db } from "./db";

/** Trace une action du bureau. Ne doit jamais faire echouer l'action metier. */
export async function journaliser(
  membreId: number | null,
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    const sql = db();
    await sql`insert into journal (membre_id, action, details) values (${membreId}, ${action}, ${JSON.stringify(details)}::jsonb)`;
  } catch {
    // Le journal est un confort, pas une condition de validite.
  }
}
