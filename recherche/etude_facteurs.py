#!/usr/bin/env python3
"""
etude_facteurs.py - Etude de rentabilite sur les donnees reelles de la BRVM.

Contrairement a strategy_research.py, qui conclut sur un univers synthetique de
20 actions simulees, ce module travaille exclusivement sur data/daily/*.csv
(44 titres, ~1 425 seances, 2021-04 -> 2026-09) et sur les fondamentaux reels.

Trois apports par rapport au backtest existant :
  1. Rendement TOTAL : le dividende est credite au portefeuille (backtest.py
     l'ignore completement, soit ~7,3 %/an de rendement omis).
  2. Bareme de frais reel : 3,3 % aller-retour (BRVM 0,3 % + DC/BR 0,1 %
     + courtage SGI jusqu'a 1 % + taxe sur activites financieres, par sens)
     au lieu de 1,3 %, plus les droits de garde annuels.
  3. Robustesse : chaque resultat est mesure sur les N decalages possibles du
     mois de rebalancement, car un seul calendrier donne un resultat non
     reproductible.

Usage :
    python recherche/etude_facteurs.py
    python recherche/etude_facteurs.py --section facteurs
"""

import argparse
import glob
import json
import os
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

RACINE  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDICES = {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}

# Titres suspendus de la cote : dernier cours fige, position non liquidable.
# SEMC (Crown SIEM CI) et SICC (SICOR) sont suspendus depuis le 16/09/2026.
SUSPENDUS = {"SEMC", "SICC"}

# Bareme reel, par sens : BRVM 0,3 % + DC/BR 0,1 % + courtage SGI <= 1 %
# + taxe sur activites financieres. Arrondi a 1,65 % par sens.
FRAIS_ALLER_RETOUR = 0.033
DROITS_DE_GARDE    = 0.0025   # Hudson & Cie 0,25 %/an ; SOGEBOURSE 2 %/an

# Les fondamentaux (BNPA, dividende) ne couvrent l'univers qu'a partir de cette
# date. Avant, tout portefeuille factoriel serait en cash et le resultat faux.
DEBUT_FONDAMENTAUX = "2022-11"


# --- Chargement ---------------------------------------------------------------

def charger_cours():
    """Retourne (cloture, volume) en DataFrame date x ticker, indices exclus."""
    cl, vl = {}, {}
    for chemin in glob.glob(os.path.join(RACINE, "data", "daily", "*.csv")):
        ticker = os.path.basename(chemin)[:-4]
        if ticker in INDICES:
            continue
        df = pd.read_csv(chemin, parse_dates=["date"]).set_index("date").sort_index()
        if len(df) < 250:
            continue
        cl[ticker], vl[ticker] = df["close"], df["volume"]
    cloture = pd.DataFrame(cl).sort_index().ffill()
    volume  = pd.DataFrame(vl).sort_index().fillna(0)
    return cloture, volume


def charger_dividendes():
    """Retourne {(ticker, exercice): dps} et {(ticker, exercice): bnpa}."""
    chemin = os.path.join(RACINE, "data", "fundamentals_history.json")
    with open(chemin, encoding="utf-8-sig") as f:
        stocks = json.load(f)["stocks"]
    dps, bnpa = {}, {}
    for ticker, fiche in stocks.items():
        for exercice, rec in (fiche.get("history") or {}).items():
            exercice = int(exercice)
            if rec.get("dividende") is not None:
                dps[(ticker, exercice)] = float(rec["dividende"])
            if rec.get("bnpa") is not None:
                bnpa[(ticker, exercice)] = float(rec["bnpa"])
    return dps, bnpa


