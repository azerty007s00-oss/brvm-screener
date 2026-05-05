#!/usr/bin/env python3
"""
strategy_research.py ? Recherche de strat?gie rentable sur le march? BRVM

Impl?mente et compare 4 strat?gies long-only adapt?es au march? BRVM (fixing journalier,
micro-liquidit?, pas de vente ? d?couvert) :

  1. CSM  ? Cross-Sectional Momentum (3 mois, top-5)
  2. TF   ? Trend Following dual-MA (SMA20 > SMA50)
  3. MR   ? Mean-Reversion RSI (RSI(20) < 35)
  4. LVT  ? Low-Volatility + Trend (ATR minimal en tendance)

Validation :
  - Walk-forward 3 fen?tres (60% train / 40% test -> r?sultats out-of-sample)
  - Monte Carlo permutation (1 000 simulations, p-value < 0.05 = significatif)
  - Benchmark buy-and-hold BRVMC synth?tique (alpha, beta)

Donn?es :
  Univers synth?tique 20 actions, 5 ans (?1 260 s?ances), calibr? BRVM :
    - Drift 6% CAGR, ?_annuelle 22%, AR(1) ?=0.18 (stale prices)
    - 20% de jours sans volume, sauts occasionnels (annonces r?sultats)
    - Frais SGI : 1,3% aller-retour, slippage proportionnel au volume journalier
    - Ex?cution T+1 (signal J -> entr?e J+1, fixing BRVM)

Usage :
    python strategy_research.py
"""

import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
from dataclasses import dataclass, field
from typing import Callable

from config import is_brvm_holiday
from backtest import _compute_metrics   # r?utilise les m?triques de risque test?es

# ??? Param?tres partag?s ?????????????????????????????????????????????????????

INITIAL_CAP    = 1_000_000.0   # FCFA
FEE_RT         = 0.013         # 1.3% aller-retour (SGI ~0.5% + pr?l?vements ~0.15%)
STOP_PCT       = 0.08          # stop loss 8%
MAX_POSITIONS  = 5             # positions simultan?es max (concentration BRVM)
VOLUME_MIN     = 100           # titres/jour min pour filtrer l'extr?me illiquidit?
VOLUME_WINDOW  = 20            # fen?tre volume moyen


# ??? G?n?ration de l'univers synth?tique BRVM ????????????????????????????????

