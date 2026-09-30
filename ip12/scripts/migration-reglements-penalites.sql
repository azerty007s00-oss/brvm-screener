-- Declaration par le membre du reglement d'une penalite.
--
-- Purement additif : une table, aucune ligne ni colonne existante modifiee.
-- A executer une fois dans le SQL Editor de Neon.
--
-- POURQUOI UNE TABLE A PART, ET NON UN STATUT DE PLUS SUR `penalties`.
--
-- Le statut de la penalite commande tout le reste : `due` la fait compter dans
-- la dette, dans le seuil de R5 et dans la relance ; `payee` la fait entrer en
-- caisse. Un statut « declaree » aurait donc fait disparaitre la dette sur la
-- seule parole du membre -- et avec elle le seuil d'exclusion. La penalite reste
-- `due` jusqu'a la validation du tresorier ; la declaration vit ici.
--
-- POURQUOI PAS DANS `contributions`, DONT LA CONTRAINTE ACCEPTE 'penalite'.
--
-- Aucune lecture de cette table ne filtre sur `kind` : une ligne de penalite y
-- serait aussitot comptee comme une cotisation du mois porte par `period` --
-- part de l'art. 12 gonflee, mois marque paye. Le chemin existait dans la
-- contrainte ; il n'a jamais ete percé, et ne le sera pas par ici.
--
-- `batch_id` sert de lot a `payment_proofs`, comme pour un versement : le membre
-- joint la capture de son transfert par le meme mecanisme.

create table if not exists penalty_settlements (
  id            uuid primary key default gen_random_uuid(),
  penalty_id    uuid not null references penalties(id) on delete cascade,
  member_id     uuid not null references members(id) on delete cascade,
  quantity      integer not null check (quantity > 0),
  paid_on       date not null,
  method        text not null default 'mobile_money'
                  check (method in ('especes','mobile_money','virement','cheque')),
  reference     text,
  note          text,
  batch_id      uuid not null default gen_random_uuid(),
  status        text not null default 'en_attente'
                  check (status in ('en_attente','validee','rejetee')),
  declared_by   uuid not null references members(id),
  reviewed_by   uuid references members(id),
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz not null default now()
);

create index if not exists penalty_settlements_penalty_idx
  on penalty_settlements (penalty_id);

create index if not exists penalty_settlements_membre_idx
  on penalty_settlements (member_id);

-- Une seule declaration en attente par ligne de penalite : deux declarations
-- concurrentes sur la meme ligne feraient solder deux fois la meme quantite.
create unique index if not exists penalty_settlements_une_attente_idx
  on penalty_settlements (penalty_id) where status = 'en_attente';