def construire_panel(cloture, volume, dps, bnpa):
    """
    Panel mensuel : prix, rendement total, facteurs, liquidite.

    L'exercice utilisable a une date donnee est N-1 a partir de juillet
    (publication des comptes entre avril et juin), N-2 avant : aucune
    anticipation d'information non publiee.
    """
    rotation = (cloture * volume).rolling(60, min_periods=20).mean()
    vol_real = cloture.pct_change().rolling(60, min_periods=30).std() * np.sqrt(252)

    prix      = cloture.resample("ME").last()
    liquidite = rotation.resample("ME").last()
    volat     = vol_real.resample("ME").last()
    colonnes  = prix.columns

    # Dividende credite en cash au mois de juillet suivant l'exercice.
    cash = pd.DataFrame(0.0, index=prix.index, columns=colonnes)
    for date in prix.index:
        if date.month == 7:
            for ticker in colonnes:
                montant = dps.get((ticker, date.year - 1))
                if montant:
                    cash.at[date, ticker] = montant
    rendement_total = (prix + cash) / prix.shift(1) - 1

    rdt_div = pd.DataFrame(index=prix.index, columns=colonnes, dtype=float)
    rdt_ben = pd.DataFrame(index=prix.index, columns=colonnes, dtype=float)
    for date in prix.index:
        exercice = date.year - 1 if date.month >= 7 else date.year - 2
        for ticker in colonnes:
            p = prix.at[date, ticker]
            if not p or np.isnan(p):
                continue
            if (ticker, exercice) in dps:
                rdt_div.at[date, ticker] = dps[(ticker, exercice)] / p
            if (ticker, exercice) in bnpa:
                rdt_ben.at[date, ticker] = bnpa[(ticker, exercice)] / p

    facteurs = {
        "MOM12":   prix.shift(1) / prix.shift(13) - 1,
        "MOM6":    prix.shift(1) / prix.shift(7) - 1,
        "MOM3":    prix.shift(1) / prix.shift(4) - 1,
        "MOM1":    prix.shift(1) / prix.shift(2) - 1,
        "LOWVOL":  -volat,
        "ILLIQ":   -np.log(liquidite.replace(0, np.nan)),
        "DIVYLD":  rdt_div,
        "EARNYLD": rdt_ben,
    }
    return prix, rendement_total, facteurs, liquidite


# --- Sections d'analyse -------------------------------------------------------

def section_marche(cloture, dps):
    """Ce que le marche a fait : la reference que toute strategie doit battre."""
    print("=== 1. CE QUE LA BRVM A FAIT (2021-04 -> 2026-09) ===\n")
    complet = cloture.dropna(axis=1, thresh=1300)
    mult = (complet.iloc[-1] / complet.bfill().iloc[0]).sort_values(ascending=False)
    annees = (cloture.index[-1] - cloture.index[0]).days / 365.25
    print(f"titres a historique complet : {len(mult)}")
    print(f"multiple moyen  x{mult.mean():.2f}  -> CAGR prix {mult.mean() ** (1 / annees) - 1:+.1%}")
    print(f"multiple median x{mult.median():.2f}  -> CAGR prix {mult.median() ** (1 / annees) - 1:+.1%}")
    print(f"titres en hausse : {(mult > 1).mean():.0%}")
    print(f"meilleur {mult.index[0]} x{mult.iloc[0]:.1f} | pire {mult.index[-1]} x{mult.iloc[-1]:.2f}")

    print("\nperformance prix par annee civile (mediane cross-section) :")
    for an in range(2021, 2027):
        bloc = cloture.loc[str(an)]
        if len(bloc) < 20:
            continue
        r = (bloc.ffill().iloc[-1] / bloc.bfill().iloc[0] - 1).dropna()
        print(f"  {an} : mediane {r.median():+6.1%} | moyenne {r.mean():+6.1%} | "
              f"%hausse {(r > 0).mean():.0%}")

    print("\nrendement du dividende realise (dps N-1 / cours moyen N) :")
    moyennes = []
    for an in range(2022, 2027):
        bloc = cloture.loc[str(an)]
        if bloc.empty:
            continue
        rdts = [dps[(t, an - 1)] / bloc[t].mean()
                for t in cloture.columns
                if (t, an - 1) in dps and bloc[t].mean() > 0]
        if rdts:
            moyennes.append(np.mean(rdts))
            print(f"  {an} : {np.mean(rdts):.2%} (n={len(rdts)})")
    if moyennes:
        print(f"  moyenne sur la periode : {np.mean(moyennes):.2%} par an")
        print("  -> entierement absent de backtest.py")


