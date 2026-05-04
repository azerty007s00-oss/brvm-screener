"""
scraper.py — Collecte de données OHLCV depuis Sika Finance pour la BRVM.

Stratégie :
1. Résoudre le ticker en identifiant Sika Finance (ex: BICC → BICC.ci)
2. Scraper le tableau HTML de la page /marches/historiques/{sika_id}
3. Fallback : tenter les différents suffixes pays si le mapping est inconnu
"""

import time
import logging
import re
from typing import Optional
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import pandas as pd
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import (
    SIKA_BASE_URL,
    SIKA_HISTORY_URL,
    SIKA_CHART_URL,
    SIKA_AAZ_URL,
    HTTP_HEADERS,
    REQUEST_DELAY_SECONDS,
    REQUEST_TIMEOUT,
    REQUEST_MAX_RETRIES,
    REQUEST_BACKOFF_FACTOR,
    MIN_DATA_POINTS,
    TICKER_TO_SIKA_ID,
    COUNTRY_SUFFIXES,
    NEWS_CACHE_TTL_SECONDS,
)
from cache import cache
from utils import _parse_date
import richbourse
import rss_feeds

logger = logging.getLogger(__name__)


# ─── Session HTTP robuste ─────────────────────────────────────────────────────

def _build_session() -> requests.Session:
    """Construit une session requests avec retry automatique et headers."""
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


# ─── Exceptions métier ────────────────────────────────────────────────────────

class TickerNotFoundError(Exception):
    """Le ticker n'existe pas sur la source interrogée."""


class InsufficientDataError(Exception):
    """Pas assez de données historiques pour calculer les indicateurs."""


class SourceStructureChangedError(Exception):
    """La structure HTML/JSON de la source a changé — mise à jour du scraper requise."""


# ─── Résolution du ticker → ID Sika Finance ──────────────────────────────────

def _resolve_sika_id(ticker: str) -> str:
    """
    Résout un ticker BRVM en identifiant Sika Finance (avec suffixe pays).

    Exemples :
        BICC  → BICC.ci
        ONTBF → ONTBF.bf
        BRVMC → BRVMC (indices sans suffixe)
    """
    ticker = ticker.upper().strip()

    # 1. Mapping connu
    if ticker in TICKER_TO_SIKA_ID:
        return TICKER_TO_SIKA_ID[ticker]

    # 2. Si le ticker contient déjà un suffixe (ex: BICC.ci passé directement)
    if "." in ticker:
        return ticker

    # 3. Tenter les différents suffixes pays
    for suffix in COUNTRY_SUFFIXES:
        sika_id = f"{ticker}{suffix}"
        url = f"{SIKA_HISTORY_URL}/{sika_id}"
        try:
            time.sleep(1)
            resp = _session.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
            if resp.status_code == 200 and "historiques" in resp.url.lower():
                # Vérifier qu'il y a bien un tableau de données
                if "<table" in resp.text.lower():
                    logger.info(f"Ticker {ticker} résolu en {sika_id}")
                    return sika_id
        except requests.RequestException:
            continue

    # 4. Dernier recours : le ticker tel quel
    return ticker


# ─── Scraping HTML page historiques ──────────────────────────────────────────

