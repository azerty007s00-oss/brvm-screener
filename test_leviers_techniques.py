"""
test_leviers_techniques.py - Test de 4 leviers techniques avant integration.

Baseline = moteur actuel (post-ameliorations A+B+C) :
  n=224, WR=47.8%, exp=+1.87%, return=+43.2%, DD=6.4%

Leviers testes :
  T1. Trailing stop break-even  : apres 50% du chemin vers target, stop -> prix entree
  T2. Filtre regime marche      : entree uniquement si BRVMC > MA50
  T3. Filtre volume             : entree si volume actuel > moyenne 20j
  T4. Relative strength 3m      : entree si perf ticker > perf BRVMC sur 3 mois
  T5. T2 + T3 + T4 combines
  T6. T1 + T2 + T3 + T4 tous
"""
import logging
import warnings
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

import pandas as pd
import numpy as np
from datetime import date, timedelta
from typing import Optional

from backtest import (BacktestEngine, ALL_TICKERS, INITIAL_CAP, WARMUP_BARS,
    REVIEW_INTERVAL_DAYS, MAX_HOLDING_DAYS, MAX_ATR_PCT, MIN_PRICE,
    BacktestResult, Position)
from config import DEFAULT_HORIZON
from analysis import compute_risk_levels, compute_position_size
from indicators import compute_indicators
from scoring import compute_score
from scraper import get_ohlcv

# ── Fetch donnees ──────────────────────────────────────────────────────────────
print("Chargement donnees...")
data_all = {}
for t in ALL_TICKERS:
    try:
        data_all[t] = get_ohlcv(t, days=730)
    except:
        pass

# BRVMC pour regime et RS
df_brvmc = None
try:
    df_brvmc = get_ohlcv("BRVMC", days=730)
    print(f"  BRVMC: {len(df_brvmc)} barres ({df_brvmc.index[0].date()} -> {df_brvmc.index[-1].date()})")
except Exception as e:
    print(f"  BRVMC introuvable: {e}")

print(f"  {len(data_all)} tickers actions\n")

BASE_KWARGS = dict(
    initial_capital=INITIAL_CAP, horizon=DEFAULT_HORIZON,
    warmup_bars=WARMUP_BARS, review_interval_days=REVIEW_INTERVAL_DAYS,
    max_holding_days=MAX_HOLDING_DAYS, max_atr_pct=MAX_ATR_PCT,
    min_price=MIN_PRICE, fee_pct=0.0,
)


# ── Moteur etendu ──────────────────────────────────────────────────────────────

