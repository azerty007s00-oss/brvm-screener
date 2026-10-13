-- Rachat des parts d'un membre sortant par d'autres membres (octobre 2026).
--
-- A executer une fois dans le SQL Editor de Neon. Rien d'existant n'est
-- modifie : deux colonnes ajoutees, deux contraintes relachees, une table
-- ajoutee. Tant que ce script n'a pas tourne, le site enregistre les sorties
-- comme avant, rachetees par le club seul.
--
-- UNE PART RACHETEE EST UNE LIGNE DU REGISTRE DES MEMBRES, rattachee a son
-- detenteur (`holder_id`). Elle a ses propres cotisations, a hauteur de sa
-- fraction d'une part (`part_fraction`), ses propres retards et ses propres
-- penalites, comme toute part. Elle n'a ni adresse ni mot de passe : elle ne se
-- connecte pas, et le courrier qui la concerne va a son detenteur.

alter table members add column if not exists holder_id uuid references members(id);
alter table members add column if not exists part_fraction numeric(9, 6)
  check (part_fraction is null or (part_fraction > 0 and part_fraction <= 1));
alter table members alter column email drop not null;
alter table members alter column password_hash drop not null;

-- Une ligne par acheteur. `weight` est le poids des cotisations du sortant qui
-- passe a la part rachetee : il compte dans sa valeur comme des cotisations.
-- `price` est le prix convenu ; `paid_to_club` en est la part que l'acheteur
-- verse au club pour solder les penalites du sortant, le reste allant au
-- sortant directement.
create table if not exists share_buybacks (
  id uuid primary key default gen_random_uuid(),
  exit_id uuid not null references member_exits(id) on delete cascade,
  seller_id uuid not null references members(id),
  buyer_id uuid not null references members(id),
  part_id uuid not null references members(id),
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

create index if not exists share_buybacks_part on share_buybacks (part_id);
create index if not exists members_holder on members (holder_id);
