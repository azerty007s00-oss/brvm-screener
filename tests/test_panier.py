"""
tests/test_panier.py - Tests unitaires pour strategie/panier.py.

Couvre le barème de frais, la détection de suspension, le filtre de liquidité,
la recherche du budget optimal, la construction du panier et les ordres de
rebalancement. Aucun appel réseau : données OHLCV synthétiques uniquement.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
from datetime import date

import numpy as np
import pandas as pd
import pytest

from strategie.panier import (
    COURTAGE_SGI_DEFAUT,
    SEUIL_RETARD_SUSPENSION,
    _budget_optimal,
    charger_portefeuille,
    detecter_suspensions,
    dividendes_attendus,
    exercice_publie,
    frais_par_sens,
    ordres,
    panier_cible,
    scores,
    univers_investissable,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _seances(n: int = 300) -> pd.DatetimeIndex:
    return pd.date_range("2025-01-01", periods=n, freq="B")


def _marche(prix: dict[str, float], n: int = 300, volume: float = 1_000.0,
            derniere_seance: dict[str, int] | None = None):
    """
    Marché synthétique à prix constants.

    derniere_seance permet d'arrêter la cotation d'un titre avant les autres,
    pour simuler une suspension.
    """
    idx = _seances(n)
    cloture, volumes = {}, {}
    for ticker, p in prix.items():
        serie = pd.Series(float(p), index=idx)
        vol = pd.Series(float(volume), index=idx)
        fin = (derniere_seance or {}).get(ticker)
        if fin is not None:
            serie.iloc[fin:] = np.nan
            vol.iloc[fin:] = 0.0
        cloture[ticker], volumes[ticker] = serie, vol
    return pd.DataFrame(cloture), pd.DataFrame(volumes)


# ─── Barème de frais ──────────────────────────────────────────────────────────

def test_frais_par_sens_inclut_taxe_et_commissions():
    # BRVM 0,3 % + DC/BR 0,1 % + courtage 1 % = 1,4 %, puis TAF 18 %
    assert frais_par_sens(0.010) == pytest.approx(0.014 * 1.18)


def test_frais_par_sens_decroit_avec_le_courtage():
    assert frais_par_sens(0.005) < frais_par_sens(COURTAGE_SGI_DEFAUT)


def test_aller_retour_proche_de_3_3_pct_au_plafond():
    """Le chiffre qui invalide toute stratégie à rotation rapide."""
    assert 2 * frais_par_sens(0.010) == pytest.approx(0.033, abs=0.0015)


# ─── Exercice publié (pas d'anticipation d'information) ───────────────────────

@pytest.mark.parametrize("jour,attendu", [
    (date(2026, 1, 15), 2024),   # avant juillet : comptes 2025 pas encore publiés
    (date(2026, 6, 30), 2024),
    (date(2026, 7, 1),  2025),   # à partir de juillet : comptes 2025 disponibles
    (date(2026, 12, 31), 2025),
])
def test_exercice_publie(jour, attendu):
    assert exercice_publie(jour) == attendu


# ─── Détection de suspension ──────────────────────────────────────────────────

def test_detecte_un_titre_dont_la_cotation_s_arrete():
    cloture, _ = _marche({"AAA": 1000, "BBB": 2000},
                         derniere_seance={"BBB": 250})
    suspendus = detecter_suspensions(cloture)
    assert "BBB" in suspendus
    assert "AAA" not in suspendus


def test_ne_signale_pas_un_retard_sous_le_seuil():
    n = 300
    cloture, _ = _marche({"AAA": 1000, "BBB": 2000}, n=n,
                         derniere_seance={"BBB": n - SEUIL_RETARD_SUSPENSION + 1})
    assert detecter_suspensions(cloture) == {}


def test_detecter_suspensions_sur_marche_vide():
    assert detecter_suspensions(pd.DataFrame()) == {}


# ─── Univers investissable ────────────────────────────────────────────────────

def test_exclut_les_suspendus_et_les_illiquides():
    # liquidité = prix x volume : AAA 1 M, BBB 10 M, CCC 10 M mais suspendu
    cloture, volume = _marche({"AAA": 1_000, "BBB": 10_000, "CCC": 10_000},
                              volume=1_000, derniere_seance={"CCC": 250})
    eligibles, exclus = univers_investissable(cloture, volume,
                                              liquidite_min=2_000_000)
    assert eligibles == ["BBB"]
    assert "liquidite" in exclus["AAA"]
    assert "cotation arretee" in exclus["CCC"]


def test_la_liquidite_ne_sert_pas_au_classement():
    """
    Résultat mesuré : trier sur la liquidité coûte ~7 points de CAGR. Elle doit
    rester un filtre binaire, donc l'ordre renvoyé est alphabétique et non
    décroissant en liquidité.
    """
    cloture, volume = _marche({"ZZZ": 10_000, "AAA": 90_000})
    eligibles, _ = univers_investissable(cloture, volume, liquidite_min=1_000)
    assert eligibles == sorted(eligibles)


# ─── Budget optimal ───────────────────────────────────────────────────────────

def test_budget_optimal_ne_depasse_pas_le_capital():
    prix = [8_290.0, 38_990.0, 67.0, 1_545.0]
    budget = _budget_optimal(1_000_000, prix)
    assert sum(int(budget // p) * p for p in prix) <= 1_000_000


def test_budget_optimal_reduit_le_cash_residuel():
    """Le gain réel : l'arrondi naïf laissait jusqu'à 14 % non investi."""
    prix = [8_290.0, 38_990.0, 11_500.0, 1_545.0, 3_395.0]
    capital = 1_000_000.0
    naif = capital / len(prix)
    investi_naif = sum(int(naif // p) * p for p in prix)
    budget = _budget_optimal(capital, prix)
    investi_opt = sum(int(budget // p) * p for p in prix)
    assert investi_opt > investi_naif
    assert investi_opt / capital > 0.97


def test_budget_optimal_sur_liste_vide():
    assert _budget_optimal(1_000_000, []) == 0.0


# ─── Scores ───────────────────────────────────────────────────────────────────

def test_score_remplit_le_bnpa_manquant_par_la_mediane():
    """
    Pénaliser l'absence de BNPA dégrade le plancher de 39,2 % à 35,4 % : un
    titre sans comptes publiés doit rester noté, pas écarté.
    """
    cloture, _ = _marche({"AAA": 1_000, "BBB": 1_000, "CCC": 1_000})
    bnpa = {("AAA", 2024): 200.0, ("BBB", 2024): 50.0}   # CCC absent
    table = scores(cloture, bnpa, ["AAA", "BBB", "CCC"], a_la_date=date(2026, 1, 15))
    assert table["score"].notna().all()
    assert pd.isna(table.at["CCC", "rdt_beneficiaire"])
    # AAA a le meilleur rendement bénéficiaire, donc le meilleur score
    assert table.index[0] == "AAA"


def test_score_classe_par_rendement_beneficiaire_decroissant():
    cloture, _ = _marche({"CHER": 10_000, "BONMARCHE": 1_000})
    bnpa = {("CHER", 2024): 100.0, ("BONMARCHE", 2024): 100.0}
    table = scores(cloture, bnpa, ["CHER", "BONMARCHE"], a_la_date=date(2026, 1, 15))
    assert table.index[0] == "BONMARCHE"


# ─── Panier cible ─────────────────────────────────────────────────────────────

def _univers_type():
    prix = {f"T{i:02d}": p for i, p in enumerate(
        [8_290, 38_990, 11_500, 1_545, 3_395, 2_945, 16_835, 9_160,
         7_995, 21_500, 4_100, 1_975, 15_000, 8_100, 9_750])}
    cloture, volume = _marche(prix, volume=500)
    bnpa = {(t, 2024): 500.0 + 10 * i for i, t in enumerate(prix)}
    return cloture, volume, bnpa


def test_panier_investit_la_quasi_totalite_du_capital():
    cloture, volume, bnpa = _univers_type()
    panier, _ = panier_cible(2_000_000, cloture, volume, bnpa,
                             nb_lignes=10, liquidite_min=1_000)
    assert len(panier) == 10
    assert panier["montant"].sum() <= 2_000_000
    assert panier["montant"].sum() / 2_000_000 > 0.97


def test_panier_poids_approximativement_equiponderes():
    cloture, volume, bnpa = _univers_type()
    panier, _ = panier_cible(5_000_000, cloture, volume, bnpa,
                             nb_lignes=10, liquidite_min=1_000)
    cible = 1 / len(panier)
    assert panier["poids"].max() < cible * 1.6
    assert panier["poids"].min() > cible * 0.4


def test_sans_tilt_retient_tout_l_univers_eligible():
    cloture, volume, bnpa = _univers_type()
    panier, _ = panier_cible(5_000_000, cloture, volume, bnpa,
                             liquidite_min=1_000, avec_tilt=False)
    assert len(panier) == len(cloture.columns)


def test_panier_ecarte_un_titre_hors_budget_par_ligne():
    cloture, volume = _marche({"ABORDABLE": 1_000, "ENORME": 5_000_000},
                              volume=500)
    bnpa = {("ABORDABLE", 2024): 100.0, ("ENORME", 2024): 100.0}
    panier, exclus = panier_cible(1_000_000, cloture, volume, bnpa,
                                  nb_lignes=2, liquidite_min=1)
    assert "ENORME" in exclus
    assert "budget par ligne" in exclus["ENORME"]
    assert list(panier.index) == ["ABORDABLE"]


def test_panier_exclut_un_titre_suspendu():
    prix = {f"T{i:02d}": 1_000 + 100 * i for i in range(6)}
    cloture, volume = _marche(prix, volume=500, derniere_seance={"T03": 250})
    bnpa = {(t, 2024): 100.0 for t in prix}
    panier, exclus = panier_cible(1_000_000, cloture, volume, bnpa,
                                  nb_lignes=6, liquidite_min=1_000)
    assert "T03" not in panier.index
    assert "cotation arretee" in exclus["T03"]


def test_panier_vide_si_capital_insuffisant():
    cloture, volume = _marche({"ENORME": 10_000_000}, volume=500)
    panier, _ = panier_cible(1_000, cloture, volume, {},
                             nb_lignes=1, liquidite_min=1)
    assert panier.empty


# ─── Dividendes attendus ──────────────────────────────────────────────────────

def test_dividendes_attendus_utilise_le_dernier_exercice_connu():
    panier = pd.DataFrame(
        {"prix": [1_000.0], "quantite": [10]}, index=["AAA"])
    panier.index.name = "ticker"
    dps = {("AAA", 2023): 50.0}   # 2025 et 2024 absents, recul jusqu'à 2023
    table = dividendes_attendus(panier, dps, a_la_date=date(2026, 8, 1))
    assert table.at["AAA", "exercice"] == 2023
    assert table.at["AAA", "encaisse"] == pytest.approx(500.0)
    assert table.at["AAA", "rendement"] == pytest.approx(0.05)


def test_dividendes_attendus_tolere_un_titre_sans_historique():
    panier = pd.DataFrame({"prix": [1_000.0], "quantite": [10]}, index=["AAA"])
    panier.index.name = "ticker"
    table = dividendes_attendus(panier, {}, a_la_date=date(2026, 8, 1))
    assert pd.isna(table.at["AAA", "dps"])
    assert table.at["AAA", "encaisse"] is None


# ─── Ordres de rebalancement ──────────────────────────────────────────────────

def test_ordres_vend_ce_qui_sort_et_achete_ce_qui_entre():
    cloture, _ = _marche({"GARDE": 1_000, "SORT": 2_000, "ENTRE": 3_000})
    panier = pd.DataFrame(
        {"prix": [1_000.0, 3_000.0], "quantite": [10, 5]},
        index=["GARDE", "ENTRE"])
    panier.index.name = "ticker"
    table, cout = ordres({"GARDE": 10, "SORT": 4}, panier, cloture)
    sens = dict(zip(table["ticker"], table["sens"]))
    assert sens == {"SORT": "VENTE", "ENTRE": "ACHAT"}   # GARDE inchangé, absent
    assert cout > 0


def test_ordres_signale_une_ligne_suspendue_non_liquidable():
    cloture, _ = _marche({"BON": 1_000, "FIGE": 2_000},
                         derniere_seance={"FIGE": 250})
    panier = pd.DataFrame({"prix": [1_000.0], "quantite": [10]}, index=["BON"])
    panier.index.name = "ticker"
    table, _ = ordres({"FIGE": 5}, panier, cloture)
    ligne = table[table["ticker"] == "FIGE"].iloc[0]
    assert ligne["sens"] == "VENTE"
    assert not ligne["negociable"]   # pandas stocke un np.bool_


def test_cout_des_ordres_suit_le_courtage():
    cloture, _ = _marche({"AAA": 1_000})
    panier = pd.DataFrame({"prix": [1_000.0], "quantite": [100]}, index=["AAA"])
    panier.index.name = "ticker"
    _, cher = ordres({}, panier, cloture, courtage_sgi=0.010)
    _, bon = ordres({}, panier, cloture, courtage_sgi=0.005)
    assert bon < cher
    assert cher == pytest.approx(100_000 * frais_par_sens(0.010))


def test_ordres_vide_quand_le_portefeuille_est_deja_la_cible():
    cloture, _ = _marche({"AAA": 1_000})
    panier = pd.DataFrame({"prix": [1_000.0], "quantite": [10]}, index=["AAA"])
    panier.index.name = "ticker"
    table, cout = ordres({"AAA": 10}, panier, cloture)
    assert table.empty
    assert cout == 0.0


# ─── Lecture du portefeuille ──────────────────────────────────────────────────

def test_charger_portefeuille_agrege_les_lignes_du_meme_ticker(tmp_path):
    chemin = tmp_path / "portfolio.json"
    chemin.write_text(json.dumps([
        {"ticker": "AAA", "quantity": 7},
        {"ticker": "AAA", "quantity": 3},
        {"ticker": "BBB", "quantity": 5},
    ]), encoding="utf-8")
    assert charger_portefeuille(str(chemin)) == {"AAA": 10, "BBB": 5}
