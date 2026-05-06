"""
test_sr_advanced.py - 4 nouvelles hypothèses S/R + frais corrects (asymétriques).

Baseline = VWAP actuel (fenêtres adaptées par horizon, frais asymétriques).

Hypothèses testées :
  H1. VWAP stop + Pivot résistance comme target
      → Stop VWAP prouvé efficace, target ancré sur vraie résistance graphique
  H2. Zones pivot clusterisées (±1 ATR)
      → Grouper les pivots proches en zones, plus robuste que points isolés
  H3. Donchian channels adaptés horizon
      → Stop = plus bas N barres, Target = plus haut N barres
      → CT:10j  MT:20j  LT:40j
  H4. Pivots élargis à l'ATR
      → Stop = swing low - 0.5 ATR (évite les whipsaws)
      → Target = swing high + 0.3 ATR (capture le breakout)

Frais : asymétriques (entrée sur valeur d'achat, sortie sur valeur de vente).
"""
import logging, warnings
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

import pandas as pd
import numpy as np
from datetime import date, timedelta
from typing import Optional

from backtest import (BacktestEngine, ALL_TICKERS, INITIAL_CAP, WARMUP_BARS,
    REVIEW_INTERVAL_DAYS, MAX_HOLDING_DAYS, MAX_ATR_PCT, MIN_PRICE,
    BacktestResult, Position)
from config import DEFAULT_HORIZON, HORIZON_PROFILES
from analysis import compute_position_size, _vwap_risk_levels
from indicators import compute_indicators
from scoring import compute_score
from scraper import get_ohlcv

# ── Données ────────────────────────────────────────────────────────────────────
print("Chargement données...")
data_all = {}
for t in ALL_TICKERS:
    try: data_all[t] = get_ohlcv(t, days=730)
    except: pass

df_brvmc = None
try: df_brvmc = get_ohlcv("BRVMC", days=730)
except: pass
print(f"  {len(data_all)} tickers\n")

HORIZON   = "Moyen terme"
FEE_ENTRY = 1.43   # % sur valeur d'entrée (Phoenix ~2.86% TTC / 2)
FEE_EXIT  = 1.43   # % sur valeur de sortie
HP        = HORIZON_PROFILES[HORIZON]

BASE_KWARGS = dict(
    initial_capital=INITIAL_CAP, horizon=HORIZON,
    warmup_bars=WARMUP_BARS,
    review_interval_days=HP["review_interval_days"],
    max_holding_days=HP["max_holding_days"],
    max_atr_pct=MAX_ATR_PCT, min_price=MIN_PRICE,
    min_atr_pct=2.0, df_index=df_brvmc,
    fee_pct=0.0,   # frais gérés manuellement dans le moteur ci-dessous
)


# ── Helpers S/R ────────────────────────────────────────────────────────────────

def swing_levels(df: pd.DataFrame, order: int = 5):
    h, l = df["high"].values, df["low"].values
    highs, lows = [], []
    for i in range(order, len(df) - order):
        if h[i] == max(h[i-order:i+order+1]): highs.append(h[i])
        if l[i] == min(l[i-order:i+order+1]): lows.append(l[i])
    return highs, lows


def pivot_target(highs, prix, max_pct=25.0):
    c = [p for p in highs if p > prix and (p - prix)/prix*100 <= max_pct]
    return min(c) if c else None


def pivot_stop(lows, prix, max_pct=12.0):
    c = [p for p in lows if p < prix and (prix - p)/prix*100 <= max_pct]
    return max(c) if c else None


def cluster_zones(levels, atr):
    """Regroupe les niveaux proches (±0.5 ATR) en zones [min, max]."""
    if not levels:
        return []
    sorted_lvl = sorted(levels)
    zones = [[sorted_lvl[0], sorted_lvl[0]]]
    for v in sorted_lvl[1:]:
        if v - zones[-1][1] <= 0.5 * atr:
            zones[-1][1] = v
        else:
            zones.append([v, v])
    return zones


def nearest_support_zone(zones, prix):
    """Zone support la plus proche sous le prix."""
    below = [z for z in zones if z[1] < prix]
    return below[-1] if below else None


def nearest_resist_zone(zones, prix):
    """Zone résistance la plus proche au-dessus du prix."""
    above = [z for z in zones if z[0] > prix]
    return above[0] if above else None


# ── Moteur avec frais asymétriques ────────────────────────────────────────────

