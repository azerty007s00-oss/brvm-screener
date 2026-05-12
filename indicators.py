"""
indicators.py - Calcul des indicateurs techniques sur données OHLCV BRVM.

Implémentation pure pandas/numpy (sans pandas-ta) pour compatibilité Python 3.10-3.13.
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

from config import (
    BOLLINGER_STD,
    VOLUME_AVG_PERIOD,
    HORIZON_PROFILES,
    DEFAULT_HORIZON,
    is_brvm_holiday,
)

logger = logging.getLogger(__name__)


# ─── Fonctions d'indicateurs purs (remplacement pandas-ta) ───────────────────

def _calc_rsi(close: pd.Series, length: int = 14) -> pd.Series:
    """Calcule le RSI (Relative Strength Index) de Wilder."""
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)

    # Moyenne exponentielle de Wilder (alpha = 1/length)
    avg_gain = gain.ewm(alpha=1 / length, min_periods=length, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / length, min_periods=length, adjust=False).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi


def _calc_sma(close: pd.Series, length: int) -> pd.Series:
    """Calcule une Moyenne Mobile Simple."""
    return close.rolling(window=length, min_periods=length).mean()


def _calc_ema(close: pd.Series, length: int) -> pd.Series:
    """Calcule une Moyenne Mobile Exponentielle."""
    return close.ewm(span=length, min_periods=length, adjust=False).mean()


def _calc_macd(
    close: pd.Series,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """
    Calcule le MACD, la ligne signal et l'histogramme.

    Returns:
        (macd_line, signal_line, histogram)
    """
    ema_fast = _calc_ema(close, fast)
    ema_slow = _calc_ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, min_periods=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def _calc_bbands(
    close: pd.Series,
    length: int = 20,
    std: float = 2.0,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """
    Calcule les Bandes de Bollinger.

    Returns:
        (upper, middle, lower)
    """
    middle = _calc_sma(close, length)
    rolling_std = close.rolling(window=length, min_periods=length).std()
    upper = middle + std * rolling_std
    lower = middle - std * rolling_std
    return upper, middle, lower


# ─── Dataclass résultat ───────────────────────────────────────────────────────

def _calc_stochastic(
    high: pd.Series, low: pd.Series, close: pd.Series,
    k_period: int = 14, d_period: int = 3,
) -> tuple[pd.Series, pd.Series]:
    """Calcule le Stochastic Oscillator (%K et %D)."""
    lowest_low = low.rolling(window=k_period, min_periods=k_period).min()
    highest_high = high.rolling(window=k_period, min_periods=k_period).max()
    denom = highest_high - lowest_low
    k = 100 * (close - lowest_low) / denom.replace(0, np.nan)
    d = k.rolling(window=d_period, min_periods=d_period).mean()
    return k, d


def _calc_adx(
    high: pd.Series, low: pd.Series, close: pd.Series,
    length: int = 14,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Calcule l'ADX, +DI et -DI."""
    prev_close = close.shift(1)
    tr1 = high - low
    tr2 = (high - prev_close).abs()
    tr3 = (low - prev_close).abs()
    tr = pd.Series(
        np.maximum(tr1.values, np.maximum(tr2.values, tr3.values)),
        index=high.index,
    )

    plus_dm = high.diff()
    minus_dm = -low.diff()
    plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0.0)
    minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0.0)

    alpha = 1.0 / length
    atr = tr.ewm(alpha=alpha, min_periods=length, adjust=False).mean()
    plus_di = 100 * plus_dm.ewm(alpha=alpha, min_periods=length, adjust=False).mean() / atr.replace(0, np.nan)
    minus_di = 100 * minus_dm.ewm(alpha=alpha, min_periods=length, adjust=False).mean() / atr.replace(0, np.nan)

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.ewm(alpha=alpha, min_periods=length, adjust=False).mean()

    return adx, plus_di, minus_di


def _calc_atr(
    high: pd.Series, low: pd.Series, close: pd.Series,
    period: int = 14,
) -> Optional[pd.Series]:
    """ATR de Wilder - formule identique à _calc_adx pour cohérence interne."""
    if len(close) < period + 1:
        return None
    prev_close = close.shift(1)
    tr1 = high - low
    tr2 = (high - prev_close).abs()
    tr3 = (low - prev_close).abs()
    tr = pd.Series(
        np.maximum(tr1.values, np.maximum(tr2.values, tr3.values)),
        index=high.index,
    )
    return tr.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()


@dataclass
class TechnicalIndicators:
    """Conteneur structuré pour tous les indicateurs calculés."""

    ticker: str

    # Horizon d'analyse utilisé
    horizon: str = "Moyen terme"

    # Prix actuels
    cours_actuel: float = 0.0
    variation_j1_pct: float = 0.0

    # RSI
    rsi: Optional[float] = None
    rsi_signal: str = "neutre"        # survendu | neutre | suracheté
    rsi_p10: Optional[float] = None   # seuil survendu adaptatif (C2) - percentile 10 local
    rsi_p90: Optional[float] = None   # seuil suracheté adaptatif (C2) - percentile 90 local

    # Moyennes mobiles
    ma20: Optional[float] = None
    ma50: Optional[float] = None
    ma50_slope_pct: Optional[float] = None
    ma200: Optional[float] = None
    ma_lt: Optional[float] = None       # MA long terme adaptative (MA200 ou MA100 fallback)
    ma_lt_period: int = 0               # Période réellement utilisée pour la MA LT
    ma_signal: str = "neutre"         # golden_cross | bullish | bearish | death_cross | neutre
    prix_vs_ma_lt: str = "neutre"     # au_dessus | en_dessous | inconnu

    # MACD
    macd_line: Optional[float] = None
    macd_signal_line: Optional[float] = None
    macd_histogram: Optional[float] = None
    macd_histogram_prev: Optional[float] = None
    macd_signal: str = "neutre"       # haussier | baissier | neutre

    # Bollinger
    bb_upper: Optional[float] = None
    bb_middle: Optional[float] = None
    bb_lower: Optional[float] = None
    bb_pct: Optional[float] = None    # position du prix dans les bandes (0=bas, 1=haut)
    bb_squeeze: bool = False          # bandes très resserrées

    # Volume
    volume_actuel: float = 0.0
    volume_moy20: float = 0.0
    volume_relatif_pct: float = 0.0   # % vs moy 20j
    turnover_moy20_fcfa: float = 0.0  # volume × cours moyen sur 20j (FCFA)
    zero_volume_days_pct: float = 0.0 # % de jours sans transaction sur 20j (thin trading bias)
    synthetic_ohlc: bool = False      # True si high=low=close sur >50% des barres (ATR biaisé)

    # Stochastic
    stoch_k: Optional[float] = None
    stoch_d: Optional[float] = None
    stoch_signal: str = "neutre"      # survendu | neutre | suracheté

    # ADX (force de la tendance)
    adx: Optional[float] = None
    plus_di: Optional[float] = None
    minus_di: Optional[float] = None
    adx_signal: str = "neutre"        # tendance_forte | tendance_moderee | pas_de_tendance
    atr: Optional[float] = None           # ATR absolu (Wilder, période ADX)
    atr_pct: Optional[float] = None       # ATR / close[-1] × 100 - comparable cross-tickers BRVM

    # Supports / Résistances
    support: Optional[float] = None
    resistance: Optional[float] = None

    # Performance relative
    perf_1m: Optional[float] = None   # % sur 1 mois
    perf_3m: Optional[float] = None   # % sur 3 mois
    perf_vs_index_1m: Optional[float] = None        # alpha brut vs BRVMC (%)
    perf_vs_index_1m_atr_norm: Optional[float] = None  # alpha / atr_pct - ATR space (B3)

    # Divergence RSI
    rsi_divergence: str = "aucune"       # aucune | haussiere | baissiere | haussiere_forte | baissiere_forte
    rsi_divergence_detail: str = ""      # Explication textuelle

    # Divergence MACD
    macd_divergence: str = "aucune"      # aucune | haussiere | baissiere
    macd_divergence_detail: str = ""

    # Configuration chartiste
    config_chartiste: str = "indéterminé"
    # canal_ascendant | canal_descendant | range_lateral | squeeze_bollinger | indéterminé

    # ── Analyse 3 mois ──
    volatilite_3m: Optional[float] = None   # écart-type annualisé des rendements sur 3M
    drawdown_max_3m: Optional[float] = None # drawdown max sur 3 mois (%)
    drawdown_current: Optional[float] = None # drawdown courant depuis le plus haut 3M
    perf_vs_index_3m: Optional[float] = None # alpha vs BRVMC sur 3 mois

    # ── Détection d'événements techniques ──
    events: list = field(default_factory=list)
    # Liste de dicts : {"type": str, "date": str, "description": str, "importance": str}
    # Types : golden_cross, death_cross, breakout_up, breakout_down,
    #         volume_spike, rsi_divergence, macd_divergence, bollinger_breakout

    # ── Plus haut / plus bas ──
    high_52w: Optional[float] = None
    low_52w: Optional[float] = None
    pct_from_52w_high: Optional[float] = None  # % par rapport au plus haut 52 semaines

    # Qualité des données (E1)
    data_quality_flag: str = "ok"   # ok | gaps | sparse - dégrade C1 confiance

    # ── BRVM-aware (Phase 2) ──
    liquidity_tier: str = "INCONNU"         # LIQUIDE | SEMI_LIQUIDE | ILLIQUIDE | INCONNU
    volume_median_nonzero: float = 0.0      # médiane volume séances non-zéro (20j)

    # ── Fondamentaux (enrichis par fundamentals_loader après precompute) ───────
    fund_div_yield:    Optional[float] = None   # Dividende / cours_actuel (ex: 0.055 = 5.5%)
    fund_per_implied:  Optional[float] = None   # cours_actuel / BNPA (ex: 8.2x)
    fund_annee:        Optional[int]   = None   # Année des données fondamentales utilisées

    # Séries temporelles pour les graphiques
    series: dict = field(default_factory=dict)


