"""
analysis.py — Analyse chartiste narrative et rapport complet pour un ticker BRVM.
"""

import logging
from dataclasses import dataclass
from typing import Optional

import pandas as pd
import numpy as np

from indicators import TechnicalIndicators
from scoring import ScoreResult

logger = logging.getLogger(__name__)


@dataclass
class AnalyseComplete:
    """Rapport d'analyse complet combinant indicateurs + score + narratif."""

    ticker: str
    nom_complet: str = ""

    # Résumé une ligne
    synthese_courte: str = ""

    # Sections de l'analyse narrative
    section_tendance: str = ""
    section_momentum: str = ""
    section_niveaux: str = ""
    section_chartiste: str = ""
    section_volume: str = ""
    section_stochastic: str = ""
    section_adx: str = ""
    section_divergence: str = ""
    section_3mois: str = ""
    section_events: str = ""
    section_actualites: str = ""

    # Actualités scrappées
    actualites: list[dict] = None

    # Narrative complète
    analyse_narrative: str = ""

    # Alertes et points d'attention
    alertes: list[str] = None

    # Horizon recommandé
    horizon: str = "Moyen terme (1–6 mois)"

    def __post_init__(self):
        if self.alertes is None:
            self.alertes = []
        if self.actualites is None:
            self.actualites = []


def compute_position_size(
    score: ScoreResult,
    ind: TechnicalIndicators,
    risk_pct: float = 1.0,
) -> Optional[float]:
    """
    D2 — Position sizing hiérarchisé par confiance et potentiel de gain.

    base        = risk_pct / stop_distance_pct × 100
    conf_factor = forte=1.0 | modérée=0.65 | faible=0.35
    gain_factor = score_total / score_max mappé → [0.75, 1.25]
    final       = base × conf_factor × gain_factor × haircut_liquidité
    Clampé [1%, 10%].
    """
    if score.stop_loss is None or ind.atr_pct is None or ind.atr_pct <= 0:
        return None
    if score.signal == "NEUTRE" or ind.cours_actuel <= 0:
        return None

    k1 = abs(score.stop_loss - ind.cours_actuel) / ind.cours_actuel * 100
    if k1 <= 0:
        return None

    base = risk_pct / k1 * 100

    # ── Facteur confiance (hiérarchie primaire) ───────────────────────────────
    _CONF = {"forte": 1.0, "modérée": 0.65, "faible": 0.35}
    conf_factor = _CONF.get(score.confiance, 0.5)

    # ── Facteur potentiel de gain (score normalisé) ───────────────────────────
    # ratio ∈ [0, 1]  →  gain_factor ∈ [0.75, 1.25]
    # score=0 → 0.75 (signal au seuil), score=max → 1.25 (tous critères alignés)
    if score.score_max_possible > 0:
        ratio = max(0.0, min(1.0, score.score_total / score.score_max_possible))
        gain_factor = 0.75 + ratio * 0.5
    else:
        gain_factor = 1.0

    raw = base * conf_factor * gain_factor

    # ── Haircut liquidité BRVM ────────────────────────────────────────────────
    vol_moy = getattr(ind, "volume_moy20", None)
    if vol_moy is not None and vol_moy > 0:
        if vol_moy < 100:
            raw *= 0.50
        elif vol_moy < 500:
            raw *= 0.70
        else:
            raw *= 0.85

    return round(min(10.0, max(1.0, raw)), 1)


