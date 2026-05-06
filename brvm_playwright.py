"""
brvm_playwright.py - Bootstrap historique BRVM depuis brvm.org (jusqu'a 5 ans).

A executer UNE SEULE FOIS en local pour peupler data/daily/*.csv.
Les mises a jour quotidiennes utilisent update_database.py (SikaFinance, sans Playwright).

Prerequis :
    pip install playwright
    playwright install chromium

Usage :
    python brvm_playwright.py                   # tous les tickers, 5 ans
    python brvm_playwright.py SGBC ORAC SNTS    # tickers specifiques
    python brvm_playwright.py --years 3         # 3 ans d'historique
    python brvm_playwright.py --debug           # screenshots de debug
    python brvm_playwright.py --discover        # affiche la structure de la page
"""

import argparse
import asyncio
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

from config import TICKER_TO_SIKA_ID

OUTPUT_DIR  = Path("data/daily")
BRVM_URL    = "https://www.brvm.org/fr/historique"

# Tickers a exclure (indices composes)
_INDEX_TICKERS = {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}

# Tickers du marche actions uniquement
ALL_STOCK_TICKERS = [t for t in TICKER_TO_SIKA_ID if t not in _INDEX_TICKERS]


# ---------------------------------------------------------------------------
# Helpers Playwright
# ---------------------------------------------------------------------------

async def _screenshot(page, name: str, debug: bool) -> None:
    if debug:
        p = OUTPUT_DIR.parent / f"debug_{name}.png"
        await page.screenshot(path=str(p), full_page=True)
        print(f"    [debug] screenshot -> {p}")


async def _discover_form(page) -> dict:
    """Retourne la structure des elements de formulaire de la page."""
    return await page.evaluate("""() => {
        const info = {};

        // Selects
        const selects = Array.from(document.querySelectorAll('select'));
        info.selects = selects.map(s => ({
            name:    s.name || s.id || '?',
            options: Array.from(s.options).slice(0, 10).map(o => ({
                value: o.value,
                text:  o.text.trim()
            }))
        }));

        // Inputs
        const inputs = Array.from(document.querySelectorAll('input'));
        info.inputs = inputs.map(i => ({
            name:  i.name || i.id || '?',
            type:  i.type,
            value: i.value.slice(0, 30)
        }));

        // Boutons
        const btns = Array.from(document.querySelectorAll('button, input[type=submit]'));
        info.buttons = btns.map(b => ({
            tag:  b.tagName,
            text: (b.textContent || b.value || '').trim().slice(0, 40),
            type: b.type
        }));

        // Tables
        const tables = Array.from(document.querySelectorAll('table'));
        info.tables = tables.map(t => ({
            rows:    t.rows.length,
            headers: Array.from(t.querySelectorAll('th')).map(h => h.textContent.trim()).slice(0, 10)
        }));

        return info;
    }""")


async def _find_ticker_select(page, sample_tickers=None) -> Optional[str]:
    """
    Identifie le <select> contenant les tickers BRVM.
    Retourne le name/id du select, ou None si introuvable.
    """
    if sample_tickers is None:
        sample_tickers = {"SGBC", "ORAC", "BICC", "SNTS", "ETIT", "BOABF"}

    selects = await page.evaluate("""() =>
        Array.from(document.querySelectorAll('select')).map(s => ({
            name:    s.name || s.id || '',
            options: Array.from(s.options).map(o => ({value: o.value, text: o.text.trim()}))
        }))
    """)

    for sel in selects:
        texts  = {o["text"]  for o in sel["options"]}
        values = {o["value"] for o in sel["options"]}
        if sample_tickers & (texts | values):
            return sel["name"]

    return None


