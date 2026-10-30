"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigerMembre } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { journaliser } from "@/lib/journal";
import {
  annoncerAnnulation,
  annulerVote,
  clotureEnClair,
  creerVote,
  deposerBulletin,
  electeursActuels,
  inviterAuVote,
  personnes,
  voteParId,
} from "@/lib/votes";
import { CHOIX, HEURE_CLOTURE, STATUT_VOTE, estChoix, estMajorite } from "@/lib/scrutin";
import type { EtatFormulaire } from "./auth";

/** Tout membre en activite soumet une question au vote du club. */
export async function proposerVote(_precedent: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const gens = await personnes();
  if (!gens.some((m) => m.id === auteur.id)) return { ok: false, erreur: "Seuls les membres en activité proposent un vote." };

  const question = String(donnees.get("question") ?? "").trim().replace(/\s+/g, " ").slice(0, 240);
  const details = String(donnees.get("details") ?? "").trim().slice(0, 2000) || null;
  const majorite = String(donnees.get("majorite") ?? "");
  const jour = String(donnees.get("cloture") ?? "").slice(0, 10);
  const vise = String(donnees.get("vise") ?? "") || null;

  if (question.length < 5) return { ok: false, erreur: "Écrivez la question posée au club." };
  if (!estMajorite(majorite)) return { ok: false, erreur: "Choisissez la majorité requise." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) return { ok: false, erreur: "Choisissez le jour de clôture." };
  const cloture = new Date(`${jour}T${String(HEURE_CLOTURE).padStart(2, "0")}:00:00Z`);
  const maintenant = new Date();
  if (cloture.getTime() - maintenant.getTime() < 12 * 3_600_000) {
    return { ok: false, erreur: "Laissez au moins une demi-journée pour voter : choisissez une clôture plus tardive." };
  }
  if (cloture.getTime() - maintenant.getTime() > 60 * 86_400_000) {
    return { ok: false, erreur: "Un vote dure deux mois au plus : choisissez une clôture plus proche." };
  }
  if (vise && !gens.some((m) => m.id === vise)) return { ok: false, erreur: "Membre concerné introuvable." };

  const id = await creerVote({ question, details, majorite, cloture, vise, auteurId: auteur.id });
  await journaliser({ id: auteur.id, nom: auteur.nom }, "vote_ouvert", { entite: "votes", id }, { question, majorite, cloture: jour, vise });
  after(async () => {
    try {
      const v = await voteParId(id);
      if (v) await inviterAuVote(v);
    } catch {
      // Le vote est ouvert ; une invitation perdue se rattrape par la page Votes.
    }
  });
  revalidatePath("/", "layout");
  redirect(`/votes/${id}`);
}

/** Pour, contre ou abstention ; on change d'avis jusqu'a la cloture. */
export async function voter(_precedent: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const membre = await exigerMembre();
  const v = await voteParId(String(donnees.get("voteId") ?? ""));
  if (!v) return { ok: false, erreur: "Vote introuvable." };
  if (v.statut !== STATUT_VOTE.ouvert || new Date() >= v.cloture) return { ok: false, erreur: "Ce vote est clos." };
  const choix = String(donnees.get("choix") ?? "");
  if (!estChoix(choix)) return { ok: false, erreur: "Choisissez pour, contre ou abstention." };

  const moi = (await electeursActuels(v.vise)).find((e) => e.membreId === membre.id);
  if (!moi) return { ok: false, erreur: "Seuls les membres en activité votent." };
  if (moi.exclu === "vise") return { ok: false, erreur: "Ce vote vous concerne directement : vous ne votez pas." };
  if (moi.exclu === "suspendu") {
    return {
      ok: false,
      erreur: "Votre droit de vote est suspendu (R2, plus de 30 jours de retard). Régularisez vos cotisations pour le retrouver avant la clôture.",
    };
  }

  await deposerBulletin(v.id, membre.id, choix);
  await journaliser({ id: membre.id, nom: membre.nom }, "bulletin", { entite: "votes", id: v.id }, { choix });
  revalidatePath("/votes");
  revalidatePath(`/votes/${v.id}`);
  revalidatePath("/");
  const libelle = CHOIX.find((c) => c.cle === choix)?.libelle.toLowerCase() ?? choix;
  return { ok: true, message: `Votre vote est enregistré : ${libelle}. Vous pouvez changer d'avis jusqu'au ${clotureEnClair(v.cloture)}.` };
}

/** L'auteur du vote ou le president l'annule, motif a l'appui ; tous en sont avertis. */
export async function annulerVoteAction(_precedent: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const membre = await exigerMembre();
  const v = await voteParId(String(donnees.get("voteId") ?? ""));
  if (!v) return { ok: false, erreur: "Vote introuvable." };
  if (v.auteurId !== membre.id && !peut(membre, "annulerVote")) {
    return { ok: false, erreur: "Seuls l'auteur du vote et le président peuvent l'annuler." };
  }
  const motif = String(donnees.get("motif") ?? "").trim().slice(0, 300);
  if (motif.length < 3) return { ok: false, erreur: "Indiquez le motif de l'annulation : tous les membres le liront." };
  if (!(await annulerVote(v.id, motif, membre.id))) return { ok: false, erreur: "Ce vote n'est plus ouvert." };

  await journaliser({ id: membre.id, nom: membre.nom }, "vote_annule", { entite: "votes", id: v.id }, { motif });
  after(async () => {
    try {
      await annoncerAnnulation(v, motif);
    } catch {
      // L'annulation est inscrite ; la page Votes la montre.
    }
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Vote annulé. Les membres en sont avertis." };
}