def _vwap_risk_levels(
    prix: float,
    df: pd.DataFrame,
    atr: float,
    signal: str,
    vwap_window: int = 20,
    k_stop: float = 1.5,
    k_target: float = 2.5,
) -> tuple[Optional[float], Optional[float]]:
    """
    Stop/target ancrés sur VWAP rolling avec multiplicateurs paramétrables.
    R/R garanti >= 1.5 ; fallback ATR si volume absent ou niveaux incohérents.
    """
    if len(df) < vwap_window or df["volume"].sum() == 0:
        return None, None

    recent = df.iloc[-vwap_window:]
    tp     = (recent["high"] + recent["low"] + recent["close"]) / 3
    vol    = recent["volume"].replace(0, 1)
    vwap   = float((tp * vol).sum() / vol.sum())
    std    = float(tp.std())

    if std <= 0:
        return None, None

    if signal == "ACHAT":
        stop   = vwap - k_stop   * std
        target = vwap + k_target * std
        if stop >= prix or target <= prix:
            return None, None
    else:  # VENTE
        stop   = vwap + k_stop   * std
        target = vwap - k_target * std
        if stop <= prix or target >= prix:
            return None, None

    dist_stop   = abs(prix - stop)
    dist_target = abs(target - prix)
    if dist_stop > 0 and dist_target / dist_stop < 1.5:
        if signal == "ACHAT":
            target = prix + 1.5 * dist_stop
        else:
            target = prix - 1.5 * dist_stop

    return round(max(0.0, stop), 2), round(max(0.0, target), 2)


def compute_risk_levels(
    score: ScoreResult,
    ind: TechnicalIndicators,
    df: Optional[pd.DataFrame] = None,
) -> tuple[Optional[float], Optional[float]]:
    """
    Stop-loss et take-profit adaptés à l'horizon.

    Méthode principale : VWAP rolling (fenêtre adaptée à l'horizon).
    Fallback : ATR-based avec multiplicateurs k₁/k₂ selon la confiance.

    Paramètres VWAP par horizon :
      Court terme  → window=10j, stop=-1.0σ, target=+1.5σ  (sorties rapides)
      Moyen terme  → window=20j, stop=-1.5σ, target=+2.5σ  (équilibré)
      Long terme   → window=40j, stop=-2.0σ, target=+3.5σ  (laisser courir)

    Returns (stop_loss, take_profit) ou (None, None) si signal NEUTRE / données absentes.
    """
    if score.signal == "NEUTRE":
        return None, None
    if ind.atr is None or ind.atr <= 0 or ind.cours_actuel <= 0:
        return None, None

    prix = ind.cours_actuel

    # Paramètres VWAP selon horizon
    _vwap_params = {
        "Court terme": {"window": 10, "k_stop": 1.0, "k_target": 1.5},
        "Moyen terme": {"window": 20, "k_stop": 1.5, "k_target": 2.5},
        "Long terme":  {"window": 40, "k_stop": 2.0, "k_target": 3.5},
    }
    horizon = getattr(ind, "horizon", "Moyen terme") or "Moyen terme"
    vp = _vwap_params.get(horizon, _vwap_params["Moyen terme"])

    # ── Méthode principale : VWAP ─────────────────────────────────────────────
    if df is not None and len(df) >= vp["window"]:
        stop, target = _vwap_risk_levels(
            prix, df, ind.atr, score.signal,
            vwap_window=vp["window"],
            k_stop=vp["k_stop"],
            k_target=vp["k_target"],
        )
        if stop is not None and target is not None:
            return stop, target

    # ── Fallback : ATR-based ──────────────────────────────────────────────────
    if score.confiance == "forte":
        k1, k2 = 2.5, 5.0
    elif score.confiance == "modérée":
        k1, k2 = 2.0, 4.0
    else:
        k1, k2 = 1.5, 3.0

    if score.signal == "ACHAT":
        stop   = prix - k1 * ind.atr
        target = prix + k2 * ind.atr
    else:
        stop   = prix + k1 * ind.atr
        target = prix - k2 * ind.atr

    return round(max(0.0, stop), 2), round(max(0.0, target), 2)


