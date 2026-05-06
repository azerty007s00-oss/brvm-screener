"""
tests/test_diagnostics.py - Tests unitaires pour diagnostics.py.
Aucun appel réseau : données synthétiques uniquement.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
import pytest

from diagnostics import (
    LiquidityMetrics,
    classify_tier,
    compute_liquidity_metrics,
    generate_report,
    run_full_diagnostic,
)
from config import LIQUIDITY_THRESHOLDS, DIAGNOSTIC_JUMP_THRESHOLD_PCT


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _make_ohlcv(
    n: int = 250,
    pct_zero_volume: float = 0.0,
    flat_ohlc: bool = False,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Construit un DataFrame OHLCV synthétique.

    Args:
        n:                Nombre de barres.
        pct_zero_volume:  Proportion de séances avec volume = 0 (0.0 - 1.0).
        flat_ohlc:        Si True, high = low = close sur toutes les barres.
        seed:             Graine aléatoire.
    """
    np.random.seed(seed)
    close = 1000.0 * np.cumprod(1 + np.random.normal(0.001, 0.01, n))

    if flat_ohlc:
        high = close.copy()
        low  = close.copy()
        open_ = close.copy()
    else:
        high  = close * np.random.uniform(1.000, 1.015, n)
        low   = close * np.random.uniform(0.985, 1.000, n)
        open_ = close * np.random.uniform(0.995, 1.005, n)

    volumes = np.random.randint(100, 500, n).astype(float)
    n_zero = int(n * pct_zero_volume)
    zero_idx = np.random.choice(n, size=n_zero, replace=False)
    volumes[zero_idx] = 0.0

    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volumes},
        index=pd.date_range("2024-01-02", periods=n, freq="B"),
    )


# ─── TEST 1 - classify_tier : limites de seuil ────────────────────────────────

class TestClassifyTier:
    def test_exactly_at_liquide_threshold(self):
        """Exactement au seuil LIQUIDE → LIQUIDE."""
        val = LIQUIDITY_THRESHOLDS["LIQUIDE"]
        assert classify_tier(val) == "LIQUIDE"

    def test_just_above_liquide_threshold(self):
        assert classify_tier(LIQUIDITY_THRESHOLDS["LIQUIDE"] + 0.1) == "LIQUIDE"

    def test_just_below_liquide_threshold(self):
        """En dessous du seuil LIQUIDE mais au-dessus de SEMI_LIQUIDE → SEMI_LIQUIDE."""
        val = LIQUIDITY_THRESHOLDS["LIQUIDE"] - 0.1
        assert classify_tier(val) == "SEMI_LIQUIDE"

    def test_exactly_at_semi_liquide_threshold(self):
        """Exactement au seuil SEMI_LIQUIDE → SEMI_LIQUIDE."""
        val = LIQUIDITY_THRESHOLDS["SEMI_LIQUIDE"]
        assert classify_tier(val) == "SEMI_LIQUIDE"

    def test_just_below_semi_liquide_threshold(self):
        """En dessous du seuil SEMI_LIQUIDE → ILLIQUIDE."""
        val = LIQUIDITY_THRESHOLDS["SEMI_LIQUIDE"] - 0.1
        assert classify_tier(val) == "ILLIQUIDE"

    def test_zero_pct(self):
        """0 % volume → ILLIQUIDE."""
        assert classify_tier(0.0) == "ILLIQUIDE"

    def test_hundred_pct(self):
        """100 % volume → LIQUIDE."""
        assert classify_tier(100.0) == "LIQUIDE"


# ─── TEST 2 - Ticker liquide (95 % volume > 0) ───────────────────────────────

def test_metrics_liquid_ticker():
    """
    Ticker avec 5 % de séances zéro-volume → pct_volume_pos ≈ 95 % → LIQUIDE.
    """
    df = _make_ohlcv(n=250, pct_zero_volume=0.05)
    m = compute_liquidity_metrics(df, "SNTS")

    assert m.ticker == "SNTS"
    assert m.tier == "LIQUIDE", f"Attendu LIQUIDE, obtenu {m.tier} ({m.pct_volume_pos:.1f}%)"
    assert m.pct_volume_pos >= LIQUIDITY_THRESHOLDS["LIQUIDE"]
    assert m.nb_seances == 250
    assert m.error is None


# ─── TEST 3 - Ticker semi-liquide (60 % volume > 0) ──────────────────────────

def test_metrics_semi_liquid_ticker():
    """
    Ticker avec 40 % de séances zéro-volume → pct_volume_pos ≈ 60 % → SEMI_LIQUIDE.
    """
    df = _make_ohlcv(n=250, pct_zero_volume=0.40)
    m = compute_liquidity_metrics(df, "PALC")

    assert m.tier == "SEMI_LIQUIDE", (
        f"Attendu SEMI_LIQUIDE, obtenu {m.tier} ({m.pct_volume_pos:.1f}%)"
    )
    thr_semi = LIQUIDITY_THRESHOLDS["SEMI_LIQUIDE"]
    thr_liq  = LIQUIDITY_THRESHOLDS["LIQUIDE"]
    assert thr_semi <= m.pct_volume_pos < thr_liq
    assert m.error is None


