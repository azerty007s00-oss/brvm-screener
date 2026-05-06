"""
diagnostics.py - Diagnostic de liquidité BRVM sur l'univers des 46 titres.

Calcule pour chaque ticker sur DIAGNOSTIC_WINDOW_DAYS (défaut 365j) :
  - nb_seances         : nombre de séances dans la période
  - pct_volume_pos     : % séances avec volume > 0
  - volume_median      : médiane du volume (séances non-zéro)
  - pct_ohlc_flat      : % séances où high = low = close (fixing unique)
  - sauts_30pct        : nombre de sauts > DIAGNOSTIC_JUMP_THRESHOLD_PCT en 1 séance

Classifie en 3 tiers selon pct_volume_pos :
  LIQUIDE       ≥ LIQUIDITY_THRESHOLDS["LIQUIDE"]      (80 %)
  SEMI_LIQUIDE  ≥ LIQUIDITY_THRESHOLDS["SEMI_LIQUIDE"] (40 %)
  ILLIQUIDE     < 40 %

Usage autonome :
    python diagnostics.py

Génère report.md dans le répertoire courant.
"""

import logging
import sys
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Optional

import numpy as np
import pandas as pd

from config import (
    DIAGNOSTIC_JUMP_THRESHOLD_PCT,
    DIAGNOSTIC_WINDOW_DAYS,
    LIQUIDITY_THRESHOLDS,
    TICKER_TO_SIKA_ID,
)

logger = logging.getLogger(__name__)

# Indices exclus du diagnostic de liquidité titre par titre
_INDEX_TICKERS: frozenset[str] = frozenset(
    {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}
)


# ─── Dataclass résultat ───────────────────────────────────────────────────────

@dataclass
class LiquidityMetrics:
    """Métriques de liquidité pour un ticker sur la période d'analyse."""

    ticker: str

    nb_seances: int = 0
    pct_volume_pos: float = 0.0     # % séances avec volume > 0
    volume_median: float = 0.0      # médiane volume (séances non-zéro)
    pct_ohlc_flat: float = 0.0      # % séances avec high=low=close
    sauts_30pct: int = 0            # nb sauts > threshold

    tier: str = "INCONNU"           # LIQUIDE | SEMI_LIQUIDE | ILLIQUIDE | INCONNU

    date_start: str = ""
    date_end: str = ""

    error: Optional[str] = None     # Renseigné si fetch ou calcul échoué


# ─── Fonctions pures ──────────────────────────────────────────────────────────

def classify_tier(pct_volume_pos: float) -> str:
    """
    Retourne le tier de liquidité selon le % de séances avec volume > 0.

    Seuils issus de LIQUIDITY_THRESHOLDS dans config.py :
      ≥ 80 % → LIQUIDE
      ≥ 40 % → SEMI_LIQUIDE
      < 40 % → ILLIQUIDE
    """
    if pct_volume_pos >= LIQUIDITY_THRESHOLDS["LIQUIDE"]:
        return "LIQUIDE"
    if pct_volume_pos >= LIQUIDITY_THRESHOLDS["SEMI_LIQUIDE"]:
        return "SEMI_LIQUIDE"
    return "ILLIQUIDE"


