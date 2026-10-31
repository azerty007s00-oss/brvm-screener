import "server-only";
import { db } from "./db";
import { avecTables } from "./tables-auto";
import { lignesDuPdf } from "./bourse-base";
import { decouperStatuts, type Article, type Resolution, type StatutResolution } from "./statuts";

/** Le meme texte que scripts/migration-statuts.sql. */
const TABLES = [
  `create table if not exists club_statutes (
    id          uuid primary key default gen_random_uuid(),
    file_name   text not null,
    pdf_base64  text not null,
    articles    jsonb not null,
    uploaded_by uuid references members(id) on delete set null,
    uploaded_at timestamptz not null default now()
  )`,
  `create table if not exists club_resolutions (
    code       text primary key,
    decided_on date not null,
    date_label text not null,
    title      text not null,
    detail     text not null default '',
    vote       text not null default '',
    articles   int[] not null default '{}',
    status     text not null check (status in ('adoptee', 'a_confirmer', 'remplacee')),
    precision  text,
    created_by uuid references members(id) on delete set null,
    created_at timestamptz not null default now()
  )`,
];

async function lire<T>(f: () => Promise<T>, defaut: T): Promise<T> {
  try {
    return await avecTables(TABLES, f);
  } catch {
    return defaut;
  }
}

export type StatutsEnBase = { id: string; fichier: string; importeLe: string; articles: Article[] };

/** Les statuts en vigueur : la derniere version importee. */
export async function statutsEnVigueur(): Promise<StatutsEnBase | null> {
  const sql = db();
  return lire(async () => {
    const r = await sql`
      select id::text as id, file_name, to_char(uploaded_at at time zone 'UTC', 'YYYY-MM-DD') as le, articles
      from club_statutes order by uploaded_at desc limit 1
    `;
    if (r.length === 0) return null;
    return { id: String(r[0].id), fichier: String(r[0].file_name), importeLe: String(r[0].le), articles: r[0].articles as Article[] };
  }, null);
}

export async function pdfDesStatuts(): Promise<{ fichier: string; octets: Buffer } | null> {
  const sql = db();
  return lire(async () => {
    const r = await sql`select file_name, pdf_base64 from club_statutes order by uploaded_at desc limit 1`;
    return r[0] ? { fichier: String(r[0].file_name), octets: Buffer.from(String(r[0].pdf_base64), "base64") } : null;
  }, null);
}

/** Lit le PDF ; null s'il n'a pas la forme de statuts (au moins dix articles numerotes). */
export async function lireStatutsPdf(octets: Uint8Array): Promise<Article[] | null> {
  const lignes = (await lignesDuPdf(octets)).map((cellules) => cellules.join(" "));
  const articles = decouperStatuts(lignes);
  return articles.length >= 10 ? articles : null;
}

export async function enregistrerStatuts(fichier: string, octets: Uint8Array, articles: Article[], auteurId: string): Promise<void> {
  const sql = db();
  await avecTables(TABLES, () => sql`
    insert into club_statutes (file_name, pdf_base64, articles, uploaded_by)
    values (${fichier}, ${Buffer.from(octets).toString("base64")}, ${JSON.stringify(articles)}::jsonb, ${auteurId}::uuid)
  `);
}

/* -------------------------------------------------------------- resolutions */

export async function listerResolutions(): Promise<Resolution[]> {
  const sql = db();
  return lire(async () => {
    const rows = await sql`
      select code, to_char(decided_on, 'YYYY-MM-DD') as le, date_label, title, detail, vote, articles, status, precision
      from club_resolutions order by decided_on desc, code desc
    `;
    return rows.map((r) => ({
      code: String(r.code),
      decideeLe: String(r.le),
      quand: String(r.date_label),
      titre: String(r.title),
      detail: String(r.detail),
      vote: String(r.vote),
      articles: (r.articles as number[]).map(Number),
      statut: String(r.status) as StatutResolution,
      precision: r.precision === null ? null : String(r.precision),
    }));
  }, []);
}

/** Inscrit ou remplace des resolutions, par leur code. */
export async function enregistrerResolutions(resolutions: Resolution[], auteurId: string): Promise<void> {
  if (resolutions.length === 0) return;
  const sql = db();
  for (const r of resolutions) {
    await avecTables(TABLES, () => sql`
      insert into club_resolutions (code, decided_on, date_label, title, detail, vote, articles, status, precision, created_by)
      values (${r.code}, ${r.decideeLe}::date, ${r.quand}, ${r.titre}, ${r.detail}, ${r.vote}, ${r.articles}::int[],
              ${r.statut}, ${r.precision}, ${auteurId}::uuid)
      on conflict (code) do update set
        decided_on = excluded.decided_on, date_label = excluded.date_label, title = excluded.title,
        detail = excluded.detail, vote = excluded.vote, articles = excluded.articles,
        status = excluded.status, precision = excluded.precision
    `);
  }
}

export async function supprimerResolution(code: string): Promise<boolean> {
  const sql = db();
  const r = await avecTables(TABLES, () => sql`delete from club_resolutions where code = ${code} returning code`);
  return r.length > 0;
}
