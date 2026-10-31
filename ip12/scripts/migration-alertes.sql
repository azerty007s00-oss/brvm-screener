-- Les alertes sur le telephone (Web Push).
--
-- Purement additif : une table, aucune ligne ni colonne existante modifiee.
-- A executer une fois dans le SQL Editor de Neon. Tant qu'elle n'a pas tourne,
-- la carte « Etre prevenu sur ce telephone » ne s'affiche pas, et rien d'autre
-- ne change.
--
-- Une ligne par telephone et par navigateur : un membre qui active les alertes
-- sur son telephone et sur son ordinateur en a deux. `endpoint` est l'adresse
-- que le service de notification (Google, Apple, Mozilla) a donnee au
-- navigateur ; `p256dh` et `auth` sont les cles avec lesquelles le site chiffre
-- le message pour lui seul. Rien de tout cela ne permet de lire quoi que ce
-- soit sur le telephone.
--
-- Les cles qui signent les alertes (VAPID) ne sont pas creees ici : le site les
-- fabrique au premier besoin et les range dans `settings`, cle `alertes_vapid`.

create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  failures    integer not null default 0
);

create index if not exists push_subscriptions_member
  on push_subscriptions (member_id);
