/**
 * Reconnaitre une table absente.
 *
 * Vit ici, et non dans le composant d'initialisation qui l'affichait, parce que
 * les lectures de `lib/queries` en ont besoin : une bibliotheque de donnees ne
 * doit pas importer un composant d'interface pour savoir lire une erreur de
 * PostgreSQL.
 */
export function estTableAbsente(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /relation .* does not exist|42P01/i.test(message);
}