# ─── TEST 4 - Ticker illiquide (20 % volume > 0) ─────────────────────────────

def test_metrics_illiquid_ticker():
    """
    Ticker avec 80 % de séances zéro-volume → pct_volume_pos ≈ 20 % → ILLIQUIDE.
    """
    df = _make_ohlcv(n=250, pct_zero_volume=0.80)
    m = compute_liquidity_metrics(df, "LNBB")

    assert m.tier == "ILLIQUIDE", (
        f"Attendu ILLIQUIDE, obtenu {m.tier} ({m.pct_volume_pos:.1f}%)"
    )
    assert m.pct_volume_pos < LIQUIDITY_THRESHOLDS["SEMI_LIQUIDE"]
    assert m.error is None


# ─── TEST 5 - Détection OHLC plats ───────────────────────────────────────────

def test_metrics_ohlc_flat_all_bars():
    """
    Quand high = low = close sur toutes les barres, pct_ohlc_flat doit être 100 %.
    """
    df = _make_ohlcv(n=60, flat_ohlc=True)
    m = compute_liquidity_metrics(df, "BOAM")

    assert m.pct_ohlc_flat == pytest.approx(100.0, abs=0.1), (
        f"pct_ohlc_flat attendu 100.0, obtenu {m.pct_ohlc_flat}"
    )


def test_metrics_ohlc_flat_zero_when_real():
    """
    Quand high ≠ low sur toutes les barres, pct_ohlc_flat doit être 0 %.
    """
    df = _make_ohlcv(n=60, flat_ohlc=False)
    # S'assurer que pas de bars accidentellement plates
    df["high"] = df["close"] * 1.01
    df["low"]  = df["close"] * 0.99
    m = compute_liquidity_metrics(df, "BOAM")

    assert m.pct_ohlc_flat == pytest.approx(0.0, abs=0.1), (
        f"pct_ohlc_flat attendu 0.0, obtenu {m.pct_ohlc_flat}"
    )


# ─── TEST 6 - Détection de sauts > 30 % ──────────────────────────────────────

def test_metrics_jump_detection_one_spike():
    """
    Un saut de +50 % inséré → sauts_30pct == 1.
    """
    df = _make_ohlcv(n=100)
    spike_idx = 50
    df.iloc[spike_idx, df.columns.get_loc("close")] = (
        df.iloc[spike_idx - 1]["close"] * 1.50
    )
    m = compute_liquidity_metrics(df, "TEST")

    assert m.sauts_30pct >= 1, (
        f"Attendu au moins 1 saut > {DIAGNOSTIC_JUMP_THRESHOLD_PCT}%, obtenu {m.sauts_30pct}"
    )


def test_metrics_jump_detection_no_spike():
    """
    Sans saut artificiel, le nombre de sauts > 30 % doit être 0 sur données stables.
    """
    # Série très stable (faible volatilité)
    np.random.seed(99)
    n = 100
    close = 1000.0 * np.cumprod(1 + np.random.normal(0.0, 0.005, n))
    df = pd.DataFrame(
        {"open": close, "high": close * 1.002, "low": close * 0.998,
         "close": close, "volume": 200.0},
        index=pd.date_range("2024-01-02", periods=n, freq="B"),
    )
    m = compute_liquidity_metrics(df, "TEST")

    assert m.sauts_30pct == 0, (
        f"Aucun saut attendu, obtenu {m.sauts_30pct}"
    )


# ─── TEST 7 - Cas limites DataFrame ───────────────────────────────────────────

def test_metrics_empty_dataframe():
    """DataFrame vide → error renseigné, tier=INCONNU."""
    df = pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    m = compute_liquidity_metrics(df, "VIDE")

    assert m.tier == "INCONNU"
    assert m.error is not None


def test_metrics_none_dataframe():
    """None passé → error renseigné, tier=INCONNU."""
    m = compute_liquidity_metrics(None, "NONE")  # type: ignore[arg-type]

    assert m.tier == "INCONNU"
    assert m.error is not None


def test_metrics_missing_columns():
    """Colonnes volume manquante → error renseigné."""
    df = pd.DataFrame(
        {"open": [100], "high": [101], "low": [99], "close": [100]},
        index=pd.date_range("2024-01-02", periods=1, freq="B"),
    )
    m = compute_liquidity_metrics(df, "TEST")

    assert m.error is not None
    assert m.tier == "INCONNU"


# ─── TEST 8 - Médiane du volume ───────────────────────────────────────────────

