"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  exigerMembre,
  fermerSession,
  hacherMotDePasse,
  membreParEmail,
  ouvrirSession,
  tracerTentative,
  tropDeTentatives,
  verifierMotDePasse,
} from "@/lib/auth";
import { journaliser } from "@/lib/journal";

export type EtatFormulaire = { ok: boolean; erreur?: string; message?: string };

export async function seConnecter(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const email = String(donnees.get("email") ?? "").trim().toLowerCase();
  const motDePasse = String(donnees.get("motDePasse") ?? "");

  if (!email || !motDePasse) {
    return { ok: false, erreur: "Renseignez votre e-mail et votre mot de passe." };
  }

  if (await tropDeTentatives(email)) {
    return {
      ok: false,
      erreur: "Trop de tentatives infructueuses. Reessayez dans un quart d'heure.",
    };
  }

  let membre;
  try {
    membre = await membreParEmail(email);
  } catch {
    return { ok: false, erreur: "La base de donnees n'est pas joignable. Reessayez dans un instant." };
  }

  // Message identique dans les trois cas : ne pas reveler quels e-mails existent.
  const echec = { ok: false as const, erreur: "E-mail ou mot de passe incorrect." };
  if (!membre || !membre.actif || !verifierMotDePasse(motDePasse, membre.password_hash)) {
    await tracerTentative(email, false);
    return echec;
  }

  await tracerTentative(email, true);
  await ouvrirSession(membre.id);
  await journaliser({ id: membre.id, nom: membre.nom }, "connexion");
  redirect("/");
}

export async function seDeconnecter(): Promise<void> {
  await fermerSession();
  redirect("/login");
}

export async function changerMotDePasse(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const membre = await exigerMembre();
  const actuel = String(donnees.get("actuel") ?? "");
  const nouveau = String(donnees.get("nouveau") ?? "");
  const confirmation = String(donnees.get("confirmation") ?? "");

  if (nouveau.length < 8) {
    return { ok: false, erreur: "Le nouveau mot de passe doit faire au moins 8 caracteres." };
  }
  if (nouveau !== confirmation) {
    return { ok: false, erreur: "Les deux saisies ne correspondent pas." };
  }

  const sql = db();
  const rows = await sql`select password_hash from members where id = ${membre.id}::uuid`;

  // Un membre dont le mot de passe est encore provisoire n'a pas a fournir l'ancien.
  if (!membre.must_change_password && !verifierMotDePasse(actuel, rows[0]?.password_hash as string)) {
    return { ok: false, erreur: "Mot de passe actuel incorrect." };
  }

  await sql`
    update members
    set password_hash = ${hacherMotDePasse(nouveau)}, must_change_password = false
    where id = ${membre.id}::uuid
  `;
  await journaliser({ id: membre.id, nom: membre.nom }, "changement_mot_de_passe");
  revalidatePath("/", "layout");
  return { ok: true, message: "Mot de passe mis a jour." };
}
