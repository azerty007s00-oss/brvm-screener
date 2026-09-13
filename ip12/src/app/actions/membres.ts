"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerRole, hacherMotDePasse, motDePasseProvisoire } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { CLUB, POSTES_UNIQUES, ROLES } from "@/lib/settings";
import type { Role } from "@/lib/settings";
import type { EtatFormulaire } from "./auth";

const ROLES_VALIDES = Object.keys(ROLES) as Role[];

export async function creerMembre(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const nom = String(donnees.get("nom") ?? "").trim();
  const email = String(donnees.get("email") ?? "").trim().toLowerCase();
  const telephone = String(donnees.get("telephone") ?? "").trim() || null;
  const titre = String(donnees.get("titre") ?? "").trim() || null;
  const role = String(donnees.get("role") ?? "membre");
  const dateAdhesion = String(donnees.get("dateAdhesion") ?? CLUB.dateCreation).slice(0, 10);

  if (nom.length < 2) return { ok: false, erreur: "Nom trop court." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, erreur: "E-mail invalide." };
  if (!ROLES_VALIDES.includes(role as Role)) {
    return { ok: false, erreur: "Role inconnu." };
  }

  const sql = db();
  const effectif = await sql`select count(*)::int as c from members where is_active = true`;
  if (Number(effectif[0]?.c ?? 0) >= CLUB.membresMax) {
    return { ok: false, erreur: `Le club est plafonne a ${CLUB.membresMax} membres (statuts).` };
  }

  // Poste de bureau : un seul titulaire, le precedent repasse simple membre.
  if (POSTES_UNIQUES.includes(role as Role)) {
    await sql`update members set role = 'membre' where role = ${role}`;
  }

  const provisoire = motDePasseProvisoire();
  try {
    await sql`
      insert into members (full_name, email, phone, title, role, password_hash,
                           must_change_password, joined_on)
      values (${nom}, ${email}, ${telephone}, ${titre}, ${role},
              ${hacherMotDePasse(provisoire)}, true, ${dateAdhesion}::date)
    `;
  } catch {
    return { ok: false, erreur: "Cet e-mail est deja utilise par un membre." };
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "creation_membre",
    { entite: "members" },
    { nom, email, role },
  );
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
  const id = String(donnees.get("id") ?? "");
  const nom = String(donnees.get("nom") ?? "").trim();
  const email = String(donnees.get("email") ?? "").trim().toLowerCase();
  const telephone = String(donnees.get("telephone") ?? "").trim() || null;
  const titre = String(donnees.get("titre") ?? "").trim() || null;
  const role = String(donnees.get("role") ?? "membre");

  if (!id) return { ok: false, erreur: "Membre introuvable." };
  if (nom.length < 2) return { ok: false, erreur: "Nom trop court." };
  if (!ROLES_VALIDES.includes(role as Role)) {
    return { ok: false, erreur: "Role inconnu." };
  }

  const sql = db();
  if (POSTES_UNIQUES.includes(role as Role)) {
    await sql`update members set role = 'membre' where role = ${role} and id <> ${id}::uuid`;
  }
  await sql`
    update members
    set full_name = ${nom}, email = ${email}, phone = ${telephone}, title = ${titre}, role = ${role}
    where id = ${id}::uuid
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "modification_membre",
    { entite: "members", id },
    { nom, role },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Membre mis a jour." };
}

export async function reinitialiserMotDePasse(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const id = String(donnees.get("id") ?? "");
  const sql = db();
  const provisoire = motDePasseProvisoire();
  const rows = await sql`
    update members
    set password_hash = ${hacherMotDePasse(provisoire)}, must_change_password = true
    where id = ${id}::uuid
    returning full_name
  `;
  if (rows.length === 0) return { ok: false, erreur: "Membre introuvable." };

  await journaliser({ id: auteur.id, nom: auteur.nom }, "reinitialisation_mot_de_passe", {
    entite: "members",
    id,
  });
  revalidatePath("/", "layout");
  return { ok: true, message: `Nouveau mot de passe provisoire pour ${rows[0].full_name} : ${provisoire}` };
}

export async function basculerActivite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const id = String(donnees.get("id") ?? "");
  if (id === auteur.id) return { ok: false, erreur: "Vous ne pouvez pas vous desactiver vous-meme." };

  const sql = db();
  const rows = await sql`
    update members set is_active = not is_active where id = ${id}::uuid
    returning full_name, is_active
  `;
  if (rows.length === 0) return { ok: false, erreur: "Membre introuvable." };
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "bascule_activite",
    { entite: "members", id },
    { actif: rows[0].is_active },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: `${rows[0].full_name} est desormais ${rows[0].is_active ? "actif" : "inactif"}.`,
  };
}
