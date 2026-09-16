# IP12 — Investment Pioneers

Suivi des versements, des parts et du portefeuille du club d'investissement
**Investment Pioneers** (Abidjan, Côte d'Ivoire), dont le compte-titres est tenu chez
Phoenix Capital Management.

## Ce que fait le site

- **Versements mensuels** — chaque membre déclare son versement ; il devient visible de tous
  immédiatement et reste en attente jusqu'à la validation du **trésorier**, qui tient la caisse.
  Le président peut déclarer pour le compte d'un autre membre, la validation du trésorier
  restant requise. Personne ne valide son propre versement.
- **Avances et retards** — une déclaration peut couvrir plusieurs mois d'avance. Les mois
  échus non couverts basculent automatiquement en retard après le 10 (art. 8).
- **Pénalités réglées par acomptes** — onze mois de retard ne se soldent pas d'un coup. Le
  règlement porte un nombre de mois : la ligne est alors **scindée**, ce qui est payé devient une
  ligne soldée et le reste demeure dû. Les totaux tombent juste sans colonne supplémentaire, et
  chaque encaissement garde sa date. Laisser le champ vide solde la ligne entière.
- **Reprendre une pénalité** — une ligne réglée ou annulée se remet en dû, motif obligatoire.
  Sans cela, une erreur de manipulation restait inscrite pour toujours et la seule issue était
  d'inventer une pénalité compensatoire qui n'avait jamais été constatée.
- **Justificatifs et notes, ouverts à tous** — ils n'apparaissaient que dans la carte « à valider »,
  réservée au trésorier : une fois le versement validé, plus personne ne les voyait, pas même celui
  qui les avait joints. La carte des versements validés est désormais ouverte à tous, pièces et
  notes comprises ; corriger et annuler restent au trésorier et au président. Voir n'est pas écrire.
- **Journal de caisse** — le trésorier y inscrit dépenses et recettes, et **sa saisie vaut
  validation** : il tient la caisse, il constate ce qui en sort. Il peut aussi annuler sa propre
  écriture, motif à l'appui. La règle des versements ne bouge pas — là, elle sépare deux personnes,
  le membre qui déclare et le trésorier qui encaisse ; ici le trésorier était seul des deux côtés,
  et le visa du président n'ajoutait qu'un délai.
- **Corriger une écriture** — un mouvement de compte-titres se supprime, une écriture de caisse
  déjà validée s'annule (motif obligatoire). Sans cela, corriger une saisie fautive demandait de
  lui opposer une écriture inverse, qui décrivait à son tour un mouvement n'ayant pas eu lieu : le
  journal finissait par raconter le contraire de ce qui s'était passé. La ligne supprimée passe au
  journal avant d'être effacée — la trace survit à la donnée, avec le nom de qui a décidé.
- **Frais de compte-titres** — ils se règlent de trois façons, et les trois se saisissent :
  retenus à l'arrivée sur un virement, payés à part depuis la caisse (catégorie *Frais SGI* ou
  *Frais bancaires*), ou **prélevés seuls dans le compte-titres** par la SGI, sans virement qui
  les accompagne. Ce dernier cas s'inscrit avec un montant viré nul : la caisse n'a rien versé,
  elle ne bouge pas, et le relevé du portefeuille porte déjà la baisse. Inscrire un retrait à la
  place ferait remonter la caisse comme si l'argent était revenu.
- **Versements partiels** — un mois n'est soldé que lorsque la somme des versements atteint la
  cotisation attendue. En dessous, le mois reste dû et la pénalité de l'art. 9 porte sur la
  cotisation entière, jamais sur le seul reliquat : verser un acompte ne réduit pas la sanction.
  Le complément reste possible à tout moment — plusieurs versements peuvent porter sur le même
  mois — et le mois est réputé soldé **à la date du versement qui le complète**, si bien qu'un
  acompte le 5 et le solde le 15 font une régularisation en retard.
- **Compte-titres** — le président enregistre et valide les virements vers la SGI (art. 14).
- **Portefeuille** — le président saisit la valeur du compte tous les 2 mois ; les parts sont
  recalculées au prorata du **capital échu** de chaque membre, diminué de ses pénalités dues.
  Une **avance** est un dépôt : retirée du pot avant partage puis rendue au nominal, elle ne
  produit rien jusqu'au mois qu'elle couvre — payer d'avance est volontaire, et ne doit donc
  pas donner une plus grosse part des gains. La répartition porte sur l'avoir du club,
  compte-titres **et** caisse.