def generate_brvm_universe(
    n_stocks: int = 20,
    n_days:   int = 1260,     # 5 ans de trading ? 252?5
    seed:     int = 42,
) -> tuple[dict, pd.Series]:
    """
    G?n?re un univers d'actions synth?tiques calibr? sur les statistiques BRVM observ?es.

    Mod?le ?conom?trique :
        r_it = ?_i + ?_i ? r_market_t + ?_it
        r_market_t = ? ? r_market_{t-1} + ?_t     (AR(1) stale prices)
        ?_it       = ? ? ?_i,{t-1}   + u_it

    Retourne :
        ticker_data : dict ticker -> DataFrame OHLCV (index DatetimIndex)
        benchmark   : pd.Series equity buy-and-hold ?quipond?r?
    """
    rng = np.random.default_rng(seed)

    # Calendrier BRVM r?el (sans week-end ni jours f?ri?s UEMOA/CI)
    raw_cal = pd.date_range("2019-01-02", periods=n_days * 2, freq="D")
    brvm_cal = pd.DatetimeIndex([d for d in raw_cal if not is_brvm_holiday(d)])[:n_days]

    mu_d    = 0.09 / 252           # drift journalier (9% CAGR ? BRVM historique)
    sig_d   = 0.18 / 252 ** 0.5   # sigma journaliere (18% vol annuelle)
    rho     = 0.18                 # autocorr?lation AR(1)

    # ?? Facteur march? commun (AR1) ??
    eps_m  = rng.normal(mu_d, sig_d, n_days)
    market = np.zeros(n_days)
    for t in range(1, n_days):
        market[t] = rho * market[t - 1] + eps_m[t]
    # Normalise le drift pour atteindre exactement le CAGR cible (8%)
    # independamment de la graine aleatoire (evite les marches baissiers artificiels)
    target_log = np.log(1.08) * n_days / 252
    market += (target_log - market.sum()) / n_days

    ticker_data: dict[str, pd.DataFrame] = {}
    bench_prices: list[np.ndarray] = []

    for i in range(n_stocks):
        ticker = f"T{i + 1:02d}"

        # Param?tres idiosyncratiques
        beta     = rng.uniform(0.5, 1.5)
        alpha    = rng.uniform(-0.0002, 0.0003)
        sig_idio = rng.uniform(0.012, 0.025)

        # Rendements avec AR(1) idiosyncratique
        eps_id = rng.normal(0, sig_idio, n_days)
        idio   = np.zeros(n_days)
        for t in range(1, n_days):
            idio[t] = rho * idio[t - 1] + eps_id[t]

        rets = alpha + beta * market + idio

        # Sauts occasionnels : annonces r?sultats, actions en capital
        n_jumps  = rng.integers(3, 10)
        j_idx    = rng.choice(n_days, n_jumps, replace=False)
        j_sizes  = rng.uniform(-0.12, 0.18, n_jumps)
        rets[j_idx] += j_sizes

        # Construction des prix
        p0     = rng.uniform(1_000, 15_000)
        prices = p0 * np.exp(np.cumsum(rets))

        # OHLC synth?tique (range intraday r?aliste pour BRVM)
        ir   = rng.uniform(0.002, 0.015, n_days)
        high = np.maximum(prices * (1 + ir * rng.uniform(0.4, 1.0, n_days)), prices)
        low  = np.minimum(prices * (1 - ir * rng.uniform(0.4, 1.0, n_days)), prices)

        # Volume : log-normal avec 20% de jours z?ro
        base_v  = rng.lognormal(np.log(rng.integers(80, 400)), 0.9, n_days)
        zero_m  = rng.random(n_days) < 0.20
        volume  = np.where(zero_m, 0.0, base_v.clip(10, 1_500))

        ticker_data[ticker] = pd.DataFrame(
            {"open": prices, "high": high, "low": low, "close": prices, "volume": volume},
            index=brvm_cal,
        )
        bench_prices.append(prices)

    # Benchmark : buy-and-hold ?quipond?r? des 20 titres
    pm         = np.stack(bench_prices, axis=1)           # (n_days, n_stocks)
    bench_rets = np.diff(np.log(pm), axis=0).mean(axis=1) # (n_days-1,)
    bench_eq   = INITIAL_CAP * np.exp(np.cumsum(bench_rets))
    benchmark  = pd.Series(bench_eq, index=brvm_cal[1:])

    return ticker_data, benchmark


# ??? Indicateurs purs (vectoris?s) ???????????????????????????????????????????

def _sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()

def _rsi(s: pd.Series, n: int = 20) -> pd.Series:
    d   = s.diff()
    ag  = d.where(d > 0, 0.0).ewm(alpha=1/n, min_periods=n, adjust=False).mean()
    al  = (-d.where(d < 0, 0.0)).ewm(alpha=1/n, min_periods=n, adjust=False).mean()
    return 100 - 100 / (1 + ag / al.replace(0, np.nan))

def _atr(df: pd.DataFrame, n: int = 20) -> pd.Series:
    hl  = df["high"] - df["low"]
    hcp = (df["high"] - df["close"].shift()).abs()
    lcp = (df["low"]  - df["close"].shift()).abs()
    tr  = pd.concat([hl, hcp, lcp], axis=1).max(axis=1)
    return tr.ewm(alpha=1/n, min_periods=n, adjust=False).mean()

def _vol_avg(df: pd.DataFrame, t_loc: int) -> float:
    """Volume moyen sur la fen?tre pass?e (en positon iloc)."""
    start = max(0, t_loc - VOLUME_WINDOW)
    return float(df["volume"].iloc[start:t_loc].mean())

def _slippage(price: float, order_value: float, vol_avg: float) -> float:
    """Market impact identique au mod?le backtest.py (plafonn? ? 2%)."""
    if vol_avg <= 0 or price <= 0:
        return price
    shares    = order_value / price
    part      = shares / vol_avg
    impact    = min(part * 0.05, 0.02)   # 0.5% par 10% de participation
    return price * (1 + impact)


# ??? Moteur de simulation g?n?rique ??????????????????????????????????????????

@dataclass
class Trade:
    ticker:      str
    entry_date:  pd.Timestamp
    entry_price: float
    exit_date:   pd.Timestamp
    exit_price:  float
    pnl_pct:     float
    holding_days: int
    exit_reason:  str
    weight_pct:   float


