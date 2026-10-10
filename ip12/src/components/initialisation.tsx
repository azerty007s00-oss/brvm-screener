import { Alerte, Carte } from "./ui";

/**
 * Affiche a la place d'une page quand Postgres repond mais qu'une table manque.
 * Evite une erreur 500 opaque et oriente vers la cause la plus probable.
 */
export function EcranInitialisation({ detail }: { detail?: string }) {
  const manqueDeclarations = /late_declarations/i.test(detail ?? "");

  return (
    <Carte titre={manqueDeclarations ? "Migration à appliquer" : "Table introuvable"}>
      {manqueDeclarations ? (
        <>
          <Alerte ton="ambre">
            La table des déclarations de retard (R3) n&apos;existe pas encore.
          </Alerte>
          <p className="mt-3 text-sm">
            Exécutez <code>scripts/migration-r3.sql</code> dans le SQL Editor de Neon. Cette
            migration est purement additive : elle ne modifie ni ne supprime aucune table existante.
          </p>
        </>
      ) : (
        <>
          <Alerte ton="rouge">
            La connexion à Postgres fonctionne, mais une table attendue est absente.
          </Alerte>
          <ol className="mt-4 space-y-2 text-sm">
            <li>
              1. Vérifiez que <code>DATABASE_URL</code> pointe bien sur le projet Neon du club et
              non sur une base vide.
            </li>
            <li>
              2. Comparez la structure attendue, décrite dans <code>src/lib/schema-cible.md</code>,
              avec celle de la base.
            </li>
            <li>
              3. Si la table des déclarations R3 manque, appliquez{" "}
              <code>scripts/migration-r3.sql</code>.
            </li>
          </ol>
        </>
      )}
      {detail && (
        <p className="mt-4 text-xs" style={{ color: "var(--discret)" }}>
          Détail technique : {detail}
        </p>
      )}
    </Carte>
  );
}

/** Vrai quand l'erreur Postgres signale une table absente (code 42P01). */
/* Reexporte : la definition vit dans `lib/erreurs`, que `lib/queries` peut lire. */
export { estTableAbsente } from "@/lib/erreurs";