def build_analyse(
    ind: TechnicalIndicators,
    score: ScoreResult,
    df: Optional[pd.DataFrame] = None,
) -> AnalyseComplete:
    """
    Construit l'analyse narrative complète à partir des indicateurs et du score.

    Args:
        ind:   Indicateurs techniques calculés
        score: Résultat du scoring
        df:    DataFrame OHLCV brut (pour calculs supplémentaires)

    Returns:
        AnalyseComplete avec toutes les sections remplies
    """
    analyse = AnalyseComplete(ticker=ind.ticker)

    # ── Section 1 : Tendance générale ─────────────────────────────────────────
    analyse.section_tendance = _build_tendance(ind, df)

    # ── Section 2 : Momentum ──────────────────────────────────────────────────
    analyse.section_momentum = _build_momentum(ind)

    # ── Section 3 : Niveaux clés ──────────────────────────────────────────────
    analyse.section_niveaux = _build_niveaux(ind)

    # ── Section 4 : Configuration chartiste ──────────────────────────────────
    analyse.section_chartiste = _build_chartiste(ind)

    # ── Section 5 : Volume ────────────────────────────────────────────────────
    analyse.section_volume = _build_volume(ind)

    # ── Section 6 : Stochastic ────────────────────────────────────────────────
    analyse.section_stochastic = _build_stochastic(ind)

    # ── Section 7 : ADX ───────────────────────────────────────────────────────
    analyse.section_adx = _build_adx(ind)

    # ── Section 8 : Divergence RSI ─────────────────────────────────────────
    analyse.section_divergence = _build_divergence(ind)

    # ── Section 9 : Analyse 3 mois ──────────────────────────────────────────
    analyse.section_3mois = _build_3mois(ind)

    # ── Section 10 : Événements techniques ───────────────────────────────────
    analyse.section_events = _build_events(ind)

    # ── Alertes ───────────────────────────────────────────────────────────────
    analyse.alertes = _build_alertes(ind, score)

    # ── Risk levels D1 + position sizing D2 — enrichit score in-place ──────────
    score.stop_loss, score.take_profit = compute_risk_levels(score, ind, df)
    score.position_size_pct = compute_position_size(score, ind)

    # ── Journal de tracking J1 — log automatique des signaux exploitables ─────
    try:
        from tracking import log_signal
        log_signal(ind, score)
    except Exception as _e:
        logger.debug(f"[Tracking] Skipped — {_e}")

    # ── Synthèse courte (format one-liner) ───────────────────────────────────
    analyse.synthese_courte = _build_synthese_courte(ind, score)

    # ── Narrative complète ────────────────────────────────────────────────────
    analyse.analyse_narrative = "\n".join([
        f"📈 TENDANCE   : {analyse.section_tendance}",
        f"⚡ MOMENTUM   : {analyse.section_momentum}",
        f"🎯 NIVEAUX    : {analyse.section_niveaux}",
        f"📊 CHARTISTE  : {analyse.section_chartiste}",
        f"📦 VOLUME     : {analyse.section_volume}",
        f"🔄 STOCHASTIC : {analyse.section_stochastic}",
        f"💪 ADX        : {analyse.section_adx}",
        f"🔀 DIVERGENCE : {analyse.section_divergence}",
        f"📅 3 MOIS     : {analyse.section_3mois}",
    ])

    return analyse


# ─── Sections narratives ──────────────────────────────────────────────────────

def _build_tendance(ind: TechnicalIndicators, df: Optional[pd.DataFrame]) -> str:
    """Décrit la tendance générale sur 3 mois."""

    # Calcul de la pente de la MA50 sur 20 séances
    slope_desc = ""
    if "ma50" in ind.series and len(ind.series["ma50"]) >= 20:
        ma50_series = list(ind.series["ma50"].values())
        recent_ma50 = ma50_series[-20:]
        slope = (recent_ma50[-1] - recent_ma50[0]) / recent_ma50[0] * 100
        if slope > 2:
            slope_desc = f"MA50 en progression (+{slope:.1f}% sur 20 séances)"
        elif slope < -2:
            slope_desc = f"MA50 en recul ({slope:.1f}% sur 20 séances)"
        else:
            slope_desc = f"MA50 quasi-stable ({slope:+.1f}% sur 20 séances)"

    tendance_labels = {
        "golden_cross": "haussière forte",
        "bullish": "haussière modérée",
        "bearish": "baissière modérée",
        "death_cross": "baissière forte",
        "neutre": "neutre/indéterminée",
    }
    tendance = tendance_labels.get(ind.ma_signal, "indéterminée")

    perf_str = ""
    if ind.perf_3m is not None:
        perf_str = f" | Performance 3M : {ind.perf_3m:+.1f}%"
    if ind.perf_1m is not None:
        perf_str += f" | 1M : {ind.perf_1m:+.1f}%"

    parts = [f"Tendance {tendance}"]
    if slope_desc:
        parts.append(slope_desc)
    if perf_str:
        parts.append(perf_str.strip(" |"))

    return " — ".join(parts)


