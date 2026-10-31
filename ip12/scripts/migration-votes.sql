-- Le vote en ligne, pondere par les parts.
--
-- Purement additif. Le site cree ces tables lui-meme au premier besoin
-- (src/lib/votes.ts, meme texte) : ce fichier n'a pas a etre execute dans
-- Neon. Il sert de trace, et la verification des requetes l'applique a sa
-- base d'essai.
--
-- `snapshot` fige a la cloture les electeurs et leur poids (JSON) : le
-- resultat proclame ne bouge plus quand les parts bougent ensuite. Le vote
-- est public : `vote_ballots` dit qui a vote quoi, et chacun le lit.

create table if not exists votes (
  id            uuid primary key default gen_random_uuid(),
  question      text not null,
  details       text,
  majority      text not null,
  closes_at     timestamptz not null,
  target_member uuid references members(id) on delete set null,
  status        text not null default 'ouvert',
  created_by    uuid not null references members(id),
  created_at    timestamptz not null default now(),
  reminded_at   timestamptz,
  closed_at     timestamptz,
  snapshot      text,
  cancel_reason text,
  cancelled_by  uuid references members(id),
  cancelled_at  timestamptz
);

create table if not exists vote_ballots (
  vote_id   uuid not null references votes(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  choice    text not null,
  cast_at   timestamptz not null default now(),
  primary key (vote_id, member_id)
);
