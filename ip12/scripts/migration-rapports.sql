-- Les points ajoutes par le bureau a l'ordre du jour d'une seance.
--
-- Purement additif. Le site cree cette table lui-meme au premier besoin
-- (src/lib/rapport-donnees.ts, meme texte) : ce fichier n'a pas a etre
-- execute dans Neon. Il sert de trace, et la verification des requetes
-- l'applique a sa base d'essai.

create table if not exists meeting_points (
  meeting_id uuid primary key references meetings(id) on delete cascade,
  points     text not null default '[]',
  updated_at timestamptz not null default now()
);
