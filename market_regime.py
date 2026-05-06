"""
market_regime.py - Régime de marché BRVM (Phase 3).

Mesure la breadth du marché sur les 46 titres de l'univers BRVM pour
classifier le régime macrostructurel :

  BULL_BROAD   ≥ 65 % titres > MA50  ET ≥ 55 % titres > MA200
  BULL_NARROW  ≥ 50 % titres > MA50  (breadth insuffisante pour BULL_BROAD)
  RANGE        ≥ 35 % titres > MA50
  BEAR_NARROW  ≥ 20 % titres > MA50
  BEAR_BROAD   < 20 % titres > MA50

Architecture :
  - Fonctions pures (testables sans réseau) :
      classify_market_regime(), sector_strength(), apply_regime_adjustment(),
      _compute_ticker_signals()
  - Fonction réseau :
      compute_market_breadth(fetch_fn, tickers, days)
  - Cache module-level (singleton) :
      set_current_regime(), get_cached_regime(), get_cached_breadth()

Intégration scoring.py (hook additif) :
  apply_regime_adjustment(result, regime) → ScoreResult
    BEAR_BROAD  : signal ACHAT → NEUTRE  (marché général défavorable)
    BULL_BROAD  : signal VENTE → NEUTRE  (marché général porteur)

Intégration app.py (1 ajout) :
  get_cached_regime() → str (affichage sidebar)
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Optional

import numpy as np
import pandas as pd

from config import (
    REGIME_MA50_THRESHOLDS,
    REGIME_MA200_BULL_BROAD_MIN,
    REGIME_52W_PROXIMITY_PCT,
    TICKER_GROUPS,
    TICKER_TO_SIKA_ID,
)

logger = logging.getLogger(__name__)

# Indices exclus du calcul de breadth
_INDEX_TICKERS: frozenset[str] = frozenset(
    {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}
)

# Minimum de barres pour calculer MA50
_MIN_BARS_MA50: int = 50
_MIN_BARS_MA200: int = 100   # on accepte MA100 en fallback


# ─── Dataclasses ──────────────────────────────────────────────────────────────

@dataclass
class TickerSignal:
    """Signaux de breadth pour un seul ticker."""
    ticker: str
    above_ma50: Optional[bool] = None    # prix > MA50
    above_ma200: Optional[bool] = None   # prix > MA200 (ou MA100 fallback)
    near_52w_high: Optional[bool] = None # prix ≥ 95 % du plus haut 52w
    near_52w_low: Optional[bool] = None  # prix ≤ 105 % du plus bas 52w
    current_price: float = 0.0
    error: Optional[str] = None


@dataclass
class MarketBreadth:
    """Métriques agrégées de breadth sur l'univers BRVM."""

    computed_at: str = ""              # Horodatage ISO
    nb_tickers_total: int = 0          # Tickers dans l'univers
    nb_tickers_analyzed: int = 0       # Tickers traités avec succès

    pct_above_ma50: float = 0.0        # % titres > MA50
    pct_above_ma200: float = 0.0       # % titres > MA200 (ou MA100)
    advance_decline_ratio: float = 0.0 # advance / decline (∞ si 0 déclinants)
    pct_near_52w_high: float = 0.0     # % titres proches du plus haut 52w
    pct_near_52w_low: float = 0.0      # % titres proches du plus bas 52w

    regime: str = "INCONNU"            # Classification finale

    # Détail par ticker (pour sector_strength et UI)
    ticker_signals: dict = field(default_factory=dict)  # {ticker: TickerSignal}

    # Forces par groupe sectoriel
    sector_scores: dict = field(default_factory=dict)   # {group: pct_above_ma50}

    # Tickers dont le fetch a échoué
    error_tickers: list = field(default_factory=list)


# ─── Cache module-level (singleton) ──────────────────────────────────────────

_cache: dict = {"regime": None, "breadth": None}


def set_current_regime(regime: str, breadth: Optional[MarketBreadth] = None) -> None:
    """Enregistre le régime courant dans le cache module-level."""
    _cache["regime"] = regime
    _cache["breadth"] = breadth
    logger.info("[Régime] Cache mis à jour → %s", regime)


def get_cached_regime() -> Optional[str]:
    """Retourne le régime courant depuis le cache, ou None si non calculé."""
    return _cache.get("regime")


def get_cached_breadth() -> Optional[MarketBreadth]:
    """Retourne la MarketBreadth complète depuis le cache."""
    return _cache.get("breadth")


# ─── Helpers de calcul (purs, sans réseau) ────────────────────────────────────