class BacktestEngineAsymFee(BacktestEngine):
    """Frais séparés entrée/sortie : fee appliqué sur valeur réelle de chaque côté."""

    def __init__(self, *args, fee_entry_pct=0.0, fee_exit_pct=0.0,
                 sr_method="vwap_baseline", **kwargs):
        super().__init__(*args, **kwargs)
        self.fee_entry_pct = fee_entry_pct
        self.fee_exit_pct  = fee_exit_pct
        self.sr_method     = sr_method

    def _close(self, ticker, exit_price, exit_date, reason):
        """Override : frais asymétriques sur valeur d'entrée et de sortie."""
        pos = self._open.pop(ticker)
        pos.exit_date    = exit_date
        pos.exit_price   = round(exit_price, 2)
        pos.exit_reason  = reason
        pos.holding_days = (exit_date - pos.entry_date).days

        # PnL brut
        raw_pnl = (exit_price - pos.entry_price) / pos.entry_price * 100
        # Frais réels : entrée sur prix d'achat, sortie sur prix de vente
        fee_entry_drag = self.fee_entry_pct                         # % du capital investi
        fee_exit_drag  = self.fee_exit_pct * (exit_price / pos.entry_price)  # % ajusté par le ratio de prix
        net_pnl = raw_pnl - fee_entry_drag - fee_exit_drag

        pos.pnl_pct = round(net_pnl, 2)

        risk_pct = abs(pos.entry_price - pos.stop_loss) / pos.entry_price * 100 if pos.stop_loss else 1.0
        pos.r_realise            = round(pos.pnl_pct / risk_pct, 2) if risk_pct > 0 else None
        pos.capital_gain_pct     = round(pos.position_pct / 100 * pos.pnl_pct, 2)
        pos.capital_investi_fcfa = round(pos.equity_at_entry * pos.position_pct / 100, 0)
        pos.gain_fcfa            = round(pos.capital_investi_fcfa * pos.pnl_pct / 100, 0)
        self._equity            *= 1 + pos.capital_gain_pct / 100
        self._closed.append(pos)

    def _sr_levels(self, score, ind, df_slice):
        """Calcule stop/target selon la méthode choisie."""
        prix = ind.cours_actuel
        atr  = ind.atr or 0

        vp = {
            "Court terme": {"window": 10, "k_stop": 1.0, "k_target": 1.5, "don_n": 10},
            "Moyen terme": {"window": 20, "k_stop": 1.5, "k_target": 2.5, "don_n": 20},
            "Long terme":  {"window": 40, "k_stop": 2.0, "k_target": 3.5, "don_n": 40},
        }.get(self.horizon, {"window": 20, "k_stop": 1.5, "k_target": 2.5, "don_n": 20})

        # ── H0 : VWAP baseline ───────────────────────────────────────────────
        if self.sr_method == "vwap_baseline":
            sl, tp = _vwap_risk_levels(prix, df_slice, atr, score.signal,
                                       vwap_window=vp["window"],
                                       k_stop=vp["k_stop"], k_target=vp["k_target"])
            if sl and tp: return sl, tp

        # ── H1 : VWAP stop + Pivot target ───────────────────────────────────
        elif self.sr_method == "vwap_stop_pivot_target":
            sl, _ = _vwap_risk_levels(prix, df_slice, atr, score.signal,
                                      vwap_window=vp["window"], k_stop=vp["k_stop"],
                                      k_target=vp["k_target"])
            swh, _ = swing_levels(df_slice, order=5)
            tp = pivot_target(swh, prix)
            if sl and tp and tp > prix:
                dist_stop = prix - sl
                dist_tgt  = tp - prix
                if dist_stop > 0 and dist_tgt / dist_stop < 1.5:
                    tp = prix + 1.5 * dist_stop
                return round(max(0, sl), 2), round(max(0, tp), 2)

        # ── H2 : Zones pivot clusterisées ───────────────────────────────────
        elif self.sr_method == "pivot_zones":
            if atr <= 0:
                return None, None
            swh, swl = swing_levels(df_slice, order=5)
            sup_zones = cluster_zones(swl, atr)
            res_zones = cluster_zones(swh, atr)
            sup_zone  = nearest_support_zone(sup_zones, prix)
            res_zone  = nearest_resist_zone(res_zones, prix)
            if sup_zone and res_zone:
                sl = sup_zone[0] - 0.1 * atr   # légèrement sous la zone
                tp = res_zone[1] + 0.1 * atr   # légèrement au-dessus
                if sl < prix < tp:
                    dist_stop = prix - sl
                    dist_tgt  = tp - prix
                    if dist_stop > 0 and dist_tgt / dist_stop < 1.5:
                        tp = prix + 1.5 * dist_stop
                    return round(max(0, sl), 2), round(max(0, tp), 2)

        # ── H3 : Donchian channels ───────────────────────────────────────────
        elif self.sr_method == "donchian":
            n = vp["don_n"]
            if len(df_slice) >= n:
                sl = float(df_slice["low"].iloc[-n:].min())
                tp = float(df_slice["high"].iloc[-n:].max())
                if sl < prix < tp:
                    dist_stop = prix - sl
                    dist_tgt  = tp - prix
                    if dist_stop > 0 and dist_tgt / dist_stop < 1.5:
                        tp = prix + 1.5 * dist_stop
                    return round(max(0, sl), 2), round(max(0, tp), 2)

        # ── H4 : Pivots élargis ATR ──────────────────────────────────────────
        elif self.sr_method == "atr_pivot":
            if atr <= 0:
                return None, None
            swh, swl = swing_levels(df_slice, order=5)
            sl_raw  = pivot_stop(swl, prix)
            tp_raw  = pivot_target(swh, prix)
            if sl_raw and tp_raw:
                sl = sl_raw  - 0.5 * atr   # donne de l'air sous le pivot
                tp = tp_raw  + 0.3 * atr   # capture le breakout au-dessus
                if sl < prix < tp:
                    dist_stop = prix - sl
                    dist_tgt  = tp - prix
                    if dist_stop > 0 and dist_tgt / dist_stop < 1.5:
                        tp = prix + 1.5 * dist_stop
                    return round(max(0, sl), 2), round(max(0, tp), 2)

        # Fallback ATR
        k1, k2 = (2.5, 5.0) if score.confiance == "forte" else \
                 (2.0, 4.0) if score.confiance == "modérée" else (1.5, 3.0)
        if atr > 0:
            return round(prix - k1 * atr, 2), round(prix + k2 * atr, 2)
        return None, None

    def run(self, ticker_data: dict) -> BacktestResult:
        if not ticker_data:
            raise ValueError("vide")

        all_dates = sorted({
            idx.date() if hasattr(idx, "date") else idx
            for df in ticker_data.values() for idx in df.index
        })
        self._equity_history.append({"date": all_dates[0], "equity": self._equity})

        for current_date in all_dates:
            ts = pd.Timestamp(current_date)
            for ticker, df_full in ticker_data.items():
                df_slice = df_full[df_full.index <= ts]
                if ts not in df_full.index: continue
                if len(df_slice) < self.warmup_bars: continue

                cb = df_full.loc[ts]
                cp = float(cb["close"])
                ch = float(cb.get("high", cp))
                cl = float(cb.get("low",  cp))

                if ticker in self._open:
                    days_held = (current_date - self._open[ticker].entry_date).days
                    if days_held >= self.max_holding_days:
                        self._close(ticker, cp, current_date, "timeout_3m")
                    else:
                        self._check_stop_target(ticker, cl, ch, current_date)

                next_rev = self._next_review.get(ticker)
                if next_rev is None or current_date >= next_rev:
                    self._next_review[ticker] = current_date + timedelta(days=self.review_interval_days)
                    if ticker not in self._open:
                        if not self._is_regime_ok(ts): continue
                        try:
                            ind   = compute_indicators(df_slice, ticker=ticker, horizon=self.horizon)
                            score = compute_score(ind)
                            score.stop_loss, score.take_profit = self._sr_levels(score, ind, df_slice)
                            score.position_size_pct = compute_position_size(score, ind)
                        except Exception:
                            continue
                        if ind.atr_pct is not None and ind.atr_pct < self.min_atr_pct: continue
                        if (score.signal == "ACHAT"
                                and score.confiance in self.confiance_filter
                                and score.stop_loss is not None
                                and score.take_profit is not None
                                and score.position_size_pct is not None
                                and ind.cours_actuel >= self.min_price
                                and (ind.atr_pct is None or ind.atr_pct <= self.max_atr_pct)
                                and self._deployed_pct + score.position_size_pct <= 100.0):
                            self._open_position(ticker, score, ind, current_date)

            self._equity_history.append({"date": current_date, "equity": self._equity})

        last_date = all_dates[-1]
        for ticker in list(self._open.keys()):
            ts_last = pd.Timestamp(last_date)
            if ticker in ticker_data and ts_last in ticker_data[ticker].index:
                lp = float(ticker_data[ticker].loc[ts_last, "close"])
                self._close(ticker, lp, last_date, "end_of_backtest")

        return self._build_result()


