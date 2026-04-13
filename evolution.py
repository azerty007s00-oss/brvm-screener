"""
evolution.py — Analyse de l'évolution d'une action sur une période glissante (90j par défaut).

Calcule :
- Performance glissante semaine par semaine
- Volatilité annualisée (réalisée sur 21j et 63j)
- Max drawdown et drawdown actuel depuis le dernier sommet
- Heatmap des rendements quotidiens (calendar view)
- Comparaison de performance vs indice BRVMC
- Détection automatique d'événements techniques sur la période
"""

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


# ─── Structures de données ────────────────────────────────────────────────────

@dataclass
class PeriodeGlissante:
    """Performance sur une fenêtre de temps."""
    label: str          # "Sem. 1", "Mois 1", etc.
    debut: date
    fin: date
    perf_pct: float
    vs_index_pct: Optional[float] = None   # Alpha vs BRVMC


@dataclass
class EvenementTechnique:
    """Événement technique détecté sur la période."""
    type: str           # golden_cross | death_cross | breakout | breakdown | volume_spike | rsi_extreme
    date: date
    prix: float
    description: str
    intensite: str      # faible | modérée | forte


@dataclass
class Evolution:
    """Résultat complet de l'analyse d'évolution sur une période."""
    ticker: str
    periode_jours: int
    periode_debut: date
    periode_fin: date

    # ── Performances ──────────────────────────────────────────────────────────
    perf_totale_pct: float = 0.0
    perf_vs_index_pct: Optional[float] = None
    perf_annualisee_pct: Optional[float] = None

    # ── Risque ────────────────────────────────────────────────────────────────
    volatilite_21j: Optional[float] = None    # Volatilité réalisée sur 21j (annualisée)
    volatilite_63j: Optional[float] = None    # Volatilité réalisée sur 63j (annualisée)
    max_drawdown_pct: float = 0.0             # Pire drawdown sur la période
    drawdown_actuel_pct: float = 0.0          # Drawdown depuis le dernier sommet
    sharpe_ratio: Optional[float] = None      # Sharpe simplifié (sans taux sans risque)
    prix_plus_haut: float = 0.0
    prix_plus_bas: float = 0.0
    date_plus_haut: Optional[date] = None
    date_plus_bas: Optional[date] = None

    # ── Performances glissantes ────────────────────────────────────────────────
    periodes_glissantes: list[PeriodeGlissante] = field(default_factory=list)

    # ── Heatmap rendements quotidiens ─────────────────────────────────────────
    # Format : {annee: {mois: {jour: return_pct}}}  — utilisé par Plotly heatmap
    heatmap_data: dict = field(default_factory=dict)
    # Format plat : [{"date": "2025-01-15", "return_pct": 1.2, "abs_return": 25.0}]
    returns_daily: list[dict] = field(default_factory=list)

    # ── Événements détectés ───────────────────────────────────────────────────
    evenements: list[EvenementTechnique] = field(default_factory=list)

    # ── Résumé narrative ──────────────────────────────────────────────────────
    synthese: str = ""


# ─── Calcul principal ─────────────────────────────────────────────────────────

