"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerDroit } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { avertirAbsence } from "@/lib/avis";
import { absencesParMembre, reglagesEffectifs } from "@/lib/queries";
import type { EtatFormulaire } from "./auth";

const PRESENCES = ["present", "absent", "excuse"] as const;
export type StatutPresence = (typeof PRESENCES)[number];

export async function creerReunion(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReunions");
  const date = String(donnees.get("date") ?? "").slice(0, 10);
  const titre = String(donnees.get("titre") ?? "").trim() || null;
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, erreur: "Date invalide." };

  const sql = db();
  const rows = await sql`
    insert into meetings (meeting_date, title, note, created_by)
    values (${date}::date, ${titre}, ${note}, ${auteur.id}::uuid)
    returning id
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "creation_reunion",
    { entite: "meetings", id: String(rows[0].id) },
    { date, titre },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Reunion creee. Vous pouvez pointer les presences." };
}

/**
 * Enregistre la feuille de presence d'une reunion.
 *
 * L'ensemble est remplace plutot que mis a jour ligne par ligne : la cle primaire
 * de la table n'est pas connue avec certitude, et un remplacement complet donne le
 * meme resultat sans rien supposer. Un membre laisse sans reponse n'est pas pointe.
 */
export async function enregistrerPresences(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReunions");
  const reunionId = String(donnees.get("reunionId") ?? "");
  if (!reunionId) return { ok: false, erreur: "Reunion introuvable." };

  const pointes: { membreId: string; statut: string }[] = [];
  for (const [cle, valeur] of donnees.entries()) {
    if (!cle.startsWith("statut_")) continue;
    const statut = String(valeur);
    if (!PRESENCES.includes(statut as StatutPresence)) continue;
    pointes.push({ membreId: cle.slice("statut_".length), statut });
  }

  const sql = db();

  /*
   * L'etat anterieur, releve avant d'ecraser la feuille. La feuille se corrige :
   * sans cette comparaison, chaque reenregistrement renverrait l'avis a tous les
   * absents, y compris ceux qui l'ont deja recu la veille.
   */
  const avant = new Map(
    (await sql`select member_id, status from attendances where meeting_id = ${reunionId}::uuid`).map(
      (r) => [String(r.member_id), String(r.status)],
    ),
  );

  await sql`delete from attendances where meeting_id = ${reunionId}::uuid`;
  for (const p of pointes) {
    await sql`
      insert into attendances (meeting_id, member_id, status)
      values (${reunionId}::uuid, ${p.membreId}::uuid, ${p.statut})
    `;
  }

  const absents = pointes.filter((p) => p.statut === "absent").length;

  /*
   * Seuls ceux qui viennent d'etre pointes absents sont avertis. Passer un membre
   * de « excuse » a « absent » est un nouveau fait, et vaut avis ; le laisser
   * absent d'un enregistrement a l'autre n'en est pas un.
   */
  const nouveaux = pointes.filter(
    (p) => p.statut === "absent" && avant.get(p.membreId) !== "absent",
  );
  let avertis = 0;
  if (nouveaux.length > 0) {
    const [seance, comptes, reglages] = await Promise.all([
      sql`select to_char(meeting_date, 'YYYY-MM-DD') as date, title from meetings where id = ${reunionId}::uuid`,
      absencesParMembre().catch(() => []),
      reglagesEffectifs(),
    ]);
    const info = seance[0];
    if (info) {
      for (const p of nouveaux) {
        const parti = await avertirAbsence({
          membreId: p.membreId,
          seance: { date: String(info.date), titre: (info.title as string | null) ?? null },
          total: comptes.find((c) => c.membreId === p.membreId)?.injustifiees ?? 1,
          regles: reglages,
        }).catch(() => false);
        if (parti) avertis++;
      }
    }
  }
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "feuille_presence",
    { entite: "meetings", id: reunionId },
    { pointes: pointes.length, absents, nouveauxAbsents: nouveaux.length, avertis },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      absents > 0
        ? `Feuille enregistree. ${absents} absence${absents > 1 ? "s" : ""} — ` +
          `${avertis > 0 ? `${avertis} membre(s) averti(s) par courriel. ` : ""}` +
          "Vous pouvez les sanctionner depuis la page Penalites."
        : "Feuille enregistree.",
  };
}

export async function supprimerReunion(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReunions");
  const id = String(donnees.get("id") ?? "");
  const sql = db();
  await sql`delete from attendances where meeting_id = ${id}::uuid`;
  await sql`delete from meetings where id = ${id}::uuid`;
  await journaliser({ id: auteur.id, nom: auteur.nom }, "suppression_reunion", {
    entite: "meetings",
    id,
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Reunion supprimee." };
}
