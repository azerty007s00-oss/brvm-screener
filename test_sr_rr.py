"""
test_sr_rr.py - Test de 3 méthodes S/R pour améliorer le placement stop/target.

Méthodes testées :
  SR1. Pivots price action  : stop = dernier swing low, target = dernier swing high
  SR2. Fibonacci            : stop = retracement 61.8%, target = extension 161.8%
  SR3. Volume profile       : stop = VWAP - k*std, target = VWAP + k*std

Baseline = moteur actuel (ATR-only, k1=2.0 / k2=4.0 moderee, MIN_ATR=2%).

Critères de succès :
  - Expectancy nette > baseline
  - WR > baseline OU R/R réalisé > baseline
  - Nombre de trades suffisant (>= 100)
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
    BacktestResult)
from config import DEFAULT_HORIZON
from analysis import compute_position_size
from indicators import compute_indicators
from scoring import compute_score
from scraper import get_ohlcv


# ── Données ────────────────────────────────────────────────────────────────────
print("Chargement données (730j)...")
data_all = {}
for t in ALL_TICKERS:
    try:
        data_all[t] = get_ohlcv(t, days=730)
    except Exception:
        pass

df_brvmc = None
try:
    df_brvmc = get_ohlcv("BRVMC", days=730)
except Exception:
    pass
print(f"  {len(data_all)} tickers  |  BRVMC: {'OK' if df_brvmc is not None else 'absent'}\n")

BASE_KWARGS = dict(
    initial_capital=INITIAL_CAP, horizon=DEFAULT_HORIZON,
    warmup_bars=WARMUP_BARS, review_interval_days=REVIEW_INTERVAL_DAYS,
    max_holding_days=MAX_HOLDING_DAYS, max_atr_pct=MAX_ATR_PCT,
    min_price=MIN_PRICE, fee_pct=2.0, df_index=df_brvmc,
    min_atr_pct=2.0,
)


# ── Helpers S/R ────────────────────────────────────────────────────────────────

def find_swing_levels(df: pd.DataFrame, order: int = 5) -> tuple[list, list]:
    """Swing highs et lows avec fenêtre order barres de chaque côté."""
    highs, lows = [], []
    h = df["high"].values
    l = df["low"].values
    for i in range(order, len(df) - order):
        if h[i] == max(h[i - order: i + order + 1]):
            highs.append((i, h[i]))
        if l[i] == min(l[i - order: i + order + 1]):
            lows.append((i, l[i]))
    return highs, lows


def nearest_swing_stop(lows: list, entry_price: float, max_dist_pct: float = 15.0) -> Optional[float]:
    """Plus haut swing low en-dessous de l'entrée (dans la limite max_dist_pct)."""
    candidates = [p for _, p in lows if p < entry_price
                  and (entry_price - p) / entry_price * 100 <= max_dist_pct]
    return max(candidates) if candidates else None


def nearest_swing_target(highs: list, entry_price: float, max_dist_pct: float = 30.0) -> Optional[float]:
    """Plus bas swing high au-dessus de l'entrée (dans la limite max_dist_pct)."""
    candidates = [p for _, p in highs if p > entry_price
                  and (p - entry_price) / entry_price * 100 <= max_dist_pct]
    return min(candidates) if candidates else None


def fib_levels(swing_low: float, swing_high: float) -> dict:
    """Niveaux Fibonacci standard entre swing_low et swing_high."""
    diff = swing_high - swing_low
    return {
        "0.0":   swing_high,
        "23.6":  swing_high - 0.236 * diff,
        "38.2":  swing_high - 0.382 * diff,
        "50.0":  swing_high - 0.500 * diff,
        "61.8":  swing_high - 0.618 * diff,
        "78.6":  swing_high - 0.786 * diff,
        "100.0": swing_low,
        "127.2": swing_low  - 0.272 * diff,
        "161.8": swing_high + 0.618 * diff,
        "200.0": swing_high + 1.000 * diff,
    }


