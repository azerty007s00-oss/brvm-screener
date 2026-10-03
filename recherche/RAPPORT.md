# Pourquoi le screener ne gagne pas d'argent — et ce que disent les données

**Date :** 2 octobre 2026
**Périmètre :** 44 titres BRVM, 1 425 séances (2021-04-07 → 2026-09-30), fondamentaux 2021-2025
**Reproduire :** `python recherche/etude_facteurs.py`

---

## 1. Les quatre défauts qui expliquent l'absence de rentabilité

### 1.1 Le backtest ignore 7,3 % de rendement par an

`grep -i dividend backtest.py` → **zéro occurrence**. Or le rendement du dividende réalisé sur
l'univers est de :

| Année | 2022 | 2023 | 2024 | 2025 | 2026* | Moyenne |
|---|---|---|---|---|---|---|
| Rendement (dps N-1 / cours moyen N) | 7,36 % | 7,98 % | 7,75 % | 8,34 % | 5,20 % | **7,33 %** |

\* exercice partiel

Sur la BRVM le dividende *est* le moteur du rendement. Toute optimisation menée sur une P&L
amputée de 7 points par an optimise la mauvaise fonction.

### 1.2 Le barème de frais utilisé est deux fois trop faible

`backtest.py` applique 0,65 % par sens, soit 1,3 % aller-retour. Le barème réel, relevé sur la
grille comparative des SGI :

| Poste | Montant |
|---|---|
| Courtage SGI | plafonné à **1 %** par sens, appliqué par 28 SGI sur 35 |
| Commission de marché (BRVM + dépositaire central) et TAF | ≈ 0,4 % par sens |
| **Total par ordre** | **≈ 1,4 %**, soit **2,8 % aller-retour** |
| Minimum de perception par ordre | ≈ 1 000 F |
| Frais de tenue de compte | **forfaitaires**, de 0 à 15 625 F **par an** |

Deux choses à retenir, et je me suis trompé sur les deux dans une version antérieure de ce rapport.

**Les 1,4 % sont déjà le total toutes taxes comprises.** J'avais appliqué la TAF par-dessus et
retenu 1,65 % par sens. C'est faux : la grille est explicite — « sur un achat de 1 000 000 FCFA,
une quinzaine de milliers de francs ». Le chiffre juste est 2,8 % aller-retour, pas 3,3 %.

**Les frais de tenue de compte sont un forfait, pas un pourcentage.** J'avais écrit qu'ils allaient
de 0,25 %/an à 2 %/an et qu'en choisir une bonne rapportait 1,75 point de CAGR. C'est faux : ce sont
des montants fixes, de 0 F à 15 625 F par an. Leur poids relatif s'effondre donc quand le capital
grandit — 15 625 F valent 1,56 %/an sur 1 M FCFA, 0,78 % sur 2 M, 0,16 % sur 10 M. Le classement
réel des SGI est en section 5.

### 1.3 Le marché que l'outil essaie de timer a fait +40 % par an

| Mesure (prix seul, 2021-04 → 2026-09) | Valeur |
|---|---|
| Multiple médian | ×4,53 → CAGR **+31,7 %** |
| Multiple moyen | ×6,45 → CAGR **+40,5 %** |
| Titres en hausse | **95 %** |
| Extrêmes | STBC ×31,2 / ORGT ×0,75 |

Décomposition annuelle (médiane cross-section) : 2021 **+61,9 %**, 2022 −0,4 %, 2023 −0,2 %,
2024 +13,6 %, 2025 **+48,2 %**, 2026 **+48,2 %**.

Un marché où 95 % des titres montent est un marché où **tout filtre retire de la valeur**. Le
moteur actuel — revue tous les 14 jours, stop à 8 %, sortie dès que le signal n'est plus ACHAT,
détention plafonnée à 90 jours — est précisément construit pour sortir pendant les consolidations
de 2022-2023 puis manquer la ré-accélération de 2025-2026.

### 1.4 `strategy_research.py` ne porte pas sur la BRVM

Ce module conclut sur un **univers synthétique de 20 actions simulées** (« Univers synthétique
20 actions, 5 ans, drift 6 % CAGR, σ 22 % »). Calibrer un générateur à 6 % de drift pour
représenter un marché qui en a fait 40 % produit des conclusions sans rapport avec le terrain.
Les 44 séries réelles étaient disponibles dans `data/daily/`.

---

## 2. Les facteurs qui prédisent réellement les rendements

Information coefficient (Spearman, cross-section mensuelle, rendement **total**) :

