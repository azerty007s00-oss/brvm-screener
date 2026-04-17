"""
rss_feeds.py — Agrégateur d'actualités BRVM via flux RSS et scraping ciblé.

Stratégie en cascade :
1. Flux RSS de sikafinance.com (si dispo)
2. Flux RSS de sources économiques africaines
3. Fallback : scraping direct de la page actualités Sika Finance
"""

import logging
import time
import re
import xml.etree.ElementTree as ET
from typing import Optional

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import (
    HTTP_HEADERS,
    NEWS_MAX_AGE_DAYS,
    NEWS_MAX_ITEMS_DEFAULT,
    REQUEST_DELAY_SECONDS,
    REQUEST_TIMEOUT,
    RSS_FEEDS,
    SIKA_BASE_URL,
    TICKER_TO_SIKA_ID,
)

logger = logging.getLogger(__name__)

try:
    from news_cleaner import process_articles
    _CLEANER_AVAILABLE = True
except ImportError:
    _CLEANER_AVAILABLE = False


# ─── Mots-clés par ticker ─────────────────────────────────────────────────────
# Associe chaque ticker à des termes de recherche dans les titres/résumés d'articles.
# Permet de filtrer les news pertinentes même si le ticker exact n'apparaît pas.

TICKER_KEYWORDS: dict[str, list[str]] = {
    "ORAC":  ["orange ci", "orange côte d'ivoire", "orange cote d'ivoire", "orac"],
    "SNTS":  ["sonatel", "orange sénégal", "orange senegal", "snts"],
    "ETIT":  ["ecobank", "eti", "ecobank transnational", "etit"],
    "SGBC":  ["société générale", "societe generale", "sgbc"],
    "BICC":  ["bicici", "bnp paribas ci", "bicc"],
    "BOAC":  ["bank of africa ci", "boa côte d'ivoire", "boac"],
    "BOABF": ["bank of africa burkina", "boa burkina", "boabf"],
    "BOAB":  ["bank of africa bénin", "boa bénin", "boa benin", "boab"],
    "BOAM":  ["bank of africa mali", "boa mali", "boam"],
    "BOAS":  ["bank of africa sénégal", "boa sénégal", "boa senegal", "boas"],
    "ONTBF": ["onatel", "burkina télécom", "burkina telecom", "ontbf"],
    "NTLC":  ["nestlé ci", "nestle ci", "nestlé côte d'ivoire", "ntlc"],
    "TTLC":  ["total ci", "totalenergies ci", "total côte d'ivoire", "ttlc"],
    "TTLS":  ["total sénégal", "totalenergies sénégal", "ttls"],
    "PALC":  ["palm ci", "palmiculture", "palc"],
    "SLBC":  ["solibra", "brasserie abidjan", "slbc"],
    "SGBC":  ["société générale ci", "societe generale ci"],
    "SIBC":  ["sib", "société ivoirienne de banque", "sibc"],
    "ECOC":  ["ecobank ci", "ecobank côte d'ivoire", "ecoc"],
    "CIEC":  ["cie", "compagnie ivoirienne electricité", "ciec"],
    "SDCC":  ["sodeci", "sdcc"],
    "SHEC":  ["vivo energy", "shell ci", "shec"],
    "CFAC":  ["cfao", "cfao motors", "cfac"],
    "CBIBF": ["coris bank", "cbibf"],
    "ORGT":  ["oragroup", "orgt"],
    "BNBC":  ["nsia banque", "bnbc"],
    "NSBC":  ["nsia assurances", "nsbc"],
}


# ─── Session HTTP ─────────────────────────────────────────────────────────────