# ─── Helpers qualité des données ─────────────────────────────────────────────

def _fill_ohlcv_gaps(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DatetimeIndex]:
    """
    Comble les trous ≤ 3 jours ouvrés dans un DataFrame OHLCV.
    OHLC : forward-fill (limit=3) ; volume : 0 sur les jours ajoutés.
    Retourne (df_complété, dates_ajoutées).
    """
    try:
        # Calendrier BRVM : jours ouvrés hors week-end et jours fériés UEMOA/CI.
        # On prend l'union avec les dates existantes pour ne jamais supprimer
        # un prix publié un jour férié (certains courtiers BRVM le font).
        all_days = pd.date_range(df.index.min(), df.index.max(), freq="D")
        brvm_days = pd.DatetimeIndex([d for d in all_days if not is_brvm_holiday(d)])
        full_idx = brvm_days.union(df.index).sort_values()
        if len(full_idx) <= len(df):
            return df, pd.DatetimeIndex([])
        added_days = full_idx.difference(df.index)
        df_filled = df.reindex(full_idx)
        for col in ["open", "high", "low", "close"]:
            if col in df_filled.columns:
                df_filled[col] = df_filled[col].ffill(limit=3)
        if "volume" in df_filled.columns:
            df_filled.loc[df_filled.index.isin(added_days), "volume"] = 0
            df_filled["volume"] = df_filled["volume"].fillna(0)
        return df_filled, added_days
    except Exception as exc:
        logger.debug(f"[Gaps] interpolation ignorée - {exc}")
        return df, pd.DatetimeIndex([])


def _validate_ohlcv(df: pd.DataFrame) -> list[str]:
    """
    Détecte les anomalies dans les données OHLCV.
    Retourne une liste de warnings (chaînes de caractères).
    Un saut de cours > 30% sur une journée est signalé (action sur le capital probable).
    """
    warnings: list[str] = []
    if "close" not in df.columns or len(df) < 2:
        return warnings
    pct_changes = df["close"].pct_change().abs() * 100
    for ts, pct in pct_changes.items():
        if pd.notna(pct) and pct > 30:
            day = ts.date() if hasattr(ts, "date") else ts
            warnings.append(
                f"Saut de cours > 30% détecté le {day}: {pct:.1f}%"
            )
    return warnings


# ─── Calcul principal ─────────────────────────────────────────────────────────

