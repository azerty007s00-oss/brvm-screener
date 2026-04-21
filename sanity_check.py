"""
sanity_check.py — Validation rapide du pipeline Phase 2 + D1.

5 profils synthétiques :
  1. Haussier fort (large cap liquide)
  2. Baissier clair
  3. Range complet (pas de tendance)
  4. Small cap illiquide (faible volume, ATR bas, RSI compressé)
  5. Retournement récent (haussier→baissier)
"""

import sys
import numpy as np
import pandas as pd

from indicators import compute_indicators
from scoring import compute_score
from analysis import compute_risk_levels


# ─── Générateurs de données synthétiques ─────────────────────────────────────

def _df(prices, volumes=None, n=None):
    n = len(prices)
    dates = pd.date_range("2022-01-01", periods=n, freq="B")
    p = np.array(prices, dtype=float)
    noise = np.random.RandomState(99).uniform(0.98, 1.01, n)
    return pd.DataFrame({
        "open":   p * 0.995,
        "high":   p * 1.012,
        "low":    p * 0.988,
        "close":  p,
        "volume": volumes if volumes is not None else np.full(n, 300),
    }, index=dates)


def make_trending_up(n=250):
    """Tendance haussière régulière — score positif attendu."""
    rng = np.random.RandomState(1)
    returns = rng.normal(0.006, 0.008, n)
    prices = 1000 * np.exp(np.cumsum(returns))
    vols = rng.randint(200, 600, n).astype(float)
    return _df(prices, vols)


def make_trending_down(n=250):
    """Tendance baissière régulière — score négatif attendu."""
    rng = np.random.RandomState(2)
    returns = rng.normal(-0.006, 0.008, n)
    prices = 1000 * np.exp(np.cumsum(returns))
    vols = rng.randint(200, 600, n).astype(float)
    return _df(prices, vols)


def make_range(n=250):
    """Marché en range — score proche de 0 attendu."""
    rng = np.random.RandomState(3)
    t = np.linspace(0, 4 * np.pi, n)
    prices = 1000 + 40 * np.sin(t) + rng.normal(0, 5, n)
    vols = rng.randint(100, 300, n).astype(float)
    return _df(prices, vols)


def make_illiquid_small_cap(n=250):
    """Small cap illiquide — volume faible, prix quasi-flat → _vol_mult clamp attendu."""
    rng = np.random.RandomState(4)
    returns = rng.normal(0.0005, 0.002, n)      # volatilité très faible
    prices = 500 * np.exp(np.cumsum(returns))
    # volumes très faibles, avec beaucoup de zéros
    vols = rng.choice([0, 0, 5, 10, 20, 50], n).astype(float)
    return _df(prices, vols)


def make_reversal(n=250):
    """Tendance haussière puis retournement brutal sur les 40 dernières séances."""
    rng = np.random.RandomState(5)
    up   = 1000 * np.exp(np.cumsum(rng.normal(0.005, 0.008, n - 40)))
    down = up[-1]  * np.exp(np.cumsum(rng.normal(-0.010, 0.010, 40)))
    prices = np.concatenate([up, down])
    vols = rng.randint(150, 500, n).astype(float)
    return _df(prices, vols)


# ─── Rapport structuré ────────────────────────────────────────────────────────

def report(label: str, df: pd.DataFrame):
    ind   = compute_indicators(df, ticker=label)
    score = compute_score(ind)
    stop, target = compute_risk_levels(score, ind)

    # groupes (recalcul depuis critères pour affichage)
    G_MOMENTUM = {"MACD", "Divergence MACD", "MACD Momentum"}
    G_TREND    = {"MA Config", "MA50 Slope", "Tendance LT"}
    G_TIMING   = {"RSI", "Divergence RSI", "Stochastic"}

    def gs(group):
        return sum(max(-1, min(1, c.points)) for c in score.criteres if c.nom in group)

    s_m, s_t, s_ti = gs(G_MOMENTUM), gs(G_TREND), gs(G_TIMING)

    atr_pct  = f"{ind.atr_pct:.2f}%" if ind.atr_pct is not None else "N/A"
    rsi_str  = f"{ind.rsi:.1f}" if ind.rsi is not None else "N/A"
    rsi_lo   = f"{ind.rsi_p10:.0f}" if ind.rsi_p10 is not None else "30"
    rsi_hi   = f"{ind.rsi_p90:.0f}" if ind.rsi_p90 is not None else "70"
    adx_str  = f"{ind.adx:.1f}" if ind.adx is not None else "N/A"

    # Risk levels
    if stop is not None and ind.atr and ind.atr > 0:
        k1_obs = abs(stop - ind.cours_actuel) / ind.atr
        k2_obs = abs(target - ind.cours_actuel) / ind.atr
        risk_str = (
            f"Stop={stop:,.0f} ({k1_obs:.1f}×ATR) | "
            f"Target={target:,.0f} (+{k2_obs:.1f}×ATR)"
        )
    else:
        risk_str = "N/A (neutre ou ATR absent)"

    print(f"\n{'='*62}")
    print(f"  {label}")
    print(f"{'-'*62}")
    print(f"  Prix   : {ind.cours_actuel:,.0f} FCFA  |  ATR: {atr_pct}  |  ADX: {adx_str}")
    print(f"  Score  : {score.score_total:+d}  |  Signal: {score.signal:<6}  |  Confiance: {score.confiance}")
    print(f"  Groupes: momentum={s_m:+d}  trend={s_t:+d}  timing={s_ti:+d}")
    print(f"  RSI    : {rsi_str} [P10={rsi_lo} / P90={rsi_hi}]")
    print(f"  D1     : {risk_str}")

    # Checks
    issues = []
    if "haussi" in label.lower() and score.score_total <= 0:
        issues.append("⚠ score non positif sur tendance haussière")
    if "baissier" in label.lower() and score.score_total >= 0:
        issues.append("⚠ score non négatif sur tendance baissière")
    if "range" in label.lower() and abs(score.score_total) > 3:
        issues.append(f"⚠ score {score.score_total:+d} élevé sur marché en range")
    if score.score_total != 0 and score.confiance == "forte" and s_m == 0 and s_t == 0:
        issues.append("⚠ confiance forte sans groupes momentum/trend actifs")
    if stop is not None and score.signal == "ACHAT" and stop >= ind.cours_actuel:
        issues.append("⚠ stop > prix sur ACHAT — incohérence directionnelle")
    if stop is not None and score.signal == "VENTE" and stop <= ind.cours_actuel:
        issues.append("⚠ stop < prix sur VENTE — incohérence directionnelle")

    if issues:
        for iss in issues:
            print(f"  {iss}")
    else:
        print("  ✓ Aucun red flag détecté")


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    np.random.seed(0)
    print("\nSANITY CHECK — Phase 2 + D1")
    report("1. Haussier fort (large cap)",    make_trending_up())
    report("2. Baissier clair",               make_trending_down())
    report("3. Range complet",                make_range())
    report("4. Small cap illiquide",          make_illiquid_small_cap())
    report("5. Retournement récent",          make_reversal())
    print(f"\n{'═'*62}\n")
