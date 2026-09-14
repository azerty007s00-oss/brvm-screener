-- Ajout de la trace des declarations de retard exigees par R3.
--
-- Purement additif : ne modifie ni ne supprime aucune table existante.
-- A executer une fois dans le SQL Editor de Neon.

create table if not exists late_declarations (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references members(id) on delete cascade,
  period        date not null,
  declared_at   timestamptz not null default now(),
  note          text,
  created_by    uuid not null references members(id),
  unique (member_id, period)
);

create index if not exists late_declarations_member_idx
  on late_declarations (member_id);