def compute_indicators(
    df: pd.DataFrame,
    ticker: str,
    df_index: Optional[pd.DataFrame] = None,
    horizon: str = DEFAULT_HORIZON,
    compute_events: bool = True,
    fill_gaps: bool = True,
) -> TechnicalIndicators:
    """
    Calcule tous les indicateurs techniques sur un DataFrame OHLCV.

    Args:
        df:        DataFrame OHLCV avec index DatetimeIndex
        ticker:    Symbole du titre
        df_index:  DataFrame OHLCV de l'indice BRVMC pour calcul alpha (optionnel)
        horizon:   Nom du profil d'horizon ("Court terme" | "Moyen terme" | "Long terme")

    Returns:
        TechnicalIndicators rempli
    """
    result = TechnicalIndicators(ticker=ticker)

    if df is None or len(df) < 5:
        logger.warning(f"DataFrame insuffisant pour {ticker}")
        return result

    # ── Paramètres du profil d'horizon ───────────────────────────────────────
    profile = HORIZON_PROFILES.get(horizon, HORIZON_PROFILES[DEFAULT_HORIZON])
    p = profile["periods"]

    RSI_PERIOD        = p["rsi"]
    MA_SHORT          = p["ma_short"]
    MA_MID            = p["ma_mid"]
    MA_LONG           = p["ma_long"]
    MA_LONG_FALLBACK  = p["ma_long_fallback"]
    MACD_FAST         = p["macd_fast"]
    MACD_SLOW         = p["macd_slow"]
    MACD_SIGNAL_P     = p["macd_signal"]
    STOCH_K_PERIOD    = p["stoch_k"]
    STOCH_D_PERIOD    = p["stoch_d"]
    ADX_PERIOD        = p["adx"]
    BOLLINGER_PERIOD  = p["bollinger"]
    BOLLINGER_STD_P   = p.get("bb_std", BOLLINGER_STD)
    RSI_OVERSOLD      = p.get("rsi_oversold", 30)
    RSI_OVERBOUGHT    = p.get("rsi_overbought", 70)

    result.horizon = horizon

    df = df.copy().sort_index()

    # ── Interpolation des gaps ≤ 3 jours ouvrés (C3) ─────────────────────────
    # Forward-fill OHLC sur les jours manquants, volume=0 pour les jours ajoutés.
    # fill_gaps=False quand le DataFrame parent a déjà été interpolé (ex: backtest).
    if fill_gaps:
        df, _added_days = _fill_ohlcv_gaps(df)
    else:
        _added_days = pd.DatetimeIndex([])

    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"] if "volume" in df.columns else pd.Series(0, index=df.index)

    # ── Gap detection (E1) - trous de cotation impactent indicateurs temporels ─
    if len(df) >= 5:
        date_diffs = pd.Series(df.index).diff().dt.days.dropna()
        n_gaps = int((date_diffs > 10).sum())   # > 10 jours cal. = trou non-férié
        if n_gaps >= 3:
            result.data_quality_flag = "sparse"  # données très lacunaires
        elif n_gaps >= 1:
            result.data_quality_flag = "gaps"    # quelques trous acceptables

    # ── Prix actuels ──────────────────────────────────────────────────────────
    result.cours_actuel = round(float(close.iloc[-1]), 2)
    if len(close) >= 2:
        result.variation_j1_pct = round(
            (close.iloc[-1] / close.iloc[-2] - 1) * 100, 2
        )

    # ── ATR - calculé avant RSI pour que atr_pct soit disponible (B1) ────────
    # Même période qu'ADX → cohérence Wilder ; close.iloc[-1] pour référence temporelle
    atr_s = _calc_atr(high, low, close, period=ADX_PERIOD)
    if atr_s is not None:
        atr_val = atr_s.iloc[-1]
        if pd.notna(atr_val):
            result.atr = round(float(atr_val), 4)
            price_ref = float(close.iloc[-1])
            if price_ref > 0:
                result.atr_pct = round(result.atr / price_ref * 100, 3)

    # ── RSI ───────────────────────────────────────────────────────────────────
    if len(df) >= RSI_PERIOD + 1:
        rsi_series = _calc_rsi(close, length=RSI_PERIOD)
        if rsi_series is not None and not rsi_series.empty:
            rsi_val = rsi_series.iloc[-1]
            if pd.notna(rsi_val):
                result.rsi = round(float(rsi_val), 2)
                result.rsi_signal = (
                    "survendu" if result.rsi < RSI_OVERSOLD
                    else "suracheté" if result.rsi > RSI_OVERBOUGHT
                    else "neutre"
                )
                if compute_events:
                    result.series["rsi"] = rsi_series.dropna().round(2).to_dict()

                # Détection divergence RSI vs prix
                div_window = {"Court terme": 20, "Moyen terme": 40, "Long terme": 60}.get(horizon, 40)
                result.rsi_divergence, result.rsi_divergence_detail = _detect_rsi_divergence(
                    close, rsi_series, window=min(div_window, len(close)),
                    atr_pct=result.atr_pct,
                )

                # Seuils adaptatifs RSI (C2) - percentile local, fenêtre adaptative
                # Fallback 30/70 si distribution comprimée (spread < 15 pts RSI)
                rsi_clean = rsi_series.dropna()
                if len(rsi_clean) >= 60:
                    rsi_window = rsi_clean.iloc[-min(120, len(rsi_clean)):]
                    p10 = float(rsi_window.quantile(0.10))
                    p90 = float(rsi_window.quantile(0.90))
                    if (p90 - p10) >= 15:
                        result.rsi_p10 = round(p10, 2)
                        result.rsi_p90 = round(p90, 2)
                    else:
                        result.rsi_p10 = float(RSI_OVERSOLD)
                        result.rsi_p90 = float(RSI_OVERBOUGHT)

    # ── Moyennes mobiles ──────────────────────────────────────────────────────
    n = len(close)
    if n >= MA_SHORT:
        ma20_s = _calc_sma(close, length=MA_SHORT)
        if ma20_s is not None:
            result.ma20 = round(float(ma20_s.iloc[-1]), 2) if pd.notna(ma20_s.iloc[-1]) else None
            if compute_events:
                result.series["ma20"] = ma20_s.dropna().round(2).to_dict()

    if n >= MA_MID:
        ma50_s = _calc_sma(close, length=MA_MID)
        if ma50_s is not None:
            result.ma50 = round(float(ma50_s.iloc[-1]), 2) if pd.notna(ma50_s.iloc[-1]) else None
            if compute_events:
                result.series["ma50"] = ma50_s.dropna().round(2).to_dict()
            # Pente normalisée % sur 5 séances - comparable cross-tickers (BRVM multi-cap)
            # Robuste aux gaps : on travaille sur la série clean, pas sur iloc absolu
            ma50_clean = ma50_s.dropna()
            if len(ma50_clean) >= 6:
                last = ma50_clean.iloc[-1]
                prev = ma50_clean.iloc[-6]
                if prev != 0:
                    result.ma50_slope_pct = round((last - prev) / prev * 100, 3)

    if n >= MA_LONG:
        ma200_s = _calc_sma(close, length=MA_LONG)
        if ma200_s is not None:
            result.ma200 = round(float(ma200_s.iloc[-1]), 2) if pd.notna(ma200_s.iloc[-1]) else None
            if compute_events:
                result.series["ma200"] = ma200_s.dropna().round(2).to_dict()

    # MA long terme adaptative : MA200 si dispo, sinon MA100 fallback
    if result.ma200 is not None:
        result.ma_lt = result.ma200
        result.ma_lt_period = MA_LONG
    elif n >= MA_LONG_FALLBACK:
        ma_lt_s = _calc_sma(close, length=MA_LONG_FALLBACK)
        if ma_lt_s is not None and pd.notna(ma_lt_s.iloc[-1]):
            result.ma_lt = round(float(ma_lt_s.iloc[-1]), 2)
            result.ma_lt_period = MA_LONG_FALLBACK
            if compute_events:
                result.series["ma_lt"] = ma_lt_s.dropna().round(2).to_dict()

    # Signal MA
    result.ma_signal = _compute_ma_signal(result.cours_actuel, result.ma20, result.ma50, result.ma_lt)
    result.prix_vs_ma_lt = (
        "au_dessus" if result.ma_lt and result.cours_actuel > result.ma_lt
        else "en_dessous" if result.ma_lt
        else "inconnu"
    )

    # ── MACD ──────────────────────────────────────────────────────────────────
    _macd_clean_local = None
    if n >= MACD_SLOW + MACD_SIGNAL_P:
        macd_l, macd_s, macd_h = _calc_macd(close, fast=MACD_FAST, slow=MACD_SLOW, signal=MACD_SIGNAL_P)

        v = macd_l.iloc[-1]
        result.macd_line = round(float(v), 4) if pd.notna(v) else None

        v = macd_s.iloc[-1]
        result.macd_signal_line = round(float(v), 4) if pd.notna(v) else None

        macd_clean = macd_h.dropna()
        v = macd_clean.iloc[-1] if len(macd_clean) >= 1 else None
        result.macd_histogram = round(float(v), 4) if v is not None and pd.notna(v) else None
        v_prev = macd_clean.iloc[-2] if len(macd_clean) >= 2 else None
        result.macd_histogram_prev = round(float(v_prev), 4) if v_prev is not None and pd.notna(v_prev) else None
        if compute_events:
            result.series["macd"] = macd_l.dropna().round(4).to_dict()
            result.series["macd_signal"] = macd_s.dropna().round(4).to_dict()
            result.series["macd_hist"] = macd_clean.round(4).to_dict()
        # Garder macd_clean accessible pour divergence MACD ci-dessous
        _macd_clean_local = macd_clean

        if result.macd_line is not None and result.macd_signal_line is not None:
            result.macd_signal = (
                "haussier" if result.macd_line > result.macd_signal_line
                else "baissier"
            )

    # ── Bandes de Bollinger ───────────────────────────────────────────────────
    if n >= BOLLINGER_PERIOD:
        bb_upper_s, bb_mid_s, bb_lower_s = _calc_bbands(
            close, length=BOLLINGER_PERIOD, std=BOLLINGER_STD_P
        )

        last_upper = bb_upper_s.iloc[-1]
        last_mid = bb_mid_s.iloc[-1]
        last_lower = bb_lower_s.iloc[-1]

        if pd.notna(last_upper) and pd.notna(last_lower) and pd.notna(last_mid):
            result.bb_upper = round(float(last_upper), 2)
            result.bb_middle = round(float(last_mid), 2)
            result.bb_lower = round(float(last_lower), 2)

            bw = result.bb_upper - result.bb_lower
            if bw > 0:
                result.bb_pct = round((result.cours_actuel - result.bb_lower) / bw, 4)

            # Squeeze : bandes < 2% de la MM
            if result.bb_middle and result.bb_middle > 0:
                squeeze_ratio = bw / result.bb_middle
                result.bb_squeeze = squeeze_ratio < 0.02

            if compute_events:
                result.series["bb_upper"] = bb_upper_s.dropna().round(2).to_dict()
                result.series["bb_lower"] = bb_lower_s.dropna().round(2).to_dict()

    # ── Volume ────────────────────────────────────────────────────────────────
    if volume.sum() > 0:
        result.volume_actuel = float(volume.iloc[-1])
        vol_window = min(VOLUME_AVG_PERIOD, len(volume))
        vol_slice = volume.iloc[-vol_window:]
        result.volume_moy20 = float(vol_slice.mean())
        if result.volume_moy20 > 0:
            result.volume_relatif_pct = round(
                (result.volume_actuel / result.volume_moy20 - 1) * 100, 2
            )

        # Turnover FCFA : volume × cours - filtre plus fiable que le volume seul
        close_slice = close.iloc[-vol_window:]
        turnover_slice = vol_slice * close_slice
        result.turnover_moy20_fcfa = round(float(turnover_slice.mean()), 0)

        # Thin trading bias : % de jours sans transaction sur 20j
        zero_days = int((vol_slice == 0).sum())
        result.zero_volume_days_pct = round(zero_days / len(vol_slice) * 100, 1)

        # Médiane volume séances non-zéro (brvm_aware - Phase 2)
        nonzero_vols = vol_slice[vol_slice > 0]
        result.volume_median_nonzero = float(nonzero_vols.median()) if len(nonzero_vols) > 0 else 0.0

    # ── OHLC synthétique : high=low=close sur >50% des barres → ATR biaisé ───
    if "high" in df.columns and "low" in df.columns:
        ohlc_window = min(20, len(df))
        recent_high = df["high"].iloc[-ohlc_window:]
        recent_low  = df["low"].iloc[-ohlc_window:]
        recent_close = close.iloc[-ohlc_window:]
        synthetic_bars = ((recent_high == recent_close) & (recent_low == recent_close)).sum()
        result.synthetic_ohlc = bool(synthetic_bars / ohlc_window > 0.5)

    # ── Supports / Résistances (fenêtre adaptée à l'horizon) ────────────────
    sr_windows = {"Court terme": 15, "Moyen terme": 30, "Long terme": 60}
    window_sr = min(sr_windows.get(horizon, 30), len(df))
    recent = df.iloc[-window_sr:]
    result.support = round(float(recent["low"].min()), 2)
    result.resistance = round(float(recent["high"].max()), 2)

    # Niveaux plus proches du prix actuel
    result.support, result.resistance = _find_nearest_sr(
        close, result.cours_actuel, window=window_sr
    )

    # ── Stochastic Oscillator ─────────────────────────────────────────────────
    if n >= STOCH_K_PERIOD + STOCH_D_PERIOD:
        stoch_k_s, stoch_d_s = _calc_stochastic(
            high, low, close, k_period=STOCH_K_PERIOD, d_period=STOCH_D_PERIOD
        )
        k_val = stoch_k_s.iloc[-1]
        d_val = stoch_d_s.iloc[-1]
        if pd.notna(k_val):
            result.stoch_k = round(float(k_val), 2)
        if pd.notna(d_val):
            result.stoch_d = round(float(d_val), 2)
        if result.stoch_k is not None:
            result.stoch_signal = (
                "survendu" if result.stoch_k < 20
                else "suracheté" if result.stoch_k > 80
                else "neutre"
            )
            if compute_events:
                result.series["stoch_k"] = stoch_k_s.dropna().round(2).to_dict()
                result.series["stoch_d"] = stoch_d_s.dropna().round(2).to_dict()

    # ── ADX (Average Directional Index) ───────────────────────────────────────
    if n >= ADX_PERIOD * 2:
        adx_s, plus_di_s, minus_di_s = _calc_adx(high, low, close, length=ADX_PERIOD)
        adx_val = adx_s.iloc[-1]
        if pd.notna(adx_val):
            result.adx = round(float(adx_val), 2)
            result.plus_di = round(float(plus_di_s.iloc[-1]), 2) if pd.notna(plus_di_s.iloc[-1]) else None
            result.minus_di = round(float(minus_di_s.iloc[-1]), 2) if pd.notna(minus_di_s.iloc[-1]) else None
            result.adx_signal = (
                "tendance_forte" if result.adx > 25
                else "tendance_moderee" if result.adx > 20
                else "pas_de_tendance"
            )
            if compute_events:
                result.series["adx"] = adx_s.dropna().round(2).to_dict()

    # ── Configuration chartiste ───────────────────────────────────────────────
    result.config_chartiste = _detect_chart_config(df, result.bb_squeeze)

    # ── Performance relative ──────────────────────────────────────────────────
    result.perf_1m = _compute_perf(close, 21)
    result.perf_3m = _compute_perf(close, 63)

    if df_index is not None and len(df_index) >= 21:
        index_perf_1m = _compute_perf(df_index["close"], 21)
        if index_perf_1m is not None and result.perf_1m is not None:
            result.perf_vs_index_1m = round(result.perf_1m - index_perf_1m, 2)
            # ATR-normalized alpha (B3) - atr_pct déjà disponible (calculé avant RSI)
            if result.atr_pct is not None and result.atr_pct > 0:
                result.perf_vs_index_1m_atr_norm = round(
                    result.perf_vs_index_1m / result.atr_pct, 3
                )

    if df_index is not None and len(df_index) >= 63:
        index_perf_3m = _compute_perf(df_index["close"], 63)
        if index_perf_3m is not None and result.perf_3m is not None:
            result.perf_vs_index_3m = round(result.perf_3m - index_perf_3m, 2)

    # ── Analyse 3 mois (volatilité, drawdown) ────────────────────────────────
    if n >= 63:
        result.volatilite_3m = _compute_volatility(close, window=63)
        result.drawdown_max_3m, result.drawdown_current = _compute_drawdown(close, window=63)

    # ── Plus haut / plus bas 52 semaines ─────────────────────────────────────
    if n >= 21:
        lookback_52w = min(n, 252)
        result.high_52w = round(float(high.iloc[-lookback_52w:].max()), 2)
        result.low_52w = round(float(low.iloc[-lookback_52w:].min()), 2)
        if result.high_52w > 0:
            result.pct_from_52w_high = round(
                (result.cours_actuel / result.high_52w - 1) * 100, 2
            )

    # ── Divergence MACD ──────────────────────────────────────────────────────
    if _macd_clean_local is not None and len(_macd_clean_local) >= 20:
        result.macd_divergence, result.macd_divergence_detail = _detect_macd_divergence(
            close, _macd_clean_local, atr_pct=result.atr_pct,
        )

    # ── Détection d'événements techniques ────────────────────────────────────
    result.events = _detect_events(df, result, close, high, low, volume) if compute_events else []

    # ── Séries pour graphiques ────────────────────────────────────────────────
    if compute_events:
        result.series["close"] = close.round(2).to_dict()
        result.series["open"] = df["open"].round(2).to_dict()
        result.series["high"] = high.round(2).to_dict()
        result.series["low"] = low.round(2).to_dict()
        result.series["volume"] = volume.round(0).to_dict()

        # Séries ADX (+DI, -DI) pour graphique
        if n >= ADX_PERIOD * 2:
            adx_s, plus_di_s, minus_di_s = _calc_adx(high, low, close, length=ADX_PERIOD)
            result.series["plus_di"] = plus_di_s.dropna().round(2).to_dict()
            result.series["minus_di"] = minus_di_s.dropna().round(2).to_dict()

    # ── Tier de liquidité BRVM-aware (Phase 2) ────────────────────────────────
    # Résolution depuis LIQUIDITY_TIERS dans config.py.
    # Le dict est vide par défaut ; peuplé après run de diagnostics.py.
    from config import LIQUIDITY_TIERS as _LT
    result.liquidity_tier = _LT.get(ticker, "INCONNU")

    return result


