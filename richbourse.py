"""
richbourse.py — Scraper RichBourse.com comme source OHLCV de fallback pour la BRVM.

Utilisé par scraper.py quand SikaFinance est indisponible ou renvoie des données
insuffisantes.
"""

import logging
import time
import re
from typing import Optional
from datetime import datetime

import requests
import pandas as pd
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import (
    HTTP_HEADERS,
    REQUEST_DELAY_SECONDS,
    REQUEST_TIMEOUT,
    REQUEST_MAX_RETRIES,
    REQUEST_BACKOFF_FACTOR,
    RICHBOURSE_BASE_URL,
)

logger = logging.getLogger(__name__)


# ─── Session HTTP ─────────────────────────────────────────────────────────────

def _build_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=REQUEST_MAX_RETRIES,
        backoff_factor=REQUEST_BACKOFF_FACTOR,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(HTTP_HEADERS)
    return session


_session = _build_session()


# ─── Résolution de l'URL RichBourse ──────────────────────────────────────────

def _candidate_urls(ticker: str) -> list[str]:
    """
    Génère les URLs candidates à tester sur RichBourse.com.
    RichBourse utilise le ticker sans suffixe pays, en minuscules.
    """
    base = ticker.split(".")[0].upper()
    low = base.lower()
    return [
        f"{RICHBOURSE_BASE_URL}/cours-bourse/brvm/{low}",
        f"{RICHBOURSE_BASE_URL}/cours-bourse/brvm/{low}/historique",
        f"{RICHBOURSE_BASE_URL}/bourse/brvm/cours/{low}",
        f"{RICHBOURSE_BASE_URL}/BRVM/historique/{base}",
        f"{RICHBOURSE_BASE_URL}/cours/{base}",
        f"{RICHBOURSE_BASE_URL}/cours/{low}",
    ]


# ─── Point d'entrée ───────────────────────────────────────────────────────────

def fetch_ohlcv(ticker: str, days: int) -> Optional[pd.DataFrame]:
    """
    Tente de récupérer les données OHLCV depuis RichBourse.com.

    Args:
        ticker: Ticker BRVM (ex: "BICC" ou "BICC.ci")
        days:   Nombre de jours d'historique souhaité

    Returns:
        DataFrame OHLCV ou None si échec
    """
    for url in _candidate_urls(ticker):
        try:
            logger.info(f"[RichBourse] Tentative : {url}")
            time.sleep(REQUEST_DELAY_SECONDS)
            resp = _session.get(url, timeout=REQUEST_TIMEOUT)

            if resp.status_code == 404:
                continue
            if resp.status_code != 200:
                continue

            df = _parse_page(resp.text, days)
            if df is not None and len(df) >= 5:
                logger.info(f"[RichBourse] {len(df)} jours récupérés pour {ticker}")
                return df

        except requests.RequestException as e:
            logger.debug(f"[RichBourse] Erreur réseau {url}: {e}")
        except Exception as e:
            logger.debug(f"[RichBourse] Erreur parsing {url}: {e}")

    return None


# ─── Parsing HTML ─────────────────────────────────────────────────────────────

def _parse_page(html: str, days: int) -> Optional[pd.DataFrame]:
    """Extrait les données OHLCV depuis le HTML d'une page RichBourse."""
    soup = BeautifulSoup(html, "html.parser")

    # Chercher tous les tableaux et tenter le parsing sur chacun
    for table in soup.find_all("table"):
        df = _try_parse_table(table)
        if df is not None and len(df) >= 5:
            return df.tail(days) if len(df) > days else df

    return None


def _try_parse_table(table) -> Optional[pd.DataFrame]:
    """Tente de parser un tableau HTML comme données OHLCV."""
    try:
        headers = [th.get_text(strip=True).lower() for th in table.find_all("th")]
        if not headers:
            return None

        headers_text = " ".join(headers)
        if "date" not in headers_text:
            return None
        if not any(kw in headers_text for kw in ["cours", "clôture", "cloture", "close", "dernier", "prix", "last"]):
            return None

        rows = []
        for tr in table.find_all("tr")[1:]:
            cells = [td.get_text(strip=True) for td in tr.find_all("td")]
            if len(cells) >= 2:
                rows.append(cells)

        if not rows:
            return None

        n_cols = len(rows[0])
        cols = (
            headers[:n_cols]
            if len(headers) >= n_cols
            else headers + [f"col_{i}" for i in range(len(headers), n_cols)]
        )
        df = pd.DataFrame(rows, columns=cols[:n_cols])
        return _normalize(df)

    except Exception as e:
        logger.debug(f"[RichBourse] Erreur parse table: {e}")
        return None


# ─── Normalisation ────────────────────────────────────────────────────────────

def _normalize(df: pd.DataFrame) -> Optional[pd.DataFrame]:
    """Normalise un DataFrame brut en format OHLCV standard."""
    cols_lower = {c.lower().strip(): c for c in df.columns}
    col_map = {}

    # Date
    for alias in ["date", "jour", "séance", "date de séance", "date séance"]:
        if alias in cols_lower:
            col_map[cols_lower[alias]] = "date"
            break

    # Open
    for alias in ["ouverture", "open", "premier", "cours d'ouverture", "1er cours"]:
        if alias in cols_lower:
            col_map[cols_lower[alias]] = "open"
            break

    # High
    for alias in ["plus haut", "haut", "high", "maximum", "+haut", "cours haut"]:
        if alias in cols_lower:
            col_map[cols_lower[alias]] = "high"
            break

    # Low
    for alias in ["plus bas", "bas", "low", "minimum", "+bas", "cours bas"]:
        if alias in cols_lower:
            col_map[cols_lower[alias]] = "low"
            break

    # Close
    for alias in ["clôture", "cloture", "cours", "close", "dernier", "prix", "last", "cours de clôture"]:
        if alias in cols_lower:
            col_map[cols_lower[alias]] = "close"
            break

    # Volume
    for alias in ["volume", "vol", "volume titres", "volume (titres)", "qté", "quantité"]:
        if alias in cols_lower:
            col_map[cols_lower[alias]] = "volume"
            break

    if "date" not in col_map.values() or "close" not in col_map.values():
        return None

    df = df.rename(columns=col_map)

    # Colonnes manquantes → inférer depuis close
    for col in ["open", "high", "low"]:
        if col not in df.columns:
            df[col] = df["close"]
    if "volume" not in df.columns:
        df["volume"] = 0

    # Nettoyage numérique
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = (
            df[col].astype(str)
            .str.replace(r"\s+", "", regex=True)
            .str.replace(",", ".", regex=False)
            .str.replace(r"[^\d.\-]", "", regex=True)
            .replace("", "0")
        )
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # Parse dates
    df["date"] = df["date"].apply(_parse_date)
    df = df.dropna(subset=["date", "close"])
    df = df[df["close"] > 0]
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    df.set_index("date", inplace=True)

    return df[["open", "high", "low", "close", "volume"]]


def _parse_date(date_str: str) -> Optional[str]:
    """Tente de parser une date depuis différents formats."""
    formats = [
        "%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y",
        "%d %b %Y", "%d %B %Y", "%d.%m.%Y", "%Y%m%d",
    ]
    s = str(date_str).strip()
    for fmt in formats:
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    try:
        return pd.to_datetime(s, dayfirst=True).strftime("%Y-%m-%d")
    except Exception:
        return None
