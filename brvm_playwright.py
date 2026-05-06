"""
brvm_playwright.py - Bootstrap historique BRVM 5 ans via SikaFinance (fenetres 90j).

Principe : l'API SikaFinance accepte jusqu'a ~90 jours en daily depuis le navigateur.
On ouvre une page Playwright et on glisse une fenetre de 90j sur 5 ans.

A executer UNE SEULE FOIS en local pour peupler data/daily/*.csv.
Les mises a jour quotidiennes utilisent update_database.py (API, sans Playwright).

Prerequis :
    pip install playwright
    playwright install chromium

Usage :
    python brvm_playwright.py                   # tous les tickers, 5 ans
    python brvm_playwright.py SGBC ORAC SNTS    # tickers specifiques
    python brvm_playwright.py --years 3         # 3 ans d'historique
    python brvm_playwright.py --debug           # screenshots de debug
    python brvm_playwright.py --no-headless     # afficher le navigateur
    python brvm_playwright.py --discover        # tester la connexion
"""

import argparse
import asyncio
import logging
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from config import TICKER_TO_SIKA_ID
from utils import _parse_date

OUTPUT_DIR = Path("data/daily")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

_INDEX_TICKERS = {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}
ALL_STOCK_TICKERS = [t for t in TICKER_TO_SIKA_ID if t not in _INDEX_TICKERS]

WINDOW_DAYS  = 85   # fenetre de 85 jours (< 90j limite SikaFinance)
WAIT_API_MS  = 4000 # ms d'attente apres click OK
WAIT_NAV_MS  = 2500 # ms d'attente apres navigation


# ---------------------------------------------------------------------------
# Normalisation DataFrame brut SikaFinance -> OHLCV standard
# ---------------------------------------------------------------------------

def _rows_to_df(lst: list, ticker: str) -> Optional[pd.DataFrame]:
    """Convertit la liste de dict JSON SikaFinance en DataFrame OHLCV standard."""
    if not lst:
        return None
    rows = []
    for row in lst:
        try:
            rows.append({
                "date":   _parse_date(str(row["Date"])),
                "open":   float(row.get("Open",   row.get("Close", 0))),
                "high":   float(row.get("High",   row.get("Close", 0))),
                "low":    float(row.get("Low",    row.get("Close", 0))),
                "close":  float(row["Close"]),
                "volume": float(row.get("Volume", 0)),
            })
        except (KeyError, ValueError, TypeError):
            continue

    if not rows:
        return None

    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    df = df.dropna(subset=["date", "close"])
    df = df[df["close"] > 0]
    df = df.sort_values("date").drop_duplicates("date").set_index("date")

    # Anti thin-trading : close=0 -> forward-fill
    for col in ["open", "high", "low", "close"]:
        df[col] = df[col].replace(0, float("nan")).ffill()

    return df[["open", "high", "low", "close", "volume"]]


# ---------------------------------------------------------------------------
# Scraping d'un ticker - fenetres glissantes 90j via Playwright
# ---------------------------------------------------------------------------