| Facteur | IC 3 m | IC 6 m | IC 12 m |
|---|---|---|---|
| **EARNYLD** (BNPA / cours) | +0,075 *(t=2,9)* | +0,099 *(t=4,1)* | **+0,116** *(t=3,5)* |
| **LOWVOL** (faible volatilité) | +0,080 *(t=3,2)* | **+0,122** *(t=4,0)* | +0,085 *(t=2,4)* |
| MOM3 (momentum 3 mois) | +0,074 *(t=3,5)* | +0,043 *(t=2,0)* | +0,025 |
| MOM1 | +0,060 *(t=2,9)* | +0,027 | +0,007 |
| DIVYLD | +0,038 | +0,039 | +0,048 |
| MOM12 | +0,011 | −0,018 | −0,029 |
| SMALL | −0,023 | −0,028 | −0,011 |
| ILLIQ | −0,055 | −0,038 | −0,020 |

Trois enseignements :

- **La valeur (rendement bénéficiaire) et la faible volatilité sont les seuls facteurs robustes**,
  et leur IC *croît* avec l'horizon — donc exploitables à faible rotation uniquement.
- **Le momentum 12 mois ne fonctionne pas** ; seul le momentum court (1-3 mois) a un signal, qui
  s'éteint au-delà de 3 mois.
- **ILLIQ est négatif** : les titres *plus* liquides ont mieux performé. Il n'y a pas de prime
  d'illiquidité à récolter ici.

Ces trois résultats concordent avec la littérature sur les marchés frontières : prime de faible
volatilité significative sur neuf marchés africains *sauf en phase haussière*, prime de valeur et
momentum 6 mois présents, et **absence de prime d'illiquidité** sur 22 marchés frontières
(1991-2019). Les données BRVM reproduisent la littérature.

Mais un IC de 0,10 reste un signal faible. La question est de savoir s'il paie les frais.

---

## 3. Le test qui tranche : sensibilité au calendrier

