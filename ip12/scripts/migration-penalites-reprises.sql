-- Pénalités d'un sortant reprises par les acheteurs de ses parts : de la caisse au registre.
--
-- Jusqu'ici, la part des pénalités du sortant que reprenait chaque acheteur
-- attendait dans Caisse, en recette « penalites_sortant » à valider. Personne n'y
-- était nommé au registre et aucun rappel ne la réclamait. Elle devient une
-- pénalité due sur la part rachetée de l'acheteur, comme le fait désormais le
-- site à chaque sortie.
--
-- À exécuter une fois dans l'éditeur SQL de Neon. Sans effet si on le relance :
-- chaque étape vérifie qu'elle n'a pas déjà été faite.

begin;

-- 1. Chaque reprise devient une pénalité due sur la part rachetée. Une reprise
--    déjà encaissée (recette validée) n'est pas réinscrite : elle est payée.
insert into penalties (member_id, kind, quantity, unit_amount, reason, incurred_on, status,
                       created_by, auto)
select b.part_id, 'autre', 1, b.paid_to_club,
       'Pénalités de ' || s.full_name || ' reprises au rachat de '
         || replace(rtrim(rtrim(to_char(b.fraction * 100, 'FM990.99'), '0'), '.'), '.', ',')
         || ' % de ses parts',
       b.bought_on, 'due', b.created_by, false
from share_buybacks b
join members s on s.id = b.seller_id
join members h on h.id = b.buyer_id
where b.paid_to_club > 0
  and not exists (
    select 1 from penalties p
    where p.member_id = b.part_id and p.reason like 'Pénalités de % reprises au rachat de %'
  )
  and not exists (
    select 1 from cash_movements c
    where c.category = 'penalites_sortant' and c.status = 'valide'
      and c.note like '%payées par ' || h.full_name || '%'
  );

-- 2. Les recettes qui les attendaient en caisse, jamais encaissées, sont retirées.
delete from cash_movements
where category = 'penalites_sortant' and status = 'en_attente';

-- 3. Les pénalités du sortant disent qui les a reprises.
update penalties p
set settlement_note = p.settlement_note || ' · reprises par ' || r.qui || ', dues sur leurs parts'
from (
  select b.seller_id,
         string_agg(h.full_name || ' ('
                      || replace(to_char(b.paid_to_club, 'FM999G999G999'), ',', ' ') || ' FCFA)',
                    ', ' order by h.full_name) as qui
  from share_buybacks b
  join members h on h.id = b.buyer_id
  where b.paid_to_club > 0
  group by b.seller_id
) r
where p.member_id = r.seller_id
  and p.settlement_note like 'Soldée à la sortie%'
  and p.settlement_note not like '%reprises par%';

commit;