async def scrape_ticker(
    page,
    ticker: str,
    years: int = 5,
    debug: bool = False,
) -> Optional[pd.DataFrame]:
    """
    Scrape l'historique complet d'un ticker via fenetres glissantes de 85 jours.
    La page Playwright est reutilisee (deja sur sikafinance.com).
    """
    sika_id = TICKER_TO_SIKA_ID.get(ticker, ticker.lower() + ".ci")
    url = f"https://www.sikafinance.com/marches/historiques/{sika_id}"

    logger.info(f"  {ticker} ({sika_id}): chargement page...")
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(WAIT_NAV_MS)
    except Exception as e:
        logger.warning(f"  {ticker}: navigation echouee - {e}")
        return None

    # Verifier que les elements de formulaire sont la
    try:
        await page.wait_for_selector("#datefrom", timeout=5000)
        await page.wait_for_selector("#dateto",   timeout=5000)
        await page.wait_for_selector("#btnChange", timeout=5000)
    except Exception:
        logger.warning(f"  {ticker}: formulaire non trouve sur la page")
        return None

    # Fenetres de dates : de (today - years*365) jusqu'a aujourd'hui, par blocs de WINDOW_DAYS
    all_frames: list[pd.DataFrame] = []
    cutoff = date.today() - timedelta(days=years * 365 + 30)
    win_start = cutoff

    while win_start < date.today():
        win_end = min(win_start + timedelta(days=WINDOW_DAYS), date.today())

        # Intercepter la reponse API pour cette fenetre
        api_data: list[dict] = []

        async def on_response(resp):
            if "GetHistos" in resp.url:
                try:
                    body = await resp.json()
                    lst  = body.get("lst", [])
                    if lst:
                        api_data.extend(lst)
                except Exception:
                    pass

        page.on("response", on_response)

        try:
            await page.fill("#datefrom", win_start.strftime("%Y-%m-%d"))
            await page.fill("#dateto",   win_end.strftime("%Y-%m-%d"))
            await page.click("#btnChange")
            await page.wait_for_timeout(WAIT_API_MS)
        except Exception as e:
            logger.debug(f"  {ticker}: erreur click - {e}")
            page.remove_listener("response", on_response)
            win_start = win_end + timedelta(days=1)
            continue

        page.remove_listener("response", on_response)

        if api_data:
            df_win = _rows_to_df(api_data, ticker)
            if df_win is not None and not df_win.empty:
                all_frames.append(df_win)
                oldest = df_win.index.min().date()
                newest = df_win.index.max().date()
                logger.info(f"    [{win_start}..{win_end}] {len(df_win)} barres ({oldest}..{newest})")
            else:
                logger.debug(f"    [{win_start}..{win_end}] donnees non parsees")
        else:
            logger.debug(f"    [{win_start}..{win_end}] aucune reponse API")

        win_start = win_end + timedelta(days=1)
        await asyncio.sleep(0.8)

    if not all_frames:
        logger.warning(f"  {ticker}: aucune donnee recoltee")
        return None

    combined = pd.concat(all_frames)
    combined = combined[~combined.index.duplicated(keep="first")].sort_index()
    logger.info(f"  {ticker}: {len(combined)} barres ({combined.index.min().date()} -> {combined.index.max().date()})")
    return combined


# ---------------------------------------------------------------------------
# Mode discover
# ---------------------------------------------------------------------------

async def run_discover(headless: bool = True) -> None:
    from playwright.async_api import async_playwright

    ticker = "SGBC"
    sika_id = TICKER_TO_SIKA_ID.get(ticker, "SGBC.ci")
    url = f"https://www.sikafinance.com/marches/historiques/{sika_id}"

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)
        page    = await browser.new_page()

        api_data = []
        async def on_response(resp):
            if "GetHistos" in resp.url:
                try:
                    body = await resp.json()
                    api_data.extend(body.get("lst", []))
                except Exception:
                    pass

        page.on("response", on_response)
        print(f"[Discover] Navigation vers {url}...")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(3000)

        # Verifier le formulaire
        inputs = await page.evaluate("""() =>
            Array.from(document.querySelectorAll('input, select')).map(el => ({
                tag: el.tagName, name: el.name || el.id, type: el.type, value: el.value
            }))
        """)
        print("\nFormulaire :")
        for i in inputs:
            if i['name'] in ('datefrom', 'dateto', 'btnChange', 'dlPeriod'):
                print(f"  <{i['tag']}> name={i['name']!r} type={i['type']!r} value={i['value']!r}")

        # Test une fenetre 2021 Q1
        print("\nTest fenetre 2021-01-01 / 2021-03-31 ...")
        api_data.clear()
        await page.fill("#datefrom", "2021-01-01")
        await page.fill("#dateto",   "2021-03-31")
        await page.click("#btnChange")
        await page.wait_for_timeout(4000)

        if api_data:
            print(f"OK: {len(api_data)} barres recues")
            print(f"  Premiere: {api_data[0]['Date']}  Derniere: {api_data[-1]['Date']}")
            print("  SikaFinance est operationnel - pret pour le bootstrap")
        else:
            print("ECHEC: aucune donnee recue - verifier la connexion")

        await browser.close()


