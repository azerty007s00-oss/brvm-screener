"""
tests/test_collecte_calendrier.py - Tests unitaires pour collecte_calendrier.py.

Couvre le classement des événements, le rapprochement raison sociale → ticker,
l'extraction depuis le HTML et la fusion non destructive avec le fichier
existant. Aucun appel réseau : HTML synthétique uniquement.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date

import pandas as pd
import pytest

from collecte_calendrier import (
    COLONNES,
    classer,
    extraire,
    fusionner,
    normaliser,
    resoudre_ticker,
)


# ─── Normalisation ────────────────────────────────────────────────────────────

def test_normaliser_retire_accents_et_casse():
    assert normaliser("SOCIÉTÉ  GÉNÉRALE CI") == "societe generale ci"


# ─── Classement des événements ────────────────────────────────────────────────

@pytest.mark.parametrize("libelle,attendu", [
    ("Paiement de dividendes - Exercice 2023", "paiement"),
    ("Rectificatif Paiement de dividendes Exercice 2020", "rectificatif"),
    ("Annonce aux Actionnaires - Dividendes 2019", "annonce"),
    ("Prorogation du délai de paiement des dividendes", "annonce"),
    ("Report de paiement de dividendes", "annonce"),
    ("Projet d'affectation du résultat de l'exercice 2022", "annonce"),
    ("Assemblée générale ordinaire", None),
    ("Publication des résultats annuels", None),
])
def test_classer(libelle, attendu):
    assert classer(libelle) == attendu


def test_rectificatif_prime_sur_paiement():
    """Un rectificatif contient le mot paiement : il ne doit pas être compté
    comme une mise en paiement de plus."""
    assert classer("Rectificatif Paiement de dividendes") == "rectificatif"


# ─── Rapprochement raison sociale → ticker ────────────────────────────────────

@pytest.mark.parametrize("societe,ticker", [
    ("SOCIETE GENERALE CI", "SGBC"),
    ("SOCIÉTÉ GENERALE CI", "SGBC"),
    ("BOA CI", "BOAC"),
    ("BANK OF AFRICA CI", "BOAC"),
    ("BOA COTE D'IVOIRE", "BOAC"),
    ("SONATEL SENEGAL", "SNTS"),
    ("Ecobank Transnational Incorporated TG", "ETIT"),
    ("ETI TG", "ETIT"),
    ("BOLLORE TRANSPORT & LOGISTICS CI", "SDSC"),
    ("AFRICA GLOBAL LOGISTICS CI", "SDSC"),
])
def test_resoudre_ticker_gere_les_alias(societe, ticker):
    assert resoudre_ticker(societe)[0] == ticker


def test_societe_hors_univers_est_tracee_sans_ticker():
    ticker, note = resoudre_ticker("SUCRIVOIRE CI")
    assert ticker is None
    assert "non couvert" in note


def test_societe_inconnue_est_signalee():
    ticker, note = resoudre_ticker("ENTREPRISE INCONNUE SA")
    assert ticker is None
    assert "non rapprochee" in note


def test_parenthese_ignoree_dans_le_rapprochement():
    societe = "AFRICA GLOBAL LOGISTICS CI (ex BOLLORE TRANSPORT & LOGISTICS CI)"
    assert resoudre_ticker(societe)[0] == "SDSC"


# ─── Extraction ───────────────────────────────────────────────────────────────

HTML = """<table>
<tr><td>04/06/2024</td><td><a>SOCIETE GENERALE CI : Paiement de dividendes - Exercice 2023</a></td></tr>
<tr><td>14/02/2023</td><td>ORANGE CI : Projet d&#39;affectation du r&eacute;sultat de l&#39;exercice 2022</td></tr>
<tr><td>01/01/2024</td><td>TRUC CI : Assembl&eacute;e g&eacute;n&eacute;rale ordinaire</td></tr>
</table>"""


def test_extraire_rend_les_colonnes_attendues():
    assert list(extraire(HTML).columns) == COLONNES


def test_extraire_decode_les_entites_html():
    table = extraire(HTML)
    ligne = table[table["societe"] == "ORANGE CI"].iloc[0]
    assert ligne["type"] == "annonce"
    assert ligne["exercice"] == 2022


def test_extraire_ignore_les_evenements_non_dividende():
    assert "TRUC CI" not in set(extraire(HTML)["societe"])


def test_extraire_lit_date_et_exercice():
    ligne = extraire(HTML).iloc[0]
    assert ligne["date"] == date(2024, 6, 4)
    assert ligne["ticker"] == "SGBC"
    assert ligne["exercice"] == 2023


def test_extraire_sur_page_vide():
    assert extraire("<html><body>rien ici</body></html>").empty


def test_extraire_rejette_une_date_impossible():
    assert extraire("<tr><td>31/02/2024</td><td>X CI : Paiement de dividendes "
                    "Exercice 2023</td></tr>").empty


# ─── Fusion non destructive ───────────────────────────────────────────────────

def _existant():
    return pd.DataFrame([{
        "date": date(2024, 6, 4), "societe": "SOCIETE GENERALE CI",
        "ticker": "SGBC", "exercice": 2023, "type": "paiement", "note": "",
    }], columns=COLONNES)


def test_fusion_n_ajoute_pas_un_doublon():
    collecte = extraire(
        "<tr><td>04/06/2024</td><td>SOCIETE GENERALE CI : Paiement de "
        "dividendes - Exercice 2023</td></tr>")
    fusion, ajoutees = fusionner(_existant(), collecte)
    assert ajoutees == 0
    assert len(fusion) == 1


def test_fusion_ajoute_une_ligne_nouvelle():
    collecte = extraire(
        "<tr><td>10/05/2024</td><td>ECOBANK CI : Paiement de dividendes - "
        "Exercice 2023</td></tr>")
    fusion, ajoutees = fusionner(_existant(), collecte)
    assert ajoutees == 1
    assert set(fusion["ticker"]) == {"SGBC", "ECOC"}


def test_fusion_ignore_une_ligne_sans_exercice():
    """Sans exercice, la ligne ne peut pas être rattachée à un dividende connu."""
    collecte = extraire("<tr><td>10/05/2024</td><td>ECOBANK CI : Paiement de "
                        "dividendes</td></tr>")
    _, ajoutees = fusionner(_existant(), collecte)
    assert ajoutees == 0


def test_fusion_preserve_les_lignes_saisies_a_la_main():
    """Le fichier contient 113 lignes relues : la collecte ne doit rien écraser."""
    existant = _existant()
    collecte = extraire(
        "<tr><td>04/06/2024</td><td>SOCIETE GENERALE CI : Paiement de "
        "dividendes - Exercice 2023</td></tr>")
    fusion, _ = fusionner(existant, collecte)
    assert fusion.iloc[0]["note"] == ""
    assert fusion.iloc[0]["societe"] == "SOCIETE GENERALE CI"


def test_fusion_sur_collecte_vide():
    existant = _existant()
    fusion, ajoutees = fusionner(existant, pd.DataFrame(columns=COLONNES))
    assert ajoutees == 0
    assert len(fusion) == len(existant)


# ─── Cohérence avec le fichier réel ───────────────────────────────────────────

def test_le_fichier_reel_se_recharge_sans_doublon():
    """Fusionner le fichier avec lui-même ne doit rien ajouter."""
    from collecte_calendrier import charger_existant
    reel = charger_existant()
    assert len(reel) > 100
    fusion, ajoutees = fusionner(reel, reel)
    assert ajoutees == 0
    assert len(fusion) == len(reel)
