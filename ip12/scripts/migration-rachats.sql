-- Rachat des parts d'un membre sortant par d'autres membres (octobre 2026).
--
-- Purement additif : une table, aucune ligne modifiee. A executer une fois dans
-- le SQL Editor de Neon. Tant qu'elle n'existe pas, le site enregistre les
-- sorties comme avant, rachetees par le club seul.
--
-- Une ligne par acheteur. `weight` est le poids des cotisations du sortant qui
-- passe a l'acheteur : il compte dans sa part comme ses propres cotisations.
-- `price` est le prix convenu entre eux ; `paid_to_club` en est la part que
-- l'acheteur verse au club pour solder les penalites du sortant, le reste allant
-- au sortant directement.

create table if not exists share_buybacks (
  id uuid primary key default gen_random_uuid(),
  exit_id uuid not null references member_exits(id) on delete cascade,
  seller_id uuid not null references members(id),
  buyer_id uuid not null references members(id),
  bought_on date not null,
  fraction numeric(9, 6) not null check (fraction > 0 and fraction <= 1),
  weight bigint not null check (weight >= 0),
  reference_value bigint not null default 0 check (reference_value >= 0),
  price bigint not null check (price >= 0),
  paid_to_club bigint not null default 0 check (paid_to_club >= 0 and paid_to_club <= price),
  created_by uuid not null references members(id),
  created_at timestamptz not null default now(),
  check (buyer_id <> seller_id)
);

create index if not exists share_buybacks_buyer on share_buybacks (buyer_id);