Fenêtre 2022-11 → 2026-09 (47 mois — avant novembre 2022 les fondamentaux ne couvrent pas
l'univers, un portefeuille factoriel y serait en cash et le résultat faux). Frais 3,3 %
aller-retour + garde 0,25 %/an. Rendement total. Chaque stratégie est mesurée sur **les 12 mois
de rebalancement possibles**, parce qu'un résultat qui dépend du calendrier choisi n'est pas une
stratégie mais de la chance.

### CAGR selon le mois de rebalancement (rebalancement annuel)

| Stratégie | min | **médiane** | max | écart-type |
|---|---|---|---|---|
| Équipondéré, tout l'univers | +38,3 % | +42,1 % | +44,2 % | **1,7 %** |
| **top25 value+lowvol** | **+38,8 %** | **+44,6 %** | +48,2 % | 2,5 % |
| top20 value+lowvol | +37,1 % | +44,4 % | +47,2 % | 3,0 % |
| top12 value+lowvol | +36,5 % | +40,2 % | +47,6 % | 3,9 % |
| top8 value+lowvol | +28,0 % | +38,5 % | +47,0 % | 5,6 % |
| top5 value+lowvol | +24,1 % | +34,8 % | +46,4 % | 6,4 % |

C'est le tableau le plus important du rapport. **Plus le portefeuille est concentré, plus le
résultat dépend du hasard du calendrier.** Un top8 peut afficher +47,0 % ou +28,0 % selon le mois
où l'on rebalance : annoncer le premier chiffre comme une performance de stratégie serait
malhonnête.

**top25 est la seule configuration qui domine l'équipondéré sans contrepartie** : meilleure médiane
(+44,6 % contre +42,1 %) *et* meilleur plancher (+38,8 % contre +38,3 %). En dessous de 20 lignes,
le plancher s'effondre. La règle qui en découle : **au moins 20 lignes, 25 de préférence.**

### CAGR médian selon la fréquence de rebalancement

| Stratégie | annuel | semestriel | trimestriel | mensuel |
|---|---|---|---|---|
| Équipondéré | +42,1 % | +43,2 % | +43,1 % | +42,2 % |
| top25 value+lowvol | **+44,6 %** | +44,4 % | +41,2 % | +39,5 % |
| top8 value+lowvol | +38,5 % | +37,2 % | +36,1 % | +31,6 % |

**La fréquence est le paramètre dominant.** L'équipondéré y est insensible : il ne tourne pas.
Dès qu'on sélectionne, accélérer le rythme coûte — top25 perd 5,1 points en passant d'annuel à
mensuel, top8 en perd 6,9. À 2,8 % d'aller-retour, la rotation reste l'ennemi principal, au-dessus
de la qualité du signal.

## 4. La poche événementielle : pas d'edge, et une erreur de ma part corrigée

### Première tentative, et pourquoi elle était fausse

Faute de dates réelles, j'ai d'abord **inféré** les détachements depuis les cours : le jour où la
baisse en FCFA approchait le dividende connu. Résultat brut, achat 60 séances avant / vente
20 après : **+13,4 % moyen, 75 % de gagnants, t = 6,4** net de frais.

C'était faux, pour deux raisons que j'ai trouvées en contrôlant :

- **Les +13,4 % étaient la hausse du marché sur trois mois**, pas un effet dividende. Corrigé du
  marché, il restait +4,66 %.
- **Même ce résidu ne survivait pas au placebo** : des dates tirées au hasard dans la même saison
  donnaient +6,57 %, soit *mieux* que les vraies. Ce qui était mesuré, c'est que les sociétés
  payeuses ont surperformé sur n'importe quelle fenêtre de cette période.

La détection elle-même était peu fiable : la date retenue était un candidat parmi ~7.

### Avec les vraies dates

Le calendrier officiel des mises en paiement est maintenant dans le dépôt
(`data/dividendes_paiements.csv`, 211 lignes, 2021-04 → 2026-09, 38 titres, exercices 2020 à
2025). Excès de rendement vs marché, **hors dividende** — un cours qui décroche donnerait un excès
nettement négatif :

| Fenêtre | n | Excès hors dividende | t-stat |
|---|---|---|---|
| J-0 / J+1 | 184 | −0,03 % | −0,20 |
| J-0 / J+5 | 184 | +0,15 % | +0,46 |
| J-5 / J+5 | 182 | +0,35 % | +0,77 |
| J-10 / J+10 | 182 | −0,89 % | −1,29 |
| J-20 / J+20 | 177 | **−3,24 %** | **−2,49** |

Deux enseignements.

**Aucun edge exploitable.** À l'échelle de quelques séances autour du paiement, le cours ne bouge
pas (t = 0,77 à J±5, t = −0,20 le jour même). Il n'y a ni anticipation avant, ni dérive après. C'est cohérent : la date de
mise en paiement n'est **pas** la date de détachement. Le droit au dividende est fixé plus tôt, donc
acheter la veille du décaissement ne donne droit à rien — il n'y a pas de machine à cash à
construire ici.

**Le détachement existe mais il est diffus.** À ±20 séances, le titre sous-performe de 3,24 %
(t = −2,49), soit environ 40 % du rendement du dividende. Autrement dit le marché absorbe le
détachement progressivement plutôt qu'en une séance — ce qui est typique d'un marché à fixing et à
faible liquidité. Cela ne change rien au calcul de rendement total : cette sous-performance est
déjà contenue dans la série de prix, à laquelle on ajoute le dividende encaissé.

### Vérification : les cours ne sont pas ajustés des dividendes

L'absence de décrochage net autour du paiement pose la question inverse : et si `data/daily/`
contenait des cours déjà ajustés ? Dans ce cas, ajouter le dividende les compterait deux fois et
tous les chiffres de ce rapport seraient gonflés de ~7 points par an. Deux contrôles l'écartent :

- **Aucun historique n'a été réécrit.** Sur les 49 fichiers, les cotations antérieures au
  01/07/2026 sont identiques entre le premier commit et aujourd'hui, alors que des dividendes ont
  été payés entre-temps. Un ajustement rétroactif les aurait toutes modifiées.
- **Sonatel cote 12 900 F au 07/04/2021**, son cours réel de l'époque. Cinq ans de dividendes à
  1 500 F l'auraient ramené vers 6 000-8 000 F si la série était ajustée.

Les cours sont bruts. Créditer le dividende en plus est correct.

### Ce que les vraies dates changent aux conclusions : rien

L'étude créditait auparavant tous les dividendes au 1er juillet par convention. Avec **140 dates
exactes sur 151** désormais substituées :

| Stratégie | Convention juillet | Dates réelles |
|---|---|---|
| Équipondéré | +42,3 % | +42,3 % |
| top25 value+lowvol | +44,4 % | +44,7 % |
| top20 value+lowvol | +44,6 % | +44,4 % |

Écart maximal 0,3 point. La convention ne biaisait pas le résultat, et les conclusions reposent
maintenant sur des dates réelles et non sur une approximation.

### Ce qu'il manque encore

Le calendrier couvre désormais toute la fenêtre de cours (2021-04 → 2026-09). Ce qui manque
encore est d'une autre nature : tester réellement la capture du dividende exigerait les **dates de
détachement**, qui ne figurent pas au calendrier des paiements. Sans elles, cette piste reste
fermée — et rien dans ce qui précède ne suggère qu'elle serait fructueuse.

Quelques lignes n'ont pas pu être rattachées à un ticker : Tractafric Motors CI (raison sociale non
identifiée avec certitude), un libellé « TotalEnergies Marketing » sans pays (CI ou SN indécidable),
et trois sociétés absentes de `data/daily/` (BOA Niger, Sucrivoire CI, BIIC Bénin).

