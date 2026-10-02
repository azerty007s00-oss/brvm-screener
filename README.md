# 📈 BRVM Stock Screener - Investment Pioneers

Analyse technique multi-critères pour actions BRVM (Bourse Régionale des Valeurs Mobilières).

## Fonctionnalités

### Indicateurs techniques
- **RSI (14)** - Relative Strength Index
- **Stochastic (14,3)** - Oscillateur stochastique (%K / %D)
- **ADX (14)** - Average Directional Index (force de la tendance)
- **Moyennes Mobiles** - MA20, MA50, MA200 (ou MA100 en fallback adaptatif)
- **Golden / Death Cross** - croisements MA
- **MACD (12,26,9)** - ligne, signal, histogramme
- **Bandes de Bollinger (20,2)** - squeeze détecté automatiquement
- **Volume relatif** - vs moyenne 20 jours
- **Performance relative** - alpha vs indice BRVMC
- **Supports / Résistances** - extrema locaux sur 20 séances
- **Configuration chartiste** - canal ascendant/descendant, range, squeeze

### Scoring multi-critères
7 critères → score de -8 à +8 :
- 🟢 **ACHAT** : score ≥ +3
- 🟡 **NEUTRE** : -2 à +2
- 🔴 **VENTE** : score ≤ -3

### Tendance Long Terme Adaptative
Le screener utilise la MA200 quand les données sont suffisantes (≥ 200 séances).
Sinon, il bascule automatiquement sur la **MA100** comme proxy long terme,
ce qui permet de toujours calculer la Tendance LT même avec un historique limité.

### Actualités
Scraping automatique des dernières actualités Sika Finance pour chaque titre analysé.

## Installation

```bash
pip install -r requirements.txt
streamlit run app.py
```

## Architecture

| Fichier | Rôle |
|---|---|
| `config.py` | Constantes, mapping tickers, paramètres indicateurs |
| `scraper.py` | Scraping OHLCV + actualités depuis Sika Finance |
| `cache.py` | Cache fichier local (TTL 1h) |
| `indicators.py` | Calcul RSI, MA, MACD, Bollinger, Stochastic, ADX |
| `scoring.py` | Scoring multi-critères → signal ACHAT/NEUTRE/VENTE |
| `analysis.py` | Analyse narrative complète par section |
| `app.py` | Interface Streamlit |
| `recherche/etude_facteurs.py` | Étude de rentabilité sur les données réelles (facteurs, robustesse, dimensionnement) |
| `recherche/RAPPORT.md` | Conclusions chiffrées et limites de l'étude |
| `strategie/panier.py` | Panier à faible rotation : univers, classement, ordres de rebalancement |

## Stratégie à faible rotation

L'approche technique du screener (revue bi-mensuelle, stop à 8 %, détention plafonnée
à 90 jours) n'a pas été rentable sur 2021-2026. L'étude dans `recherche/` en donne les
causes mesurées : le dividende était absent du backtest (7,33 %/an omis), les frais y
valaient 1,3 % aller-retour contre 3,3 % réels, et sur un marché où 95 % des titres
montaient, chaque filtre retirait de la valeur.

`strategie/panier.py` applique ce que les données valident :

```bash
python strategie/panier.py --capital 2000000
python strategie/panier.py --capital 2000000 --portefeuille portfolio.json
```

- **25 lignes équipondérées**, classées sur rendement bénéficiaire + faible volatilité
- **liquidité en filtre, jamais en critère de tri** — trier dessus coûte ~7 points de CAGR
- **rebalancement annuel** — le même panier perd 10,7 points en passant au mensuel
- détection automatique des titres dont la cotation s'est arrêtée (SEMC et SICC
  depuis le 16/09/2026), signalés comme non liquidables

Reproduire l'étude : `python recherche/etude_facteurs.py`. Lire `recherche/RAPPORT.md`
section 7 avant d'engager de l'argent : les chiffres mesurent un passé exceptionnel.

## Changelog v2

- ✅ **Fix Tendance LT** - MA adaptative (MA200 → MA100 fallback) : plus de "N/D" systématique
- ✅ **Stochastic Oscillator** - nouvel indicateur + critère de scoring + graphique
- ✅ **ADX** - force de tendance avec +DI/-DI
- ✅ **Actualités** - scraping news Sika Finance par titre
- ✅ **Alertes enrichies** - convergence RSI+Stochastic, ADX forte tendance
- ✅ **Tableau récap** - colonnes Stoch %K et ADX ajoutées
- ✅ **Scoring étendu** - 7 critères (ajout Stochastic), range -8/+8
