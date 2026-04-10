"""
indicators.py — Calcul des indicateurs techniques sur données OHLCV BRVM.

Implémentation pure pandas/numpy (sans pandas-ta) pour compatibilité Python 3.10–3.13.
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
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

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

    # Moyennes mobiles
    ma20: Optional[float] = None
    ma50: Optional[float] = None
    ma200: Optional[float] = None
    ma_lt: Optional[float] = None       # MA long terme adaptative (MA200 ou MA100 fallback)
    ma_lt_period: int = 0               # Période réellement utilisée pour la MA LT
    ma_signal: str = "neutre"         # golden_cross | bullish | bearish | death_cross | neutre
    prix_vs_ma_lt: str = "neutre"     # au_dessus | en_dessous | inconnu

    # MACD
    macd_line: Optional[float] = None
    macd_signal_line: Optional[float] = None
    macd_histogram: Optional[float] = None
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

    # Stochastic
    stoch_k: Optional[float] = None
    stoch_d: Optional[float] = None
    stoch_signal: str = "neutre"      # survendu | neutre | suracheté

    # ADX (force de la tendance)
    adx: Optional[float] = None
    plus_di: Optional[float] = None
    minus_di: Optional[float] = None
    adx_signal: str = "neutre"        # tendance_forte | tendance_moderee | pas_de_tendance

    # Supports / Résistances
    support: Optional[float] = None
    resistance: Optional[float] = None

    # Performance relative
    perf_1m: Optional[float] = None   # % sur 1 mois
    perf_3m: Optional[float] = None   # % sur 3 mois
    perf_vs_index_1m: Optional[float] = None  # alpha vs BRVMC

    # Divergence RSI
    rsi_divergence: str = "aucune"       # aucune | haussiere | baissiere | haussiere_forte | baissiere_forte
    rsi_divergence_detail: str = ""      # Explication textuelle

    # Configuration chartiste
    config_chartiste: str = "indéterminé"
    # canal_ascendant | canal_descendant | range_lateral | squeeze_bollinger | indéterminé

    # Séries temporelles pour les graphiques
    series: dict = field(default_factory=dict)


# ─── Calcul principal ─────────────────────────────────────────────────────────

def compute_indicators(
    df: pd.DataFrame,
    ticker: str,
    df_index: Optional[pd.DataFrame] = None,
    horizon: str = DEFAULT_HORIZON,
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

    result.horizon = horizon

    df = df.copy().sort_index()
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"] if "volume" in df.columns else pd.Series(0, index=df.index)

    # ── Prix actuels ──────────────────────────────────────────────────────────
    result.cours_actuel = round(float(close.iloc[-1]), 2)
    if len(close) >= 2:
        result.variation_j1_pct = round(
            (close.iloc[-1] / close.iloc[-2] - 1) * 100, 2
        )

    # ── RSI ───────────────────────────────────────────────────────────────────
    if len(df) >= RSI_PERIOD + 1:
        rsi_series = _calc_rsi(close, length=RSI_PERIOD)
        if rsi_series is not None and not rsi_series.empty:
            rsi_val = rsi_series.iloc[-1]
            if pd.notna(rsi_val):
                result.rsi = round(float(rsi_val), 2)
                result.rsi_signal = (
                    "survendu" if result.rsi < 30
                    else "suracheté" if result.rsi > 70
                    else "neutre"
                )
                result.series["rsi"] = rsi_series.dropna().round(2).to_dict()

                # Détection divergence RSI vs prix
                div_window = {"Court terme": 20, "Moyen terme": 40, "Long terme": 60}.get(horizon, 40)
                result.rsi_divergence, result.rsi_divergence_detail = _detect_rsi_divergence(
                    close, rsi_series, window=min(div_window, len(close))
                )

    # ── Moyennes mobiles ──────────────────────────────────────────────────────
    n = len(close)
    if n >= MA_SHORT:
        ma20_s = _calc_sma(close, length=MA_SHORT)
        if ma20_s is not None:
            result.ma20 = round(float(ma20_s.iloc[-1]), 2) if pd.notna(ma20_s.iloc[-1]) else None
            result.series["ma20"] = ma20_s.dropna().round(2).to_dict()

    if n >= MA_MID:
        ma50_s = _calc_sma(close, length=MA_MID)
        if ma50_s is not None:
            result.ma50 = round(float(ma50_s.iloc[-1]), 2) if pd.notna(ma50_s.iloc[-1]) else None
            result.series["ma50"] = ma50_s.dropna().round(2).to_dict()

    if n >= MA_LONG:
        ma200_s = _calc_sma(close, length=MA_LONG)
        if ma200_s is not None:
            result.ma200 = round(float(ma200_s.iloc[-1]), 2) if pd.notna(ma200_s.iloc[-1]) else None
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
            result.series["ma_lt"] = ma_lt_s.dropna().round(2).to_dict()

    # Signal MA
    result.ma_signal = _compute_ma_signal(result.cours_actuel, result.ma20, result.ma50, result.ma_lt)
    result.prix_vs_ma_lt = (
        "au_dessus" if result.ma_lt and result.cours_actuel > result.ma_lt
        else "en_dessous" if result.ma_lt
        else "inconnu"
    )

    # ── MACD ──────────────────────────────────────────────────────────────────
    if n >= MACD_SLOW + MACD_SIGNAL_P:
        macd_l, macd_s, macd_h = _calc_macd(close, fast=MACD_FAST, slow=MACD_SLOW, signal=MACD_SIGNAL_P)

        v = macd_l.iloc[-1]
        result.macd_line = round(float(v), 4) if pd.notna(v) else None
        result.series["macd"] = macd_l.dropna().round(4).to_dict()

        v = macd_s.iloc[-1]
        result.macd_signal_line = round(float(v), 4) if pd.notna(v) else None
        result.series["macd_signal"] = macd_s.dropna().round(4).to_dict()

        v = macd_h.iloc[-1]
        result.macd_histogram = round(float(v), 4) if pd.notna(v) else None
        result.series["macd_hist"] = macd_h.dropna().round(4).to_dict()

        if result.macd_line is not None and result.macd_signal_line is not None:
            result.macd_signal = (
                "haussier" if result.macd_line > result.macd_signal_line
                else "baissier"
            )

    # ── Bandes de Bollinger ───────────────────────────────────────────────────
    if n >= BOLLINGER_PERIOD:
        bb_upper_s, bb_mid_s, bb_lower_s = _calc_bbands(
            close, length=BOLLINGER_PERIOD, std=BOLLINGER_STD
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

            result.series["bb_upper"] = bb_upper_s.dropna().round(2).to_dict()
            result.series["bb_lower"] = bb_lower_s.dropna().round(2).to_dict()

    # ── Volume ────────────────────────────────────────────────────────────────
    if volume.sum() > 0:
        result.volume_actuel = float(volume.iloc[-1])
        vol_window = min(VOLUME_AVG_PERIOD, len(volume))
        result.volume_moy20 = float(volume.iloc[-vol_window:].mean())
        if result.volume_moy20 > 0:
            result.volume_relatif_pct = round(
                (result.volume_actuel / result.volume_moy20 - 1) * 100, 2
            )

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

    # ── Séries pour graphiques ────────────────────────────────────────────────
    result.series["close"] = close.round(2).to_dict()
    result.series["open"] = df["open"].round(2).to_dict()
    result.series["high"] = high.round(2).to_dict()
    result.series["low"] = low.round(2).to_dict()
    result.series["volume"] = volume.round(0).to_dict()

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


def _detect_rsi_divergence(
    close: pd.Series, rsi_series: pd.Series, window: int = 30, min_swing: float = 1.5
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

    # === Divergence baissière : comparer les 2 derniers pivot highs ===
    if len(pivot_highs) >= 2:
        prev_h = pivot_highs[-2]
        last_h = pivot_highs[-1]
        # Prix monte, RSI descend
        if last_h[1] > prev_h[1] and last_h[2] < prev_h[2] - min_swing:
            price_pct = (last_h[1] - prev_h[1]) / prev_h[1] * 100
            rsi_drop = prev_h[2] - last_h[2]
            if price_pct > 3 or rsi_drop > 5:
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
            if price_pct > 3 or rsi_rise > 5:
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
