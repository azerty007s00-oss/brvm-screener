import "server-only";
import { db } from "./db";
import { partsEnBase } from "./queries";
import type { Faits, LignePenalite, LigneRachat, LigneRappel, LigneReglement, LigneVersement } from "./fil";

/*
 * Les horodatages sont rendus en heure UTC, celle d'Abidjan, sans fuseau : le
 * fil les trie comme des chaines, et une date seule (« 2026-10-11 ») s'y range
 * avant l'horodatage du meme jour.
 */

/**
 * Tout ce qui touche a la part d'un membre, et aux parts rachetees qu'il
 * detient sans les avoir fusionnees : la matiere du fil (lib/fil).
 *
 * Cinq lectures en parallele, un seul aller-retour d'attente. Les tables qui
 * arrivent avec une migration (reglements de penalites, rachats) peuvent
 * manquer : leur absence vide leur part du fil, sans faire tomber la page.
 */
export async function faitsDuMembre(membreId: string): Promise<{ faits: Faits; parts: Map<string, string> }> {
  const sql = db();
  const parts = new Map<string, string>();
  if (await partsEnBase()) {
    const rows = await sql`select id, full_name from members where holder_id = ${membreId}::uuid`;
    for (const r of rows) parts.set(String(r.id), String(r.full_name));
  }
  const ids = [membreId, ...parts.keys()];

  const [versements, penalites, reglements, rappels, rachats] = await Promise.all([
    sql`
      select coalesce(c.batch_id, c.id)::text as lot, c.member_id::text as membre_id,
             to_char(c.period, 'YYYY-MM-DD') as mois, c.amount as montant, c.method as mode,
             c.reference, c.note, c.status as statut, c.review_note as motif,
             to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as cree_le,
             to_char(c.reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as vise_le,
             c.declared_by::text as declare_par, d.full_name as declare_par_nom, r.full_name as vise_par_nom
      from contributions c
      left join members d on d.id = c.declared_by
      left join members r on r.id = c.reviewed_by
      where c.member_id = any(${ids}::uuid[])
      order by c.period
    `.then((r) => r as LigneVersement[]),
    sql`
      select p.id::text as id, p.member_id::text as membre_id, p.kind as nature,
             (p.quantity * p.unit_amount) as montant, p.reason as motif,
             to_char(p.incurred_on, 'YYYY-MM-DD') as constatee_le, p.status as statut,
             to_char(p.settled_on, 'YYYY-MM-DD') as reglee_le, p.settlement_note as note_reglement,
             to_char(p.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as resolue_le,
             r.full_name as resolu_par_nom
      from penalties p
      left join members r on r.id = p.resolved_by
      where p.member_id = any(${ids}::uuid[])
    `.then((r) => r as LignePenalite[]),
    sql`
      select s.batch_id::text as lot, s.penalty_id::text as penalite_id, s.member_id::text as membre_id,
             (s.quantity * p.unit_amount) as montant, s.method as mode, s.status as statut,
             s.review_note as motif_rejet,
             to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as cree_le,
             to_char(s.reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as vise_le,
             r.full_name as vise_par_nom, p.kind as nature, p.reason as motif_penalite
      from penalty_settlements s
      join penalties p on p.id = s.penalty_id
      left join members r on r.id = s.reviewed_by
      where s.member_id = any(${ids}::uuid[])
    `.then((r) => r as LigneReglement[]).catch(() => [] as LigneReglement[]),
    sql`
      select member_id::text as membre_id, channel as canal, to_char(period, 'YYYY-MM-DD') as mois,
             to_char(sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as envoye_le
      from reminder_log
      where member_id = any(${ids}::uuid[]) and ok
    `.then((r) => r as LigneRappel[]).catch(() => [] as LigneRappel[]),
    sql`
      select to_char(b.bought_on, 'YYYY-MM-DD') as achete_le, b.fraction, b.price as prix, s.full_name as vendeur
      from share_buybacks b
      join members s on s.id = b.seller_id
      where b.buyer_id = ${membreId}::uuid
    `.then((r) => r as LigneRachat[]).catch(() => [] as LigneRachat[]),
  ]);

  return { faits: { versements, penalites, reglements, rappels, rachats }, parts };
}