def _build_momentum(ind: TechnicalIndicators) -> str:
    """Décrit le momentum via RSI et MACD."""
    parts = []

    # RSI
    if ind.rsi is not None:
        rsi_interp = {
            "survendu": f"RSI à {ind.rsi} → zone de survente, rebond potentiel",
            "suracheté": f"RSI à {ind.rsi} → zone de surachat, prudence",
            "neutre": f"RSI à {ind.rsi} → momentum neutre",
        }
        parts.append(rsi_interp.get(ind.rsi_signal, f"RSI={ind.rsi}"))

        # Divergence RSI
        if ind.rsi_divergence != "aucune":
            div_labels = {
                "haussiere_forte": "🟢 DIVERGENCE HAUSSIÈRE FORTE",
                "haussiere": "🟢 Divergence haussière",
                "baissiere_forte": "🔴 DIVERGENCE BAISSIÈRE FORTE",
                "baissiere": "🔴 Divergence baissière",
            }
            label = div_labels.get(ind.rsi_divergence, "")
            detail = ind.rsi_divergence_detail if ind.rsi_divergence_detail else ""
            parts.append(f"{label} — {detail}" if detail else label)

    # MACD
    if ind.macd_line is not None and ind.macd_signal_line is not None:
        diff = ind.macd_line - ind.macd_signal_line
        direction = "haussier" if diff > 0 else "baissier"
        strength = "faible" if abs(diff) < 0.001 else "marqué"
        parts.append(f"MACD {direction} ({strength}, écart: {diff:+.4f})")
    else:
        parts.append("MACD non disponible")

    return " | ".join(parts)


def _build_niveaux(ind: TechnicalIndicators) -> str:
    """Décrit les niveaux de support et résistance."""
    parts = []

    if ind.support:
        dist_support = ((ind.cours_actuel - ind.support) / ind.cours_actuel * 100)
        parts.append(f"Support: {ind.support:,.0f} FCFA ({dist_support:.1f}% sous le cours)")

    if ind.resistance:
        dist_resist = ((ind.resistance - ind.cours_actuel) / ind.cours_actuel * 100)
        parts.append(f"Résistance: {ind.resistance:,.0f} FCFA ({dist_resist:.1f}% au-dessus)")

    if ind.ma_lt:
        ma_label = f"MA{ind.ma_lt_period}" if ind.ma_lt_period else "MA LT"
        parts.append(f"{ma_label}: {ind.ma_lt:,.0f} FCFA (pivot long terme)")

    if not parts:
        return "Niveaux non calculables (données insuffisantes)"

    return " | ".join(parts)