# ─── Precompute vectorisé pour le backtest ────────────────────────────────────

def precompute_backtest_indicators(
    df: pd.DataFrame,
    ticker: str,
    df_index: Optional[pd.DataFrame] = None,
    horizon: str = DEFAULT_HORIZON,
    warmup_bars: int = 30,
) -> dict:
    """
    Calcule tous les indicateurs pour toutes les dates en une passe vectorisée.
    Retourne un dict {pd.Timestamp: TechnicalIndicators}.
    Utilisé par le backtest pour éviter de recalculer depuis zéro à chaque barre.
    Toutes les séries sont converties en numpy pour un accès indexé O(1).
    """
    if df is None or len(df) < warmup_bars + 5:
        return {}

    profile = HORIZON_PROFILES.get(horizon, HORIZON_PROFILES[DEFAULT_HORIZON])
    p = profile["periods"]

    RSI_PERIOD       = p["rsi"]
    MA_SHORT         = p["ma_short"]
    MA_MID           = p["ma_mid"]
    MA_LONG          = p["ma_long"]
    MA_LONG_FALLBACK = p.get("ma_long_fallback", 100)
    MACD_FAST        = p["macd_fast"]
    MACD_SLOW        = p["macd_slow"]
    MACD_SIGNAL_P    = p["macd_signal"]
    STOCH_K          = p["stoch_k"]
    STOCH_D          = p["stoch_d"]
    ADX_P            = p["adx"]
    BB_P             = p["bollinger"]
    BB_STD           = p.get("bb_std", BOLLINGER_STD)
    RSI_LO           = p.get("rsi_oversold", 30)
    RSI_HI           = p.get("rsi_overbought", 70)

    close  = df["close"]
    high   = df["high"]
    low    = df["low"]
    volume = df["volume"] if "volume" in df.columns else pd.Series(0.0, index=df.index)

    # ── Calcul unique de toutes les séries (pandas) ───────────────────────────
    rsi_s                            = _calc_rsi(close, length=RSI_PERIOD)
    ma20_s                           = _calc_sma(close, length=MA_SHORT)
    ma50_s                           = _calc_sma(close, length=MA_MID)
    ma200_s                          = _calc_sma(close, length=MA_LONG)
    ma_lt_s                          = _calc_sma(close, length=MA_LONG_FALLBACK)
    macd_l_s, macd_sig_s, macd_h_s  = _calc_macd(close, fast=MACD_FAST, slow=MACD_SLOW, signal=MACD_SIGNAL_P)
    adx_s, plus_di_s, minus_di_s    = _calc_adx(high, low, close, length=ADX_P)
    atr_s                            = _calc_atr(high, low, close, period=ADX_P)
    stoch_k_s, stoch_d_s             = _calc_stochastic(high, low, close, k_period=STOCH_K, d_period=STOCH_D)
    bb_upper_s, bb_mid_s, bb_lower_s = _calc_bbands(close, length=BB_P, std=BB_STD)

    rsi_p10_s    = rsi_s.rolling(120, min_periods=60).quantile(0.10)
    rsi_p90_s    = rsi_s.rolling(120, min_periods=60).quantile(0.90)
    ma50_slope_s = ma50_s.pct_change(5, fill_method=None) * 100
    vol_ma_s     = volume.rolling(VOLUME_AVG_PERIOD, min_periods=1).mean()
    turnover_s   = (volume * close).rolling(VOLUME_AVG_PERIOD, min_periods=1).mean()
    zero_pct_s   = (volume == 0).rolling(VOLUME_AVG_PERIOD, min_periods=1).mean() * 100
    perf1m_s     = close.pct_change(21, fill_method=None) * 100
    perf3m_s     = close.pct_change(63, fill_method=None) * 100
    high_52w_s   = high.rolling(252, min_periods=1).max()
    low_52w_s    = low.rolling(252, min_periods=1).min()
    sr_w         = {"Court terme": 15, "Moyen terme": 30, "Long terme": 60}.get(horizon, 30)
    support_s    = low.rolling(sr_w, min_periods=1).min()
    resistance_s = high.rolling(sr_w, min_periods=1).max()

    idx_p1m = idx_p3m = None
    if df_index is not None and len(df_index) >= 21:
        ic = df_index["close"].reindex(df.index, method="ffill")
        idx_p1m = (ic.pct_change(21, fill_method=None) * 100).values
        if len(df_index) >= 63:
            idx_p3m = (ic.pct_change(63, fill_method=None) * 100).values

    from config import LIQUIDITY_TIERS as _LT
    liq_tier = _LT.get(ticker, "INCONNU")

    # ── Conversion numpy (accès O(1) sans overhead pandas) ───────────────────
    nan = float("nan")
    _nan = np.nan

    def _arr(s):
        return s.values if s is not None else None

    A_close  = close.values
    A_rsi    = _arr(rsi_s)
    A_p10    = _arr(rsi_p10_s)
    A_p90    = _arr(rsi_p90_s)
    A_ma20   = _arr(ma20_s)
    A_ma50   = _arr(ma50_s)
    A_sl50   = _arr(ma50_slope_s)
    A_ma200  = _arr(ma200_s)
    A_malt   = _arr(ma_lt_s)
    A_macd_l = _arr(macd_l_s)
    A_macd_s = _arr(macd_sig_s)
    A_macd_h = _arr(macd_h_s)
    A_adx    = _arr(adx_s)
    A_pdi    = _arr(plus_di_s)
    A_mdi    = _arr(minus_di_s)
    A_atr    = _arr(atr_s)
    A_sk     = _arr(stoch_k_s)
    A_sd     = _arr(stoch_d_s)
    A_bbu    = _arr(bb_upper_s)
    A_bbl    = _arr(bb_lower_s)
    A_bbm    = _arr(bb_mid_s)
    A_vol    = volume.values
    A_volma  = _arr(vol_ma_s)
    A_turn   = _arr(turnover_s)
    A_zeropt = _arr(zero_pct_s)
    A_p1m    = _arr(perf1m_s)
    A_p3m    = _arr(perf3m_s)
    A_h52    = _arr(high_52w_s)
    A_l52    = _arr(low_52w_s)
    A_sup    = _arr(support_s)
    A_res    = _arr(resistance_s)

    timestamps = df.index
    result: dict = {}

    for i in range(warmup_bars, len(df)):
        ts  = timestamps[i]
        ind = TechnicalIndicators(ticker=ticker)
        ind.horizon       = horizon
        ind.liquidity_tier = liq_tier

        cur = float(A_close[i])
        ind.cours_actuel = round(cur, 2)

        # ATR
        if A_atr is not None:
            av = A_atr[i]
            if not np.isnan(av):
                ind.atr = round(float(av), 2)
                if cur > 0:
                    ind.atr_pct = round(float(av) / cur * 100, 2)

        # RSI
        rv = A_rsi[i]
        if not np.isnan(rv):
            rsi_v = float(rv)
            ind.rsi = round(rsi_v, 2)
            ind.rsi_signal = (
                "survendu"   if rsi_v < RSI_LO
                else "suracheté" if rsi_v > RSI_HI
                else "neutre"
            )
            p10v = A_p10[i]; p90v = A_p90[i]
            if not np.isnan(p10v) and not np.isnan(p90v) and (p90v - p10v) >= 15:
                ind.rsi_p10 = round(float(p10v), 2)
                ind.rsi_p90 = round(float(p90v), 2)

        # MA20
        mv = A_ma20[i]
        if not np.isnan(mv):
            ind.ma20 = round(float(mv), 2)

        # MA50 + pente
        mv = A_ma50[i]
        if not np.isnan(mv):
            ind.ma50 = round(float(mv), 2)
            sv = A_sl50[i]
            if not np.isnan(sv):
                ind.ma50_slope_pct = round(float(sv), 3)

        # MA LT (MA200 prioritaire, sinon fallback)
        mv = A_ma200[i]
        if not np.isnan(mv):
            ind.ma200     = round(float(mv), 2)
            ind.ma_lt     = ind.ma200
            ind.ma_lt_period = MA_LONG
        else:
            mv = A_malt[i]
            if not np.isnan(mv):
                ind.ma_lt        = round(float(mv), 2)
                ind.ma_lt_period = MA_LONG_FALLBACK

        ind.ma_signal = _compute_ma_signal(ind.cours_actuel, ind.ma20, ind.ma50, ind.ma_lt)
        ind.prix_vs_ma_lt = (
            "au_dessus"  if ind.ma_lt and cur > ind.ma_lt
            else "en_dessous" if ind.ma_lt
            else "inconnu"
        )

        # MACD
        ml = A_macd_l[i]; ms = A_macd_s[i]; mh = A_macd_h[i]
        if not np.isnan(ml):
            ind.macd_line = round(float(ml), 4)
        if not np.isnan(ms):
            ind.macd_signal_line = round(float(ms), 4)
        if not np.isnan(mh):
            ind.macd_histogram = round(float(mh), 4)
        if i > 0:
            mh_prev = A_macd_h[i - 1]
            if not np.isnan(mh_prev):
                ind.macd_histogram_prev = round(float(mh_prev), 4)
        if ind.macd_line is not None and ind.macd_signal_line is not None:
            ind.macd_signal = "haussier" if ml > ms else "baissier"

        # Bollinger
        bbu = A_bbu[i]; bbl = A_bbl[i]; bbm = A_bbm[i]
        if not np.isnan(bbu) and not np.isnan(bbl) and not np.isnan(bbm):
            ind.bb_upper  = round(float(bbu), 2)
            ind.bb_lower  = round(float(bbl), 2)
            ind.bb_middle = round(float(bbm), 2)
            bw = bbu - bbl
            if bw > 0:
                ind.bb_pct = round((cur - bbl) / bw, 4)
            if bbm > 0:
                ind.bb_squeeze = (bw / bbm) < 0.02

        # Stochastic
        kv = A_sk[i]; dv = A_sd[i]
        if not np.isnan(kv):
            ind.stoch_k = round(float(kv), 2)
        if not np.isnan(dv):
            ind.stoch_d = round(float(dv), 2)
        if ind.stoch_k is not None:
            ind.stoch_signal = (
                "survendu"   if kv < 20
                else "suracheté" if kv > 80
                else "neutre"
            )

        # ADX
        av = A_adx[i]
        if not np.isnan(av):
            adx_v = float(av)
            ind.adx = round(adx_v, 2)
            pdi = A_pdi[i]; mdi = A_mdi[i]
            if not np.isnan(pdi):
                ind.plus_di  = round(float(pdi), 2)
            if not np.isnan(mdi):
                ind.minus_di = round(float(mdi), 2)
            ind.adx_signal = (
                "tendance_forte"    if adx_v > 25
                else "tendance_moderee" if adx_v > 20
                else "pas_de_tendance"
            )

        # Volume
        ind.volume_actuel        = float(A_vol[i])
        vol_ma                   = float(A_volma[i])
        ind.volume_moy20         = vol_ma
        if vol_ma > 0:
            ind.volume_relatif_pct = round((ind.volume_actuel / vol_ma - 1) * 100, 2)
        ind.turnover_moy20_fcfa  = round(float(A_turn[i]), 0)
        ind.zero_volume_days_pct = round(float(A_zeropt[i]), 1)

        # Perf 1m / 3m
        pv = A_p1m[i]
        if not np.isnan(pv):
            ind.perf_1m = round(float(pv), 2)
        pv = A_p3m[i]
        if not np.isnan(pv):
            ind.perf_3m = round(float(pv), 2)

        if idx_p1m is not None:
            ip = idx_p1m[i]
            if not np.isnan(ip) and ind.perf_1m is not None:
                ind.perf_vs_index_1m = round(ind.perf_1m - float(ip), 2)
                if ind.atr_pct and ind.atr_pct > 0:
                    ind.perf_vs_index_1m_atr_norm = round(ind.perf_vs_index_1m / ind.atr_pct, 3)
        if idx_p3m is not None:
            ip = idx_p3m[i]
            if not np.isnan(ip) and ind.perf_3m is not None:
                ind.perf_vs_index_3m = round(ind.perf_3m - float(ip), 2)

        # Support / résistance
        ind.support    = round(float(A_sup[i]), 2)
        ind.resistance = round(float(A_res[i]), 2)

        # 52-week high/low
        h52 = A_h52[i]; l52 = A_l52[i]
        if not np.isnan(h52):
            ind.high_52w = round(float(h52), 2)
            if ind.high_52w > 0:
                ind.pct_from_52w_high = round((cur / ind.high_52w - 1) * 100, 2)
        if not np.isnan(l52):
            ind.low_52w = round(float(l52), 2)

        result[ts] = ind

    return result


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _compute_ma_signal(prix: float, ma20: Optional[float], ma50: Optional[float], ma_lt: Optional[float]) -> str:
    """Détermine le signal des moyennes mobiles (ma_lt = MA200 ou MA100 adaptative)."""
    if ma20 and ma50 and ma_lt:
        if ma20 > ma50 > ma_lt:
            return "golden_cross"
        if ma20 < ma50 < ma_lt:
            return "death_cross"
        if ma20 > ma50:
            return "bullish"
        return "bearish"
    if ma20 and ma50:
        return "bullish" if ma20 > ma50 else "bearish"
    return "neutre"


