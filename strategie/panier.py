#!/usr/bin/env python3
"""
panier.py - Construction et rebalancement du panier BRVM a faible rotation.

Remplace l'approche du screener (revue bi-mensuelle, stop a 8 %, detention
plafonnee a 90 jours) par la seule approche que les donnees valident sur
2021-2026. Voir recherche/RAPPORT.md pour les mesures.

Trois regles, chacune issue d'un resultat chiffre :

  1. La liquidite est un FILTRE, jamais un critere de classement.
     Selectionner les 25 titres les plus liquides donne +35,6 % de CAGR
     median ; les selectionner par value+lowvol donne +44,4 %. Ecarter les
     titres non negociables, puis classer sur les facteurs.

  2. Le classement se fait sur rendement beneficiaire + faible volatilite.
     Seuls facteurs robustes de l'etude (IC 12 mois +0,116 et +0,085).
     Momentum 12 mois : aucun signal. Prime d'illiquidite : inexistante.

  3. Rebalancement ANNUEL. A 3,3 % d'aller-retour, la frequence domine la
     qualite du signal : le meme panier perd 10,7 points de CAGR en passant
     d'annuel a mensuel. Un rebalancement de plus d'une fois par semestre
     detruit l'avantage qu'il cherche a capter.

25 lignes est le reglage retenu : c'est celui dont le pire calendrier de
rebalancement reste le meilleur (+39,2 %, contre +38,1 % pour l'univers
entier et +37,4 % a 20 lignes).

Usage :
    python strategie/panier.py --capital 2000000
    python strategie/panier.py --versement-eur 50 --portefeuille portfolio.json
    python strategie/panier.py --capital 2000000 --lignes 20 --courtage 0.008
    python strategie/panier.py --capital 2000000 --portefeuille portfolio.json
    python strategie/panier.py --capital 2000000 --sans-tilt
"""

import argparse
import glob
import json
import os
from datetime import date

import numpy as np
import pandas as pd

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

INDICES = {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}

# --- Bareme de frais -------------------------------------------------------
# Par sens. La grille comparative des SGI (Richbourse, relevee le 02/10/2026)
# donne le total : "comptez autour de 1,4 % du montant de l'ordre, tous frais
# confondus ; sur un achat de 1 000 000 FCFA, une quinzaine de milliers de
# francs". Avec 1 % de courtage, cela laisse 0,4 % pour la commission de
# marche (BRVM + depositaire central) et la taxe sur les activites
# financieres reunies.
FRAIS_MARCHE_PAR_SENS = 0.004   # BRVM + DC/BR + TAF, hors courtage SGI
COURTAGE_SGI_DEFAUT   = 0.010   # plafond homologue AMF-UMOA, applique par 28 SGI sur 35

# Minimum de perception par ordre. Les baremes homologues publies en citent
# autour de 1 000 F. C'est le parametre qui decide du nombre de lignes tenable :
# en dessous d'un certain montant par ligne, le minimum remplace le pourcentage
# et le cout d'entree augmente a mesure qu'on diversifie.
MINIMUM_PAR_ORDRE     = 1_000.0

# Frais de tenue de compte, annuels et FORFAITAIRES : de 0 F (BNI Finances,
# AGI, Atlantique Finance) a 15 625 F (One Africa Markets, Kerales Finance).
# Ce n'est pas un pourcentage, donc le poids relatif s'effondre quand le
# capital grandit : 15 625 F valent 1,56 %/an sur 1 M FCFA et 0,16 % sur 10 M.
# Sur un petit portefeuille, ce forfait pese plus lourd que l'ecart de
# courtage entre deux SGI.
FRAIS_TENUE_COMPTE    = 10_000.0   # mediane de la grille ; a remplacer par le reel

# Poids maximal d'une ligne, applique a l'achat. Un versement mensuel vise une
# seule ligne a la fois : sans plafond, la concentration derive vite. Mesure sur
# 2021-2026, la regle "renforcer ce qui a le plus baisse" finit sans plafond
# avec 16 lignes et 31,9 % sur un seul titre. 8 % vaut deux fois le poids cible
# d'un panier de 25 lignes : assez souple pour laisser respirer, assez ferme
# pour qu'aucune ligne ne domine.
PLAFOND_PAR_LIGNE     = 0.08

# Fenetre du plus haut servant a la regle "creux".
FENETRE_PLUS_HAUT     = 252

# --- Parametres de construction --------------------------------------------
LIQUIDITE_MIN_FCFA    = 2_000_000   # valeur echangee moyenne sur 60 seances
NB_LIGNES_DEFAUT      = 25
FENETRE_LIQUIDITE     = 60
FENETRE_VOLATILITE    = 60

