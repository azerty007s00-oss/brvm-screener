"""
test_improvements.py - Test isolé de 3 leviers d'amélioration avant intégration.

Leviers testés :
  A. Blacklist SPHC
  B. Filtre MIN_ATR >= 1.5%
  C. Tolérance stop J+3 (stop extrême uniquement les 3 premiers jours)
  D. Combinaison A + B + C
"""
import logging
import warnings
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

import pandas as pd
from datetime import date, timedelta
from typing import Optional

from backtest import (BacktestEngine, ALL_TICKERS, INITIAL_CAP, WARMUP_BARS,
    REVIEW_INTERVAL_DAYS, MAX_HOLDING_DAYS, MAX_ATR_PCT, MIN_PRICE,
    BacktestResult, Position, _build_equity_curve, _compute_by_confiance,
    _compute_by_ticker, _compute_summary, _positions_to_df)
from config import DEFAULT_HORIZON
from analysis import compute_risk_levels, compute_position_size
from indicators import compute_indicators
from scoring import compute_score
from scraper import get_ohlcv

# ── Fetch ──────────────────────────────────────────────────────────────────────
print("Chargement donnees (cache)...")
data_all = {}
for t in ALL_TICKERS:
    try:
        data_all[t] = get_ohlcv(t, days=730)
    except:
        pass
print(f"  {len(data_all)} tickers\n")

BASE_KWARGS = dict(
    initial_capital      = INITIAL_CAP,
    horizon              = DEFAULT_HORIZON,
    warmup_bars          = WARMUP_BARS,
    review_interval_days = REVIEW_INTERVAL_DAYS,
    max_holding_days     = MAX_HOLDING_DAYS,
    max_atr_pct          = MAX_ATR_PCT,
    min_price            = MIN_PRICE,
    fee_pct              = 0.0,
)

# ── Moteur amélioré ────────────────────────────────────────────────────────────

class BacktestEngineImproved(BacktestEngine):
    """
    Ajoute :
      - min_atr_pct : filtre les entrées quand ATR% < seuil
      - stop_tolerance_days : pendant les N premiers jours, le stop normal
        est suspendu ; seul un "stop extrême" (prix < 2× distance de stop
        sous l'entrée) déclenche la sortie
    """

    def __init__(self, *args,
                 min_atr_pct: float = 0.0,
                 stop_tolerance_days: int = 0,
                 **kwargs):
        super().__init__(*args, **kwargs)
        self.min_atr_pct          = min_atr_pct
        self.stop_tolerance_days  = stop_tolerance_days

    # -- Stop / target avec tolérance J+N ------------------------------------
    def _check_stop_target(self, ticker: str, low: float, high: float,
                           current_date: date) -> None:
        pos = self._open[ticker]

        if self.stop_tolerance_days > 0:
            days_held = (current_date - pos.entry_date).days
            if days_held < self.stop_tolerance_days:
                # Stop extrême : prix tombe à 2× la distance de stop sous l'entrée
                stop_distance = pos.entry_price - pos.stop_loss
                extreme_stop  = pos.stop_loss - stop_distance   # = 2*stop - entry
                if low <= extreme_stop:
                    self._close(ticker, extreme_stop, current_date, "stop_extreme")
                elif ticker in self._open and high >= pos.take_profit:
                    self._close(ticker, pos.take_profit, current_date, "target")
                return  # stop normal suspendu

        # Comportement standard après la période de tolérance
        super()._check_stop_target(ticker, low, high, current_date)

    # -- run() avec filtre min_atr à l'entrée --------------------------------
    def run(self, ticker_data: dict) -> BacktestResult:
        if not ticker_data:
            raise ValueError("ticker_data est vide")

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

                # Suivi journalier
                if ticker in self._open:
                    pos = self._open[ticker]
                    days_held = (current_date - pos.entry_date).days
                    if days_held >= self.max_holding_days:
                        self._close(ticker, current_price, current_date, "timeout_3m")
                    else:
                        self._check_stop_target(ticker, current_low, current_high, current_date)

                # Revue
                next_rev = self._next_review.get(ticker)
                if next_rev is None or current_date >= next_rev:
                    self._next_review[ticker] = current_date + timedelta(
                        days=self.review_interval_days)

                    if ticker not in self._open:
                        try:
                            ind   = compute_indicators(df_slice, ticker=ticker,
                                                       horizon=self.horizon)
                            score = compute_score(ind)
                            score.stop_loss, score.take_profit = compute_risk_levels(score, ind)
                            score.position_size_pct = compute_position_size(score, ind)
                        except Exception:
                            continue

                        # -- Filtre MIN_ATR (levier B) --
                        if (self.min_atr_pct > 0
                                and ind.atr_pct is not None
                                and ind.atr_pct < self.min_atr_pct):
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

