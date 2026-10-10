import { neon } from "@neondatabase/serverless";

/**
 * Connexion Postgres (Neon) via HTTP : pas de pool a gerer, adapte au serverless Vercel.
 * L'URL vit dans la variable d'environnement DATABASE_URL, jamais dans le depot.
 */
function connexion() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL absente. Renseignez-la dans .env.local en local, " +
        "ou dans Settings > Environment Variables sur Vercel.",
    );
  }
  return neon(url);
}

let memo: ReturnType<typeof connexion> | null = null;

export function db() {
  if (!memo) memo = connexion();
  return memo;
}

/** true si la base est configuree : permet d'afficher un ecran d'aide plutot qu'une erreur brute. */
export function baseConfiguree(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
