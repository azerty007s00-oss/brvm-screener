"""
strategy_comparison.py - A vs B sur les mêmes données historiques.

A : hold mécanique (stop / target / timeout_3m) - stratégie actuelle
B : + exit si signal ≠ ACHAT à chaque revue
"""

import logging
import time
from datetime import date, timedelta
from typing import Optional

import pandas as pd

from analysis import compute_risk_levels, compute_position_size
from backtest import (
    ALL_TICKERS, INITIAL_CAP, MAX_ATR_PCT, MAX_HOLDING_DAYS,
    MIN_PRICE, REVIEW_INTERVAL_DAYS, WARMUP_BARS, BacktestEngine,
    BacktestResult, Position, _build_equity_curve, _compute_by_confiance,
    _compute_by_ticker, _compute_summary, _positions_to_df,
)
from config import DEFAULT_HORIZON
from indicators import compute_indicators
from scoring import compute_score

logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")


# ─── Moteur B - exit sur retournement de signal ──────────────────────────────

class BacktestEngineWithSignalExit(BacktestEngine):
    """
    Identique à BacktestEngine + fermeture si signal ≠ ACHAT à la revue.
    """

    def run(self, ticker_data: dict[str, pd.DataFrame]) -> BacktestResult:
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

                # ── Suivi journalier ──────────────────────────────────────
                if ticker in self._open:
                    pos = self._open[ticker]
                    days_held = (current_date - pos.entry_date).days
                    if days_held >= self.max_holding_days:
                        self._close(ticker, current_price, current_date, "timeout_3m")
                    else:
                        self._check_stop_target(ticker, current_low, current_high, current_date)

                # ── Revue ─────────────────────────────────────────────────
                next_rev = self._next_review.get(ticker)
                if next_rev is None or current_date >= next_rev:
                    self._next_review[ticker] = current_date + timedelta(days=self.review_interval_days)

                    try:
                        ind   = compute_indicators(df_slice, ticker=ticker, horizon=self.horizon)
                        score = compute_score(ind)
                    except Exception:
                        continue

                    # ── B : exit si signal retourné ──────────────────────
                    if ticker in self._open and score.signal != "ACHAT":
                        self._close(ticker, current_price, current_date, "signal_exit")

                    # ── Ouverture si ticker libre ────────────────────────
                    if ticker not in self._open:
                        score.stop_loss, score.take_profit = compute_risk_levels(score, ind)
                        score.position_size_pct = compute_position_size(score, ind)

                        if (score.signal == "ACHAT"
                                and score.confiance in self.confiance_filter
                                and score.stop_loss is not None
                                and score.take_profit is not None
                                and score.position_size_pct is not None
                                and ind.cours_actuel >= self.min_price
                                and (ind.atr_pct is None or ind.atr_pct <= self.max_atr_pct)):
                            self._open_position(ticker, score, ind, current_date)

            self._equity_history.append({"date": current_date, "equity": self._equity})

        last_date = all_dates[-1]
        for ticker in list(self._open.keys()):
            ts_last = pd.Timestamp(last_date)
            if ticker in ticker_data and ts_last in ticker_data[ticker].index:
                last_price = float(ticker_data[ticker].loc[ts_last, "close"])
                self._close(ticker, last_price, last_date, "end_of_backtest")

        return self._build_result()


# ─── Fetch données (une seule fois) ──────────────────────────────────────────

def fetch_data(tickers: list[str], days: int = 730) -> dict[str, pd.DataFrame]:
    from scraper import get_ohlcv, TickerNotFoundError, InsufficientDataError
    data = {}
    for ticker in tickers:
        try:
            df = get_ohlcv(ticker, days=days)
            data[ticker] = df
        except (TickerNotFoundError, InsufficientDataError) as e:
            print(f"  SKIP {ticker} - {e}")
        except Exception as e:
            print(f"  ERR  {ticker} - {e}")
    return data


# ─── Affichage résultats ──────────────────────────────────────────────────────

def print_summary(label: str, s: dict, by_conf: dict) -> None:
    if s.get("status") != "ok":
        print(f"\n{label} : aucun trade ({s.get('status')})")
        return

    print(f"\n{'-'*60}")
    print(f"  {label}")
    print(f"{'-'*60}")
    print(f"  Trades       : {s['n_trades']}  (W={s['n_wins']} / L={s['n_losses']})")
    print(f"  Win rate     : {s['win_rate_pct']}%")
    print(f"  Expectancy   : {s['expectancy_pct']:+.2f}%  (pondérée : {s['expectancy_weighted']})")
    print(f"  Avg R        : {s['avg_r_realise']}")
    print(f"  Durée moy.   : {s['avg_holding_days']:.0f}j")
    print(f"  Return total : {s['total_return_pct']:+.2f}%")
    print(f"  Gain net     : {s['gain_net_fcfa']:+,.0f} FCFA")
    print(f"  Capital final: {s['final_capital']:,.0f} FCFA")
    print(f"  Max drawdown : {s['max_drawdown_pct']:.1f}%")

    print(f"\n  Sorties :")
    for reason, stats in sorted(s.get("by_exit_reason", {}).items()):
        print(f"    {reason:<22}  n={stats['n']:>3}  PnL moy={stats['avg_pnl']:+.1f}%  {stats['avg_days']:.0f}j")

    if by_conf:
        print(f"\n  Par confiance :")
        for conf in ["forte", "modérée", "faible"]:
            st = by_conf.get(conf)
            if st:
                print(
                    f"    {conf:<10}  n={st['n']:>3}  "
                    f"win={st['win_rate_pct']}%  "
                    f"exp={st['expectancy_pct']:+.2f}%  "
                    f"{st['avg_days']:.0f}j"
                )


