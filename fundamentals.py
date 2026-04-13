"""
fundamentals.py — Collecte et scoring des données fondamentales BRVM.

Sources :
1. sikafinance.com/marches/cotation/{sika_id} — capitalisation, PER, dividende,
   rendement, 52w high/low, nombre de titres
2. sikafinance.com/marches/aaz — listing complet avec données agrégées

Score fondamental (0–10) basé sur :
- Valorisation : PER relatif au marché BRVM (≈ 10–15×)
- Dividende   : rendement brut
- Position 52w : prix vs extremes annuels
"""

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Optional

import requests
import pandas as pd
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import (
    SIKA_BASE_URL,
    SIKA_QUOTE_URL,
    SIKA_AAZ_URL,
    HTTP_HEADERS,
    REQUEST_DELAY_SECONDS,
    REQUEST_TIMEOUT,
    TICKER_TO_SIKA_ID,
    MACRO_CACHE_TTL_SECONDS,
)
from cache import cache

logger = logging.getLogger(__name__)


# ─── Structures de données ────────────────────────────────────────────────────

@dataclass
class FundamentalData:
    """Données fondamentales pour un titre BRVM."""
    ticker: str
    source: str = "Sika Finance"

    # ── Valorisation ─────────────────────────────────────────────────────────
    capitalisation_fcfa: Optional[float] = None   # Capitalisation boursière en FCFA
    per: Optional[float] = None                   # Price/Earnings Ratio
    prix_livre: Optional[float] = None            # Price/Book (si disponible)

    # ── Dividende ─────────────────────────────────────────────────────────────
    dividende_par_action: Optional[float] = None  # DPA en FCFA
    rendement_dividende_pct: Optional[float] = None  # Rendement brut en %
    derniere_annee_dividende: Optional[str] = None

    # ── Cours & activité ─────────────────────────────────────────────────────
    cours_actuel: Optional[float] = None
    variation_j1_pct: Optional[float] = None
    volume_jour: Optional[float] = None
    nombre_titres: Optional[float] = None        # Nombre d'actions en circulation

    # ── Extremes annuels ──────────────────────────────────────────────────────
    plus_haut_52s: Optional[float] = None        # Plus haut sur 52 semaines
    plus_bas_52s: Optional[float] = None         # Plus bas sur 52 semaines
    position_52s_pct: Optional[float] = None     # Position du cours dans le range 52s (0–100%)

    # ── Score fondamental ─────────────────────────────────────────────────────
    score_fondamental: int = 0                   # Score [-4, +6]
    criteres_fondamentaux: list[dict] = field(default_factory=list)
    signal_fondamental: str = "NEUTRE"           # SOLIDE | NEUTRE | FAIBLE
    signal_emoji: str = "🟡"

    # ── Métadonnées ───────────────────────────────────────────────────────────
    donnees_disponibles: bool = False
    raison_echec: str = ""


# ─── Session HTTP ─────────────────────────────────────────────────────────────

def _build_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=2, backoff_factor=0.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(HTTP_HEADERS)
    return session


_session = _build_session()


# ─── Point d'entrée ───────────────────────────────────────────────────────────

