-- Fusion des parts rachetées dans la part de leur acheteur (décision du bureau, octobre 2026).
--
-- Chaque part rachetée avait sa ligne, ses mois et ses rappels : deux versements,
-- deux validations et deux courriers par mois pour un seul payeur. Ce script
-- reporte sur l'acheteur tout ce qui était inscrit au nom de sa part (versements,
-- pénalités, règlements, justificatifs, rappels), rattache le rachat à l'acheteur,
-- puis retire la ligne de la part. Le site ajoute alors la fraction rachetée à la
-- cotisation de l'acheteur, à partir de la première échéance qui suit le rachat :
-- 7 500 FCFA par mois pour la moitié d'une part.
--
-- À exécuter une fois dans l'éditeur SQL de Neon, après la mise en ligne du site
-- qui sait lire les rachats fusionnés. Sans effet si on le relance : il ne reste
-- alors plus de part à fusionner. En cas d'erreur, rien n'est modifié.

begin;

-- La base de production portait un index unique, contributions_one_active_per_period,
-- absent du schéma relevé : un seul versement non rejeté par membre et par mois.
-- Le site compte pourtant plusieurs versements sur un mois (un acompte, puis le
-- complément) : c'est ainsi qu'un membre complète un mois payé à l'ancien tarif, et
-- que les cotisations reprises au rachat s'ajoutent aux mois déjà réglés par
-- l'acheteur. Le premier essai de ce script s'y est heurté (21/10/2026). Index ou
-- contrainte, l'une des deux lignes le retire, l'autre ne fait rien.
alter table contributions drop constraint if exists contributions_one_active_per_period;
drop index if exists contributions_one_active_per_period;

create temporary table parts_a_fusionner on commit drop as
  select id as part_id, holder_id as acheteur
  from members
  where holder_id is not null and is_active;

update contributions x set member_id = p.acheteur from parts_a_fusionner p where x.member_id = p.part_id;
update penalties x set member_id = p.acheteur from parts_a_fusionner p where x.member_id = p.part_id;
update penalty_settlements x set member_id = p.acheteur from parts_a_fusionner p where x.member_id = p.part_id;
update payment_proofs x set member_id = p.acheteur from parts_a_fusionner p where x.member_id = p.part_id;
update reminder_log x set member_id = p.acheteur from parts_a_fusionner p where x.member_id = p.part_id;
-- Une part ne siège pas et ne déclare pas de retard : rien à reporter, on nettoie.
-- Ses règles particulières non plus : reportée, une cotisation propre à la part
-- remplacerait celle de l'acheteur.
delete from member_rules x using parts_a_fusionner p where x.member_id = p.part_id;
delete from late_declarations x using parts_a_fusionner p where x.member_id = p.part_id;
delete from attendances x using parts_a_fusionner p where x.member_id = p.part_id;

-- Le rachat se rattache à l'acheteur : son poids et son prix comptent désormais dans sa part.
update share_buybacks b set part_id = b.buyer_id from parts_a_fusionner p where b.part_id = p.part_id;

delete from members m using parts_a_fusionner p where m.id = p.part_id;

-- Les pénalités du sortant disaient « dues sur leurs parts ».
update penalties
set settlement_note = replace(settlement_note, ', dues sur leurs parts', ', inscrites à leur nom')
where settlement_note like '%dues sur leurs parts%';

commit;
