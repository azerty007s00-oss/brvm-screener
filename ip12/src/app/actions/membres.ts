"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerRole, hacherMotDePasse, motDePasseProvisoire } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { envoyerAcces } from "@/lib/avis";
import { CLUB, POSTES_UNIQUES, ROLES, variable } from "@/lib/settings";
import type { Role } from "@/lib/settings";
import type { EtatFormulaire } from "./auth";

const ROLES_VALIDES = Object.keys(ROLES) as Role[];

/*
 * Le courrier d'acces porte le lien du site. Sans NEXT_PUBLIC_SITE_URL, il part
 * quand meme -- l'identifiant et le mot de passe valent d'etre transmis -- mais
 * sans l'adresse, et le destinataire ne sait pas ou aller. Le president doit
 * l'apprendre du message de retour, non d'un membre perdu.
 */
function lienManquant(): string {
  return variable("NEXT_PUBLIC_SITE_URL", "") === ""
    ? " Attention : NEXT_PUBLIC_SITE_URL n'est pas renseignee dans Vercel, le courrier part sans l'adresse du site."
    : "";
}

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

  /* Meme courrier qu'a la reinitialisation : le nouveau venu recoit ses acces. */
  const envoi = await envoyerAcces({ nom, email }, provisoire).catch((e: unknown) => ({
    ok: false,
    detail: String(e),
  }));

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "creation_membre",
    { entite: "members" },
    { nom, email, role, courriel: envoi.ok ? "remis" : `echec : ${envoi.detail}` },
  );
  revalidatePath("/", "layout");

  const rappel = `Mot de passe provisoire : ${provisoire} — il lui sera demande de le changer a la premiere connexion.`;
  return {
    ok: true,
    message: envoi.ok
      ? `${nom} est cree, ses acces sont partis a ${email}. ${rappel}${lienManquant()}`
      : `${nom} est cree. Le courrier n'est pas parti (${envoi.detail}) : transmettez-lui vous-meme. ${rappel}`,
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
  const rows = (await sql`
    update members
    set password_hash = ${hacherMotDePasse(provisoire)}, must_change_password = true
    where id = ${id}::uuid
    returning full_name, email
  `) as { full_name: string; email: string }[];
  if (rows.length === 0) return { ok: false, erreur: "Membre introuvable." };

  /*
   * Le courrier porte le lien, l'identifiant et le mot de passe provisoire.
   *
   * Il ne part qu'apres l'ecriture : un envoi reussi sur un mot de passe non
   * enregistre donnerait un acces qui ne fonctionne pas, et l'interesse
   * chercherait longtemps.
   *
   * Son echec n'annule pas la reinitialisation -- l'ancien mot de passe ne vaut
   * deja plus rien -- mais il est dit, et le provisoire reste affiche pour etre
   * transmis autrement.
   */
  const envoi = await envoyerAcces(
    { nom: rows[0].full_name, email: rows[0].email },
    provisoire,
  ).catch((e: unknown) => ({ ok: false, detail: String(e) }));

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "reinitialisation_mot_de_passe",
    { entite: "members", id },
    { courriel: envoi.ok ? "remis" : `echec : ${envoi.detail}` },
  );
  revalidatePath("/", "layout");

  const rappel = `Mot de passe provisoire de ${rows[0].full_name} : ${provisoire}`;
  return envoi.ok
    ? {
        ok: true,
        message: `Acces envoyes a ${rows[0].email}. ${rappel} — a garder sous la main tant qu'il n'a pas confirme.${lienManquant()}`,
      }
    : {
        ok: true,
        message: `${rappel}. Le courrier n'est pas parti (${envoi.detail}) : transmettez-le vous-meme.`,
      };
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
