"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { exigerDroit } from "@/lib/auth";
import { journaliser } from "@/lib/journal";
import {
  absencesParMembre,
  bornesReprisePenalites,
  reglagesEffectifs,
  situationsClub,
} from "@/lib/queries";
import { REGLES, moisLong } from "@/lib/settings";
import { tranchesAbsence } from "@/lib/penalites";
import { KIND_PENALITE, STATUT_PENALITE } from "@/lib/valeurs";
import type { EtatFormulaire } from "./auth";

const NATURES = Object.values(KIND_PENALITE) as string[];

/** Identifiant stable d'une penalite de retard : rend le constat idempotent. */
const cleRetard = (membreId: string, mois: string) => `retard:${membreId}:${mois}`;

/** Motif lisible, qui dit pourquoi la penalite est due et a quel titre. */
function motifPenalite(p: { mois: string; doublee: boolean; figee: boolean }): string {
  const base = `Retard de versement — ${moisLong(p.mois)}`;
  if (p.figee) return `${base} (regle apres l'echeance, penalite acquise, art. 9)`;
  return p.doublee ? `${base} (doublee, R4)` : base;
}

/**
 * Constate les penalites de retard : transcrit dans le registre ce que les statuts
 * prevoient pour les mois impayes.
 *
 * Rejouable sans risque. Une penalite deja reglee ou annulee n'est jamais retouchee :
 * seules celles encore dues voient leur montant reajuste, ce qui compte puisque R4
 * double les trois derniers mois des que le retard atteint trois mois.
 */
export async function constaterPenalitesRetard(
  _precedent: EtatFormulaire,
  _donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const sql = db();
  const [situations, bornes] = await Promise.all([situationsClub(), bornesReprisePenalites()]);

  let creees = 0;
  let reajustees = 0;
  let intactes = 0;
  let couvertes = 0;

  for (const s of situations) {
    const borne = bornes.get(s.membreId);
    for (const p of s.penalites) {
      // Deja compte dans la reprise du tresorier : ne pas le compter une seconde fois.
      if (borne && p.mois <= borne) {
        couvertes++;
        continue;
      }
      const cle = cleRetard(s.membreId, p.mois);
      const echeance = `${p.mois.slice(0, 8)}${String(REGLES.jourEcheance).padStart(2, "0")}`;

      /*
       * On cherche la ligne par sa cle, mais aussi par le couple membre-echeance :
       * la base porte des penalites ecrites par une version anterieure, dont les
       * cles suivaient une autre convention (`retard:2026-04`, sans identifiant de
       * membre, et une ligne `majoration:` distincte pour R4). Ne chercher que ses
       * propres cles reviendrait a recreer ce qui existe deja sous un autre nom.
       */
      const existante = await sql`
        select id, status, unit_amount, source_key from penalties
        where source_key = ${cle}
           or (member_id = ${s.membreId}::uuid
               and kind = ${KIND_PENALITE.retard}
               and incurred_on = ${echeance}::date)
        limit 1
      `;

      if (existante.length === 0) {
        await sql`
          insert into penalties (member_id, kind, quantity, unit_amount, reason,
                                 incurred_on, status, created_by, source_key, auto)
          values (${s.membreId}::uuid, ${KIND_PENALITE.retard}, 1, ${p.montant},
                  ${motifPenalite(p)},
                  ${echeance}::date, ${STATUT_PENALITE.due}, ${auteur.id}::uuid, ${cle}, true)
        `;
        creees++;
        continue;
      }

      const courante = existante[0];
      if (courante.status !== STATUT_PENALITE.due || courante.source_key !== cle) {
        // Soldee, ou ecrite par une autre version : on n'y touche pas.
        intactes++;
      } else if (Number(courante.unit_amount) !== p.montant) {
        await sql`
          update penalties
          set unit_amount = ${p.montant},
              reason = ${motifPenalite(p)}
          where id = ${courante.id}::uuid
        `;
        reajustees++;
      }
    }
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "constat_penalites",
    { entite: "penalties" },
    { creees, reajustees, intactes, couvertes },
  );
  revalidatePath("/", "layout");

  const sousReprise =
    couvertes > 0
      ? ` ${couvertes} mois relevent de la reprise du tresorier et ne sont pas recomptes.`
      : "";

  if (creees === 0 && reajustees === 0) {
    return { ok: true, message: `Le registre est deja a jour, rien a constater.${sousReprise}` };
  }
  const parts: string[] = [];
  if (creees > 0) parts.push(`${creees} penalite${creees > 1 ? "s" : ""} constatee${creees > 1 ? "s" : ""}`);
  if (reajustees > 0) parts.push(`${reajustees} reajustee${reajustees > 1 ? "s" : ""} (R4)`);
  if (intactes > 0) parts.push(`${intactes} deja reglee${intactes > 1 ? "s" : ""} ou annulee${intactes > 1 ? "s" : ""}, laissee${intactes > 1 ? "s" : ""} intacte${intactes > 1 ? "s" : ""}`);
  return { ok: true, message: `${parts.join(", ")}.${sousReprise}` };
}

