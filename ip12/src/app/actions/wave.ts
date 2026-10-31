"use server";

import { revalidatePath } from "next/cache";
import { exigerMembre } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { METHODE } from "@/lib/valeurs";
import { lireNumero, numeroEnClair, referenceWave } from "@/lib/wave";
import { enregistrerNumeroWave, numeroWaveDe } from "@/lib/wave-membres";
import { declarerVersement } from "./versements";
import type { EtatFormulaire } from "./auth";

/** Le membre donne, ou corrige, son numero Wave. */
export async function enregistrerMonNumeroWave(_precedent: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const membre = await exigerMembre();
  const numero = lireNumero(String(donnees.get("numero") ?? ""));
  if (!numero) {
    return { ok: false, erreur: "Numéro illisible : écrivez-le comme dans Wave, par exemple 07 08 12 34 56, ou avec l'indicatif +225." };
  }
  await enregistrerNumeroWave(membre.id, numero);
  await journaliser({ id: membre.id, nom: membre.nom }, "numero_wave", { entite: "member_wave", id: membre.id });
  revalidatePath("/", "layout");
  return { ok: true, message: `Numéro Wave enregistré : ${numeroEnClair(numero)}.` };
}

/**
 * « J'ai paye » : la declaration d'une cotisation envoyee par Wave, deja
 * remplie. Elle passe par la declaration ordinaire (memes regles, meme
 * circuit, meme validation du tresorier) ; seuls le mode et la reference
 * sont fixes ici, la reference portant le numero d'ou l'argent est parti.
 *
 * Un membre qui n'avait pas encore donne son numero le donne ainsi : celui
 * qu'il vient d'utiliser devient le sien.
 */
export async function declarerPaiementWave(precedent: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const membre = await exigerMembre();
  const numero = lireNumero(String(donnees.get("depuis") ?? ""));
  if (!numero) {
    return { ok: false, erreur: "Indiquez le numéro Wave d'où vous avez envoyé l'argent, par exemple 07 08 12 34 56." };
  }

  const declaration = new FormData();
  declaration.set("nature", "cotisation");
  declaration.set("montant", String(donnees.get("montant") ?? ""));
  declaration.set("dateVersement", new Date().toISOString().slice(0, 10));
  declaration.set("mode", METHODE.mobileMoney);
  declaration.set("reference", referenceWave(numero));
  /* La capture est facultative : le numero suffit au tresorier pour retrouver l'envoi. */
  for (const champ of ["justificatif_b64", "justificatif_nom", "justificatif_mime"]) {
    const valeur = donnees.get(champ);
    if (typeof valeur === "string" && valeur !== "") declaration.set(champ, valeur);
  }

  const retour = await declarerVersement(precedent, declaration);
  if (retour.ok && !(await numeroWaveDe(membre.id).catch(() => null))) {
    await enregistrerNumeroWave(membre.id, numero).catch(() => null);
  }
  return retour;
}
