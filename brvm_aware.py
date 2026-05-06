"""
brvm_aware.py - Helpers BRVM-aware pour indicateurs et scoring.

Module indépendant - n'altère pas indicators.py ni scoring.py.
Fournit des fonctions de garde et de détection adaptées aux contraintes
du marché BRVM : fixing journalier unique, illiquidité structurelle,
OHLC synthétique sur small caps, calendrier UEMOA.

Intégration dans scoring.py (hooks additifs) :
    apply_brvm_critere_adjustments(ind, criteres) - neutralise ADX/Stochastic si ILLIQUIDE
    apply_confiance_override(result, ind)          - force confiance=faible si ILLIQUIDE

Fonctions pures testables sans réseau :
    should_compute_indicator(ticker, name)   → bool
    adjust_volume_signal(ticker, ratio, median_vol) → float
    detect_session_gap(series)              → dict
    detect_unadjusted_event(series)         → list[dict]
"""

import logging
from typing import Optional

import pandas as pd

from config import LIQUIDITY_TIERS

logger = logging.getLogger(__name__)


# ─── Constantes ───────────────────────────────────────────────────────────────

# Indicateurs dont le calcul est biaisé sur OHLC plats (high=low=close)
# ADX   : exploite le True Range → ATR ≈ 0 quand high=low
# Stochastic : %K = (close-low)/(high-low) → division par 0 ou bruit pur
_INDICATORS_UNRELIABLE_ON_ILLIQUID: frozenset[str] = frozenset({"ADX", "Stochastic"})

# Volume médian (séances non-zéro) sous lequel le ratio vol/moy20 est non significatif.
# En dessous de 50 titres/jour, 1 transaction peut multiplier le ratio par 10+.
VOLUME_SIGNAL_MIN_MEDIAN: int = 50  # titres/jour

# Seuil de saut considéré potentiellement non ajusté (split/dividende Sika Finance)
UNADJUSTED_EVENT_THRESHOLD_PCT: float = 20.0  # %

# Fenêtre de retour pour qualifier un saut comme "événement non ajusté"
UNADJUSTED_EVENT_REVERSAL_WINDOW: int = 5  # séances

# Trou de cotation en jours calendaires = probable suspension ou données manquantes
# BRVM : 5 séances/semaine → 3 séances ouvrées ≈ 4-5 jours calendaires
SESSION_GAP_CALENDAR_DAYS: int = 4


# ─── Helpers de base ──────────────────────────────────────────────────────────

def get_liquidity_tier(ticker: str) -> str:
    """
    Retourne le tier de liquidité d'un ticker depuis config.LIQUIDITY_TIERS.
    Retourne 'INCONNU' si le ticker n'est pas dans le mapping.
    """
    return LIQUIDITY_TIERS.get(ticker, "INCONNU")


def should_compute_indicator(ticker: str, indicator_name: str) -> bool:
    """
    Indique si un indicateur est fiable pour un ticker donné.

    Désactive ADX et Stochastic pour les titres ILLIQUIDE :
    ces deux indicateurs utilisent high-low (ATR/range), qui tend vers 0
    quand high=low=close sur la majorité des séances de fixing BRVM.
    Calculer ADX ou Stochastic sur ces données produit du bruit pur.

    Args:
        ticker:         Symbole du titre (ex. "BOAM").
        indicator_name: Nom de l'indicateur (ex. "ADX", "Stochastic").

    Returns:
        True si l'indicateur peut être utilisé, False s'il doit être ignoré.
    """
    tier = get_liquidity_tier(ticker)
    if tier == "ILLIQUIDE" and indicator_name in _INDICATORS_UNRELIABLE_ON_ILLIQUID:
        logger.debug(
            "[BRVM-aware] %s désactivé pour %s (tier=%s - OHLC plats)",
            indicator_name, ticker, tier,
        )
        return False
    return True


def adjust_volume_signal(
    ticker: str,
    ratio: float,
    volume_median: float,
) -> float:
    """
    Neutralise le ratio volume si le volume médian est trop faible.

    Sur BRVM, un volume médian < VOLUME_SIGNAL_MIN_MEDIAN titres/jour
    rend le ratio vol_actuel/moy20 instable : une seule transaction peut
    créer un ratio de ×10 ou ×20, qui serait interprété comme un signal
    fort alors qu'il ne reflète qu'un artefact statistique.

    Args:
        ticker:        Symbole du titre (pour le log).
        ratio:         Ratio vol_actuel / vol_moy20 calculé par indicators.py.
        volume_median: Médiane du volume sur séances non-zéro (20j).

    Returns:
        1.0 (neutre) si volume_median < seuil, sinon ratio inchangé.
    """
    if volume_median < VOLUME_SIGNAL_MIN_MEDIAN:
        logger.debug(
            "[BRVM-aware] Signal volume neutralisé pour %s (médian=%.0f < %d titres/j)",
            ticker, volume_median, VOLUME_SIGNAL_MIN_MEDIAN,
        )
        return 1.0
    return ratio