def _fetch_sika_historiques(sika_id: str, days: int) -> Optional[pd.DataFrame]:
    """
    Scrape le tableau historique depuis /marches/historiques/{sika_id}.
    Gère la pagination pour récupérer jusqu'à `days` séances.
    """
    base_url = f"{SIKA_HISTORY_URL}/{sika_id}"
    all_frames = []
    seen_dates = set()

    for page in range(1, 20):  # max 20 pages (~1200 jours)
        url = base_url if page == 1 else f"{base_url}?page={page}"
        logger.info(f"[SikaFinance] Scraping page {page} : {url}")

        try:
            time.sleep(REQUEST_DELAY_SECONDS)
            resp = _session.get(url, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 404:
                break
            resp.raise_for_status()
        except requests.RequestException as e:
            logger.warning(f"Erreur HTTP page {page} pour {sika_id}: {e}")
            break

        soup = BeautifulSoup(resp.text, "html.parser")
        tables = soup.find_all("table")

        page_df = None
        for table in tables:
            df = _parse_historiques_table(table)
            if df is not None and len(df) >= 2:
                page_df = df
                break

        if page_df is None or page_df.empty:
            break

        # Vérifier si les dates sont nouvelles (évite boucle infinie sur sites sans pagination réelle)
        page_dates = set(page_df.index.strftime("%Y-%m-%d"))
        if page_dates.issubset(seen_dates):
            break

        seen_dates |= page_dates
        all_frames.append(page_df)

        total = sum(len(f) for f in all_frames)
        if total >= days:
            break

    if not all_frames:
        return None

    combined = pd.concat(all_frames)
    combined = combined[~combined.index.duplicated(keep="first")].sort_index()
    logger.info(f"[SikaFinance] {len(combined)} jours récupérés pour {sika_id} ({len(all_frames)} page(s))")
    return combined.tail(days) if len(combined) > days else combined


def _parse_historiques_table(table) -> Optional[pd.DataFrame]:
    """
    Parse le tableau HTML de la page historiques Sika Finance.

    Colonnes attendues : Date, Clôture, Plus bas, Plus haut, Ouverture,
                         Volume Titres, Volume FCFA, Variation %
    """
    try:
        # Extraire les en-têtes
        headers_raw = [th.get_text(strip=True).lower() for th in table.find_all("th")]
        if not headers_raw:
            return None

        # Vérifier que c'est un tableau de cours (doit contenir "date" et "clôture" ou "cloture")
        headers_text = " ".join(headers_raw)
        if "date" not in headers_text:
            return None
        if not any(kw in headers_text for kw in ["clôture", "cloture", "dernier", "cours", "close"]):
            return None

        # Extraire les lignes
        rows = []
        for tr in table.find_all("tr")[1:]:  # Skip header
            cells = [td.get_text(strip=True) for td in tr.find_all("td")]
            if len(cells) >= 2:
                rows.append(cells)

        if not rows:
            return None

        # Créer DataFrame avec les en-têtes
        n_cols = len(rows[0])
        headers = headers_raw[:n_cols] if len(headers_raw) >= n_cols else headers_raw + [f"col_{i}" for i in range(len(headers_raw), n_cols)]
        df = pd.DataFrame(rows, columns=headers[:n_cols])

        return _normalize_sika_dataframe(df)

    except Exception as e:
        logger.debug(f"Erreur parsing table: {e}")
        return None


def _normalize_sika_dataframe(df: pd.DataFrame) -> Optional[pd.DataFrame]:
    """
    Normalise le DataFrame brut Sika Finance en format OHLCV standard.
    """
    # Mapping des noms de colonnes Sika Finance → noms standards
    col_mapping = {}
    cols_lower = {c.lower().strip(): c for c in df.columns}

    # Date
    for alias in ["date", "jour", "séance"]:
        if alias in cols_lower:
            col_mapping[cols_lower[alias]] = "date"
            break

    # Open
    for alias in ["ouverture", "open", "premier"]:
        if alias in cols_lower:
            col_mapping[cols_lower[alias]] = "open"
            break

    # High
    for alias in ["plus haut", "+haut", "haut", "high", "maximum"]:
        if alias in cols_lower:
            col_mapping[cols_lower[alias]] = "high"
            break

    # Low
    for alias in ["plus bas", "+bas", "bas", "low", "minimum"]:
        if alias in cols_lower:
            col_mapping[cols_lower[alias]] = "low"
            break

    # Close
    for alias in ["clôture", "cloture", "close", "dernier", "cours"]:
        if alias in cols_lower:
            col_mapping[cols_lower[alias]] = "close"
            break

    # Volume
    for alias in ["volume titres", "volume (titres)", "volume", "vol"]:
        if alias in cols_lower:
            col_mapping[cols_lower[alias]] = "volume"
            break

    # Vérifier qu'on a au minimum date + close
    target_cols = set(col_mapping.values())
    if "date" not in target_cols or "close" not in target_cols:
        return None

    df = df.rename(columns=col_mapping)

    # Colonnes manquantes : inférer depuis close
    for col in ["open", "high", "low"]:
        if col not in df.columns:
            df[col] = df["close"]
    if "volume" not in df.columns:
        df["volume"] = 0

    # Nettoyage des valeurs numériques (espaces, virgules, symboles monétaires)
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = (
            df[col].astype(str)
            .str.replace(r"\s+", "", regex=True)      # supprimer espaces (séparateurs milliers)
            .str.replace(",", ".", regex=False)         # virgule décimale → point
            .str.replace(r"[^\d.\-]", "", regex=True)  # garder chiffres, point, signe
            .replace("", "0")
        )
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # Parser les dates
    df["date"] = df["date"].apply(_parse_date)
    df = df.dropna(subset=["date", "close"])
    df = df[df["close"] > 0]
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    df.set_index("date", inplace=True)
    df = df[["open", "high", "low", "close", "volume"]]

    return df


# ─── API POST GetHistos (source principale) ───────────────────────────────────

SIKA_API_URL = "https://www.sikafinance.com/api/general/GetHistos"

def _fetch_sika_api(sika_id: str, days: int, period: str = "daily") -> Optional[pd.DataFrame]:
    """
    Appel à l'API POST /api/general/GetHistos de SikaFinance.

    period='daily'   → xperiod='1',  ~260 barres journalières (1 an max)
    period='monthly' → xperiod='30', ~60 barres mensuelles (5 ans)
    """
    from datetime import timedelta
    today = datetime.now()
    if period == "monthly":
        xperiod = "30"
        lookback_days = max(days * 35, 1900)   # 60 mois × 35j ≈ 2100j
    else:
        xperiod = "1"
        lookback_days = max(days, 365)
    payload = {
        "ticker": sika_id,
        "datedeb": (today - timedelta(days=lookback_days)).strftime("%Y-%m-%d"),
        "datefin": today.strftime("%Y-%m-%d"),
        "xperiod": xperiod,
    }
    headers_api = {
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": "https://www.sikafinance.com",
        "Referer": f"https://www.sikafinance.com/marches/historiques/{sika_id}",
    }
    try:
        time.sleep(REQUEST_DELAY_SECONDS)
        resp = _session.post(SIKA_API_URL, json=payload, headers=headers_api, timeout=REQUEST_TIMEOUT)
        if resp.status_code != 200:
            logger.debug(f"[SikaFinance API] HTTP {resp.status_code} pour {sika_id}")
            return None

        data = resp.json()
        lst = data.get("lst", [])
        if not lst:
            err = data.get("error", "")
            logger.debug(f"[SikaFinance API] Aucune donnée pour {sika_id} (error={err})")
            return None

        rows = []
        for row in lst:
            try:
                rows.append({
                    "date": _parse_date(str(row["Date"])),
                    "open":   float(row.get("Open",  row.get("Close", 0))),
                    "high":   float(row.get("High",  row.get("Close", 0))),
                    "low":    float(row.get("Low",   row.get("Close", 0))),
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
        df = df.sort_values("date").drop_duplicates("date").reset_index(drop=True)
        df.set_index("date", inplace=True)
        df = df[["open", "high", "low", "close", "volume"]]

        logger.info(f"[SikaFinance API] {len(df)} points pour {sika_id}")
        return df

    except (requests.RequestException, ValueError, KeyError) as e:
        logger.debug(f"[SikaFinance API] Erreur pour {sika_id}: {e}")
        return None




# ─── Point d'entrée principal ─────────────────────────────────────────────────

def get_ohlcv(ticker: str, days: int = 365, period: str = "daily") -> pd.DataFrame:
    """
    Récupère les données OHLCV pour un ticker BRVM.

    Args:
        ticker:  Symbole boursier (ex: "BICC", "ONTBF")
        days:    Nombre de barres souhaitées
        period:  'daily' (~260 barres max, 1 an) ou 'monthly' (~60 barres, 5 ans)

    Returns:
        DataFrame avec colonnes [open, high, low, close, volume] et index DatetimeIndex

    Raises:
        TickerNotFoundError: Si le ticker est introuvable
        InsufficientDataError: Si moins de MIN_DATA_POINTS barres disponibles
    """
    ticker = ticker.upper().strip()
    cache_key = f"ohlcv_{ticker}_{days}_{period}"

    # 1. Cache
    cached = cache.get(cache_key)
    if cached is not None:
        logger.info(f"[Cache] Données chargées pour {ticker}")
        df = pd.DataFrame(cached)
        df.index = pd.to_datetime(df.index)
        return df

    # 2. Résoudre le ticker
    sika_id = _resolve_sika_id(ticker)
    logger.info(f"Ticker {ticker} → Sika ID: {sika_id}")

    df = None
    errors = []

    # 3. API POST GetHistos — source primaire
    try:
        df = _fetch_sika_api(sika_id, days, period=period)
    except Exception as e:
        errors.append(f"SikaFinance API: {e}")

    # 4. Fallback HTML historiques (daily seulement)
    if period == "daily" and (df is None or len(df) < MIN_DATA_POINTS):
        try:
            df_html = _fetch_sika_historiques(sika_id, days)
            if df_html is not None and (df is None or len(df_html) > len(df)):
                df = df_html
        except Exception as e:
            errors.append(f"SikaFinance HTML: {e}")

    # 5. Fallback RichBourse si toujours insuffisant (daily seulement)
    if period == "daily" and (df is None or len(df) < MIN_DATA_POINTS):
        try:
            df_rb = richbourse.fetch_ohlcv(sika_id, days)
            if df_rb is not None and (df is None or len(df_rb) > len(df)):
                df = df_rb
                logger.info(f"[RichBourse] {len(df)} jours pour {ticker}")
        except Exception as e:
            errors.append(f"RichBourse: {e}")

    # Validation finale
    if df is None or len(df) == 0:
        raise TickerNotFoundError(
            f"Ticker '{ticker}' (ID: {sika_id}) introuvable sur Sika Finance. "
            f"Vérifiez l'orthographe sur sikafinance.com/marches/aaz. "
            f"Erreurs : {' | '.join(errors) if errors else 'Aucune donnée trouvée'}"
        )

    if len(df) < MIN_DATA_POINTS:
        raise InsufficientDataError(
            f"Seulement {len(df)} jours disponibles pour '{ticker}' "
            f"(minimum requis : {MIN_DATA_POINTS}). "
            "Le titre a peut-être trop peu d'historique ou est peu coté."
        )

    # Validation qualité (E1) — log sans bloquer
    _validate_ohlcv(df, ticker)

    # Mise en cache — convertir l'index DatetimeIndex en str pour JSON
    df_cache = df.copy()
    df_cache.index = df_cache.index.strftime("%Y-%m-%d")
    cache.set(cache_key, df_cache.to_dict())
    return df


# ─── Validation qualité données (E1) ─────────────────────────────────────────

def _validate_ohlcv(df: pd.DataFrame, ticker: str) -> None:
    """
    Contrôle qualité post-scrape — log des anomalies sans bloquer le pipeline.
    Détecte : données trop sparse, OHLCV incohérent, staleness.
    """
    if df is None or df.empty:
        return

    n = len(df)
    issues = []

    # 1. Sparsité close (> 20% NaN → probable changement de structure HTML)
    nan_rate = df["close"].isna().mean()
    if nan_rate > 0.20:
        issues.append(
            f"close NaN rate={nan_rate:.0%} — possible structure change on Sika Finance"
        )

    # 2. Cohérence OHLCV (high >= low et close dans [low, high])
    valid = df.dropna(subset=["open", "high", "low", "close"])
    if len(valid) > 0:
        pct_hl_ok = (valid["high"] >= valid["low"]).mean()
        pct_c_ok  = ((valid["close"] >= valid["low"]) & (valid["close"] <= valid["high"])).mean()
        if pct_hl_ok < 0.95:
            issues.append(f"OHLCV incohérent: high<low sur {1-pct_hl_ok:.0%} des séances")
        if pct_c_ok < 0.90:
            issues.append(f"close hors [low,high] sur {1-pct_c_ok:.0%} des séances")

    # 3. Staleness — dernière date > 15 jours ouvrés
    try:
        last_date = pd.to_datetime(df.index[-1])
        lag_days = (pd.Timestamp.today() - last_date).days
        if lag_days > 21:   # ~15 jours ouvrés
            issues.append(f"Données potentiellement obsolètes : dernière séance il y a {lag_days}j")
    except Exception:
        pass

    # 4. Zéros pathologiques sur close (erreur de parsing, non NaN)
    zero_rate = (df["close"] == 0).mean()
    if zero_rate > 0.05:
        issues.append(f"close=0 sur {zero_rate:.0%} des séances — vérifier le parsing")

    # 5. Heuristique splits/dividendes exceptionnels (variation journalière > 30%)
    close_clean = df["close"].dropna()
    if len(close_clean) >= 2:
        daily_chg = close_clean.pct_change().abs()
        split_candidates = daily_chg[daily_chg > 0.30]
        if not split_candidates.empty:
            dates_str = ", ".join(str(d)[:10] for d in split_candidates.index[:5])
            issues.append(
                f"Variation(s) journalière(s) > 30% détectée(s) aux dates : {dates_str} — "
                "possible split ou dividende exceptionnel. Vérifier sur sikafinance.com"
            )

    for issue in issues:
        logger.warning(f"[DataQuality] {ticker}: {issue}")

    if issues:
        logger.warning(
            f"[DataQuality] {ticker}: {len(issues)} anomalie(s) détectée(s) — "
            "données utilisées avec réserve"
        )


# ─── Actualités ──────────────────────────────────────────────────────────────

def get_news(ticker: str, max_items: int = 5) -> list[dict]:
    """
    Récupère les dernières actualités pour un ticker BRVM.

    Délègue à rss_feeds.py qui agrège plusieurs sources (RSS + scraping).
    Cache avec TTL court (30 min) pour avoir des news fraîches.

    Returns:
        Liste de dicts avec clés : titre, date, url, source, resume
    """
    from config import NEWS_ENABLED
    if not NEWS_ENABLED:
        return []
    ticker = ticker.upper().strip()
    cache_key = f"news_{ticker}"

    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    news = rss_feeds.get_news_for_ticker(ticker, max_items=max_items)

    # TTL court pour les news (30 min), même si vide (évite re-scraping rapide)
    cache.set(cache_key, news, ttl=NEWS_CACHE_TTL_SECONDS)
    return news
