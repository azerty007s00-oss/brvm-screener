"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerMembre } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { envoyerAlertes, lireAbonnement } from "@/lib/alertes";
import type { EtatFormulaire } from "./auth";

/**
 * Le telephone du membre vient d'accepter les alertes : on garde son adresse.
 *
 * Une meme adresse revient si le membre reactive apres avoir desactive, ou si
 * un autre membre se connecte sur le meme telephone : la ligne passe alors au
 * membre connecte, pour qu'un telephone prete ne recoive pas les alertes de
 * son ancien proprietaire.
 */
export async function abonnerAlertes(brut: string): Promise<EtatFormulaire> {
  const membre = await exigerMembre();
  let abonnement;
  try {
    abonnement = lireAbonnement(JSON.parse(brut));
  } catch {
    abonnement = null;
  }
  if (!abonnement) return { ok: false, erreur: "Le téléphone a renvoyé une adresse que le site ne reconnaît pas." };

  const agent = ((await headers()).get("user-agent") ?? "").slice(0, 300);
  try {
    await db()`
      insert into push_subscriptions (member_id, endpoint, p256dh, auth, user_agent)
      values (${membre.id}::uuid, ${abonnement.endpoint}, ${abonnement.p256dh}, ${abonnement.auth}, ${agent})
      on conflict (endpoint) do update
        set member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth,
            user_agent = excluded.user_agent, failures = 0
    `;
  } catch {
    return { ok: false, erreur: "Les alertes ne sont pas encore en place sur le site : prévenez le président." };
  }
  await journaliser({ id: membre.id, nom: membre.nom }, "alertes_activees", { entite: "push_subscriptions" });
  revalidatePath("/mon-compte");
  return { ok: true, message: "Alertes activées sur ce téléphone." };
}

export async function desabonnerAlertes(endpoint: string): Promise<EtatFormulaire> {
  const membre = await exigerMembre();
  try {
    await db()`delete from push_subscriptions where member_id = ${membre.id}::uuid and endpoint = ${endpoint}`;
  } catch {
    return { ok: false, erreur: "La désactivation n'a pas abouti : réessayez." };
  }
  await journaliser({ id: membre.id, nom: membre.nom }, "alertes_desactivees", { entite: "push_subscriptions" });
  revalidatePath("/mon-compte");
  return { ok: true, message: "Alertes désactivées sur ce téléphone." };
}

/** Une alerte d'essai, pour verifier que tout arrive bien. */
export async function essayerAlerte(): Promise<EtatFormulaire> {
  const membre = await exigerMembre();
  const { envoyees, echecs } = await envoyerAlertes([membre.id], {
    titre: "Essai réussi",
    corps: "Les alertes du club arriveront sur ce téléphone.",
    url: "/mon-compte",
    etiquette: "essai",
  });
  if (envoyees === 0) {
    return {
      ok: false,
      erreur:
        echecs > 0
          ? "Le service de notification du téléphone a refusé l'alerte. Désactivez puis réactivez les alertes."
          : "Aucun téléphone n'est inscrit pour vos alertes.",
    };
  }
  return {
    ok: true,
    message: envoyees > 1 ? `Alerte envoyée sur vos ${envoyees} appareils.` : "Alerte envoyée : elle arrive dans quelques secondes.",
  };
}
