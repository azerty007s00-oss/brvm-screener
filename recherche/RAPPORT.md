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

### 1.2 Le barème de frais utilisé est 2,5× trop faible

`backtest.py` applique 0,65 % par sens, soit 1,3 % aller-retour. Le barème réel :

| Poste | Taux |
|---|---|
| Commission BRVM | 0,2 – 0,3 % par sens |
| Commission DC/BR (règlement-livraison) | 0,1 % par sens |
| Courtage SGI | plafonné à 1 % par sens, homologué CREPMF |
| Taxe sur activités financières | s'ajoute aux commissions |
| **Total aller-retour** | **≈ 3,3 %** |
| Droits de garde annuels | 0,25 %/an (Hudson & Cie) à **2 %/an** (SOGEBOURSE, 0,5 %/trimestre) |

Conséquence directe : **le choix de la SGI pèse plus lourd que n'importe quel signal.** Passer de
2 %/an à 0,25 %/an de droits de garde rapporte 1,75 point de CAGR, garanti, sans risque. Aucun
indicateur technique du dépôt ne produit un gain de cette taille avec cette certitude.

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
| Équipondéré, tout l'univers | +38,1 % | **+42,3 %** | +44,3 % | **1,8 %** |
| top20 value+lowvol | +37,4 % | **+44,6 %** | +47,0 % | 3,3 % |
| top12 value+lowvol | +36,3 % | +41,0 % | +47,3 % | 3,7 % |
| top8 value+lowvol | +27,5 % | +37,9 % | +47,3 % | 5,8 % |
| top5 value+lowvol | +24,6 % | +34,8 % | +45,7 % | 6,5 % |

C'est le tableau le plus important du rapport. **Plus le portefeuille est concentré, plus le
résultat dépend du hasard du calendrier.** Un top8 peut afficher +47,3 % ou +27,5 % selon le mois
où l'on rebalance : annoncer le premier chiffre comme une performance de stratégie serait
malhonnête. L'équipondéré large est le seul dont le résultat ne bouge pas (±1,8 %).

**top20 est le seul tilt défendable** : médiane 2,3 points au-dessus de l'équipondéré, et surtout
un plancher équivalent (+37,4 % contre +38,1 %). Il améliore le médian sans dégrader le pire cas.
Les concentrations plus fortes effondrent le plancher. La règle qui en découle : **au moins 20
lignes.**

### CAGR médian selon la fréquence de rebalancement

| Stratégie | annuel | semestriel | trimestriel | mensuel |
|---|---|---|---|---|
| Équipondéré | +42,3 % | +43,4 % | +43,0 % | +42,0 % |
| top20 value+lowvol | **+44,6 %** | +41,4 % | +37,5 % | +33,9 % |
| top8 value+lowvol | +37,9 % | +36,8 % | +34,3 % | +30,1 % |

**La fréquence est le paramètre dominant.** L'équipondéré y est insensible (il ne tourne pas).
Dès qu'on sélectionne, chaque accélération du rythme coûte : top20 perd 10,7 points en passant
d'annuel à mensuel. À 3,3 % d'aller-retour, la rotation est l'ennemi principal, très au-dessus de
la qualité du signal.

---

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

### Le minimum de perception par ordre : question tranchée

J'avais signalé ce paramètre comme celui qui pouvait annuler la diversification. Les barèmes
homologués publiés citent un **minimum d'environ 1 000 FCFA par ordre**. Avec 1,65 % par sens, le
minimum ne s'applique qu'en dessous de **60 500 F par ligne** :

| Capital | 12 lignes | 15 lignes | 20 lignes | 25 lignes |
|---|---|---|---|---|
| 1 M | 1,65 % | 1,65 % | **2,00 %** | **2,50 %** |
| 2 M | 1,65 % | 1,65 % | 1,65 % | 1,65 % |
| 3 M et plus | 1,65 % | 1,65 % | 1,65 % | 1,65 % |

**À partir de 2 M FCFA le minimum ne mord jamais** : diversifier ne coûte rien de plus. À 1 M, tenir
25 lignes au lieu de 12 coûte 0,85 point de capital — **une seule fois, à l'entrée**. En face,
25 lignes rapportent 3,4 points de CAGR **par an** de plus que 12 (section 3). L'arbitrage n'est pas
serré : on garde 25 lignes.