## 5. Ce qui est réellement implémentable avec 1 à 5 M FCFA

Univers négociable : **41 titres sur 44**.

- Exclus pour **suspension de cotation** : **SEMC** (Crown SIEM CI) et **SICC** (SICOR). Leurs
  données s'arrêtent au 15/09/2026, veille des avis de suspension du 16/09/2026. **Le screener
  affiche encore leurs derniers cours comme s'ils étaient négociables, et peut émettre des
  signaux dessus.** Une position y serait gelée, non liquidable.
- Exclu pour illiquidité (< 2 M FCFA échangés/jour) : UNLC.

| Capital | Lignes | Cash résiduel | Poids min/max | % du volume quotidien requis |
|---|---|---|---|---|
| 1 M | 20 | 11,1 % | 3,4 % / 5,6 % | 0,1 % |
| **2 M** | **20** | **8,1 %** | **4,1 % / 5,4 %** | **0,3 %** |
| 3 M | 20 | 6,2 % | 4,2 % / 5,3 % | 0,4 % |
| 5 M | 20 | 3,5 % | 4,7 % / 5,2 % | 0,7 % |
| 5 M | 25 | 2,7 % | 3,7 % / 4,1 % | 0,9 % |

Bonnes nouvelles : **20 lignes sont atteignables dès 1 M FCFA**, et l'impact marché est
négligeable (< 1 % du volume quotidien). La contrainte de liquidité n'est pas le problème à ce
niveau de capital.

Le cash résiduel (arrondi au nombre entier d'actions) passe de 11-14 % à 1 M FCFA à 3-4 % à
5 M FCFA. À 1 M, ces 11 % de cash non investi coûtent environ 4,5 points de CAGR : **monter le
capital de 1 à 2-3 M est un gain mécanique plus important que n'importe quel signal.**

### Quelle SGI : le comparatif chiffré

Coût **annuel récurrent** pour un portefeuille de 2 M FCFA, 25 lignes, rebalancement annuel
(rotation estimée à 25 %), tenue de compte comprise :

| SGI | Dépôt minimum | Tenue de compte /an | Courtage | Coût annuel | % du capital |
|---|---|---|---|---|---|
| **Atlantique Finance** | 2 000 000 | 0 F | **0,65 %** | 6 000 F | **0,30 %** |
| **BNI Finances** | 1 000 000 | **gratuit** | 1 % | 7 000 F | 0,35 % |
| **Africaine de Gestion (AGI)** | n.c. | **néant** | 1 % | 7 000 F | 0,35 % |
| Attijari Securities | 1 000 000 | 2 000 F | 1 % | 9 000 F | 0,45 % |
| Phoenix Capital Management (PCM) | 2 000 000 | 2 500 F HT | 1 % HT | 9 500 F | 0,47 % |
| BICI Bourse | n.c. | 5 000 F | 0,4–1 % | 12 000 F | 0,60 % |
| EDC Investment | 1 000 000 | 5 000 F | 0,4–1 % | 12 000 F | 0,60 % |
| BSIC Capital | 500 000 | 10 000 F | 0,8 % | 16 000 F | 0,80 % |
| MAC African SGI | n.c. | 10 000 F | 0,85 % | 16 250 F | 0,81 % |
| Coris Bourse | **50 000** | 10 000 F | 1 % | 17 000 F | 0,85 % |
| NSIA Capital | 200 000 | 10 000 F | 1 % | 17 000 F | 0,85 % |
| Bridge Securities | 250 000 | 10 000 F | 1 % | 17 000 F | 0,85 % |
| One Africa Markets | n.c. | 15 625 F | 0,80 % | 21 625 F | 1,08 % |
| Kerales Finance | n.c. | 15 625 F | 1 % | 22 625 F | 1,13 % |

**L'écart entre la moins chère et la plus chère est de 0,83 point par an** sur 2 M FCFA — pas les
1,75 point que j'annonçais à partir de droits de garde en pourcentage qui n'existent pas sur ce
marché. C'est moins spectaculaire, mais c'est toujours plus que ce que rapporte le tilt factoriel,
et c'est certain plutôt que probable.

**Correction d'une recommandation erronée.** J'avais cité Hudson & Cie comme la SGI à viser pour ses
faibles droits de garde. La grille montre un **dépôt minimum de 50 000 000 FCFA** : elle est hors
de portée pour 1 à 5 M. Ne la retiens pas.

Deux remarques que la grille impose :

- **Le forfait de tenue de compte domine sur un petit portefeuille.** Un écart de courtage de
  0,2 point sur quelques ordres par an pèse moins que 15 625 F de frais fixes. À 1 M FCFA ce
  forfait vaut 1,56 %/an, davantage que tout le reste réuni.
- **Le moins cher n'est pas le meilleur critère.** La grille elle-même le dit, et c'est juste : une
  SGI injoignable quand un dividende n'arrive pas coûte plus qu'un dixième de point de commission.
  Les avis d'autres investisseurs sont le seul endroit où cela se lit.

### Le minimum de perception par ordre : question tranchée

J'avais signalé ce paramètre comme celui qui pouvait annuler la diversification. Les barèmes
publiés citent un **minimum d'environ 1 000 FCFA par ordre** (confirmé chez Atlantique Finance et
Sogebourse). À 1,4 % par sens, il ne s'applique qu'en dessous de **71 400 F par ligne** :