def rolling_vwap(df: pd.DataFrame, window: int = 20) -> tuple[float, float]:
    """VWAP rolling + écart-type des prix autour du VWAP."""
    recent = df.iloc[-window:].copy()
    tp = (recent["high"] + recent["low"] + recent["close"]) / 3
    vol = recent["volume"].replace(0, 1)
    vwap = (tp * vol).sum() / vol.sum()
    std  = float(tp.std())
    return float(vwap), std


# ── Moteur S/R ─────────────────────────────────────────────────────────────────

class BacktestEngineSR(BacktestEngine):
    """
    Remplace compute_risk_levels() par l'une des 3 méthodes S/R.
    method: "pivot" | "fib" | "volume" | "baseline"
    """

    def __init__(self, *args, sr_method: str = "baseline", **kwargs):
        super().__init__(*args, **kwargs)
        self.sr_method = sr_method

    def _compute_sr_levels(
        self,
        score,
        ind,
        df_slice: pd.DataFrame,
    ) -> tuple[Optional[float], Optional[float]]:
        """Retourne (stop, target) selon la méthode choisie."""
        prix = ind.cours_actuel
        atr  = ind.atr if ind.atr else 0

        # ── Pivot price action ─────────────────────────────────────────────────
        if self.sr_method == "pivot":
            swh, swl = find_swing_levels(df_slice, order=5)
            stop   = nearest_swing_stop(swl, prix, max_dist_pct=12.0)
            target = nearest_swing_target(swh, prix, max_dist_pct=25.0)

            # fallback ATR si pas de pivot trouvé
            if stop is None:
                stop = prix - 2.0 * atr
            if target is None:
                target = prix + 4.0 * atr

            # s'assurer que R/R >= 1.5
            dist_stop   = prix - stop
            dist_target = target - prix
            if dist_stop > 0 and dist_target / dist_stop < 1.5:
                target = prix + 1.5 * dist_stop  # étirer le target si trop serré
            return round(max(0, stop), 2), round(max(0, target), 2)

        # ── Fibonacci ──────────────────────────────────────────────────────────
        elif self.sr_method == "fib":
            swh, swl = find_swing_levels(df_slice, order=5)
            if not swh or not swl:
                # pas de swings → ATR fallback
                return prix - 2.0 * atr, prix + 4.0 * atr

            # Dernier swing low et high significatifs
            last_low  = swl[-1][1]
            last_high = swh[-1][1]

            # On veut le dernier mouvement haussier : swing low récent < prix < swing high récent
            # Chercher le swing low le plus récent sous le prix
            recent_lows  = [p for _, p in swl if p < prix]
            recent_highs = [p for _, p in swh if p > prix]

            if recent_lows and recent_highs:
                sl_fib = max(recent_lows)
                sh_fib = min(recent_highs)
                fibs = fib_levels(sl_fib, sh_fib)

                # Stop = retracement 61.8% (si en-dessous du prix)
                stop_fib = fibs["61.8"]
                if stop_fib >= prix:
                    stop_fib = fibs["78.6"]
                if stop_fib >= prix:
                    stop_fib = prix - 2.0 * atr  # fallback

                # Target = extension 161.8% depuis swing low
                target_fib = fibs["161.8"]
                if target_fib <= prix:
                    target_fib = prix + 4.0 * atr  # fallback

                # R/R >= 1.5 garanti
                dist_stop   = prix - stop_fib
                dist_target = target_fib - prix
                if dist_stop > 0 and dist_target / dist_stop < 1.5:
                    target_fib = prix + 1.5 * dist_stop

                return round(max(0, stop_fib), 2), round(max(0, target_fib), 2)
            else:
                return prix - 2.0 * atr, prix + 4.0 * atr

        # ── Volume profile (VWAP) ──────────────────────────────────────────────
        elif self.sr_method == "volume":
            has_volume = df_slice["volume"].sum() > 0
            if has_volume and len(df_slice) >= 20:
                vwap, vstd = rolling_vwap(df_slice, window=20)
                if vstd > 0:
                    # Stop = VWAP - 1.5 std (si sous le prix)
                    stop_vol   = vwap - 1.5 * vstd
                    target_vol = vwap + 2.5 * vstd
                    if stop_vol < prix and target_vol > prix:
                        dist_stop   = prix - stop_vol
                        dist_target = target_vol - prix
                        if dist_stop > 0 and dist_target / dist_stop < 1.5:
                            target_vol = prix + 1.5 * dist_stop
                        return round(max(0, stop_vol), 2), round(max(0, target_vol), 2)
            # fallback ATR
            return round(prix - 2.0 * atr, 2), round(prix + 4.0 * atr, 2)

        # ── Baseline (ATR-only) ────────────────────────────────────────────────
        else:
            from analysis import compute_risk_levels as _crl
            return _crl(score, ind)

    def run(self, ticker_data: dict) -> BacktestResult:
        if not ticker_data:
            raise ValueError("ticker_data vide")

        all_dates = sorted({
            idx.date() if hasattr(idx, "date") else idx
            for df in ticker_data.values()
            for idx in df.index
        })

        self._equity_history.append({"date": all_dates[0], "equity": self._equity})

        for current_date in all_dates:
            ts = pd.Timestamp(current_date)

            for ticker, df_full in ticker_data.items():
                df_slice = df_full[df_full.index <= ts]
                if ts not in df_full.index:
                    continue
                if len(df_slice) < self.warmup_bars:
                    continue

                current_bar   = df_full.loc[ts]
                current_price = float(current_bar["close"])
                current_high  = float(current_bar.get("high", current_price))
                current_low   = float(current_bar.get("low",  current_price))

                if ticker in self._open:
                    days_held = (current_date - self._open[ticker].entry_date).days
                    if days_held >= self.max_holding_days:
                        self._close(ticker, current_price, current_date, "timeout_3m")
                    else:
                        self._check_stop_target(ticker, current_low, current_high, current_date)

                next_rev = self._next_review.get(ticker)
                if next_rev is None or current_date >= next_rev:
                    self._next_review[ticker] = current_date + timedelta(
                        days=self.review_interval_days)

                    if ticker not in self._open:
                        if not self._is_regime_ok(ts):
                            continue
                        try:
                            ind   = compute_indicators(df_slice, ticker=ticker,
                                                       horizon=self.horizon)
                            score = compute_score(ind)
                            score.stop_loss, score.take_profit = self._compute_sr_levels(
                                score, ind, df_slice)
                            score.position_size_pct = compute_position_size(score, ind)
                        except Exception:
                            continue

                        if ind.atr_pct is not None and ind.atr_pct < self.min_atr_pct:
                            continue

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
                last_price = float(ticker_data[ticker].loc[ts_last, "close"])
                self._close(ticker, last_price, last_date, "end_of_backtest")

        return self._build_result()