def _compute_perf(close: pd.Series, periods: int) -> Optional[float]:
    """Calcule la performance en % sur N périodes."""
    if len(close) < periods + 1:
        return None
    perf = (close.iloc[-1] / close.iloc[-periods] - 1) * 100
    return round(float(perf), 2)


# ─── Volatility Normalization Layer (B2) ─────────────────────────────────────
# Point de vérité unique pour le scaling ATR : tous les seuils adaptatifs
# passent par _vol_mult() → cohérence garantie cross-indicateurs.

_BRVM_REF_ATR_PCT = 1.5   # régime de volatilité "normal" BRVM
_VOL_MULT_LO      = 0.67  # plancher : marché très stable
_VOL_MULT_HI      = 2.0   # plafond  : marché violent / illiquidité extrême


def _vol_mult(atr_pct: Optional[float]) -> float:
    """Multiplicateur volatilité borné - appliqué à TOUS les seuils adaptatifs."""
    if atr_pct is None or atr_pct <= 0:
        return 1.0
    if atr_pct < 0.3 * _BRVM_REF_ATR_PCT:   # titre quasi-figé - ATR non représentatif
        return 1.0
    return max(_VOL_MULT_LO, min(_VOL_MULT_HI, atr_pct / _BRVM_REF_ATR_PCT))