async def _parse_result_table(page) -> Optional[pd.DataFrame]:
    """Lit le premier tableau de donnees OHLCV trouve sur la page."""
    tables = await page.query_selector_all("table")
    for table in tables:
        try:
            html = await table.evaluate("el => el.outerHTML")
            dfs = pd.read_html(html)
            if dfs and len(dfs[0]) >= 3:
                df = dfs[0]
                # Exclure si c'est manifestement un tableau de navigation
                if len(df.columns) >= 3:
                    return df
        except Exception:
            continue
    return None


def _normalize_df(df_raw: pd.DataFrame, ticker: str) -> Optional[pd.DataFrame]:
    """
    Normalise un DataFrame brut scrape en format standard OHLCV.
    Colonnes cibles : date (index), open, high, low, close, volume.
    """
    cols_lower = {str(c).lower().strip(): c for c in df_raw.columns}

    mapping = {}

    # Date
    for alias in ["date", "séance", "seance", "jour", "day"]:
        if alias in cols_lower:
            mapping[cols_lower[alias]] = "date"
            break

    # Close (priorite car parfois seul disponible)
    for alias in ["clôture", "cloture", "close", "dernier", "cours", "last"]:
        if alias in cols_lower:
            mapping[cols_lower[alias]] = "close"
            break

    # Open
    for alias in ["ouverture", "open", "premier", "first"]:
        if alias in cols_lower:
            mapping[cols_lower[alias]] = "open"
            break

    # High
    for alias in ["plus haut", "+haut", "haut", "high", "maximum", "max"]:
        if alias in cols_lower:
            mapping[cols_lower[alias]] = "high"
            break

    # Low
    for alias in ["plus bas", "+bas", "bas", "low", "minimum", "min"]:
        if alias in cols_lower:
            mapping[cols_lower[alias]] = "low"
            break

    # Volume
    for alias in ["volume titres", "volume (titres)", "volume", "vol", "qté", "quantite"]:
        if alias in cols_lower:
            mapping[cols_lower[alias]] = "volume"
            break

    if "date" not in mapping.values() or "close" not in mapping.values():
        return None

    df = df_raw.rename(columns=mapping).copy()

    # Colonnes manquantes : infer depuis close
    for col in ["open", "high", "low"]:
        if col not in df.columns:
            df[col] = df["close"]
    if "volume" not in df.columns:
        df["volume"] = 0

    # Nettoyage numerique
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = (
            df[col].astype(str)
            .str.replace(r"\s+", "", regex=True)
            .str.replace(",", ".", regex=False)
            .str.replace(r"[^\d.\-]", "", regex=True)
            .replace("", "0")
        )
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # Dates
    from utils import _parse_date
    df["date"] = df["date"].apply(lambda x: _parse_date(str(x)))
    df = df.dropna(subset=["date", "close"])
    df = df[df["close"] > 0]
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").drop_duplicates("date").set_index("date")
    return df[["open", "high", "low", "close", "volume"]]


# ---------------------------------------------------------------------------
# Scraping d'un ticker
# ---------------------------------------------------------------------------