def _build_chartiste(ind: TechnicalIndicators) -> str:
    """Décrit la configuration chartiste détectée."""
    configs = {
        "canal_ascendant": (
            "Canal ascendant — série de hauts et bas croissants sur 20 séances. "
            "Tendance clairement haussière à court terme."
        ),
        "canal_descendant": (
            "Canal descendant — série de hauts et bas décroissants sur 20 séances. "
            "Pression vendeuse persistante."
        ),
        "range_lateral": (
            "Range latéral — oscillation < 5% sur 20 séances. "
            "Attendre une sortie de range pour prendre position."
        ),
        "squeeze_bollinger": (
            "Squeeze Bollinger — bandes très resserrées. "
            "Forte contraction de la volatilité, explosion imminente possible dans les deux sens."
        ),
        "indéterminé": "Configuration chartiste indéterminée sur la période d'analyse.",
    }

    base = configs.get(ind.config_chartiste, "Indéterminé")

    # Complément Bollinger
    bb_info = ""
    if ind.bb_pct is not None:
        if ind.bb_pct < 0.1:
            bb_info = " Prix proche de la bande Bollinger basse → potentiel rebond."
        elif ind.bb_pct > 0.9:
            bb_info = " Prix proche de la bande Bollinger haute → zone de résistance."

    return base + bb_info


def _build_volume(ind: TechnicalIndicators) -> str:
    """Décrit le comportement du volume."""
    if ind.volume_actuel == 0 and ind.volume_moy20 == 0:
        return "Données de volume non disponibles"

    if ind.volume_moy20 == 0:
        return f"Volume actuel : {ind.volume_actuel:,.0f} titres (moyenne non disponible)"

    sign = "+" if ind.volume_relatif_pct >= 0 else ""
    niveau = (
        "volume très élevé → forte conviction des opérateurs"
        if ind.volume_relatif_pct > 50
        else "volume élevé → signal confirmé"
        if ind.volume_relatif_pct > 20
        else "volume faible → signal à confirmer"
        if ind.volume_relatif_pct < -20
        else "volume dans la norme"
    )

    return (
        f"Volume actuel {ind.volume_actuel:,.0f} titres "
        f"({sign}{ind.volume_relatif_pct:.0f}% vs moy. 20j) — {niveau}"
    )


def _build_alertes(ind: TechnicalIndicators, score: ScoreResult) -> list[str]:
    """Génère des alertes spécifiques sur des situations particulières."""
    alertes = []

    if ind.rsi is not None:
        if ind.rsi < 20:
            alertes.append("⚠️ RSI extrêmement bas (< 20) — survente excessive, rebond technique probable")
        elif ind.rsi > 80:
            alertes.append("⚠️ RSI extrêmement haut (> 80) — surachat excessif, risque de correction")

    # Divergence RSI
    if ind.rsi_divergence in ("haussiere_forte", "baissiere_forte"):
        emoji = "📈" if "haussiere" in ind.rsi_divergence else "📉"
        alertes.append(f"{emoji} {ind.rsi_divergence_detail}")

    if ind.bb_squeeze:
        alertes.append("⚡ Squeeze Bollinger actif — explosion de volatilité imminente")

    if ind.volume_relatif_pct > 100:
        alertes.append(f"📊 Volume exceptionnel (+{ind.volume_relatif_pct:.0f}% vs moy20j) — surveiller la direction")

    if ind.ma_signal == "golden_cross":
        alertes.append("🚀 Golden Cross confirmé — signal d'achat fort")

    if ind.ma_signal == "death_cross":
        alertes.append("💀 Death Cross confirmé — signal de vente fort")

    # Convergence RSI + Stochastic
    if ind.rsi is not None and ind.stoch_k is not None:
        if ind.rsi < 30 and ind.stoch_k < 20:
            alertes.append("🔥 Double survente RSI + Stochastic — signal de rebond renforcé")
        elif ind.rsi > 70 and ind.stoch_k > 80:
            alertes.append("🔥 Double surachat RSI + Stochastic — signal de correction renforcé")

    # ADX tendance forte
    if ind.adx is not None and ind.adx > 40:
        di_dir = "haussière" if (ind.plus_di or 0) > (ind.minus_di or 0) else "baissière"
        alertes.append(f"💪 ADX très élevé ({ind.adx}) — tendance {di_dir} très forte")

    if score.confiance == "faible":
        alertes.append("ℹ️ Données partielles — signaux à confirmer avant toute décision")

    if ind.perf_vs_index_1m and abs(ind.perf_vs_index_1m) > 10:
        direction = "surperformance" if ind.perf_vs_index_1m > 0 else "sous-performance"
        alertes.append(f"📈 {direction.capitalize()} importante vs BRVMC ({ind.perf_vs_index_1m:+.1f}% sur 1M)")

    # Divergence MACD
    if hasattr(ind, "macd_divergence") and ind.macd_divergence != "aucune":
        emoji = "📈" if "haussiere" in ind.macd_divergence else "📉"
        alertes.append(f"{emoji} {ind.macd_divergence_detail}")

    # Drawdown sévère
    if hasattr(ind, "drawdown_current") and ind.drawdown_current is not None and ind.drawdown_current < -15:
        alertes.append(f"📉 Drawdown important ({ind.drawdown_current:.1f}%) — prix bien en-dessous du plus haut récent")

    # Événements techniques forts récents
    events = getattr(ind, "events", [])
    strong_events = [e for e in events if e.get("importance") == "forte"]
    for e in strong_events[:2]:
        alertes.append(f"🔔 [{e['date']}] {e['description']}")

    return alertes


