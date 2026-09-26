-- Frais de depot preleves sur les virements vers le compte-titres.
--
-- Purement additif : une colonne, valeur par defaut zero, aucune ligne modifiee.
-- A executer une fois dans le SQL Editor de Neon.
--
-- `amount` reste ce qui quitte la caisse ; `fees` en est la part retenue par la
-- SGI a l'arrivee. Le net reellement investi vaut donc amount - fees. Le calcul
-- du TRI continue de porter sur `amount`, c'est-a-dire l'argent reellement
-- engage : des frais ne sont pas un placement.

alter table securities_transfers
  add column if not exists fees bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'securities_transfers_fees_check'
  ) then
    alter table securities_transfers
      add constraint securities_transfers_fees_check check (fees >= 0 and fees <= amount);
  end if;
end $$;