# ── Affichage ──────────────────────────────────────────────────────────────────

def row(label, r: BacktestResult, base: BacktestResult = None):
    s = r.summary
    if s.get("status") != "ok":
        print(f"  {label:<42}  AUCUN TRADE")
        return
    df = r.trades
    rr_avg = df["r_realise"].mean() if "r_realise" in df.columns else 0
    stops  = len(df[df["exit_reason"].isin(["stop", "stop_extreme"])])
    tgts   = len(df[df["exit_reason"] == "target"])
    delta  = ""
    if base and base.summary.get("status") == "ok":
        bs = base.summary
        delta = f"  [dRet={s['total_return_pct']-bs['total_return_pct']:+.1f}%  dExp={s['expectancy_pct']-bs['expectancy_pct']:+.2f}%  dRR={rr_avg-(base.trades['r_realise'].mean() if 'r_realise' in base.trades.columns else 0):+.2f}]"
    print(f"  {label:<42}  n={s['n_trades']:>3}  WR={s['win_rate_pct']:>5.1f}%  "
          f"Exp={s['expectancy_pct']:>+6.2f}%  Ret={s['total_return_pct']:>+7.1f}%  "
          f"DD={s['max_drawdown_pct']:>4.1f}%  RR={rr_avg:>+5.2f}  st={stops}  tgt={tgts}"
          f"{delta}")