def test_metrics_volume_median_exact():
    """
    Avec un volume constant de 300 sur les séances non-zéro,
    volume_median doit être exactement 300.
    """
    n = 60
    # Alternance : 300 une fois sur deux, 0 sinon
    volumes = [300.0 if i % 2 == 0 else 0.0 for i in range(n)]
    close = 1000.0
    df = pd.DataFrame(
        {"open": close, "high": close * 1.01, "low": close * 0.99,
         "close": close, "volume": volumes},
        index=pd.date_range("2024-01-02", periods=n, freq="B"),
    )
    m = compute_liquidity_metrics(df, "TEST")

    assert m.volume_median == pytest.approx(300.0, abs=1.0), (
        f"volume_median attendu 300, obtenu {m.volume_median}"
    )


# ─── TEST 9 - pct_volume_pos exact ───────────────────────────────────────────

def test_metrics_pct_volume_pos_exact():
    """
    Sur 100 barres avec 50 volumes=0, pct_volume_pos doit être exactement 50.0%.
    """
    n = 100
    volumes = [200.0 if i % 2 == 0 else 0.0 for i in range(n)]
    close = 2000.0
    df = pd.DataFrame(
        {"open": close, "high": close * 1.01, "low": close * 0.99,
         "close": close, "volume": volumes},
        index=pd.date_range("2024-01-02", periods=n, freq="B"),
    )
    m = compute_liquidity_metrics(df, "TEST")

    assert m.pct_volume_pos == pytest.approx(50.0, abs=0.1), (
        f"pct_volume_pos attendu 50.0%, obtenu {m.pct_volume_pos}"
    )


# ─── TEST 10 - run_full_diagnostic avec fetch mock ────────────────────────────

def test_run_full_diagnostic_with_mock():
    """
    run_full_diagnostic() avec un fetch_fn mock retournant un DataFrame valide.
    Vérifie que tous les tickers de la liste sont présents dans le résultat.
    """
    tickers = ["SNTS", "BOAM", "LNBB"]

    def mock_fetch(ticker: str, days: int) -> pd.DataFrame:
        pct_zero = {"SNTS": 0.05, "BOAM": 0.80, "LNBB": 0.90}.get(ticker, 0.5)
        return _make_ohlcv(n=days, pct_zero_volume=pct_zero)

    results = run_full_diagnostic(fetch_fn=mock_fetch, tickers=tickers, days=100)

    assert set(results.keys()) == set(tickers)
    assert results["SNTS"].tier == "LIQUIDE"
    assert results["BOAM"].tier == "ILLIQUIDE"
    assert results["LNBB"].tier == "ILLIQUIDE"
    for m in results.values():
        assert m.error is None


def test_run_full_diagnostic_with_failing_fetch():
    """
    Si le fetch_fn lève une exception pour un ticker,
    run_full_diagnostic() ne doit pas planter et doit consigner l'erreur.
    """
    tickers = ["SNTS", "BOAM"]

    def flaky_fetch(ticker: str, days: int) -> pd.DataFrame:
        if ticker == "BOAM":
            raise RuntimeError("Timeout réseau simulé")
        return _make_ohlcv(n=days)

    results = run_full_diagnostic(fetch_fn=flaky_fetch, tickers=tickers, days=50)

    assert "SNTS" in results
    assert "BOAM" in results
    assert results["BOAM"].error is not None
    assert results["SNTS"].error is None


# ─── TEST 11 - generate_report contenu minimal ────────────────────────────────

def test_generate_report_contains_required_sections(tmp_path):
    """
    Le rapport généré doit contenir les sections clés et le bloc LIQUIDITY_TIERS.
    """
    tickers = ["SNTS", "BOAB"]

    def mock_fetch(ticker: str, days: int) -> pd.DataFrame:
        return _make_ohlcv(n=days, pct_zero_volume=0.05 if ticker == "SNTS" else 0.60)

    results = run_full_diagnostic(fetch_fn=mock_fetch, tickers=tickers, days=80)
    out_path = str(tmp_path / "report.md")
    content = generate_report(results, output_path=out_path)

    assert "# Rapport Diagnostic Liquidité BRVM" in content
    assert "## Résumé des tiers" in content
    assert "## Détail par ticker" in content
    assert "LIQUIDITY_TIERS" in content
    assert "SNTS" in content
    assert "BOAB" in content

    # Le fichier doit exister et avoir le même contenu
    with open(out_path, encoding="utf-8") as fh:
        file_content = fh.read()
    assert file_content == content


def test_generate_report_file_written(tmp_path):
    """generate_report() doit créer le fichier et retourner une str non-vide."""
    results = {
        "TEST": LiquidityMetrics(
            ticker="TEST",
            nb_seances=100,
            pct_volume_pos=75.0,
            volume_median=250.0,
            pct_ohlc_flat=10.0,
            sauts_30pct=0,
            tier="SEMI_LIQUIDE",
            date_start="2024-01-02",
            date_end="2024-12-31",
        )
    }
    out_path = str(tmp_path / "test_report.md")
    content = generate_report(results, output_path=out_path)

    assert len(content) > 0
    assert os.path.exists(out_path)
    assert "SEMI_LIQUIDE" in content
