"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerRole } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { SENS_TRANSFERT } from "@/lib/valeurs";
import type { EtatFormulaire } from "./auth";

/**
 * Mouvement entre la caisse et le compte-titres Phoenix.
 *
 * La table ne porte pas de statut : la saisie vaut validation, ce qui correspond
 * a l'art. 14 (le president transmet les ordres). L'action est donc reservee au
 * president, et `direction` distingue l'apport du retrait.
 */
export async function enregistrerApport(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const dateApport = String(donnees.get("dateApport") ?? "").slice(0, 10);
  const montant = Number(donnees.get("montant") ?? 0);
  const sens = String(donnees.get("sens") ?? SENS_TRANSFERT.entree);
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateApport)) return { ok: false, erreur: "Date invalide." };
  if (!Number.isFinite(montant) || montant <= 0) return { ok: false, erreur: "Montant invalide." };
  if (sens !== SENS_TRANSFERT.entree && sens !== SENS_TRANSFERT.sortie) {
    return { ok: false, erreur: "Sens du mouvement inconnu." };
  }

  const sql = db();
  await sql`
    insert into securities_transfers (transfer_date, amount, direction, note, created_by)
    values (${dateApport}::date, ${Math.round(montant)}, ${sens}, ${note}, ${auteur.id}::uuid)
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "mouvement_compte_titres",
    { entite: "securities_transfers" },
    { dateApport, montant, sens },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: sens === SENS_TRANSFERT.entree ? "Apport enregistre." : "Retrait enregistre.",
  };
}

/**
 * Releve du compte-titres, saisi par le president tous les deux mois.
 * `total_value` est la valeur totale, `cash_part` sa part liquide.
 *
 * Pas d'`on conflict` : les contraintes d'unicite de la base n'etant pas connues
 * avec certitude, on teste puis on met a jour ou on insere.
 */
export async function enregistrerValorisation(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const dateValo = String(donnees.get("dateValo") ?? "").slice(0, 10);
  const total = Number(donnees.get("total") ?? 0);
  const liquidites = Number(donnees.get("liquidites") ?? 0);
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValo)) return { ok: false, erreur: "Date invalide." };
  if (!Number.isFinite(total) || total <= 0) return { ok: false, erreur: "Valeur totale invalide." };
  if (!Number.isFinite(liquidites) || liquidites < 0) return { ok: false, erreur: "Liquidites invalides." };
  if (liquidites > total) {
    return { ok: false, erreur: "Les liquidites ne peuvent pas depasser la valeur totale." };
  }

  const sql = db();
  const existant = await sql`
    select id from portfolio_valuations where valued_on = ${dateValo}::date limit 1
  `;

  if (existant.length > 0) {
    await sql`
      update portfolio_valuations
      set total_value = ${Math.round(total)}, cash_part = ${Math.round(liquidites)},
          note = ${note}, created_by = ${auteur.id}::uuid
      where id = ${existant[0].id}::uuid
    `;
  } else {
    await sql`
      insert into portfolio_valuations (valued_on, total_value, cash_part, note, created_by)
      values (${dateValo}::date, ${Math.round(total)}, ${Math.round(liquidites)}, ${note},
              ${auteur.id}::uuid)
    `;
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "valorisation",
    { entite: "portfolio_valuations" },
    { dateValo, total, liquidites, remplacement: existant.length > 0 },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: existant.length > 0
      ? "Releve remplace. Les parts sont recalculees."
      : "Releve enregistre. Les parts sont recalculees.",
  };
}

export async function supprimerValorisation(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("president");
  const id = String(donnees.get("id") ?? "");
  const sql = db();
  await sql`delete from portfolio_valuations where id = ${id}::uuid`;
  await journaliser({ id: auteur.id, nom: auteur.nom }, "suppression_valorisation", {
    entite: "portfolio_valuations",
    id,
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Releve supprime." };
}