def detail(label, r: BacktestResult):
    df = r.trades
    print(f"\n  {label} - sorties détaillées :")
    for reason, grp in df.groupby("exit_reason"):
        wr  = (grp["pnl_pct"] > 0).mean() * 100
        avg = grp["pnl_pct"].mean()
        rr  = grp["r_realise"].mean() if "r_realise" in grp.columns else 0
        print(f"    {reason:<22}  n={len(grp):>3}  WR={wr:>5.1f}%  "
              f"avg_pnl={avg:>+6.2f}%  R={rr:>+5.2f}  {grp['holding_days'].mean():.0f}j")


# ── Exécution ──────────────────────────────────────────────────────────────────

print(f"{'='*125}")
print(f"  {'Méthode':<42}  {'n':>4}  {'WR':>7}  {'Exp':>8}  {'Return':>9}  {'DD':>5}  "
      f"{'RR':>5}  {'stops':>6}  {'tgts':>5}  Delta")
print(f"  {'-'*42}  {'-'*4}  {'-'*7}  {'-'*8}  {'-'*9}  {'-'*5}  {'-'*5}  {'-'*6}  {'-'*5}")
print("  [calcul en cours - baseline...]")

r_base = BacktestEngineSR(**BASE_KWARGS, sr_method="baseline").run(data_all)
row("0. Baseline (ATR-only, 2% frais)", r_base)

print("  [SR1 - Pivots price action...]")
r_pivot = BacktestEngineSR(**BASE_KWARGS, sr_method="pivot").run(data_all)
row("SR1. Pivots price action", r_pivot, r_base)

print("  [SR2 - Fibonacci retracements...]")
r_fib = BacktestEngineSR(**BASE_KWARGS, sr_method="fib").run(data_all)
row("SR2. Fibonacci 61.8%/161.8%", r_fib, r_base)

print("  [SR3 - Volume profile (VWAP)...]")
r_vol = BacktestEngineSR(**BASE_KWARGS, sr_method="volume").run(data_all)
row("SR3. Volume profile / VWAP", r_vol, r_base)

print(f"{'='*125}")

# Détail des meilleurs
print()
for label, r in [("Baseline ATR", r_base), ("SR1 Pivots", r_pivot),
                 ("SR2 Fibonacci", r_fib), ("SR3 Volume", r_vol)]:
    detail(label, r)

# Distribution des niveaux stop/target calculés
print(f"\n  Distribution distances stop/target (% du cours à l'entrée) :")
print(f"  {'Méthode':<22}  {'stop_moy':>9}  {'tgt_moy':>9}  {'RR_setup':>9}  {'RR_realise':>10}")
for label, r in [("Baseline", r_base), ("Pivots", r_pivot),
                 ("Fibonacci", r_fib), ("Volume", r_vol)]:
    df = r.trades
    if df.empty:
        continue
    ep  = df["entry_price"]
    sl  = df["stop_loss"]  if "stop_loss"  in df.columns else None
    tp  = df["take_profit"] if "take_profit" in df.columns else None
    rr  = df["r_realise"].mean() if "r_realise" in df.columns else 0
    if sl is not None and tp is not None:
        stop_pct = ((ep - sl) / ep * 100).mean()
        tgt_pct  = ((tp - ep) / ep * 100).mean()
        rr_setup = tgt_pct / stop_pct if stop_pct > 0 else 0
        print(f"  {label:<22}  {stop_pct:>8.2f}%  {tgt_pct:>8.2f}%  {rr_setup:>9.2f}  {rr:>10.2f}")

print(f"\n{'='*125}")
