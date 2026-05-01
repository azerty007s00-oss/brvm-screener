"""
backtest.py — Backtest bi-mensuel BRVM (stratégie long-only).

Stratégie :
  - Revue de portefeuille toutes les REVIEW_INTERVAL_DAYS (défaut 14j)
  - Entrée uniquement sur signal ACHAT (pas de short — interdit sur la BRVM)
  - Sortie sur :
      1. Stop loss intraday (vérifié à chaque barre)
      2. Take profit intraday (vérifié à chaque barre)
      3. Signal ≠ ACHAT lors de la revue bi-mensuelle (NEUTRE ou VENTE → sortie)
  - 1 trade max par ticker simultanément
  - Aucun look-ahead : seul df[:current_date] est visible à chaque barre

Pipeline identique au live :
    compute_indicators() → compute_score() → compute_risk_levels() → compute_position_size()

Usage :
    result = fetch_and_backtest(ALL_TICKERS)
    print(result.summary)

    python backtest.py --debug
"""

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

import pandas as pd

from analysis import compute_risk_levels, compute_position_size
from config import DEFAULT_HORIZON, TICKER_NAMES
from indicators import compute_indicators
from scoring import compute_score

logger = logging.getLogger(__name__)

# ─── Paramètres globaux ───────────────────────────────────────────────────────

DEBUG_MODE            = False
WARMUP_BARS           = 30     # barres min avant 1er signal (~30 séances ≈ 6 semaines)
INITIAL_CAP           = 1_000_000.0
REVIEW_INTERVAL_DAYS  = 7      # revue hebdomadaire (jours calendaires)
MAX_HOLDING_DAYS      = 90     # durée max de détention (3 mois)
MAX_ATR_PCT           = 4.0    # ATR% max autorisé à l'entrée (filtre volatilité)
MIN_PRICE             = 500.0  # prix min en FCFA (exclut les penny stocks type ETIT)

# Tous les tickers actions (hors indices)
INDICES   = {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}
BLACKLIST = {"SPHC"}   # WR 20%, exp -2.01% sur 5 ans — exclu définitivement
ALL_TICKERS = [t for t in TICKER_NAMES if t not in INDICES and t not in BLACKLIST]


# ─── Dataclasses ─────────────────────────────────────────────────────────────

@dataclass
class Position:
    ticker:       str
    entry_date:   date
    entry_price:  float
    stop_loss:    float
    take_profit:  float
    rr:           Optional[float]
    position_pct: float
    confiance:    str
    score:        int
    atr_pct:      Optional[float]
    data_quality: str
    equity_at_entry:      float         = 0.0
    exit_date:            Optional[date]  = None
    exit_price:           Optional[float] = None
    exit_reason:          Optional[str]   = None
    pnl_pct:              Optional[float] = None
    r_realise:            Optional[float] = None
    holding_days:         Optional[int]   = None
    capital_gain_pct:     Optional[float] = None
    capital_investi_fcfa: Optional[float] = None
    gain_fcfa:            Optional[float] = None


@dataclass
class BacktestResult:
    trades:       pd.DataFrame
    equity_curve: pd.DataFrame
    summary:      dict
    by_ticker:    dict
    by_confiance: dict


# ─── Engine ──────────────────────────────────────────────────────────────────

