"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerMembre, exigerRole } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { REGLES, decalerMois } from "@/lib/settings";
import type { EtatFormulaire } from "./auth";

const MODES = ["especes", "mobile_money", "virement", "cheque"] as const;

/**
 * Declare un versement en caisse. Il reste "en attente" jusqu'a validation du tresorier,
 * mais il est visible de tous des la declaration : c'est le suivi partage voulu par le club.
 *
 * Un membre declare pour lui-meme ; le president peut declarer pour un autre membre
 * (l'argent transite parfois par lui), la validation du tresorier restant requise.
 */
export async function declarerVersement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const membreCible = Number(donnees.get("membreId") ?? auteur.id);
  const moisDebut = String(donnees.get("moisDebut") ?? "").slice(0, 10);
  const nbMois = Math.max(1, Math.min(24, Number(donnees.get("nbMois") ?? 1)));
  const montantParMois = Number(donnees.get("montant") ?? REGLES.cotisationMensuelle);
  const dateVersement = String(donnees.get("dateVersement") ?? "").slice(0, 10);
  const mode = String(donnees.get("mode") ?? "especes");
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (membreCible !== auteur.id && auteur.role !== "president") {
    return { ok: false, erreur: "Seul le president peut declarer un versement pour un autre membre." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(moisDebut)) {
    return { ok: false, erreur: "Mois de depart invalide." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVersement)) {
    return { ok: false, erreur: "Date de versement invalide." };
  }
  if (!Number.isFinite(montantParMois) || montantParMois <= 0) {
    return { ok: false, erreur: "Montant invalide." };
  }
  if (!MODES.includes(mode as (typeof MODES)[number])) {
    return { ok: false, erreur: "Mode de paiement inconnu." };
  }

  const mois = Array.from({ length: nbMois }, (_, i) => decalerMois(moisDebut, i));
  const sql = db();

  // Un mois deja couvert par un versement vivant ne peut pas l'etre deux fois.
  const existants = await sql`
    select to_char(mois_couvert, 'YYYY-MM-DD') as mois
    from versements
    where membre_id = ${membreCible} and statut <> 'rejete'
      and mois_couvert = any(${mois}::date[])
  `;
  if (existants.length > 0) {
    const liste = existants.map((r) => r.mois).join(", ");
    return { ok: false, erreur: `Ces mois sont deja couverts : ${liste}.` };
  }

  for (const m of mois) {
    await sql`
      insert into versements (membre_id, mois_couvert, montant, date_versement, mode, statut, saisi_par, note)
      values (${membreCible}, ${m}::date, ${Math.round(montantParMois)}, ${dateVersement}::date,
              ${mode}, 'en_attente', ${auteur.id}, ${note})
    `;
  }

  await journaliser(auteur.id, "declaration_versement", {
    membreCible,
    mois,
    montantTotal: Math.round(montantParMois) * nbMois,
  });
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      nbMois === 1
        ? "Versement declare. Il attend la validation du tresorier."
        : `${nbMois} mois declares. Ils attendent la validation du tresorier.`,
  };
}

/**
 * Validation d'un encaissement : competence du tresorier, qui tient la caisse.
 * Exception necessaire : le tresorier ne valide pas ses propres versements,
 * le president s'en charge pour eviter l'auto-validation.
 */
export async function validerVersement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("tresorier", "president");
  const id = Number(donnees.get("id"));
  if (!Number.isInteger(id)) return { ok: false, erreur: "Versement introuvable." };

  const sql = db();
  const rows = await sql`select membre_id, statut from versements where id = ${id}`;
  const v = rows[0];
  if (!v) return { ok: false, erreur: "Versement introuvable." };
  if (v.statut !== "en_attente") return { ok: false, erreur: "Ce versement est deja traite." };

  const estSonPropreVersement = Number(v.membre_id) === auteur.id;
  if (estSonPropreVersement) {
    return { ok: false, erreur: "Vous ne pouvez pas valider votre propre versement." };
  }
  if (auteur.role === "president") {
    // Le president n'intervient que sur les versements du tresorier.
    const t = await sql`select id from membres where id = ${v.membre_id} and role = 'tresorier'`;
    if (t.length === 0) {
      return { ok: false, erreur: "La validation des encaissements revient au tresorier." };
    }
  }

  await sql`
    update versements set statut = 'valide', valide_par = ${auteur.id}, valide_le = now(), motif_rejet = null
    where id = ${id}
  `;
  await journaliser(auteur.id, "validation_versement", { versementId: id });
  revalidatePath("/", "layout");
  return { ok: true, message: "Versement valide." };
}

export async function rejeterVersement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("tresorier", "president");
  const id = Number(donnees.get("id"));
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!motif) return { ok: false, erreur: "Indiquez le motif du rejet." };

  const sql = db();
  const rows = await sql`select membre_id, statut from versements where id = ${id}`;
  const v = rows[0];
  if (!v) return { ok: false, erreur: "Versement introuvable." };
  if (Number(v.membre_id) === auteur.id) {
    return { ok: false, erreur: "Vous ne pouvez pas statuer sur votre propre versement." };
  }

  await sql`
    update versements set statut = 'rejete', valide_par = ${auteur.id}, valide_le = now(), motif_rejet = ${motif}
    where id = ${id} and statut = 'en_attente'
  `;
  await journaliser(auteur.id, "rejet_versement", { versementId: id, motif });
  revalidatePath("/", "layout");
  return { ok: true, message: "Versement rejete. Le mois redevient disponible." };
}

/** R3 : le membre declare son retard au groupe ; la trace est conservee ici. */
export async function declarerRetard(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const membreCible = Number(donnees.get("membreId") ?? auteur.id);
  const mois = String(donnees.get("mois") ?? "").slice(0, 10);
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (membreCible !== auteur.id && auteur.role !== "president") {
    return { ok: false, erreur: "Seul le president peut enregistrer la declaration d'un autre membre." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mois)) return { ok: false, erreur: "Mois invalide." };

  const sql = db();
  await sql`
    insert into declarations_retard (membre_id, mois_concerne, note)
    values (${membreCible}, ${mois}::date, ${note})
    on conflict (membre_id, mois_concerne) do update set note = excluded.note
  `;
  await journaliser(auteur.id, "declaration_retard", { membreCible, mois });
  revalidatePath("/", "layout");
  return { ok: true, message: "Retard declare. Le benefice du plan de redressement (R5) est preserve." };
}