def section_facteurs(facteurs, rendement_total):
    """Information coefficient : quels facteurs predisent les rendements."""
    print("=== 2. INFORMATION COEFFICIENT (Spearman, cross-section mensuelle) ===\n")
    horizons = (3, 6, 12)
    fwd = {h: (1 + rendement_total).rolling(h).apply(np.prod, raw=True).shift(-h) - 1
           for h in horizons}
    print(f"{'facteur':10s} " + " ".join(f"| IC {h:>2d}m  t-stat" for h in horizons))
    for nom, valeurs in facteurs.items():
        ligne = f"{nom:10s} "
        for h in horizons:
            ics = []
            for date in valeurs.index:
                paire = pd.concat([valeurs.loc[date], fwd[h].loc[date]], axis=1).dropna()
                if len(paire) >= 12:
                    ics.append(paire.corr(method="spearman").iloc[0, 1])
            if len(ics) > 6:
                ics = np.array(ics)
                t = ics.mean() / (ics.std(ddof=1) / np.sqrt(len(ics)))
                ligne += f"| {ics.mean():+.3f} {t:+6.2f} "
            else:
                ligne += "|    n/a       "
        print(ligne)
    print("\nun IC de 0,10 est un signal reel mais faible : il ne suffit pas a payer")
    print("la perte de diversification et 3,3 % de frais aller-retour.")


def simuler(prix, rendement_total, facteurs, liquidite,
            frequence=12, topn=None, noms_facteurs=None, decalage=0,
            frais=FRAIS_ALLER_RETOUR, garde=DROITS_DE_GARDE):
    """
    Portefeuille long-only equipondere, rendement total net de frais.

    Un score manquant est remplace par la mediane du mois (facteur neutre) et
    non par une exclusion : sinon le titre sort du portefeuille pour absence de
    donnee et non par decision de strategie.
    """
    score = None
    if noms_facteurs:
        rangs = [facteurs[n].rank(axis=1, pct=True) for n in noms_facteurs]
        score = sum(rangs) / len(rangs)
        score = score.apply(lambda ligne: ligne.fillna(ligne.median()), axis=1)

    equity, detenu, courbe = 1.0, pd.Series(dtype=float), {}
    for i, date in enumerate(prix.index):
        if i > 0:
            if len(detenu):
                r = rendement_total.loc[date, detenu.index].fillna(0)
                croissance = (detenu * (1 + r)).sum()
                equity *= croissance
                detenu = detenu * (1 + r) / croissance
            equity *= (1 - garde / 12)
            courbe[date] = equity
        if i >= decalage and (i - decalage) % frequence == 0:
            univers = [t for t in prix.loc[date].dropna().index if t not in SUSPENDUS]
            if score is not None and topn:
                univers = list(score.loc[date, univers].dropna().nlargest(topn).index)
            if not univers:
                continue
            cible = pd.Series(1 / len(univers), index=univers)
            clefs = set(cible.index) | set(detenu.index)
            rotation = (cible.reindex(clefs).fillna(0)
                        - detenu.reindex(clefs).fillna(0)).abs().sum() / 2
            equity *= (1 - frais * rotation)
            detenu = cible
    return pd.Series(courbe)


def metriques(courbe):
    rdt = courbe.pct_change().dropna()
    annees = len(courbe) / 12
    cagr = courbe.iloc[-1] ** (1 / annees) - 1
    vol = rdt.std() * np.sqrt(12)
    return cagr, (cagr - 0.055) / vol if vol else 0.0, (courbe / courbe.cummax() - 1).min()