def detect_session_gap(series: pd.Series) -> dict:
    """
    Détecte un trou de cotation récent ≥ SESSION_GAP_CALENDAR_DAYS jours.

    Un trou > 3 séances ouvrées (≈ 4 jours calendaires) sur BRVM indique :
    - suspension temporaire du titre (décision DC/BRVM)
    - absence de cotation en période de publication
    - données manquantes chez Sika Finance

    La recherche porte sur les 30 dernières barres pour ne signaler que
    des trous récents (pas des trous anciens dans l'historique long).

    Args:
        series: pd.Series avec index DatetimeIndex. Peut être une série close.

    Returns:
        dict avec :
          stale (bool)    : True si trou ≥ seuil détecté
          gap_days (int)  : durée calendaire du plus grand trou récent
          gap_start (str) : date début du trou (YYYY-MM-DD)
          gap_end (str)   : date fin du trou (YYYY-MM-DD)
          message (str)   : description lisible
    """
    result = {
        "stale": False,
        "gap_days": 0,
        "gap_start": "",
        "gap_end": "",
        "message": "",
    }

    if series is None or len(series) < 2:
        return result

    series = series.dropna().sort_index()
    if len(series) < 2:
        return result

    # Fenêtre récente (30 dernières barres)
    recent = series.iloc[-30:] if len(series) >= 30 else series
    dates = pd.Series(recent.index)
    diffs = dates.diff().dt.days.dropna()

    if len(diffs) == 0:
        return result

    # idxmax() retourne un label (pas une position) ; utiliser .max() pour la valeur
    max_gap_pos   = int(diffs.idxmax())   # label dans dates - utilisé pour retrouver les dates
    max_gap_days  = int(diffs.max())      # valeur max (calendaires)

    if max_gap_days >= SESSION_GAP_CALENDAR_DAYS:
        dates_list = list(recent.index)
        gap_start = str(dates_list[max_gap_pos - 1].date()) if max_gap_pos >= 1 else ""
        gap_end   = str(dates_list[max_gap_pos].date()) if max_gap_pos < len(dates_list) else ""

        result["stale"]     = True
        result["gap_days"]  = max_gap_days
        result["gap_start"] = gap_start
        result["gap_end"]   = gap_end
        result["message"]   = (
            f"Trou de cotation de {max_gap_days}j calendaires "
            f"({gap_start} → {gap_end}) - données potentiellement stales"
        )
        logger.debug("[BRVM-aware] %s", result["message"])

    return result


def detect_unadjusted_event(
    series: pd.Series,
    window_reversal: int = UNADJUSTED_EVENT_REVERSAL_WINDOW,
) -> list[dict]:
    """
    Détecte les sauts ≥ 20 % non ajustés suivis d'un retour en N séances.

    Sika Finance n'ajuste pas systématiquement splits et dividendes.
    Signature caractéristique : saut brusque suivi d'un retour partiel
    dans les window_reversal séances → probable ajustement ou dividende
    détaché non reflété dans la série.

    Le seuil de "retour" est fixé à 10 % dans la direction opposée
    au saut (valeur conservative pour éviter les faux positifs sur
    les mouvements directionnels normaux de la BRVM).

    Args:
        series:           pd.Series de prix de clôture (index DatetimeIndex).
        window_reversal:  Nombre de séances pour mesurer le retour.

    Returns:
        Liste de dicts (un par événement) avec :
          date (str)            : date du saut
          jump_pct (float)      : amplitude du saut (%)
          reversal_pct (float)  : variation dans la fenêtre post-saut (%)
          reverted (bool)       : True si retour > 10 % dans la fenêtre
          message (str)         : description lisible
    """
    events: list[dict] = []

    if series is None or len(series) < window_reversal + 2:
        return events

    series = series.dropna().sort_index()
    if len(series) < window_reversal + 2:
        return events

    pct_changes = series.pct_change() * 100

    for i in range(1, len(series) - window_reversal):
        jump = float(pct_changes.iloc[i])
        if abs(jump) < UNADJUSTED_EVENT_THRESHOLD_PCT:
            continue

        price_at_jump  = float(series.iloc[i])
        window_prices  = series.iloc[i + 1 : i + 1 + window_reversal]

        if len(window_prices) == 0 or price_at_jump == 0:
            continue

        reversal_pct = float(
            (window_prices.iloc[-1] - price_at_jump) / price_at_jump * 100
        )
        # Retour qualifié : direction opposée au saut ET amplitude > 10 %
        reverted = (
            (jump > 0 and reversal_pct < -10.0)
            or (jump < 0 and reversal_pct > 10.0)
        )

        event_date = str(series.index[i].date())
        events.append({
            "date":         event_date,
            "jump_pct":     round(jump, 2),
            "reversal_pct": round(reversal_pct, 2),
            "reverted":     reverted,
            "message": (
                f"Saut de {jump:+.1f}% le {event_date}"
                + (
                    f" - retour de {reversal_pct:+.1f}% en {window_reversal}j "
                    "(dividende ou split non ajusté probable)"
                    if reverted
                    else ""
                )
            ),
        })

    return events


