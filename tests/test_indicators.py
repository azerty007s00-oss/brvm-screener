"""
tests/test_indicators.py — Tests unitaires pour les fonctions d'indicators.py.
Aucun appel réseau : données synthétiques uniquement.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
import pytest

from indicators import (
    _fill_ohlcv_gaps,
    _validate_ohlcv,
    _calc_rsi,
    _calc_bbands,
    compute_indicators,
    TechnicalIndicators,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _make_ohlcv_df(n: int = 100, seed: int = 42) -> pd.DataFrame:
    """DataFrame OHLCV synthétique avec index DatetimIndex continu."""
    np.random.seed(seed)
    close = 1000.0 * np.cumprod(1 + np.random.normal(0.001, 0.01, n))
    high  = np.maximum(close * np.random.uniform(1.000, 1.015, n), close)
    low   = np.minimum(close * np.random.uniform(0.985, 1.000, n), close)
    return pd.DataFrame({
        "open":   close * np.random.uniform(0.995, 1.005, n),
        "high":   high,
        "low":    low,
        "close":  close,
        "volume": np.random.randint(200, 1000, n).astype(float),
    }, index=pd.date_range("2020-01-01", periods=n, freq="B"))


# ─── TEST 1 — Interpolation de gaps ──────────────────────────────────────────

def test_gap_interpolation():
    """
    DataFrame avec 2 jours manquants dans une semaine sans jours fériés BRVM.
    Après _fill_ohlcv_gaps() :
    - les 2 jours manquants sont comblés
    - le volume des jours ajoutés est 0
    - les jours existants sont conservés (y compris éventuels jours fériés publiés)
    Utilise une plage en mars (hors jours fériés UEMOA/CI) pour éviter les effets
    du calendrier BRVM sur le décompte attendu.
    """
    # Plage sans jours fériés BRVM : 2 mars – 30 avril 2020 (hors 1er mai)
    idx_full = pd.bdate_range("2020-03-02", "2020-04-30")   # ~43 jours ouvrés
    n = len(idx_full)
    np.random.seed(7)
    close = 1000.0 * np.cumprod(1 + np.random.normal(0.001, 0.01, n))
    df_full = pd.DataFrame({
        "open": close, "high": close * 1.01, "low": close * 0.99,
        "close": close, "volume": np.random.randint(200, 800, n).astype(float),
    }, index=idx_full)

    # Créer un gap de 2 jours consécutifs au milieu
    gap_dates = idx_full[20:22]
    df_gap = df_full.drop(gap_dates)
    assert len(df_gap) == n - 2

    df_filled, added_days = _fill_ohlcv_gaps(df_gap)

    # Les 2 jours manquants ont été ajoutés
    assert len(added_days) == 2, f"{len(added_days)} jours ajoutés, attendu 2"
    assert df_filled.index.is_monotonic_increasing

    # Volume = 0 sur les jours interpolés
    for d in added_days:
        vol = df_filled.loc[d, "volume"]
        assert vol == 0, f"Volume le {d} devrait être 0 (jour interpolé), obtenu {vol}"

    # Les jours existants sont tous présents
    for d in df_gap.index:
        assert d in df_filled.index, f"Jour existant {d} supprimé après gap-filling"


# ─── TEST 2 — RSI dans [0, 100] ───────────────────────────────────────────────

def test_rsi_range():
    """
    Sur n'importe quelle série de prix synthétiques,
    tous les valeurs de RSI doivent être dans [0, 100].
    """
    np.random.seed(123)
    n = 200
    close = pd.Series(
        1000.0 * np.cumprod(1 + np.random.normal(0.0, 0.02, n)),
        index=pd.date_range("2020-01-01", periods=n, freq="B"),
    )

    rsi_series = _calc_rsi(close, length=14).dropna()

    assert len(rsi_series) > 0, "La série RSI ne doit pas être vide"
    assert (rsi_series >= 0).all(), (
        f"RSI minimum = {rsi_series.min():.2f} — inférieur à 0"
    )
    assert (rsi_series <= 100).all(), (
        f"RSI maximum = {rsi_series.max():.2f} — supérieur à 100"
    )


# ─── TEST 3 — Bandes de Bollinger : upper >= mid >= lower ────────────────────

def test_bollinger_bands_ordering():
    """
    Sur toute la série, bb_upper >= bb_middle >= bb_lower doit être vérifié.
    """
    np.random.seed(7)
    n = 150
    close = pd.Series(
        1000.0 * np.cumprod(1 + np.random.normal(0.001, 0.01, n)),
        index=pd.date_range("2020-01-01", periods=n, freq="B"),
    )

    upper, middle, lower = _calc_bbands(close, length=20, std=2.0)

    valid = pd.DataFrame({
        "upper":  upper,
        "middle": middle,
        "lower":  lower,
    }).dropna()

    assert len(valid) > 0, "Aucune valeur valide dans les Bandes de Bollinger"
    assert (valid["upper"] >= valid["middle"]).all(), (
        "bb_upper >= bb_middle non respecté sur toute la série"
    )
    assert (valid["middle"] >= valid["lower"]).all(), (
        "bb_middle >= bb_lower non respecté sur toute la série"
    )


# ─── TEST 4 — Détection action sur le capital (saut > 30%) ───────────────────

def test_corporate_action_flag():
    """
    DataFrame avec un saut de cours > 30% sur une journée.
    _validate_ohlcv() doit retourner au moins un warning contenant '30%'.
    """
    n = 50
    df = _make_ohlcv_df(n=n, seed=99)

    # Introduire un saut de +50% au jour 25
    spike_date = df.index[25]
    df.loc[spike_date, "close"] = df.loc[df.index[24], "close"] * 1.50
    df.loc[spike_date, "high"]  = df.loc[spike_date, "close"]

    warnings = _validate_ohlcv(df)

    assert len(warnings) >= 1, (
        "Au moins un warning devrait être retourné pour un saut de +50%"
    )
    found_30 = any("30%" in w for w in warnings)
    assert found_30, (
        f"Aucun warning ne contient '30%'. Warnings reçus : {warnings}"
    )


# ─── TEST 5 — Turnover FCFA : volume × cours ─────────────────────────────────

def test_turnover_fcfa_computed():
    """
    compute_indicators() doit calculer turnover_moy20_fcfa ≈ volume_moy20 × close_moyen.
    On construit un DataFrame avec volume et close constants pour vérification exacte.
    """
    n = 60
    volume_fixe = 300.0
    close_fixe  = 5000.0   # 300 × 5000 = 1 500 000 FCFA/j
    idx = pd.date_range("2021-01-04", periods=n, freq="B")
    df = pd.DataFrame({
        "open":   close_fixe,
        "high":   close_fixe,
        "low":    close_fixe,
        "close":  close_fixe,
        "volume": volume_fixe,
    }, index=idx)

    result = compute_indicators(df, ticker="TEST")

    attendu = volume_fixe * close_fixe   # 1 500 000
    assert result.turnover_moy20_fcfa == pytest.approx(attendu, rel=0.01), (
        f"Turnover attendu ≈ {attendu}, obtenu {result.turnover_moy20_fcfa}"
    )


# ─── TEST 6 — Thin trading bias : % jours volume=0 ───────────────────────────

def test_zero_volume_days_pct():
    """
    Avec 10 jours sur 20 sans transaction (volume=0),
    zero_volume_days_pct doit être exactement 50.0%.
    """
    n = 60
    idx = pd.date_range("2021-01-04", periods=n, freq="B")
    volumes = [300.0 if i % 2 == 0 else 0.0 for i in range(n)]
    close_fixe = 2000.0
    df = pd.DataFrame({
        "open":   close_fixe,
        "high":   close_fixe * 1.01,
        "low":    close_fixe * 0.99,
        "close":  close_fixe,
        "volume": volumes,
    }, index=idx)

    result = compute_indicators(df, ticker="TEST")

    assert result.zero_volume_days_pct == pytest.approx(50.0, abs=1.0), (
        f"zero_volume_days_pct attendu ≈ 50%, obtenu {result.zero_volume_days_pct}"
    )


# ─── TEST 7 — Détection OHLC synthétique ─────────────────────────────────────

def test_synthetic_ohlc_detected():
    """
    Quand high=low=close sur >50% des 20 dernières barres,
    synthetic_ohlc doit être True.
    Quand high≠low≠close partout, synthetic_ohlc doit être False.
    """
    n = 60
    idx = pd.date_range("2021-01-04", periods=n, freq="B")
    np.random.seed(42)
    close = 1000.0 * np.cumprod(1 + np.random.normal(0.001, 0.005, n))

    # ── Cas 1 : 20 dernières barres toutes synthétiques (high=low=close) ──
    df_synth = pd.DataFrame({
        "open":   close,
        "high":   close,
        "low":    close,
        "close":  close,
        "volume": 200.0,
    }, index=idx)
    res_synth = compute_indicators(df_synth, ticker="TEST")
    assert res_synth.synthetic_ohlc is True, (
        "synthetic_ohlc devrait être True quand high=low=close partout"
    )

    # ── Cas 2 : OHLC réels (high≠low) ──
    high  = close * 1.01
    low   = close * 0.99
    df_real = pd.DataFrame({
        "open":   close,
        "high":   high,
        "low":    low,
        "close":  close,
        "volume": 200.0,
    }, index=idx)
    res_real = compute_indicators(df_real, ticker="TEST")
    assert res_real.synthetic_ohlc is False, (
        "synthetic_ohlc devrait être False quand high≠low"
    )