def _detect_rsi_divergence(
    close: pd.Series, rsi_series: pd.Series, window: int = 30, min_swing: float = 1.5,
    atr_pct: Optional[float] = None,
) -> tuple[str, str]:
    """
    Détecte les divergences haussières et baissières entre le prix et le RSI.

    Divergence haussière  : prix fait des plus bas décroissants MAIS RSI fait des plus bas croissants
                            → la pression vendeuse faiblit, hausse probable
    Divergence haussière forte : idem mais l'écart de prix est significatif (> 3%)

    Divergence baissière  : prix fait des plus hauts croissants MAIS RSI fait des plus hauts décroissants
                            → la pression acheteuse faiblit, baisse probable
    Divergence baissière forte : idem mais l'écart de prix est significatif (> 3%)

    Args:
        close:      Série des prix de clôture
        rsi_series: Série RSI calculée
        window:     Nombre de séances à analyser pour trouver les pivots
        min_swing:  Écart minimum (en points RSI) pour valider un pivot

    Returns:
        (type_divergence, detail_str)
    """
    if len(close) < window or len(rsi_series) < window:
        return "aucune", ""

    c = close.iloc[-window:].values
    r = rsi_series.iloc[-window:].values

    # Trouver les pivots hauts et bas locaux (ordre 2 min pour fiabilité)
    pivot_highs = []  # (index, price, rsi)
    pivot_lows = []

    order = 2
    for i in range(order, len(c) - order):
        # Pivot haut
        if all(c[i] >= c[i - j] for j in range(1, order + 1)) and \
           all(c[i] >= c[i + j] for j in range(1, order + 1)):
            if not np.isnan(r[i]):
                pivot_highs.append((i, c[i], r[i]))
        # Pivot bas
        if all(c[i] <= c[i - j] for j in range(1, order + 1)) and \
           all(c[i] <= c[i + j] for j in range(1, order + 1)):
            if not np.isnan(r[i]):
                pivot_lows.append((i, c[i], r[i]))

    # Seuil forte adaptatif - via VNL (B2) : 3.0% × vol_mult, borné [2.0%, 6.0%]
    seuil_forte = 3.0 * _vol_mult(atr_pct)

    # === Divergence baissière : comparer les 2 derniers pivot highs ===
    if len(pivot_highs) >= 2:
        prev_h = pivot_highs[-2]
        last_h = pivot_highs[-1]
        # Prix monte, RSI descend
        if last_h[1] > prev_h[1] and last_h[2] < prev_h[2] - min_swing:
            price_pct = (last_h[1] - prev_h[1]) / prev_h[1] * 100
            rsi_drop = prev_h[2] - last_h[2]
            if price_pct > seuil_forte or rsi_drop > 5:
                return "baissiere_forte", (
                    f"Prix +{price_pct:.1f}% (hauts croissants) mais RSI -{rsi_drop:.1f}pts "
                    f"(hauts décroissants) → divergence baissière forte, retournement probable"
                )
            else:
                return "baissiere", (
                    f"Prix +{price_pct:.1f}% mais RSI -{rsi_drop:.1f}pts → divergence baissière"
                )

    # === Divergence haussière : comparer les 2 derniers pivot lows ===
    if len(pivot_lows) >= 2:
        prev_l = pivot_lows[-2]
        last_l = pivot_lows[-1]
        # Prix descend, RSI monte
        if last_l[1] < prev_l[1] and last_l[2] > prev_l[2] + min_swing:
            price_pct = (prev_l[1] - last_l[1]) / prev_l[1] * 100
            rsi_rise = last_l[2] - prev_l[2]
            if price_pct > seuil_forte or rsi_rise > 5:
                return "haussiere_forte", (
                    f"Prix -{price_pct:.1f}% (bas décroissants) mais RSI +{rsi_rise:.1f}pts "
                    f"(bas croissants) → divergence haussière forte, rebond probable"
                )
            else:
                return "haussiere", (
                    f"Prix -{price_pct:.1f}% mais RSI +{rsi_rise:.1f}pts → divergence haussière"
                )

    return "aucune", ""