# ─── Hooks scoring - importés dans scoring.py ─────────────────────────────────

def apply_brvm_critere_adjustments(ind, criteres: list) -> list:
    """
    Post-traitement des critères de scoring pour les tickers illiquides.

    Appelé dans compute_score() juste avant le calcul du score de groupe,
    après que tous les critères ont été ajoutés à la liste.

    Actions :
    - ILLIQUIDE : neutralise ADX et Stochastic (points → 0, interprétation marquée)
    - Volume médian < VOLUME_SIGNAL_MIN_MEDIAN : neutralise le critère Volume

    Args:
        ind:      TechnicalIndicators - fournit ticker, liquidity_tier,
                  volume_median_nonzero.
        criteres: Liste de CritereScore déjà calculés dans compute_score().

    Returns:
        Liste de critères modifiée (les autres critères sont inchangés).
    """
    tier = getattr(ind, "liquidity_tier", get_liquidity_tier(ind.ticker))
    vol_median = getattr(ind, "volume_median_nonzero", 0.0)

    for c in criteres:
        # Neutralisation ADX et Stochastic sur titres illiquides
        if tier == "ILLIQUIDE" and c.nom in _INDICATORS_UNRELIABLE_ON_ILLIQUID:
            if c.points != 0:
                logger.debug(
                    "[BRVM-aware] Critère '%s' neutralisé pour %s (ILLIQUIDE - OHLC plats)",
                    c.nom, ind.ticker,
                )
            c.points = 0
            c.interpretation = (
                f"[ILLIQUIDE] neutralisé - OHLC plats biaisent {c.nom} "
                f"(high=low=close sur majorité des séances)"
            )

        # Neutralisation signal volume si médiane trop faible
        if c.nom == "Volume" and vol_median < VOLUME_SIGNAL_MIN_MEDIAN:
            if c.points != 0:
                logger.debug(
                    "[BRVM-aware] Signal volume neutralisé pour %s "
                    "(médian=%.0f < %d)",
                    ind.ticker, vol_median, VOLUME_SIGNAL_MIN_MEDIAN,
                )
            c.points = 0
            c.interpretation = (
                f"[Vol médian {vol_median:.0f} < {VOLUME_SIGNAL_MIN_MEDIAN} titres/j] "
                "Ratio non significatif - neutralisé"
            )

    return criteres


def apply_confiance_override(result, ind) -> object:
    """
    Force confiance='faible' pour les tickers classés ILLIQUIDE.

    Un titre illiquide produit des indicateurs biaisés (OHLC plats,
    ATR sous-estimé, ADX non fiable) - un signal ACHAT ou VENTE ne
    peut pas être qualifié de confiance modérée ou forte dans ce contexte.

    Appelé à la fin de compute_score(), après le calcul de confiance
    par dispersion inter-groupes.

    Args:
        result: ScoreResult (modifié en place).
        ind:    TechnicalIndicators (fournit liquidity_tier).

    Returns:
        ScoreResult modifié.
    """
    tier = getattr(ind, "liquidity_tier", get_liquidity_tier(ind.ticker))
    if tier == "ILLIQUIDE" and result.confiance != "faible":
        logger.debug(
            "[BRVM-aware] confiance forcée à 'faible' pour %s (tier=%s)",
            ind.ticker, tier,
        )
        result.confiance = "faible"
    return result