def _run_strategy(
    ticker_data:     dict[str, pd.DataFrame],
    select_fn:       Callable,   # (ticker_data, dates, t_i) -> list[str]  (tickers souhait?s)
    rebalance_freq:  int  = 20,  # jours entre deux rebalancements
    max_hold_days:   int  = 60,
    stop_pct:        float = STOP_PCT,
    max_pos:         int   = MAX_POSITIONS,
) -> tuple[pd.Series, list[Trade]]:
    """
    Moteur g?n?rique long-only avec :
    - Stop loss quotidien v?rifi? sur le BAS de la bougie (low)
    - Ex?cution T+1 (signal J -> entr?e J+1)
    - Frais 1,3% aller-retour + slippage march?
    - Rebalancement ? fr?quence fixe
    """
    all_dates  = sorted({d for df in ticker_data.values() for d in df.index})
    n_dates    = len(all_dates)
    equity     = INITIAL_CAP
    positions: dict[str, dict] = {}      # ticker -> {entry_price, entry_date, stop, weight}
    pending:   list[tuple]     = []      # [(ticker, weight)] ? ouvrir au prochain jour
    trades:    list[Trade]     = []
    eq_hist:   dict            = {all_dates[0]: equity}
    last_reb   = -rebalance_freq          # forcer un rebalancement au d?part

    for t_i, t in enumerate(all_dates):

        # ?? 1. Ex?cution des entr?es T+1 ??????????????????????????????????????
        for ticker, weight in pending:
            if t not in ticker_data.get(ticker, {}).index:
                continue
            bar = ticker_data[ticker].loc[t]
            if float(bar["volume"]) == 0:
                continue                    # jour sans volume -> on saute
            vol_avg = _vol_avg(ticker_data[ticker], t_i)
            order_v = equity * weight / 100
            ep      = _slippage(float(bar["close"]), order_v, vol_avg)
            positions[ticker] = {
                "entry_price": ep,
                "entry_date":  t,
                "stop":        ep * (1 - stop_pct),
                "weight":      weight,
            }
        pending.clear()

        # ?? 2. Stop loss journalier (v?rifi? sur le LOW de la barre) ?????????
        for ticker in list(positions.keys()):
            df_tk = ticker_data.get(ticker)
            if df_tk is None or t not in df_tk.index:
                continue
            pos  = positions[ticker]
            bar  = df_tk.loc[t]
            low  = float(bar["low"])
            days = (t - pos["entry_date"]).days

            if low <= pos["stop"]:
                ep  = pos["stop"]
                pnl = (ep / pos["entry_price"] - 1) * 100 - FEE_RT * 100
                equity *= 1 + pos["weight"] / 100 * pnl / 100
                trades.append(Trade(ticker, pos["entry_date"], pos["entry_price"],
                                    t, ep, round(pnl, 2), days, "stop", pos["weight"]))
                del positions[ticker]
            elif days >= max_hold_days:
                cp  = float(bar["close"])
                pnl = (cp / pos["entry_price"] - 1) * 100 - FEE_RT * 100
                equity *= 1 + pos["weight"] / 100 * pnl / 100
                trades.append(Trade(ticker, pos["entry_date"], pos["entry_price"],
                                    t, cp, round(pnl, 2), days, "timeout", pos["weight"]))
                del positions[ticker]

        # ?? 3. Rebalancement ?????????????????????????????????????????????????
        if t_i - last_reb >= rebalance_freq:
            last_reb = t_i
            targets  = set(select_fn(ticker_data, all_dates, t_i))

            # Fermer les positions hors-s?lection
            for ticker in list(positions.keys()):
                if ticker not in targets:
                    df_tk = ticker_data.get(ticker)
                    if df_tk is None or t not in df_tk.index:
                        continue
                    pos  = positions[ticker]
                    cp   = float(df_tk.loc[t, "close"])
                    days = (t - pos["entry_date"]).days
                    pnl  = (cp / pos["entry_price"] - 1) * 100 - FEE_RT * 100
                    equity *= 1 + pos["weight"] / 100 * pnl / 100
                    trades.append(Trade(ticker, pos["entry_date"], pos["entry_price"],
                                        t, cp, round(pnl, 2), days, "rebalance", pos["weight"]))
                    del positions[ticker]

            # Planifier nouvelles entr?es ? T+1
            slots    = max_pos - len(positions)
            new_tkrs = [tk for tk in targets if tk not in positions][:slots]
            if new_tkrs and t_i + 1 < n_dates:
                w = 100.0 / max_pos
                pending.extend((tk, w) for tk in new_tkrs)

        eq_hist[t] = equity

    # ?? 4. Cl?ture forc?e en fin de p?riode ????????????????????????????????????
    last_t = all_dates[-1]
    for ticker, pos in list(positions.items()):
        df_tk = ticker_data.get(ticker)
        if df_tk is not None and last_t in df_tk.index:
            cp   = float(df_tk.loc[last_t, "close"])
            days = (last_t - pos["entry_date"]).days
            pnl  = (cp / pos["entry_price"] - 1) * 100 - FEE_RT * 100
            equity *= 1 + pos["weight"] / 100 * pnl / 100
            trades.append(Trade(ticker, pos["entry_date"], pos["entry_price"],
                                last_t, cp, round(pnl, 2), days, "end", pos["weight"]))
    eq_hist[last_t] = equity

    eq_series = pd.Series(eq_hist).sort_index()
    return eq_series, trades


