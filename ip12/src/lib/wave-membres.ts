import "server-only";
import { db } from "./db";
import { avecTables } from "./tables-auto";
import { envoyerAlertes } from "./alertes";
import { listerMembres } from "./queries";

/** Le meme texte que scripts/migration-wave.sql. */
const TABLES = [
  `create table if not exists member_wave (
    member_id   uuid primary key references members(id) on delete cascade,
    wave_number text,
    asked_at    timestamptz,
    updated_at  timestamptz not null default now()
  )`,
];

/** Le numero Wave de chaque membre qui l'a donne (E.164), par identifiant. Vide si rien n'est lisible. */
export async function numerosWave(): Promise<Map<string, string>> {
  const sql = db();
  try {
    const rows = await avecTables(TABLES, () => sql`
      select member_id::text as membre, wave_number as numero from member_wave where wave_number is not null
    `);
    return new Map(rows.map((r) => [String(r.membre), String(r.numero)]));
  } catch {
    return new Map();
  }
}

export async function numeroWaveDe(membreId: string): Promise<string | null> {
  return (await numerosWave()).get(membreId) ?? null;
}

export async function enregistrerNumeroWave(membreId: string, numero: string): Promise<void> {
  const sql = db();
  await avecTables(TABLES, () => sql`
    insert into member_wave (member_id, wave_number, updated_at) values (${membreId}::uuid, ${numero}, now())
    on conflict (member_id) do update set wave_number = excluded.wave_number, updated_at = now()
  `);
}

/**
 * Parmi ces membres, ceux a qui demander leur numero : sans numero, et jamais
 * sollicites. Ils sont marques dans la meme ecriture : la demande ne part
 * qu'une fois, meme si deux passages se croisent.
 */
export async function aSolliciterPourWave(membreIds: string[], instant: Date): Promise<string[]> {
  if (membreIds.length === 0) return [];
  const sql = db();
  const rows = await avecTables(TABLES, () => sql`
    insert into member_wave (member_id, asked_at)
    select id, ${instant.toISOString()}::timestamptz from unnest(${membreIds}::uuid[]) as id
    on conflict (member_id) do update set asked_at = excluded.asked_at
      where member_wave.asked_at is null and member_wave.wave_number is null
    returning member_id::text as membre
  `);
  return rows.map((r) => String(r.membre));
}

/**
 * La demande du numero, une fois par membre, par une alerte. Ceux qui n'ont
 * pas active les alertes la lisent sur l'accueil, tant que le numero manque.
 */
export async function demanderNumerosWave(instant: Date): Promise<number> {
  const gens = (await listerMembres()).filter((m) => m.actif && !m.titulaireId);
  const ids = await aSolliciterPourWave(
    gens.map((m) => m.id),
    instant,
  );
  if (ids.length > 0) {
    await envoyerAlertes(ids, {
      titre: "On peut avoir ton numéro Wave ?",
      corps: "C'est juste pour que le trésorier sache que c'est toi qui as envoyé. Y a pas drap, 10 secondes chrono.",
      url: "/mon-compte",
      etiquette: "numero-wave",
    });
  }
  return ids.length;
}
