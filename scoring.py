"""
scoring.py — Algorithme de scoring multi-critères → signal ACHAT / NEUTRE / VENTE.

Chaque critère contribue à un score entre -8 et +8.
Le signal final est déterminé par des seuils paramétrables.
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

from config import SCORE_ACHAT_SEUIL, SCORE_VENTE_SEUIL, HORIZON_PROFILES, DEFAULT_HORIZON
from indicators import TechnicalIndicators

logger = logging.getLogger(__name__)


# ─── Dataclass résultat scoring ───────────────────────────────────────────────

@dataclass
class CritereScore:
    """Un critère individuel avec sa contribution au score."""
    nom: str
    valeur: str           # Valeur affichée (ex: "RSI = 28")
    points: int           # -2, -1, 0, +1, +2
    interpretation: str   # Explication courte


@dataclass
class ScoreResult:
    """Résultat complet du scoring pour un ticker."""
    ticker: str
    score_total: int = 0
    signal: str = "NEUTRE"          # ACHAT | NEUTRE | VENTE
    signal_emoji: str = "🟡"        # 🟢 | 🟡 | 🔴
    signal_color: str = "#888780"   # hex pour l'UI
    confiance: str = "faible"       # faible | modérée | forte
    criteres: list[CritereScore] = field(default_factory=list)
    score_max_possible: int = 0
    score_min_possible: int = 0
    message_synthese: str = ""


# ─── Calcul du score ──────────────────────────────────────────────────────────

def compute_score(ind: TechnicalIndicators) -> ScoreResult:
    """
    Calcule le score multi-critères avec poids adaptés à l'horizon.

    Les poids varient selon le profil :
    - Court terme : MACD×2, Stochastic×2, Tendance LT ignorée, Perf relative ignorée
    - Moyen terme : tous les critères à poids 1 (équilibré)
    - Long terme  : MA Config×2, Tendance LT×2, Perf relative×2, Stochastic ignoré
    """
    horizon = getattr(ind, "horizon", DEFAULT_HORIZON)
    profile = HORIZON_PROFILES.get(horizon, HORIZON_PROFILES[DEFAULT_HORIZON])
    w = profile["weights"]
    seuil_achat = profile["seuil_achat"]
    seuil_vente = profile["seuil_vente"]

    result = ScoreResult(ticker=ind.ticker)
    criteres = []

    # ── Critère 1 : RSI ───────────────────────────────────────────────────────
    w_rsi = w.get("rsi", 1)
    if w_rsi > 0 and ind.rsi is not None:
        if ind.rsi < 30:
            criteres.append(CritereScore(
                nom="RSI", valeur=f"RSI({ind.rsi})",
                points=+2 * w_rsi, interpretation="Survendu — potentiel rebond"
            ))
        elif ind.rsi > 70:
            criteres.append(CritereScore(
                nom="RSI", valeur=f"RSI({ind.rsi})",
                points=-2 * w_rsi, interpretation="Suracheté — risque de retournement"
            ))
        else:
            criteres.append(CritereScore(
                nom="RSI", valeur=f"RSI({ind.rsi})",
                points=0, interpretation="Zone neutre"
            ))
    elif w_rsi == 0:
        pass  # Critère désactivé pour cet horizon
    else:
        criteres.append(CritereScore(
            nom="RSI", valeur="N/D",
            points=0, interpretation="Données insuffisantes"
        ))

    # ── Critère 1b : Divergence RSI ─────────────────────────────────────────
    w_rsi_div = w.get("rsi", 1)  # Même poids que le RSI
    if w_rsi_div > 0 and ind.rsi_divergence != "aucune":
        if ind.rsi_divergence == "haussiere_forte":
            criteres.append(CritereScore(
                nom="Divergence RSI", valeur=f"Div. haussière forte",
                points=+2 * w_rsi_div, interpretation=ind.rsi_divergence_detail or "Divergence haussière forte RSI — fort potentiel de hausse"
            ))
        elif ind.rsi_divergence == "haussiere":
            criteres.append(CritereScore(
                nom="Divergence RSI", valeur=f"Div. haussière",
                points=+1 * w_rsi_div, interpretation=ind.rsi_divergence_detail or "Divergence haussière RSI — potentiel rebond"
            ))
        elif ind.rsi_divergence == "baissiere_forte":
            criteres.append(CritereScore(
                nom="Divergence RSI", valeur=f"Div. baissière forte",
                points=-2 * w_rsi_div, interpretation=ind.rsi_divergence_detail or "Divergence baissière forte RSI — fort risque de baisse"
            ))
        elif ind.rsi_divergence == "baissiere":
            criteres.append(CritereScore(
                nom="Divergence RSI", valeur=f"Div. baissière",
                points=-1 * w_rsi_div, interpretation=ind.rsi_divergence_detail or "Divergence baissière RSI — risque de correction"
            ))

    # ── Critère 2 : Moyennes mobiles (configuration) ──────────────────────────
    w_ma = w.get("ma_config", 1)
    ma_lt_label = f"MA{ind.ma_lt_period}" if ind.ma_lt_period else "MA LT"
    if w_ma > 0:
        if ind.ma20 is not None and ind.ma50 is not None and ind.ma_lt is not None:
            if ind.ma_signal == "golden_cross":
                criteres.append(CritereScore(
                    nom="MA Config",
                    valeur=f"MA20({ind.ma20}) > MA50({ind.ma50}) > {ma_lt_label}({ind.ma_lt})",
                    points=+2 * w_ma, interpretation=f"Golden Cross — fort signal haussier (réf. {ma_lt_label})"
                ))
            elif ind.ma_signal == "death_cross":
                criteres.append(CritereScore(
                    nom="MA Config",
                    valeur=f"MA20({ind.ma20}) < MA50({ind.ma50}) < {ma_lt_label}({ind.ma_lt})",
                    points=-2 * w_ma, interpretation=f"Death Cross — fort signal baissier (réf. {ma_lt_label})"
                ))
            elif ind.ma_signal == "bullish":
                criteres.append(CritereScore(
                    nom="MA Config",
                    valeur=f"MA20({ind.ma20}) > MA50({ind.ma50})",
                    points=+1 * w_ma, interpretation="MA court terme > moyen terme — tendance positive"
                ))
            else:
                criteres.append(CritereScore(
                    nom="MA Config",
                    valeur=f"MA20({ind.ma20}) < MA50({ind.ma50})",
                    points=-1 * w_ma, interpretation="MA court terme < moyen terme — tendance négative"
                ))
        elif ind.ma20 is not None and ind.ma50 is not None:
            p_pts = +1 * w_ma if ind.ma20 > ind.ma50 else -1 * w_ma
            interp = "MA court > moyen (bullish)" if p_pts > 0 else "MA court < moyen (bearish)"
            criteres.append(CritereScore(
                nom="MA Config",
                valeur=f"MA20({ind.ma20}) / MA50({ind.ma50})",
                points=p_pts, interpretation=interp
            ))
        else:
            criteres.append(CritereScore(
                nom="MA Config", valeur="N/D",
                points=0, interpretation="Données insuffisantes (< 50 séances)"
            ))

    # ── Critère 3 : Prix vs MA Long Terme ────────────────────────────────────
    w_lt = w.get("tendance_lt", 1)
    if w_lt > 0:
        if ind.ma_lt is not None:
            if ind.prix_vs_ma_lt == "au_dessus":
                criteres.append(CritereScore(
                    nom="Tendance LT",
                    valeur=f"Cours({ind.cours_actuel}) > {ma_lt_label}({ind.ma_lt})",
                    points=+1 * w_lt, interpretation=f"Au-dessus de la {ma_lt_label} — tendance long terme haussière"
                ))
            else:
                criteres.append(CritereScore(
                    nom="Tendance LT",
                    valeur=f"Cours({ind.cours_actuel}) < {ma_lt_label}({ind.ma_lt})",
                    points=-1 * w_lt, interpretation=f"En-dessous de la {ma_lt_label} — tendance long terme baissière"
                ))
        else:
            criteres.append(CritereScore(
                nom="Tendance LT", valeur="N/D",
                points=0, interpretation="Données insuffisantes (< 100 séances)"
            ))

    # ── Critère 4 : MACD ──────────────────────────────────────────────────────
    w_macd = w.get("macd", 1)
    if w_macd > 0:
        if ind.macd_line is not None and ind.macd_signal_line is not None:
            if ind.macd_signal == "haussier":
                criteres.append(CritereScore(
                    nom="MACD",
                    valeur=f"MACD({ind.macd_line:.4f}) > Signal({ind.macd_signal_line:.4f})",
                    points=+1 * w_macd, interpretation="MACD au-dessus de sa ligne signal — momentum haussier"
                ))
            else:
                criteres.append(CritereScore(
                    nom="MACD",
                    valeur=f"MACD({ind.macd_line:.4f}) < Signal({ind.macd_signal_line:.4f})",
                    points=-1 * w_macd, interpretation="MACD sous sa ligne signal — momentum baissier"
                ))
        else:
            criteres.append(CritereScore(
                nom="MACD", valeur="N/D",
                points=0, interpretation="Données insuffisantes"
            ))

    # ── Critère 5 : Performance relative vs indice ────────────────────────────
    w_perf = w.get("perf_relative", 1)
    if w_perf > 0:
        if ind.perf_vs_index_1m is not None:
            if ind.perf_vs_index_1m > 2:
                criteres.append(CritereScore(
                    nom="Perf relative",
                    valeur=f"Alpha 1M = +{ind.perf_vs_index_1m:.1f}% vs BRVMC",
                    points=+1 * w_perf, interpretation="Sur-performance vs indice BRVM (+2% de seuil)"
                ))
            elif ind.perf_vs_index_1m < -2:
                criteres.append(CritereScore(
                    nom="Perf relative",
                    valeur=f"Alpha 1M = {ind.perf_vs_index_1m:.1f}% vs BRVMC",
                    points=-1 * w_perf, interpretation="Sous-performance vs indice BRVM (-2% de seuil)"
                ))
            else:
                criteres.append(CritereScore(
                    nom="Perf relative",
                    valeur=f"Alpha 1M = {ind.perf_vs_index_1m:+.1f}% vs BRVMC",
                    points=0, interpretation="Performance en ligne avec l'indice"
                ))
        elif ind.perf_1m is not None:
            criteres.append(CritereScore(
                nom="Perf 1M",
                valeur=f"Perf 1M = {ind.perf_1m:+.1f}% (indice indisponible)",
                points=0, interpretation="Indice BRVMC non disponible pour comparaison"
            ))
        else:
            criteres.append(CritereScore(
                nom="Perf relative", valeur="N/D",
                points=0, interpretation="Historique insuffisant"
            ))

    # ── Critère 6 : Stochastic Oscillator ─────────────────────────────────────
    w_stoch = w.get("stochastic", 1)
    if w_stoch > 0:
        if ind.stoch_k is not None:
            if ind.stoch_k < 20:
                criteres.append(CritereScore(
                    nom="Stochastic",
                    valeur=f"%K({ind.stoch_k}) / %D({ind.stoch_d})",
                    points=+1 * w_stoch, interpretation="Zone de survente — potentiel rebond"
                ))
            elif ind.stoch_k > 80:
                criteres.append(CritereScore(
                    nom="Stochastic",
                    valeur=f"%K({ind.stoch_k}) / %D({ind.stoch_d})",
                    points=-1 * w_stoch, interpretation="Zone de surachat — risque de correction"
                ))
            else:
                criteres.append(CritereScore(
                    nom="Stochastic",
                    valeur=f"%K({ind.stoch_k}) / %D({ind.stoch_d})",
                    points=0, interpretation="Zone neutre"
                ))
        else:
            criteres.append(CritereScore(
                nom="Stochastic", valeur="N/D",
                points=0, interpretation="Données insuffisantes"
            ))

    # ── Calcul score total ────────────────────────────────────────────────────
    score = sum(c.points for c in criteres)
    points_positifs = [c.points for c in criteres if c.points > 0]
    points_negatifs = [c.points for c in criteres if c.points < 0]

    result.criteres = criteres
    result.score_total = score
    result.score_max_possible = sum(points_positifs) if points_positifs else 0
    result.score_min_possible = sum(points_negatifs) if points_negatifs else 0

    # ── Signal final ──────────────────────────────────────────────────────────
    if score >= seuil_achat:
        result.signal = "ACHAT"
        result.signal_emoji = "🟢"
        result.signal_color = "#0F6E56"
    elif score <= seuil_vente:
        result.signal = "VENTE"
        result.signal_emoji = "🔴"
        result.signal_color = "#A32D2D"
    else:
        result.signal = "NEUTRE"
        result.signal_emoji = "🟡"
        result.signal_color = "#BA7517"

    # ── Niveau de confiance ───────────────────────────────────────────────────
    criteres_avec_donnees = [c for c in criteres if c.valeur != "N/D"]
    taux_couverture = len(criteres_avec_donnees) / len(criteres)

    if taux_couverture >= 0.8 and abs(score) >= 4:
        result.confiance = "forte"
    elif taux_couverture >= 0.6 and abs(score) >= 2:
        result.confiance = "modérée"
    else:
        result.confiance = "faible"

    # ── Message de synthèse ───────────────────────────────────────────────────
    result.message_synthese = _build_synthese(result, ind)

    logger.info(
        f"[Scoring] {ind.ticker} → {result.signal} "
        f"(score: {score:+d}, confiance: {result.confiance})"
    )

    return result


# ─── Message de synthèse ──────────────────────────────────────────────────────

def _build_synthese(result: ScoreResult, ind: TechnicalIndicators) -> str:
    """Construit un message de synthèse d'une ligne pour l'affichage dashboard."""
    parts = []

    # Tendance MA
    ma_labels = {
        "golden_cross": "Tendance haussière forte",
        "death_cross": "Tendance baissière forte",
        "bullish": "Tendance haussière",
        "bearish": "Tendance baissière",
        "neutre": "Tendance neutre",
    }
    parts.append(ma_labels.get(ind.ma_signal, "Tendance indéterminée"))

    # RSI
    if ind.rsi is not None:
        rsi_labels = {
            "survendu": f"RSI={ind.rsi} (survendu)",
            "suracheté": f"RSI={ind.rsi} (suracheté)",
            "neutre": f"RSI={ind.rsi} (neutre)",
        }
        parts.append(rsi_labels.get(ind.rsi_signal, f"RSI={ind.rsi}"))

    # Divergence RSI
    if ind.rsi_divergence != "aucune":
        div_short = {
            "haussiere_forte": "Div.RSI haussière forte ↗",
            "haussiere": "Div.RSI haussière ↗",
            "baissiere_forte": "Div.RSI baissière forte ↘",
            "baissiere": "Div.RSI baissière ↘",
        }
        parts.append(div_short.get(ind.rsi_divergence, ""))

    # MACD
    if ind.macd_signal != "neutre":
        parts.append(f"MACD {ind.macd_signal}")

    # S/R
    if ind.support and ind.resistance:
        parts.append(f"Support={ind.support:,.0f} / Résistance={ind.resistance:,.0f}")

    # Config
    config_labels = {
        "canal_ascendant": "Canal ascendant",
        "canal_descendant": "Canal descendant",
        "range_lateral": "Range latéral",
        "squeeze_bollinger": "Squeeze Bollinger",
        "indéterminé": "",
    }
    cfg = config_labels.get(ind.config_chartiste, "")
    if cfg:
        parts.append(f"Config: {cfg}")

    # Volume
    if ind.volume_relatif_pct != 0:
        vol_str = f"+{ind.volume_relatif_pct:.0f}%" if ind.volume_relatif_pct > 0 else f"{ind.volume_relatif_pct:.0f}%"
        parts.append(f"Volume {vol_str} vs moy20j")

    return " | ".join(parts)