- **Releve individuel** — chaque membre edite le sien, le bureau celui de tous : versements,
  part, penalites et situation statutaire, mis en page pour le papier. L'impression du
  navigateur produit le PDF, sans rien a installer.
- **Relances des 7, 9 et 10** — un cron Vercel écrit trois fois par mois aux membres qui n'ont
  pas versé. Les 7 et 9 préviennent avant l'échéance en disant les jours restants ; le 10 est le
  dernier jour de l'art. 8. **La liste est recalculée à chaque passage** : qui a versé le 8 n'est
  pas relancé le 9. **Un membre déjà relancé dans la journée ne l'est pas deux fois** : le
  registre `reminder_log` fait foi, et seuls les envois réussis comptent — un échec est retenté au
  passage suivant. Le récapitulatif au bureau ne part que le 10, et seulement si au moins une
  relance nouvelle est partie. La relance déclenchée à la main par le bureau reste toujours
  possible : elle s'inscrit sous un canal distinct, ne bloque pas le passage automatique, et
  signale au président combien de destinataires avaient déjà reçu le courrier du jour. L'envoi
  passe par le SMTP du club (Gmail, Brevo) ou par Resend ; sans transport, seules les alertes du
  site subsistent.
- **Accès envoyés par courrier** — créer un membre ou réinitialiser son mot de passe lui envoie
  ses accès : lien du site, identifiant, mot de passe provisoire. Le mot de passe ne sert qu'une
  fois — l'écran de première connexion en exige un autre avant d'ouvrir quoi que ce soit. L'envoi
  suit l'écriture en base, jamais l'inverse : un courrier parti sur un mot de passe non enregistré
  donnerait un accès qui ne fonctionne pas. Son échec n'annule pas l'opération, mais il est dit,
  et le mot de passe reste affiché pour être transmis autrement. Sans `NEXT_PUBLIC_SITE_URL`, le
  courrier part sans l'adresse du site et le message de retour le signale.
- **Avis au bureau** — déclaration de versement en attente, récapitulatif de ce qu'il y a à
  encaisser, absence relevée par le secrétariat : le site n'attend plus qu'on l'ouvre.

## Règles appliquées

| Source | Règle |
|---|---|
| Art. 6 | Versement mensuel de 5 000 FCFA par membre |
| Art. 8 | Exigible au plus tard le 10 du mois |
| Art. 9 | Pénalité de 10 % du versement dû, versée à l'actif du club |
| Art. 12 | Droits de vote proportionnels aux parts, calculees sur le capital echu |
| Art. 14 | Le président transmet les ordres de bourse, le trésorier par délégation |
| Art. 20 | Exclusion à 3 mois de retard, majorité des 3/4, remboursement moins 2 % de frais |
| R1 | Souscription à la bourse en ligne, mandat au bureau ; ordres transmis par le président ou le trésorier par délégation (art. 14) |
| R2 | Droit de vote suspendu dès 30 jours de retard, jusqu'à régularisation |
| R3 | Déclaration du retard au groupe obligatoire à l'entrée dans le 2e mois |
| R4 | Dès 3 mois de retard, pénalités des 3 derniers mois doublées (30 % → 60 %) |
| R5 | Retard non déclaré : exclusion de plein droit. Déclaré : plan de redressement unique |
| AG 2026 | Pénalités indissociables des cotisations : 3 pénalités de retard impayées emportent l'exclusion (R5), à compter du 10/01/2027 |
| AG 2026 | Avance minimale imposable à un membre, à titre disciplinaire, exprimée en mois |

Ces valeurs sont centralisées dans `src/lib/settings.ts` : un amendement des statuts se
répercute partout en modifiant ce seul fichier.

## Base de données

L'application se branche sur la base Neon **existante** du club, dont la structure est décrite
dans `src/lib/schema-cible.md`. Les dix membres y sont déjà enregistrés.

Deux migrations la complètent, toutes deux purement additives :

| Script | Ce qu'il ajoute |
|---|---|
| `scripts/migration-r3.sql` | La table des déclarations de retard exigées par R3, absente du schéma d'origine |
| `scripts/migration-frais.sql` | `securities_transfers.fees`, la part d'un virement retenue en frais de dépôt |

Tant que `migration-frais.sql` n'a pas été exécutée, la lecture des mouvements retombe sur une
projection sans `fees` : le site continue de fonctionner, les frais s'affichent à zéro.