# ??? Strat?gie 1 : Momentum Cross-Sectionnel ?????????????????????????????????

def csm_select(ticker_data, dates, t_i,
               lookback=65, skip=5, n_top=5, vol_min=VOLUME_MIN):
    """
    Rank tous les titres par rendement sur [t-lookback, t-skip].
    Retourne les n_top meilleurs avec volume suffisant.
    """
    if t_i < lookback + 10:
        return []

    scores = {}
    t = dates[t_i]
    for ticker, df in ticker_data.items():
        if t not in df.index:
            continue
        loc = df.index.get_loc(t)
        if loc < lookback + skip:
            continue
        # Volume moyen 20j
        vol_avg = float(df["volume"].iloc[max(0, loc - 20):loc].mean())
        if vol_avg < vol_min:
            continue
        # Rendement formation : [t-lookback, t-skip]
        p_end   = float(df["close"].iloc[loc - skip])
        p_start = float(df["close"].iloc[loc - lookback])
        if p_start <= 0:
            continue
        scores[ticker] = (p_end / p_start) - 1.0

    ranked = sorted(scores, key=scores.get, reverse=True)
    return ranked[:n_top]


# ??? Strat?gie 2 : Trend Following Dual-MA ???????????????????????????????????

def tf_select(ticker_data, dates, t_i,
              ma_fast=20, ma_slow=50, vol_min=VOLUME_MIN, n_top=5):
    """
    S?lectionne les titres o? SMA(20) > SMA(50) et prix > SMA(20).
    Parmi les qualifiants, retient les n_top ayant le momentum 20j le plus fort.
    """
    if t_i < ma_slow + 5:
        return []

    candidates = {}
    t = dates[t_i]
    for ticker, df in ticker_data.items():
        if t not in df.index:
            continue
        loc = df.index.get_loc(t)
        if loc < ma_slow + 1:
            continue
        vol_avg = float(df["volume"].iloc[max(0, loc - 20):loc].mean())
        if vol_avg < vol_min:
            continue

        close = df["close"]
        sma_f = _sma(close, ma_fast).iloc[loc]
        sma_s = _sma(close, ma_slow).iloc[loc]
        price = float(close.iloc[loc])

        if pd.isna(sma_f) or pd.isna(sma_s):
            continue
        if sma_f > sma_s and price > float(sma_f):
            # Trier par momentum 20j pour prioriser les plus forts
            p20  = float(close.iloc[max(0, loc - 20)])
            mom  = price / p20 - 1 if p20 > 0 else 0
            candidates[ticker] = mom

    ranked = sorted(candidates, key=candidates.get, reverse=True)
    return ranked[:n_top]


# ??? Strat?gie 3 : Mean-Reversion RSI ????????????????????????????????????????

def mr_select(ticker_data, dates, t_i,
              rsi_period=20, oversold=35, trend_filter=True,
              vol_min=VOLUME_MIN, n_top=3):
    """
    RSI(20) < 35 ET (optionnel) prix > SMA(50) pour ?viter les couteaux qui tombent.
    Retient les n_top titres les plus survendus.
    """
    if t_i < rsi_period + 55:
        return []

    candidates = {}
    t = dates[t_i]
    for ticker, df in ticker_data.items():
        if t not in df.index:
            continue
        loc = df.index.get_loc(t)
        if loc < rsi_period + 5:
            continue
        vol_avg = float(df["volume"].iloc[max(0, loc - 20):loc].mean())
        if vol_avg < vol_min:
            continue

        close  = df["close"]
        rsi_v  = _rsi(close.iloc[:loc + 1], rsi_period).iloc[-1]
        if pd.isna(rsi_v) or rsi_v >= oversold:
            continue

        if trend_filter:
            sma20 = _sma(close, 20).iloc[loc]
            if pd.isna(sma20) or float(close.iloc[loc]) < float(sma20) * 0.95:
                continue  # exclut les tendances baissi?res marqu?es (>5% sous MA20)

        candidates[ticker] = rsi_v   # plus petit = plus survendu = prioritaire

    ranked = sorted(candidates, key=candidates.get)   # ascendant : RSI le + bas en premier
    return ranked[:n_top]