def get_fundamentals(ticker: str) -> FundamentalData:
    """
    Récupère les données fondamentales pour un ticker BRVM.

    Stratégie :
    1. Cache (TTL 24h — les fondamentaux changent peu)
    2. Page cotation Sika Finance (source principale)
    3. Page A-Z Sika Finance (données agrégées)

    Returns:
        FundamentalData rempli (ou avec donnees_disponibles=False si échec)
    """
    ticker = ticker.upper().strip()
    cache_key = f"fundamentals_{ticker}"

    cached = cache.get(cache_key)
    if cached is not None:
        fd = FundamentalData(ticker=ticker)
        for k, v in cached.items():
            if hasattr(fd, k):
                setattr(fd, k, v)
        return fd

    fd = FundamentalData(ticker=ticker)
    sika_id = TICKER_TO_SIKA_ID.get(ticker, ticker)

    # 1. Page cotation (source principale)
    try:
        _scrape_cotation_page(fd, sika_id)
    except Exception as e:
        logger.debug(f"[Fundamentals] Cotation {ticker}: {e}")

    # 2. Compléter via page A-Z si données manquantes
    if not fd.donnees_disponibles or fd.per is None:
        try:
            _scrape_aaz_page(fd, ticker, sika_id)
        except Exception as e:
            logger.debug(f"[Fundamentals] AAZ {ticker}: {e}")

    # 3. Calcul du score
    if fd.donnees_disponibles:
        _compute_score(fd)
    else:
        fd.raison_echec = "Données fondamentales non disponibles sur Sika Finance"

    # Mise en cache (24h)
    cache.set(cache_key, {
        k: v for k, v in fd.__dict__.items()
        if not k.startswith("_")
    }, ttl=MACRO_CACHE_TTL_SECONDS)

    return fd


# ─── Scraping ─────────────────────────────────────────────────────────────────

def _scrape_cotation_page(fd: FundamentalData, sika_id: str) -> None:
    """
    Scrape la page /marches/cotation/{sika_id} de Sika Finance.
    Cette page contient le cours, les stats du jour, et parfois les fondamentaux.
    """
    url = f"{SIKA_QUOTE_URL}/{sika_id}"
    logger.info(f"[Fundamentals] Cotation : {url}")

    time.sleep(REQUEST_DELAY_SECONDS)
    resp = _session.get(url, timeout=REQUEST_TIMEOUT)
    if resp.status_code != 200:
        return

    soup = BeautifulSoup(resp.text, "html.parser")

    # ── Recherche dans tous les tableaux ──────────────────────────────────────
    for table in soup.find_all("table"):
        _extract_from_table(fd, table)

    # ── Recherche dans les blocs de stats (cards, divs clés) ─────────────────
    _extract_from_stats_blocks(fd, soup)

    # ── Recherche du cours dans le titre de la page ───────────────────────────
    if fd.cours_actuel is None:
        _extract_cours_from_page(fd, soup)

    if fd.cours_actuel is not None or fd.capitalisation_fcfa is not None:
        fd.donnees_disponibles = True

    # ── Calculer la position 52s ──────────────────────────────────────────────
    if fd.cours_actuel and fd.plus_haut_52s and fd.plus_bas_52s:
        rang = fd.plus_haut_52s - fd.plus_bas_52s
        if rang > 0:
            fd.position_52s_pct = round(
                (fd.cours_actuel - fd.plus_bas_52s) / rang * 100, 1
            )


def _scrape_aaz_page(fd: FundamentalData, ticker: str, sika_id: str) -> None:
    """
    Scrape la page A-Z de Sika Finance pour récupérer les données agrégées.
    Cette page liste tous les titres avec capitalisation, PER, dividende.
    """
    logger.info(f"[Fundamentals] AAZ : {SIKA_AAZ_URL}")
    time.sleep(REQUEST_DELAY_SECONDS)
    resp = _session.get(SIKA_AAZ_URL, timeout=REQUEST_TIMEOUT)
    if resp.status_code != 200:
        return

    soup = BeautifulSoup(resp.text, "html.parser")
    base = ticker.split(".")[0].upper()

    # Chercher dans les tableaux la ligne correspondant au ticker
    for table in soup.find_all("table"):
        headers = [th.get_text(strip=True).lower() for th in table.find_all("th")]
        for tr in table.find_all("tr"):
            cells = [td.get_text(strip=True) for td in tr.find_all("td")]
            if len(cells) < 2:
                continue
            # Chercher la ligne du ticker
            row_text = " ".join(cells).upper()
            if base not in row_text:
                continue

            # Essayer d'extraire les données selon les en-têtes
            for i, header in enumerate(headers):
                if i >= len(cells):
                    break
                val = _parse_number(cells[i])
                if val is None:
                    continue
                if any(kw in header for kw in ["capi", "market cap"]) and fd.capitalisation_fcfa is None:
                    fd.capitalisation_fcfa = val
                    fd.donnees_disponibles = True
                elif any(kw in header for kw in ["per", "p/e", "pe ratio"]) and fd.per is None:
                    fd.per = val
                elif any(kw in header for kw in ["dividende", "dpa", "dividend"]) and fd.dividende_par_action is None:
                    fd.dividende_par_action = val
                elif any(kw in header for kw in ["rendement", "yield"]) and fd.rendement_dividende_pct is None:
                    fd.rendement_dividende_pct = val
            break