# ---------------------------------------------------------------------------
# Bootstrap principal
# ---------------------------------------------------------------------------

async def run_bootstrap(
    tickers: list,
    years:   int  = 5,
    debug:   bool = False,
    headless: bool = True,
) -> None:
    from playwright.async_api import async_playwright

    logger.info(f"=== Bootstrap BRVM | {len(tickers)} tickers | {years} ans | fenetres {WINDOW_DAYS}j ===")
    n_windows = (years * 365) // WINDOW_DAYS + 1
    logger.info(f"~{n_windows} appels API par ticker")

    ok, skip, fail = [], [], []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)
        page    = await browser.new_page()

        for i, ticker in enumerate(tickers, 1):
            csv_path = OUTPUT_DIR / f"{ticker}.csv"

            # Verifier si deja bootstrappe avec assez de donnees
            if csv_path.exists():
                try:
                    existing = pd.read_csv(csv_path, index_col="date", parse_dates=True)
                    if len(existing) >= years * 200:
                        logger.info(f"[{i}/{len(tickers)}] {ticker}: deja bootstrappe ({len(existing)} barres) - skip")
                        skip.append(ticker)
                        continue
                except Exception:
                    pass

            logger.info(f"[{i}/{len(tickers)}] {ticker}")
            df = await scrape_ticker(page, ticker, years=years, debug=debug)

            if df is None or df.empty:
                logger.warning(f"  {ticker}: ECHEC")
                fail.append(ticker)
                continue

            # Fusionner avec donnees existantes si partiel
            if csv_path.exists():
                try:
                    existing = pd.read_csv(csv_path, index_col="date", parse_dates=True)
                    existing.index = pd.to_datetime(existing.index)
                    df = pd.concat([existing, df])
                    df = df[~df.index.duplicated(keep="last")].sort_index()
                except Exception:
                    pass

            df.sort_index(inplace=True)
            df.to_csv(csv_path, date_format="%Y-%m-%d")
            logger.info(f"  Sauvegarde: {csv_path.name} ({len(df)} barres)")
            ok.append(ticker)

            await asyncio.sleep(1.5)

        await browser.close()

    logger.info("=== Termine ===")
    logger.info(f"  OK    : {len(ok)} tickers")
    logger.info(f"  Skip  : {len(skip)} tickers (deja a jour)")
    logger.info(f"  Echec : {len(fail)} tickers {fail if fail else ''}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Bootstrap historique BRVM via SikaFinance + Playwright")
    parser.add_argument("tickers",      nargs="*",         help="Tickers a scraper (defaut: tous)")
    parser.add_argument("--years",      type=int, default=5, help="Annees d'historique (defaut: 5)")
    parser.add_argument("--debug",      action="store_true", help="Screenshots de debug")
    parser.add_argument("--no-headless",action="store_true", help="Afficher le navigateur")
    parser.add_argument("--discover",   action="store_true", help="Tester la connexion (1 ticker)")
    args = parser.parse_args()

    headless = not args.no_headless

    if args.discover:
        asyncio.run(run_discover(headless=headless))
        return

    targets = [t.upper() for t in args.tickers] if args.tickers else ALL_STOCK_TICKERS
    unknown = [t for t in targets if t not in TICKER_TO_SIKA_ID]
    if unknown:
        logger.error(f"Tickers inconnus : {unknown}")
        sys.exit(1)

    asyncio.run(run_bootstrap(targets, years=args.years, debug=args.debug, headless=headless))


if __name__ == "__main__":
    main()