def _build_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(total=2, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(HTTP_HEADERS)
    return session


_session = _build_session()


# ─── Point d'entrée ───────────────────────────────────────────────────────────

def get_news_for_ticker(ticker: str, max_items: int = None) -> list[dict]:
    """
    Agrège les actualités depuis plusieurs sources pour un ticker BRVM.

    Cascade :
    1. Flux RSS configurés (filtrés par mots-clés ticker)
    2. Scraping page actualités Sika Finance (fallback)

    Args:
        ticker:    Symbole boursier (ex: "ORAC", "SNTS")
        max_items: Nombre max d'articles à retourner

    Returns:
        Liste de dicts {titre, date, url, source, resume}
    """
    if max_items is None:
        try:
            from config import NEWS_MAX_ITEMS_DEFAULT
            max_items = NEWS_MAX_ITEMS_DEFAULT
        except ImportError:
            max_items = 10
    ticker = ticker.upper().strip()
    keywords = _get_keywords(ticker)
    news: list[dict] = []

    # 1. Flux RSS (plus rapide, plus propre)
    for feed_url in RSS_FEEDS:
        if len(news) >= max_items * 3:
            break
        try:
            items = _fetch_rss(feed_url, keywords, max_items=max_items * 3)
            news.extend(items)
        except Exception as e:
            logger.debug(f"[RSS] Flux {feed_url} → {e}")

    # 1b. Scraping BRVM officielle
    try:
        items = _scrape_brvm_org(ticker, keywords, max_items)
        news.extend(items)
    except Exception as e:
        logger.debug(f"[RSS] BRVM.org scraping → {e}")

    # 2. Fallback : page actualités Sika Finance
    if len(news) < 2:
        try:
            items = _scrape_sika_actualites(ticker, keywords, max_items)
            news.extend(items)
        except Exception as e:
            logger.debug(f"[RSS] Fallback Sika actualités → {e}")

    # Déduplique par URL puis par titre
    seen: set[str] = set()
    unique: list[dict] = []
    for item in news:
        key = item.get("url") or item.get("titre", "")
        if key and key not in seen:
            seen.add(key)
            unique.append(item)

    return unique[:max_items]


# ─── Parsing RSS ──────────────────────────────────────────────────────────────

def _fetch_rss(feed_url: str, keywords: list[str], max_items: int = 10) -> list[dict]:
    """
    Télécharge et parse un flux RSS (format RSS 2.0 ou Atom).
    Filtre les entrées par mots-clés.
    """
    time.sleep(0.3)
    resp = _session.get(feed_url, timeout=REQUEST_TIMEOUT)
    if resp.status_code != 200:
        logger.debug(f"[RSS] HTTP {resp.status_code} pour {feed_url}")
        return []

    items: list[dict] = []
    try:
        root = ET.fromstring(resp.content)
    except ET.ParseError as e:
        logger.debug(f"[RSS] XML invalide {feed_url}: {e}")
        return []

    # ── RSS 2.0 ──
    rss_items = root.findall(".//item")
    if rss_items:
        for item in rss_items:
            titre = (item.findtext("title") or "").strip()
            url = (item.findtext("link") or "").strip()
            date_str = (item.findtext("pubDate") or "")[:25]
            desc_raw = item.findtext("description") or ""
            resume = BeautifulSoup(desc_raw, "html.parser").get_text()[:250].strip()

            if titre and _matches_keywords(titre + " " + resume, keywords):
                items.append({
                    "titre": titre,
                    "date": _clean_date(date_str),
                    "url": url,
                    "source": _source_label(feed_url),
                    "resume": resume,
                })
            if len(items) >= max_items:
                break
        return items

    # ── Atom ──
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    atom_entries = root.findall(".//atom:entry", ns)
    if not atom_entries:
        # Certains feeds n'utilisent pas le namespace explicite
        atom_entries = root.findall(".//{http://www.w3.org/2005/Atom}entry")

    for entry in atom_entries:
        def _text(tag: str) -> str:
            el = entry.find(tag) or entry.find(f"{{http://www.w3.org/2005/Atom}}{tag.split(':')[-1]}")
            return (el.text or "").strip() if el is not None else ""

        titre = _text("atom:title") or _text("title")
        link_el = entry.find("atom:link", ns) or entry.find("{http://www.w3.org/2005/Atom}link")
        url = link_el.get("href", "") if link_el is not None else ""
        date_str = _text("atom:updated") or _text("atom:published") or _text("updated") or _text("published")
        summary_raw = _text("atom:summary") or _text("summary") or _text("atom:content") or _text("content")
        resume = BeautifulSoup(summary_raw, "html.parser").get_text()[:250].strip()

        if titre and _matches_keywords(titre + " " + resume, keywords):
            items.append({
                "titre": titre,
                "date": _clean_date(date_str[:25]),
                "url": url,
                "source": _source_label(feed_url),
                "resume": resume,
            })
        if len(items) >= max_items:
            break

    return items


# ─── Fallback scraping Sika Finance actualités ────────────────────────────────

def _scrape_sika_actualites(ticker: str, keywords: list[str], max_items: int) -> list[dict]:
    """
    Scrape la page actualités de Sika Finance et filtre par mots-clés.
    Tente aussi la page de cotation spécifique au ticker.
    """
    sika_id = TICKER_TO_SIKA_ID.get(ticker, ticker)
    urls_to_try = [
        f"{SIKA_BASE_URL}/marches/actualites",
        f"{SIKA_BASE_URL}/marches/cotation/{sika_id}",
    ]

    items: list[dict] = []

    for url in urls_to_try:
        if len(items) >= max_items:
            break
        try:
            time.sleep(REQUEST_DELAY_SECONDS)
            resp = _session.get(url, timeout=REQUEST_TIMEOUT)
            if resp.status_code != 200:
                continue

            soup = BeautifulSoup(resp.text, "html.parser")

            # Sélecteurs CSS larges pour couvrir les différentes versions du site
            candidates = soup.select(
                "article, "
                ".news-item, .actualite-item, .card-news, "
                "[class*='news'], [class*='actu'], "
                ".card, .post-item"
            )

            for article in candidates:
                # Chercher le titre dans les balises de titre ou liens
                titre_el = article.select_one(
                    "h2 a, h3 a, h4 a, h5 a, "
                    ".titre a, .title a, a.title, "
                    "a[href*='actualit']"
                )
                if not titre_el:
                    # Essai : titre sans lien
                    titre_el = article.select_one("h2, h3, h4, .titre, .title")

                if not titre_el:
                    continue

                titre = titre_el.get_text(strip=True)
                if not titre or len(titre) < 10:
                    continue

                resume_el = article.select_one("p, .resume, .excerpt, .description, .summary")
                resume = resume_el.get_text(strip=True)[:250] if resume_el else ""

                # Filtrer par pertinence ticker
                if not _matches_keywords(titre + " " + resume, keywords):
                    continue

                href = titre_el.get("href", "")
                if href and not href.startswith("http"):
                    href = SIKA_BASE_URL + href

                date_el = article.select_one("time, .date, .published, [class*='date'], [datetime]")
                date_str = ""
                if date_el:
                    date_str = date_el.get("datetime", "") or date_el.get_text(strip=True)

                items.append({
                    "titre": titre,
                    "date": _clean_date(date_str),
                    "url": href,
                    "source": "Sika Finance",
                    "resume": resume,
                })

                if len(items) >= max_items:
                    break

        except Exception as e:
            logger.debug(f"[RSS] Erreur scraping {url}: {e}")

    return items


# ─── Utilitaires ──────────────────────────────────────────────────────────────

def _get_keywords(ticker: str) -> list[str]:
    """
    Retourne la liste de mots-clés pour filtrer les actualités d'un ticker.
    Toujours inclut le ticker brut (sans suffixe pays) comme mot-clé de base.
    """
    base = ticker.split(".")[0].upper()
    custom = TICKER_KEYWORDS.get(base, [])
    # Le ticker lui-même est toujours inclus, en minuscules pour la comparaison
    return [base.lower()] + [k.lower() for k in custom]


def _matches_keywords(text: str, keywords: list[str]) -> bool:
    """Retourne True si le texte contient au moins un des mots-clés (insensible à la casse)."""
    text_lower = text.lower()
    return any(kw in text_lower for kw in keywords)


def _source_label(url: str) -> str:
    try:
        from news_sources import source_label_from_url
        label = source_label_from_url(url)
        if label and not label.startswith("http"):
            return label
    except ImportError:
        pass
    url_lower = url.lower()
    LABELS = {
        "sikafinance": "Sika Finance",
        "lereussitefinanciere": "La Réussite Financière",
        "abidjan.net": "Abidjan.net",
        "apanews": "APA News",
        "reuters": "Reuters Africa",
        "financialafrik": "Financial Afrik",
        "agenceecofin": "Agence Ecofin",
        "jeuneafrique": "Jeune Afrique",
        "invest.ci": "Invest.ci",
        "brvm.org": "BRVM Officielle",
        "richbourse": "Richbourse",
    }
    for key, label in LABELS.items():
        if key in url_lower:
            return label
    match = re.search(r"https?://(?:www\.)?([^/]+)", url)
    return match.group(1) if match else url

def _clean_date(date_str: str) -> str:
    """Normalise une chaîne de date en format lisible court."""
    if not date_str:
        return ""
    # Format RFC 2822 (RSS) : "Mon, 14 Apr 2025 10:30:00 +0000"
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(date_str)
        return dt.strftime("%d/%m/%Y")
    except Exception:
        pass
    # Format ISO 8601 (Atom) : "2025-04-14T10:30:00Z"
    try:
        clean = re.sub(r"[TZ]", " ", date_str).strip()[:19]
        from datetime import datetime
        dt = datetime.strptime(clean, "%Y-%m-%d %H:%M:%S")
        return dt.strftime("%d/%m/%Y")
    except Exception:
        pass
    # Retourner tel quel si on ne sait pas parser
    return date_str[:16]
