import "server-only";
import { db } from "./db";
import { estTableAbsente } from "./erreurs";

/**
 * Execute `f`, en creant d'abord les tables qui lui manquent.
 *
 * Pour les tables purement additives que le site installe lui-meme : le
 * president n'a pas de console Neon a ouvrir pour qu'une fonction nouvelle
 * marche. Le texte de chaque table est aussi dans scripts/migration-*.sql,
 * que la verification des requetes applique a sa base d'essai.
 */
export async function avecTables<T>(tables: readonly string[], f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!estTableAbsente(e)) throw e;
    for (const t of tables) await db().query(t);
    return f();
  }
}