| Capital | 12 lignes | 15 lignes | 20 lignes | 25 lignes |
|---|---|---|---|---|
| 1 M | 1,40 % | 1,40 % | **2,00 %** | **2,50 %** |
| 2 M | 1,40 % | 1,40 % | 1,40 % | 1,42 % |
| 3 M et plus | 1,40 % | 1,40 % | 1,40 % | 1,40 % |

**À partir de 2 M FCFA, diversifier ne coûte pratiquement rien de plus.** À 1 M, tenir 25 lignes au
lieu de 12 coûte 1,1 point de capital — **une seule fois, à l'entrée** — contre 6,1 points de CAGR
**par an** gagnés (top25 +44,6 % contre top12 +40,2 %). L'arbitrage n'est pas serré.

Si ta SGI pratique un autre plancher :
`python strategie/panier.py --capital 2000000 --minimum-ordre 5000`.

## 6. Ce que les données disent de faire

Classé par rapport gain/certitude, le plus sûr d'abord :

1. **Si le compte n'est pas encore ouvert, choisir la SGI sur le forfait de tenue de compte, pas
   sur le courtage.** De 0 F à 15 625 F par an : 0,83 point de CAGR d'écart sur 2 M FCFA. BNI
   Finances (tenue gratuite), AGI (néant) et Atlantique Finance (0 F et 0,65 % de courtage) sont en
   tête, sous réserve de leur dépôt minimum.

   **Si le compte existe déjà, ne changer que si l'écart dépasse environ 0,4 point par an.** En
   dessous, le gain ne paie pas le dossier d'ouverture ni la perte d'une relation qui fonctionne.
   Concrètement, un compte dans les six premières lignes du tableau de la section 5 n'est pas à
   déplacer : le meilleur ne rapporterait que 0,17 à 0,21 point de plus. Les trois dernières lignes
   (10 000 F et au-delà de tenue de compte), en revanche, coûtent assez cher sur un petit
   portefeuille pour justifier le changement.

   Et dans tous les cas, le tarif n'est pas le seul critère : une SGI injoignable quand un dividende
   n'arrive pas coûtera plus cher que l'écart de commission.
2. **Panier équipondéré de 20 à 25 lignes, rebalancé une fois par an**, dividendes réinvestis.
   Médiane +42,3 % sur la période, écart-type 1,8 % selon le calendrier, max drawdown ~5 %.
3. **Tilt vers top25 value + faible volatilité** (rendement bénéficiaire et volatilité 60 j).
   Médiane +44,6 % contre +42,1 %, et plancher légèrement meilleur que l'équipondéré : c'est la
   seule configuration qui améliore les deux à la fois. Gain réel mais modeste.
4. **Ne jamais rebalancer plus d'une fois par semestre.** C'est le paramètre le plus coûteux.
5. **Retirer SEMC et SICC de l'univers** et ajouter une détection de suspension.
6. **Récupérer les dates de détachement** si l'on veut encore tester l'événementiel. Les dates de mise en paiement, elles, sont acquises et servent à la trésorerie.

7. **Étaler l'entrée sur plusieurs mois** plutôt qu'investir d'un bloc. Le marché se paie
   aujourd'hui 14,7 fois ses bénéfices contre 7,9 en moyenne sur 2021-2024 : voir section 7.

Et ce qu'il faut arrêter : les stops à 8 %, la revue bi-mensuelle, la détention plafonnée à
90 jours, et la sélection à moins de 20 lignes. Ces quatre paramètres ont coûté de l'argent sur
toute la période mesurée.

---

## 7. Le marché est-il devenu cher ? Oui, et ça change les attentes

Tout ce qui précède porte sur **comment** construire et faire tourner un portefeuille. Rien n'y
porte sur **à quel prix** on y entre. Ce sont deux décisions distinctes, et je n'avais traité que la
première. Voici la seconde.