def compute_liquidity_metrics(df: pd.DataFrame, ticker: str) -> LiquidityMetrics:
    """
    Calcule les métriques de liquidité à partir d'un DataFrame OHLCV.

    Args:
        df:     DataFrame avec colonnes open/high/low/close/volume et index DatetimeIndex.
                Les noms de colonnes sont normalisés en minuscules.
        ticker: Symbole du titre (pour traçabilité).

    Returns:
        LiquidityMetrics rempli. Si df est vide ou colonnes manquantes,
        retourne un objet avec error renseigné et tier="INCONNU".
    """
    result = LiquidityMetrics(ticker=ticker)

    if df is None or len(df) == 0:
        result.error = "DataFrame vide ou None"
        return result

    df = df.copy()
    df.columns = [c.lower() for c in df.columns]

    required = {"open", "high", "low", "close", "volume"}
    missing = required - set(df.columns)
    if missing:
        result.error = f"Colonnes manquantes : {sorted(missing)}"
        return result

    df = df.sort_index()
    n = len(df)

    result.nb_seances = n
    result.date_start = str(df.index[0].date()) if n > 0 else ""
    result.date_end   = str(df.index[-1].date()) if n > 0 else ""

    # % séances avec volume > 0
    vol_pos = int((df["volume"] > 0).sum())
    result.pct_volume_pos = round(100.0 * vol_pos / n, 2)

    # Médiane du volume (séances non-zéro uniquement)
    nonzero = df.loc[df["volume"] > 0, "volume"]
    result.volume_median = float(nonzero.median()) if len(nonzero) > 0 else 0.0

    # % séances OHLC plats - prix unique de fixing (high = low = close)
    flat_mask = (df["high"] == df["low"]) & (df["low"] == df["close"])
    result.pct_ohlc_flat = round(100.0 * int(flat_mask.sum()) / n, 2)

    # Sauts > threshold sur 1 séance (probables actions sur capital non ajustées)
    pct_chg = df["close"].pct_change().abs() * 100
    result.sauts_30pct = int((pct_chg > DIAGNOSTIC_JUMP_THRESHOLD_PCT).sum())

    result.tier = classify_tier(result.pct_volume_pos)
    return result


# ─── Orchestrateur réseau ─────────────────────────────────────────────────────

def run_full_diagnostic(
    fetch_fn: Callable[[str, int], Optional[pd.DataFrame]],
    tickers: Optional[list[str]] = None,
    days: Optional[int] = None,
) -> dict[str, LiquidityMetrics]:
    """
    Lance le diagnostic sur tous les tickers (ou la liste fournie).

    Args:
        fetch_fn: Callable(ticker: str, days: int) → DataFrame OHLCV ou None.
                  Compatible avec scraper.get_ohlcv(ticker, days).
        tickers:  Liste de tickers à analyser.
                  Si None, utilise TICKER_TO_SIKA_ID sans les indices.
        days:     Fenêtre d'analyse (défaut : DIAGNOSTIC_WINDOW_DAYS).

    Returns:
        Dict {ticker: LiquidityMetrics}.
    """
    if days is None:
        days = DIAGNOSTIC_WINDOW_DAYS

    if tickers is None:
        tickers = [t for t in TICKER_TO_SIKA_ID if t not in _INDEX_TICKERS]

    results: dict[str, LiquidityMetrics] = {}

    for ticker in tickers:
        logger.info("[Diagnostic] %s - fetch %d jours...", ticker, days)
        try:
            df = fetch_fn(ticker, days)
            if df is None or len(df) == 0:
                metrics = LiquidityMetrics(ticker=ticker, error="Données non disponibles")
            else:
                metrics = compute_liquidity_metrics(df, ticker)
        except Exception as exc:
            logger.error("[Diagnostic] Erreur pour %s : %s", ticker, exc)
            metrics = LiquidityMetrics(ticker=ticker, error=str(exc))

        results[ticker] = metrics
        logger.info(
            "[Diagnostic] %s → tier=%s pct_vol_pos=%.1f%%",
            ticker, metrics.tier, metrics.pct_volume_pos,
        )

    return results


# ─── Génération du rapport Markdown ───────────────────────────────────────────

