-- Schema IP12 - club d'investissement Investment Pioneers
-- Idempotent : peut etre rejoue sans risque.

create table if not exists membres (
  id                   serial primary key,
  nom                  text not null,
  email                text not null unique,
  telephone            text,
  role                 text not null default 'membre' check (role in ('president','tresorier','membre')),
  password_hash        text,
  must_change_password boolean not null default true,
  actif                boolean not null default true,
  date_adhesion        date not null default current_date,
  created_at           timestamptz not null default now()
);

-- Cotisations encaissees en caisse. Une ligne par mois couvert :
-- une avance de 3 mois cree 3 lignes, ce qui rend le suivi mensuel trivial.
create table if not exists versements (
  id            serial primary key,
  membre_id     integer not null references membres(id) on delete cascade,
  mois_couvert  date not null,
  montant       integer not null check (montant > 0),
  date_versement date not null,
  mode          text not null default 'especes'
                check (mode in ('especes','mobile_money','virement','cheque')),
  statut        text not null default 'en_attente'
                check (statut in ('en_attente','valide','rejete')),
  saisi_par     integer references membres(id),
  valide_par    integer references membres(id),
  valide_le     timestamptz,
  motif_rejet   text,
  note          text,
  created_at    timestamptz not null default now()
);

-- Un membre ne peut avoir qu'un versement vivant par mois ; un rejet libere le mois.
create unique index if not exists versements_mois_unique
  on versements (membre_id, mois_couvert)
  where statut <> 'rejete';

create index if not exists versements_statut_idx on versements (statut);

-- Virements de la caisse vers le compte-titres Phoenix. Saisis et valides par le president.
create table if not exists apports_titres (
  id         serial primary key,
  date_apport date not null,
  montant    integer not null check (montant > 0),
  reference  text,
  statut     text not null default 'en_attente' check (statut in ('en_attente','valide')),
  saisi_par  integer references membres(id),
  valide_par integer references membres(id),
  valide_le  timestamptz,
  note       text,
  created_at timestamptz not null default now()
);

-- Releves du compte-titres, saisis par le president tous les 2 mois.
create table if not exists valorisations (
  id                serial primary key,
  date_valo         date not null unique,
  valeur_actions    bigint not null default 0 check (valeur_actions >= 0),
  valeur_liquidites bigint not null default 0 check (valeur_liquidites >= 0),
  saisi_par         integer references membres(id),
  note              text,
  created_at        timestamptz not null default now()
);

-- Penalites art. 9, doublees par R4 au-dela de 3 mois de retard.
create table if not exists penalites (
  id            serial primary key,
  membre_id     integer not null references membres(id) on delete cascade,
  mois_concerne date not null,
  montant       integer not null check (montant >= 0),
  taux          numeric(5,4) not null,
  doublee       boolean not null default false,
  statut        text not null default 'due' check (statut in ('due','payee','annulee')),
  motif         text,
  created_at    timestamptz not null default now(),
  unique (membre_id, mois_concerne)
);

-- R3 : declaration du retard sur le groupe WhatsApp, tracee ici.
create table if not exists declarations_retard (
  id            serial primary key,
  membre_id     integer not null references membres(id) on delete cascade,
  mois_concerne date not null,
  declare_le    timestamptz not null default now(),
  note          text,
  unique (membre_id, mois_concerne)
);

-- Relances du 10 : une seule par mois, quel que soit le nombre de declenchements.
create table if not exists relances (
  id            serial primary key,
  mois_concerne date not null unique,
  envoye_le     timestamptz not null default now(),
  destinataires integer not null default 0,
  detail        text
);

-- Journal d'audit : qui a valide quoi, et quand.
create table if not exists journal (
  id         serial primary key,
  membre_id  integer references membres(id) on delete set null,
  action     text not null,
  details    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists journal_date_idx on journal (created_at desc);