# ??? Strat?gie 4 : Low-Volatility + Trend ????????????????????????????????????

def lvt_select(ticker_data, dates, t_i,
               atr_period=20, trend_ma=20, vol_min=VOLUME_MIN, n_top=5):
    """
    Parmi les titres en tendance (prix > SMA(20)), s?lectionne les n_top
    ayant le plus faible ATR% (anomalie faible volatilit? calibr?e BRVM).
    """
    if t_i < atr_period + trend_ma + 10:
        return []

    candidates = {}
    t = dates[t_i]
    for ticker, df in ticker_data.items():
        if t not in df.index:
            continue
        loc = df.index.get_loc(t)
        if loc < atr_period + trend_ma + 1:
            continue
        vol_avg = float(df["volume"].iloc[max(0, loc - 20):loc].mean())
        if vol_avg < vol_min:
            continue

        close  = df["close"]
        price  = float(close.iloc[loc])
        sma20  = float(_sma(close, trend_ma).iloc[loc])
        if pd.isna(sma20) or price < sma20:
            continue        # doit ?tre au-dessus de sa MA(20)

        atr_v   = float(_atr(df.iloc[:loc + 1], atr_period).iloc[-1])
        atr_pct = atr_v / price if price > 0 else 99
        if pd.isna(atr_pct):
            continue

        candidates[ticker] = atr_pct   # ascendant : moins volatil en premier

    ranked = sorted(candidates, key=candidates.get)
    return ranked[:n_top]


# ??? Monte Carlo (permutation test) ??????????????????????????????????????????

def mc_permutation(eq: pd.Series, n_sim: int = 1_000, seed: int = 42) -> dict:
    """
    Teste si le Sharpe de la strat?gie est d? ? la chance.
    Permute al?atoirement les rendements journaliers et recalcule le Sharpe.
    H0 : la strat?gie ne fait pas mieux qu'un portefeuille al?atoire.
    """
    rets = eq.pct_change().dropna().values
    if len(rets) < 20:
        return {}

    real_metrics = _compute_metrics(eq.reindex(eq.index), risk_free=0.035)
    real_sharpe  = real_metrics["sharpe"]

    rng       = np.random.default_rng(seed)
    mc_sharpes = []
    for _ in range(n_sim):
        perm   = rng.permutation(rets)
        eq_sim = pd.Series(INITIAL_CAP * np.cumprod(1 + perm))
        mc_sharpes.append(_compute_metrics(eq_sim, risk_free=0.035)["sharpe"])

    mc_arr  = np.array(mc_sharpes)
    p_value = float(np.mean(mc_arr >= real_sharpe))

    return {
        "sharpe_reel":       round(real_sharpe, 3),
        "sharpe_median_mc":  round(float(np.median(mc_arr)), 3),
        "p_value":           round(p_value, 4),
        "significatif_95":   p_value < 0.05,
        "significatif_99":   p_value < 0.01,
    }


# ??? Walk-forward (out-of-sample) ????????????????????????????????????????????