def generate_report(
    results: dict[str, LiquidityMetrics],
    output_path: str = "report.md",
) -> str:
    """
    Génère un rapport Markdown des métriques de liquidité et le sauvegarde.

    Args:
        results:     Dict {ticker: LiquidityMetrics} issu de run_full_diagnostic().
        output_path: Chemin du fichier de sortie (défaut : report.md).

    Returns:
        Contenu du rapport sous forme de chaîne.
    """
    threshold_liq  = LIQUIDITY_THRESHOLDS["LIQUIDE"]
    threshold_semi = LIQUIDITY_THRESHOLDS["SEMI_LIQUIDE"]

    tier_counts: dict[str, int] = {"LIQUIDE": 0, "SEMI_LIQUIDE": 0, "ILLIQUIDE": 0, "INCONNU": 0}
    for m in results.values():
        tier_counts[m.tier] = tier_counts.get(m.tier, 0) + 1

    sorted_metrics = sorted(
        results.values(),
        key=lambda m: m.pct_volume_pos,
        reverse=True,
    )

    lines: list[str] = [
        "# Rapport Diagnostic Liquidité BRVM",
        "",
        f"Généré le : {datetime.now().strftime('%Y-%m-%d %H:%M')}  ",
        f"Fenêtre d'analyse : {DIAGNOSTIC_WINDOW_DAYS} jours  ",
        f"Seuil saut anormal : {DIAGNOSTIC_JUMP_THRESHOLD_PCT:.0f} %",
        "",
        "---",
        "",
        "## Résumé des tiers",
        "",
        "| Tier | Critère | Nb titres |",
        "|------|---------|-----------|",
        f"| LIQUIDE | ≥ {threshold_liq:.0f} % séances vol > 0 | {tier_counts['LIQUIDE']} |",
        f"| SEMI_LIQUIDE | {threshold_semi:.0f} - {threshold_liq:.0f} % | {tier_counts['SEMI_LIQUIDE']} |",
        f"| ILLIQUIDE | < {threshold_semi:.0f} % | {tier_counts['ILLIQUIDE']} |",
        f"| INCONNU (erreur) | - | {tier_counts['INCONNU']} |",
        "",
        "---",
        "",
        "## Détail par ticker",
        "",
        "| Ticker | Tier | Séances | Vol > 0 (%) | Vol médian | OHLC flat (%) | Sauts > 30 % | Période |",
        "|--------|------|---------|-------------|------------|---------------|--------------|---------|",
    ]

    for m in sorted_metrics:
        err_note = f" ⚠️ {m.error}" if m.error else ""
        periode = f"{m.date_start} → {m.date_end}" if m.date_start else "-"
        lines.append(
            f"| {m.ticker} | **{m.tier}** | {m.nb_seances} "
            f"| {m.pct_volume_pos:.1f} % | {m.volume_median:,.0f} "
            f"| {m.pct_ohlc_flat:.1f} % | {m.sauts_30pct}{err_note} | {periode} |"
        )

    lines += [
        "",
        "---",
        "",
        "## Mapping LIQUIDITY_TIERS (à copier dans config.py)",
        "",
        "> Collez ce bloc dans config.py pour remplacer le dict vide `LIQUIDITY_TIERS = {}`.",
        "",
        "```python",
        "LIQUIDITY_TIERS: dict[str, str] = {",
    ]

    for m in sorted_metrics:
        comment = f"  # {m.pct_volume_pos:.1f}% vol>0"
        lines.append(f'    "{m.ticker}": "{m.tier}",{comment}')

    lines += [
        "}",
        "```",
        "",
    ]

    content = "\n".join(lines)

    try:
        with open(output_path, "w", encoding="utf-8") as fh:
            fh.write(content)
        logger.info("[Diagnostic] Rapport sauvegardé : %s", output_path)
    except OSError as exc:
        logger.error("[Diagnostic] Impossible d'écrire %s : %s", output_path, exc)

    return content


# ─── Point d'entrée autonome ──────────────────────────────────────────────────

def _main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    try:
        from scraper import get_ohlcv  # import réseau uniquement si __main__
    except ImportError:
        logger.error("scraper.py introuvable - impossible de lancer le diagnostic réseau.")
        sys.exit(1)

    logger.info("=== Diagnostic BRVM Phase 1 ===")
    results = run_full_diagnostic(fetch_fn=get_ohlcv)
    report  = generate_report(results, output_path="report.md")

    # Afficher un résumé console
    tiers: dict[str, list[str]] = {"LIQUIDE": [], "SEMI_LIQUIDE": [], "ILLIQUIDE": [], "INCONNU": []}
    for m in results.values():
        tiers[m.tier].append(m.ticker)

    print("\n=== RÉSUMÉ ===")
    for tier_name, tickers in tiers.items():
        print(f"  {tier_name} ({len(tickers)}) : {', '.join(sorted(tickers)) or '-'}")

    print(f"\nRapport complet → report.md")


if __name__ == "__main__":
    _main()
