-- Le numero Wave de chaque membre.
--
-- Purement additif. Le site cree cette table lui-meme au premier besoin
-- (src/lib/wave-membres.ts, meme texte) : ce fichier n'a pas a etre execute
-- dans Neon. Il sert de trace, et la verification des requetes l'applique a
-- sa base d'essai.
--
-- Le numero (E.164, « +2250708123456 ») pre-remplit « J'ai payé » et permet
-- au tresorier de reconnaitre l'envoi dans son historique Wave. `asked_at`
-- dit que la demande du numero est partie : elle ne part qu'une fois.

create table if not exists member_wave (
  member_id   uuid primary key references members(id) on delete cascade,
  wave_number text,
  asked_at    timestamptz,
  updated_at  timestamptz not null default now()
);
