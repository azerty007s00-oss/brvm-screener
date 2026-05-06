"""
backtest.py - Backtest bi-mensuel BRVM (stratégie long-only).

Stratégie :
  - Revue de portefeuille toutes les REVIEW_INTERVAL_DAYS (défaut 14j)
  - Entrée uniquement sur signal ACHAT (pas de short - interdit sur la BRVM)
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
import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

import numpy as np
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
REVIEW_INTERVAL_DAYS  = 14     # revue bi-mensuelle (optimum TF-BRVM, frais ÷2 vs 7j)
MAX_HOLDING_DAYS      = 90     # durée max de détention (3 mois)
MAX_ATR_PCT           = 4.0    # ATR% max autorisé à l'entrée (filtre volatilité)
MIN_PRICE             = 500.0  # prix min en FCFA (exclut les penny stocks type ETIT)

# Tous les tickers actions (hors indices)
INDICES   = {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}
BLACKLIST = {"SPHC"}   # WR 20%, exp -2.01% sur 5 ans - exclu définitivement
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
    nb_actions:           int             = 0
    tp_active:            bool            = True
    original_stop_loss:   Optional[float] = None


@dataclass
class BacktestResult:
    trades:       pd.DataFrame
    equity_curve: pd.DataFrame
    summary:      dict
    by_ticker:    dict
    by_confiance: dict


# ─── Slippage / market impact ────────────────────────────────────────────────

def _apply_slippage(
    price: float,
    position_pct: float,
    volume_moy20: float | None,
    equity: float,
    price_per_share: float | None = None,
) -> float:
    """
    Modèle de market impact simplifié pour fixing BRVM illiquide.
    Si la position représente plus de 10% du volume moyen journalier,
    on pénalise le prix d'entrée proportionnellement.
    Impact max plafonné à 2% (cas extrêmes).
    """
    if volume_moy20 is None or volume_moy20 <= 0 or price <= 0:
        return price
    order_value = equity * position_pct / 100
    order_shares = order_value / price
    participation = order_shares / volume_moy20  # fraction du volume journalier
    # Impact linéaire : 0.5% par tranche de 10% du volume journalier
    impact_pct = min(participation * 0.05, 0.02)   # plafonné à 2%
    return price * (1 + impact_pct)


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
        # Frais BRVM réels : SGI ~0.5% + prélèvements ~0.15% chaque sens
        fee_entry_pct:        float             = 0.65,
        fee_exit_pct:         float             = 0.65,
        stop_tolerance_days:  int               = 3,
        regime_filter:        bool              = True,
        df_index:             Optional[pd.DataFrame] = None,
        tp_trail_signal:      bool              = False,
        trail_stop:           bool              = False,
        close_on_non_achat:   bool              = False,
        close_on_vente:       bool              = False,
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
        self.fee_entry_pct        = fee_entry_pct
        self.fee_exit_pct         = fee_exit_pct
        self.stop_tolerance_days  = stop_tolerance_days
        self.regime_filter        = regime_filter
        self.df_index             = df_index  # BRVMC OHLCV pour filtre regime
        self.tp_trail_signal      = tp_trail_signal
        self.trail_stop           = trail_stop
        self.close_on_non_achat   = close_on_non_achat
        self.close_on_vente       = close_on_vente
        self.debug                = debug or DEBUG_MODE

        self._open:    dict[str, Position] = {}
        self._closed:  list[Position]      = []
        self._equity:  float               = initial_capital
        self._equity_history: list[dict]   = []
        self._next_review: dict[str, date] = {}
        self._pending: dict[str, tuple]    = {}  # ticker → (score, ind, signal_date)

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

            # ── Exécution T+1 : entrées en attente du jour précédent ──────────
            for ticker, (pending_score, pending_ind, signal_date) in list(self._pending.items()):
                if ticker not in self._open:
                    ts_exec = pd.Timestamp(current_date)
                    if ticker in ticker_data and ts_exec in ticker_data[ticker].index:
                        bar = ticker_data[ticker].loc[ts_exec]
                        exec_price  = float(bar["close"])
                        exec_volume = float(bar.get("volume", 0))
                        if exec_volume == 0:
                            if self.debug:
                                print(f"  SKIP T+1 {current_date} {ticker} volume=0")
                            del self._pending[ticker]
                            continue
                        exec_price = _apply_slippage(
                            exec_price,
                            pending_score.position_size_pct,
                            pending_ind.volume_moy20,
                            self._equity,
                        )
                        self._open_position(ticker, pending_score, pending_ind,
                                            current_date, override_price=exec_price)
                del self._pending[ticker]

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
                        # 2. Stop / target - vérifié sur high/low intraday
                        self._check_stop_target(ticker, current_low, current_high, current_date)

                # ── Revue bi-mensuelle ────────────────────────────────────
                next_rev = self._next_review.get(ticker)
                if next_rev is None or current_date >= next_rev:
                    self._next_review[ticker] = current_date + timedelta(days=self.review_interval_days)

                    if ticker not in self._open:   # ticker libre → tenter une entrée
                        # Filtre régime marché
                        if not self._is_regime_ok(ts):
                            continue

                        # M2 - Fixing théorique : aucune transaction si volume=0
                        current_volume = float(current_bar.get("volume", 0))
                        if current_volume == 0:
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
                            # Stocker en attente → exécution au fixing J+1
                            self._pending[ticker] = (score, ind, current_date)
                        elif score.signal == "ACHAT" and self.debug:
                            reason = []
                            if ind.cours_actuel < self.min_price:
                                reason.append(f"prix trop bas ({ind.cours_actuel:.0f} < {self.min_price:.0f})")
                            if ind.atr_pct and ind.atr_pct > self.max_atr_pct:
                                reason.append(f"ATR trop eleve ({ind.atr_pct:.2f}% > {self.max_atr_pct:.1f}%)")
                            if reason:
                                print(f"  SKIP  {current_date}  {ticker:<8}  {' | '.join(reason)}")

                    elif ticker in self._open:
                        # Réévaluation du signal pour position ouverte
                        _need = self.trail_stop or self.close_on_non_achat or self.close_on_vente or self.tp_trail_signal
                        if _need:
                            try:
                                ind   = compute_indicators(df_slice, ticker=ticker, horizon=self.horizon)
                                score = compute_score(ind)
                                pos   = self._open[ticker]

                                if score.signal == "ACHAT":
                                    # tp_trail_signal : désactiver TP si forte/modérée
                                    if self.tp_trail_signal:
                                        pos.tp_active = score.confiance not in ("forte", "modérée")

                                    # Trailing stop : remonter le stop d'initial_risk sous le cours
                                    if self.trail_stop and pos.original_stop_loss is not None:
                                        initial_risk = pos.entry_price - pos.original_stop_loss
                                        if initial_risk > 0:
                                            new_stop = ind.cours_actuel - initial_risk
                                            if new_stop > pos.stop_loss:
                                                if self.debug:
                                                    print(
                                                        f"  TRAIL {current_date}  {ticker:<8}  "
                                                        f"stop {pos.stop_loss:,.0f} → {new_stop:,.0f}"
                                                    )
                                                pos.stop_loss = new_stop
                                else:
                                    # Signal ≠ ACHAT
                                    if self.tp_trail_signal:
                                        pos.tp_active = True
                                    if self.close_on_non_achat:
                                        self._close(
                                            ticker, ind.cours_actuel, current_date,
                                            f"signal_{score.signal.lower()}"
                                        )
                                    elif self.close_on_vente and score.signal == "VENTE":
                                        self._close(
                                            ticker, ind.cours_actuel, current_date,
                                            "signal_vente"
                                        )
                            except Exception:
                                pass

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
                # Stop normal suspendu - seul un stop extrême (2× distance) déclenche la sortie
                stop_distance = pos.entry_price - pos.stop_loss
                extreme_stop  = pos.stop_loss - stop_distance  # = 2*stop_loss - entry_price
                if low <= extreme_stop:
                    self._close(ticker, extreme_stop, current_date, "stop_extreme")
                elif ticker in self._open and pos.tp_active and high >= pos.take_profit:
                    self._close(ticker, pos.take_profit, current_date, "target")
                return

        stop_hit   = low  <= pos.stop_loss
        target_hit = pos.tp_active and high >= pos.take_profit
        # Si les deux sont touchés dans la même barre → priorité au stop (conservateur)
        if stop_hit:
            self._close(ticker, pos.stop_loss,   current_date, "stop")
        elif target_hit:
            self._close(ticker, pos.take_profit, current_date, "target")

    # ── Ouverture ────────────────────────────────────────────────────────────

    def _open_position(self, ticker, score, ind, current_date: date, override_price: float | None = None) -> None:
        entry_price = override_price if override_price is not None else ind.cours_actuel

        # BRVM : pas de fractions d'actions - arrondir au nombre entier inferieur
        nb_actions = math.floor(
            self._equity * (score.position_size_pct / 100) / entry_price
        ) if entry_price > 0 else 0

        if nb_actions == 0:
            if self.debug:
                print(
                    f"  SKIP  {current_date}  {ticker:<8}  "
                    f"capital insuffisant pour 1 action a {entry_price:,.0f} FCFA "
                    f"(alloc={score.position_size_pct:.1f}% de {self._equity:,.0f})"
                )
            return

        # Position reelle apres arrondi (toujours <= position_size_pct)
        capital_investi   = nb_actions * entry_price
        position_pct_reel = capital_investi / self._equity * 100

        rr = None
        if ind.atr and ind.atr > 0:
            k1 = abs(score.stop_loss  - entry_price) / ind.atr
            k2 = abs(score.take_profit - entry_price) / ind.atr
            rr = round(k2 / k1, 2) if k1 > 0 else None

        pos = Position(
            ticker              = ticker,
            entry_date          = current_date,
            entry_price         = entry_price,
            stop_loss           = score.stop_loss,
            take_profit         = score.take_profit,
            original_stop_loss  = score.stop_loss,
            rr                  = rr,
            position_pct        = position_pct_reel,
            nb_actions          = nb_actions,
            confiance           = score.confiance,
            score               = score.score_total,
            atr_pct             = ind.atr_pct,
            data_quality        = getattr(ind, "data_quality_flag", "ok"),
            equity_at_entry     = self._equity,
        )
        self._open[ticker] = pos

        if self.debug:
            print(
                f"  OPEN  {current_date}  {ticker:<8}  "
                f"score={score.score_total:+d}  conf={score.confiance:<9}  "
                f"stop={score.stop_loss:,.0f}  target={score.take_profit:,.0f}  "
                f"R/R={rr or '?'}  "
                f"{nb_actions} actions x {entry_price:,.0f} = {capital_investi:,.0f} FCFA "
                f"({position_pct_reel:.1f}%)"
            )

    # ── Clôture ──────────────────────────────────────────────────────────────

    def _close(self, ticker: str, exit_price: float, exit_date: date, reason: str) -> None:
        pos = self._open.pop(ticker)
        pos.exit_date    = exit_date
        pos.exit_price   = round(exit_price, 2)
        pos.exit_reason  = reason
        pos.holding_days = (exit_date - pos.entry_date).days

        # Frais asymétriques : entrée sur valeur d'achat, sortie sur valeur de vente
        raw_pnl        = (exit_price - pos.entry_price) / pos.entry_price * 100
        fee_entry_drag = self.fee_entry_pct
        fee_exit_drag  = self.fee_exit_pct * (exit_price / pos.entry_price)
        net_pnl        = raw_pnl - fee_entry_drag - fee_exit_drag
        pos.pnl_pct    = round(net_pnl, 2)

        risk_pct = abs(pos.entry_price - pos.stop_loss) / pos.entry_price * 100 if pos.stop_loss else 1.0
        pos.r_realise = round(pos.pnl_pct / risk_pct, 2) if risk_pct > 0 else None

        # Calcul exact en FCFA depuis le nombre entier d'actions
        # pnl_pct est deja net de frais - on l'applique au capital investi reel
        pos.capital_investi_fcfa = round(pos.nb_actions * pos.entry_price, 0)
        pos.gain_fcfa            = round(pos.capital_investi_fcfa * pos.pnl_pct / 100, 0)
        pos.capital_gain_pct     = round(pos.gain_fcfa / pos.equity_at_entry * 100, 4) if pos.equity_at_entry > 0 else 0.0
        self._equity            += pos.gain_fcfa

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
    # Frais BRVM réels : SGI ~0.5% + prélèvements ~0.15% chaque sens
    fee_entry_pct:        float          = 0.65,
    fee_exit_pct:         float          = 0.65,
    stop_tolerance_days:  int            = 3,
    regime_filter:        bool           = True,
    df_index:             Optional[pd.DataFrame] = None,
    tp_trail_signal:      bool           = False,
    trail_stop:           bool           = False,
    close_on_non_achat:   bool           = False,
    close_on_vente:       bool           = False,
    debug:                bool           = False,
    benchmark_series:     Optional[pd.Series] = None,
) -> BacktestResult:
    result = BacktestEngine(
        initial_capital      = initial_capital,
        horizon              = horizon,
        warmup_bars          = warmup_bars,
        review_interval_days = review_interval_days,
        max_holding_days     = max_holding_days,
        max_atr_pct          = max_atr_pct,
        min_atr_pct          = min_atr_pct,
        min_price            = min_price,
        confiance_filter     = confiance_filter,
        fee_entry_pct        = fee_entry_pct,
        fee_exit_pct         = fee_exit_pct,
        stop_tolerance_days  = stop_tolerance_days,
        regime_filter        = regime_filter,
        df_index             = df_index,
        tp_trail_signal      = tp_trail_signal,
        trail_stop           = trail_stop,
        close_on_non_achat   = close_on_non_achat,
        close_on_vente       = close_on_vente,
        debug                = debug,
    ).run(ticker_data)

    # E1 - Métriques de risque complètes sur la courbe d'équité
    if len(result.equity_curve) >= 2:
        equity = result.equity_curve.set_index("date")["equity"]
        metrics = _compute_metrics(equity)
        result.summary.update(metrics)

        # E2 - Comparaison indice BRVM Composite (si fourni)
        if benchmark_series is not None and len(benchmark_series) >= 2:
            bench_metrics = _compute_metrics(benchmark_series)
            result.summary["benchmark_total_return"] = bench_metrics["total_return"]
            result.summary["benchmark_cagr"]         = bench_metrics["cagr"]
            result.summary["benchmark_sharpe"]       = bench_metrics["sharpe"]
            result.summary["alpha"] = round(metrics["cagr"] - bench_metrics["cagr"], 4)

            strat_rets = equity.pct_change().dropna()
            bench_rets = benchmark_series.pct_change().dropna()
            common_idx = strat_rets.index.intersection(bench_rets.index)
            if len(common_idx) > 1:
                s = strat_rets.loc[common_idx].values
                b = bench_rets.loc[common_idx].values
                var_b = float(np.var(b, ddof=1))
                if var_b > 0:
                    result.summary["beta"] = round(float(np.cov(s, b)[0, 1] / var_b), 4)

    return result


def fetch_and_backtest(
    tickers:     list[str],
    days:        int = 730,
    data_period: str = "daily",
    **kwargs,
) -> BacktestResult:
    from scraper import get_ohlcv, TickerNotFoundError, InsufficientDataError

    # Données mensuelles : 60 barres = 5 ans
    if data_period == "monthly" and days == 730:
        days = 60

    ticker_data: dict[str, pd.DataFrame] = {}
    for ticker in tickers:
        try:
            df = get_ohlcv(ticker, days=days, period=data_period)
            ticker_data[ticker] = df
            logger.info(f"[Backtest] {ticker} - {len(df)} barres ({data_period})")
        except (TickerNotFoundError, InsufficientDataError) as exc:
            logger.warning(f"[Backtest] {ticker} ignore - {exc}")
        except Exception as exc:
            logger.warning(f"[Backtest] {ticker} erreur fetch - {exc}")

    if not ticker_data:
        raise RuntimeError("Aucun ticker disponible pour le backtest")

    # Récupérer BRVMC pour le filtre régime si non fourni
    if kwargs.get("regime_filter", True) and kwargs.get("df_index") is None:
        try:
            kwargs["df_index"] = get_ohlcv("BRVMC", days=days, period=data_period)
        except Exception:
            pass

    # Adapter les paramètres à l'horizon et au mode données
    from config import HORIZON_PROFILES
    horizon = kwargs.get("horizon", "Moyen terme")
    hp = HORIZON_PROFILES.get(horizon, {})
    if "max_holding_days" not in kwargs:
        base_hold = hp.get("max_holding_days", MAX_HOLDING_DAYS)
        kwargs["max_holding_days"] = base_hold * 2 if data_period == "monthly" else base_hold
    if "review_interval_days" not in kwargs:
        kwargs["review_interval_days"] = 30 if data_period == "monthly" else hp.get("review_interval_days", REVIEW_INTERVAL_DAYS)
    if "warmup_bars" not in kwargs:
        kwargs["warmup_bars"] = 12 if data_period == "monthly" else WARMUP_BARS
    if data_period == "monthly":
        # Monthly ATR% est naturellement 5-15× plus élevé qu'en daily → seuils adaptés
        if "max_atr_pct" not in kwargs:
            kwargs["max_atr_pct"] = 25.0   # filtre seulement les valeurs extrêmement volatiles
        if "min_atr_pct" not in kwargs:
            kwargs["min_atr_pct"] = 3.0    # minimum de mouvement mensuel

    data_period = kwargs.pop("data_period", data_period)  # absorbe si passé via **kwargs (cache .pyc)

    # Réappliquer la logique mensuelle au cas où data_period venait de kwargs
    if data_period == "monthly":
        if "max_atr_pct" not in kwargs:
            kwargs["max_atr_pct"] = 25.0
        if "min_atr_pct" not in kwargs:
            kwargs["min_atr_pct"] = 3.0

    return run_backtest(ticker_data, **kwargs)


def walk_forward_backtest(
    ticker_data: dict[str, pd.DataFrame],
    n_splits: int = 3,
    train_ratio: float = 0.7,
    **kwargs,
) -> list[BacktestResult]:
    """
    Walk-forward backtest : divise la période en n_splits fenêtres,
    entraîne sur train_ratio de chaque fenêtre, teste sur le reste.

    Évite le biais de suroptimisation d'un backtest full-period.

    Args:
        ticker_data:  Données OHLCV par ticker
        n_splits:     Nombre de fenêtres (défaut 3)
        train_ratio:  Part de chaque fenêtre utilisée pour "train" (info)
        **kwargs:     Paramètres passés à run_backtest()

    Returns:
        Liste de BacktestResult (un par fenêtre de test)
    """
    if not ticker_data:
        raise ValueError("ticker_data vide")

    # Collecter toutes les dates disponibles
    all_dates = sorted({
        idx.date() if hasattr(idx, "date") else idx
        for df in ticker_data.values()
        for idx in df.index
    })
    if len(all_dates) < 60:
        raise ValueError("Pas assez de données pour walk-forward (min 60j)")

    total = len(all_dates)
    window = total // n_splits
    results = []

    for i in range(n_splits):
        start_i = i * window
        end_i   = start_i + window if i < n_splits - 1 else total
        split_dates = all_dates[start_i:end_i]
        test_start  = split_dates[int(len(split_dates) * train_ratio)]

        # Filtrer les données sur la fenêtre de test uniquement
        test_data = {}
        for ticker, df in ticker_data.items():
            mask = df.index >= pd.Timestamp(test_start)
            mask &= df.index <= pd.Timestamp(split_dates[-1])
            if mask.sum() >= 30:
                test_data[ticker] = df[mask]

        if not test_data:
            logger.warning(f"[WalkForward] Fenêtre {i+1} : aucun ticker valide")
            continue

        logger.info(
            f"[WalkForward] Fenêtre {i+1}/{n_splits} : "
            f"test du {test_start} au {split_dates[-1]} "
            f"({len(test_data)} tickers)"
        )
        try:
            r = run_backtest(test_data, **kwargs)
            results.append(r)
        except Exception as e:
            logger.warning(f"[WalkForward] Fenêtre {i+1} échouée : {e}")

    return results


# ─── Monte Carlo ─────────────────────────────────────────────────────────────

def monte_carlo_permutation(
    result: BacktestResult,
    n_simulations: int = 1000,
    risk_free: float = 0.035,
    seed: int = 42,
) -> dict:
    """
    Teste si le Sharpe de la stratégie est statistiquement significatif.
    Permute aléatoirement les rendements journaliers N fois,
    calcule le Sharpe de chaque permutation, compare à la stratégie réelle.

    Retourne :
      sharpe_reel     : float
      sharpe_median_mc: float  (médiane des Sharpe permutés)
      p_value         : float  (fraction des simulations ≥ Sharpe réel)
      significatif_95 : bool   (p_value < 0.05)
    """
    if result.equity_curve.empty or len(result.equity_curve) < 10:
        return {"erreur": "Données insuffisantes pour Monte Carlo"}

    equity = result.equity_curve.set_index("date")["equity"]
    rets = equity.pct_change().dropna().values
    if len(rets) < 5:
        return {"erreur": "Historique trop court"}

    real_metrics = _compute_metrics(pd.Series(rets).cumsum().apply(lambda x: 1 + x),
                                    risk_free=risk_free)
    real_sharpe = real_metrics["sharpe"]

    rng = np.random.default_rng(seed)
    mc_sharpes = []
    for _ in range(n_simulations):
        perm = rng.permutation(rets)
        eq_sim = pd.Series(np.cumprod(1 + perm))
        m = _compute_metrics(eq_sim, risk_free=risk_free)
        mc_sharpes.append(m["sharpe"])

    mc_arr = np.array(mc_sharpes)
    p_value = float(np.mean(mc_arr >= real_sharpe))

    return {
        "sharpe_reel":      round(real_sharpe, 3),
        "sharpe_median_mc": round(float(np.median(mc_arr)), 3),
        "sharpe_p10_mc":    round(float(np.percentile(mc_arr, 10)), 3),
        "sharpe_p90_mc":    round(float(np.percentile(mc_arr, 90)), 3),
        "p_value":          round(p_value, 3),
        "significatif_95":  p_value < 0.05,
        "n_simulations":    n_simulations,
    }


# ─── Métriques de risque ─────────────────────────────────────────────────────

def _compute_metrics(equity_curve: pd.Series, risk_free: float = 0.035) -> dict:
    """
    equity_curve : série indexée par date, valeurs = valeur du portefeuille
    risk_free     : taux sans risque annuel (OAT UEMOA ≈ 3.5 %)
    Retourne : total_return, cagr, sharpe, sortino, max_drawdown, calmar
    """
    rets = equity_curve.pct_change().dropna()
    n_days = len(equity_curve)
    years = n_days / 252

    total_return = equity_curve.iloc[-1] / equity_curve.iloc[0] - 1
    cagr = (1 + total_return) ** (1 / years) - 1 if years > 0 else 0.0

    excess = rets - risk_free / 252
    sharpe = float(excess.mean() / rets.std() * (252 ** 0.5)) if rets.std() > 0 else 0.0

    downside = rets[rets < 0].std()
    sortino = float(excess.mean() / downside * (252 ** 0.5)) if downside > 0 else 0.0

    roll_max = equity_curve.cummax()
    drawdown = (equity_curve - roll_max) / roll_max
    max_drawdown = float(drawdown.min())

    calmar = float(cagr / abs(max_drawdown)) if max_drawdown != 0 else 0.0

    return {
        "total_return": round(float(total_return), 4),
        "cagr":         round(float(cagr),         4),
        "sharpe":       round(sharpe,               4),
        "sortino":      round(sortino,              4),
        "max_drawdown": round(max_drawdown,         4),
        "calmar":       round(calmar,               4),
    }


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
            "nb_actions":           p.nb_actions,
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

def _print_result(s: dict, result: BacktestResult, label: str = "") -> None:
    tag = f"  [{label}]" if label else " "
    if s.get("status") != "ok":
        print(f"{tag} Aucun trade genere ({s.get('status')}).")
        return
    print(f"\n{tag} Trades : {s['n_trades']}  (W={s['n_wins']} / L={s['n_losses']})")
    print(f"{tag} Win rate       : {s['win_rate_pct']}%")
    print(f"{tag} Expectancy     : {s['expectancy_pct']:+.2f}%  (ponderee : {s['expectancy_weighted']})")
    print(f"{tag} Avg R realise  : {s['avg_r_realise']}")
    print(f"{tag} Duree moy.     : {s['avg_holding_days']:.0f}j")
    print(f"{tag} Return total   : {s['total_return_pct']:+.2f}%")
    print(f"{tag} Capital final  : {s['final_capital']:,.0f} FCFA")
    print(f"{tag} Max drawdown   : {s['max_drawdown_pct']:.1f}%")
    print(f"{tag} Sorties :")
    for reason, stats in s.get("by_exit_reason", {}).items():
        print(f"{tag}   {reason:<20}  n={stats['n']}  PnL moy={stats['avg_pnl']:+.1f}%  {stats['avg_days']:.0f}j")
    if result.by_confiance:
        print(f"{tag} Par confiance :")
        for conf, stats in result.by_confiance.items():
            print(f"{tag}   {conf:<12}  n={stats['n']}  hit={stats['win_rate_pct']}%  exp={stats['expectancy_pct']:+.2f}%  {stats['avg_days']:.0f}j")


if __name__ == "__main__":
    import sys
    import time

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    args    = sys.argv[1:]
    debug   = "--debug" in args
    compare = "--compare" in args
    trail   = "--trail" in args or compare
    monthly = "--monthly" in args
    tickers_arg = [a for a in args if not a.startswith("--")]
    tickers = tickers_arg if tickers_arg else ALL_TICKERS

    _days   = 60  if monthly else 730
    _period = "monthly" if monthly else "daily"

    print(f"\nBACKTEST BRVM (long-only, revue /{REVIEW_INTERVAL_DAYS}j, {_period})")
    print(f"Tickers : {len(tickers)} | Horizon : {DEFAULT_HORIZON} | Warmup : {WARMUP_BARS} barres")
    print("=" * 72)

    def _run(label, **kw):
        t0 = time.time()
        try:
            r = fetch_and_backtest(tickers, days=_days, data_period=_period, debug=debug, **kw)
        except RuntimeError as e:
            print(f"Erreur {label} : {e}"); sys.exit(1)
        _print_result(r.summary, r, label)
        print(f"  Duree : {time.time()-t0:.1f}s")
        return r

    def _delta(label, sn, sb):
        if sb.get("status") != "ok" or sn.get("status") != "ok":
            return
        print(f"\n>>> DELTA ({label} − BASELINE)")
        print(f"  Expectancy   : {sn['expectancy_pct']:+.2f}%  vs  {sb['expectancy_pct']:+.2f}%"
              f"  d={sn['expectancy_pct']-sb['expectancy_pct']:+.2f}%")
        print(f"  Win rate     : {sn['win_rate_pct']:.1f}%  vs  {sb['win_rate_pct']:.1f}%"
              f"  d={sn['win_rate_pct']-sb['win_rate_pct']:+.1f}%")
        print(f"  Return total : {sn['total_return_pct']:+.2f}%  vs  {sb['total_return_pct']:+.2f}%"
              f"  d={sn['total_return_pct']-sb['total_return_pct']:+.2f}%")
        print(f"  Max drawdown : {sn['max_drawdown_pct']:.1f}%  vs  {sb['max_drawdown_pct']:.1f}%"
              f"  d={sn['max_drawdown_pct']-sb['max_drawdown_pct']:+.1f}%")
        print(f"  Duree moy.   : {sn['avg_holding_days']:.0f}j  vs  {sb['avg_holding_days']:.0f}j  "
              f"  N={sn['n_trades']} vs {sb['n_trades']}")

    if compare:
        print("\n>>> BASELINE (stop fixe, sortie timeout/stop/target)")
        r_base = _run("BASELINE")
        print("\n>>> TRAIL_ONLY (trailing stop, pas de sortie signal)")
        r_trail = _run("TRAIL_ONLY", trail_stop=True)
        print("\n>>> TRAIL+VENTE (trailing stop + sortie sur VENTE uniquement)")
        r_tv = _run("TRAIL+VENTE", trail_stop=True, close_on_vente=True)
        print("\n>>> TRAIL+NEUTRE (trailing stop + sortie sur NEUTRE ou VENTE)")
        r_tn = _run("TRAIL+NEUTRE", trail_stop=True, close_on_non_achat=True)
        sb = r_base.summary
        _delta("TRAIL_ONLY",   r_trail.summary, sb)
        _delta("TRAIL+VENTE",  r_tv.summary,    sb)
        _delta("TRAIL+NEUTRE", r_tn.summary,    sb)
    else:
        t0 = time.time()
        try:
            result = fetch_and_backtest(
                tickers, days=_days, data_period=_period,
                trail_stop=trail, close_on_non_achat=trail, debug=debug
            )
        except RuntimeError as e:
            print(f"Erreur : {e}"); sys.exit(1)
        elapsed = time.time() - t0
        label = "TRAIL+SIGNAL" if trail else "BASELINE"
        _print_result(result.summary, result, label)
        if result.by_ticker:
            print(f"\n  Top tickers (par PnL moyen) :")
            for ticker, stats in sorted(result.by_ticker.items(), key=lambda x: -x[1]["avg_pnl_pct"])[:10]:
                print(f"    {ticker:<8}  n={stats['n']}  win={stats['win_rate_pct']}%  avg={stats['avg_pnl_pct']:+.2f}%  {stats['avg_days']:.0f}j")
        print(f"\n  Duree execution : {elapsed:.1f}s")
    print("=" * 72)