def _compute_ticker_signals(df: pd.DataFrame, ticker: str) -> TickerSignal:
    """
    Calcule les signaux de breadth pour un seul ticker.

    Standalone - n'appelle pas compute_indicators() pour rester léger
    et éviter les dépendances circulaires.

    Args:
        df:     DataFrame OHLCV (index DatetimeIndex, colonne 'close' requise).
        ticker: Symbole.

    Returns:
        TickerSignal. Si données insuffisantes, above_ma50=None.
    """
    sig = TickerSignal(ticker=ticker)

    if df is None or len(df) == 0:
        sig.error = "DataFrame vide"
        return sig

    df = df.copy()
    df.columns = [c.lower() for c in df.columns]

    if "close" not in df.columns:
        sig.error = "Colonne 'close' manquante"
        return sig

    close = df["close"].sort_index().dropna()
    n = len(close)

    if n < _MIN_BARS_MA50:
        sig.error = f"Seulement {n} barres (min {_MIN_BARS_MA50} pour MA50)"
        return sig

    current = float(close.iloc[-1])
    sig.current_price = current

    # MA50
    ma50 = float(close.rolling(_MIN_BARS_MA50).mean().iloc[-1])
    if pd.notna(ma50) and ma50 > 0:
        sig.above_ma50 = current > ma50

    # MA200 ou MA100 fallback
    if n >= 200:
        ma_lt = float(close.rolling(200).mean().iloc[-1])
    elif n >= _MIN_BARS_MA200:
        ma_lt = float(close.rolling(_MIN_BARS_MA200).mean().iloc[-1])
    else:
        ma_lt = float("nan")

    if pd.notna(ma_lt) and ma_lt > 0:
        sig.above_ma200 = current > ma_lt

    # 52 semaines (≈ 252 séances, ou toute la série si plus courte)
    year_window = min(252, n)
    high_52w = float(close.iloc[-year_window:].max())
    low_52w  = float(close.iloc[-year_window:].min())

    prox = REGIME_52W_PROXIMITY_PCT / 100.0
    if high_52w > 0:
        sig.near_52w_high = current >= high_52w * (1.0 - prox)
    if low_52w > 0:
        sig.near_52w_low = current <= low_52w * (1.0 + prox)

    return sig


def classify_market_regime(breadth: "MarketBreadth") -> str:
    """
    Classifie le régime à partir d'une MarketBreadth.

    Classification séquentielle (premier critère vrai gagne) :
      pct_above_ma50 ≥ 65% ET pct_above_ma200 ≥ 55% → BULL_BROAD
      pct_above_ma50 ≥ 50%                           → BULL_NARROW
      pct_above_ma50 ≥ 35%                           → RANGE
      pct_above_ma50 ≥ 20%                           → BEAR_NARROW
      sinon                                          → BEAR_BROAD

    Args:
        breadth: MarketBreadth avec pct_above_ma50 et pct_above_ma200 peuplés.

    Returns:
        Chaîne de régime.
    """
    t = REGIME_MA50_THRESHOLDS

    if (
        breadth.pct_above_ma50 >= t["BULL_BROAD"]
        and breadth.pct_above_ma200 >= REGIME_MA200_BULL_BROAD_MIN
    ):
        return "BULL_BROAD"
    if breadth.pct_above_ma50 >= t["BULL_NARROW"]:
        return "BULL_NARROW"
    if breadth.pct_above_ma50 >= t["RANGE"]:
        return "RANGE"
    if breadth.pct_above_ma50 >= t["BEAR_NARROW"]:
        return "BEAR_NARROW"
    return "BEAR_BROAD"


def sector_strength(
    ticker_signals: dict,
    ticker_groups: Optional[dict] = None,
) -> dict:
    """
    Agrège le % de titres > MA50 par groupe sectoriel (TICKER_GROUPS).

    Exclut les groupes d'indices (noms contenant "Indices").

    Args:
        ticker_signals: Dict {ticker: TickerSignal}.
        ticker_groups:  Dict {group_label: [tickers]}. Défaut : config.TICKER_GROUPS.

    Returns:
        Dict {group_label: pct_above_ma50 (0-100)} trié par score décroissant.
        Retourne 0.0 si le groupe n'a aucun ticker avec signal valide.
    """
    if ticker_groups is None:
        ticker_groups = TICKER_GROUPS

    scores: dict[str, float] = {}

    for group, tickers in ticker_groups.items():
        # Exclure les groupes d'indices (pas de logique MA50 sur un indice composite)
        if "Indic" in group:
            continue

        valid = [
            sig
            for t in tickers
            if (sig := ticker_signals.get(t)) is not None
            and sig.above_ma50 is not None
        ]
        if not valid:
            scores[group] = 0.0
            continue

        n_above = sum(1 for s in valid if s.above_ma50)
        scores[group] = round(100.0 * n_above / len(valid), 1)

    # Trier par score décroissant
    return dict(sorted(scores.items(), key=lambda x: x[1], reverse=True))


# ─── Orchestrateur réseau ─────────────────────────────────────────────────────

