-- Replique locale du schema de production, POUR LES TESTS UNIQUEMENT.
--
-- Ne jamais executer sur la base Neon : elle porte deja ce schema, avec les
-- donnees du club. Ce fichier sert a monter un PostgreSQL jetable pour verifier
-- que les requetes de l'application sont valides avant tout deploiement.
--
-- Releve depuis information_schema le 13/09/2026. Les contraintes CHECK n'etaient
-- pas visibles : elles sont reproduites ici d'apres src/lib/valeurs.ts.

create extension if not exists pgcrypto;

create table members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  phone text,
  title text,
  role text not null default 'membre',
  password_hash text not null,
  must_change_password boolean not null default true,
  is_active boolean not null default true,
  joined_on date not null default current_date,
  created_at timestamptz not null default now()
);

create table contributions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  period date not null,
  kind text not null default 'cotisation',
  amount bigint not null,
  paid_on date not null,
  method text not null default 'mobile_money',
  reference text,
  note text,
  batch_id uuid not null,
  status text not null default 'en_attente',
  declared_by uuid not null references members(id),
  reviewed_by uuid references members(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

create table securities_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_date date not null,
  amount bigint not null,
  direction text not null,
  note text,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table portfolio_valuations (
  id uuid primary key default gen_random_uuid(),
  valued_on date not null,
  total_value bigint not null,
  cash_part bigint,
  note text,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table penalties (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  kind text not null default 'retard',
  quantity integer not null default 1,
  unit_amount bigint not null,
  reason text,
  incurred_on date not null default current_date,
  status text not null default 'due',
  settled_on date,
  settlement_note text,
  created_by uuid not null references members(id),
  resolved_by uuid references members(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  source_key text,
  auto boolean not null default false
);

create table settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  actor_id uuid,
  actor_name text,
  action text not null,
  entity text,
  entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

create table login_attempts (
  id bigserial primary key,
  email text not null,
  ip text,
  ok boolean not null default false,
  attempted_at timestamptz not null default now()
);

create table reminder_log (
  id bigserial primary key,
  period date not null,
  member_id uuid not null references members(id) on delete cascade,
  channel text not null default 'email',
  ok boolean not null default true,
  error text,
  sent_at timestamptz not null default now()
);