`scripts/test/schema-local.sql` est une réplique de cette structure, **réservée aux tests** :
elle sert à monter un PostgreSQL jetable pour vérifier les requêtes avant déploiement. Ne jamais
l'exécuter sur la base de production.

## Mise en service

0. **Identité des commits** — Vercel refuse de construire un commit dont l'adresse d'auteur
   n'est rattachée à aucun compte GitHub, et l'échec ne ressemble pas à un échec : le dernier
   déploiement réussi reste en ligne, sans que rien ne signale que les suivants ont été bloqués.
   On cherche alors dans le code une fonctionnalité qui s'y trouve déjà. Committer sous une
   adresse du compte — l'adresse `@users.noreply.github.com` convient et ne divulgue rien :

   ```bash
   git config user.email "IDENTIFIANT+UTILISATEUR@users.noreply.github.com"
   ```

   Le pied de page affiche la révision réellement en ligne : c'est de là qu'on part pour
   distinguer une fonctionnalité manquante d'un déploiement resté en arrière.

1. **Variables** — renseigner sur Vercel celles listées dans `.env.example`, `DATABASE_URL`
   pointant sur le projet Neon du club.
2. **Migrations** — exécuter `scripts/migration-r3.sql` puis `scripts/migration-frais.sql`
   dans le SQL Editor de Neon.
3. **Reprise en main** — appeler une fois `/api/bootstrap?token=SETUP_TOKEN`. Les mots de passe
   hérités ayant été produits par une version antérieure au format inconnu, cette route
   réinitialise celui de l'adresse déclarée dans `BOOTSTRAP_EMAIL` et renvoie un mot de passe
   provisoire. **Supprimer `SETUP_TOKEN` des variables d'environnement juste après.**
4. **Les autres membres** — leur mot de passe se réinitialise depuis la page *Membres* ; chacun
   reçoit un provisoire qu'il remplace à sa première connexion.

## Développement

```bash
npm install
cp .env.example .env.local   # puis renseigner DATABASE_URL et SESSION_SECRET
npm run dev
npm run verif                # 102 contrôles de calcul : TRI, Dietz modifié, parts, pénalités, R3, R5
npm run verif:sql            # rejoue les 96 requêtes SQL contre le schéma de production
```

`verif` porte sur les calculs, en mémoire, sans base. `verif:sql` porte sur le SQL :
il charge `scripts/test/schema-local.sql` **et les migrations** dans une base jetable,
puis passe chaque requête du site par `EXPLAIN`, dans une transaction annulée — rien
n'est exécuté, rien n'est écrit. Il attrape ce qu'aucun compilateur ne voit : une
colonne renommée, une table oubliée, une faute de frappe dans un nom. Sans PostgreSQL
joignable, il s'annonce ignoré et rend la main sans bloquer les autres contrôles.

```bash
# Un PostgreSQL de test, le temps du contrôle
initdb -D /tmp/pgtest && pg_ctl -D /tmp/pgtest -o "-k /tmp -p 5433" start
PGPORT_TEST=5433 npm run verif:sql
```

## Architecture

| Fichier | Rôle |
|---|---|
| `src/lib/settings.ts` | Statuts et résolutions traduits en constantes |
| `src/lib/penalites.ts` | Situation mensuelle d'un membre, retards, pénalités, issues R5 |
| `src/lib/perf.ts` | TRI (XIRR), Dietz modifié, répartition des parts |
| `src/lib/queries.ts` | Accès Postgres et agrégats du club |
| `src/lib/auth.ts` | Mots de passe scrypt, sessions signées par cookie |
| `src/app/actions/` | Actions serveur : versements, compte-titres, membres |
| `src/app/(app)/` | Pages authentifiées |
| `src/lib/valeurs.ts` | Valeurs des colonnes à contrainte, rassemblées en un point |
| `src/lib/droits.ts` | Qui a le droit de faire quoi, rassemblé en un tableau |
| `src/lib/version.ts` | Révision déployée, lue dans l'environnement Vercel |
| `src/lib/courriel.ts` | Envoi du courrier, par SMTP ou Resend |
| `src/lib/relance.ts` | Qui relancer, et que leur écrire |
| `src/lib/avis.ts` | Avis adressés au bureau et aux membres absents |
| `scripts/migration-r3.sql` | Ajout de la table des déclarations R3 |
| `scripts/migration-frais.sql` | Ajout des frais de dépôt sur les virements |