def section_robustesse(prix, rendement_total, facteurs, liquidite):
    """
    Le test qui tranche : un resultat qui depend du mois de rebalancement
    choisi n'est pas une strategie, c'est de la chance.
    """
    prix = prix.loc[DEBUT_FONDAMENTAUX:]
    rendement_total = rendement_total.loc[DEBUT_FONDAMENTAUX:]
    facteurs = {k: v.loc[DEBUT_FONDAMENTAUX:] for k, v in facteurs.items()}
    liquidite = liquidite.loc[DEBUT_FONDAMENTAUX:]

    print(f"=== 3. ROBUSTESSE ({prix.index[0].date()} -> {prix.index[-1].date()}, "
          f"{len(prix)} mois) ===")
    print(f"frais {FRAIS_ALLER_RETOUR:.1%} aller-retour + garde {DROITS_DE_GARDE:.2%}/an\n")

    vl = ["EARNYLD", "LOWVOL"]
    configs = [
        ("equipondere (tout l'univers)", None, None),
        ("top20 value+lowvol",            20,  vl),
        ("top12 value+lowvol",            12,  vl),
        ("top8  value+lowvol",             8,  vl),
        ("top5  value+lowvol",             5,  vl),
    ]

    print("CAGR selon le mois de rebalancement choisi (rebalancement annuel) :")
    print(f"{'strategie':32s}   min    mediane   max   ecart-type")
    for nom, topn, fl in configs:
        resultats = np.array([
            metriques(simuler(prix, rendement_total, facteurs, liquidite,
                              12, topn, fl, decalage=d))[0]
            for d in range(12)
        ])
        print(f"{nom:32s} {resultats.min():+6.1%} {np.median(resultats):+7.1%} "
              f"{resultats.max():+6.1%}   {resultats.std():5.1%}")

    print("\nCAGR median selon la frequence de rebalancement :")
    print(f"{'strategie':32s}  annuel  semestr.  trimestr.  mensuel")
    for nom, topn, fl in [configs[0], configs[1], configs[3]]:
        cases = []
        for freq in (12, 6, 3, 1):
            resultats = [metriques(simuler(prix, rendement_total, facteurs, liquidite,
                                           freq, topn, fl, decalage=d))[0]
                         for d in range(freq)]
            cases.append(f"{np.median(resultats):+7.1%}")
        print(f"{nom:32s} " + "  ".join(cases))
    print("\nla frequence est le parametre dominant : toute selection cree de la")
    print("rotation, et la rotation coute 3,3 %. L'equipondere y est insensible.")


