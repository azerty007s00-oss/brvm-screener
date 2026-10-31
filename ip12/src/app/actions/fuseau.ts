"use server";

import { membreCourant } from "@/lib/auth";
import { fuseauValide } from "@/lib/fuseaux";
import { noterFuseauMembre } from "@/lib/fuseau-membres";

/**
 * Le navigateur du membre donne son fuseau (« Europe/Paris ») : la
 * convocation lui dira l'heure de la reunion chez lui. Rien n'est demande au
 * membre, et un echec ne se voit pas : l'heure reste dite en GMT.
 */
export async function noterFuseau(fuseau: string): Promise<boolean> {
  const membre = await membreCourant();
  if (!membre || typeof fuseau !== "string" || !fuseauValide(fuseau)) return false;
  try {
    await noterFuseauMembre(membre.id, fuseau);
    return true;
  } catch {
    return false;
  }
}
