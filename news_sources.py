"""
news_sources.py - Registre centralisé de toutes les sources d'actualités BRVM.
"""
from dataclasses import dataclass
from typing import Optional

@dataclass
class NewsSource:
    name: str
    url: str
    source_type: str        # "rss" | "scrape" | "atom"
    language: str = "fr"
    reliability: int = 3    # 1 (faible) → 5 (très fiable)
    brvm_focus: bool = False
    active: bool = True
    scrape_selector: Optional[str] = None
    notes: str = ""

NEWS_SOURCES: list[NewsSource] = [
    NewsSource(name="Sika Finance - Actualités", url="https://www.sikafinance.com/rss/actualites", source_type="rss", reliability=5, brvm_focus=True),
    NewsSource(name="Sika Finance - Feed général", url="https://www.sikafinance.com/feed", source_type="rss", reliability=5, brvm_focus=True),
    NewsSource(name="Financial Afrik", url="https://www.financialafrik.com/feed/", source_type="rss", reliability=4, brvm_focus=True),
    NewsSource(name="Agence Ecofin", url="https://www.agenceecofin.com/feed", source_type="rss", reliability=4, brvm_focus=True),
    NewsSource(name="La Réussite Financière", url="https://lereussitefinanciere.com/feed/", source_type="rss", reliability=3, brvm_focus=True),
    NewsSource(name="Invest.ci", url="https://www.invest.ci/feed/", source_type="rss", reliability=3, brvm_focus=True),
    NewsSource(name="Abidjan.net - Économie", url="https://www.abidjan.net/services/rss/economie.asp", source_type="rss", reliability=3, brvm_focus=False),
    NewsSource(name="APA News", url="https://apanews.net/feed/", source_type="rss", reliability=3, brvm_focus=False),
    NewsSource(name="Jeune Afrique", url="https://www.jeuneafrique.com/feed/", source_type="rss", reliability=3, brvm_focus=False),
    NewsSource(name="BRVM Officielle", url="https://www.brvm.org/fr/actualites", source_type="scrape", reliability=5, brvm_focus=True, scrape_selector="article, .views-row, .node, .card"),
    NewsSource(name="Richbourse - Actualités", url="https://www.richbourse.com/actualites/", source_type="scrape", reliability=3, brvm_focus=True, scrape_selector=".post, article, .news"),
]

def get_active_rss_sources() -> list[NewsSource]:
    return sorted([s for s in NEWS_SOURCES if s.active and s.source_type in ("rss", "atom")], key=lambda s: s.reliability, reverse=True)

def get_rss_urls() -> list[str]:
    return [s.url for s in get_active_rss_sources()]

def source_label_from_url(url: str) -> str:
    import re
    url_lower = url.lower()
    for source in NEWS_SOURCES:
        if source.url.lower() in url_lower or url_lower in source.url.lower():
            return source.name
    match = re.search(r"https?://(?:www\.)?([^/]+)", url)
    return match.group(1) if match else url

TICKER_IR_URLS: dict[str, str] = {
    "ORAC": "https://orange.ci/fr/groupe/investisseurs",
    "SNTS": "https://sonatel.sn/investisseurs",
    "ETIT": "https://www.ecobank.com/upload/investorrelations",
    "TTLC": "https://totalenergies.ci/investisseurs",
    "TTLS": "https://totalenergies.sn/investisseurs",
    "SGBC": "https://societegenerale.ci/fr/investisseurs",
    "ONTBF": "https://onatel.bf/investisseurs",
    "NTLC": "https://www.nestle-cwa.com/fr/investisseurs",
}