def _extract_from_table(fd: FundamentalData, table) -> None:
    """
    Extrait les données fondamentales depuis un tableau HTML générique.
    Cherche des patterns clé:valeur dans les tableaux à 2 colonnes.
    """
    rows = table.find_all("tr")
    for row in rows:
        cells = row.find_all(["td", "th"])
        if len(cells) < 2:
            continue

        key = cells[0].get_text(strip=True).lower()
        val_raw = cells[1].get_text(strip=True)
        val = _parse_number(val_raw)

        # Capitalisation
        if any(kw in key for kw in ["capitali", "market cap", "cap. boursière", "cap boursiere"]):
            if val is not None and fd.capitalisation_fcfa is None:
                # Convertir milliards/millions si nécessaire
                fd.capitalisation_fcfa = _parse_large_number(val_raw)
                fd.donnees_disponibles = True

        # PER
        elif any(kw in key for kw in ["per", "p/e", "price earning", "bénéfice"]):
            if val is not None and fd.per is None and 0 < val < 1000:
                fd.per = val

        # Dividende
        elif any(kw in key for kw in ["dividende", "dpa", "dividend par action"]):
            if val is not None and fd.dividende_par_action is None:
                fd.dividende_par_action = val

        # Rendement dividende
        elif any(kw in key for kw in ["rendement", "yield", "taux dividende"]):
            if val is not None and fd.rendement_dividende_pct is None and val < 50:
                fd.rendement_dividende_pct = val

        # Plus haut 52 semaines
        elif any(kw in key for kw in ["plus haut", "52s haut", "52 semaines haut", "high 52"]):
            if val is not None and fd.plus_haut_52s is None:
                fd.plus_haut_52s = val

        # Plus bas 52 semaines
        elif any(kw in key for kw in ["plus bas", "52s bas", "52 semaines bas", "low 52"]):
            if val is not None and fd.plus_bas_52s is None:
                fd.plus_bas_52s = val

        # Nombre de titres
        elif any(kw in key for kw in ["nombre de titres", "nb titres", "actions", "shares"]):
            if val is not None and fd.nombre_titres is None:
                fd.nombre_titres = _parse_large_number(val_raw)

        # Cours
        elif any(kw in key for kw in ["cours", "dernier", "clôture", "cloture", "last"]):
            if val is not None and fd.cours_actuel is None and val > 0:
                fd.cours_actuel = val

        # Variation
        elif any(kw in key for kw in ["variation", "var.", "change"]):
            pct = _parse_percentage(val_raw)
            if pct is not None and fd.variation_j1_pct is None:
                fd.variation_j1_pct = pct


