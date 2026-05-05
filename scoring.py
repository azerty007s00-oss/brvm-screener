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
    stop_loss: Optional[float] = None    # D1 — ATR-based, conditionné par confiance
    take_profit: Optional[float] = None  # D1 — ATR-based, ratio R/R asymétrique
    position_size_pct: Optional[float] = None  # D2 — % du capital à allouer
    multiplicateur_liquidite: float = 1.0  # D2 — facteur de pondération par liquidité (0.25–1.0)


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

    # Tendance haussière confirmée : MA bullish + ADX >= 20 (trend présent)
    # Conditionne l'interprétation du RSI et du Stochastic (momentum vs oscillateur)
    in_uptrend = (
        ind.ma_signal in ("bullish", "golden_cross")
        and ind.adx is not None
        and ind.adx >= 20
    )

    # ── Critère 1 : RSI ───────────────────────────────────────────────────────
    w_rsi = w.get("rsi", 1)
    if w_rsi > 0 and ind.rsi is not None:
        # Seuils adaptatifs C2 — percentile local ; fallback 30/70 si non calculé
        rsi_lo = ind.rsi_p10 if ind.rsi_p10 is not None else 30.0
        rsi_hi = ind.rsi_p90 if ind.rsi_p90 is not None else 70.0
        seuil_str = f"P10={rsi_lo:.0f}/P90={rsi_hi:.0f}" if ind.rsi_p10 is not None else "30/70"
        if ind.rsi < rsi_lo:
            # Survendu : rebond en MR, mais en uptrend = momentum qui s'affaiblit
            pts = -1 * w_rsi if in_uptrend else +2 * w_rsi
            interp = ("RSI bas malgré tendance haussière — momentum s'affaiblit" if in_uptrend
                      else f"Survendu (< {rsi_lo:.0f}) — potentiel rebond")
            criteres.append(CritereScore(
                nom="RSI", valeur=f"RSI({ind.rsi}) [{seuil_str}]",
                points=pts, interpretation=interp,
            ))
        elif ind.rsi > rsi_hi:
            # Au-dessus du P90 adaptatif : pénalité normale hors uptrend, réduite en uptrend
            pts = -1 * w_rsi if in_uptrend else -2 * w_rsi
            interp = ("RSI élevé en tendance haussière — momentum fort, prudence" if in_uptrend
                      else f"Suracheté (> {rsi_hi:.0f}) — risque de retournement")
            criteres.append(CritereScore(
                nom="RSI", valeur=f"RSI({ind.rsi}) [{seuil_str}]",
                points=pts, interpretation=interp,
            ))
        elif ind.rsi > 65 and not in_uptrend:
            # Hard ceiling uniquement hors uptrend confirmé
            criteres.append(CritereScore(
                nom="RSI", valeur=f"RSI({ind.rsi}) [{seuil_str}]",
                points=-1 * w_rsi,
                interpretation="RSI élevé (>65) — zone de prudence même hors P90",
            ))
        elif in_uptrend and ind.rsi >= 50:
            # RSI 50–rsi_hi en uptrend : momentum sain, signal positif
            criteres.append(CritereScore(
                nom="RSI", valeur=f"RSI({ind.rsi}) [{seuil_str}]",
                points=+1 * w_rsi,
                interpretation="RSI en zone de tendance haussière — momentum sain",
            ))
        else:
            criteres.append(CritereScore(
                nom="RSI", valeur=f"RSI({ind.rsi}) [{seuil_str}]",
                points=0, interpretation="Zone neutre",
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
        if ind.perf_vs_index_1m_atr_norm is not None:
            # ATR-normalized alpha (B3) : seuil ±1.0 ATR-unit — risk-adjusted
            norm = ind.perf_vs_index_1m_atr_norm
            alpha_str = f"{ind.perf_vs_index_1m:+.1f}%" if ind.perf_vs_index_1m is not None else "?"
            if norm > 1.0:
                criteres.append(CritereScore(
                    nom="Perf relative",
                    valeur=f"Alpha 1M = {alpha_str} vs BRVMC ({norm:+.2f} ATR)",
                    points=+1 * w_perf,
                    interpretation="Sur-performance risk-adjusted > 1 ATR mensuel",
                ))
            elif norm < -1.0:
                criteres.append(CritereScore(
                    nom="Perf relative",
                    valeur=f"Alpha 1M = {alpha_str} vs BRVMC ({norm:+.2f} ATR)",
                    points=-1 * w_perf,
                    interpretation="Sous-performance risk-adjusted < -1 ATR mensuel",
                ))
            else:
                criteres.append(CritereScore(
                    nom="Perf relative",
                    valeur=f"Alpha 1M = {alpha_str} vs BRVMC ({norm:+.2f} ATR)",
                    points=0,
                    interpretation="Performance en ligne avec l'indice (< 1 ATR d'écart)",
                ))
        elif ind.perf_vs_index_1m is not None:
            # Fallback brut si ATR indisponible (série trop courte)
            if ind.perf_vs_index_1m > 2:
                criteres.append(CritereScore(
                    nom="Perf relative",
                    valeur=f"Alpha 1M = +{ind.perf_vs_index_1m:.1f}% vs BRVMC",
                    points=+1 * w_perf, interpretation="Sur-performance vs indice BRVM (ATR non dispo)"
                ))
            elif ind.perf_vs_index_1m < -2:
                criteres.append(CritereScore(
                    nom="Perf relative",
                    valeur=f"Alpha 1M = {ind.perf_vs_index_1m:.1f}% vs BRVMC",
                    points=-1 * w_perf, interpretation="Sous-performance vs indice BRVM (ATR non dispo)"
                ))
            else:
                criteres.append(CritereScore(
                    nom="Perf relative",
                    valeur=f"Alpha 1M = {ind.perf_vs_index_1m:+.1f}% vs BRVMC",
                    points=0, interpretation="Performance en ligne avec l'indice"
                ))
        elif ind.perf_1m is not None:
            # Fallback absolu : sans indice, la perf brute signale au moins les cas extrêmes
            if ind.perf_1m < -2:
                criteres.append(CritereScore(
                    nom="Perf 1M",
                    valeur=f"Perf 1M = {ind.perf_1m:+.1f}% (indice indisponible)",
                    points=-1 * w_perf,
                    interpretation="Baisse >2% sans indice disponible — signal baissier absolu",
                ))
            elif ind.perf_1m > 5:
                criteres.append(CritereScore(
                    nom="Perf 1M",
                    valeur=f"Perf 1M = {ind.perf_1m:+.1f}% (indice indisponible)",
                    points=+1 * w_perf,
                    interpretation="Hausse >5% sans indice disponible — signal haussier absolu",
                ))
            else:
                criteres.append(CritereScore(
                    nom="Perf 1M",
                    valeur=f"Perf 1M = {ind.perf_1m:+.1f}% (indice indisponible)",
                    points=0, interpretation="Indice BRVMC non disponible pour comparaison",
                ))
        else:
            criteres.append(CritereScore(
                nom="Perf relative", valeur="N/D",
                points=0, interpretation="Historique insuffisant"
            ))

    # ── Critère 6 : Divergence MACD ─────────────────────────────────────────
    w_macd_div = w.get("macd", 1)
    if w_macd_div > 0 and hasattr(ind, "macd_divergence") and ind.macd_divergence != "aucune":
        if ind.macd_divergence == "haussiere":
            criteres.append(CritereScore(
                nom="Divergence MACD", valeur="Div. haussière",
                points=+1 * w_macd_div,
                interpretation=ind.macd_divergence_detail or "Divergence haussière MACD — essoufflement vendeur"
            ))
        elif ind.macd_divergence == "baissiere":
            criteres.append(CritereScore(
                nom="Divergence MACD", valeur="Div. baissière",
                points=-1 * w_macd_div,
                interpretation=ind.macd_divergence_detail or "Divergence baissière MACD — essoufflement acheteur"
            ))

    # ── Critère 6b : Pente histogramme MACD — Inflexion de momentum ───────────
    # Seconde dérivée du MACD : hist = f'(MACD), slope(hist) = f''(MACD)
    # Score uniquement les transitions de régime (pas la direction brute)
    # → évite de doubler le critère MACD directionnel déjà présent
    # Histogramme > 0 ET pente < 0 : momentum haussier s'épuise → -1
    # Histogramme < 0 ET pente > 0 : momentum baissier se retourne → +1
    # Critère silencieux si aucune inflexion détectée (pas de ligne N/D)
    if ind.macd_histogram is not None and ind.macd_histogram_prev is not None:
        hist_slope = ind.macd_histogram - ind.macd_histogram_prev
        if ind.macd_histogram > 0 and hist_slope < 0:
            criteres.append(CritereScore(
                nom="MACD Momentum",
                valeur=f"Hist({ind.macd_histogram:+.4f}) ↘",
                points=-1,
                interpretation="Histogramme positif en baisse — momentum haussier s'épuise"
            ))
        elif ind.macd_histogram < 0 and hist_slope > 0:
            criteres.append(CritereScore(
                nom="MACD Momentum",
                valeur=f"Hist({ind.macd_histogram:+.4f}) ↗",
                points=+1,
                interpretation="Histogramme négatif en hausse — momentum baissier se retourne"
            ))
        # Pas d'inflexion → critère silencieux (pas de N/D, pas de dilution couverture)

    # ── Critère 6c : Pente MA50 — Trend structurel long ──────────────────────
    # Couche "trend long" du modèle 3-layer (régime → trend → timing)
    # Pente normalisée % / 5 séances → comparable cross-tickers BRVM
    # Seuil ±0.2% : en dessous = MA plate sur 5j, pas de signal structurel détectable
    # Symétrique (+1/-1) : ADX distingue déjà "baissier structurel" vs "baissier bruité"
    # Critère silencieux en zone neutre (pas de N/D) — cohérence avec 6b
    if ind.ma50_slope_pct is not None:
        if ind.ma50_slope_pct > 0.2:
            criteres.append(CritereScore(
                nom="MA50 Slope",
                valeur=f"MA50 +{ind.ma50_slope_pct:.2f}%/5j",
                points=+1,
                interpretation="MA50 en hausse structurelle — trend de fond haussier confirmé"
            ))
        elif ind.ma50_slope_pct < -0.3:
            # Pente fortement négative : trend baissier structurel prononcé
            criteres.append(CritereScore(
                nom="MA50 Slope",
                valeur=f"MA50 {ind.ma50_slope_pct:.2f}%/5j",
                points=-2,
                interpretation="MA50 en forte baisse structurelle — trend baissier de fond confirmé"
            ))
        elif ind.ma50_slope_pct < -0.2:
            criteres.append(CritereScore(
                nom="MA50 Slope",
                valeur=f"MA50 {ind.ma50_slope_pct:.2f}%/5j",
                points=-1,
                interpretation="MA50 en baisse structurelle — trend de fond baissier confirmé"
            ))
        # Entre ±0.2% : MA plate → critère silencieux (pas de N/D)
    # ind.ma50_slope_pct is None → données insuffisantes → silencieux

    # ── Critère 7 : Stochastic Oscillator ─────────────────────────────────────
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
                # En uptrend confirmé, surachat stochastique = continuation normale → neutre
                pts = 0 if in_uptrend else -1 * w_stoch
                interp = ("Surachat en tendance haussière — continuation possible"
                          if in_uptrend else "Zone de surachat — risque de correction")
                criteres.append(CritereScore(
                    nom="Stochastic",
                    valeur=f"%K({ind.stoch_k}) / %D({ind.stoch_d})",
                    points=pts, interpretation=interp
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

    # ── Critère 8 : ADX — Régime de marché ───────────────────────────────────
    # Poids fixe = 1 (régime filter, indépendant de l'horizon)
    # ADX > 25 : tendance forte, signaux directionnels fiables → +1
    # ADX < 15 : range/chop, signaux peu fiables sur BRVM illiquide → -1
    # Garde : ind.adx is None si historique < 28 séances (2× période Wilder)
    if ind.adx is not None:
        if ind.adx > 25:
            criteres.append(CritereScore(
                nom="ADX",
                valeur=f"ADX({ind.adx})",
                points=+1,
                interpretation="Tendance forte (ADX>25) — signal directionnel fiable"
            ))
        elif ind.adx < 15:
            criteres.append(CritereScore(
                nom="ADX",
                valeur=f"ADX({ind.adx})",
                points=-1,
                interpretation="Marché en range (ADX<15) — signaux directionnels peu fiables"
            ))
        else:
            criteres.append(CritereScore(
                nom="ADX",
                valeur=f"ADX({ind.adx})",
                points=0,
                interpretation="Tendance modérée (15≤ADX≤25) — régime ambigu"
            ))
    else:
        criteres.append(CritereScore(
            nom="ADX", valeur="N/D",
            points=0, interpretation="Données insuffisantes (< 28 séances)"
        ))

    # ── Critère 9 : Volume — Confirmation du signal ───────────────────────────
    # Poids fixe = 1 (confirmation, indépendant de l'horizon)
    # Volume en titres échangés (Sika Finance → "Volume Titres" → colonne "volume")
    # Garde stricte : volume_moy20 == 0 uniquement (pas de seuil dur — small caps BRVM
    # peuvent avoir 10–200 titres/jour, un seuil fixe tuerait leur scoring)
    # ADX (critère 8) joue déjà le rôle de filtre de régime structurel
    if ind.volume_moy20 is not None and ind.volume_moy20 > 0 and ind.volume_actuel is not None:
        vol_ratio = ind.volume_actuel / ind.volume_moy20
        if vol_ratio >= 2.0:
            criteres.append(CritereScore(
                nom="Volume",
                valeur=f"Vol {vol_ratio:.1f}× moy20j",
                points=+1,
                interpretation="Volume élevé (≥2×) — signal confirmé par l'activité"
            ))
        elif vol_ratio <= 0.5:
            criteres.append(CritereScore(
                nom="Volume",
                valeur=f"Vol {vol_ratio:.1f}× moy20j",
                points=-1,
                interpretation="Volume faible (≤0.5×) — signal non confirmé, activité absente"
            ))
        else:
            criteres.append(CritereScore(
                nom="Volume",
                valeur=f"Vol {vol_ratio:.1f}× moy20j",
                points=0,
                interpretation="Volume dans la norme (0.5×–2×)"
            ))
    else:
        criteres.append(CritereScore(
            nom="Volume", valeur="N/D",
            points=0, interpretation="Volume moyen indisponible ou nul"
        ))

    # ── Critère Liquidité — hors groupes (s_autres) ──────────────────────────
    # Pénalise les titres très peu liquides indépendamment du signal directionnel.
    # Seuil < 200 titres/jour : exécution difficile, signaux peu fiables sur BRVM.
    if ind.volume_moy20 is not None and 0 < ind.volume_moy20 < 200:
        criteres.append(CritereScore(
            nom="Liquidité",
            valeur=f"Vol moy20={ind.volume_moy20:.0f} titres/j",
            points=-1,
            interpretation="Liquidité très faible — signaux peu fiables, exécution difficile",
        ))

    # ── Critère Turnover FCFA — filtre d'exploitabilité réelle ──────────────
    # Volume en titres ne distingue pas 100 titres à 500 FCFA vs 100 titres à 50 000 FCFA.
    # Seuil 500k FCFA/jour = minimum raisonnable pour exécuter une position meaningful.
    if getattr(ind, "turnover_moy20_fcfa", 0) > 0:
        if ind.turnover_moy20_fcfa < 500_000:
            criteres.append(CritereScore(
                nom="Turnover",
                valeur=f"{ind.turnover_moy20_fcfa:,.0f} FCFA/j",
                points=-1,
                interpretation=f"Turnover insuffisant (<500k FCFA/j) — position difficile à constituer",
            ))

    # ── Critère Thin Trading Bias ─────────────────────────────────────────────
    # >30% de jours sans transaction sur 20j = prix collants, indicateurs biaisés.
    if getattr(ind, "zero_volume_days_pct", 0) > 30:
        criteres.append(CritereScore(
            nom="Thin Trading",
            valeur=f"{ind.zero_volume_days_pct:.0f}% jours sans transaction",
            points=-1,
            interpretation="Prix non-synchrone : indicateurs calculés sur des cours fictifs (reconduits)",
        ))

    # ── Critère OHLC synthétique — ATR biaisé ────────────────────────────────
    if getattr(ind, "synthetic_ohlc", False):
        criteres.append(CritereScore(
            nom="OHLC Qualité",
            valeur="OHLC reconstruit depuis close",
            points=-1,
            interpretation="ATR, ADX et Stochastic sous-estimés — stops/sizing peu fiables",
        ))

    # ── Calcul score total — Hierarchical Bounded Factor Model (A5-Simple) ────
    # Trois blocs corrélés : chaque critère normalisé à ±1 intra-groupe (vote unique),
    # puis cap ±2 par groupe → mesure un consensus de signaux, pas une addition de magnitudes
    # Régime/filtre (ADX, Volume, PerfRel) : libres, information structurellement indépendante
    _G_MOMENTUM = {"MACD", "Divergence MACD", "MACD Momentum"}
    _G_TREND    = {"MA Config", "MA50 Slope", "Tendance LT"}
    _G_TIMING   = {"RSI", "Divergence RSI", "Stochastic"}
    _G_GROUPED  = _G_MOMENTUM | _G_TREND | _G_TIMING
    _CAP        = 2

    def _group_score(group):
        """Somme des votes normalisés ±1 par critère dans un groupe."""
        return sum(
            max(-1, min(1, c.points))
            for c in criteres if c.nom in group
        )

    s_momentum = _group_score(_G_MOMENTUM)
    s_trend    = _group_score(_G_TREND)
    s_timing   = _group_score(_G_TIMING)
    s_autres   = sum(c.points for c in criteres if c.nom not in _G_GROUPED)

    score = (
        max(-_CAP, min(_CAP, s_momentum))
        + max(-_CAP, min(_CAP, s_trend))
        + max(-_CAP, min(_CAP, s_timing))
        + s_autres
    )

    # Dampening données lacunaires (E1) : données sparse → signal moins fiable
    if getattr(ind, "data_quality_flag", "ok") == "sparse":
        score = round(score * 0.8)

    # Multiplicateur de confiance basé sur la liquidité (D2)
    # Volume moyen 20j < 100 titres/jour → signal quasi-inexploitable sur BRVM
    _vol = ind.volume_moy20 if ind.volume_moy20 is not None else 0.0
    if _vol >= 500:
        _mult_liq = 1.0
    elif _vol >= 200:
        _mult_liq = 0.75
    elif _vol >= 100:
        _mult_liq = 0.50
    else:
        _mult_liq = 0.25
    score = round(score * _mult_liq)
    result.multiplicateur_liquidite = _mult_liq

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

    # ── Niveau de confiance — Dispersion inter-groupes (C1) ───────────────────
    # Couche validation : indépendante de score_total (sinon biais ADX/Volume/PerfRel)
    # Direction = majorité de votes directionnels des groupes, pas signe du score global
    # Couverture : critères de _G_GROUPED avec N/D comptent quand même (absence de signal
    # ≠ absence de données ; critères silencieux = logique validée sans signal détecté)
    criteres_valides = [c for c in criteres if c.valeur != "N/D" or c.nom in _G_GROUPED]
    taux_couverture = len(criteres_valides) / len(criteres) if criteres else 0

    votes = [
        1 if s_momentum > 0 else (-1 if s_momentum < 0 else 0),
        1 if s_trend > 0 else (-1 if s_trend < 0 else 0),
        1 if s_timing > 0 else (-1 if s_timing < 0 else 0),
    ]
    direction = 1 if votes.count(1) > votes.count(-1) else (
        -1 if votes.count(-1) > votes.count(1) else 0
    )
    nb_groupes_alignes = votes.count(direction) if direction != 0 else 0
    nb_groupes_actifs  = sum(1 for s in [s_momentum, s_trend, s_timing] if s != 0)
    data_quality       = getattr(ind, "data_quality_flag", "ok")

    if taux_couverture < 0.5 or nb_groupes_actifs < 2 or data_quality == "sparse":
        result.confiance = "faible"   # Données insuffisantes, mono-bloc, ou très lacunaires
    elif nb_groupes_alignes == 3 and data_quality == "ok":
        result.confiance = "forte"    # forte requiert données sans trou
    elif nb_groupes_alignes >= 2:
        result.confiance = "modérée"  # gaps acceptables → cap à modérée
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