### La valorisation a presque doublé

PER médian de fin d'exercice (cours au 31/12 de l'année N divisé par le BNPA de l'exercice N) :

| Exercice | PER médian | Rendement du dividende médian |
|---|---|---|
| 2021 | 8,3 | 7,4 % |
| 2022 | 7,8 | 7,9 % |
| 2023 | 8,0 | 8,9 % |
| 2024 | 7,6 | 8,4 % |
| 2025 | 9,9 | 6,4 % |
| **Aujourd'hui** *(cours 30/09/2026, BNPA 2025)* | **14,7** | **4,0 %** |

**Le marché s'est revalorisé d'un facteur 1,86**, et le rendement du dividende a été divisé par deux.
Tu es payé deux fois moins pour attendre qu'il y a trois ans.

### La hausse n'est pas payée par les bénéfices

| Période | Bénéfices agrégés | Cours (médiane) | Dont revalorisation |
|---|---|---|---|
| 2021 → 2023 | +6,0 %/an | −1,6 %/an | **−7,2 %/an** |
| 2023 → 2025 | +11,6 %/an | +35,2 %/an | **+21,2 %/an** |
| 2025 → sept. 2026 | *inconnus* | +48,2 % en 9 mois | — |

Les sociétés ont fait croître leurs bénéfices d'environ **10 % par an** — c'est solide et c'est réel.
Les cours ont monté de **35 % par an** sur la période récente. **Les deux tiers de la hausse sont une
revalorisation, pas une création de valeur.** Et un multiple ne peut pas doubler indéfiniment.

### Ce qu'on peut raisonnablement attendre maintenant

À croissance des bénéfices maintenue (+10,5 %/an) et dividende réinvesti, sur 5 ans :

| Si le multiple… | PER final | CAGR 5 ans | Capital |
|---|---|---|---|
| double encore (euphorie) | 22,0 | +22,1 % | ×2,7 |
| tient à son niveau actuel | 14,7 | **+13,6 %** | ×1,9 |
| se dégonfle partiellement | 12,0 | +9,7 % | ×1,6 |
| revient à la moyenne 2021-2024 | 7,9 | **+2,5 %** | ×1,1 |
| sur-réagit à la baisse | 6,0 | −1,7 % | ×0,9 |

Et si le multiple se normalisait brutalement plutôt que progressivement : **−18 % pour un retour à
12, −32 % pour un retour à 10, −46 % pour un retour à 7,9.**

### Les trois conséquences

**1. Le +42 % de CAGR mesuré dans ce rapport n'est pas une prévision.** Il décrit un passé dont une
grande partie vient d'une revalorisation qui ne peut pas se répéter. Le scénario central raisonnable
est plutôt **+13 à +14 % par an**, soit un tiers de ce que montre le backtest. C'est encore très
bon, mais il faut partir avec la bonne attente.

**2. Cela ne ressuscite pas la gestion active.** Toutes les alternatives testées dans ce rapport
perdent face au panier large, y compris pendant la phase molle 2022-2024. Être cher ne rend pas le
market timing technique rentable pour autant — la hausse peut durer des années, et sortir pour
rentrer plus tard coûte 2,8 % à chaque aller-retour plus le risque de rater la suite.

**3. Cela change la mise en place, pas la méthode.** Étaler les achats sur plusieurs mois plutôt
qu'entrer d'un bloc, garder le tilt value + faible volatilité (qui tient mieux quand le marché
stagne : +10,0 % contre +6,1 % sur 2022-2024), et surveiller le rendement du dividende du
portefeuille comme jauge — à 4 % on paie cher, à 8 % on est payé pour attendre.

### Le précédent : la BRVM a déjà fait exactement ça

Le parallèle le plus instructif n'est pas à chercher à l'étranger. Il est dans l'histoire récente du
marché lui-même, **juste avant le début de mes données** :

| Date | BRVM Composite | Variation |
|---|---|---|
| 2012 → 2015 | — | **+119 %**, meilleure bourse africaine ; capitalisation ×2,4 |
| Mars 2016 *(sommet historique)* | 320,30 | — |
| Fin 2016 | 292,17 | −8,8 % |
| Fin 2017 | 243,06 | −16,8 % |
| 2018 | — | **−29,2 %**, pire année de son histoire |
| 1ᵉʳ janvier 2021 *(creux)* | 145,37 | **−54,6 % depuis le sommet** |
| Fin 2025 | 345,75 | +137,8 % |
| 30 septembre 2026 | 548,38 | +58,6 % sur 9 mois |

