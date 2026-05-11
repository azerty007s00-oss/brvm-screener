"""
update_database.py - Mise à jour quotidienne de data/daily/*.csv

Stratégie :
  1. Pour chaque ticker dans TICKER_TO_SIKA_ID, lire la dernière date du CSV local
  2. Fetcher les nouvelles séances depuis SikaFinance API (jours manquants uniquement)
  3. Appliquer l'anti-thin-trading (close=0 → close précédent)
  4. Appender les nouvelles lignes et sauvegarder

Ne nécessite PAS Playwright - SikaFinance couvre 260 jours en daily, suffisant pour
le rattrappage quotidien. Lancé par GitHub Actions à 15:15 UTC (après clôture BRVM).

Usage :
    python update_database.py [TICKER1 TICKER2 ...] [--force-full] [--dry-run]

Options :
    TICKERS      Sous-ensemble de tickers à mettre à jour (défaut : tous)
    --force-full Ré-télécharger les 260 derniers jours même si CSV à jour
    --dry-run    Afficher les mises à jour sans écrire sur disque
"""

import argparse
import logging
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from config import TICKER_TO_SIKA_ID
from scraper import _resolve_sika_id, _fetch_sika_api, _validate_ohlcv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent / "data" / "daily"
DATA_DIR.mkdir(parents=True, exist_ok=True)


# ─── Helpers CSV ─────────────────────────────────────────────────────────────

def _csv_path(ticker: str) -> Path:
    return DATA_DIR / f"{ticker}.csv"


def _load_csv(ticker: str) -> pd.DataFrame:
    """Charge le CSV local. Retourne DataFrame vide si absent."""
    p = _csv_path(ticker)
    if not p.exists():
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    df = pd.read_csv(p, index_col="date", parse_dates=True)
    df.index = pd.to_datetime(df.index)
    df = df.sort_index()
    return df


def _save_csv(ticker: str, df: pd.DataFrame, dry_run: bool = False) -> None:
    """Sauvegarde le DataFrame dans data/daily/{ticker}.csv."""
    if dry_run:
        logger.info(f"  [dry-run] {ticker}: {len(df)} lignes (non sauvegardé)")
        return
    p = _csv_path(ticker)
    df.sort_index(inplace=True)
    df.to_csv(p, date_format="%Y-%m-%d")
    logger.info(f"  Sauvegardé : {p.name} ({len(df)} lignes)")


# ─── Anti-thin-trading (close=0 → forward-fill) ──────────────────────────────

def _fix_thin_trading(df: pd.DataFrame) -> pd.DataFrame:
    """Remplace close=0 (pas de transaction) par le dernier close connu."""
    for col in ["open", "high", "low", "close"]:
        if col in df.columns:
            df[col] = df[col].replace(0, float("nan")).ffill()
    return df


# ─── Mise à jour d'un ticker ─────────────────────────────────────────────────

def update_ticker(ticker: str, force_full: bool = False, dry_run: bool = False) -> int:
    """
    Met à jour le CSV local pour un ticker.

    Returns:
        Nombre de nouvelles lignes ajoutées (0 si déjà à jour, -1 si erreur).
    """
    existing = _load_csv(ticker)

    if not existing.empty and not force_full:
        last_date = existing.index.max()
        days_since = (datetime.now() - last_date).days
        if days_since <= 1:
            logger.info(f"  {ticker}: déjà à jour (dernière séance : {last_date.date()})")
            return 0
        # Fetcher seulement ce qui manque, plus une marge de 5 jours
        fetch_days = min(days_since + 10, 260)
        logger.info(f"  {ticker}: dernière séance {last_date.date()}, fetch {fetch_days} jours")
    else:
        fetch_days = 260
        logger.info(f"  {ticker}: fetch complet ({fetch_days} jours)")

    sika_id = _resolve_sika_id(ticker)
    df_new = _fetch_sika_api(sika_id, days=fetch_days, period="daily")

    if df_new is None or df_new.empty:
        logger.warning(f"  {ticker}: aucune donnée reçue de SikaFinance")
        return -1

    df_new = _fix_thin_trading(df_new)

    if not existing.empty and not force_full:
        last_date = existing.index.max()
        df_new = df_new[df_new.index > last_date]

    if df_new.empty:
        logger.info(f"  {ticker}: aucune nouvelle séance")
        return 0

    new_rows = len(df_new)
    logger.info(f"  {ticker}: +{new_rows} nouvelle(s) séance(s)")

    if existing.empty:
        merged = df_new
    else:
        merged = pd.concat([existing, df_new])
        merged = merged[~merged.index.duplicated(keep="last")].sort_index()

    _validate_ohlcv(merged, ticker)
    _save_csv(ticker, merged, dry_run=dry_run)
    return new_rows


# ─── Point d'entrée ──────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Mise à jour quotidienne des CSV OHLCV")
    parser.add_argument("tickers", nargs="*", help="Tickers à mettre à jour (défaut : tous)")
    parser.add_argument("--force-full", action="store_true", help="Ré-télécharger 260 jours")
    parser.add_argument("--dry-run", action="store_true", help="Simuler sans écrire")
    args = parser.parse_args()

    all_tickers = list(TICKER_TO_SIKA_ID.keys())
    targets = [t.upper() for t in args.tickers] if args.tickers else all_tickers

    unknown = [t for t in targets if t not in all_tickers]
    if unknown:
        logger.error(f"Tickers inconnus : {unknown}")
        sys.exit(1)

    logger.info(f"=== update_database.py | {datetime.now().strftime('%Y-%m-%d %H:%M')} ===")
    logger.info(f"Tickers : {len(targets)} | force-full={args.force_full} | dry-run={args.dry_run}")

    total_added = 0
    errors = []

    for i, ticker in enumerate(targets, 1):
        logger.info(f"[{i}/{len(targets)}] {ticker}")
        try:
            n = update_ticker(ticker, force_full=args.force_full, dry_run=args.dry_run)
            if n > 0:
                total_added += n
        except Exception as e:
            logger.error(f"  {ticker}: erreur inattendue: {e}")
            errors.append(ticker)
        time.sleep(1.5)

    logger.info(f"=== Terminé : {total_added} nouvelles séances | {len(errors)} erreurs ===")
    if errors:
        logger.warning(f"Tickers en erreur : {errors}")
    if total_added == 0 and not errors:
        logger.info("Tous les tickers sont déjà à jour.")
    # Ne jamais faire échouer le job CI pour des problèmes d'API externe.
    # Les IPs GitHub Actions peuvent être rate-limitées par SikaFinance — c'est transitoire.


if __name__ == "__main__":
    main()
