import { variable } from "@/lib/settings";

/*
 * Vercel renseigne ces variables lui-meme, a la construction comme a
 * l'execution : elles decrivent la revision reellement deployee.
 *
 * Sans ce repere, une fonctionnalite absente de l'ecran ne se distingue pas
 * d'un deploiement reste en arriere -- et l'on cherche dans le code un defaut
 * qui n'y est pas.
 */
export type Version = {
  /** Les sept premiers caracteres du commit deploye, ou null hors Vercel. */
  revision: string | null;
  /** La branche d'ou vient le deploiement. */
  branche: string | null;
  /** Le depot d'ou vient le deploiement, `proprietaire/nom`. */
  depot: string | null;
  /** Le titre du commit deploye, tel que Vercel le transmet. */
  titre: string | null;
};

function depot(): string | null {
  const proprietaire = variable("VERCEL_GIT_REPO_OWNER", "");
  const nom = variable("VERCEL_GIT_REPO_SLUG", "");
  return nom === "" ? null : proprietaire === "" ? nom : `${proprietaire}/${nom}`;
}

export function versionDeployee(): Version {
  const sha = variable("VERCEL_GIT_COMMIT_SHA", "");
  return {
    revision: sha === "" ? null : sha.slice(0, 7),
    branche: variable("VERCEL_GIT_COMMIT_REF", "") || null,
    depot: depot(),
    titre: variable("VERCEL_GIT_COMMIT_MESSAGE", "").split("\n")[0] || null,
  };
}
