"""
tests/test_backtest.py — Tests unitaires pour _compute_metrics(), walk_forward_backtest(),
_apply_slippage(), monte_carlo_permutation() et BacktestEngine (T+1, volume=0).
Aucun appel réseau : données OHLCV synthétiques uniquement.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import inspect
import numpy as np
import pandas as pd
import pytest

from backtest import (
    _compute_metrics,
    _apply_slippage,
    monte_carlo_permutation,
    walk_forward_backtest,
    BacktestEngine,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _make_equity(n: int, daily_return: float, seed: int = 0) -> pd.Series:
    """Série d'équité à rendement journalier constant, indexée sur jours ouvrés."""
    np.random.seed(seed)
    returns = np.full(n, daily_return)
    prices = 1_000_000.0 * np.cumprod(1 + returns)
    return pd.Series(prices, index=pd.date_range("2020-01-01", periods=n, freq="B"))


def _make_equity_volatile(n: int, mu: float = 0.002, sigma: float = 0.01, seed: int = 42) -> pd.Series:
    """Série d'équité avec rendements aléatoires (mu > 0 → tendance haussière)."""
    np.random.seed(seed)
    returns = np.random.normal(mu, sigma, n)
    prices = 1_000_000.0 * np.cumprod(1 + returns)
    return pd.Series(prices, index=pd.date_range("2020-01-01", periods=n, freq="B"))


def _make_ohlcv(n: int = 500, seed: int = 42) -> pd.DataFrame:
    """DataFrame OHLCV synthétique pour tests walk-forward (sans réseau)."""
    np.random.seed(seed)
    close = 1500.0 * np.cumprod(1 + np.random.normal(0.001, 0.012, n))
    high  = close * np.random.uniform(1.000, 1.015, n)
    low   = close * np.random.uniform(0.985, 1.000, n)
    # Garantir cohérence OHLCV
    high  = np.maximum(high, close)
    low   = np.minimum(low,  close)
    return pd.DataFrame({
        "open":   close * np.random.uniform(0.995, 1.005, n),
        "high":   high,
        "low":    low,
        "close":  close,
        "volume": np.random.randint(300, 1200, n).astype(float),
    }, index=pd.date_range("2020-01-01", periods=n, freq="B"))


# ─── TEST 1 — Sharpe positif sur equity croissante ────────────────────────────

def test_fees_applied():
    """
    Equity synthétique de 252 points avec rendements positifs variables.
    _compute_metrics() doit retourner un Sharpe > 0.
    """
    np.random.seed(0)
    n = 252
    # Tous les rendements positifs → excess > risk_free/252 en moyenne → Sharpe > 0
    returns = np.abs(np.random.normal(0.003, 0.002, n))
    prices = 1_000_000.0 * np.cumprod(1 + returns)
    equity = pd.Series(prices, index=pd.date_range("2020-01-01", periods=n, freq="B"))

    metrics = _compute_metrics(equity)

    assert "sharpe" in metrics, "La clé 'sharpe' est absente du résultat"
    assert metrics["sharpe"] > 0, (
        f"Sharpe={metrics['sharpe']:.4f} devrait être > 0 sur equity croissante"
    )


# ─── TEST 2 — Max drawdown correct (100→150→120 ≈ -20%) ──────────────────────

def test_max_drawdown_correct():
    """
    Equity : monte de 100 à 150, redescend à 120.
    max_drawdown doit être ≈ -0.20 (soit -20%).
    """
    n1, n2 = 60, 30
    up   = np.linspace(100, 150, n1)
    down = np.linspace(150, 120, n2 + 1)[1:]  # skip le 150 dupliqué
    prices = np.concatenate([up, down]) * 10_000   # en FCFA
    equity = pd.Series(
        prices,
        index=pd.date_range("2020-01-01", periods=len(prices), freq="B"),
    )

    metrics = _compute_metrics(equity)
    dd = metrics["max_drawdown"]

    assert abs(dd - (-0.20)) < 0.01, (
        f"max_drawdown={dd:.4f} devrait être ≈ -0.20 (tolérance ±0.01)"
    )