class BacktestEngine:
    """
    Moteur bi-mensuel long-only :
    - Chaque jour : vérification stop/target sur positions ouvertes
    - Toutes les REVIEW_INTERVAL_DAYS : réévaluation des signaux
        → fermeture si signal ≠ ACHAT
        → ouverture si signal = ACHAT et ticker libre
    """

    def __init__(
        self,
        initial_capital:      float             = INITIAL_CAP,
        horizon:              str               = DEFAULT_HORIZON,
        warmup_bars:          int               = WARMUP_BARS,
        review_interval_days: int               = REVIEW_INTERVAL_DAYS,
        max_holding_days:     int               = MAX_HOLDING_DAYS,
        max_atr_pct:          float             = MAX_ATR_PCT,
        min_atr_pct:          float             = 2.0,
        min_price:            float             = MIN_PRICE,
        confiance_filter:     Optional[list]    = None,
        fee_pct:              float             = 0.0,
        stop_tolerance_days:  int               = 3,
        regime_filter:        bool              = True,
        df_index:             Optional[pd.DataFrame] = None,
        debug:                bool              = False,
    ):
        self.initial_capital      = initial_capital
        self.horizon              = horizon
        self.warmup_bars          = warmup_bars
        self.review_interval_days = review_interval_days
        self.max_holding_days     = max_holding_days
        self.max_atr_pct          = max_atr_pct
        self.min_atr_pct          = min_atr_pct
        self.min_price            = min_price
        self.confiance_filter     = set(confiance_filter) if confiance_filter else {"forte", "modérée", "faible"}
        self.fee_pct              = fee_pct
        self.stop_tolerance_days  = stop_tolerance_days
        self.regime_filter        = regime_filter
        self.df_index             = df_index  # BRVMC OHLCV pour filtre regime
        self.debug                = debug or DEBUG_MODE

        self._open:    dict[str, Position] = {}
        self._closed:  list[Position]      = []
        self._equity:  float               = initial_capital
        self._equity_history: list[dict]   = []
        self._next_review: dict[str, date] = {}

    @property
    def _deployed_pct(self) -> float:
        """Somme des allocations des positions ouvertes (% capital)."""
        return sum(p.position_pct for p in self._open.values())

    def _is_regime_ok(self, ts: pd.Timestamp) -> bool:
        """True si BRVMC est au-dessus de sa MA50 (marché haussier)."""
        if not self.regime_filter or self.df_index is None:
            return True
        idx = self.df_index[self.df_index.index <= ts]
        if len(idx) < 50:
            return True  # pas assez d'historique → laisser passer
        return float(idx["close"].iloc[-1]) >= float(idx["close"].iloc[-50:].mean())

    # ── Boucle principale ────────────────────────────────────────────────────

    def run(self, ticker_data: dict[str, pd.DataFrame]) -> BacktestResult:
        if not ticker_data:
            raise ValueError("ticker_data est vide")

        all_dates: list[date] = sorted({
            idx.date() if hasattr(idx, "date") else idx
            for df in ticker_data.values()
            for idx in df.index
        })

        if not all_dates:
            raise ValueError("Aucune date dans ticker_data")

        logger.info(
            f"[Backtest] {len(ticker_data)} ticker(s) | "
            f"{len(all_dates)} jours | {all_dates[0]} -> {all_dates[-1]} | "
            f"revue /{self.review_interval_days}j | long-only"
        )

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

                # ── Suivi journalier des positions ouvertes ────────────────
                if ticker in self._open:
                    pos = self._open[ticker]
                    days_held = (current_date - pos.entry_date).days

                    # 1. Timeout 3 mois
                    if days_held >= self.max_holding_days:
                        self._close(ticker, current_price, current_date, "timeout_3m")
                    else:
                        # 2. Stop / target — vérifié sur high/low intraday
                        self._check_stop_target(ticker, current_low, current_high, current_date)

                # ── Revue bi-mensuelle — ouvertures uniquement ────────────
                next_rev = self._next_review.get(ticker)
                if next_rev is None or current_date >= next_rev:
                    self._next_review[ticker] = current_date + timedelta(days=self.review_interval_days)

                    if ticker not in self._open:   # ticker libre → tenter une entrée
                        # Filtre régime marché
                        if not self._is_regime_ok(ts):
                            continue

                        try:
                            ind   = compute_indicators(df_slice, ticker=ticker, horizon=self.horizon)
                            score = compute_score(ind)
                            score.stop_loss, score.take_profit = compute_risk_levels(score, ind, df_slice)
                            score.position_size_pct = compute_position_size(score, ind)
                        except Exception as exc:
                            logger.debug(f"[Backtest] {ticker} {current_date} indicators KO: {exc}")
                            continue

                        if (score.signal == "ACHAT"
                                and score.confiance in self.confiance_filter
                                and score.stop_loss is not None
                                and score.take_profit is not None
                                and score.position_size_pct is not None
                                and ind.cours_actuel >= self.min_price
                                and (ind.atr_pct is None or ind.atr_pct <= self.max_atr_pct)
                                and (ind.atr_pct is None or ind.atr_pct >= self.min_atr_pct)
                                and self._deployed_pct + score.position_size_pct <= 100.0):
                            self._open_position(ticker, score, ind, current_date)
                        elif score.signal == "ACHAT" and self.debug:
                            reason = []
                            if ind.cours_actuel < self.min_price:
                                reason.append(f"prix trop bas ({ind.cours_actuel:.0f} < {self.min_price:.0f})")
                            if ind.atr_pct and ind.atr_pct > self.max_atr_pct:
                                reason.append(f"ATR trop eleve ({ind.atr_pct:.2f}% > {self.max_atr_pct:.1f}%)")
                            if reason:
                                print(f"  SKIP  {current_date}  {ticker:<8}  {' | '.join(reason)}")

            self._equity_history.append({"date": current_date, "equity": self._equity})

        # Clôture forcée des positions ouvertes à la fin
        last_date = all_dates[-1]
        for ticker in list(self._open.keys()):
            ts_last = pd.Timestamp(last_date)
            if ticker in ticker_data and ts_last in ticker_data[ticker].index:
                last_price = float(ticker_data[ticker].loc[ts_last, "close"])
                self._close(ticker, last_price, last_date, "end_of_backtest")

        return self._build_result()

    # ── Stop / target (intraday high/low) ───────────────────────────────────

    def _check_stop_target(self, ticker: str, low: float, high: float, current_date: date) -> None:
        pos = self._open[ticker]

        if self.stop_tolerance_days > 0:
            days_held = (current_date - pos.entry_date).days
            if days_held < self.stop_tolerance_days:
                # Stop normal suspendu — seul un stop extrême (2× distance) déclenche la sortie
                stop_distance = pos.entry_price - pos.stop_loss
                extreme_stop  = pos.stop_loss - stop_distance  # = 2*stop_loss - entry_price
                if low <= extreme_stop:
                    self._close(ticker, extreme_stop, current_date, "stop_extreme")
                elif ticker in self._open and high >= pos.take_profit:
                    self._close(ticker, pos.take_profit, current_date, "target")
                return

        stop_hit   = low  <= pos.stop_loss
        target_hit = high >= pos.take_profit
        # Si les deux sont touchés dans la même barre → priorité au stop (conservateur)
        if stop_hit:
            self._close(ticker, pos.stop_loss,   current_date, "stop")
        elif target_hit:
            self._close(ticker, pos.take_profit, current_date, "target")

    # ── Ouverture ────────────────────────────────────────────────────────────

    def _open_position(self, ticker, score, ind, current_date: date) -> None:
        rr = None
        if ind.atr and ind.atr > 0:
            k1 = abs(score.stop_loss  - ind.cours_actuel) / ind.atr
            k2 = abs(score.take_profit - ind.cours_actuel) / ind.atr
            rr = round(k2 / k1, 2) if k1 > 0 else None

        pos = Position(
            ticker          = ticker,
            entry_date      = current_date,
            entry_price     = ind.cours_actuel,
            stop_loss       = score.stop_loss,
            take_profit     = score.take_profit,
            rr              = rr,
            position_pct    = score.position_size_pct,
            confiance       = score.confiance,
            score           = score.score_total,
            atr_pct         = ind.atr_pct,
            data_quality    = getattr(ind, "data_quality_flag", "ok"),
            equity_at_entry = self._equity,
        )
        self._open[ticker] = pos

        if self.debug:
            print(
                f"  OPEN  {current_date}  {ticker:<8}  "
                f"score={score.score_total:+d}  conf={score.confiance:<9}  "
                f"stop={score.stop_loss:,.0f}  target={score.take_profit:,.0f}  "
                f"R/R={rr or '?'}  sz={score.position_size_pct:.1f}%"
            )

    # ── Clôture ──────────────────────────────────────────────────────────────

    def _close(self, ticker: str, exit_price: float, exit_date: date, reason: str) -> None:
        pos = self._open.pop(ticker)
        pos.exit_date    = exit_date
        pos.exit_price   = round(exit_price, 2)
        pos.exit_reason  = reason
        pos.holding_days = (exit_date - pos.entry_date).days

        pos.pnl_pct = round((exit_price - pos.entry_price) / pos.entry_price * 100, 2)

        risk_pct = abs(pos.entry_price - pos.stop_loss) / pos.entry_price * 100
        pos.r_realise = round(pos.pnl_pct / risk_pct, 2) if risk_pct > 0 else None

        pos.capital_gain_pct     = round(pos.position_pct / 100 * pos.pnl_pct, 2)
        pos.capital_investi_fcfa = round(pos.equity_at_entry * pos.position_pct / 100, 0)
        pos.gain_fcfa            = round(pos.capital_investi_fcfa * pos.pnl_pct / 100, 0)
        # Frais aller-retour appliqués sur le capital investi
        fee_drag = pos.position_pct * self.fee_pct / 100
        self._equity *= 1 + (pos.capital_gain_pct - fee_drag) / 100

        self._closed.append(pos)

        if self.debug:
            sign = "+" if pos.pnl_pct >= 0 else ""
            print(
                f"  CLOSE {exit_date}  {ticker:<8}  {reason:<18}  "
                f"pnl={sign}{pos.pnl_pct:.1f}%  R={pos.r_realise or '?'}  "
                f"{pos.holding_days}j"
            )

    # ── Construction du résultat ─────────────────────────────────────────────

    def _build_result(self) -> BacktestResult:
        trades       = _positions_to_df(self._closed)
        equity_curve = _build_equity_curve(self._equity_history)
        summary      = _compute_summary(trades, self._equity, self.initial_capital, equity_curve)
        by_ticker    = _compute_by_ticker(trades)
        by_confiance = _compute_by_confiance(trades)
        return BacktestResult(trades, equity_curve, summary, by_ticker, by_confiance)


