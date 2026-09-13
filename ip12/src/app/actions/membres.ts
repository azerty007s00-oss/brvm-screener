"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { exigerRole, hacherMotDePasse } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { CLUB } from "@/lib/settings";
import type { EtatFormulaire } from "./auth";

const ROLES_VALIDES = ["president", "tresorier", "membre"] as const;

/** Mot de passe provisoire lisible : 3 groupes de 4, sans caracteres ambigus. */
function motDePasseProvisoire(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const octets = randomBytes(12);
  const brut = Array.from(octets, (o) => alphabet[o % alphabet.length]).join("");
  return `${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8, 12)}`;
}

export async function creerMembre(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const nom = String(donnees.get("nom") ?? "").trim();
  const email = String(donnees.get("email") ?? "").trim().toLowerCase();
  const telephone = String(donnees.get("telephone") ?? "").trim() || null;
  const role = String(donnees.get("role") ?? "membre");
  const dateAdhesion = String(donnees.get("dateAdhesion") ?? CLUB.dateCreation).slice(0, 10);

  if (nom.length < 2) return { ok: false, erreur: "Nom trop court." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, erreur: "E-mail invalide." };
  if (!ROLES_VALIDES.includes(role as (typeof ROLES_VALIDES)[number])) {
    return { ok: false, erreur: "Role inconnu." };
  }

  const sql = db();
  const effectif = await sql`select count(*)::int as c from membres where actif = true`;
  if (Number(effectif[0]?.c ?? 0) >= CLUB.membresMax) {
    return { ok: false, erreur: `Le club est plafonne a ${CLUB.membresMax} membres (statuts).` };
  }

  // Un seul president et un seul tresorier : le poste precedent repasse simple membre.
  if (role === "president" || role === "tresorier") {
    await sql`update membres set role = 'membre' where role = ${role}`;
  }

  const provisoire = motDePasseProvisoire();
  try {
    await sql`
      insert into membres (nom, email, telephone, role, password_hash, must_change_password, date_adhesion)
      values (${nom}, ${email}, ${telephone}, ${role}, ${hacherMotDePasse(provisoire)}, true, ${dateAdhesion}::date)
    `;
  } catch {
    return { ok: false, erreur: "Cet e-mail est deja utilise par un membre." };
  }

  await journaliser(auteur.id, "creation_membre", { nom, email, role });
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `${nom} est cree. Mot de passe provisoire a lui transmettre : ${provisoire} — il lui sera demande de le changer a la premiere connexion.`,
  };
}

export async function modifierMembre(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const id = Number(donnees.get("id"));
  const nom = String(donnees.get("nom") ?? "").trim();
  const email = String(donnees.get("email") ?? "").trim().toLowerCase();
  const telephone = String(donnees.get("telephone") ?? "").trim() || null;
  const role = String(donnees.get("role") ?? "membre");

  if (!Number.isInteger(id)) return { ok: false, erreur: "Membre introuvable." };
  if (nom.length < 2) return { ok: false, erreur: "Nom trop court." };
  if (!ROLES_VALIDES.includes(role as (typeof ROLES_VALIDES)[number])) {
    return { ok: false, erreur: "Role inconnu." };
  }

  const sql = db();
  if (role === "president" || role === "tresorier") {
    await sql`update membres set role = 'membre' where role = ${role} and id <> ${id}`;
  }
  await sql`
    update membres set nom = ${nom}, email = ${email}, telephone = ${telephone}, role = ${role}
    where id = ${id}
  `;
  await journaliser(auteur.id, "modification_membre", { id, nom, role });
  revalidatePath("/", "layout");
  return { ok: true, message: "Membre mis a jour." };
}

export async function reinitialiserMotDePasse(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const id = Number(donnees.get("id"));
  const sql = db();
  const rows = await sql`select nom from membres where id = ${id}`;
  if (rows.length === 0) return { ok: false, erreur: "Membre introuvable." };

  const provisoire = motDePasseProvisoire();
  await sql`
    update membres set password_hash = ${hacherMotDePasse(provisoire)}, must_change_password = true
    where id = ${id}
  `;
  await journaliser(auteur.id, "reinitialisation_mot_de_passe", { id });
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `Nouveau mot de passe provisoire pour ${rows[0].nom} : ${provisoire}`,
  };
}

export async function basculerActivite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const id = Number(donnees.get("id"));
  if (id === auteur.id) return { ok: false, erreur: "Vous ne pouvez pas vous desactiver vous-meme." };

  const sql = db();
  const rows = await sql`
    update membres set actif = not actif where id = ${id} returning nom, actif
  `;
  if (rows.length === 0) return { ok: false, erreur: "Membre introuvable." };
  await journaliser(auteur.id, "bascule_activite", { id, actif: rows[0].actif });
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `${rows[0].nom} est desormais ${rows[0].actif ? "actif" : "inactif"}.`,
  };
}
