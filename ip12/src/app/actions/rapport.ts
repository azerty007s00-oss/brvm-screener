"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { exigerDroit } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { envoyerAlertes } from "@/lib/alertes";
import { envoyerCourriel } from "@/lib/courriel";
import { donneesRapport, enregistrerPoints } from "@/lib/rapport-donnees";
import { nomFichierRapport, ordreDuJour, rapportPdf, rapportTexte } from "@/lib/rapport-reunion";
import { participants } from "@/lib/sondage";
import { CLUB, dateCourte, lienDuSite } from "@/lib/settings";
import type { EtatFormulaire } from "./auth";

/** Le bureau ajoute, corrige ou retire ses points a l'ordre du jour. */
export async function enregistrerPointsAction(_precedent: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReunions");
  const reunionId = String(donnees.get("reunionId") ?? "");
  const points = donnees
    .getAll("point")
    .map((p) => String(p).trim().replace(/\s+/g, " ").slice(0, 200))
    .filter((p) => p !== "")
    .slice(0, 20);
  await enregistrerPoints(reunionId, points);
  await journaliser({ id: auteur.id, nom: auteur.nom }, "ordre_du_jour", { entite: "meetings", id: reunionId }, { points: points.length });
  revalidatePath(`/reunions/${reunionId}`);
  return { ok: true, message: points.length === 0 ? "Aucun point ajouté." : `${points.length} ${points.length > 1 ? "points enregistrés" : "point enregistré"}.` };
}

/**
 * L'ordre du jour a tous : un courriel, rapport joint, et une alerte. Il
 * complete la convocation partie a la validation de la date.
 */
export async function envoyerOrdreDuJour(_precedent: EtatFormulaire, donnees: FormData): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReunions");
  const reunionId = String(donnees.get("reunionId") ?? "");
  const rapport = await donneesRapport(reunionId);
  if (!rapport) return { ok: false, erreur: "Réunion introuvable." };
  const d = rapport.donnees;
  const gens = await participants();
  const pdf = rapportPdf(d);
  const site = lienDuSite();
  const points = ordreDuJour(d);

  after(async () => {
    try {
      await envoyerAlertes(
        gens.map((m) => m.id),
        {
          titre: `Ordre du jour : réunion du ${dateCourte(d.date)}`,
          corps: `${points.length} ${points.length > 1 ? "points" : "point"} au programme. Les chiffres du club sont prêts : viens préparé, frérot.`,
          url: `/reunions/${reunionId}`,
          etiquette: `odj-${reunionId}`,
        },
      );
      for (const m of gens) {
        if (!m.email) continue;
        await envoyerCourriel({
          destinataire: m.email,
          sujet: `${CLUB.sigle} : ordre du jour de la réunion du ${dateCourte(d.date)}`,
          texte: [
            `Bonjour ${m.nom},`,
            "",
            "Voici l'ordre du jour de la prochaine réunion, et le rapport du club sur la période, en pièce jointe.",
            "",
            rapportTexte(d).replace(/\*/g, ""),
            "",
            site ? `Sur le site : ${site}/reunions/${reunionId}` : "",
            "",
            `Le suivi du club ${CLUB.nom}`,
          ].join("\n"),
          pieces: [{ nom: nomFichierRapport(d.date), contenu: pdf, type: "application/pdf" }],
        }).catch(() => null);
      }
    } catch {
      // L'ordre du jour reste sur le site.
    }
  });
  await journaliser({ id: auteur.id, nom: auteur.nom }, "ordre_du_jour_envoye", { entite: "meetings", id: reunionId }, { destinataires: gens.length });
  return { ok: true, message: `Ordre du jour envoyé à ${gens.length} membres, par courriel (rapport joint) et par alerte.` };
}