def _build_stochastic(ind: TechnicalIndicators) -> str:
    """Décrit le Stochastic Oscillator."""
    if ind.stoch_k is None:
        return "Stochastic non disponible (données insuffisantes)"

    k_str = f"%K={ind.stoch_k:.1f}"
    d_str = f"%D={ind.stoch_d:.1f}" if ind.stoch_d is not None else ""

    interp = {
        "survendu": f"{k_str} / {d_str} → zone de survente (< 20), rebond potentiel",
        "suracheté": f"{k_str} / {d_str} → zone de surachat (> 80), prudence",
        "neutre": f"{k_str} / {d_str} → zone neutre",
    }
    base = interp.get(ind.stoch_signal, f"{k_str} / {d_str}")

    # Croisement %K / %D
    if ind.stoch_k is not None and ind.stoch_d is not None:
        if ind.stoch_k > ind.stoch_d:
            base += " | %K > %D (momentum haussier)"
        else:
            base += " | %K < %D (momentum baissier)"

    return base


def _build_adx(ind: TechnicalIndicators) -> str:
    """Décrit l'ADX et la force de la tendance."""
    if ind.adx is None:
        return "ADX non disponible (données insuffisantes)"

    adx_interp = {
        "tendance_forte": f"ADX={ind.adx} → tendance forte (> 25)",
        "tendance_moderee": f"ADX={ind.adx} → tendance modérée (20-25)",
        "pas_de_tendance": f"ADX={ind.adx} → pas de tendance claire (< 20), marché range",
    }
    base = adx_interp.get(ind.adx_signal, f"ADX={ind.adx}")

    if ind.plus_di is not None and ind.minus_di is not None:
        if ind.plus_di > ind.minus_di:
            base += f" | +DI({ind.plus_di}) > -DI({ind.minus_di}) → pression acheteuse"
        else:
            base += f" | -DI({ind.minus_di}) > +DI({ind.plus_di}) → pression vendeuse"

    return base


def _build_divergence(ind: TechnicalIndicators) -> str:
    """Décrit la divergence RSI détectée."""
    if ind.rsi_divergence == "aucune":
        return "Pas de divergence RSI détectée"

    labels = {
        "haussiere_forte": "🟢 DIVERGENCE HAUSSIÈRE FORTE",
        "haussiere": "🟢 Divergence haussière",
        "baissiere_forte": "🔴 DIVERGENCE BAISSIÈRE FORTE",
        "baissiere": "🔴 Divergence baissière",
    }
    label = labels.get(ind.rsi_divergence, "Divergence détectée")
    detail = ind.rsi_divergence_detail or ""
    return f"{label} — {detail}" if detail else label