# ─── API publique ─────────────────────────────────────────────────────────────

def run_backtest(
    ticker_data:          dict[str, pd.DataFrame],
    initial_capital:      float          = INITIAL_CAP,
    horizon:              str            = DEFAULT_HORIZON,
    warmup_bars:          int            = WARMUP_BARS,
    review_interval_days: int            = REVIEW_INTERVAL_DAYS,
    max_holding_days:     int            = MAX_HOLDING_DAYS,
    max_atr_pct:          float          = MAX_ATR_PCT,
    min_atr_pct:          float          = 2.0,
    min_price:            float          = MIN_PRICE,
    confiance_filter:     Optional[list] = None,
    fee_pct:              float          = 0.0,
    stop_tolerance_days:  int            = 3,
    regime_filter:        bool           = True,
    df_index:             Optional[pd.DataFrame] = None,
    debug:                bool           = False,
) -> BacktestResult:
    return BacktestEngine(
        initial_capital      = initial_capital,
        horizon              = horizon,
        warmup_bars          = warmup_bars,
        review_interval_days = review_interval_days,
        max_holding_days     = max_holding_days,
        max_atr_pct          = max_atr_pct,
        min_atr_pct          = min_atr_pct,
        min_price            = min_price,
        confiance_filter     = confiance_filter,
        fee_pct              = fee_pct,
        stop_tolerance_days  = stop_tolerance_days,
        regime_filter        = regime_filter,
        df_index             = df_index,
        debug                = debug,
    ).run(ticker_data)