class BacktestEngineExtended(BacktestEngine):
    """
    Ajoute en options (desactivables independamment) :
      - trailing_stop   : stop -> entry apres 50% du target
      - regime_filter   : entree si BRVMC > MA50
      - volume_filter   : entree si volume > moy20j
      - rs_filter       : entree si perf_3m ticker > perf_3m BRVMC
    """

    def __init__(self, *args,
                 trailing_stop:  bool = False,
                 regime_filter:  bool = False,
                 volume_filter:  bool = False,
                 rs_filter:      bool = False,
                 df_index: Optional[pd.DataFrame] = None,
                 **kwargs):
        super().__init__(*args, **kwargs)
        self.trailing_stop = trailing_stop
        self.regime_filter = regime_filter
        self.volume_filter = volume_filter
        self.rs_filter     = rs_filter
        self.df_index      = df_index  # BRVMC OHLCV

    # -- Trailing stop break-even ---------------------------------------------
    def _update_trailing_stop(self, ticker: str, current_high: float,
                               current_date: date) -> None:
        """Apres 50% du chemin vers target, move stop au prix d'entree."""
        pos = self._open[ticker]
        # Ne s'active qu'apres la periode de tolerance (stop actif)
        days_held = (current_date - pos.entry_date).days
        if days_held < self.stop_tolerance_days:
            return
        # Si stop est deja au-dessus de l'entree (break-even deja active), rien a faire
        if pos.stop_loss >= pos.entry_price:
            return
        midpoint = pos.entry_price + 0.5 * (pos.take_profit - pos.entry_price)
        if current_high >= midpoint:
            pos.stop_loss = pos.entry_price  # break-even

    # -- Regime BRVMC > MA50 --------------------------------------------------
    def _is_regime_ok(self, current_ts: pd.Timestamp) -> bool:
        """Retourne True si BRVMC est au-dessus de sa MA50 a la date donnee."""
        if self.df_index is None:
            return True
        idx = self.df_index[self.df_index.index <= current_ts]
        if len(idx) < 50:
            return True  # pas assez de donnees -> laisser passer
        ma50 = idx["close"].iloc[-50:].mean()
        return float(idx["close"].iloc[-1]) >= ma50

    # -- run() avec tous les filtres ------------------------------------------
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

                    # T1 : trailing stop (avant check stop/target)
                    if self.trailing_stop and ticker in self._open:
                        self._update_trailing_stop(ticker, current_high, current_date)

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
                        # T2 : filtre regime marche
                        if self.regime_filter and not self._is_regime_ok(ts):
                            continue

                        try:
                            df_idx_slice = (
                                self.df_index[self.df_index.index <= ts]
                                if self.df_index is not None else None
                            )
                            ind = compute_indicators(df_slice, ticker=ticker,
                                                     horizon=self.horizon,
                                                     df_index=df_idx_slice)
                            score = compute_score(ind)
                            score.stop_loss, score.take_profit = compute_risk_levels(score, ind)
                            score.position_size_pct = compute_position_size(score, ind)
                        except Exception:
                            continue

                        # T3 : filtre volume
                        if self.volume_filter and ind.volume_moy20 > 0:
                            if ind.volume_actuel < ind.volume_moy20:
                                continue

                        # T4 : filtre relative strength 3m
                        if self.rs_filter:
                            rs = ind.perf_vs_index_3m
                            if rs is not None and rs < 0:
                                continue

                        # MIN_ATR (herite de BacktestEngine)
                        if (ind.atr_pct is not None
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

def row(label: str, r: BacktestResult, baseline: BacktestResult = None):
    s = r.summary
    if s.get("status") != "ok":
        print(f"  {label:<42}  AUCUN TRADE")
        return
    df = r.trades
    be_trades = len(df[df["exit_reason"] == "stop_extreme"])  # stops precoces restes

    # Taux de break-even atteint (stops > entry price)
    stops_all  = len(df[df["exit_reason"].isin(["stop","stop_extreme","breakeven"])])
    stops_1_3j = len(df[(df["exit_reason"].isin(["stop","stop_extreme"])) & (df["holding_days"]<=3)])

    ret  = s["total_return_pct"]
    exp  = s["expectancy_pct"]
    wr   = s["win_rate_pct"]
    dd   = s["max_drawdown_pct"]
    n    = s["n_trades"]

    delta = ""
    if baseline and baseline.summary.get("status") == "ok":
        bs = baseline.summary
        dr = ret - bs["total_return_pct"]
        de = exp - bs["expectancy_pct"]
        delta = f"  [dRet={dr:+.1f}%  dExp={de:+.2f}%]"

    print(f"  {label:<42}  n={n:>3}  WR={wr:>5.1f}%  "
          f"Exp={exp:>+6.2f}%  Ret={ret:>+7.1f}%  DD={dd:>5.1f}%  "
          f"st1-3j={stops_1_3j:>2}{delta}")


def detail(label: str, r: BacktestResult):
    df = r.trades
    print(f"\n  {label} - durees + sorties :")
    b = [
        ("1-3j",   len(df[df["holding_days"].between(1,3)])),
        ("4-7j",   len(df[df["holding_days"].between(4,7)])),
        ("8-14j",  len(df[df["holding_days"].between(8,14)])),
        ("15-30j", len(df[df["holding_days"].between(15,30)])),
        (">30j",   len(df[df["holding_days"]>30])),
    ]
    print("    " + "  ".join(f"{l}={v}" for l, v in b))
    for reason, grp in df.groupby("exit_reason"):
        wr  = (grp["pnl_pct"] > 0).mean() * 100
        avg = grp["pnl_pct"].mean()
        print(f"    {reason:<22}  n={len(grp):>3}  WR={wr:>5.1f}%  avg={avg:>+6.2f}%  "
              f"{grp['holding_days'].mean():.0f}j")


# ── Scenarios ──────────────────────────────────────────────────────────────────

print(f"\n{'='*115}")
print(f"  {'Scenario':<42}  {'n':>4}  {'WR':>7}  {'Exp':>8}  {'Return':>9}  "
      f"{'MaxDD':>7}  {'st1-3j':>7}  Delta")
print(f"  {'-'*42}  {'-'*4}  {'-'*7}  {'-'*8}  {'-'*9}  {'-'*7}  {'-'*7}")
print("  [calcul en cours...]")

# Baseline
r0 = BacktestEngine(**BASE_KWARGS).run(data_all)
row("0. Baseline (post A+B+C)", r0)

# T1 : trailing stop seulement
r1 = BacktestEngineExtended(**BASE_KWARGS, trailing_stop=True,
                             df_index=df_brvmc).run(data_all)
row("T1. Trailing stop break-even", r1, r0)

# T2 : regime BRVMC > MA50
r2 = BacktestEngineExtended(**BASE_KWARGS, regime_filter=True,
                             df_index=df_brvmc).run(data_all)
row("T2. Regime BRVMC > MA50", r2, r0)

# T3 : volume > moy20
r3 = BacktestEngineExtended(**BASE_KWARGS, volume_filter=True,
                             df_index=df_brvmc).run(data_all)
row("T3. Volume > moyenne 20j", r3, r0)

# T4 : RS 3m > 0
r4 = BacktestEngineExtended(**BASE_KWARGS, rs_filter=True,
                             df_index=df_brvmc).run(data_all)
row("T4. Relative strength 3m > 0", r4, r0)

# T5 : T2 + T3 + T4
r5 = BacktestEngineExtended(**BASE_KWARGS,
                             regime_filter=True, volume_filter=True, rs_filter=True,
                             df_index=df_brvmc).run(data_all)
row("T5. T2+T3+T4 (filtres entree)", r5, r0)

# T6 : tout
r6 = BacktestEngineExtended(**BASE_KWARGS,
                             trailing_stop=True, regime_filter=True,
                             volume_filter=True, rs_filter=True,
                             df_index=df_brvmc).run(data_all)
row("T6. Tout (T1+T2+T3+T4)", r6, r0)

print(f"{'='*115}")

# Detail sur les plus prometteurs
for label, r in [("T1 trailing", r1), ("T5 filtres entree", r5), ("T6 tout", r6)]:
    detail(label, r)

# Distribution des stops par scenario
print(f"\n  Distribution stops :")
print(f"  {'Scenario':<30}  {'stops_tot':>10}  {'stop1-3j':>10}  {'breakeven':>10}  {'target':>8}")
for lbl, r in [("Baseline", r0), ("T1 trailing", r1), ("T5 T2+T3+T4", r5), ("T6 tout", r6)]:
    df = r.trades
    st  = len(df[df["exit_reason"].isin(["stop","stop_extreme"])])
    s13 = len(df[(df["exit_reason"].isin(["stop","stop_extreme"])) & (df["holding_days"]<=3)])
    be  = len(df[df["exit_reason"] == "breakeven"])
    tgt = len(df[df["exit_reason"] == "target"])
    print(f"  {lbl:<30}  {st:>10}  {s13:>10}  {be:>10}  {tgt:>8}")

print(f"\n{'='*115}")