def _build_synthese_courte(ind: TechnicalIndicators, score: ScoreResult) -> str:
    """
    Synthèse ultra-concise format one-liner pour le tableau récapitulatif.
    """
    tendance_labels = {
        "golden_cross": "Haussier fort",
        "bullish": "Haussier",
        "bearish": "Baissier",
        "death_cross": "Baissier fort",
        "neutre": "Neutre",
    }
    tendance = tendance_labels.get(ind.ma_signal, "—")

    rsi_str = f"RSI={ind.rsi}" if ind.rsi else "RSI=N/D"
    macd_str = f"MACD {ind.macd_signal}" if ind.macd_signal != "neutre" else ""
    sr_str = (
        f"S={ind.support:,.0f}/R={ind.resistance:,.0f}"
        if ind.support and ind.resistance else ""
    )
    config_str = ind.config_chartiste.replace("_", " ").capitalize()
    vol_str = f"Vol {ind.volume_relatif_pct:+.0f}%" if ind.volume_relatif_pct else ""

    parts = [tendance, rsi_str]
    if ind.rsi_divergence != "aucune":
        div_short = {"haussiere_forte": "DivRSI↗↗", "haussiere": "DivRSI↗",
                     "baissiere_forte": "DivRSI↘↘", "baissiere": "DivRSI↘"}
        parts.append(div_short.get(ind.rsi_divergence, ""))
    if macd_str:
        parts.append(macd_str)
    if sr_str:
        parts.append(sr_str)
    if config_str and config_str != "Indéterminé":
        parts.append(config_str)
    if vol_str:
        parts.append(vol_str)

    return " | ".join(parts)


def _build_3mois(ind: TechnicalIndicators) -> str:
    """Décrit l'analyse sur 3 mois : volatilité, drawdown, performance relative."""
    parts = []

    if ind.perf_3m is not None:
        parts.append(f"Performance 3M : {ind.perf_3m:+.1f}%")

    if ind.perf_vs_index_3m is not None:
        alpha = ind.perf_vs_index_3m
        label = "surperformance" if alpha > 0 else "sous-performance"
        parts.append(f"Alpha vs BRVMC : {alpha:+.1f}% ({label})")

    if ind.volatilite_3m is not None:
        vol_level = (
            "très volatile" if ind.volatilite_3m > 40
            else "volatile" if ind.volatilite_3m > 25
            else "modérée" if ind.volatilite_3m > 15
            else "faible"
        )
        parts.append(f"Volatilité : {ind.volatilite_3m:.1f}% ann. ({vol_level})")

    if ind.drawdown_max_3m is not None:
        parts.append(f"Drawdown max 3M : {ind.drawdown_max_3m:.1f}%")

    if ind.drawdown_current is not None and ind.drawdown_current < -1:
        parts.append(f"Drawdown courant : {ind.drawdown_current:.1f}%")

    if ind.pct_from_52w_high is not None:
        if ind.pct_from_52w_high > -2:
            parts.append(f"Proche du plus haut 52 semaines ({ind.high_52w:,.0f} FCFA)")
        elif ind.pct_from_52w_high < -20:
            parts.append(f"À {ind.pct_from_52w_high:.0f}% du plus haut 52S ({ind.high_52w:,.0f} FCFA)")

    if not parts:
        return "Données insuffisantes pour l'analyse 3 mois"

    return " | ".join(parts)


def _build_events(ind: TechnicalIndicators) -> str:
    """Décrit les événements techniques détectés récemment."""
    events = getattr(ind, "events", [])
    if not events:
        return "Aucun événement technique notable détecté"

    strong = [e for e in events if e.get("importance") == "forte"]
    moderate = [e for e in events if e.get("importance") == "modérée"]

    parts = []
    if strong:
        parts.append(f"{len(strong)} événement(s) fort(s)")
        for e in strong[:3]:
            parts.append(f"  [{e['date']}] {e['description']}")
    if moderate:
        parts.append(f"{len(moderate)} événement(s) modéré(s)")
        for e in moderate[:2]:
            parts.append(f"  [{e['date']}] {e['description']}")

    return " — ".join(parts) if len(parts) <= 3 else "\n".join(parts)
