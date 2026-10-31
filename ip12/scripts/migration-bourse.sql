-- La bourse : cours BRVM du soir, releves de la SGI, achats, ventes et dividendes.
-- Le site cree ces tables lui-meme (src/lib/bourse-base.ts) ; ce texte est le meme.

create table if not exists stock_quotes (
    trade_date date not null,
    symbol     text not null,
    name       text not null,
    close      numeric not null,
    change_pct numeric not null default 0,
    primary key (trade_date, symbol)
  );

create table if not exists index_quotes (
    trade_date date not null,
    code       text not null,
    close      numeric not null,
    day_pct    numeric not null,
    ytd_pct    numeric not null,
    primary key (trade_date, code)
  );

create table if not exists sgi_statements (
    id             uuid primary key default gen_random_uuid(),
    statement_date date not null unique,
    cash           numeric not null,
    total          numeric,
    imported_by    uuid references members(id) on delete set null,
    imported_at    timestamptz not null default now()
  );

create table if not exists sgi_statement_lines (
    statement_id uuid not null references sgi_statements(id) on delete cascade,
    symbol       text,
    sgi_name     text not null,
    quantity     numeric not null,
    avg_cost     numeric not null,
    price        numeric not null,
    value        numeric not null
  );

create table if not exists stock_movements (
    id         uuid primary key default gen_random_uuid(),
    trade_date date not null,
    kind       text not null check (kind in ('achat', 'vente', 'dividende')),
    symbol     text not null,
    quantity   numeric not null default 0,
    unit_price numeric not null default 0,
    fees       numeric not null default 0,
    amount     numeric not null default 0,
    note       text,
    created_by uuid references members(id) on delete set null,
    created_at timestamptz not null default now()
  );

create table if not exists brvm_dividends (
    issuer      text not null,
    pay_date    date not null,
    ex_date     date not null,
    fiscal_year text,
    net_amount  numeric,
    notice_url  text,
    symbol      text,
    handled_at  timestamptz,
    quantity    numeric,
    movement_id uuid,
    primary key (issuer, pay_date)
  );

create table if not exists portfolio_daily (
    trade_date date primary key,
    value      numeric not null,
    cash       numeric not null,
    club_ytd   numeric,
    index_ytd  numeric
  );
