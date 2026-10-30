import "server-only";
import { db } from "./db";
import { avecTables } from "./tables-auto";

/** Le meme texte que scripts/migration-fuseaux.sql. */
const TABLES = [
  `create table if not exists member_time_zones (
    member_id  uuid primary key references members(id) on delete cascade,
    time_zone  text not null,
    updated_at timestamptz not null default now()
  )`,
];

/** Le fuseau de chaque membre qui a ouvert le site, par identifiant. Vide si rien n'est lisible. */
export async function fuseauxDesMembres(): Promise<Map<string, string>> {
  const sql = db();
  try {
    const rows = await avecTables(TABLES, () => sql`select member_id::text as membre, time_zone as fuseau from member_time_zones`);
    return new Map(rows.map((r) => [String(r.membre), String(r.fuseau)]));
  } catch {
    return new Map();
  }
}

export async function noterFuseauMembre(membreId: string, fuseau: string): Promise<void> {
  const sql = db();
  await avecTables(TABLES, () => sql`
    insert into member_time_zones (member_id, time_zone, updated_at) values (${membreId}::uuid, ${fuseau}, now())
    on conflict (member_id) do update set time_zone = excluded.time_zone, updated_at = now()
  `);
}