# Un titre dont la derniere cotation retarde de plus de ce nombre de seances
# sur le marche est suspendu ou radie : son dernier cours est fige et la
# position n'est pas liquidable.
SEUIL_RETARD_SUSPENSION = 10


def frais_par_sens(courtage_sgi: float = COURTAGE_SGI_DEFAUT) -> float:
    """
    Frais d'un ordre en fraction du montant, hors minimum de perception.

    Au plafond de courtage de 1 %, cela donne 1,4 % par sens, soit 2,8 %
    aller-retour. Une version anterieure de ce module retenait 1,65 % par
    sens, en appliquant la TAF par-dessus des commissions de 1,4 % : la grille
    des SGI montre que le 1,4 % est deja le total toutes taxes comprises.
    """
    return courtage_sgi + FRAIS_MARCHE_PAR_SENS


def frais_ordre(montant: float,
                courtage_sgi: float = COURTAGE_SGI_DEFAUT,
                minimum: float = MINIMUM_PAR_ORDRE) -> float:
    """Frais reels d'un ordre : le pourcentage, ou le minimum s'il est superieur."""
    return max(minimum, montant * frais_par_sens(courtage_sgi))


def seuil_minimum_mordant(courtage_sgi: float = COURTAGE_SGI_DEFAUT,
                          minimum: float = MINIMUM_PAR_ORDRE) -> float:
    """
    Montant par ligne en dessous duquel le minimum de perception s'applique.

    Au-dessus, diversifier ne coute rien de plus : le cout d'entree reste
    proportionnel au capital quel que soit le nombre de lignes. En dessous,
    chaque ligne supplementaire coute le minimum en entier.
    """
    taux = frais_par_sens(courtage_sgi)
    return minimum / taux if taux > 0 else float("inf")


# --- Donnees ---------------------------------------------------------------

