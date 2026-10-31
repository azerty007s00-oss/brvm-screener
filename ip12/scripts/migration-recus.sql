-- Les numeros des recus de versement, attribues une fois pour toutes.
-- Le site cree cette table lui-meme (src/lib/recus.ts) ; ce texte est le meme.

create table if not exists receipt_numbers (
    lot        text primary key,
    year       int not null,
    rank       int not null,
    created_at timestamptz not null default now(),
    unique (year, rank)
  );
