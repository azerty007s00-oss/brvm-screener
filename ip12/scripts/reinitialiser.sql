-- ATTENTION : DESTRUCTIF.
--
-- Supprime les tables du site IP12 et toutes leurs donnees, puis laisse la base
-- prete a recevoir schema.sql.
--
-- A n'executer QUE apres avoir verifie qu'aucune table ne contient de donnees
-- a conserver. La requete de controle est rappelee en fin de fichier.
--
-- Les tables d'un schema anterieur portant d'autres noms ne sont PAS touchees :
-- cette liste est explicite, elle ne supprime rien qu'elle ne nomme.

drop table if exists journal              cascade;
drop table if exists relances             cascade;
drop table if exists declarations_retard  cascade;
drop table if exists penalites            cascade;
drop table if exists valorisations        cascade;
drop table if exists apports_titres       cascade;
drop table if exists versements           cascade;
drop table if exists membres              cascade;

-- Controle : la requete ci-dessous doit ne plus renvoyer aucune de ces tables.
--
-- select table_name,
--        (xpath('/row/c/text()',
--               query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
--                            false, true, '')))[1]::text::int as lignes
-- from information_schema.tables
-- where table_schema = 'public'
-- order by table_name;