def fetch_and_backtest(
    tickers: list[str],
    days:    int = 730,
    **kwargs,
) -> BacktestResult:
    from scraper import get_ohlcv, TickerNotFoundError, InsufficientDataError

    ticker_data: dict[str, pd.DataFrame] = {}
    for ticker in tickers:
        try:
            df = get_ohlcv(ticker, days=days)
            ticker_data[ticker] = df
            logger.info(f"[Backtest] {ticker} — {len(df)} barres")
        except (TickerNotFoundError, InsufficientDataError) as exc:
            logger.warning(f"[Backtest] {ticker} ignore — {exc}")
        except Exception as exc:
            logger.warning(f"[Backtest] {ticker} erreur fetch — {exc}")

    if not ticker_data:
        raise RuntimeError("Aucun ticker disponible pour le backtest")

    # Récupérer BRVMC pour le filtre régime si non fourni
    if kwargs.get("regime_filter", True) and kwargs.get("df_index") is None:
        try:
            kwargs["df_index"] = get_ohlcv("BRVMC", days=days)
        except Exception:
            pass

    # Adapter max_holding_days et review_interval_days à l'horizon si non fournis
    from config import HORIZON_PROFILES
    horizon = kwargs.get("horizon", "Moyen terme")
    hp = HORIZON_PROFILES.get(horizon, {})
    if "max_holding_days" not in kwargs:
        kwargs["max_holding_days"] = hp.get("max_holding_days", MAX_HOLDING_DAYS)
    if "review_interval_days" not in kwargs:
        kwargs["review_interval_days"] = hp.get("review_interval_days", REVIEW_INTERVAL_DAYS)

    return run_backtest(ticker_data, **kwargs)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _positions_to_df(positions: list[Position]) -> pd.DataFrame:
    if not positions:
        return pd.DataFrame()
    return pd.DataFrame([
        {
            "entry_date":       p.entry_date,
            "exit_date":        p.exit_date,
            "ticker":           p.ticker,
            "signal":           "ACHAT",
            "score":            p.score,
            "confiance":        p.confiance,
            "entry_price":      p.entry_price,
            "exit_price":       p.exit_price,
            "stop_loss":        p.stop_loss,
            "take_profit":      p.take_profit,
            "exit_reason":      p.exit_reason,
            "pnl_pct":              p.pnl_pct,
            "r_realise":            p.r_realise,
            "capital_gain_pct":     p.capital_gain_pct,
            "capital_investi_fcfa": p.capital_investi_fcfa,
            "gain_fcfa":            p.gain_fcfa,
            "position_pct":         p.position_pct,
            "holding_days":         p.holding_days,
            "rr":               p.rr,
            "atr_pct":          p.atr_pct,
            "data_quality":     p.data_quality,
        }
        for p in positions
    ]).sort_values("entry_date").reset_index(drop=True)