def compute_evolution(
    df: pd.DataFrame,
    ticker: str,
    df_index: Optional[pd.DataFrame] = None,
    periode_jours: int = 90,
    ma_short: int = 20,
    ma_mid: int = 50,
) -> Evolution:
    """
    Calcule l'analyse complète d'évolution pour un ticker.

    Args:
        df:            DataFrame OHLCV avec index DatetimeIndex
        ticker:        Symbole du titre
        df_index:      DataFrame OHLCV de l'indice BRVMC (optionnel)
        periode_jours: Fenêtre d'analyse en jours (défaut : 90 = 3 mois)
        ma_short:      Période MA court terme pour détection Golden/Death Cross
        ma_mid:        Période MA moyen terme pour détection Golden/Death Cross

    Returns:
        Evolution avec tous les champs remplis
    """
    result = Evolution(ticker=ticker, periode_jours=periode_jours,
                       periode_debut=date.today(), periode_fin=date.today())

    if df is None or len(df) < 5:
        logger.warning(f"[Evolution] Données insuffisantes pour {ticker}")
        return result

    df = df.copy().sort_index()
    n = len(df)
    window = min(periode_jours, n)
    df_period = df.iloc[-window:]

    result.periode_debut = df_period.index[0].date()
    result.periode_fin = df_period.index[-1].date()

    close = df_period["close"]
    high = df_period["high"]
    low = df_period["low"]
    volume = df_period.get("volume", pd.Series(0, index=df_period.index))

    # ── Performance totale ────────────────────────────────────────────────────
    prix_debut = float(close.iloc[0])
    prix_fin = float(close.iloc[-1])
    result.perf_totale_pct = round((prix_fin / prix_debut - 1) * 100, 2) if prix_debut > 0 else 0.0

    # Performance annualisée
    if window > 1 and prix_debut > 0:
        result.perf_annualisee_pct = round(
            ((prix_fin / prix_debut) ** (252 / window) - 1) * 100, 2
        )

    # Alpha vs indice
    if df_index is not None and len(df_index) >= window:
        df_idx = df_index.copy().sort_index()
        df_idx_period = df_idx.iloc[-window:]
        idx_close = df_idx_period["close"]
        if len(idx_close) >= 2 and float(idx_close.iloc[0]) > 0:
            idx_perf = (float(idx_close.iloc[-1]) / float(idx_close.iloc[0]) - 1) * 100
            result.perf_vs_index_pct = round(result.perf_totale_pct - idx_perf, 2)

    # ── Extrema ───────────────────────────────────────────────────────────────
    result.prix_plus_haut = round(float(high.max()), 2)
    result.prix_plus_bas = round(float(low.min()), 2)
    result.date_plus_haut = high.idxmax().date()
    result.date_plus_bas = low.idxmin().date()

    # ── Volatilité ────────────────────────────────────────────────────────────
    daily_returns = close.pct_change().dropna()
    if len(daily_returns) >= 5:
        result.volatilite_21j = round(
            float(daily_returns.tail(min(21, len(daily_returns))).std() * np.sqrt(252) * 100), 2
        )
    if len(daily_returns) >= 20:
        result.volatilite_63j = round(
            float(daily_returns.std() * np.sqrt(252) * 100), 2
        )

    # Sharpe simplifié (sans taux sans risque, sur la période)
    if len(daily_returns) >= 5 and daily_returns.std() > 0:
        result.sharpe_ratio = round(
            float(daily_returns.mean() / daily_returns.std() * np.sqrt(252)), 2
        )

    # ── Drawdown ──────────────────────────────────────────────────────────────
    result.max_drawdown_pct, result.drawdown_actuel_pct = _compute_drawdown(close)

    # ── Performances glissantes ────────────────────────────────────────────────
    result.periodes_glissantes = _compute_rolling_performance(
        df, df_index, window
    )

    # ── Heatmap des rendements ────────────────────────────────────────────────
    result.returns_daily, result.heatmap_data = _compute_heatmap(df_period)

    # ── Événements techniques ─────────────────────────────────────────────────
    result.evenements = _detect_events(df, ma_short, ma_mid, window)

    # ── Synthèse narrative ────────────────────────────────────────────────────
    result.synthese = _build_synthese(result)

    return result


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _compute_drawdown(close: pd.Series) -> tuple[float, float]:
    """
    Calcule le max drawdown et le drawdown actuel depuis le dernier sommet.

    Returns:
        (max_drawdown_pct, drawdown_actuel_pct) — valeurs négatives en %
    """
    rolling_max = close.cummax()
    drawdown = (close - rolling_max) / rolling_max * 100

    max_dd = round(float(drawdown.min()), 2)

    # Drawdown actuel depuis le dernier sommet
    peak = float(close.max())
    current = float(close.iloc[-1])
    current_dd = round((current - peak) / peak * 100, 2) if peak > 0 else 0.0

    return max_dd, current_dd


def _compute_rolling_performance(
    df: pd.DataFrame,
    df_index: Optional[pd.DataFrame],
    window: int,
) -> list[PeriodeGlissante]:
    """
    Calcule les performances par fenêtres : 1S, 2S, 1M, 2M, 3M, 6M, 1A.
    Uniquement les fenêtres inférieures ou égales au nombre de jours disponibles.
    """
    periodes = [
        ("1 semaine",  5),
        ("2 semaines", 10),
        ("1 mois",     21),
        ("2 mois",     42),
        ("3 mois",     63),
        ("6 mois",     126),
        ("1 an",       252),
    ]

    close = df["close"].sort_index()
    idx_close = df_index["close"].sort_index() if df_index is not None else None
    n = len(close)

    results = []
    for label, days in periodes:
        if days > n:
            continue
        debut_price = float(close.iloc[-days])
        fin_price = float(close.iloc[-1])
        if debut_price <= 0:
            continue

        perf = round((fin_price / debut_price - 1) * 100, 2)
        vs_idx = None

        if idx_close is not None and len(idx_close) >= days:
            idx_debut = float(idx_close.iloc[-days])
            idx_fin = float(idx_close.iloc[-1])
            if idx_debut > 0:
                idx_perf = (idx_fin / idx_debut - 1) * 100
                vs_idx = round(perf - idx_perf, 2)

        results.append(PeriodeGlissante(
            label=label,
            debut=close.index[-days].date(),
            fin=close.index[-1].date(),
            perf_pct=perf,
            vs_index_pct=vs_idx,
        ))

    return results