# ── Affichage ──────────────────────────────────────────────────────────────────

def row(label, r: BacktestResult, base: BacktestResult = None):
    s = r.summary
    if s.get("status") != "ok":
        print(f"  {label:<45}  AUCUN TRADE"); return
    df = r.trades
    rr  = df["r_realise"].mean() if "r_realise" in df.columns else 0
    st  = len(df[df["exit_reason"].isin(["stop","stop_extreme"])])
    tgt = len(df[df["exit_reason"] == "target"])
    tmo = len(df[df["exit_reason"].str.startswith("timeout", na=False)])
    delta = ""
    if base and base.summary.get("status") == "ok":
        bs  = base.summary
        delta = (f"  [dRet={s['total_return_pct']-bs['total_return_pct']:+.1f}%"
                 f"  dExp={s['expectancy_pct']-bs['expectancy_pct']:+.2f}%"
                 f"  dDD={s['max_drawdown_pct']-bs['max_drawdown_pct']:+.1f}%]")
    print(f"  {label:<45}  n={s['n_trades']:>3}  WR={s['win_rate_pct']:>5.1f}%  "
          f"Exp={s['expectancy_pct']:>+6.2f}%  Ret={s['total_return_pct']:>+7.1f}%  "
          f"DD={s['max_drawdown_pct']:>4.1f}%  RR={rr:>+5.2f}  "
          f"st={st}  tgt={tgt}  tmo={tmo}{delta}")


