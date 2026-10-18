"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerRole, hacherMotDePasse, motDePasseProvisoire } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { envoyerAcces } from "@/lib/avis";
import { listerMembres } from "@/lib/queries";
import { CLUB, POSTES_UNIQUES, ROLES, lienDuSite } from "@/lib/settings";
import type { Role } from "@/lib/settings";
import type { EtatFormulaire } from "./auth";

const ROLES_VALIDES = Object.keys(ROLES) as Role[];

/**
 * Le titulaire actuel d'un poste de bureau, autre que `sauf` : il repassera
 * simple membre, et le message doit le nommer.
 *
 * Le changement se faisait en silence : donner le poste de secretaire a un
 * membre retirait le sien au secretaire en place, sans un mot. Et il se faisait
 * AVANT l'ecriture du nouveau titulaire, dans une autre requete : si celle-ci
 * echouait (une adresse deja prise), le poste restait vacant.
 */
async function titulaireActuel(role: string, sauf: string | null): Promise<string | null> {
  if (!POSTES_UNIQUES.includes(role as Role)) return null;
  const rows = await db()`
    select full_name from members
    where role = ${role} and is_active and (${sauf}::uuid is null or id <> ${sauf}::uuid)
    limit 1
  `;
  return rows[0] ? String(rows[0].full_name) : null;
}

/** « KONE Bourama redevient simple membre : le poste de tresorier n'a qu'un titulaire. » */
function passation(ancien: string | null, role: string): string {
  return ancien
    ? ` ${ancien} redevient simple membre : le poste de ${ROLES[role as Role].toLowerCase()} n'a qu'un titulaire.`
    : "";
}

/** Une adresse ne sert qu'a un compte : on le dit avant d'ecrire, plutot que de laisser la base refuser. */
async function adressePrise(email: string, sauf: string | null): Promise<boolean> {
  const rows = await db()`
    select 1 from members
    where lower(email) = ${email} and (${sauf}::uuid is null or id <> ${sauf}::uuid)
    limit 1
  `;
  return rows.length > 0;
}

/*
 * Le courrier d'acces porte le lien du site. Sans NEXT_PUBLIC_SITE_URL, il part
 * quand meme -- l'identifiant et le mot de passe valent d'etre transmis -- mais
 * sans l'adresse, et le destinataire ne sait pas ou aller. Le president doit
 * l'apprendre du message de retour, non d'un membre perdu.
 */
function lienManquant(): string {
  return lienDuSite() === ""
    ? " Attention : NEXT_PUBLIC_SITE_URL n'est pas renseignée dans Vercel, le courrier part sans l'adresse du site."
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
    return { ok: false, erreur: "Rôle inconnu." };
  }

  const sql = db();
  /* Le plafond compte des personnes : une part rachetee n'en est pas une. */
  const effectif = (await listerMembres()).filter((m) => !m.titulaireId).length;
  if (effectif >= CLUB.membresMax) {
    return { ok: false, erreur: `Le club est plafonné à ${CLUB.membresMax} membres (statuts).` };
  }

  if (await adressePrise(email, null)) {
    return { ok: false, erreur: "Cet e-mail est déjà utilisé par un membre." };
  }

  /*
   * Poste de bureau : un seul titulaire, le precedent repasse simple membre --
   * dans la meme transaction que l'arrivee du nouveau, pour que le poste ne
   * reste jamais vacant.
   */
  const ancien = await titulaireActuel(role, null);
  const provisoire = motDePasseProvisoire();
  try {
    await sql.transaction([
      ...(POSTES_UNIQUES.includes(role as Role)
        ? [sql`update members set role = 'membre' where role = ${role}`]
        : []),
      sql`
        insert into members (full_name, email, phone, title, role, password_hash,
                             must_change_password, joined_on)
        values (${nom}, ${email}, ${telephone}, ${titre}, ${role},
                ${hacherMotDePasse(provisoire)}, true, ${dateAdhesion}::date)
      `,
    ]);
  } catch {
    return { ok: false, erreur: "Le profil n'a pas pu être créé : vérifiez l'adresse e-mail, puis réessayez." };
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
    { nom, email, role, courriel: envoi.ok ? "remis" : `échec : ${envoi.detail}` },
  );
  revalidatePath("/", "layout");

  const rappel = `Mot de passe provisoire : ${provisoire}. Il lui sera demandé de le changer à la première connexion.`;
  return {
    ok: true,
    message: envoi.ok
      ? `${nom} est créé, ses accès sont partis à ${email}. ${rappel}${lienManquant()}${passation(ancien, role)}`
      : `${nom} est créé. Le courrier n'est pas parti (${envoi.detail}) : transmettez-lui vous-même. ${rappel}${passation(ancien, role)}`,
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
    return { ok: false, erreur: "Rôle inconnu." };
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, erreur: "E-mail invalide." };
  /*
   * Le president qui se retirait la presidence perdait aussitot l'acces a cette
   * page, sans successeur. La passation se fait depuis la fiche du successeur.
   */
  if (id === auteur.id && role !== "president") {
    return {
      ok: false,
      erreur: "Vous ne pouvez pas quitter la présidence depuis votre fiche : donnez le rôle de président à votre successeur depuis la sienne.",
    };
  }
  if (await adressePrise(email, id)) {
    return { ok: false, erreur: "Cet e-mail est déjà utilisé par un autre membre." };
  }

  const sql = db();
  const ancien = await titulaireActuel(role, id);
  await sql.transaction([
    ...(POSTES_UNIQUES.includes(role as Role)
      ? [sql`update members set role = 'membre' where role = ${role} and id <> ${id}::uuid`]
      : []),
    sql`
      update members
      set full_name = ${nom}, email = ${email}, phone = ${telephone}, title = ${titre}, role = ${role}
      where id = ${id}::uuid
    `,
  ]);
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "modification_membre",
    { entite: "members", id },
    { nom, role },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: `Membre mis à jour.${passation(ancien, role)}` };
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
    { courriel: envoi.ok ? "remis" : `échec : ${envoi.detail}` },
  );
  revalidatePath("/", "layout");

  const rappel = `Mot de passe provisoire de ${rows[0].full_name} : ${provisoire}`;
  return envoi.ok
    ? {
        ok: true,
        message: `Accès envoyés à ${rows[0].email}. ${rappel} À garder sous la main tant qu'il n'a pas confirmé.${lienManquant()}`,
      }
    : {
        ok: true,
        message: `${rappel}. Le courrier n'est pas parti (${envoi.detail}) : transmettez-le vous-même.`,
      };
}

export async function basculerActivite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const id = String(donnees.get("id") ?? "");
  if (id === auteur.id) return { ok: false, erreur: "Vous ne pouvez pas vous désactiver vous-même." };

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
    message: `${rows[0].full_name} est désormais ${rows[0].is_active ? "actif" : "inactif"}.`,
  };
}
