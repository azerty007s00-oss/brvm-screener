"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  exigerMembre,
  fermerSession,
  hacherMotDePasse,
  ouvrirSession,
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

  let rows;
  try {
    const sql = db();
    rows = await sql`
      select id, password_hash, actif from membres where lower(email) = ${email}
    `;
  } catch {
    return { ok: false, erreur: "La base de donnees n'est pas joignable. Reessayez dans un instant." };
  }

  const membre = rows[0];
  // Message identique dans les trois cas : ne pas reveler quels e-mails existent.
  const echec = { ok: false as const, erreur: "E-mail ou mot de passe incorrect." };
  if (!membre || !membre.actif) return echec;
  if (!verifierMotDePasse(motDePasse, membre.password_hash as string | null)) return echec;

  await ouvrirSession(Number(membre.id));
  await journaliser(Number(membre.id), "connexion");
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
  const rows = await sql`select password_hash from membres where id = ${membre.id}`;
  const hash = rows[0]?.password_hash as string | null;

  // Un membre dont le mot de passe est encore provisoire n'a pas a fournir l'ancien.
  if (!membre.must_change_password && !verifierMotDePasse(actuel, hash)) {
    return { ok: false, erreur: "Mot de passe actuel incorrect." };
  }

  await sql`
    update membres
    set password_hash = ${hacherMotDePasse(nouveau)}, must_change_password = false
    where id = ${membre.id}
  `;
  await journaliser(membre.id, "changement_mot_de_passe");
  revalidatePath("/", "layout");
  return { ok: true, message: "Mot de passe mis a jour." };
}
