"""
build_fundamentals_history.py
==============================
Scrape SikaFinance pour construire une base de données historique des fondamentaux BRVM.

Source : https://www.sikafinance.com/marches/societe/[TICKER].[pays]
Données : BNPA, PER, Dividende, Résultat net, Chiffre d'affaires (2021-2025)

Usage :
    python build_fundamentals_history.py                  # Tous les tickers
    python build_fundamentals_history.py --ticker SNTS    # Un seul ticker
    python build_fundamentals_history.py --dry-run        # Test sans sauvegarder
    python build_fundamentals_history.py --force          # Re-scraper même si données existantes
    python build_fundamentals_history.py --verbose        # Log détaillé
"""

import sys
import json
import time
import re
import argparse
import logging
from pathlib import Path
from datetime import date
from typing import Optional

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Chemins
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
SOURCE_FILE = DATA_DIR / "fundamentals_brvm.json"
OUTPUT_FILE = DATA_DIR / "fundamentals_history.json"

# ---------------------------------------------------------------------------
# Mapping pays → suffixe SikaFinance
# ---------------------------------------------------------------------------
PAYS_TO_SUFFIX = {
    "Côte d'Ivoire":  "ci",
    "Sénégal":        "sn",
    "Burkina Faso":   "bf",
    "Togo":           "tg",
    "Bénin":          "bj",
    "Mali":           "ml",
    "Niger":          "ne",
    "Guinée-Bissau":  "gw",
    "Guinée-Conakry": "gn",
}

# ---------------------------------------------------------------------------
# Libellés de lignes attendus dans le tableau SikaFinance
# Les clés sont les libellés normalisés, les valeurs les noms dans notre JSON
# ---------------------------------------------------------------------------
ROW_MAP = {
    # Libellés exacts ou partiels (insensible à la casse + strip)
    "bnpa":                       "bnpa",
    "bpa":                        "bnpa",
    "bénéfice par action":        "bnpa",
    "per":                        "per",
    "p/e":                        "per",
    "cours/bénéfice":             "per",
    "dividende":                  "dividende",
    "résultat net":               "resultat_net_millions",
    "resultat net":               "resultat_net_millions",
    "chiffre d'affaires":         "ca_millions",
    "chiffre d affaires":         "ca_millions",
    "ca":                         "ca_millions",
    "revenus":                    "ca_millions",
}

YEARS_TO_SCRAPE = ["2021", "2022", "2023", "2024", "2025"]

# ---------------------------------------------------------------------------
# Logger
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("fundamentals_history")


# ---------------------------------------------------------------------------
# Utilitaires
# ---------------------------------------------------------------------------

