import { Alerte, Carte } from "./ui";

/**
 * Affiche a la place d'une page quand la base repond mais que les tables n'existent pas
 * encore. Evite une erreur 500 opaque au premier deploiement.
 */
export function EcranInitialisation({ detail }: { detail?: string }) {
  return (
    <Carte titre="Base non initialisee">
      <Alerte ton="ambre">
        La connexion a Postgres fonctionne, mais les tables du club n&apos;existent pas encore.
      </Alerte>
      <ol className="mt-4 space-y-2 text-sm">
        <li>
          1. Ouvrez la console Neon, onglet <strong>SQL Editor</strong>.
        </li>
        <li>
          2. Collez-y le contenu du fichier <code>scripts/schema.sql</code> du depot, puis executez.
        </li>
        <li>
          3. Appelez une fois <code>/api/bootstrap?token=VOTRE_SETUP_TOKEN</code> pour creer le compte
          president. Les 9 autres profils se creent ensuite depuis la page Membres.
        </li>
        <li>4. Rechargez cette page.</li>
      </ol>
      {detail && (
        <p className="mt-4 text-xs" style={{ color: "var(--discret)" }}>
          Detail technique : {detail}
        </p>
      )}
    </Carte>
  );
}

/** Vrai quand l'erreur Postgres signale une table absente (code 42P01). */
export function estTableAbsente(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /relation .* does not exist|42P01/i.test(message);
}