def _extract_from_stats_blocks(fd: FundamentalData, soup: BeautifulSoup) -> None:
    """
    Extrait les données depuis des blocs/cards de statistiques (divs, spans).
    Recherche par mots-clés dans les labels et valeurs adjacents.
    """
    # Chercher des patterns label + valeur dans les cards
    label_elements = soup.find_all(
        ["span", "div", "dt", "th", "label", "p"],
        string=re.compile(
            r"(capitali|per\b|p/e|dividende|rendement|52|plus haut|plus bas|nombre.*titres)",
            re.IGNORECASE
        )
    )

    for label_el in label_elements:
        label_text = label_el.get_text(strip=True).lower()

        # Chercher la valeur dans l'élément suivant (sibling ou parent)
        val_el = (
            label_el.find_next_sibling()
            or label_el.parent.find_next_sibling()
        )
        if val_el is None:
            continue
        val_raw = val_el.get_text(strip=True)

        if any(kw in label_text for kw in ["capitali", "market cap"]):
            if fd.capitalisation_fcfa is None:
                fd.capitalisation_fcfa = _parse_large_number(val_raw)
                if fd.capitalisation_fcfa:
                    fd.donnees_disponibles = True
        elif "per" in label_text or "p/e" in label_text:
            v = _parse_number(val_raw)
            if v is not None and fd.per is None and 0 < v < 1000:
                fd.per = v
        elif "dividende" in label_text:
            v = _parse_number(val_raw)
            if v is not None and fd.dividende_par_action is None:
                fd.dividende_par_action = v
        elif "rendement" in label_text:
            pct = _parse_percentage(val_raw)
            if pct is not None and fd.rendement_dividende_pct is None:
                fd.rendement_dividende_pct = pct


def _extract_cours_from_page(fd: FundamentalData, soup: BeautifulSoup) -> None:
    """Tente d'extraire le cours depuis les éléments de prix de la page."""
    # Éléments contenant généralement le cours sur Sika Finance
    price_selectors = [
        ".cours-actuel", ".price", ".last-price",
        "[class*='cours']", "[class*='price']", "[class*='quote']",
        "h1 + div", ".stock-price",
    ]
    for sel in price_selectors:
        el = soup.select_one(sel)
        if el:
            val = _parse_number(el.get_text(strip=True))
            if val and val > 0:
                fd.cours_actuel = val
                fd.donnees_disponibles = True
                return


# ─── Scoring fondamental ──────────────────────────────────────────────────────