def _build_equity_curve(history: list[dict]) -> pd.DataFrame:
    df = (
        pd.DataFrame(history)
        .drop_duplicates("date", keep="last")
        .sort_values("date")
        .reset_index(drop=True)
    )
    df["peak"]         = df["equity"].cummax()
    df["drawdown_pct"] = (df["peak"] - df["equity"]) / df["peak"] * 100
    return df.drop(columns=["peak"])


def _compute_summary(
    trades: pd.DataFrame,
    final_equity: float,
    initial_capital: float,
    equity_curve: pd.DataFrame,
) -> dict:
    if trades.empty:
        return {"status": "no_trades", "n_trades": 0}

    valid = trades.dropna(subset=["pnl_pct"]).copy()
    if valid.empty:
        return {"status": "no_closed_trades", "n_trades": len(trades)}

    wins  = valid[valid["pnl_pct"] > 0]
    loses = valid[valid["pnl_pct"] <= 0]
    win_rate = len(wins) / len(valid)
    avg_win  = float(wins["pnl_pct"].mean())  if not wins.empty  else 0.0
    avg_loss = float(loses["pnl_pct"].mean()) if not loses.empty else 0.0
    expectancy = round(win_rate * avg_win + (1 - win_rate) * avg_loss, 2)

    valid["position_pct"] = pd.to_numeric(valid["position_pct"], errors="coerce")
    avg_pos = float(valid["position_pct"].mean())
    exp_w   = round(expectancy * avg_pos / 100, 3) if avg_pos > 0 else None

    valid["r_realise"] = pd.to_numeric(valid["r_realise"], errors="coerce")
    avg_r = valid["r_realise"].mean()

    max_dd = float(equity_curve["drawdown_pct"].max()) if not equity_curve.empty else 0.0

    by_reason = (
        valid.groupby("exit_reason")
        .agg(
            n        = ("pnl_pct",      "count"),
            avg_pnl  = ("pnl_pct",      "mean"),
            avg_days = ("holding_days",  "mean"),
        )
        .round(2)
        .to_dict(orient="index")
    )

    gain_fcfa_total = valid["gain_fcfa"].sum() if "gain_fcfa" in valid.columns else None

    return {
        "status":              "ok",
        "n_trades":            len(valid),
        "n_wins":              len(wins),
        "n_losses":            len(loses),
        "win_rate_pct":        round(win_rate * 100, 1),
        "expectancy_pct":      expectancy,
        "expectancy_weighted": exp_w,
        "avg_r_realise":       round(float(avg_r), 2) if pd.notna(avg_r) else None,
        "avg_win_pct":         round(avg_win,  2) if not wins.empty  else None,
        "avg_loss_pct":        round(avg_loss, 2) if not loses.empty else None,
        "win_loss_ratio":      round(abs(avg_win / avg_loss), 2) if avg_loss != 0 and not loses.empty else None,
        "avg_position_pct":    round(avg_pos, 1),
        "avg_holding_days":    round(float(valid["holding_days"].mean()), 1),
        "total_return_pct":    round((final_equity - initial_capital) / initial_capital * 100, 2),
        "gain_net_fcfa":       round(final_equity - initial_capital, 0),
        "gain_fcfa_total":     round(float(gain_fcfa_total), 0) if gain_fcfa_total is not None else None,
        "final_capital":       round(final_equity, 2),
        "max_drawdown_pct":    round(max_dd, 2),
        "by_exit_reason":      by_reason,
    }


