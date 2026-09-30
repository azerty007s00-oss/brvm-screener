"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerDroit } from "@/lib/auth";
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

  /*
   * La saisie vaut validation, pour le tresorier comme pour le president.
   *
   * L'ecriture du tresorier attendait le visa du president -- separation des
   * roles calquee sur celle des versements. Le club en a decide autrement : le
   * tresorier tient la caisse, il constate ses depenses lui-meme. La regle des
   * versements, elle, ne bouge pas : la elle separe deux personnes, le membre
   * qui declare et le tresorier qui encaisse, tandis qu'ici le tresorier etait
   * seul des deux cotes et le visa n'ajoutait qu'un delai.
   *
   * Seuls le tresorier et le president atteignent cette action (droit
   * `gererCaisse`) : aucune ecriture n'arrive donc plus en attente. Le circuit
   * de validation reste en place pour les lignes deja en attente en base, et
   * pour annuler une ecriture close.
   */
  const sql = db();
  await sql`
    insert into cash_movements
      (movement_date, direction, category, amount, note, status, created_by, reviewed_by, reviewed_at)
    values (${date}::date, ${sens}, ${categorie}, ${Math.round(montant)}, ${note},
            ${STATUT_CAISSE.valide}, ${auteur.id}::uuid, ${auteur.id}::uuid,
            ${new Date().toISOString()}::timestamptz)
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "mouvement_caisse",
    { entite: "cash_movements" },
    { date, sens, categorie, montant: Math.round(montant) },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Mouvement enregistre et valide." };
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
  /*
   * Qui tient la caisse peut annuler ce qu'il y a inscrit.
   *
   * L'annulation etait reservee au president, du temps ou le tresorier n'osait
   * pas valider seul. Maintenant qu'il valide, lui refuser de se reprendre le
   * laisserait sans recours devant sa propre faute de frappe -- ou pire, le
   * pousserait a inscrire une ecriture inverse, qui decrirait un mouvement
   * n'ayant pas eu lieu. Le motif reste obligatoire et le journal garde le nom.
   */
  const auteur = await exigerDroit("gererCaisse");
  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!motif) return { ok: false, erreur: "Indiquez le motif du rejet." };

  /*
   * Le rejet valait pour les seules lignes en attente. Une ligne validee etait
   * donc definitive : la corriger demandait de lui opposer une ecriture inverse,
   * qui decrivait a son tour un mouvement n'ayant pas eu lieu. Une ecriture close
   * s'annule desormais aussi -- acte plus lourd, reserve au president comme le
   * rejet, motif obligatoire, et trace au journal de l'etat d'ou l'on vient.
   */
  const sql = db();
  const rows = (await sql`
    update cash_movements
    set status = ${STATUT_CAISSE.rejete}, reviewed_by = ${auteur.id}::uuid,
        reviewed_at = now(), review_note = ${motif}
    where id = ${id}::uuid and status <> ${STATUT_CAISSE.rejete}
    returning id, amount, direction, category
  `) as { id: string; amount: number | string; direction: string; category: string }[];
  if (rows.length === 0) return { ok: false, erreur: "Mouvement introuvable ou deja rejete." };
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "rejet_mouvement_caisse",
    { entite: "cash_movements", id },
    {
      motif,
      montant: Number(rows[0].amount),
      sens: rows[0].direction,
      categorie: rows[0].category,
    },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Mouvement rejete : il ne compte plus dans la caisse." };
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