def compute_market_breadth(
    fetch_fn: Callable[[str, int], Optional[pd.DataFrame]],
    tickers: Optional[list] = None,
    days: int = 365,
) -> MarketBreadth:
    """
    Calcule la breadth du marché BRVM en fetchant tous les tickers.

    Met à jour automatiquement le cache module-level via set_current_regime().

    Args:
        fetch_fn: Callable(ticker, days) → DataFrame OHLCV.
        tickers:  Univers d'analyse. Défaut : TICKER_TO_SIKA_ID sans indices.
        days:     Fenêtre de données à récupérer.

    Returns:
        MarketBreadth complète avec régime classifié.
    """
    if tickers is None:
        tickers = [t for t in TICKER_TO_SIKA_ID if t not in _INDEX_TICKERS]

    breadth = MarketBreadth(
        computed_at=datetime.now().isoformat(timespec="minutes"),
        nb_tickers_total=len(tickers),
    )

    ticker_signals: dict[str, TickerSignal] = {}
    error_tickers: list[str] = []

    for ticker in tickers:
        logger.info("[Régime] %s - fetch %dj...", ticker, days)
        try:
            df = fetch_fn(ticker, days)
            sig = _compute_ticker_signals(df, ticker)
        except Exception as exc:
            logger.warning("[Régime] %s - erreur : %s", ticker, exc)
            sig = TickerSignal(ticker=ticker, error=str(exc))

        ticker_signals[ticker] = sig
        if sig.error:
            error_tickers.append(ticker)

    breadth.error_tickers = error_tickers
    breadth.ticker_signals = ticker_signals

    # Agréger les signaux valides
    valid_ma50   = [s for s in ticker_signals.values() if s.above_ma50 is not None]
    valid_ma200  = [s for s in ticker_signals.values() if s.above_ma200 is not None]
    valid_52wh   = [s for s in ticker_signals.values() if s.near_52w_high is not None]
    valid_52wl   = [s for s in ticker_signals.values() if s.near_52w_low is not None]

    n_analyzed = len(valid_ma50)
    breadth.nb_tickers_analyzed = n_analyzed

    if n_analyzed > 0:
        n_above_ma50  = sum(1 for s in valid_ma50 if s.above_ma50)
        breadth.pct_above_ma50 = round(100.0 * n_above_ma50 / n_analyzed, 1)

        n_below = n_analyzed - n_above_ma50
        breadth.advance_decline_ratio = (
            round(n_above_ma50 / n_below, 2) if n_below > 0 else float("inf")
        )

    if valid_ma200:
        n_above_ma200 = sum(1 for s in valid_ma200 if s.above_ma200)
        breadth.pct_above_ma200 = round(100.0 * n_above_ma200 / len(valid_ma200), 1)

    if valid_52wh:
        breadth.pct_near_52w_high = round(
            100.0 * sum(1 for s in valid_52wh if s.near_52w_high) / len(valid_52wh), 1
        )
    if valid_52wl:
        breadth.pct_near_52w_low = round(
            100.0 * sum(1 for s in valid_52wl if s.near_52w_low) / len(valid_52wl), 1
        )

    breadth.sector_scores = sector_strength(ticker_signals)
    breadth.regime = classify_market_regime(breadth) if n_analyzed > 0 else "INCONNU"

    set_current_regime(breadth.regime, breadth)

    logger.info(
        "[Régime] %s - MA50=%.1f%% MA200=%.1f%% A/D=%.2f (%d/%d titres)",
        breadth.regime,
        breadth.pct_above_ma50,
        breadth.pct_above_ma200,
        breadth.advance_decline_ratio,
        n_analyzed,
        len(tickers),
    )
    return breadth


# ─── Hook scoring ──────────────────────────────────────────────────────────────

def apply_regime_adjustment(result, regime: str):
    """
    Dégrade le signal d'un cran selon le régime de marché.

    Règles :
      BEAR_BROAD + ACHAT → NEUTRE  (vague baissière générale contre le signal)
      BULL_BROAD + VENTE → NEUTRE  (vague haussière générale contre le signal)
      Autres régimes     → signal inchangé

    Appelé depuis compute_score() via un hook try/except dans scoring.py.

    Args:
        result: ScoreResult (modifié en place si nécessaire).
        regime: Régime courant (string).

    Returns:
        ScoreResult (éventuellement modifié).
    """
    if regime == "BEAR_BROAD" and result.signal == "ACHAT":
        logger.debug(
            "[Régime] %s ACHAT → NEUTRE (BEAR_BROAD)", result.ticker
        )
        result.signal       = "NEUTRE"
        result.signal_emoji = "🟡"
        result.signal_color = "#BA7517"

    elif regime == "BULL_BROAD" and result.signal == "VENTE":
        logger.debug(
            "[Régime] %s VENTE → NEUTRE (BULL_BROAD)", result.ticker
        )
        result.signal       = "NEUTRE"
        result.signal_emoji = "🟡"
        result.signal_color = "#BA7517"

    return result