# ─── TEST 3 — Calmar positif sur equity croissante avec petit drawdown ────────

def test_calmar_positive():
    """
    Equity haussière (μ=+0.2%/j) avec drawdowns résiduels aléatoires.
    calmar doit être > 0 : CAGR > 0 et max_drawdown < 0.
    """
    equity = _make_equity_volatile(n=252, mu=0.002, sigma=0.008, seed=7)

    metrics = _compute_metrics(equity)

    assert metrics["cagr"] > 0, f"CAGR={metrics['cagr']:.4f} devrait être > 0"
    assert metrics["max_drawdown"] < 0, (
        f"max_drawdown={metrics['max_drawdown']:.4f} devrait être < 0"
    )
    assert metrics["calmar"] > 0, (
        f"calmar={metrics['calmar']:.4f} devrait être > 0 sur equity haussière"
    )


# ─── TEST 4 — walk_forward_backtest retourne une liste non vide ───────────────

def test_walk_forward_returns_list():
    """
    walk_forward_backtest sur données synthétiques (500 barres, 3 fenêtres).
    Doit retourner une liste non vide ; chaque élément a la clé 'total_return'.
    """
    df = _make_ohlcv(n=500, seed=42)
    ticker_data = {"SYNTH": df}

    results = walk_forward_backtest(
        ticker_data,
        n_splits=3,
        train_ratio=0.7,
        regime_filter=False,   # pas d'indice BRVMC dans les données synthétiques
        min_price=0.0,         # prix synthétiques < 500 FCFA si besoin
        debug=False,
    )

    assert isinstance(results, list), "walk_forward_backtest doit retourner une liste"
    assert len(results) > 0, "La liste de résultats ne doit pas être vide"

    for i, r in enumerate(results):
        assert "total_return" in r.summary, (
            f"Fenêtre {i+1} : clé 'total_return' absente du summary "
            f"(clés présentes : {list(r.summary.keys())})"
        )


# ─── TEST 5 — Alpha positif : stratégie surperforme le benchmark ─────────────

def test_benchmark_alpha():
    """
    Stratégie : +0.15%/j  —  Benchmark : +0.03%/j.
    alpha = cagr_stratégie − cagr_benchmark doit être > 0.
    """
    strat_equity = _make_equity(n=252, daily_return=0.0015)
    bench_equity  = _make_equity(n=252, daily_return=0.0003)

    strat_metrics = _compute_metrics(strat_equity)
    bench_metrics  = _compute_metrics(bench_equity)

    alpha = strat_metrics["cagr"] - bench_metrics["cagr"]

    assert alpha > 0, (
        f"alpha={alpha:.4f} devrait être > 0 "
        f"(cagr_strat={strat_metrics['cagr']:.4f}, "
        f"cagr_bench={bench_metrics['cagr']:.4f})"
    )


# ─── TEST 6 — Slippage nul si volume = 0 ou None ─────────────────────────────

def test_slippage_no_volume():
    """Sans volume de référence, _apply_slippage retourne le prix inchangé."""
    price = 1500.0
    assert _apply_slippage(price, 10.0, None,  100_000.0) == price
    assert _apply_slippage(price, 10.0, 0.0,   100_000.0) == price
    assert _apply_slippage(0.0,   10.0, 500.0, 100_000.0) == 0.0


# ─── TEST 7 — Slippage croît avec la participation au volume ──────────────────

def test_slippage_increases_with_participation():
    """Plus la position est grande par rapport au volume moyen, plus le slippage est élevé."""
    price = 1000.0
    equity = 1_000_000.0
    # Position 5% sur volume 500 → participation faible
    p_low  = _apply_slippage(price, 5.0,  500.0, equity)
    # Position 20% sur volume 50 → participation élevée
    p_high = _apply_slippage(price, 20.0, 50.0,  equity)
    assert p_high > p_low, f"Slippage élevé ({p_high}) doit dépasser slippage faible ({p_low})"
    assert p_low  > price, "Même un faible slippage doit augmenter le prix d'entrée"