def print_delta(sA: dict, sB: dict) -> None:
    if sA.get("status") != "ok" or sB.get("status") != "ok":
        return
    print(f"\n{'='*60}")
    print(f"  DELTA  B - A")
    print(f"{'='*60}")

    def d(key, fmt="+.2f", suffix=""):
        a, b = sA.get(key), sB.get(key)
        if a is None or b is None:
            return
        delta = b - a
        print(f"  {key:<25} A={a:{fmt}}{suffix}  B={b:{fmt}}{suffix}  D={delta:+.2f}{suffix}")

    d("n_trades",         fmt=".0f")
    d("win_rate_pct",     suffix="%")
    d("expectancy_pct",   suffix="%")
    d("avg_r_realise")
    d("avg_holding_days", fmt=".1f", suffix="j")
    d("total_return_pct", suffix="%")
    d("max_drawdown_pct", suffix="%")
    d("gain_net_fcfa",    fmt=",.0f", suffix=" FCFA")


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    TICKERS = ALL_TICKERS          # tous les tickers actions BRVM
    DAYS    = 730

    print(f"Fetch donnees -- {len(TICKERS)} tickers, {DAYS} jours...")
    t0 = time.time()
    data = fetch_data(TICKERS, days=DAYS)
    print(f"  {len(data)} tickers charges en {time.time()-t0:.1f}s\n")

    if not data:
        print("Aucune donnée disponible.")
        exit(1)

    kwargs = dict(
        initial_capital      = INITIAL_CAP,
        horizon              = DEFAULT_HORIZON,
        warmup_bars          = WARMUP_BARS,
        review_interval_days = REVIEW_INTERVAL_DAYS,
        max_holding_days     = MAX_HOLDING_DAYS,
        max_atr_pct          = MAX_ATR_PCT,
        min_price            = MIN_PRICE,
    )
    FEE = 1.5   # frais aller-retour BRVM

    print("A  - hold mecanique, sans frais...")
    rA0 = BacktestEngine(**kwargs, fee_pct=0.0).run(data)
    print("A' - hold mecanique, frais 1.5%...")
    rA  = BacktestEngine(**kwargs, fee_pct=FEE).run(data)
    print("B  - exit signal,    sans frais...")
    rB0 = BacktestEngineWithSignalExit(**kwargs, fee_pct=0.0).run(data)
    print("B' - exit signal,    frais 1.5%...")
    rB  = BacktestEngineWithSignalExit(**kwargs, fee_pct=FEE).run(data)

    print_summary("A  - Hold mecanique  (sans frais)", rA0.summary, rA0.by_confiance)
    print_summary("A' - Hold mecanique  (frais 1.5%)", rA.summary,  rA.by_confiance)
    print_summary("B  - Exit signal     (sans frais)", rB0.summary, rB0.by_confiance)
    print_summary("B' - Exit signal     (frais 1.5%)", rB.summary,  rB.by_confiance)

    print(f"\n{'='*60}")
    print("  TABLEAU RECAPITULATIF")
    print(f"{'='*60}")
    print(f"  {'Strategie':<30} {'Trades':>7} {'Return':>9} {'WR':>7} {'Exp':>8} {'MaxDD':>7}")
    print(f"  {'-'*30} {'-'*7} {'-'*9} {'-'*7} {'-'*8} {'-'*7}")
    for label, s in [
        ("A  hold mecanique sans frais", rA0.summary),
        ("A' hold mecanique frais 1.5%", rA.summary),
        ("B  exit signal    sans frais", rB0.summary),
        ("B' exit signal    frais 1.5%", rB.summary),
    ]:
        if s.get("status") == "ok":
            print(
                f"  {label:<30} {s['n_trades']:>7} "
                f"{s['total_return_pct']:>+8.1f}% "
                f"{s['win_rate_pct']:>6.1f}% "
                f"{s['expectancy_pct']:>+7.2f}% "
                f"{s['max_drawdown_pct']:>6.1f}%"
            )