def _compute_heatmap(df: pd.DataFrame) -> tuple[list[dict], dict]:
    """
    Calcule les rendements quotidiens pour la heatmap calendrier.

    Returns:
        - returns_daily : liste de dicts {date, return_pct, abs_return}
        - heatmap_data  : dict structuré {annee: {mois_nom: {jour: return_pct}}}
    """
    close = df["close"].sort_index()
    daily_ret = close.pct_change().dropna()

    returns_daily = []
    for dt, ret in daily_ret.items():
        if pd.isna(ret):
            continue
        returns_daily.append({
            "date": dt.strftime("%Y-%m-%d"),
            "return_pct": round(float(ret) * 100, 2),
            "abs_return": round(float(close.loc[dt] - close.shift(1).loc[dt]), 2),
        })

    # Structure pour heatmap Plotly (mois × jours)
    heatmap: dict = {}
    for item in returns_daily:
        dt = pd.to_datetime(item["date"])
        annee = str(dt.year)
        mois = dt.strftime("%b %Y")
        jour = dt.day
        if annee not in heatmap:
            heatmap[annee] = {}
        if mois not in heatmap[annee]:
            heatmap[annee][mois] = {}
        heatmap[annee][mois][jour] = item["return_pct"]

    return returns_daily, heatmap


def _detect_events(
    df: pd.DataFrame,
    ma_short: int,
    ma_mid: int,
    window: int,
) -> list[EvenementTechnique]:
    """
    Détecte les événements techniques sur la fenêtre d'analyse.

    Événements détectés :
    - Golden Cross / Death Cross (MA court terme vs MA moyen terme)
    - Breakout (clôture > plus haut des N derniers jours avec volume élevé)
    - Breakdown (clôture < plus bas des N derniers jours)
    - Volume spike (volume > 3× moyenne 20j)
    - RSI extrême (< 25 ou > 75)
    """
    events: list[EvenementTechnique] = []
    df = df.copy().sort_index()
    n = len(df)
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df.get("volume", pd.Series(0, index=df.index))

    # Fenêtre d'analyse
    df_w = df.iloc[-window:]
    close_w = df_w["close"]

    # ── Moyennes mobiles pour Golden/Death Cross ──────────────────────────────
    if n >= ma_mid:
        ma_s = close.rolling(ma_short, min_periods=ma_short).mean()
        ma_m = close.rolling(ma_mid, min_periods=ma_mid).mean()

        ma_s_w = ma_s.iloc[-window:]
        ma_m_w = ma_m.iloc[-window:]

        for i in range(1, len(ma_s_w)):
            if pd.isna(ma_s_w.iloc[i]) or pd.isna(ma_m_w.iloc[i]):
                continue
            if pd.isna(ma_s_w.iloc[i - 1]) or pd.isna(ma_m_w.iloc[i - 1]):
                continue

            prev_diff = ma_s_w.iloc[i - 1] - ma_m_w.iloc[i - 1]
            curr_diff = ma_s_w.iloc[i] - ma_m_w.iloc[i]

            if prev_diff < 0 and curr_diff > 0:
                events.append(EvenementTechnique(
                    type="golden_cross",
                    date=ma_s_w.index[i].date(),
                    prix=round(float(close_w.iloc[i]), 2),
                    description=f"Golden Cross : MA{ma_short} croise au-dessus MA{ma_mid}",
                    intensite="forte",
                ))
            elif prev_diff > 0 and curr_diff < 0:
                events.append(EvenementTechnique(
                    type="death_cross",
                    date=ma_s_w.index[i].date(),
                    prix=round(float(close_w.iloc[i]), 2),
                    description=f"Death Cross : MA{ma_short} croise sous MA{ma_mid}",
                    intensite="forte",
                ))

    # ── Breakout / Breakdown sur 20 séances ──────────────────────────────────
    breakout_window = min(20, window - 1)
    for i in range(breakout_window + 1, len(df_w)):
        prev_high = float(high.iloc[-(window - i + breakout_window):-(window - i)].max()) if (window - i) > 0 else float(high.iloc[:i].tail(breakout_window).max())
        prev_low = float(low.iloc[-(window - i + breakout_window):-(window - i)].min()) if (window - i) > 0 else float(low.iloc[:i].tail(breakout_window).min())

        c = float(close_w.iloc[i])
        v = float(volume.iloc[-window + i]) if volume.sum() > 0 else 0
        v_avg = float(volume.rolling(20, min_periods=5).mean().iloc[-window + i]) if volume.sum() > 0 else 0

        high_cond = c > prev_high and (v_avg == 0 or v > v_avg * 1.5)
        low_cond = c < prev_low

        if high_cond:
            events.append(EvenementTechnique(
                type="breakout",
                date=close_w.index[i].date(),
                prix=round(c, 2),
                description=f"Breakout : clôture au-dessus du plus haut des {breakout_window} séances ({prev_high:,.0f} FCFA)",
                intensite="forte" if (v_avg > 0 and v > v_avg * 2) else "modérée",
            ))
        elif low_cond:
            events.append(EvenementTechnique(
                type="breakdown",
                date=close_w.index[i].date(),
                prix=round(c, 2),
                description=f"Breakdown : clôture sous le plus bas des {breakout_window} séances ({prev_low:,.0f} FCFA)",
                intensite="forte",
            ))

    # ── Volume spikes ─────────────────────────────────────────────────────────
    if volume.sum() > 0:
        vol_w = volume.iloc[-window:]
        vol_mean = float(volume.rolling(20, min_periods=5).mean().iloc[-window:].mean())
        if vol_mean > 0:
            for i, (dt, v) in enumerate(vol_w.items()):
                if float(v) > vol_mean * 3:
                    events.append(EvenementTechnique(
                        type="volume_spike",
                        date=dt.date(),
                        prix=round(float(close_w.iloc[i]) if i < len(close_w) else 0, 2),
                        description=f"Volume exceptionnel : {v:,.0f} titres ({v / vol_mean:.1f}× la moyenne)",
                        intensite="forte" if float(v) > vol_mean * 5 else "modérée",
                    ))

    # ── RSI extrêmes ──────────────────────────────────────────────────────────
    if n >= 15:
        delta = close.diff()
        gain = delta.where(delta > 0, 0.0)
        loss = -delta.where(delta < 0, 0.0)
        avg_gain = gain.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
        avg_loss = loss.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
        rs = avg_gain / avg_loss.replace(0, np.nan)
        rsi = 100 - (100 / (1 + rs))
        rsi_w = rsi.iloc[-window:]

        for i, (dt, r) in enumerate(rsi_w.items()):
            if pd.isna(r):
                continue
            if float(r) < 20:
                events.append(EvenementTechnique(
                    type="rsi_extreme",
                    date=dt.date(),
                    prix=round(float(close_w.iloc[i]) if i < len(close_w) else 0, 2),
                    description=f"RSI extrêmement bas ({r:.1f}) — survente intense",
                    intensite="forte",
                ))
            elif float(r) > 80:
                events.append(EvenementTechnique(
                    type="rsi_extreme",
                    date=dt.date(),
                    prix=round(float(close_w.iloc[i]) if i < len(close_w) else 0, 2),
                    description=f"RSI extrêmement haut ({r:.1f}) — surachat intense",
                    intensite="forte",
                ))

    # Garder les 10 événements les plus récents par type (éviter le bruit)
    events.sort(key=lambda e: e.date)
    return _deduplicate_events(events)