Un cycle complet : **+119 % de hausse, puis −54,6 % sur quatre ans et dix mois.** La baisse n'a pas
eu besoin d'un krach mondial pour se produire : elle s'explique par des causes locales — cacao en
baisse de 46 % entre janvier 2016 et décembre 2017, instabilité politique au premier trimestre 2017.

**Mes données commencent le 7 avril 2021, soit environ trois mois après le creux exact.** Tout ce
rapport mesure donc une seule jambe de reprise, depuis le point bas. C'est la limite la plus
importante de l'étude, et elle est structurelle : *un échantillon qui commence au creux d'un cycle
ne peut pas contenir le contre-exemple*.

Deux conséquences qu'il faut regarder en face.

**La conclusion « ne rien filtrer » a un domaine de validité, pas une portée générale.** Elle est
établie sur un marché qui remonte. Elle n'a jamais été testée sur un marché qui baisse pendant cinq
ans, parce que les données ne le permettent pas.

**Mon rejet du filtre de tendance est aussi dépendant de l'échantillon que mon soutien au passif.**
J'ai mesuré que le filtre MA200 coûtait de la performance sur 2021-2026 ; c'est vrai, et c'est sans
intérêt pour la question de savoir s'il aurait protégé pendant la baisse de 2016-2020. **Je ne peux
pas l'exclure.** Un filtre de tendance est inutile dans une reprise et potentiellement utile dans un
déclin prolongé — mes données ne contiennent que le premier cas.

Pour mémoire, le reste des marchés frontières suit la même mécanique : l'indice MSCI Frontier
Markets a perdu 53 % sur la seule année 2008 et environ deux tiers de sa valeur entre avril 2008 et
février 2009, avec une reprise nettement plus lente que celle des marchés développés.

Aujourd'hui, le marché est **71 % au-dessus de son sommet de 2016**, après une hausse de **+277 %**
depuis le creux — plus forte que les +119 % du cycle précédent — et à un multiple deux fois
supérieur à sa moyenne. Cela ne dit pas qu'une baisse est imminente : un marché cher peut le rester
des années, et la croissance des bénéfices est réelle. Cela dit que le scénario baissier n'est pas
une hypothèse d'école sur ce marché, qu'il s'y est produit une fois en dix ans, et qu'aucun chiffre
de ce rapport ne l'a jamais rencontré.

### Ce que je ne peux pas te dire

**Je n'ai pas testé si la valorisation prédit les rendements sur la BRVM, et je ne peux pas le
faire** : 5,5 ans de données contiennent environ un seul cycle de valorisation, ce qui ne permet
aucune conclusion statistique. Ce qui précède est de l'arithmétique de valorisation, pas un
backtest. C'est un raisonnement solide mais d'une nature différente du reste du rapport, et il faut
le lire comme tel.

Deux réserves de données s'y ajoutent : le PER actuel repose sur 29 sociétés seulement (celles dont
le BNPA 2025 est renseigné), et il rapporte des cours de septembre 2026 à des bénéfices 2025. Si les
bénéfices 2026 progressent de 10 %, le PER réel est plutôt autour de 13 — toujours près du double de
sa moyenne historique.

---

## 8. Limites — à lire avant d'engager de l'argent

Ce rapport mesure un passé exceptionnel. Il ne prédit rien.

- **Un seul régime, 5,5 ans, et c'est une jambe de reprise.** Les données commencent le
  7 avril 2021, trois mois après le creux du cycle précédent. Le marché avait auparavant perdu
  54,6 % en quatre ans et dix mois, dont −29,2 % sur la seule année 2018. **Un échantillon qui
  commence au creux d'un cycle ne peut pas contenir le contre-exemple** : voir section 7. 2022 et
  2023 ont été plats (−0,4 % et −0,2 % en médiane), c'est le seul test de résistance disponible. Le BRVM Composite a presque doublé en 16 mois (295,6 → 548,4) : après une
  telle hausse, le risque de retour à la moyenne est élevé, et la conclusion « ne filtre rien »
  est précisément celle qui souffrira le plus dans un marché baissier.
- **Biais de survie confirmé et non corrigé.** Movis CI (SVOC) a été radié le 26/06/2025 après
  dégradation financière : il est absent de `data/daily/`. Tous les chiffres ci-dessus excluent au
  moins une perte totale. L'ampleur du biais n'est pas quantifiée faute de la liste complète des
  radiations depuis 2021.
- **Dividendes incomplets.** 151 couples ticker-exercice sur ~215 possibles, et une partie des
  fiches porte `"confiance": "moyenne"`. Les 7,33 %/an sont une estimation.
- **Fondamentaux courts.** L'historique commence à l'exercice 2021, d'où la fenêtre factorielle
  réduite à 47 mois et seulement 4 rebalancements annuels indépendants. C'est peu pour conclure.