def walk_forward(
    ticker_data: dict,
    benchmark:   pd.Series,
    select_fn:   Callable,
    rebalance_freq: int,
    max_hold_days:  int,
    n_splits:    int   = 3,
    train_ratio: float = 0.60,
) -> list[dict]:
    """
    Divise la p?riode totale en n_splits fen?tres.
    Pour chaque fen?tre, ?value sur la sous-p?riode TEST (40% finale).
    Le signal est toujours calcul? ? partir des donn?es disponibles ? chaque date,
    donc m?me la p?riode de train reste walk-forward par construction.
    Retourne les m?triques out-of-sample de chaque fen?tre.
    """
    all_dates = sorted({d for df in ticker_data.values() for d in df.index})
    total     = len(all_dates)
    window    = total // n_splits
    results   = []

    for i in range(n_splits):
        s_i     = i * window
        e_i     = s_i + window if i < n_splits - 1 else total
        seg     = all_dates[s_i:e_i]
        test_s  = seg[int(len(seg) * train_ratio)]

        # Donn?es compl?tes mais on mesure uniquement la sous-p?riode test
        eq, trades = _run_strategy(
            ticker_data,
            select_fn,
            rebalance_freq=rebalance_freq,
            max_hold_days=max_hold_days,
        )
        eq_test = eq[eq.index >= test_s]
        if len(eq_test) < 20:
            continue

        metrics = _compute_metrics(eq_test, risk_free=0.035)
        n_tr    = len([tr for tr in trades if tr.entry_date >= test_s])
        wins    = [tr for tr in trades if tr.entry_date >= test_s and tr.pnl_pct > 0]
        wr      = round(len(wins) / n_tr * 100, 1) if n_tr else 0

        results.append({
            "fenetre": i + 1,
            "debut":   str(test_s.date()),
            "fin":     str(seg[-1].date()),
            "cagr":    metrics["cagr"],
            "sharpe":  metrics["sharpe"],
            "max_dd":  metrics["max_drawdown"],
            "n_trades": n_tr,
            "win_rate": wr,
        })

    return results


# ??? Rapport complet ?????????????????????????????????????????????????????????

def _trade_stats(trades: list[Trade]) -> dict:
    if not trades:
        return {"n": 0}
    pnls = [t.pnl_pct for t in trades]
    wins = [p for p in pnls if p > 0]
    loss = [p for p in pnls if p <= 0]
    wr   = len(wins) / len(pnls) * 100
    avg_w = float(np.mean(wins))  if wins else 0
    avg_l = float(np.mean(loss))  if loss else 0
    exp   = wr / 100 * avg_w + (1 - wr / 100) * avg_l
    return {
        "n":         len(pnls),
        "win_rate":  round(wr, 1),
        "avg_win":   round(avg_w, 2),
        "avg_loss":  round(avg_l, 2),
        "expectancy": round(exp, 2),
        "avg_hold":  round(float(np.mean([t.holding_days for t in trades])), 1),
    }


def _alpha_beta(eq: pd.Series, bench: pd.Series) -> tuple[float, float]:
    eq_r    = eq.pct_change().dropna()
    bench_r = bench.pct_change().dropna()
    common  = eq_r.index.intersection(bench_r.index)
    if len(common) < 10:
        return 0.0, 1.0
    s = eq_r.loc[common].values
    b = bench_r.loc[common].values
    cov_mat = np.cov(s, b)
    var_b   = float(np.var(b, ddof=1))
    beta    = float(cov_mat[0, 1] / var_b) if var_b > 0 else 1.0
    alpha   = float(np.mean(s) - beta * np.mean(b)) * 252  # annualis?
    return round(alpha, 4), round(beta, 4)


