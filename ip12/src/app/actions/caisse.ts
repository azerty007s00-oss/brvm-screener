"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerDroit } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { journaliser } from "@/lib/journal";
import { SENS_CAISSE, STATUT_CAISSE } from "@/lib/valeurs";
import { synthese } from "@/lib/queries";
import { fcfa } from "@/lib/settings";
import type { EtatFormulaire } from "./auth";

/**
 * Mouvement de caisse : depense de fonctionnement ou recette exceptionnelle.
 *
 * Le tresorier saisit et le president valide ; le president, lui, fait les deux
 * d'un geste. La caisse n'est pas le compte-titres : on y puise pour le
 * transport, les impressions, les frais bancaires, et l'on y verse ce qui
 * n'est pas une cotisation -- les versements acquis au club d'un membre parti,
 * par exemple (art. 18).
 */
export async function enregistrerMouvement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererCaisse");
  const date = String(donnees.get("date") ?? "").slice(0, 10);
  const sens = String(donnees.get("sens") ?? SENS_CAISSE.depense);
  const categorie = String(donnees.get("categorie") ?? "autre").slice(0, 60);
  const montant = Number(donnees.get("montant") ?? 0);
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, erreur: "Date invalide." };
  if (sens !== SENS_CAISSE.depense && sens !== SENS_CAISSE.recette) {
    return { ok: false, erreur: "Sens du mouvement inconnu." };
  }
  if (!Number.isFinite(montant) || montant <= 0) return { ok: false, erreur: "Montant invalide." };

  // Le president valide sa propre saisie ; celle du tresorier attend son visa.
  const valideDOffice = peut(auteur, "gererReglages");
  const sql = db();
  await sql`
    insert into cash_movements
      (movement_date, direction, category, amount, note, status, created_by, reviewed_by, reviewed_at)
    values (${date}::date, ${sens}, ${categorie}, ${Math.round(montant)}, ${note},
            ${valideDOffice ? STATUT_CAISSE.valide : STATUT_CAISSE.enAttente},
            ${auteur.id}::uuid,
            ${valideDOffice ? auteur.id : null}::uuid,
            ${valideDOffice ? new Date().toISOString() : null}::timestamptz)
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "mouvement_caisse",
    { entite: "cash_movements" },
    { date, sens, categorie, montant: Math.round(montant), valideDOffice },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: valideDOffice
      ? "Mouvement enregistre et valide."
      : "Mouvement enregistre. Il attend la validation du president.",
  };
}

export async function validerMouvement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReglages");
  const id = String(donnees.get("id") ?? "");
  const sql = db();
  const rows = await sql`
    update cash_movements
    set status = ${STATUT_CAISSE.valide}, reviewed_by = ${auteur.id}::uuid, reviewed_at = now()
    where id = ${id}::uuid and status = ${STATUT_CAISSE.enAttente}
    returning id
  `;
  if (rows.length === 0) return { ok: false, erreur: "Mouvement introuvable ou deja traite." };
  await journaliser({ id: auteur.id, nom: auteur.nom }, "validation_mouvement_caisse", {
    entite: "cash_movements",
    id,
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Mouvement valide." };
}

export async function rejeterMouvement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererReglages");
  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!motif) return { ok: false, erreur: "Indiquez le motif du rejet." };

  const sql = db();
  const rows = await sql`
    update cash_movements
    set status = ${STATUT_CAISSE.rejete}, reviewed_by = ${auteur.id}::uuid,
        reviewed_at = now(), review_note = ${motif}
    where id = ${id}::uuid and status = ${STATUT_CAISSE.enAttente}
    returning id
  `;
  if (rows.length === 0) return { ok: false, erreur: "Mouvement introuvable ou deja traite." };
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "rejet_mouvement_caisse",
    { entite: "cash_movements", id },
    { motif },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Mouvement rejete." };
}

/**
 * Regularise l'ecart entre la caisse calculee et la caisse reellement constatee.
 *
 * Un club qui reprend son historique traine des mouvements dont le detail est
 * perdu -- des penalites anciennes encaissees sans trace nominative, le plus
 * souvent. Plutot que de laisser le tresorier soustraire deux nombres et saisir
 * le resultat dans le bon sens, il annonce le solde qu'il constate et l'outil
 * ecrit l'ecart : le signe ne peut pas etre inverse par erreur, et le motif
 * garde la memoire de ce qu'on n'a pas su documenter.
 */
export async function regulariserCaisse(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererCaisse");
  const soldeReel = Number(donnees.get("soldeReel") ?? NaN);
  const date = String(donnees.get("date") ?? "").slice(0, 10);
  const motif =
    String(donnees.get("motif") ?? "").trim() || "Penalites historiques non documentees";

  if (!Number.isFinite(soldeReel) || soldeReel < 0) {
    return { ok: false, erreur: "Solde constate invalide." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, erreur: "Date invalide." };

  const s = await synthese();
  const ecart = Math.round(soldeReel) - Math.round(s.totalEnCaisse);

  if (ecart === 0) {
    return {
      ok: true,
      message: `La caisse tombe deja juste a ${fcfa(s.totalEnCaisse)}. Rien a regulariser.`,
    };
  }

  const sens = ecart > 0 ? SENS_CAISSE.recette : SENS_CAISSE.depense;
  const sql = db();
  await sql`
    insert into cash_movements
      (movement_date, direction, category, amount, note, status, created_by, reviewed_by, reviewed_at)
    values (${date}::date, ${sens}, 'regularisation', ${Math.abs(ecart)}, ${motif},
            ${STATUT_CAISSE.valide}, ${auteur.id}::uuid, ${auteur.id}::uuid, now())
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "regularisation_caisse",
    { entite: "cash_movements" },
    { soldeCalcule: s.totalEnCaisse, soldeReel: Math.round(soldeReel), ecart, motif },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      `Ecart de ${fcfa(Math.abs(ecart))} inscrit en ${ecart > 0 ? "recette" : "depense"}. ` +
      `La caisse affiche desormais ${fcfa(Math.round(soldeReel))}.`,
  };
}
