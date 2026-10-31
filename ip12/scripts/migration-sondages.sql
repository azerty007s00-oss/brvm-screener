-- Le sondage de date de reunion.
--
-- Purement additif : deux tables, rien d'existant n'est modifie. Le site les
-- cree lui-meme au premier besoin (src/lib/sondage.ts, meme texte) : ce
-- fichier n'a pas a etre execute dans Neon. Il sert de trace, et la
-- verification des requetes l'applique a sa base d'essai.
--
-- Un sondage par mois de reunion. Les horodatages (reminded_at, asked_at,
-- president_reminded_at, eve_sent_at) disent quelles alertes sont deja
-- parties : le passage quotidien ne les renvoie jamais.

create table if not exists meeting_polls (
  id                    uuid primary key default gen_random_uuid(),
  month                 date not null unique,
  closes_at             timestamptz not null,
  status                text not null default 'ouvert',
  chosen_day            date,
  meeting_id            uuid references meetings(id) on delete set null,
  meeting_time          text,
  place                 text,
  reminded_at           timestamptz,
  asked_at              timestamptz,
  president_reminded_at timestamptz,
  eve_sent_at           timestamptz,
  validated_by          uuid references members(id),
  validated_at          timestamptz,
  created_at            timestamptz not null default now()
);

-- Une reponse par membre : les jours du mois qui lui vont (10 a 17). Une
-- liste vide dit « aucun jour ne me va », ce qui n'est pas ne pas repondre.
create table if not exists meeting_poll_answers (
  poll_id     uuid not null references meeting_polls(id) on delete cascade,
  member_id   uuid not null references members(id) on delete cascade,
  days        smallint[] not null default '{}',
  answered_at timestamptz not null default now(),
  primary key (poll_id, member_id)
);
