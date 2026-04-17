"""
news_cleaner.py — Filtrage par date, déduplication, tri des actualités BRVM.
"""
import re
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_MAX_AGE_DAYS = 90
SIMILARITY_THRESHOLD = 0.75

def clean_article(article: dict) -> dict:
    def strip_html(t): return re.sub(r"<[^>]+>", "", t or "").strip()
    def norm(t): return re.sub(r"\s+", " ", t or "").strip()
    cleaned = {
        "titre": strip_html(norm(article.get("titre", ""))),
        "date": article.get("date", ""),
        "url": (article.get("url") or "").strip(),
        "source": (article.get("source") or "").strip(),
        "resume": strip_html(norm(article.get("resume", "")))[:300],
        "date_iso": article.get("date_iso", ""),
    }
    if not cleaned["date_iso"] and cleaned["date"]:
        cleaned["date_iso"] = _to_iso(cleaned["date"])
    return cleaned

def parse_date(date_str: str) -> Optional[datetime]:
    if not date_str:
        return None
    date_str = date_str.strip()[:30]
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        pass
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"]:
        try:
            s = re.sub(r"[TZ]", " ", date_str).strip()[:19]
            return datetime.strptime(s[:len(fmt)], fmt).replace(tzinfo=timezone.utc)
        except Exception:
            continue
    return None

def _to_iso(date_display: str) -> str:
    dt = parse_date(date_display)
    return dt.strftime("%Y-%m-%d") if dt else ""

def filter_recent(articles: list[dict], max_age_days: int = DEFAULT_MAX_AGE_DAYS) -> list[dict]:
    if not articles:
        return []
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=max_age_days)
    kept = []
    for a in articles:
        dt = parse_date(a.get("date_iso") or a.get("date", ""))
        if dt is None or dt >= cutoff:
            kept.append(a)
    return kept

def sort_by_date(articles: list[dict], newest_first: bool = True) -> list[dict]:
    def key(a):
        dt = parse_date(a.get("date_iso") or a.get("date", ""))
        return dt if dt else datetime.min.replace(tzinfo=timezone.utc)
    return sorted(articles, key=key, reverse=newest_first)

def deduplicate(articles: list[dict]) -> list[dict]:
    seen_urls: set[str] = set()
    step1 = []
    for a in articles:
        url = (a.get("url") or "").strip()
        if url and url in seen_urls:
            continue
        if url:
            seen_urls.add(url)
        step1.append(a)
    unique = []
    seen_tokens = []
    for a in step1:
        tokens = frozenset(w for w in re.split(r"\W+", a.get("titre", "").lower()) if len(w) > 3)
        if not tokens:
            unique.append(a)
            continue
        is_dup = any(
            len(tokens & e) / len(tokens | e) >= SIMILARITY_THRESHOLD
            for e in seen_tokens if e
        )
        if not is_dup:
            unique.append(a)
            seen_tokens.append(tokens)
    return unique

def process_articles(articles: list[dict], max_age_days: int = DEFAULT_MAX_AGE_DAYS, max_items: int = 10) -> list[dict]:
    cleaned = [clean_article(a) for a in articles]
    recent = filter_recent(cleaned, max_age_days=max_age_days)
    unique = deduplicate(recent)
    sorted_articles = sort_by_date(unique, newest_first=True)
    return sorted_articles[:max_items]
