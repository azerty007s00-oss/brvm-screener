"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerRole } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import type { EtatFormulaire } from "./auth";

/**
 * Apport de la caisse vers le compte-titres Phoenix.
 * Le president saisit et valide dans le meme geste (art. 14 : il transmet les ordres).
 * Le tresorier peut preparer un apport, qui reste alors en attente du president.
 */
export async function enregistrerApport(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president", "tresorier");
  const dateApport = String(donnees.get("dateApport") ?? "").slice(0, 10);
  const montant = Number(donnees.get("montant") ?? 0);
  const reference = String(donnees.get("reference") ?? "").trim() || null;
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateApport)) return { ok: false, erreur: "Date invalide." };
  if (!Number.isFinite(montant) || montant <= 0) return { ok: false, erreur: "Montant invalide." };

  const directementValide = auteur.role === "president";
  const sql = db();
  await sql`
    insert into apports_titres (date_apport, montant, reference, statut, saisi_par, valide_par, valide_le, note)
    values (${dateApport}::date, ${Math.round(montant)}, ${reference},
            ${directementValide ? "valide" : "en_attente"}, ${auteur.id},
            ${directementValide ? auteur.id : null},
            ${directementValide ? new Date().toISOString() : null}, ${note})
  `;
  await journaliser(auteur.id, "apport_compte_titres", { dateApport, montant, directementValide });
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: directementValide
      ? "Apport enregistre et valide."
      : "Apport enregistre. Il attend la validation du president.",
  };
}

export async function validerApport(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const id = Number(donnees.get("id"));
  const sql = db();
  const maj = await sql`
    update apports_titres set statut = 'valide', valide_par = ${auteur.id}, valide_le = now()
    where id = ${id} and statut = 'en_attente' returning id
  `;
  if (maj.length === 0) return { ok: false, erreur: "Apport introuvable ou deja valide." };
  await journaliser(auteur.id, "validation_apport", { apportId: id });
  revalidatePath("/", "layout");
  return { ok: true, message: "Apport valide." };
}

/** Releve du compte-titres, saisi par le president tous les 2 mois. */
export async function enregistrerValorisation(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const dateValo = String(donnees.get("dateValo") ?? "").slice(0, 10);
  const actions = Number(donnees.get("valeurActions") ?? 0);
  const liquidites = Number(donnees.get("valeurLiquidites") ?? 0);
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValo)) return { ok: false, erreur: "Date invalide." };
  if (!Number.isFinite(actions) || actions < 0) return { ok: false, erreur: "Valeur des actions invalide." };
  if (!Number.isFinite(liquidites) || liquidites < 0) return { ok: false, erreur: "Liquidites invalides." };
  if (actions + liquidites <= 0) return { ok: false, erreur: "Le releve ne peut pas etre vide." };

  const sql = db();
  await sql`
    insert into valorisations (date_valo, valeur_actions, valeur_liquidites, saisi_par, note)
    values (${dateValo}::date, ${Math.round(actions)}, ${Math.round(liquidites)}, ${auteur.id}, ${note})
    on conflict (date_valo) do update
      set valeur_actions = excluded.valeur_actions,
          valeur_liquidites = excluded.valeur_liquidites,
          saisi_par = excluded.saisi_par,
          note = excluded.note
  `;
  await journaliser(auteur.id, "valorisation", { dateValo, total: actions + liquidites });
  revalidatePath("/", "layout");
  return { ok: true, message: "Releve enregistre. Les parts sont recalculees." };
}

export async function supprimerValorisation(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const id = Number(donnees.get("id"));
  const sql = db();
  await sql`delete from valorisations where id = ${id}`;
  await journaliser(auteur.id, "suppression_valorisation", { id });
  revalidatePath("/", "layout");
  return { ok: true, message: "Releve supprime." };
}
