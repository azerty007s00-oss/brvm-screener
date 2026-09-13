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
- **Compte-titres** — le président enregistre et valide les virements vers la SGI (art. 14).
- **Portefeuille** — le président saisit la valeur du compte tous les 2 mois ; les parts de
  chaque membre sont recalculées au prorata de ses versements validés (art. 12).
- **Relance du 10** — un cron Vercel envoie chaque mois un e-mail aux retardataires et le site
  affiche les alertes correspondantes.

## Règles appliquées

| Source | Règle |
|---|---|
| Art. 6 | Versement mensuel de 5 000 FCFA par membre |
| Art. 8 | Exigible au plus tard le 10 du mois |
| Art. 9 | Pénalité de 10 % du versement dû, versée à l'actif du club |
| Art. 12 | Droits de vote proportionnels aux parts |
| Art. 14 | Le président transmet les ordres de bourse, le trésorier par délégation |
| Art. 20 | Exclusion à 3 mois de retard, majorité des 3/4, remboursement moins 2 % de frais |
| R2 | Droit de vote suspendu dès 30 jours de retard, jusqu'à régularisation |
| R3 | Déclaration du retard au groupe obligatoire à l'entrée dans le 2e mois |
| R4 | Dès 3 mois de retard, pénalités des 3 derniers mois doublées (30 % → 60 %) |
| R5 | Retard non déclaré : exclusion de plein droit. Déclaré : plan de redressement unique |

Ces valeurs sont centralisées dans `src/lib/settings.ts` : un amendement des statuts se
répercute partout en modifiant ce seul fichier.

## Mise en service

1. **Base** — créer un projet Neon, copier la chaîne de connexion *pooled*.
2. **Schéma** — exécuter `scripts/schema.sql` dans le SQL Editor de Neon.
3. **Variables** — renseigner sur Vercel celles listées dans `.env.example`.
4. **Premier compte** — appeler une fois `/api/bootstrap?token=SETUP_TOKEN` : la route crée le
   compte président, renvoie un mot de passe provisoire, puis devient inerte.
5. **Les 9 autres membres** — les créer depuis la page *Membres* ; chacun reçoit un mot de passe
   provisoire qu'il remplace à sa première connexion.

## Développement

```bash
npm install
cp .env.example .env.local   # puis renseigner DATABASE_URL et SESSION_SECRET
npm run dev
npm run verif                # vérifie TRI, Dietz modifié et répartition des parts
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
| `scripts/schema.sql` | Schéma de la base |
