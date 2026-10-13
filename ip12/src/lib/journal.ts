import "server-only";
import { db } from "./db";

/**
 * Trace une action dans audit_log. Le nom de l'auteur est copie a cote de son
 * identifiant : la trace reste lisible meme si le membre est supprime plus tard.
 * Ne doit jamais faire echouer l'action metier.
 */
export async function journaliser(
  acteur: { id: string; nom: string } | null,
  action: string,
  cible?: { entite: string; id?: string },
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    const sql = db();
    await sql`
      insert into audit_log (actor_id, actor_name, action, entity, entity_id, details)
      values (${acteur?.id ?? null}::uuid, ${acteur?.nom ?? null}, ${action},
              ${cible?.entite ?? null}, ${cible?.id ?? null},
              ${JSON.stringify(details)}::jsonb)
    `;
  } catch {
    // Le journal est un confort, pas une condition de validite.
  }
}

export async function journalRecent(limite = 40) {
  const sql = db();
  const rows = await sql`
    select id, action, entity, entity_id, details, actor_name, created_at
    from audit_log
    order by created_at desc
    limit ${limite}
  `;
  return rows as {
    id: number;
    action: string;
    entity: string | null;
    entity_id: string | null;
    details: unknown;
    actor_name: string | null;
    created_at: string;
  }[];
}

/**
 * Les demandes de mot de passe oublie qui attendent encore quelque chose.
 *
 * Une demande est reglee des que le membre a retrouve l'acces apres l'avoir
 * faite : le president lui a donne un provisoire, il s'est reconnecte, ou il a
 * change son mot de passe. Elle quitte alors la page Administration ; le
 * journal, lui, la garde. Plusieurs demandes du meme membre tombent ensemble.
 *
 * Une demande qui n'a trouve aucun compte (adresse inconnue, compte inactif,
 * plafond atteint) n'a rien a regler : elle reste sept jours, le temps d'etre
 * lue, puis s'efface d'elle-meme.
 *
 * Lue a part du journal recent : prise dans ses trente dernieres lignes, une
 * demande en attente disparaissait au bout de trente autres actions, reglee
 * ou non.
 */
export async function demandesEnAttente(limite = 6) {
  const sql = db();
  const rows = await sql`
    select d.id, d.details, d.created_at
    from audit_log d
    where d.action = 'demande_reinitialisation'
      and (d.entity_id is not null or d.created_at > now() - interval '7 days')
      and not exists (
        select 1
        from audit_log r
        where d.entity_id is not null
          and r.created_at > d.created_at
          and (
            (r.action = 'reinitialisation_mot_de_passe' and r.entity_id = d.entity_id)
            or (r.action in ('connexion', 'changement_mot_de_passe')
                and r.actor_id::text = d.entity_id)
          )
      )
    order by d.created_at desc
    limit ${limite}
  `;
  return rows as { id: number; details: unknown; created_at: string }[];
}