def parse_french_number(raw: str) -> Optional[float]:
    """
    Convertit un nombre au format français en float.
    Exemples :
        "1 400,00"  → 1400.0
        "28 312"    → 28312.0
        "-"         → None
        "n/a"       → None
        "11,45"     → 11.45
        "0"         → 0.0
    """
    if raw is None:
        return None
    s = raw.strip().replace("\xa0", " ").replace(" ", " ")
    if not s or s in ("-", "–", "N/A", "n/a", "nd", "n.d.", "—"):
        return None
    # Supprimer espaces (séparateurs de milliers)
    s = s.replace(" ", "")
    # Remplacer virgule décimale par point
    s = s.replace(",", ".")
    # Supprimer unités éventuelles (ex: " M FCFA")
    s = re.sub(r"[^\d.\-+]", "", s)
    if not s or s in (".", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def normalize_row_label(raw: str) -> str:
    """Normalise un libellé de ligne pour matching."""
    return raw.strip().lower().replace("'", " ").replace("'", " ").replace("\xa0", " ")


def get_sika_url(ticker: str, pays: str) -> Optional[str]:
    """Construit l'URL SikaFinance pour un ticker."""
    suffix = PAYS_TO_SUFFIX.get(pays)
    if not suffix:
        log.warning(f"Pays inconnu : '{pays}' pour {ticker}")
        return None
    return f"https://www.sikafinance.com/marches/societe/{ticker}.{suffix}"


# ---------------------------------------------------------------------------
# Scraper
# ---------------------------------------------------------------------------

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def fetch_page(url: str, retries: int = 3, delay: float = 2.0) -> Optional[str]:
    """Télécharge une page HTML avec retry."""
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            if resp.status_code == 200:
                resp.encoding = resp.apparent_encoding or "utf-8"
                return resp.text
            elif resp.status_code == 404:
                log.warning(f"404 : {url}")
                return None
            else:
                log.warning(f"HTTP {resp.status_code} : {url} (essai {attempt+1}/{retries})")
        except requests.RequestException as e:
            log.warning(f"Erreur réseau : {e} (essai {attempt+1}/{retries})")
        if attempt < retries - 1:
            time.sleep(delay * (attempt + 1))
    return None


def parse_sika_table(html: str, ticker: str) -> dict:
    """
    Extrait les données du tableau fondamentaux SikaFinance.
    Retourne un dict : { "2021": {"bnpa": ..., "per": ..., ...}, ... }
    """
    soup = BeautifulSoup(html, "html.parser")

    # Chercher le tableau fondamentaux (plusieurs sélecteurs par robustesse)
    table = (
        soup.find("table", class_=lambda c: c and "tabSociete" in c)
        or soup.find("table", id="tabSociete")
        or soup.find("table", class_="tablenosort")
    )

    if not table:
        log.warning(f"{ticker} : tableau fondamentaux non trouvé")
        return {}

    # Extraire l'en-tête pour identifier les colonnes d'années
    header_row = table.find("tr")
    if not header_row:
        log.warning(f"{ticker} : aucune ligne d'en-tête")
        return {}

    header_cells = [th.get_text(strip=True) for th in header_row.find_all(["th", "td"])]
    log.debug(f"{ticker} en-têtes : {header_cells}")

    # Map colonne_index → année
    year_cols: dict[int, str] = {}
    for i, cell in enumerate(header_cells):
        clean = cell.strip()
        if re.match(r"^\d{4}$", clean) and clean in YEARS_TO_SCRAPE:
            year_cols[i] = clean

    if not year_cols:
        log.warning(f"{ticker} : aucune colonne d'année trouvée dans {header_cells}")
        return {}

    log.debug(f"{ticker} colonnes années : {year_cols}")

    # Initialiser le résultat
    result: dict[str, dict] = {y: {} for y in year_cols.values()}

    # Parcourir les lignes de données
    rows = table.find_all("tr")[1:]  # Sauter l'en-tête
    for row in rows:
        cells = row.find_all(["th", "td"])
        if not cells:
            continue

        # Libellé en première colonne
        raw_label = cells[0].get_text(strip=True)
        label_norm = normalize_row_label(raw_label)

        # Trouver la clé JSON correspondante
        field_key = None
        for pattern, key in ROW_MAP.items():
            if pattern in label_norm:
                field_key = key
                break

        if field_key is None:
            log.debug(f"{ticker} : ligne ignorée '{raw_label}'")
            continue

        # Extraire les valeurs par colonne d'année
        for col_idx, year in year_cols.items():
            if col_idx < len(cells):
                raw_val = cells[col_idx].get_text(strip=True)
                parsed = parse_french_number(raw_val)
                if parsed is not None:
                    # Ne pas écraser une valeur déjà parsée (première occurrence prioritaire)
                    if field_key not in result[year]:
                        result[year][field_key] = parsed
                        log.debug(f"{ticker} {year} {field_key} = {parsed} ('{raw_val}')")

    return result


def scrape_ticker(ticker: str, info: dict, verbose: bool = False) -> dict:
    """
    Scrape les données historiques d'un ticker sur SikaFinance.
    Retourne l'entrée complète pour le JSON de sortie.
    """
    pays = info.get("pays", "")
    url = get_sika_url(ticker, pays)

    entry = {
        "nom":               info.get("nom", ticker),
        "pays":              pays,
        "secteur":           info.get("secteur", ""),
        "nb_actions_millions": info.get("nb_actions_millions"),
        "confiance":         info.get("confiance", "estimee"),
        "history":           {},
    }

    if not url:
        log.error(f"{ticker} : URL impossible à construire (pays='{pays}')")
        return entry

    if verbose:
        log.info(f"{ticker:8s} → {url}")
    else:
        log.info(f"Scraping {ticker:8s} ({pays})")

    html = fetch_page(url)
    if not html:
        log.error(f"{ticker} : impossible de télécharger la page")
        return entry

    history = parse_sika_table(html, ticker)

    # Nettoyer les années sans données
    entry["history"] = {
        year: data
        for year, data in history.items()
        if data  # ignorer les années sans aucune donnée
    }

    if entry["history"]:
        years_ok = sorted(entry["history"].keys())
        fields_ok = set()
        for yd in entry["history"].values():
            fields_ok.update(yd.keys())
        log.info(f"  OK : {years_ok} | champs : {sorted(fields_ok)}")
    else:
        log.warning(f"  {ticker} : aucune donnée historique extraite")

    return entry


# ---------------------------------------------------------------------------
# Chargement / sauvegarde
# ---------------------------------------------------------------------------

def load_source() -> dict:
    """Charge fundamentals_brvm.json."""
    if not SOURCE_FILE.exists():
        log.error(f"Fichier source introuvable : {SOURCE_FILE}")
        sys.exit(1)
    with open(SOURCE_FILE, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def load_output() -> dict:
    """Charge fundamentals_history.json existant (ou retourne un squelette vide)."""
    if OUTPUT_FILE.exists():
        with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "version":      "1.0",
        "last_updated": str(date.today()),
        "description":  "Historique fondamentaux BRVM - scraped from SikaFinance",
        "stocks":       {},
    }


def save_output(data: dict, dry_run: bool = False) -> None:
    """Sauvegarde fundamentals_history.json."""
    data["last_updated"] = str(date.today())
    if dry_run:
        print("\n[DRY-RUN] JSON résultat (extrait 3 premiers tickers) :")
        preview = {
            "version": data["version"],
            "last_updated": data["last_updated"],
            "stocks": dict(list(data["stocks"].items())[:3]),
        }
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        return

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log.info(f"Sauvegardé : {OUTPUT_FILE}")


# ---------------------------------------------------------------------------
# Stats / rapport
# ---------------------------------------------------------------------------

def print_summary(output: dict) -> None:
    """Affiche un résumé de la base construite."""
    stocks = output.get("stocks", {})
    total = len(stocks)
    with_data = sum(1 for s in stocks.values() if s.get("history"))
    years_coverage = {}
    fields_coverage = {}

    for s in stocks.values():
        for year, fields in s.get("history", {}).items():
            years_coverage[year] = years_coverage.get(year, 0) + 1
            for f in fields:
                fields_coverage[f] = fields_coverage.get(f, 0) + 1

    print("\n" + "=" * 55)
    print("  RESUME BASE FONDAMENTAUX HISTORIQUE")
    print("=" * 55)
    print(f"  Tickers total    : {total}")
    print(f"  Avec donnees     : {with_data} / {total}")
    print()
    print("  Couverture par annee :")
    for year in sorted(years_coverage):
        n = years_coverage[year]
        bar = "#" * (n * 20 // max(total, 1))
        print(f"    {year} : {n:3d}/{total} {bar}")
    print()
    print("  Champs disponibles :")
    for field in sorted(fields_coverage):
        print(f"    {field:30s} : {fields_coverage[field]:3d} tickers")
    print("=" * 55)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Scraper historique fondamentaux BRVM depuis SikaFinance"
    )
    parser.add_argument("--ticker", metavar="TICKER",
                        help="Scraper un seul ticker (ex: SNTS)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Afficher le résultat sans sauvegarder")
    parser.add_argument("--force", action="store_true",
                        help="Re-scraper même si des données existent déjà")
    parser.add_argument("--verbose", action="store_true",
                        help="Log détaillé (incluant les lignes parsées)")
    parser.add_argument("--delay", type=float, default=1.5,
                        help="Délai entre requêtes en secondes (défaut: 1.5)")
    args = parser.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    # Chargement des données source
    source = load_source()
    source_stocks = source.get("stocks", {})
    output = load_output()

    # Sélection des tickers à traiter
    if args.ticker:
        tickers_to_process = [args.ticker.upper()]
        if tickers_to_process[0] not in source_stocks:
            log.error(f"Ticker '{args.ticker}' introuvable dans {SOURCE_FILE.name}")
            sys.exit(1)
    else:
        tickers_to_process = sorted(source_stocks.keys())

    log.info(f"Tickers a traiter : {len(tickers_to_process)}")
    log.info(f"Délai entre requêtes : {args.delay}s")

    # Scraping
    processed = 0
    skipped = 0
    failed = 0

    for i, ticker in enumerate(tickers_to_process):
        info = source_stocks.get(ticker, {})

        # Ignorer si données déjà présentes et pas --force
        if (
            not args.force
            and ticker in output["stocks"]
            and output["stocks"][ticker].get("history")
        ):
            log.info(f"Skip {ticker} (données existantes, utiliser --force pour re-scraper)")
            skipped += 1
            # Mettre quand même à jour les métadonnées statiques
            for k in ("nom", "pays", "secteur", "nb_actions_millions", "confiance"):
                if k in info:
                    output["stocks"][ticker][k] = info[k]
            continue

        entry = scrape_ticker(ticker, info, verbose=args.verbose)
        output["stocks"][ticker] = entry

        if entry.get("history"):
            processed += 1
        else:
            failed += 1

        # Sauvegarde intermédiaire toutes les 5 tickers (au cas où interruption)
        if not args.dry_run and (i + 1) % 5 == 0:
            save_output(output, dry_run=False)
            log.info(f"  [checkpoint] {i+1}/{len(tickers_to_process)} tickers traités")

        # Délai poli entre requêtes
        if i < len(tickers_to_process) - 1:
            time.sleep(args.delay)

    # Sauvegarde finale
    log.info(f"\nTraités: {processed} OK | {skipped} skipped | {failed} echecs")
    save_output(output, dry_run=args.dry_run)
    print_summary(output)


if __name__ == "__main__":
    main()