def detail(label, r: BacktestResult):
    df = r.trades
    print(f"\n  {label} :")
    for reason, grp in df.groupby("exit_reason"):
        wr  = (grp["pnl_pct"] > 0).mean() * 100
        avg = grp["pnl_pct"].mean()
        hd  = grp["holding_days"].mean()
        print(f"    {reason:<22}  n={len(grp):>3}  WR={wr:>5.1f}%  avg={avg:>+6.2f}%  {hd:.0f}j")


# ── Scénarios ──────────────────────────────────────────────────────────────────

SCENARIOS = [
    ("0. VWAP baseline (frais sym.)",          "vwap_baseline",          2.86, 2.86, True),
    ("0b. VWAP baseline (frais asym.)",         "vwap_baseline",          1.43, 1.43, False),
    ("H1. VWAP stop + Pivot target",            "vwap_stop_pivot_target", 1.43, 1.43, False),
    ("H2. Zones pivot clusterisées",            "pivot_zones",            1.43, 1.43, False),
    ("H3. Donchian channels",                   "donchian",               1.43, 1.43, False),
    ("H4. Pivots élargis ATR",                  "atr_pivot",              1.43, 1.43, False),
]

print(f"{'='*140}")
print(f"  {'Méthode':<45}  {'n':>4}  {'WR':>7}  {'Exp':>8}  {'Return':>9}  "
      f"{'DD':>5}  {'RR':>5}  {'st':>4}  {'tgt':>4}  {'tmo':>4}  Delta")
print(f"  {'-'*45}  {'-'*4}  {'-'*7}  {'-'*8}  {'-'*9}  {'-'*5}  {'-'*5}  {'-'*4}  {'-'*4}  {'-'*4}")

results = {}
r_base = None
for label, method, fee_e, fee_x, sym in SCENARIOS:
    print(f"  [{label}...]")
    r = BacktestEngineAsymFee(
        **BASE_KWARGS,
        fee_entry_pct=fee_e, fee_exit_pct=fee_x,
        sr_method=method,
    ).run(data_all)
    row(label, r, r_base)
    results[label] = r
    if r_base is None:
        r_base = r

print(f"{'='*140}")

# Détails des meilleurs
print()
for lbl in ["0b. VWAP baseline (frais asym.)", "H1. VWAP stop + Pivot target",
            "H2. Zones pivot clusterisées", "H3. Donchian channels", "H4. Pivots élargis ATR"]:
    detail(lbl, results[lbl])

# Distribution stop vs target vs timeout
print(f"\n  Distribution sorties (nb) :")
print(f"  {'Méthode':<45}  {'stop':>6}  {'target':>7}  {'timeout':>8}  {'end':>5}  {'WR_tgt%':>8}")
for lbl, r in results.items():
    if r.summary.get("status") != "ok": continue
    df = r.trades
    st  = len(df[df["exit_reason"].isin(["stop","stop_extreme"])])
    tgt = len(df[df["exit_reason"] == "target"])
    tmo = len(df[df["exit_reason"].str.startswith("timeout", na=False)])
    end = len(df[df["exit_reason"] == "end_of_backtest"])
    tgt_wr = (df[df["exit_reason"]=="target"]["pnl_pct"] > 0).mean()*100 if tgt > 0 else 0
    print(f"  {lbl:<45}  {st:>6}  {tgt:>7}  {tmo:>8}  {end:>5}  {tgt_wr:>7.0f}%")

print(f"\n{'='*140}")