def charger_marche() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Cloture et volume quotidiens, date x ticker, indices exclus."""
    cloture, volume = {}, {}
    for chemin in glob.glob(os.path.join(RACINE, "data", "daily", "*.csv")):
        ticker = os.path.basename(chemin)[:-4]
        if ticker in INDICES:
            continue
        df = pd.read_csv(chemin, parse_dates=["date"]).set_index("date").sort_index()
        if df.empty:
            continue
        cloture[ticker], volume[ticker] = df["close"], df["volume"]
    return (pd.DataFrame(cloture).sort_index(),
            pd.DataFrame(volume).sort_index().fillna(0))


def charger_fondamentaux() -> tuple[dict, dict]:
    """Retourne {(ticker, exercice): dps} et {(ticker, exercice): bnpa}."""
    chemin = os.path.join(RACINE, "data", "fundamentals_history.json")
    with open(chemin, encoding="utf-8-sig") as fichier:
        stocks = json.load(fichier)["stocks"]
    dps, bnpa = {}, {}
    for ticker, fiche in stocks.items():
        for exercice, rec in (fiche.get("history") or {}).items():
            exercice = int(exercice)
            if rec.get("dividende") is not None:
                dps[(ticker, exercice)] = float(rec["dividende"])
            if rec.get("bnpa") is not None:
                bnpa[(ticker, exercice)] = float(rec["bnpa"])
    return dps, bnpa


def exercice_publie(a_la_date: date) -> int:
    """
    Dernier exercice dont les comptes sont publies a cette date.

    Les societes BRVM publient entre avril et juin : avant juillet, seul
    l'exercice N-2 est disponible. Utiliser N-1 plus tot anticiperait une
    information non publique.
    """
    return a_la_date.year - 1 if a_la_date.month >= 7 else a_la_date.year - 2


# --- Univers investissable -------------------------------------------------

def detecter_suspensions(cloture: pd.DataFrame) -> dict[str, pd.Timestamp]:
    """
    Titres dont la cotation s'est arretee alors que le marche continue.

    Retourne {ticker: derniere_cotation}. Ne distingue pas suspension de
    radiation : dans les deux cas la position n'est pas liquidable, ce qui
    est la seule chose qui compte pour la construction du panier.
    """
    if cloture.empty:
        return {}
    seances = cloture.index
    derniere_du_marche = seances[-1]
    limite = seances[max(0, len(seances) - 1 - SEUIL_RETARD_SUSPENSION)]
    suspendus = {}
    for ticker in cloture.columns:
        serie = cloture[ticker].dropna()
        if serie.empty:
            continue
        if serie.index[-1] < limite:
            suspendus[ticker] = serie.index[-1]
    return dict(sorted(suspendus.items(), key=lambda kv: kv[1]))


def univers_investissable(
        cloture: pd.DataFrame,
        volume: pd.DataFrame,
        liquidite_min: float = LIQUIDITE_MIN_FCFA,
) -> tuple[list[str], dict[str, str]]:
    """
    Titres reellement achetables, et le motif d'exclusion des autres.

    La liquidite sert uniquement a ecarter ce qui n'est pas negociable. Elle
    n'intervient pas dans le classement : trier sur la liquidite coute
    environ 7 points de CAGR (cf. RAPPORT.md section 3).
    """
    liquidite = (cloture * volume).rolling(
        FENETRE_LIQUIDITE, min_periods=20).mean().iloc[-1]
    suspendus = detecter_suspensions(cloture)

    eligibles, exclus = [], {}
    for ticker in sorted(cloture.columns):
        if ticker in suspendus:
            exclus[ticker] = (f"cotation arretee depuis le "
                              f"{suspendus[ticker].date()}")
        elif pd.isna(liquidite.get(ticker)) or liquidite[ticker] < liquidite_min:
            valeur = liquidite.get(ticker)
            montant = "inconnue" if pd.isna(valeur) else f"{valeur / 1e6:.2f} M"
            exclus[ticker] = f"liquidite {montant} F/jour < {liquidite_min / 1e6:.0f} M"
        else:
            eligibles.append(ticker)
    return eligibles, exclus


# --- Classement ------------------------------------------------------------

def scores(
        cloture: pd.DataFrame,
        bnpa: dict,
        univers: list[str],
        a_la_date: date | None = None,
) -> pd.DataFrame:
    """
    Score de classement : moyenne des rangs de rendement beneficiaire et de
    faible volatilite.

    Un facteur manquant vaut la mediane de l'univers (facteur neutre), et non
    le dernier rang. On pourrait croire l'inverse preferable, puisque ne pas
    publier ses comptes est un signal de difficulte - SEMC et SICC ont ete
    suspendus pour ce motif. Mesure faite : penaliser l'absence de donnee
    degrade le CAGR median de 44,4 % a 43,6 % et son plancher de 39,2 % a
    35,4 %. Environ 7 titres sur 43 n'ont pas de BNPA un mois donne ; les
    ecarter revient a jeter trop d'univers pour le signal gagne.
    """
    a_la_date = a_la_date or cloture.index[-1].date()
    exercice = exercice_publie(a_la_date)
    dernier = cloture[univers].iloc[-1]
    volatilite = (cloture[univers].pct_change()
                  .rolling(FENETRE_VOLATILITE, min_periods=30)
                  .std().iloc[-1] * np.sqrt(252))

    rendement_benef = pd.Series(
        {t: bnpa[(t, exercice)] / dernier[t]
         for t in univers
         if (t, exercice) in bnpa and dernier[t] > 0},
        dtype=float).reindex(univers)

    table = pd.DataFrame({
        "prix":            dernier,
        "rdt_beneficiaire": rendement_benef,
        "volatilite":      volatilite,
    })
    rang_valeur = table["rdt_beneficiaire"].rank(pct=True)
    rang_vol    = (-table["volatilite"]).rank(pct=True)
    table["score"] = pd.concat([
        rang_valeur.fillna(rang_valeur.median()),
        rang_vol.fillna(rang_vol.median()),
    ], axis=1).mean(axis=1)
    table["exercice_utilise"] = exercice
    return table.sort_values("score", ascending=False)


# --- Panier ----------------------------------------------------------------

def _budget_optimal(capital: float, prix: list[float]) -> float:
    """
    Plus grand budget par ligne tel que l'achat en nombres entiers d'actions
    tienne dans le capital.

    Repartir naivement capital/n puis arrondir a l'entier inferieur laisse
    jusqu'a 14 % du capital non investi, parce que chaque ligne perd une
    fraction d'action. Ce cash coute environ 4 points de CAGR a 1 M FCFA.
    Relever le budget uniforme jusqu'a saturation recupere l'essentiel, sans
    privilegier les titres a petit nominal : tous les poids montent ensemble.
    """
    if not prix:
        return 0.0
    bas, haut = capital / len(prix), capital
    for _ in range(60):
        milieu = (bas + haut) / 2
        total = sum(int(milieu // p) * p for p in prix)
        if total <= capital:
            bas = milieu
        else:
            haut = milieu
    return bas


def panier_cible(
        capital: float,
        cloture: pd.DataFrame,
        volume: pd.DataFrame,
        bnpa: dict,
        nb_lignes: int = NB_LIGNES_DEFAUT,
        liquidite_min: float = LIQUIDITE_MIN_FCFA,
        avec_tilt: bool = True,
) -> tuple[pd.DataFrame, dict[str, str]]:
    """
    Panier cible equipondere, en nombres entiers d'actions.

    avec_tilt=False equipondere tout l'univers eligible au lieu d'en
    selectionner les meilleurs : c'est le panier de reference de l'etude
    (+42,3 % de CAGR median contre +44,4 %), plus large et plus previsible.
    """
    eligibles, exclus = univers_investissable(cloture, volume, liquidite_min)
    if not eligibles:
        return pd.DataFrame(), exclus

    table = scores(cloture, bnpa, eligibles)
    retenus = list(table.index) if not avec_tilt else list(table.index[:nb_lignes])

    # Un titre dont une seule action depasse le budget par ligne est ecarte :
    # l'acheter deformerait les poids au-dela de la cible.
    budget = capital / len(retenus)
    trop_chers = [t for t in retenus if table.at[t, "prix"] > budget]
    for ticker in trop_chers:
        exclus[ticker] = (f"1 action = {table.at[ticker, 'prix']:,.0f} F "
                          f"> budget par ligne {budget:,.0f} F")
    retenus = [t for t in retenus if t not in trop_chers]
    if not retenus:
        return pd.DataFrame(), exclus

    budget = _budget_optimal(capital, [float(table.at[t, "prix"]) for t in retenus])
    lignes = []
    for ticker in retenus:
        prix = float(table.at[ticker, "prix"])
        quantite = int(budget // prix)
        if quantite < 1:
            continue
        lignes.append({
            "ticker":            ticker,
            "prix":              prix,
            "quantite":          quantite,
            "montant":           quantite * prix,
            "score":             round(float(table.at[ticker, "score"]), 3),
            "rdt_beneficiaire":  table.at[ticker, "rdt_beneficiaire"],
            "volatilite":        table.at[ticker, "volatilite"],
        })
    panier = pd.DataFrame(lignes).set_index("ticker")
    if not panier.empty:
        panier["poids"] = panier["montant"] / panier["montant"].sum()
    return panier, exclus


def mois_de_paiement() -> dict[str, list[int]]:
    """
    Mois ou chaque titre a historiquement mis ses dividendes en paiement.

    Lu sur le calendrier officiel releve dans data/dividendes_paiements.csv.
    Sert a la tresorerie : savoir quand le cash tombe. Ce n'est pas la date de
    detachement, donc cela ne dit pas jusqu'a quand il faut detenir le titre
    pour y avoir droit.
    """
    chemin = os.path.join(RACINE, "data", "dividendes_paiements.csv")
    if not os.path.exists(chemin):
        return {}
    table = pd.read_csv(chemin, parse_dates=["date"])
    table = table[(table["type"] == "paiement") & table["ticker"].notna()]
    calendrier: dict[str, list[int]] = {}
    for ticker, groupe in table.groupby("ticker"):
        mois = sorted(set(groupe["date"].dt.month))
        calendrier[str(ticker)] = mois
    return calendrier


def dividendes_attendus(panier: pd.DataFrame, dps: dict,
                        a_la_date: date | None = None) -> pd.DataFrame:
    """
    Dividende annuel attendu, au dernier montant par action connu.

    C'est une projection sur le passe, pas une annonce : le conseil peut
    couper ou augmenter. Les 7,33 %/an mesures sur 2022-2026 sont la moyenne
    d'un marche en expansion.
    """
    a_la_date = a_la_date or date.today()
    exercice = exercice_publie(a_la_date)
    calendrier = mois_de_paiement()
    lignes = []
    for ticker, ligne in panier.iterrows():
        montant, source = None, None
        for recul in range(3):
            if (ticker, exercice - recul) in dps:
                montant = dps[(ticker, exercice - recul)]
                source = exercice - recul
                break
        lignes.append({
            "ticker":    ticker,
            "dps":       montant,
            "exercice":  source,
            "encaisse":  None if montant is None else montant * ligne["quantite"],
            "rendement": None if montant is None else montant / ligne["prix"],
            "mois_paiement": calendrier.get(ticker, []),
        })
    return pd.DataFrame(lignes).set_index("ticker")


# --- Rebalancement ---------------------------------------------------------

def charger_portefeuille(chemin: str) -> dict[str, int]:
    """Lit portfolio.json et retourne {ticker: quantite}."""
    with open(chemin, encoding="utf-8-sig") as fichier:
        contenu = json.load(fichier)
    positions: dict[str, int] = {}
    for ligne in contenu:
        ticker = ligne.get("ticker")
        if ticker:
            positions[ticker] = positions.get(ticker, 0) + int(ligne.get("quantity", 0))
    return positions


def ordres(
        positions: dict[str, int],
        panier: pd.DataFrame,
        cloture: pd.DataFrame,
        courtage_sgi: float = COURTAGE_SGI_DEFAUT,
        minimum_ordre: float = MINIMUM_PAR_ORDRE,
) -> tuple[pd.DataFrame, float]:
    """
    Ordres pour passer des positions actuelles au panier cible, et leur cout.

    Un titre detenu mais absent du panier est vendu au dernier cours connu.
    S'il est suspendu, ce cours est fige et l'ordre ne pourra pas etre
    execute : la colonne 'negociable' le signale.
    """
    suspendus = detecter_suspensions(cloture)
    # ffill, et non la derniere ligne : un titre suspendu n'y cote plus, et sans
    # report il disparaitrait de la table au lieu d'etre signale non liquidable.
    dernier = cloture.ffill().iloc[-1]

    lignes = []
    for ticker in sorted(set(positions) | set(panier.index)):
        detenu = positions.get(ticker, 0)
        cible = int(panier.at[ticker, "quantite"]) if ticker in panier.index else 0
        delta = cible - detenu
        if delta == 0:
            continue
        prix = float(panier.at[ticker, "prix"]) if ticker in panier.index \
            else float(dernier.get(ticker, float("nan")))
        if not np.isfinite(prix):
            continue
        montant = abs(delta) * prix
        lignes.append({
            "ticker":     ticker,
            "sens":       "ACHAT" if delta > 0 else "VENTE",
            "quantite":   abs(delta),
            "prix":       prix,
            "montant":    montant,
            "frais":      frais_ordre(montant, courtage_sgi, minimum_ordre),
            "negociable": ticker not in suspendus,
        })
    table = pd.DataFrame(lignes)
    cout = float(table["frais"].sum()) if not table.empty else 0.0
    return table, cout


# --- Versement mensuel -----------------------------------------------------

REGLES_VERSEMENT = {
    "equilibre": "la ligne la plus eloignee de son poids cible",
    "creux":     "la ligne la plus eloignee de son plus haut sur un an",
}


def ligne_a_renforcer(
        positions: dict[str, int],
        cloture: pd.DataFrame,
        montant: float,
        univers: list[str] | None = None,
        plafond: float = PLAFOND_PAR_LIGNE,
        regle: str = "equilibre",
        courtage_sgi: float = COURTAGE_SGI_DEFAUT,
        minimum: float = MINIMUM_PAR_ORDRE,
        objectif: float | None = None,
) -> dict:
    """
    Quelle ligne acheter avec le versement du mois, et combien.

    Un versement ne paie qu'un seul ordre : a 50 EUR, soit 32 798 F, le minimum
    de perception de 1 000 F represente deja 3 % ; en fractionner deux le
    doublerait. On vise donc une seule ligne, celle que la regle designe parmi
    celles qui resteront sous le plafond apres l'achat.

    regle="equilibre" renforce la ligne la plus sous-ponderee. regle="creux"
    renforce celle qui s'est le plus eloignee de son plus haut sur un an.
    Cette seconde regle a donne +41,1 % de TRI contre +34,3 % sur 2021-2026,
    mais sans plafond et en finissant a 31,9 % sur un seul titre : une fois la
    diversification imposee a 6 %, elle fait moins bien qu'un choix au hasard
    sur les douze dates de depart testees. Elle reste disponible, elle n'est
    pas recommandee.

    objectif est le patrimoine vise a terme. Le plafond s'y applique tant que le
    portefeuille est plus petit, ce qui evite qu'un portefeuille en constitution
    ne se limite aux titres a faible nominal.
    """
    if regle not in REGLES_VERSEMENT:
        raise ValueError(f"regle inconnue : {regle!r}, attendu {set(REGLES_VERSEMENT)}")

    dernier = cloture.ffill().iloc[-1]
    suspendus = detecter_suspensions(cloture)
    univers = univers if univers is not None else list(cloture.columns)

    detenu = {t: positions.get(t, 0) * float(dernier[t])
              for t in univers
              if t in dernier.index and np.isfinite(dernier.get(t, np.nan))}
    patrimoine = sum(detenu.values()) + montant

    negociables, exclus = [], {}
    for ticker in sorted(univers):
        prix = float(dernier.get(ticker, float("nan")))
        if not np.isfinite(prix) or prix <= 0:
            exclus[ticker] = "pas de cours"
        elif ticker in suspendus:
            exclus[ticker] = f"cotation arretee depuis le {suspendus[ticker].date()}"
        elif prix > montant - minimum:
            exclus[ticker] = f"1 action = {prix:,.0f} F, hors budget du versement".replace(",", " ")
        elif patrimoine > 0 and detenu.get(ticker, 0.0) / patrimoine >= plafond:
            poids = detenu.get(ticker, 0.0) / patrimoine
            exclus[ticker] = f"deja {poids:.1%} du portefeuille, plafond {plafond:.0%}"
        else:
            negociables.append(ticker)

    if not negociables:
        return {"ticker": None, "exclus": exclus, "patrimoine": patrimoine}

    if regle == "creux":
        plus_haut = cloture.rolling(FENETRE_PLUS_HAUT, min_periods=60).max().iloc[-1]
        def rang(t):
            h = plus_haut.get(t, float("nan"))
            return float(dernier[t]) / h if np.isfinite(h) and h > 0 else float("inf")
    else:
        def rang(t):
            return detenu.get(t, 0.0)

    cible = min(negociables, key=rang)
    prix = float(dernier[cible])

    # Le plafond limite la quantite, mais n'interdit jamais la premiere action :
    # un portefeuille en constitution ne peut pas etre diversifie, et refuser
    # tout titre dont une action pese plus que le plafond reviendrait a n'acheter
    # que les nominaux les plus bas. La reference est le patrimoine vise quand il
    # est connu, sinon le patrimoine courant.
    reference = max(patrimoine, objectif or 0.0)
    quantite = int((montant - minimum) // prix)
    if reference > 0:
        place = int(max(0.0, (plafond * reference - detenu.get(cible, 0.0)) / prix))
        quantite = min(quantite, max(1, place))
    frais = frais_ordre(quantite * prix, courtage_sgi, minimum)
    while quantite > 0 and quantite * prix + frais > montant:
        quantite -= 1
        frais = frais_ordre(quantite * prix, courtage_sgi, minimum)
    if quantite < 1:
        return {"ticker": None, "exclus": exclus, "patrimoine": patrimoine}

    engage = quantite * prix
    return {
        "ticker":        cible,
        "prix":          prix,
        "quantite":      quantite,
        "montant":       engage,
        "frais":         frais,
        "reste":         montant - engage - frais,
        # Les poids sont rapportes a la reference du plafond, et non au seul
        # patrimoine courant : sur un portefeuille en constitution le second
        # donnerait des pourcentages spectaculaires et sans signification.
        "poids_avant":   detenu.get(cible, 0.0) / reference if reference else 0.0,
        "poids_apres":   (detenu.get(cible, 0.0) + engage) / reference if reference else 0.0,
        "reference":     reference,
        "en_constitution": objectif is not None and patrimoine < objectif,
        "patrimoine":    patrimoine,
        "exclus":        exclus,
        "regle":         regle,
    }


def afficher_versement(montant, choix, plafond, minimum):
    print(f"Versement de {fcfa(montant)} FCFA "
          f"({montant / 655.957:,.0f} EUR a parite fixe)\n".replace(",", " "))
    if choix["ticker"] is None:
        print("Aucune ligne achetable avec ce versement.")
        print("Toutes sont hors budget, suspendues, ou deja au plafond.")
    else:
        print(f"  ACHETER  {choix['ticker']}   {choix['quantite']} action(s) "
              f"a {fcfa(choix['prix'])} F  =  {fcfa(choix['montant'])} F")
        print(f"  frais    {fcfa(choix['frais'])} F "
              f"({choix['frais'] / montant:.2%} du versement)")
        print(f"  reste    {fcfa(choix['reste'])} F, a reporter sur le prochain versement")
        base = ("du patrimoine vise" if choix["en_constitution"]
                else "du portefeuille")
        print(f"\n  poids de la ligne : {choix['poids_avant']:.1%} -> "
              f"{choix['poids_apres']:.1%} {base}  (plafond {plafond:.0%})")
        if choix["en_constitution"]:
            print(f"  portefeuille en constitution : {fcfa(choix['patrimoine'])} F sur "
                  f"{fcfa(choix['reference'])} F vises")
        print(f"  regle appliquee   : {REGLES_VERSEMENT[choix['regle']]}")
    au_plafond = {t: m for t, m in choix["exclus"].items() if "plafond" in m}
    if au_plafond:
        print(f"\n  lignes ecartees car au plafond ({len(au_plafond)}) :")
        for ticker, motif in sorted(au_plafond.items()):
            print(f"    {ticker:8s} {motif}")


# --- Restitution -----------------------------------------------------------

def fcfa(valeur) -> str:
    if valeur is None or (isinstance(valeur, float) and not np.isfinite(valeur)):
        return "n/d"
    return f"{valeur:,.0f}".replace(",", " ")


def afficher(capital, panier, exclus, dividendes, table_ordres, cout, courtage_sgi,
             minimum_ordre=MINIMUM_PAR_ORDRE):
    taux = frais_par_sens(courtage_sgi)
    print(f"Panier cible pour {fcfa(capital)} FCFA "
          f"(courtage SGI {courtage_sgi:.2%} -> {taux:.2%} par sens, "
          f"{2 * taux:.2%} aller-retour)\n")

    if panier.empty:
        print("Aucune ligne constructible avec ce capital.")
        return

    affichage = panier.copy()
    affichage["rdt_benef"] = affichage["rdt_beneficiaire"].map(
        lambda v: "n/d" if pd.isna(v) else f"{v:.1%}")
    affichage["vol"] = affichage["volatilite"].map(
        lambda v: "n/d" if pd.isna(v) else f"{v:.0%}")
    print(f"{'ticker':8s}{'prix':>10s}{'qte':>6s}{'montant':>12s}"
          f"{'poids':>8s}{'score':>7s}{'rdt_bén':>9s}{'vol':>6s}")
    for ticker, ligne in affichage.iterrows():
        print(f"{ticker:8s}{fcfa(ligne['prix']):>10s}{int(ligne['quantite']):>6d}"
              f"{fcfa(ligne['montant']):>12s}{ligne['poids']:>7.1%}"
              f"{ligne['score']:>7.2f}{ligne['rdt_benef']:>9s}{ligne['vol']:>6s}")

    investi = panier["montant"].sum()
    frais_initiaux = sum(frais_ordre(m, courtage_sgi, minimum_ordre)
                         for m in panier["montant"])
    print(f"\n{len(panier)} lignes | investi {fcfa(investi)} F "
          f"({investi / capital:.1%}) | cash residuel "
          f"{fcfa(capital - investi)} F ({1 - investi / capital:.1%})")
    print(f"frais d'entree : {fcfa(frais_initiaux)} F "
          f"({frais_initiaux / capital:.2%} du capital, "
          f"minimum {fcfa(minimum_ordre)} F par ordre)")

    seuil = seuil_minimum_mordant(courtage_sgi, minimum_ordre)
    sous_le_seuil = panier[panier["montant"] < seuil]
    if not sous_le_seuil.empty:
        surcout = frais_initiaux - investi * taux
        print(f"  {len(sous_le_seuil)} ligne(s) sous {fcfa(seuil)} F : le minimum "
              f"s'applique au lieu du pourcentage,")
        print(f"  surcout {fcfa(surcout)} F ({surcout / capital:.2%} du capital, "
              f"une seule fois a l'entree).")
        print(f"  Le garder reste preferable : passer de 25 a 12 lignes economise "
              f"environ 1 point une fois")
        print(f"  et coute 3,4 points de CAGR par an (cf. RAPPORT.md section 3).")

    connus = dividendes[dividendes["dps"].notna()]
    if not connus.empty:
        total = connus["encaisse"].sum()
        print(f"\ndividende annuel attendu : {fcfa(total)} F "
              f"({total / investi:.2%} de l'investi) "
              f"sur {len(connus)}/{len(dividendes)} lignes renseignees")
        print("projection sur le dernier montant connu, pas une annonce.")

        repartition: dict[int, float] = {}
        for ticker, ligne in connus.iterrows():
            mois = ligne["mois_paiement"]
            if not mois:
                continue
            for m in mois:
                repartition[m] = repartition.get(m, 0.0) + ligne["encaisse"] / len(mois)
        if repartition:
            noms = {1: "jan", 2: "fev", 3: "mar", 4: "avr", 5: "mai", 6: "juin",
                    7: "juil", 8: "aout", 9: "sep", 10: "oct", 11: "nov", 12: "dec"}
            calendrier_txt = "  ".join(
                f"{noms[m]} {fcfa(v)}" for m, v in sorted(repartition.items()))
            print(f"repartition par mois de mise en paiement :\n  {calendrier_txt}")

    if table_ordres is not None and not table_ordres.empty:
        print(f"\n--- Ordres de rebalancement ---")
        for _, ligne in table_ordres.iterrows():
            alerte = "" if ligne["negociable"] else "   [SUSPENDU, non executable]"
            print(f"  {ligne['sens']:5s} {ligne['ticker']:8s} "
                  f"{int(ligne['quantite']):>5d} x {fcfa(ligne['prix']):>9s} F "
                  f"= {fcfa(ligne['montant']):>11s} F{alerte}")
        print(f"  frais de rebalancement : {fcfa(cout)} F")
        bloques = table_ordres[~table_ordres["negociable"]]
        if not bloques.empty:
            print(f"  ATTENTION : {len(bloques)} ligne(s) non liquidable(s) "
                  f"(cotation suspendue).")

    if exclus:
        print(f"\n--- Exclus de l'univers ({len(exclus)}) ---")
        for ticker, motif in sorted(exclus.items()):
            print(f"  {ticker:8s} {motif}")


def main():
    analyseur = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    analyseur.add_argument("--capital", type=float, default=None,
                           help="capital a investir en FCFA : construit le panier cible")
    analyseur.add_argument("--versement", type=float, default=None,
                           help="versement du mois en FCFA : indique la ligne a renforcer")
    analyseur.add_argument("--versement-eur", type=float, default=None,
                           help="idem, exprime en euros (parite fixe 1 EUR = 655,957 FCFA)")
    analyseur.add_argument("--plafond", type=float, default=PLAFOND_PAR_LIGNE,
                           help="poids maximal d'une ligne, en fraction "
                                f"(defaut {PLAFOND_PAR_LIGNE:.2f})")
    analyseur.add_argument("--objectif", type=float, default=None,
                           help="patrimoine vise a terme en FCFA ; le plafond s'y applique "
                                "tant que le portefeuille est plus petit")
    analyseur.add_argument("--regle", choices=sorted(REGLES_VERSEMENT), default="equilibre",
                           help="regle de choix de la ligne renforcee (defaut equilibre)")
    analyseur.add_argument("--lignes", type=int, default=NB_LIGNES_DEFAUT,
                           help=f"nombre de lignes visees (defaut {NB_LIGNES_DEFAUT})")
    analyseur.add_argument("--courtage", type=float, default=COURTAGE_SGI_DEFAUT,
                           help="taux de courtage de la SGI, en fraction "
                                f"(defaut {COURTAGE_SGI_DEFAUT}, plafond CREPMF)")
    analyseur.add_argument("--minimum-ordre", type=float, default=MINIMUM_PAR_ORDRE,
                           help="minimum de perception par ordre en FCFA "
                                f"(defaut {MINIMUM_PAR_ORDRE:.0f}, a confirmer aupres de la SGI)")
    analyseur.add_argument("--liquidite-min", type=float, default=LIQUIDITE_MIN_FCFA,
                           help="liquidite minimale en FCFA/jour pour entrer dans l'univers")
    analyseur.add_argument("--sans-tilt", action="store_true",
                           help="equiponderer tout l'univers eligible au lieu de "
                                "selectionner les meilleurs scores")
    analyseur.add_argument("--portefeuille", type=str, default=None,
                           help="chemin d'un portfolio.json, pour calculer les ordres")
    arguments = analyseur.parse_args()

    cloture, volume = charger_marche()
    dps, bnpa = charger_fondamentaux()

    versement = arguments.versement
    if arguments.versement_eur is not None:
        versement = arguments.versement_eur * 655.957
    if versement is not None:
        positions = (charger_portefeuille(arguments.portefeuille)
                     if arguments.portefeuille else {})
        eligibles, _ = univers_investissable(cloture, volume, arguments.liquidite_min)
        choix = ligne_a_renforcer(positions, cloture, versement, eligibles,
                                  arguments.plafond, arguments.regle,
                                  arguments.courtage, arguments.minimum_ordre,
                                  arguments.objectif)
        print(f"donnees arretees au {cloture.index[-1].date()}\n")
        afficher_versement(versement, choix, arguments.plafond, arguments.minimum_ordre)
        return

    if arguments.capital is None:
        analyseur.error("indiquer --capital, ou --versement / --versement-eur")

    panier, exclus = panier_cible(
        arguments.capital, cloture, volume, bnpa,
        nb_lignes=arguments.lignes,
        liquidite_min=arguments.liquidite_min,
        avec_tilt=not arguments.sans_tilt,
    )
    dividendes = dividendes_attendus(panier, dps) if not panier.empty \
        else pd.DataFrame(columns=["dps", "encaisse"])

    table_ordres, cout = None, 0.0
    if arguments.portefeuille and not panier.empty:
        positions = charger_portefeuille(arguments.portefeuille)
        table_ordres, cout = ordres(positions, panier, cloture,
                                    arguments.courtage, arguments.minimum_ordre)

    print(f"donnees arretees au {cloture.index[-1].date()}\n")
    afficher(arguments.capital, panier, exclus, dividendes,
             table_ordres, cout, arguments.courtage, arguments.minimum_ordre)


if __name__ == "__main__":
    main()