def _find_nearest_sr(close: pd.Series, cours: float, window: int = 20) -> tuple[float, float]:
    """
    Identifie les niveaux de support et résistance les plus proches du cours actuel.
    Utilise les extrema locaux (plus hauts et bas locaux) sur la fenêtre glissante.
    """
    recent = close.iloc[-window:]

    # Extrema locaux simples (comparaison avec voisins immédiats)
    highs, lows = [], []
    for i in range(1, len(recent) - 1):
        if recent.iloc[i] > recent.iloc[i-1] and recent.iloc[i] > recent.iloc[i+1]:
            highs.append(float(recent.iloc[i]))
        if recent.iloc[i] < recent.iloc[i-1] and recent.iloc[i] < recent.iloc[i+1]:
            lows.append(float(recent.iloc[i]))

    support = max((l for l in lows if l < cours), default=round(float(recent.min()), 2))
    resistance = min((h for h in highs if h > cours), default=round(float(recent.max()), 2))

    return round(support, 2), round(resistance, 2)


def _detect_chart_config(df: pd.DataFrame, bb_squeeze: bool) -> str:
    """
    Détecte la configuration chartiste dominante sur les 20 dernières séances.
    """
    if bb_squeeze:
        return "squeeze_bollinger"

    n = min(20, len(df))
    recent = df.iloc[-n:]
    close = recent["close"]

    # Range latéral : écart max/min < 5%
    if close.min() > 0:
        spread = (close.max() - close.min()) / close.min()
        if spread < 0.05:
            return "range_lateral"

    # Canal : détection via pente des hauts et bas
    highs = recent["high"].values
    lows = recent["low"].values

    x = np.arange(len(highs))
    if len(x) >= 6:
        slope_high = np.polyfit(x, highs, 1)[0]
        slope_low = np.polyfit(x, lows, 1)[0]

        if slope_high > 0 and slope_low > 0:
            return "canal_ascendant"
        if slope_high < 0 and slope_low < 0:
            return "canal_descendant"

    return "indéterminé"


# ─── Analyse 3 mois ─────────────────────────────────────────────────────────

def _compute_volatility(close: pd.Series, window: int = 63) -> Optional[float]:
    """
    Calcule la volatilité annualisée (écart-type des rendements quotidiens × √252).

    Args:
        close:  Série de prix de clôture
        window: Nombre de séances (63 ≈ 3 mois)

    Returns:
        Volatilité annualisée en %
    """
    if len(close) < window:
        return None
    returns = close.iloc[-window:].pct_change(fill_method=None).dropna()
    if len(returns) < 10:
        return None
    vol = float(returns.std() * np.sqrt(252) * 100)
    return round(vol, 2)


def _compute_drawdown(close: pd.Series, window: int = 63) -> tuple[Optional[float], Optional[float]]:
    """
    Calcule le drawdown max et le drawdown courant sur une fenêtre glissante.

    Returns:
        (drawdown_max_pct, drawdown_current_pct) - valeurs négatives
    """
    if len(close) < window:
        return None, None
    recent = close.iloc[-window:]
    cummax = recent.cummax()
    drawdown = (recent / cummax - 1) * 100
    dd_max = round(float(drawdown.min()), 2)
    dd_current = round(float(drawdown.iloc[-1]), 2)
    return dd_max, dd_current


# ─── Divergence MACD ─────────────────────────────────────────────────────────