async def scrape_ticker(
    browser,
    ticker: str,
    years: int = 5,
    debug: bool = False,
) -> Optional[pd.DataFrame]:
    """
    Scrape l'historique d'un ticker depuis brvm.org.
    Retourne un DataFrame OHLCV ou None en cas d'echec.
    """
    page = await browser.new_page()
    try:
        date_end   = date.today()
        date_start = date_end - timedelta(days=years * 365 + 60)

        print(f"  {ticker}: navigation...")
        await page.goto(BRVM_URL, wait_until="networkidle", timeout=45000)
        await page.wait_for_timeout(3000)
        await _screenshot(page, f"{ticker}_01_load", debug)

        # -- Trouver le select de ticker --
        sel_name = await _find_ticker_select(page)
        if sel_name is None:
            print(f"  {ticker}: select de ticker non trouve - voir debug screenshot")
            await _screenshot(page, f"{ticker}_FAIL_noselect", True)
            return None

        # Selectionner le ticker (valeur ou texte)
        try:
            await page.select_option(f"select[name='{sel_name}']", value=ticker)
        except Exception:
            try:
                await page.select_option(f"select[name='{sel_name}']", label=ticker)
            except Exception as e:
                print(f"  {ticker}: impossible de selectionner dans le select - {e}")
                return None

        await page.wait_for_timeout(1500)
        await _screenshot(page, f"{ticker}_02_selected", debug)

        # -- Remplir les dates --
        # Format FR : JJ/MM/AAAA ou ISO : AAAA-MM-JJ selon le type du champ
        date_start_iso = date_start.strftime("%Y-%m-%d")
        date_start_fr  = date_start.strftime("%d/%m/%Y")
        date_end_iso   = date_end.strftime("%Y-%m-%d")
        date_end_fr    = date_end.strftime("%d/%m/%Y")

        date_fields = await page.evaluate("""() =>
            Array.from(document.querySelectorAll('input[type=date], input[type=text]'))
            .filter(i => /date|from|to|debut|fin|start|end/i.test(i.name + i.id + i.placeholder))
            .map(i => ({name: i.name || i.id, type: i.type, placeholder: i.placeholder}))
        """)

        for j, field in enumerate(date_fields[:2]):
            fname = field["name"]
            ftype = field["type"]
            val_iso = date_start_iso if j == 0 else date_end_iso
            val_fr  = date_start_fr  if j == 0 else date_end_fr
            selector = f"input[name='{fname}']" if fname else f"input[type='{ftype}']"
            try:
                await page.fill(selector, val_iso if ftype == "date" else val_fr)
            except Exception:
                pass

        await _screenshot(page, f"{ticker}_03_dates", debug)

        # -- Soumettre le formulaire --
        submit_clicked = False
        for btn_sel in [
            "button[type=submit]",
            "input[type=submit]",
            "button:has-text('Voir')",
            "button:has-text('Recherch')",
            "button:has-text('Valider')",
            "button:has-text('OK')",
            "button",
        ]:
            try:
                btn = page.locator(btn_sel).first
                if await btn.is_visible():
                    await btn.click()
                    submit_clicked = True
                    break
            except Exception:
                continue

        if not submit_clicked:
            # Essayer Enter sur le dernier champ de date
            try:
                await page.keyboard.press("Enter")
            except Exception:
                pass

        await page.wait_for_timeout(4000)
        await _screenshot(page, f"{ticker}_04_result", debug)

        # -- Lire le tableau de resultats --
        df_raw = await _parse_result_table(page)
        if df_raw is None:
            print(f"  {ticker}: aucun tableau trouve apres soumission")
            return None

        df = _normalize_df(df_raw, ticker)
        if df is None or df.empty:
            print(f"  {ticker}: impossible de normaliser le tableau "
                  f"(colonnes: {list(df_raw.columns)})")
            return None

        # Filtrer par date_start si necessaire
        df = df[df.index >= pd.Timestamp(date_start)]
        print(f"  {ticker}: OK - {len(df)} jours ({df.index.min().date()} -> {df.index.max().date()})")
        return df

    except Exception as exc:
        print(f"  {ticker}: ERREUR - {exc}")
        await _screenshot(page, f"{ticker}_EXCEPTION", debug)
        return None
    finally:
        await page.close()


# ---------------------------------------------------------------------------
# Bootstrap complet
# ---------------------------------------------------------------------------