def _deduplicate_events(events: list[EvenementTechnique]) -> list[EvenementTechnique]:
    """Garde au max 1 événement de chaque type par tranche de 5 jours."""
    seen: dict[str, date] = {}
    result = []
    for ev in events:
        last = seen.get(ev.type)
        if last is None or (ev.date - last).days >= 5:
            result.append(ev)
            seen[ev.type] = ev.date
    return result


def _build_synthese(evo: Evolution) -> str:
    """Construit un résumé narratif de l'évolution."""
    parts = []

    # Performance
    sign = "+" if evo.perf_totale_pct >= 0 else ""
    perf_str = f"Performance sur {evo.periode_jours}j : {sign}{evo.perf_totale_pct:.1f}%"
    if evo.perf_vs_index_pct is not None:
        alpha_sign = "+" if evo.perf_vs_index_pct >= 0 else ""
        perf_str += f" (alpha vs BRVMC : {alpha_sign}{evo.perf_vs_index_pct:.1f}%)"
    parts.append(perf_str)

    # Volatilité
    if evo.volatilite_63j is not None:
        niveau_vol = (
            "très faible" if evo.volatilite_63j < 10
            else "faible" if evo.volatilite_63j < 20
            else "modérée" if evo.volatilite_63j < 35
            else "élevée" if evo.volatilite_63j < 50
            else "très élevée"
        )
        parts.append(f"Volatilité annualisée : {evo.volatilite_63j:.1f}% ({niveau_vol})")

    # Drawdown
    if evo.max_drawdown_pct != 0:
        parts.append(f"Max drawdown : {evo.max_drawdown_pct:.1f}%")

    # Événements
    n_ev = len(evo.evenements)
    if n_ev:
        types_ev = list({e.type for e in evo.evenements})
        parts.append(f"{n_ev} événement(s) détecté(s) : {', '.join(types_ev)}")

    return " | ".join(parts)
