"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerMembre, exigerRole } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import { reglagesEffectifs } from "@/lib/queries";
import { decalerMois } from "@/lib/settings";
import { KIND_VERSEMENT, METHODE, STATUT_VERSEMENT } from "@/lib/valeurs";
import type { EtatFormulaire } from "./auth";

const METHODES = Object.values(METHODE) as string[];

/**
 * Declare un versement en caisse. Il reste "en attente" jusqu'a validation du
 * tresorier, mais il est visible de tous des la declaration : c'est le suivi
 * partage voulu par le club.
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

  if (membreCible !== auteur.id && auteur.role !== "president") {
    return { ok: false, erreur: "Seul le president peut declarer un versement pour un autre membre." };
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
  for (const m of mois) {
    await sql`
      insert into contributions
        (member_id, period, kind, amount, paid_on, method, reference, note,
         batch_id, status, declared_by)
      values
        (${membreCible}::uuid, ${m}::date, ${KIND_VERSEMENT.cotisation},
         ${Math.round(montantParMois)}, ${dateVersement}::date, ${mode}, ${reference}, ${note},
         ${lot}::uuid, ${STATUT_VERSEMENT.enAttente}, ${auteur.id}::uuid)
    `;
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "declaration_versement",
    { entite: "contributions", id: lot },
    { membreCible, mois, montantTotal: Math.round(montantParMois) * nbMois },
  );
  revalidatePath("/", "layout");
  return {
    ok: true,
    message:
      nbMois === 1
        ? "Versement declare. Il attend la validation du tresorier."
        : `${nbMois} mois declares en un seul versement. Ils attendent la validation du tresorier.`,
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
  const rows = await sql`
    select c.member_id, c.status, m.role as role_membre
    from contributions c join members m on m.id = c.member_id
    where c.id = ${id}::uuid
  `;
  const v = rows[0];
  if (!v) return { ok: false, erreur: "Versement introuvable." };
  if (v.status !== STATUT_VERSEMENT.enAttente) return { ok: false, erreur: "Ce versement est deja traite." };
  if (String(v.member_id) === auteur.id) {
    return { ok: false, erreur: "Vous ne pouvez pas valider votre propre versement." };
  }
  if (auteur.role === "president" && v.role_membre !== "tresorier") {
    return { ok: false, erreur: "La validation des encaissements revient au tresorier." };
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
  const rows = await sql`select member_id from contributions where id = ${id}::uuid`;
  if (!rows[0]) return { ok: false, erreur: "Versement introuvable." };
  if (String(rows[0].member_id) === auteur.id) {
    return { ok: false, erreur: "Vous ne pouvez pas statuer sur votre propre versement." };
  }

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