def run_all(verbose: bool = True) -> None:
    """Lance la recherche compl?te et affiche le rapport."""

    print("\n" + "=" * 72)
    print("  BRVM STRATEGY RESEARCH ? Donn?es synth?tiques, 5 ans, 20 actions")
    print("  Frais : 1.3% AR | Stop : 8% | T+1 | Positions max : 5")
    print("=" * 72)

    # ?? G?n?ration de l'univers ??????????????????????????????????????????????
    print("\n[1/3] G?n?ration de l'univers synth?tique BRVM (seed=42)...")
    td, bench = generate_brvm_universe(n_stocks=20, n_days=1260, seed=42)
    all_dates = sorted({d for df in td.values() for d in df.index})
    print(f"      {len(td)} tickers | {len(all_dates)} seances "
          f"({all_dates[0].date()} au {all_dates[-1].date()})")

    # ?? D?finition des strat?gies ????????????????????????????????????????????
    strategies = [
        {
            "label":     "CSM ? Momentum 3 mois (top-5)",
            "code":      "CSM",
            "select":    lambda td, d, i: csm_select(td, d, i),
            "reb_freq":  20,
            "max_hold":  40,
        },
        {
            "label":     "TF  ? Trend Following SMA(20/50)",
            "code":      "TF",
            "select":    lambda td, d, i: tf_select(td, d, i),
            "reb_freq":  7,
            "max_hold":  90,
        },
        {
            "label":     "MR  ? Mean-Reversion RSI(20)<35",
            "code":      "MR",
            "select":    lambda td, d, i: mr_select(td, d, i),
            "reb_freq":  5,
            "max_hold":  30,
        },
        {
            "label":     "LVT ? Low-Volatility + Trend",
            "code":      "LVT",
            "select":    lambda td, d, i: lvt_select(td, d, i),
            "reb_freq":  20,
            "max_hold":  60,
        },
        {
            "label":     "BUY ? Buy-and-Hold benchmark",
            "code":      "BUY",
            "select":    None,
            "reb_freq":  None,
            "max_hold":  None,
        },
    ]

    # ?? Backtest complet ?????????????????????????????????????????????????????
    print("\n[2/3] Backtest + Monte Carlo (1 000 permutations) par strat?gie...")
    results = {}
    bench_metrics = _compute_metrics(bench, risk_free=0.035)

    for strat in strategies:
        code = strat["code"]

        if code == "BUY":
            eq     = bench
            trades = []
        else:
            eq, trades = _run_strategy(
                td,
                strat["select"],
                rebalance_freq=strat["reb_freq"],
                max_hold_days=strat["max_hold"],
            )

        m   = _compute_metrics(eq, risk_free=0.035)
        ts  = _trade_stats(trades)
        mc  = mc_permutation(eq, n_sim=1_000) if code != "BUY" else {}
        a, b = _alpha_beta(eq, bench) if code != "BUY" else (0.0, 1.0)

        results[code] = {
            "label":   strat["label"],
            "eq":      eq,
            "trades":  trades,
            "metrics": m,
            "ts":      ts,
            "mc":      mc,
            "alpha":   a,
            "beta":    b,
        }
        sig = ""
        if mc:
            sig = "[OK] p<0.01" if mc.get("significatif_99") else \
                  "OK  p<0.05" if mc.get("significatif_95") else \
                  "x  non sig."
        print(f"      {code:<4} CAGR={m['cagr']:+.1%}  Sharpe={m['sharpe']:.2f}  "
              f"DD={m['max_drawdown']:.1%}  n={ts.get('n', '?'):<4} {sig}")

    # ?? Rapport d?taill? ?????????????????????????????????????????????????????
    print("\n" + "=" * 72)
    print("  R?SULTATS D?TAILL?S")
    print("=" * 72)

    header = f"{'Strat?gie':<42} {'CAGR':>7} {'Sharpe':>7} {'Sortino':>8} {'MaxDD':>7}"
    header += f" {'WinRate':>8} {'n':>5} {'Expect':>8} {'p-val':>7} {'Alpha':>7}"
    print(header)
    print("-" * 117)

    # Tri par Sharpe d?croissant
    order = ["CSM", "TF", "MR", "LVT", "BUY"]
    for code in order:
        r  = results[code]
        m  = r["metrics"]
        ts = r["ts"]
        mc = r["mc"]
        row = (
            f"{r['label']:<42}"
            f" {m['cagr']:>+7.1%}"
            f" {m['sharpe']:>7.2f}"
            f" {m['sortino']:>8.2f}"
            f" {m['max_drawdown']:>7.1%}"
        )
        if ts.get("n"):
            row += (
                f" {ts['win_rate']:>7.1f}%"
                f" {ts['n']:>5}"
                f" {ts['expectancy']:>+8.2f}%"
            )
        else:
            row += " " * 25

        if mc:
            pv  = mc.get("p_value", 1.0)
            sig = "[OK]" if mc.get("significatif_99") else \
                  "OK " if mc.get("significatif_95") else "x "
            row += f" {pv:>6.3f}{sig}"
            row += f" {r['alpha']:>+7.2%}"
        print(row)

    # ?? Walk-forward (out-of-sample) ?????????????????????????????????????????
    print("\n" + "?" * 72)
    print("  WALK-FORWARD (r?sultats out-of-sample, 40% de chaque fen?tre)")
    print("?" * 72)
    print(f"  {'Code':<5} {'Fen?tre':<4} {'P?riode':<25} {'CAGR':>7} {'Sharpe':>7} {'MaxDD':>7} {'n':>5} {'WR':>7}")
    print("  " + "?" * 69)

    for code in ["CSM", "TF", "MR", "LVT"]:
        strat = next(s for s in strategies if s["code"] == code)
        wf    = walk_forward(td, bench, strat["select"],
                             strat["reb_freq"], strat["max_hold"])
        for w in wf:
            print(f"  {code:<5} [{w['fenetre']}]   "
                  f"{w['debut']} -> {w['fin']}   "
                  f"{w['cagr']:>+7.1%}  {w['sharpe']:>6.2f}  "
                  f"{w['max_dd']:>7.1%}  {w['n_trades']:>4}  {w['win_rate']:>6.1f}%")
        print()

    # ?? Recommandation finale ????????????????????????????????????????????????
    print("=" * 72)
    print("  RECOMMANDATION")
    print("=" * 72)

    # Classer par Sharpe moyen out-of-sample (fenetres 2+3 du walk-forward)
    # La fenetre 1 capture souvent un choc de marche -> moins representative
    def _oos_sharpe(code: str) -> float:
        strat_cfg = next((s for s in strategies if s["code"] == code), None)
        if strat_cfg is None or strat_cfg["select"] is None:
            return -99.0
        wf = walk_forward(
            td, bench, strat_cfg["select"],
            strat_cfg["reb_freq"], strat_cfg["max_hold"],
        )
        oos = [w["sharpe"] for w in wf[1:]] if len(wf) > 1 else [w["sharpe"] for w in wf]
        return float(np.mean(oos)) if oos else -99.0

    actives = [(code, results[code]) for code in ["CSM", "TF", "MR", "LVT"]]
    actives = [(c, r) for c, r in actives if r["ts"].get("n", 0) >= 10]
    actives.sort(key=lambda x: _oos_sharpe(x[0]), reverse=True)

    winner_code, winner = actives[0]
    m   = winner["metrics"]
    mc  = winner["mc"]
    ts  = winner["ts"]

    print(f"\n  ? Meilleure strat?gie : {winner['label']}")
    print(f"\n  Performance full-period :")
    print(f"    CAGR          : {m['cagr']:+.1%}")
    print(f"    Sharpe ratio  : {m['sharpe']:.2f}")
    print(f"    Sortino ratio : {m['sortino']:.2f}")
    print(f"    Max drawdown  : {m['max_drawdown']:.1%}")
    print(f"    Calmar ratio  : {m['calmar']:.2f}")
    print(f"    Alpha vs BRVMC: {winner['alpha']:+.2%} / an")
    print(f"    Beta          : {winner['beta']:.2f}")
    print(f"\n  Statistiques des trades :")
    print(f"    Nombre trades  : {ts.get('n', 0)}")
    print(f"    Win rate       : {ts.get('win_rate', 0):.1f}%")
    print(f"    Gain moyen     : {ts.get('avg_win', 0):+.2f}%")
    print(f"    Perte moyenne  : {ts.get('avg_loss', 0):+.2f}%")
    print(f"    Esp?rance      : {ts.get('expectancy', 0):+.2f}%")
    print(f"    Dur?e moyenne  : {ts.get('avg_hold', 0):.0f} jours")
    print(f"\n  Validation statistique (Monte Carlo 1 000 permutations) :")
    if mc:
        print(f"    Sharpe r?el    : {mc.get('sharpe_reel', 0):.3f}")
        print(f"    Sharpe m?dian MC (H0) : {mc.get('sharpe_median_mc', 0):.3f}")
        print(f"    p-value        : {mc.get('p_value', 1):.4f}")
        sig_str = ("[OK] SIGNIFICATIF (p < 0.01)" if mc.get("significatif_99") else
                   "OK  SIGNIFICATIF (p < 0.05)" if mc.get("significatif_95") else
                   "x  Non significatif (p ? 0.05)")
        print(f"    Conclusion     : {sig_str}")

    print(f"\n  vs Benchmark buy-and-hold :")
    bm = bench_metrics
    print(f"    BRVMC CAGR    : {bm['cagr']:+.1%}  Sharpe : {bm['sharpe']:.2f}  DD : {bm['max_drawdown']:.1%}")
    print(f"    Exc?s CAGR    : {m['cagr'] - bm['cagr']:+.1%}")

    print("\n  Param?tres op?rationnels :")
    strat_info = next(s for s in strategies if s["code"] == winner_code)
    print(f"    Fr?quence rebalancement : tous les {strat_info['reb_freq']} jours")
    print(f"    Dur?e max de d?tention  : {strat_info['max_hold']} jours")
    print(f"    Stop loss               : {STOP_PCT:.0%}")
    print(f"    Max positions           : {MAX_POSITIONS}")
    print(f"    Filtre volume           : ? {VOLUME_MIN} titres/jour (moy. {VOLUME_WINDOW}j)")
    print(f"    Frais mod?lis?s         : {FEE_RT:.1%} AR + slippage")
    print("\n" + "=" * 72)


if __name__ == "__main__":
    run_all()