def _detect_macd_divergence(
    close: pd.Series, macd_hist: pd.Series, window: int = 30,
    atr_pct: Optional[float] = None,
) -> tuple[str, str]:
    """
    Détecte les divergences entre le prix et l'histogramme MACD.

    Divergence haussière : prix fait des bas décroissants, MACD hist fait des bas croissants
    Divergence baissière : prix fait des hauts croissants, MACD hist fait des hauts décroissants
    """
    if len(close) < window or len(macd_hist) < window:
        return "aucune", ""

    # Aligner les deux séries sur les mêmes dates
    common_idx = close.index.intersection(macd_hist.index)
    if len(common_idx) < window:
        return "aucune", ""

    c = close.loc[common_idx].iloc[-window:].values
    m = macd_hist.loc[common_idx].iloc[-window:].values

    # Trouver les creux (zéro-crossings négatifs de l'histogramme)
    troughs = []
    for i in range(1, len(m) - 1):
        if m[i] < m[i-1] and m[i] < m[i+1] and m[i] < 0:
            troughs.append((i, c[i], m[i]))

    # Trouver les pics (zéro-crossings positifs)
    peaks = []
    for i in range(1, len(m) - 1):
        if m[i] > m[i-1] and m[i] > m[i+1] and m[i] > 0:
            peaks.append((i, c[i], m[i]))

    # Swing minimum adaptatif - via VNL (B2) : 1.0% × vol_mult
    seuil_min = 1.0 * _vol_mult(atr_pct)

    # Divergence haussière : prix descend, MACD hist remonte
    if len(troughs) >= 2:
        prev, last = troughs[-2], troughs[-1]
        if last[1] < prev[1] and last[2] > prev[2]:
            price_pct = (prev[1] - last[1]) / prev[1] * 100
            if price_pct >= seuil_min:
                return "haussiere", (
                    f"Prix en baisse mais histogramme MACD en hausse "
                    f"→ divergence haussière MACD, essoufflement vendeur"
                )

    # Divergence baissière : prix monte, MACD hist descend
    if len(peaks) >= 2:
        prev, last = peaks[-2], peaks[-1]
        if last[1] > prev[1] and last[2] < prev[2]:
            price_pct = (last[1] - prev[1]) / prev[1] * 100
            if price_pct >= seuil_min:
                return "baissiere", (
                    f"Prix en hausse mais histogramme MACD en baisse "
                    f"→ divergence baissière MACD, essoufflement acheteur"
                )

    return "aucune", ""


# ─── Détection d'événements techniques ───────────────────────────────────────

def _detect_events(
    df: pd.DataFrame,
    ind: 'TechnicalIndicators',
    close: pd.Series,
    high: pd.Series,
    low: pd.Series,
    volume: pd.Series,
) -> list[dict]:
    """
    Détecte les événements techniques récents (20 dernières séances).

    Types d'événements :
    - golden_cross / death_cross : croisement MA courte/longue
    - breakout_up / breakout_down : cassure de résistance/support
    - volume_spike : volume > 2× la moyenne 20j
    - bollinger_breakout : sortie des bandes de Bollinger
    - rsi_extreme : RSI < 20 ou > 80
    - macd_crossover : croisement MACD/Signal
    """
    events = []
    n = len(df)
    lookback = min(20, n - 1)

    # ── Golden Cross / Death Cross dynamique ──
    if "ma20" in ind.series and "ma50" in ind.series:
        ma20_s = pd.Series(ind.series["ma20"])
        ma50_s = pd.Series(ind.series["ma50"])
        common = ma20_s.index.intersection(ma50_s.index)
        if len(common) >= 5:
            ma20_c = ma20_s.loc[common]
            ma50_c = ma50_s.loc[common]
            diff = ma20_c - ma50_c
            for i in range(max(1, len(diff) - lookback), len(diff)):
                idx = diff.index[i]
                prev_idx = diff.index[i - 1]
                # Golden cross : MA20 passe au-dessus de MA50
                if diff.iloc[i] > 0 and diff.iloc[i - 1] <= 0:
                    events.append({
                        "type": "golden_cross",
                        "date": str(idx)[:10],
                        "description": "Golden Cross - MA courte croise au-dessus de la MA longue",
                        "importance": "forte",
                    })
                # Death cross : MA20 passe en-dessous de MA50
                elif diff.iloc[i] < 0 and diff.iloc[i - 1] >= 0:
                    events.append({
                        "type": "death_cross",
                        "date": str(idx)[:10],
                        "description": "Death Cross - MA courte croise en-dessous de la MA longue",
                        "importance": "forte",
                    })

    # ── Volume Spike ──
    if volume.sum() > 0 and n > 20:
        vol_mean = volume.iloc[-21:-1].mean()
        if vol_mean > 0:
            for i in range(max(0, n - lookback), n):
                if volume.iloc[i] > vol_mean * 2.5:
                    date_str = str(df.index[i])[:10]
                    ratio = volume.iloc[i] / vol_mean
                    events.append({
                        "type": "volume_spike",
                        "date": date_str,
                        "description": f"Volume spike ×{ratio:.1f} vs moyenne 20j",
                        "importance": "modérée" if ratio < 4 else "forte",
                    })

    # ── Breakout (cassure support/résistance Bollinger) ──
    if "bb_upper" in ind.series and "bb_lower" in ind.series:
        bb_up = pd.Series(ind.series["bb_upper"])
        bb_lo = pd.Series(ind.series["bb_lower"])
        for i in range(max(0, n - lookback), n):
            date = df.index[i]
            date_str = str(date)[:10]
            if date in bb_up.index and close.iloc[i] > bb_up.loc[date]:
                events.append({
                    "type": "breakout_up",
                    "date": date_str,
                    "description": "Cassure haussière de la bande Bollinger haute",
                    "importance": "modérée",
                })
            elif date in bb_lo.index and close.iloc[i] < bb_lo.loc[date]:
                events.append({
                    "type": "breakout_down",
                    "date": date_str,
                    "description": "Cassure baissière de la bande Bollinger basse",
                    "importance": "modérée",
                })

    # ── MACD Crossover ──
    if "macd" in ind.series and "macd_signal" in ind.series:
        macd_s = pd.Series(ind.series["macd"])
        sig_s = pd.Series(ind.series["macd_signal"])
        common = macd_s.index.intersection(sig_s.index)
        if len(common) >= 5:
            m = macd_s.loc[common]
            s = sig_s.loc[common]
            diff = m - s
            for i in range(max(1, len(diff) - lookback), len(diff)):
                idx = diff.index[i]
                if diff.iloc[i] > 0 and diff.iloc[i - 1] <= 0:
                    events.append({
                        "type": "macd_crossover",
                        "date": str(idx)[:10],
                        "description": "MACD croise au-dessus du signal - momentum haussier",
                        "importance": "modérée",
                    })
                elif diff.iloc[i] < 0 and diff.iloc[i - 1] >= 0:
                    events.append({
                        "type": "macd_crossover",
                        "date": str(idx)[:10],
                        "description": "MACD croise en-dessous du signal - momentum baissier",
                        "importance": "modérée",
                    })

    # ── RSI Extreme ──
    if "rsi" in ind.series:
        rsi_s = pd.Series(ind.series["rsi"])
        for i in range(max(0, len(rsi_s) - lookback), len(rsi_s)):
            val = rsi_s.iloc[i]
            if val < 20:
                events.append({
                    "type": "rsi_extreme",
                    "date": str(rsi_s.index[i])[:10],
                    "description": f"RSI extrêmement bas ({val:.0f}) - survente excessive",
                    "importance": "forte",
                })
            elif val > 80:
                events.append({
                    "type": "rsi_extreme",
                    "date": str(rsi_s.index[i])[:10],
                    "description": f"RSI extrêmement haut ({val:.0f}) - surachat excessif",
                    "importance": "forte",
                })

    # Trier par date décroissante et dédupliquer
    events.sort(key=lambda e: e["date"], reverse=True)

    # Dédupliquer par (type, date)
    seen = set()
    unique = []
    for e in events:
        key = (e["type"], e["date"])
        if key not in seen:
            seen.add(key)
            unique.append(e)

    return unique[:20]  # max 20 événements
