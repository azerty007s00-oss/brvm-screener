-- Le fuseau horaire de chaque membre, lu dans son navigateur.
--
-- Purement additif. Le site cree cette table lui-meme au premier besoin
-- (src/lib/fuseau-membres.ts, meme texte) : ce fichier n'a pas a etre
-- execute dans Neon. Il sert de trace, et la verification des requetes
-- l'applique a sa base d'essai.
--
-- Les membres vivent a Abidjan, en France, au Canada et en Chine : la
-- convocation et les alertes donnent l'heure de la reunion en GMT, puis
-- celle de chacun.

create table if not exists member_time_zones (
  member_id  uuid primary key references members(id) on delete cascade,
  time_zone  text not null,
  updated_at timestamptz not null default now()
);
