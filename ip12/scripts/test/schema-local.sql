-- Replique locale du schema de production, POUR LES TESTS UNIQUEMENT.
--
-- Ne jamais executer sur la base Neon : elle porte deja ce schema, avec les
-- donnees du club. Ce fichier sert a monter un PostgreSQL jetable pour verifier
-- que les requetes de l'application sont valides avant tout deploiement.
--
-- Releve depuis information_schema le 13/09/2026, contraintes CHECK relevees
-- depuis pg_constraint le meme jour. Les reproduire ici n'est pas cosmetique :
-- leur absence avait laisse passer une valeur de direction erronee.

create extension if not exists pgcrypto;

create table members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  phone text,
  title text,
  role text not null default 'membre'
    check (role in ('president','vice_president','tresorier','secretaire','membre')),
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
  kind text not null default 'cotisation' check (kind in ('cotisation','penalite')),
  amount bigint not null check (amount > 0),
  paid_on date not null,
  method text not null default 'mobile_money'
    check (method in ('especes','mobile_money','virement','cheque')),
  reference text,
  note text,
  batch_id uuid not null,
  status text not null default 'en_attente'
    check (status in ('en_attente','valide','rejete')),
  declared_by uuid not null references members(id),
  reviewed_by uuid references members(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

create table securities_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_date date not null,
  amount bigint not null check (amount > 0),
  fees bigint not null default 0 check (fees >= 0 and fees <= amount),
  direction text not null check (direction in ('vers_titres','retrait')),
  note text,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table portfolio_valuations (
  id uuid primary key default gen_random_uuid(),
  valued_on date not null,
  total_value bigint not null check (total_value >= 0),
  cash_part bigint check (cash_part >= 0),
  note text,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table penalties (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  kind text not null default 'retard' check (kind in ('retard','absence','autre')),
  quantity integer not null default 1 check (quantity > 0),
  unit_amount bigint not null check (unit_amount > 0),
  reason text,
  incurred_on date not null default current_date,
  status text not null default 'due' check (status in ('due','payee','annulee')),
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

create table payment_proofs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  member_id uuid not null references members(id) on delete cascade,
  filename text not null,
  mime text not null,
  byte_size integer not null check (byte_size > 0),
  data bytea,
  uploaded_by uuid not null references members(id),
  created_at timestamptz not null default now(),
  blob_url text
);

create table member_rules (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  kind text not null check (kind in ('cotisation','penalite_multiplicateur','avance_min','plan_redressement','note')),
  numeric_value numeric,
  starts_on date,
  ends_on date,
  is_active boolean not null default true,
  note text,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table member_exits (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id) on delete cascade,
  exit_date date not null,
  reason text,
  gross_value bigint not null default 0 check (gross_value >= 0),
  fees bigint not null default 0 check (fees >= 0),
  net_paid bigint not null default 0 check (net_paid >= 0),
  forfeited bigint not null default 0 check (forfeited >= 0),
  note text,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table meetings (
  id uuid primary key default gen_random_uuid(),
  meeting_date date not null,
  title text,
  note text,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table attendances (
  meeting_id uuid not null references meetings(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  status text not null default 'present' check (status in ('present','absent','excuse')),
  note text
);

create table cash_movements (
  id uuid primary key default gen_random_uuid(),
  movement_date date not null,
  direction text not null check (direction in ('depense','recette')),
  category text not null default 'autre',
  amount bigint not null check (amount > 0),
  note text,
  status text not null default 'en_attente' check (status in ('en_attente','valide','rejete')),
  created_by uuid not null references members(id),
  reviewed_by uuid references members(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);