def _compute_score(fd: FundamentalData) -> None:
    """
    Calcule le score fondamental sur une échelle [-4, +6].

    Critères :
    1. Valorisation (PER)           : -2 à +2
    2. Rendement dividende          : 0 à +3
    3. Position dans range 52s      : -1 à +1
    """
    criteres = []
    score = 0

    # ── Critère 1 : PER ───────────────────────────────────────────────────────
    if fd.per is not None and fd.per > 0:
        if fd.per < 8:
            pts, interp = +2, f"PER très bas ({fd.per:.1f}×) — action potentiellement décotée"
        elif fd.per < 15:
            pts, interp = +1, f"PER bas ({fd.per:.1f}×) — valorisation raisonnable vs marché BRVM"
        elif fd.per < 25:
            pts, interp = 0, f"PER modéré ({fd.per:.1f}×) — valorisation dans la norme"
        elif fd.per < 40:
            pts, interp = -1, f"PER élevé ({fd.per:.1f}×) — prime de valorisation"
        else:
            pts, interp = -2, f"PER très élevé ({fd.per:.1f}×) — valorisation très chère"
        score += pts
        criteres.append({"nom": "PER", "valeur": f"{fd.per:.1f}×", "points": pts, "interpretation": interp})
    else:
        criteres.append({"nom": "PER", "valeur": "N/D", "points": 0, "interpretation": "PER non disponible"})

    # ── Critère 2 : Rendement dividende ───────────────────────────────────────
    # Calculer le rendement si non fourni directement
    rdiv = fd.rendement_dividende_pct
    if rdiv is None and fd.dividende_par_action and fd.cours_actuel and fd.cours_actuel > 0:
        rdiv = round(fd.dividende_par_action / fd.cours_actuel * 100, 2)
        fd.rendement_dividende_pct = rdiv

    if rdiv is not None and rdiv > 0:
        if rdiv >= 6:
            pts, interp = +3, f"Rendement dividende exceptionnel ({rdiv:.1f}%)"
        elif rdiv >= 4:
            pts, interp = +2, f"Rendement dividende attractif ({rdiv:.1f}%)"
        elif rdiv >= 2:
            pts, interp = +1, f"Rendement dividende correct ({rdiv:.1f}%)"
        else:
            pts, interp = 0, f"Rendement dividende faible ({rdiv:.1f}%)"
        score += pts
        criteres.append({"nom": "Dividende", "valeur": f"{rdiv:.1f}%", "points": pts, "interpretation": interp})
    elif fd.dividende_par_action == 0:
        criteres.append({"nom": "Dividende", "valeur": "0 FCFA", "points": 0, "interpretation": "Pas de dividende distribué"})
    else:
        criteres.append({"nom": "Dividende", "valeur": "N/D", "points": 0, "interpretation": "Données dividende non disponibles"})

    # ── Critère 3 : Position dans le range 52 semaines ───────────────────────
    if fd.position_52s_pct is not None:
        p = fd.position_52s_pct
        if p < 15:
            pts, interp = +1, f"Prix proche du plus bas 52s ({p:.0f}%) — potentiel de rebond"
        elif p > 85:
            pts, interp = -1, f"Prix proche du plus haut 52s ({p:.0f}%) — attention surachat"
        else:
            pts, interp = 0, f"Position dans le range 52s : {p:.0f}%"
        score += pts
        criteres.append({"nom": "Range 52S", "valeur": f"{p:.0f}%", "points": pts, "interpretation": interp})
    else:
        criteres.append({"nom": "Range 52S", "valeur": "N/D", "points": 0, "interpretation": "Données 52s non disponibles"})

    fd.score_fondamental = score
    fd.criteres_fondamentaux = criteres

    if score >= 3:
        fd.signal_fondamental = "SOLIDE"
        fd.signal_emoji = "🟢"
    elif score <= -1:
        fd.signal_fondamental = "FAIBLE"
        fd.signal_emoji = "🔴"
    else:
        fd.signal_fondamental = "NEUTRE"
        fd.signal_emoji = "🟡"


# ─── Utilitaires de parsing ───────────────────────────────────────────────────

def _parse_number(text: str) -> Optional[float]:
    """Parse un nombre depuis une chaîne (gère espaces, virgules, %)."""
    if not text:
        return None
    clean = (
        str(text)
        .replace(" ", "").replace("\xa0", "")
        .replace(",", ".").replace("%", "")
        .strip()
    )
    # Supprimer suffixes (FCFA, XOF, F, etc.)
    clean = re.sub(r"[^\d.\-+]", "", clean)
    try:
        v = float(clean)
        return v if not (v != v) else None  # NaN check
    except (ValueError, TypeError):
        return None


def _parse_large_number(text: str) -> Optional[float]:
    """
    Parse un grand nombre avec suffixes (Mds, Md, M, K) en valeur numérique.
    Exemples : "12,5 Mds" → 12_500_000_000, "450 M" → 450_000_000
    """
    if not text:
        return None
    clean = str(text).strip().replace("\xa0", " ")
    multiplier = 1.0

    if re.search(r"mds?|milliard", clean, re.IGNORECASE):
        multiplier = 1e9
    elif re.search(r"\bm\b|million", clean, re.IGNORECASE):
        multiplier = 1e6
    elif re.search(r"\bk\b|millier", clean, re.IGNORECASE):
        multiplier = 1e3

    num = _parse_number(re.sub(r"[a-zA-Z]", "", clean))
    if num is None:
        return None
    return num * multiplier


def _parse_percentage(text: str) -> Optional[float]:
    """Parse un pourcentage depuis une chaîne."""
    if not text:
        return None
    match = re.search(r"([+-]?\d+[,.]?\d*)\s*%", str(text))
    if match:
        return float(match.group(1).replace(",", "."))
    v = _parse_number(text)
    if v is not None and abs(v) < 100:
        return v
    return None