- **Frais : deux corrections déjà faites.** J'ai d'abord retenu 3,3 % aller-retour (TAF appliquée
  par-dessus des commissions de 1,4 %) puis des droits de garde en pourcentage de 0,25 à 2 %/an.
  Les deux étaient faux : le total est 2,8 % aller-retour, et la tenue de compte est un forfait de
  0 à 15 625 F par an. Les chiffres de ce rapport intègrent la correction. Leçon : une estimation
  de frais reconstituée depuis des sources secondaires peut se tromper d'un facteur deux, et il
  faut la confronter à la grille tarifaire réelle avant de conclure.
- **Le tilt top20 est dans le bruit.** +2,3 points de médiane pour un écart-type de 3,3 % : ce
  n'est pas une preuve, c'est une indication.

### Ce que ces limites impliquent sur la méthode

La littérature sur les marchés frontières trouve la prime de faible volatilité significative
**sauf en phase haussière**. C'est exactement ce qu'on observe, et de façon robuste sur les
12 calendriers de rebalancement (CAGR médian) :

| Stratégie | 2022-11 → 2024-06 *(phase molle)* | 2024-07 → 2026-09 *(phase haussière)* |
|---|---|---|
| Équipondéré | +6,1 % | **+69,1 %** |
| top20 value+lowvol | **+10,0 %** | +65,9 % |
| top8 value+lowvol | **+12,2 %** | +56,2 % |

Le tilt gagne quand le marché stagne et perd quand il s'envole — et plus il est concentré, plus
cet arbitrage est marqué. **Le tilt n'est donc pas là pour gagner plus maintenant, mais pour
perdre moins quand le marché se retournera.** C'est le seul argument solide en sa faveur, et il
est invisible dans le CAGR global. Si l'on croit que le régime 2025-2026 continue, l'équipondéré
pur est le bon choix ; si l'on pense que la hausse s'épuise, le tilt top20 est l'assurance — et
elle coûte environ 3 points de CAGR par an en prime tant que la hausse dure.

---

## 9. Sources

- [BRVM — Quels sont les frais applicables ?](https://www.brvm.org/fr/node/312)
- [BRVM — Tarification](https://www.brvm.org/fr/textes-reglementaires/tarification)
- [Richbourse — Ouvrir un compte titres à la BRVM : frais](https://www.richbourse.com/common/apprendre/ouvrir-compte-titres)
- [Richbourse — Ouvrir un compte titres : quelle SGI, quels frais](https://www.richbourse.com/common/apprendre/ouvrir-compte-titres) (grille comparative des 40 SGI, relevée le 02/10/2026)
- [Richbourse — Tarifs des SGI](https://www.richbourse.com/common/apprendre/tarif-sgi)
- [Sikafinance — Liste des SGI de la BRVM](https://www.sikafinance.com/sgi_de_la_brvm)
- [Movis CI officiellement radié de la cote de la BRVM](https://www.african-markets.com/fr/bourse/brvm/movis-ci-officiellement-radie-de-la-cote-de-la-brvm)
- [Suspensions à la BRVM — le sabre à moitié tiré](https://www.lejecos.com/SUSPENSIONS-A-LA-BRVM-Le-sabre-a-moitie-tire_a31522.html)
- [The low-volatility effect in African frontier equity markets](https://www.tandfonline.com/doi/full/10.1080/10293523.2024.2361986)
- [Extending value and momentum to frontier market stocks](https://www.cxoadvisory.com/8622/value-premium/extending-value-and-momentum-to-frontier-market-stocks/)
- [Is there an illiquidity premium in frontier markets?](https://www.sciencedirect.com/science/article/pii/S1566014119302481)
- [BRVM — 2025 : la consolidation quinquennale, 99,15 % de progression en 5 ans](https://www.brvm.org/fr/mediacentre/actualites/2025-la-consolidation-quinquennale-9915-de-progression-en-5-ans)
- [Raisons de la baisse spectaculaire de la BRVM en 2018](https://www.sikafinance.com/marches/raisons-de-la-baisse-spectaculaire-de-la-brvm-en-2018_15848)
- [Krach boursier ou simple correction de la BRVM en 2017 ?](https://www.financialafrik.com/2018/01/23/krach-boursier-ou-simple-correction-de-la-brvm-en-2017/)
- [Indice BRVM Composite : vers la renaissance du marché actions ? (avril 2021)](https://www.financialafrik.com/2021/04/10/indice-brvm-composite-vers-la-renaissance-du-marche-actions-de-la-bourse-regionale/)
- [Frontier Markets: A Short History](https://foreignpolicy.com/2013/03/04/frontier-markets-a-short-history/)