/** Identifiant stable d'une tranche d'absences : rend le constat idempotent. */
const cleAbsence = (membreId: string, rang: number) => `absence:${membreId}:${rang}`;

/**
 * Constate les penalites d'absence : une tranche d'absences injustifiees, une penalite.
 *
 * Le decompte part de la feuille de presence et d'elle seule. Justifier une absence
 * consiste a la passer en « excuse » sur la seance concernee -- c'est l'office du
 * secretaire -- ce qui la retire du compte penalisable.
 *
 * Rejouable : chaque tranche porte son rang en cle, un nouveau constat n'ajoute que
 * celles qui manquent. Une tranche devenue infondee parce qu'une absence a ete
 * excusee apres coup n'est pas supprimee d'office : une penalite portee au registre
 * se leve par une annulation motivee, non par un effacement silencieux. Le compte
 * rendu la signale pour qu'elle soit reprise a la main.
 */
export async function constaterPenalitesAbsence(
  _precedent: EtatFormulaire,
  _donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const sql = db();
  const [absences, reglages] = await Promise.all([absencesParMembre(), reglagesEffectifs()]);

  let creees = 0;
  let intactes = 0;
  let infondees = 0;

  for (const a of absences) {
    const tranches = tranchesAbsence(a.injustifiees, reglages);

    for (const t of tranches) {
      const cle = cleAbsence(a.membreId, t.rang);
      const existante = await sql`select id from penalties where source_key = ${cle} limit 1`;
      if (existante.length > 0) {
        intactes++;
        continue;
      }

      /*
       * La penalite nait le jour de l'absence qui a ferme la tranche, non le jour
       * du constat : c'est cette date que le registre doit porter, sans quoi toutes
       * les tranches d'un rattrapage sembleraient nees le meme jour.
       */
      const naissance = a.datesInjustifiees[t.absenceDeclenchante - 1] ?? null;
      const motif = `Absence en reunion — ${t.absenceDeclenchante} absences injustifiees (tranche ${t.rang})`;

      if (naissance) {
        await sql`
          insert into penalties (member_id, kind, quantity, unit_amount, reason,
                                 incurred_on, status, created_by, source_key, auto)
          values (${a.membreId}::uuid, ${KIND_PENALITE.absence}, 1, ${t.montant}, ${motif},
                  ${naissance}::date, ${STATUT_PENALITE.due}, ${auteur.id}::uuid, ${cle}, true)
        `;
      } else {
        await sql`
          insert into penalties (member_id, kind, quantity, unit_amount, reason,
                                 status, created_by, source_key, auto)
          values (${a.membreId}::uuid, ${KIND_PENALITE.absence}, 1, ${t.montant}, ${motif},
                  ${STATUT_PENALITE.due}, ${auteur.id}::uuid, ${cle}, true)
        `;
      }
      creees++;
    }

    // Tranches portees au registre que la feuille de presence ne justifie plus.
    const auDela = await sql`
      select count(*)::int as nb from penalties
      where member_id = ${a.membreId}::uuid
        and kind = ${KIND_PENALITE.absence}
        and status = ${STATUT_PENALITE.due}
        and source_key like ${`absence:${a.membreId}:%`}
    `;
    infondees += Math.max(0, Number(auDela[0]?.nb ?? 0) - tranches.length);
  }

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "constat_absences",
    { entite: "penalties" },
    { creees, intactes, infondees },
  );
  revalidatePath("/", "layout");

  const reste =
    infondees > 0
      ? ` ${infondees} tranche${infondees > 1 ? "s" : ""} au registre n'${infondees > 1 ? "ont" : "a"} plus de fondement depuis qu'une absence a ete excusee : a annuler a la main.`
      : "";

  if (creees === 0) {
    return { ok: true, message: `Aucune nouvelle tranche d'absences a constater.${reste}` };
  }
  return {
    ok: true,
    message: `${creees} penalite${creees > 1 ? "s" : ""} d'absence constatee${creees > 1 ? "s" : ""}.${reste}`,
  };
}