def print_row(label: str, r: BacktestResult):
    s = r.summary
    if s.get("status") != "ok":
        print(f"  {label:<38}  AUCUN TRADE")
        return
    df = r.trades
    stops_1_3j = len(df[(df["exit_reason"] == "stop") & (df["holding_days"] <= 3)])
    stops_all  = len(df[df["exit_reason"].isin(["stop", "stop_extreme"])])
    print(
        f"  {label:<38}  "
        f"n={s['n_trades']:>3}  "
        f"WR={s['win_rate_pct']:>5.1f}%  "
        f"Exp={s['expectancy_pct']:>+6.2f}%  "
        f"Ret={s['total_return_pct']:>+7.1f}%  "
        f"DD={s['max_drawdown_pct']:>5.1f}%  "
        f"stops={stops_all:>3}  stop1-3j={stops_1_3j:>2}"
    )

def detail_exit(label: str, r: BacktestResult):
    df = r.trades
    print(f"\n  {label} - sorties :")
    for reason, grp in df.groupby("exit_reason"):
        wr  = (grp["pnl_pct"] > 0).mean() * 100
        exp = grp["pnl_pct"].mean()
        avg = grp["holding_days"].mean()
        print(f"    {reason:<22}  n={len(grp):>3}  WR={wr:>5.1f}%  "
              f"avg_pnl={exp:>+6.2f}%  {avg:.0f}j")


# ── Scénarios ──────────────────────────────────────────────────────────────────

data_no_sphc = {k: v for k, v in data_all.items() if k != "SPHC"}

print(f"\n{'='*105}")
print(f"  {'Scenario':<38}  {'n':>4}  {'WR':>7}  {'Exp':>9}  {'Return':>9}  "
      f"{'MaxDD':>7}  {'stops':>7}  {'stop1-3j':>9}")
print(f"  {'-'*38}  {'-'*4}  {'-'*7}  {'-'*9}  {'-'*9}  {'-'*7}  {'-'*7}  {'-'*9}")

print("  [Calcul en cours...]")

r0 = BacktestEngine(**BASE_KWARGS).run(data_all)
print_row("0. Baseline", r0)

rA = BacktestEngine(**BASE_KWARGS).run(data_no_sphc)
print_row("A. Sans SPHC", rA)

rB = BacktestEngineImproved(**BASE_KWARGS, min_atr_pct=1.5).run(data_all)
print_row("B. MIN_ATR >= 1.5%", rB)

rC = BacktestEngineImproved(**BASE_KWARGS, stop_tolerance_days=3).run(data_all)
print_row("C. Stop tolerance J+3", rC)

rABC = BacktestEngineImproved(
    **BASE_KWARGS, min_atr_pct=1.5, stop_tolerance_days=3
).run(data_no_sphc)
print_row("D. A+B+C combinés", rABC)

print(f"{'='*105}")

# Détail des sorties pour C et D (les plus intéressants)
detail_exit("C. Stop tolerance J+3", rC)
detail_exit("D. A+B+C combinés",     rABC)

# Distribution durées pour C vs baseline
print(f"\n  Distribution durées (baseline vs C) :")
for label, r in [("Baseline", r0), ("Stop tolerance J+3", rC), ("A+B+C", rABC)]:
    df = r.trades
    b1 = len(df[df["holding_days"] <= 3])
    b2 = len(df[(df["holding_days"] >= 4) & (df["holding_days"] <= 7)])
    b3 = len(df[(df["holding_days"] >= 8) & (df["holding_days"] <= 14)])
    b4 = len(df[(df["holding_days"] >= 15) & (df["holding_days"] <= 30)])
    b5 = len(df[df["holding_days"] > 30])
    print(f"  {label:<25}  1-3j={b1:>2}  4-7j={b2:>3}  8-14j={b3:>3}  "
          f"15-30j={b4:>3}  >30j={b5:>3}")

print(f"\n{'='*105}")
