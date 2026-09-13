"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerMembre, exigerRole } from "@/lib/auth";
import { peut } from "@/lib/droits";
import { journaliser } from "@/lib/journal";
import { reglagesEffectifs } from "@/lib/queries";
import { decalerMois } from "@/lib/settings";
import { KIND_VERSEMENT, METHODE, STATUT_VERSEMENT } from "@/lib/valeurs";
import { enregistrerJustificatif } from "@/lib/justificatifs";
import type { EtatFormulaire } from "./auth";

const METHODES = Object.values(METHODE) as string[];

/**
 * Enregistre un versement en caisse.
 *
 * Un membre declare : sa ligne est visible de tous aussitot, et attend la
 * validation du tresorier qui tient la caisse. Le tresorier et le president,
 * eux, saisissent des encaissements deja constates : leur saisie vaut
 * validation. Le journal conserve dans les deux cas qui a saisi et qui a valide.
 *
 * Une avance de plusieurs mois cree une ligne par mois couvert, toutes reliees
 * par un meme batch_id : le suivi reste mensuel sans perdre le fait qu'il s'agit
 * d'un seul versement.
 */
export async function declarerVersement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const membreCible = String(donnees.get("membreId") ?? auteur.id);
  const moisDebut = String(donnees.get("moisDebut") ?? "").slice(0, 10);
  const nbMois = Math.max(1, Math.min(24, Number(donnees.get("nbMois") ?? 1)));
  const reglages = await reglagesEffectifs();
  const montantParMois = Number(donnees.get("montant") ?? reglages.cotisationMensuelle);
  const dateVersement = String(donnees.get("dateVersement") ?? "").slice(0, 10);
  const mode = String(donnees.get("mode") ?? METHODE.mobileMoney);
  const reference = String(donnees.get("reference") ?? "").trim() || null;
  const note = String(donnees.get("note") ?? "").trim() || null;

  const saisieDirecte = peut(auteur, "saisirVersementValide");
  if (membreCible !== auteur.id && !saisieDirecte) {
    return {
      ok: false,
      erreur: "Seuls le tresorier et le president peuvent enregistrer un versement pour autrui.",
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(moisDebut)) return { ok: false, erreur: "Mois de depart invalide." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVersement)) return { ok: false, erreur: "Date de versement invalide." };
  if (!Number.isFinite(montantParMois) || montantParMois <= 0) {
    return { ok: false, erreur: "Montant invalide." };
  }
  if (!METHODES.includes(mode)) return { ok: false, erreur: "Mode de paiement inconnu." };

  const mois = Array.from({ length: nbMois }, (_, i) => decalerMois(moisDebut, i));
  const sql = db();

  const existants = await sql`
    select to_char(period, 'YYYY-MM-DD') as mois
    from contributions
    where member_id = ${membreCible}::uuid
      and status <> ${STATUT_VERSEMENT.rejete}
      and period = any(${mois}::date[])
    order by period
  `;
  if (existants.length > 0) {
    return { ok: false, erreur: `Ces mois sont deja couverts : ${existants.map((r) => r.mois).join(", ")}.` };
  }

  const lot = randomUUID();
  const statut = saisieDirecte ? STATUT_VERSEMENT.valide : STATUT_VERSEMENT.enAttente;
  for (const m of mois) {
    await sql`
      insert into contributions
        (member_id, period, kind, amount, paid_on, method, reference, note,
         batch_id, status, declared_by, reviewed_by, reviewed_at)
      values
        (${membreCible}::uuid, ${m}::date, ${KIND_VERSEMENT.cotisation},
         ${Math.round(montantParMois)}, ${dateVersement}::date, ${mode}, ${reference}, ${note},
         ${lot}::uuid, ${statut}, ${auteur.id}::uuid,
         ${saisieDirecte ? auteur.id : null}::uuid,
         ${saisieDirecte ? new Date().toISOString() : null}::timestamptz)
    `;
  }

  await enregistrerJustificatif(donnees, lot, membreCible, auteur.id);

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "declaration_versement",
    { entite: "contributions", id: lot },
    { membreCible, mois, montantTotal: Math.round(montantParMois) * nbMois },
  );
  revalidatePath("/", "layout");
  const objet = nbMois === 1 ? "Versement" : `${nbMois} mois declares en un seul versement`;
  return {
    ok: true,
    message: saisieDirecte
      ? `${objet} enregistre et valide.`
      : `${objet} — en attente de validation par le tresorier.`,
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
  const id = String(donnees.get("id") ?? "");
  if (!id) return { ok: false, erreur: "Versement introuvable." };

  const sql = db();
  const rows = await sql`select status from contributions where id = ${id}::uuid`;
  const v = rows[0];
  if (!v) return { ok: false, erreur: "Versement introuvable." };
  if (v.status !== STATUT_VERSEMENT.enAttente) {
    return { ok: false, erreur: "Ce versement est deja traite." };
  }

  await sql`
    update contributions
    set status = ${STATUT_VERSEMENT.valide}, reviewed_by = ${auteur.id}::uuid,
        reviewed_at = now(), review_note = null
    where id = ${id}::uuid
  `;
  await journaliser({ id: auteur.id, nom: auteur.nom }, "validation_versement", {
    entite: "contributions",
    id,
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Versement valide." };
}

export async function rejeterVersement(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerRole("tresorier", "president");
  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!motif) return { ok: false, erreur: "Indiquez le motif du rejet." };

  const sql = db();
  const rows = await sql`select id from contributions where id = ${id}::uuid`;
  if (!rows[0]) return { ok: false, erreur: "Versement introuvable." };

  await sql`
    update contributions
    set status = ${STATUT_VERSEMENT.rejete}, reviewed_by = ${auteur.id}::uuid,
        reviewed_at = now(), review_note = ${motif}
    where id = ${id}::uuid and status = ${STATUT_VERSEMENT.enAttente}
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "rejet_versement",
    { entite: "contributions", id },
    { motif },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Versement rejete. Le mois redevient disponible." };
}

/**
 * Joint un justificatif a un versement deja declare : on oublie souvent la piece
 * sur le moment, et il ne faut pas avoir a ressaisir le versement pour la fournir.
 */
export async function joindreJustificatif(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const lot = String(donnees.get("lot") ?? "");
  if (!lot) return { ok: false, erreur: "Versement introuvable." };

  const sql = db();
  const rows = await sql`
    select distinct member_id from contributions where batch_id = ${lot}::uuid
  `;
  if (rows.length === 0) return { ok: false, erreur: "Versement introuvable." };

  const membreCible = String(rows[0].member_id);
  if (membreCible !== auteur.id && !peut(auteur, "saisirVersementValide")) {
    return { ok: false, erreur: "Vous ne pouvez joindre une piece qu'a vos propres versements." };
  }

  const resultat = await enregistrerJustificatif(donnees, lot, membreCible, auteur.id);
  if (!resultat.joint) {
    return { ok: false, erreur: `Justificatif non enregistre : ${resultat.motif ?? "aucun fichier"}.` };
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "justificatif_joint",
    { entite: "payment_proofs", id: lot },
    { membreCible },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Justificatif joint." };
}

/** R3 : le membre declare son retard au groupe ; la trace est conservee ici. */
export async function declarerRetard(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerMembre();
  const membreCible = String(donnees.get("membreId") ?? auteur.id);
  const mois = String(donnees.get("mois") ?? "").slice(0, 10);
  const note = String(donnees.get("note") ?? "").trim() || null;

  if (membreCible !== auteur.id && auteur.role !== "president") {
    return { ok: false, erreur: "Seul le president peut enregistrer la declaration d'un autre membre." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mois)) return { ok: false, erreur: "Mois invalide." };

  try {
    const sql = db();
    await sql`
      insert into late_declarations (member_id, period, note, created_by)
      values (${membreCible}::uuid, ${mois}::date, ${note}, ${auteur.id}::uuid)
      on conflict (member_id, period) do update set note = excluded.note
    `;
  } catch {
    return {
      ok: false,
      erreur:
        "La table des declarations n'existe pas encore. Executez scripts/migration-r3.sql dans la console Neon.",
    };
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "declaration_retard",
    { entite: "late_declarations" },
    { membreCible, mois },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Retard declare. Le benefice du plan de redressement (R5) est preserve." };
}