def section_dimensionnement(cloture, volume):
    """Ce qui est reellement achetable avec 1 a 5 millions FCFA."""
    print("=== 4. DIMENSIONNEMENT POUR 1 A 5 M FCFA ===\n")
    rotation = (cloture * volume).rolling(60, min_periods=20).mean()
    dernier, liq = cloture.iloc[-1], rotation.iloc[-1]

    illiquides = sorted(t for t in cloture.columns
                        if t not in SUSPENDUS and liq[t] < 2e6)
    eligibles = [t for t in cloture.columns
                 if t not in SUSPENDUS and liq[t] >= 2e6]
    print(f"univers negociable : {len(eligibles)} titres sur {len(cloture.columns)}")
    print(f"  exclus, suspendus    : {sorted(SUSPENDUS)}")
    print(f"  exclus, < 2 M F/jour : {illiquides}")

    print("\ncapital | lignes | cash residuel | poids min/max | % du volume quotidien")
    for capital in (1e6, 2e6, 3e6, 5e6):
        for lignes in (10, 15, 20, 25):
            budget = capital / lignes
            achetables = [t for t in eligibles if dernier[t] <= budget]
            if len(achetables) < lignes:
                continue
            choix = sorted(achetables, key=lambda t: -liq[t])[:lignes]
            qte = {t: int(budget // dernier[t]) for t in choix}
            investi = sum(qte[t] * dernier[t] for t in choix)
            poids = np.array([qte[t] * dernier[t] for t in choix]) / investi
            part = max(qte[t] * dernier[t] / liq[t] for t in choix)
            print(f"  {capital / 1e6:.0f} M  |   {lignes:2d}   |    {1 - investi / capital:5.1%}      "
                  f"| {poids.min():4.1%}/{poids.max():4.1%}   |  {part:.1%}")
    print("\ninconnue a verifier aupres de la SGI : le minimum de frais par ordre.")
    print("A 100 000 F par ligne, un plancher de 5 000 F represente 5 % par ordre")
    print("et annule la diversification : c'est le chiffre qui decide du nb de lignes.")


def section_evenementiel(cloture, dps):
    """
    Capture du dividende : l'effet apparent disparait au test placebo.
    Conserve ici pour qu'on ne refasse pas l'erreur.
    """
    print("=== 5. CAPTURE DU DIVIDENDE : effet non confirme ===\n")
    rng = np.random.default_rng(7)
    marche = (1 + cloture.pct_change().mean(axis=1)).cumprod()

    evenements = []
    candidats_par_cas = []
    for (ticker, exercice), montant in dps.items():
        if ticker not in cloture.columns:
            continue
        fenetre = cloture[ticker].loc[f"{exercice + 1}-03":f"{exercice + 1}-10"]
        if len(fenetre) < 20:
            continue
        ratio = (fenetre.shift(1) - fenetre) / montant
        candidats = ratio[(ratio > 0.5) & (ratio < 1.6)]
        candidats_par_cas.append(len(candidats))
        if len(candidats):
            meilleur = candidats.index[int(np.argmin(np.abs(candidats.values - 1.0)))]
            evenements.append((ticker, exercice, meilleur, montant))

    median_candidats = np.median(candidats_par_cas)
    print(f"ex-dates inferees : {len(evenements)} sur {len(dps)} couples, mais la date")
    print(f"retenue est 1 candidat parmi ~{median_candidats:.0f} -> detection non fiable.")

    def exces(evts, avant, apres):
        ecarts = []
        for ticker, _, date, montant in evts:
            serie = cloture[ticker]
            try:
                i = serie.index.get_loc(date)
            except KeyError:
                continue
            if i - avant < 0 or i + apres >= len(serie):
                continue
            depart = serie.iloc[i - avant]
            if depart <= 0:
                continue
            titre = (serie.iloc[i + apres] + montant) / depart - 1
            indice = marche.iloc[i + apres] / marche.iloc[i - avant] - 1
            ecarts.append(titre - indice)
        ecarts = np.array(ecarts)
        if len(ecarts) < 40:
            return None
        return ecarts.mean(), ecarts.mean() / (ecarts.std(ddof=1) / np.sqrt(len(ecarts)))

    factices = []
    for ticker, exercice, _, montant in evenements:
        fenetre = cloture[ticker].loc[f"{exercice + 1}-03":f"{exercice + 1}-10"]
        if len(fenetre) >= 20:
            factices.append((ticker, exercice,
                             fenetre.index[rng.integers(0, len(fenetre))], montant))

    print("\nexces de rendement vs marche, dates reelles contre dates au hasard :")
    for avant, apres in [(20, 5), (40, 5), (60, 20)]:
        reel, faux = exces(evenements, avant, apres), exces(factices, avant, apres)
        if reel and faux:
            print(f"  J-{avant:<2d}/J+{apres:<2d} : reel {reel[0]:+.2%} (t={reel[1]:+.2f})"
                  f"   placebo {faux[0]:+.2%} (t={faux[1]:+.2f})")
    print("\nle placebo fait aussi bien ou mieux : l'effet mesure est l'exposition au")
    print("marche des societes payeuses, pas la capture du detachement. Tester")
    print("l'evenementiel exige les vraies dates d'annonce, absentes du depot.")


SECTIONS = {
    "marche":          "performance du marche et dividendes realises",
    "facteurs":        "information coefficient des facteurs",
    "robustesse":      "sensibilite au calendrier et a la frequence",
    "dimensionnement": "portefeuille implementable avec 1 a 5 M FCFA",
    "evenementiel":    "capture du dividende (effet non confirme)",
}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--section", choices=sorted(SECTIONS), action="append",
                    help="limiter a une ou plusieurs sections (defaut : toutes)")
    args = ap.parse_args()
    voulues = args.section or list(SECTIONS)

    cloture, volume = charger_cours()
    dps, bnpa = charger_dividendes()
    prix, rendement_total, facteurs, liquidite = construire_panel(
        cloture, volume, dps, bnpa)

    print(f"univers : {len(cloture.columns)} titres | "
          f"{cloture.index[0].date()} -> {cloture.index[-1].date()} "
          f"({len(cloture)} seances)\n")

    for i, nom in enumerate(s for s in SECTIONS if s in voulues):
        if i:
            print()
        if nom == "marche":
            section_marche(cloture, dps)
        elif nom == "facteurs":
            section_facteurs(facteurs, rendement_total)
        elif nom == "robustesse":
            section_robustesse(prix, rendement_total, facteurs, liquidite)
        elif nom == "dimensionnement":
            section_dimensionnement(cloture, volume)
        elif nom == "evenementiel":
            section_evenementiel(cloture, dps)


if __name__ == "__main__":
    main()