Deux réserves. Le taux de 1,65 % par sens retient l'hypothèse haute (TAF appliquée aux commissions
de 1,4 %) ; certaines présentations donnent 1,4 % comme total toutes taxes comprises, auquel cas
tout ce qui précède est encore plus favorable. Et 1 000 F est un ordre de grandeur relevé sur des
barèmes publics : si ta SGI pratique 5 000 F, le seuil monte à 303 000 F par ligne et il faut
refaire le calcul — `python strategie/panier.py --capital 2000000 --minimum-ordre 5000` le fait.

Reste donc à confirmer par écrit auprès de la SGI : le minimum exact, et si la TAF est comprise ou
s'ajoute.

---

## 6. Ce que les données disent de faire

Classé par rapport gain/certitude, le plus sûr d'abord :

1. **Choisir la SGI sur les droits de garde, pas sur le courtage.** 0,25 %/an contre 2 %/an :
   +1,75 point de CAGR, certain, sans risque. Le levier le plus rentable du dossier. Attention au
   minimum trimestriel de conservation (1 250 F/trimestre chez certaines SGI, soit 5 000 F/an) :
   sur un portefeuille de 1 M FCFA, un taux affiché de 0,25 % ne coûte pas 2 500 F mais 5 000 F.
2. **Panier équipondéré de 20 à 25 lignes, rebalancé une fois par an**, dividendes réinvestis.
   Médiane +42,3 % sur la période, écart-type 1,8 % selon le calendrier, max drawdown ~5 %.
3. **Tilt optionnel vers top20 value + faible volatilité** (rendement bénéficiaire et volatilité
   60 j). Médiane +44,6 %, plancher inchangé. Gain réel mais modeste, et dans le bruit.
4. **Ne jamais rebalancer plus d'une fois par semestre.** C'est le paramètre le plus coûteux.
5. **Retirer SEMC et SICC de l'univers** et ajouter une détection de suspension.
6. **Récupérer les dates de détachement** si l'on veut encore tester l'événementiel. Les dates de mise en paiement, elles, sont acquises et servent à la trésorerie.

Et ce qu'il faut arrêter : les stops à 8 %, la revue bi-mensuelle, la détention plafonnée à
90 jours, et la sélection à moins de 20 lignes. Ces quatre paramètres ont coûté de l'argent sur
toute la période mesurée.

---

## 7. Limites — à lire avant d'engager de l'argent

Ce rapport mesure un passé exceptionnel. Il ne prédit rien.

- **Une seule régime, 5,5 ans.** Le +42 % est tiré par 2021 et 2025-2026. 2022 et 2023 ont été
  plats (−0,4 % et −0,2 % en médiane). **Un marché où 95 % des titres montent n'est pas l'état
  normal d'un marché.** Le BRVM Composite a presque doublé en 16 mois (295,6 → 548,4) : après une
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
- **Frais estimés.** 3,3 % aller-retour est reconstitué depuis les barèmes publics ; le barème
  exact de la SGI et le minimum par ordre restent à confirmer.
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

## 8. Sources

- [BRVM — Quels sont les frais applicables ?](https://www.brvm.org/fr/node/312)
- [BRVM — Tarification](https://www.brvm.org/fr/textes-reglementaires/tarification)
- [Richbourse — Ouvrir un compte titres à la BRVM : frais](https://www.richbourse.com/common/apprendre/ouvrir-compte-titres)
- [Comparatif des SGI de la BRVM 2026](https://fluxbourse.com/articles/quelle-sgi-choisir-brvm-2026)
- [Sikafinance — Liste des SGI de la BRVM](https://www.sikafinance.com/sgi_de_la_brvm)
- [Movis CI officiellement radié de la cote de la BRVM](https://www.african-markets.com/fr/bourse/brvm/movis-ci-officiellement-radie-de-la-cote-de-la-brvm)
- [Suspensions à la BRVM — le sabre à moitié tiré](https://www.lejecos.com/SUSPENSIONS-A-LA-BRVM-Le-sabre-a-moitie-tire_a31522.html)
- [The low-volatility effect in African frontier equity markets](https://www.tandfonline.com/doi/full/10.1080/10293523.2024.2361986)
- [Extending value and momentum to frontier market stocks](https://www.cxoadvisory.com/8622/value-premium/extending-value-and-momentum-to-frontier-market-stocks/)
- [Is there an illiquidity premium in frontier markets?](https://www.sciencedirect.com/science/article/pii/S1566014119302481)
