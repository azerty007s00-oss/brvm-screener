-- Les statuts du club (PDF signe et articles lus) et les resolutions.
-- Le site cree ces tables lui-meme (src/lib/statuts-base.ts) ; ce texte est le meme.

create table if not exists club_statutes (
    id          uuid primary key default gen_random_uuid(),
    file_name   text not null,
    pdf_base64  text not null,
    articles    jsonb not null,
    uploaded_by uuid references members(id) on delete set null,
    uploaded_at timestamptz not null default now()
  );

create table if not exists club_resolutions (
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
  );