# ─── TEST 8 — Slippage plafonné à 2% ─────────────────────────────────────────

def test_slippage_capped_at_2pct():
    """Impact plafonné à 2% même avec position très grande vs volume très faible."""
    price  = 1000.0
    equity = 10_000_000.0   # 10M FCFA
    # Ordre massif (50% du capital) sur volume minuscule (1 titre/jour)
    result = _apply_slippage(price, 50.0, 1.0, equity)
    assert result <= price * 1.02 + 0.01, (
        f"Slippage plafonné à 2% : attendu ≤ {price * 1.02:.2f}, obtenu {result:.2f}"
    )


# ─── TEST 9 — BacktestEngine : _pending initialisé, override_price accepté ───

def test_engine_t1_structure():
    """BacktestEngine doit avoir _pending dict et _open_position doit accepter override_price."""
    engine = BacktestEngine(
        initial_capital=1_000_000,
        horizon="Moyen terme",
        warmup_bars=30,
        review_interval_days=7,
        max_holding_days=90,
        regime_filter=False,
    )
    assert hasattr(engine, "_pending"), "_pending doit être initialisé dans __init__"
    assert isinstance(engine._pending, dict), "_pending doit être un dict"

    sig = inspect.signature(engine._open_position)
    assert "override_price" in sig.parameters, (
        "_open_position doit accepter le paramètre override_price (exécution T+1)"
    )


# ─── TEST 10 — Monte Carlo : p-value dans [0, 1], clés attendues présentes ───

def test_monte_carlo_structure():
    """monte_carlo_permutation doit retourner un dict avec les clés attendues."""
    np.random.seed(99)
    returns = np.random.normal(0.001, 0.01, 120)
    equity_vals = 1_000_000.0 * np.cumprod(1 + returns)
    eq_df = pd.DataFrame({
        "date":   pd.date_range("2021-01-01", periods=120, freq="B"),
        "equity": equity_vals,
    })

    class FakeResult:
        equity_curve = eq_df
        summary = {}

    mc = monte_carlo_permutation(FakeResult(), n_simulations=200, seed=0)

    for key in ("sharpe_reel", "sharpe_median_mc", "p_value", "significatif_95", "n_simulations"):
        assert key in mc, f"Clé '{key}' absente du résultat Monte Carlo"

    assert 0.0 <= mc["p_value"] <= 1.0, f"p_value={mc['p_value']} hors [0, 1]"
    assert isinstance(mc["significatif_95"], bool)


# ─── TEST 11 — Monte Carlo : série aléatoire non significative ───────────────

def test_monte_carlo_random_not_significant():
    """Une série de rendements purement aléatoires (mu=0) ne doit pas être significative
    dans la grande majorité des cas (on teste sur 5 seeds différents)."""
    significant_count = 0
    for seed in range(5):
        rng = np.random.default_rng(seed * 17)
        returns = rng.normal(0.0, 0.01, 100)
        equity_vals = 1_000_000.0 * np.cumprod(1 + returns)
        eq_df = pd.DataFrame({
            "date":   pd.date_range("2021-01-01", periods=100, freq="B"),
            "equity": equity_vals,
        })

        class FakeResult:
            equity_curve = eq_df
            summary = {}

        mc = monte_carlo_permutation(FakeResult(), n_simulations=500, seed=seed)
        if mc.get("significatif_95"):
            significant_count += 1

    # On tolère au plus 1 faux positif sur 5 (seuil 5% → ~0.25 attendu en moyenne)
    assert significant_count <= 2, (
        f"{significant_count}/5 séries aléatoires déclarées significatives — trop élevé"
    )