/** Penalite saisie a la main : absence en reunion, ou tout autre motif. */
export async function ajouterPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const membreId = String(donnees.get("membreId") ?? "");
  const nature = String(donnees.get("nature") ?? KIND_PENALITE.autre);
  const quantite = Math.max(1, Number(donnees.get("quantite") ?? 1));
  const montantUnitaire = Number(donnees.get("montantUnitaire") ?? 0);
  const motif = String(donnees.get("motif") ?? "").trim() || null;
  const dateConstat = String(donnees.get("dateConstat") ?? "").slice(0, 10);

  if (!membreId) return { ok: false, erreur: "Membre introuvable." };
  if (!NATURES.includes(nature)) return { ok: false, erreur: "Nature de penalite inconnue." };
  if (!Number.isFinite(montantUnitaire) || montantUnitaire <= 0) {
    return { ok: false, erreur: "Montant invalide." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateConstat)) return { ok: false, erreur: "Date invalide." };

  const sql = db();
  await sql`
    insert into penalties (member_id, kind, quantity, unit_amount, reason,
                           incurred_on, status, created_by, auto)
    values (${membreId}::uuid, ${nature}, ${Math.round(quantite)}, ${Math.round(montantUnitaire)},
            ${motif}, ${dateConstat}::date, ${STATUT_PENALITE.due}, ${auteur.id}::uuid, false)
  `;
  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "penalite_manuelle",
    { entite: "penalties" },
    { membreId, nature, montant: Math.round(quantite) * Math.round(montantUnitaire) },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Penalite enregistree." };
}

export async function reglerPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const id = String(donnees.get("id") ?? "");
  const note = String(donnees.get("note") ?? "").trim() || null;

  const sql = db();
  const rows = await sql`
    update penalties
    set status = ${STATUT_PENALITE.payee}, settled_on = current_date,
        settlement_note = ${note}, resolved_by = ${auteur.id}::uuid, resolved_at = now()
    where id = ${id}::uuid and status = ${STATUT_PENALITE.due}
    returning id
  `;
  if (rows.length === 0) return { ok: false, erreur: "Penalite introuvable ou deja soldee." };

  await journaliser({ id: auteur.id, nom: auteur.nom }, "reglement_penalite", {
    entite: "penalties",
    id,
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Penalite marquee reglee." };
}

export async function annulerPenalite(
  _precedent: EtatFormulaire,
  donnees: FormData,
): Promise<EtatFormulaire> {
  const auteur = await exigerDroit("gererPenalites");
  const id = String(donnees.get("id") ?? "");
  const motif = String(donnees.get("motif") ?? "").trim();
  if (!motif) return { ok: false, erreur: "Indiquez le motif de l'annulation." };

  const sql = db();
  const rows = await sql`
    update penalties
    set status = ${STATUT_PENALITE.annulee}, settlement_note = ${motif},
        resolved_by = ${auteur.id}::uuid, resolved_at = now()
    where id = ${id}::uuid and status = ${STATUT_PENALITE.due}
    returning id
  `;
  if (rows.length === 0) return { ok: false, erreur: "Penalite introuvable ou deja soldee." };

  await journaliser(
    { id: auteur.id, nom: auteur.nom },
    "annulation_penalite",
    { entite: "penalties", id },
    { motif },
  );
  revalidatePath("/", "layout");
  return { ok: true, message: "Penalite annulee." };
}