async def run_bootstrap(
    tickers: list,
    years: int = 5,
    debug: bool = False,
    headless: bool = True,
) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    from playwright.async_api import async_playwright

    print(f"\n[Bootstrap] {len(tickers)} tickers | {years} ans | output: {OUTPUT_DIR}/")
    print(f"[Bootstrap] headless={headless} | debug={debug}")
    print("=" * 60)

    ok = err = skip = 0

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)

        for ticker in tickers:
            csv_path = OUTPUT_DIR / f"{ticker}.csv"

            # Ne pas recraser si deja complet (>= 4 ans de donnees)
            if csv_path.exists():
                try:
                    existing = pd.read_csv(csv_path, index_col="date", parse_dates=True)
                    if len(existing) >= years * 200:
                        print(f"  {ticker}: deja present ({len(existing)} jours) - skip")
                        skip += 1
                        continue
                except Exception:
                    pass

            df = await scrape_ticker(browser, ticker, years=years, debug=debug)

            if df is not None and not df.empty:
                # Fusionner avec donnees existantes si present
                if csv_path.exists():
                    try:
                        existing = pd.read_csv(csv_path, index_col="date", parse_dates=True)
                        df = pd.concat([existing, df])
                        df = df[~df.index.duplicated(keep="last")].sort_index()
                    except Exception:
                        pass

                df.to_csv(csv_path)
                ok += 1
            else:
                err += 1

            # Pause pour ne pas surcharger le serveur
            await asyncio.sleep(2)

        await browser.close()

    print("\n" + "=" * 60)
    print(f"[Bootstrap] Termine : {ok} OK | {err} erreurs | {skip} skips")
    print(f"[Bootstrap] Donnees dans : {OUTPUT_DIR.resolve()}")

    if err > 0:
        print("\nPour diagnostiquer les erreurs :")
        print("  python brvm_playwright.py TICKER --debug --no-headless")


# ---------------------------------------------------------------------------
# Mode decouverte (--discover)
# ---------------------------------------------------------------------------

async def run_discover(headless: bool = True) -> None:
    """Affiche la structure de la page BRVM.org/fr/historique."""
    from playwright.async_api import async_playwright

    print(f"[Discover] Navigation vers {BRVM_URL}...")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless)
        page    = await browser.new_page()
        await page.goto(BRVM_URL, wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(3000)
        await page.screenshot(path="debug_discover.png", full_page=True)

        info = await _discover_form(page)

        print(f"\nSelects ({len(info['selects'])}) :")
        for sel in info["selects"]:
            print(f"  name={sel['name']} | {len(sel['options'])} options")
            for opt in sel["options"][:6]:
                print(f"    value={opt['value']!r}  text={opt['text']!r}")

        print(f"\nInputs ({len(info['inputs'])}) :")
        for inp in info["inputs"]:
            print(f"  name={inp['name']} type={inp['type']} value={inp['value']!r}")

        print(f"\nBoutons ({len(info['buttons'])}) :")
        for btn in info["buttons"]:
            print(f"  {btn['tag']} type={btn['type']} text={btn['text']!r}")

        print(f"\nTableaux ({len(info['tables'])}) :")
        for t in info["tables"]:
            print(f"  {t['rows']} lignes | headers: {t['headers']}")

        print("\nScreenshot sauvegarde : debug_discover.png")
        await browser.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Bootstrap historique BRVM depuis brvm.org"
    )
    parser.add_argument(
        "tickers", nargs="*",
        help="Tickers specifiques (defaut: tous les 46 tickers BRVM)"
    )
    parser.add_argument("--years",       type=int, default=5,
                        help="Annees d'historique (defaut: 5)")
    parser.add_argument("--debug",       action="store_true",
                        help="Sauvegarder screenshots de debug")
    parser.add_argument("--no-headless", action="store_true",
                        help="Afficher le navigateur (utile pour debug)")
    parser.add_argument("--discover",    action="store_true",
                        help="Afficher la structure de la page sans scraper")
    args = parser.parse_args()

    headless = not args.no_headless

    if args.discover:
        asyncio.run(run_discover(headless=headless))
    else:
        tickers = [t.upper() for t in args.tickers] if args.tickers else ALL_STOCK_TICKERS
        asyncio.run(run_bootstrap(
            tickers=tickers,
            years=args.years,
            debug=args.debug,
            headless=headless,
        ))
