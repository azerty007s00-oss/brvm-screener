"""
tests/test_scoring.py — Tests unitaires pour compute_score().
Aucun appel réseau, aucun scraping : TechnicalIndicators construits à la main.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from indicators import TechnicalIndicators
from scoring import compute_score


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _make_neutral() -> TechnicalIndicators:
    """Indicateurs neutres : string flags positionnés mais valeurs numériques absentes → N/D."""
    return TechnicalIndicators(
        ticker="TEST",
        rsi=50,
        ma_signal="bullish",   # ignoré car ma20/ma50 absents
        macd_signal="haussier",  # ignoré car macd_line absent
        stoch_k=50,
        adx=20,
        volume_moy20=1000,
        volume_actuel=1000,
    )


def _make_achat() -> TechnicalIndicators:
    """Indicateurs fortement haussiers : 3 groupes alignés."""
    return TechnicalIndicators(
        ticker="TEST",
        rsi=25,
        rsi_p10=30.0,
        rsi_p90=70.0,
        ma20=120.0,
        ma50=100.0,
        ma_lt=80.0,
        ma_lt_period=200,
        ma_signal="golden_cross",
        macd_line=0.001,
        macd_signal_line=0.0001,
        macd_signal="haussier",
        stoch_k=15,
        adx=30,
        volume_moy20=1000,
        volume_actuel=2500,
        cours_actuel=130.0,
        prix_vs_ma_lt="au_dessus",
    )


# ─── TEST 1 — Signal NEUTRE quand tous les indicateurs sont neutres ────────────

def test_signal_neutre():
    """Flags bullish/haussier sans valeurs numériques → N/D → score=0 → NEUTRE."""
    ind = _make_neutral()
    result = compute_score(ind)
    assert result.signal == "NEUTRE", (
        f"Attendu NEUTRE, obtenu {result.signal} (score={result.score_total})"
    )


# ─── TEST 2 — Signal ACHAT quand 3 groupes haussiers alignés ──────────────────

def test_signal_achat():
    """3 groupes alignés → ACHAT avec confiance forte ou modérée."""
    ind = _make_achat()
    result = compute_score(ind)
    assert result.signal == "ACHAT", (
        f"Attendu ACHAT, obtenu {result.signal} (score={result.score_total})"
    )
    assert result.confiance in ("forte", "modérée"), (
        f"Confiance attendue forte/modérée, obtenu '{result.confiance}'"
    )


# ─── TEST 3 — Signal VENTE quand 3 groupes baissiers alignés ──────────────────

def test_signal_vente():
    """3 groupes baissiers alignés → VENTE."""
    ind = TechnicalIndicators(
        ticker="TEST",
        rsi=80,
        rsi_p10=30.0,
        rsi_p90=70.0,
        ma20=50.0,
        ma50=100.0,
        ma_lt=200.0,
        ma_lt_period=200,
        ma_signal="death_cross",
        macd_line=-0.001,
        macd_signal_line=0.0001,
        macd_signal="baissier",
        stoch_k=85,
        adx=30,
        volume_moy20=1000,
        volume_actuel=500,
        cours_actuel=40.0,
        prix_vs_ma_lt="en_dessous",
    )
    result = compute_score(ind)
    assert result.signal == "VENTE", (
        f"Attendu VENTE, obtenu {result.signal} (score={result.score_total})"
    )


# ─── TEST 4 — Cap ±2 par groupe respecté ──────────────────────────────────────

def test_cap_par_groupe():
    """Timing brut = RSI(+1)+DivRSI(+1)+Stoch(+1) = 3, cappé à 2 → score_total <= 2."""
    ind = TechnicalIndicators(
        ticker="TEST",
        rsi=25,
        rsi_p10=30.0,
        rsi_p90=70.0,
        rsi_divergence="haussiere_forte",
        rsi_divergence_detail="Test cap groupe timing",
        stoch_k=15,
        adx=20,
        volume_moy20=1000,
        volume_actuel=1000,
    )
    result = compute_score(ind)

    CAP = 2
    timing_group = {"RSI", "Divergence RSI", "Stochastic"}
    # Calculer s_timing normalisé (chaque critère clamped ±1)
    s_timing = sum(
        max(-1, min(1, c.points))
        for c in result.criteres
        if c.nom in timing_group
    )
    # La somme brute normalisée doit être > 2 (sinon le cap n'est pas testé)
    assert s_timing > CAP, (
        f"s_timing={s_timing} devrait être > {CAP} pour tester le cap"
    )
    # Le score total doit respecter le cap (autres groupes à 0, timing cappé à 2)
    assert result.score_total <= CAP, (
        f"score_total={result.score_total} devrait être <= cap={CAP}"
    )


# ─── TEST 5 — Dampening sparse : score réduit à 80% ──────────────────────────

def test_dampening_sparse():
    """data_quality_flag='sparse' → score réduit à ~80% du score normal."""
    ind_normal = _make_achat()
    result_normal = compute_score(ind_normal)
    score_test2 = result_normal.score_total

    ind_sparse = _make_achat()
    ind_sparse.data_quality_flag = "sparse"
    result_sparse = compute_score(ind_sparse)

    tolerance = round(score_test2 * 0.8) + 1
    assert result_sparse.score_total <= tolerance, (
        f"Score sparse={result_sparse.score_total} devrait être <= {tolerance} "
        f"(80% de {score_test2} + 1)"
    )
    assert result_sparse.score_total < score_test2, (
        f"Score sparse={result_sparse.score_total} devrait être < score normal={score_test2}"
    )


# ─── TEST 6 — Filtre liquidité : volume_moy20=100 → critère Liquidité -1 ──────

def test_filtre_liquidite():
    """volume_moy20 très bas → critère Liquidité présent avec points=-1."""
    ind = TechnicalIndicators(
        ticker="TEST",
        volume_moy20=100,
        volume_actuel=100,
    )
    result = compute_score(ind)

    liquidite_criteres = [c for c in result.criteres if c.nom == "Liquidité"]
    assert len(liquidite_criteres) >= 1, (
        "Aucun critère 'Liquidité' trouvé alors que volume_moy20=100"
    )
    assert liquidite_criteres[0].points == -1, (
        f"Critère Liquidité attendu à -1, obtenu {liquidite_criteres[0].points}"
    )


# ─── TEST 7 — Confiance faible si données insuffisantes ───────────────────────

def test_confiance_faible_donnees_insuffisantes():
    """Tous les indicateurs clés à None → nb_groupes_actifs=0 → confiance faible."""
    ind = TechnicalIndicators(
        ticker="TEST",
        rsi=None,
        macd_line=None,
        stoch_k=None,
        ma20=None,
    )
    result = compute_score(ind)
    assert result.confiance == "faible", (
        f"Confiance attendue 'faible', obtenu '{result.confiance}'"
    )