def _compute_by_ticker(trades: pd.DataFrame) -> dict:
    if trades.empty:
        return {}
    out = {}
    for ticker, grp in trades.groupby("ticker"):
        valid = grp.dropna(subset=["pnl_pct"])
        if valid.empty:
            continue
        wins = valid[valid["pnl_pct"] > 0]
        out[ticker] = {
            "n":             len(valid),
            "win_rate_pct":  round(len(wins) / len(valid) * 100, 1),
            "avg_pnl_pct":   round(float(valid["pnl_pct"].mean()), 2),
            "total_pnl_pct": round(float(valid["pnl_pct"].sum()), 2),
            "avg_days":      round(float(valid["holding_days"].mean()), 1),
        }
    return out


def _compute_by_confiance(trades: pd.DataFrame) -> dict:
    if trades.empty:
        return {}
    out = {}
    for conf in ("forte", "moderee", "faible"):
        conf_label = "modérée" if conf == "moderee" else conf
        sub = trades[trades["confiance"] == conf_label].dropna(subset=["pnl_pct"]).copy()
        if sub.empty:
            continue
        wins  = sub[sub["pnl_pct"] > 0]
        loses = sub[sub["pnl_pct"] <= 0]
        wr    = len(wins) / len(sub)
        avg_w = float(wins["pnl_pct"].mean())  if not wins.empty  else 0.0
        avg_l = float(loses["pnl_pct"].mean()) if not loses.empty else 0.0
        out[conf_label] = {
            "n":              len(sub),
            "win_rate_pct":   round(wr * 100, 1),
            "avg_pnl_pct":    round(float(sub["pnl_pct"].mean()), 2),
            "expectancy_pct": round(wr * avg_w + (1 - wr) * avg_l, 2),
            "avg_days":       round(float(sub["holding_days"].mean()), 1),
        }
    return out


# ─── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    import time

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    args    = sys.argv[1:]
    debug   = "--debug" in args
    tickers_arg = [a for a in args if not a.startswith("--")]
    tickers = tickers_arg if tickers_arg else ALL_TICKERS

    print(f"\nBACKTEST BRVM (long-only, revue /{REVIEW_INTERVAL_DAYS}j)")
    print(f"Tickers : {len(tickers)} | Horizon : {DEFAULT_HORIZON} | Warmup : {WARMUP_BARS} barres")
    print("=" * 72)

    t0 = time.time()
    try:
        result = fetch_and_backtest(tickers, days=730, debug=debug)
    except RuntimeError as e:
        print(f"Erreur : {e}")
        sys.exit(1)

    elapsed = time.time() - t0
    s = result.summary

    if s.get("status") != "ok":
        print(f"Aucun trade genere ({s.get('status')}).")
        sys.exit(0)

    print(f"\n  Trades : {s['n_trades']}  (W={s['n_wins']} / L={s['n_losses']})")
    print(f"  Win rate       : {s['win_rate_pct']}%  (break-even ~33% avec R/R=2.0)")
    print(f"  Expectancy     : {s['expectancy_pct']:+.2f}%  (ponderee : {s['expectancy_weighted']})")
    print(f"  Avg R realise  : {s['avg_r_realise']}")
    print(f"  Duree moy.     : {s['avg_holding_days']:.0f}j")
    print(f"  Return total   : {s['total_return_pct']:+.2f}%")
    print(f"  Capital final  : {s['final_capital']:,.0f} FCFA")
    print(f"  Max drawdown   : {s['max_drawdown_pct']:.1f}%")

    print(f"\n  Distribution des sorties :")
    for reason, stats in s.get("by_exit_reason", {}).items():
        print(f"    {reason:<20}  n={stats['n']}  PnL moy={stats['avg_pnl']:+.1f}%  {stats['avg_days']:.0f}j")

    if result.by_confiance:
        print(f"\n  Performance par confiance (C1) :")
        for conf, stats in result.by_confiance.items():
            print(
                f"    {conf:<12}  n={stats['n']}  "
                f"hit={stats['win_rate_pct']}%  "
                f"exp={stats['expectancy_pct']:+.2f}%  "
                f"{stats['avg_days']:.0f}j"
            )

    if result.by_ticker:
        print(f"\n  Top tickers (par PnL moyen) :")
        for ticker, stats in sorted(result.by_ticker.items(), key=lambda x: -x[1]["avg_pnl_pct"])[:10]:
            print(
                f"    {ticker:<8}  n={stats['n']}  "
                f"win={stats['win_rate_pct']}%  "
                f"avg={stats['avg_pnl_pct']:+.2f}%  "
                f"{stats['avg_days']:.0f}j"
            )

    print(f"\n  Duree execution : {elapsed:.1f}s")
    print("=" * 72)
