"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerDroit } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
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
  await sql`delete from attendances where meeting_id = ${reunionId}::uuid`;
  for (const p of pointes) {
    await sql`
      insert into attendances (meeting_id, member_id, status)
      values (${reunionId}::uuid, ${p.membreId}::uuid, ${p.statut})
    `;
  }

  const absents = pointes.filter((p) => p.statut === "absent").length;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "feuille_presence",
    { entite: "meetings", id: reunionId },
    { pointes: pointes.length, absents },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      absents > 0
        ? `Feuille enregistree. ${absents} absence${absents > 1 ? "s" : ""} — vous pouvez les sanctionner depuis la page Penalites.`
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
