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
  tracerDemande,
  tracerTentative,
  tropDeDemandes,
  tropDeTentatives,
  verifierMotDePasse,
} from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { avertirDemandeReinitialisation } from "@/lib/avis";

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
      erreur: "Trop de tentatives infructueuses. Réessayez dans un quart d'heure.",
    };
  }

  let membre;
  try {
    membre = await membreParEmail(email);
  } catch {
    return { ok: false, erreur: "La base de données n'est pas joignable. Réessayez dans un instant." };
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
    return { ok: false, erreur: "Le nouveau mot de passe doit faire au moins 8 caractères." };
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
  return { ok: true, message: "Mot de passe mis à jour." };
}

/* --------------------------------- mot de passe oublie */

/**
 * Le membre demande au bureau de reinitialiser son mot de passe.
 *
 * POURQUOI UN CHEMIN, ET NON UN LIEN.
 *
 * La page de connexion disait « Mot de passe oublie ? Demandez au president de
 * le reinitialiser » sans donner le moyen de le demander -- une consigne qui ne
 * mene nulle part, comme le courrier qui reclamait des penalites sans dire
 * comment les regler. Un `mailto:` aurait publie l'adresse du president sur une
 * page accessible sans connexion ; le site, lui, connait deja cette adresse et
 * sait ecrire.
 *
 * AUCUN MOT DE PASSE N'EST ENVOYE, et aucun lien de reinitialisation : le
 * president rouvre l'acces depuis la page Membres, comme aujourd'hui. Cette
 * action ne fait que porter la demande.
 */
export async function demanderReinitialisation(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const email = String(donnees.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { ok: false, erreur: "Renseignez l'adresse avec laquelle vous vous connectez." };
  }

  /*
   * LA MEME REPONSE DANS TOUS LES CAS.
   *
   * Dire « cette adresse n'est pas celle d'un membre » apprendrait a un inconnu
   * qui est du club, sur une page que n'importe qui peut ouvrir. Le message ne
   * distingue donc pas l'adresse connue de l'autre -- pas plus que celui de la
   * connexion.
   */
  const reponse = {
    ok: true as const,
    message:
      "Si cette adresse est celle d'un membre, le bureau vient d'en être averti. " +
      "Vous recevrez un mot de passe provisoire.",
  };

  /*
   * CHAQUE DEMANDE LAISSE UNE TRACE, QUELLE QUE SOIT SON ISSUE.
   *
   * La reponse est volontairement la meme dans tous les cas : elle n'apprend
   * rien a un inconnu. Mais elle n'apprenait rien au president non plus, qui
   * lisait « le bureau vient d'en etre averti » quand rien n'etait parti -- une
   * adresse mal saisie, un compte inactif, un transport en panne, tout se
   * ressemblait. Le journal, lui, n'est lu que par lui : il peut tout dire.
   */
  const tracer = (issue: string, detail?: string) =>
    journaliser(null, "demande_reinitialisation", { entite: "members" }, {
      email,
      issue,
      ...(detail ? { detail } : {}),
    });

  if (await tropDeDemandes(email)) {
    await tracer("plafond atteint, rien n'est réparti");
    return reponse;
  }
  await tracerDemande(email);

  let membre;
  try {
    membre = await membreParEmail(email);
  } catch (e) {
    await tracer("base injoignable", String(e));
    return { ok: false, erreur: "La base de données n'est pas joignable. Réessayez dans un instant." };
  }
  if (!membre) {
    await tracer("aucun membre à cette adresse");
    return reponse;
  }
  if (!membre.actif) {
    await tracer("compte inactif");
    return reponse;
  }

  /* L'adresse saisie est celle qui a trouve le compte : inutile de la relire. */
  const envoi = await avertirDemandeReinitialisation({ nom: membre.nom, email }).catch((e) => ({
    partis: 0,
    detail: String(e),
  }));
  await journaliser(
    { id: membre.id, nom: membre.nom },
    "demande_reinitialisation",
    { entite: "members", id: membre.id },
    { email, issue: envoi.partis > 0 ? "avertis" : "aucun avis envoyé", detail: envoi.detail },
  );
  return reponse;
}
