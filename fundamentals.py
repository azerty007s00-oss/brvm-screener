"""
fundamentals.py — Analyse fondamentale pour actions BRVM.

Stratégie :
  1. Source PRIMAIRE : data/fundamentals_brvm.json (fichier statique curated)
     → BPA, dividende, nb_actions, secteur, pays (mise à jour annuelle)
     → PER et rendement calculés dynamiquement avec le cours live
     → Capitalisation calculée dynamiquement avec cours live × nb_actions
  2. Source SECONDAIRE : scraper SikaFinance (52 semaines high/low uniquement)
     → Ces données changent chaque jour — impossible à mettre en statique
"""

import json
import logging
import time
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import (
    HTTP_HEADERS,
    REQUEST_DELAY_SECONDS,
    REQUEST_TIMEOUT,
    REQUEST_MAX_RETRIES,
    REQUEST_BACKOFF_FACTOR,
    SIKA_BASE_URL,
    TICKER_TO_SIKA_ID,
    MACRO_CACHE_TTL_SECONDS,
)
from cache import cache

logger = logging.getLogger(__name__)

# ─── Chargement fichier statique ──────────────────────────────────────────────

_DATA_FILE = Path(__file__).parent / "data" / "fundamentals_brvm.json"

def _load_static_data() -> dict:
    try:
        with open(_DATA_FILE, encoding="utf-8") as f:
            raw = json.load(f)
        return raw.get("stocks", {})
    except Exception as e:
        logger.warning(f"[Fundamentals] Impossible de charger {_DATA_FILE}: {e}")
        return {}

_STATIC: dict = _load_static_data()


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


# ─── Dataclass résultat ──────────────────────────────────────────────────────

@dataclass
class FundamentalData:
    """Données fondamentales normalisées pour un ticker BRVM."""

    ticker: str

    # Identification
    secteur: str = ""
    pays: str = ""

    # Capitalisation (calculée dynamiquement : cours × nb_actions)
    capitalisation: Optional[float] = None       # en millions FCFA
    capitalisation_source: str = ""
    nb_actions_millions: Optional[float] = None

    # Dividendes
    dividende_par_action: Optional[float] = None  # FCFA
    rendement_dividende: Optional[float] = None   # %
    dividende_annee: str = ""
    dividende_source: str = ""

    # Valorisation
    per: Optional[float] = None                   # Price/Earnings Ratio
    per_source: str = ""
    bpa: Optional[float] = None                   # Bénéfice Par Action (FCFA)

    # Plus haut / plus bas 52 semaines (depuis scraper live)
    high_52w: Optional[float] = None
    low_52w: Optional[float] = None
    pct_from_52w_high: Optional[float] = None

    # Cours actuel (pour calculs)
    cours_actuel: Optional[float] = None

    # Score fondamental (0–10)
    score_fondamental: Optional[float] = None
    score_detail: dict = field(default_factory=dict)

    # Qualité de la donnée
    confiance_donnees: str = ""    # "haute" | "moyenne" | "estimee"
    source_errors: list = field(default_factory=list)


# ─── Point d'entrée principal ────────────────────────────────────────────────

def get_fundamentals(ticker: str, cours_actuel: Optional[float] = None) -> FundamentalData:
    """
    Récupère les données fondamentales pour un ticker BRVM.

    Sources (ordre de priorité) :
    1. Fichier statique JSON pour BPA, dividende, secteur, pays
    2. Scraper SikaFinance pour 52w high/low
    3. Calculs dérivés : PER, rendement, capitalisation depuis cours live

    Cache 6h (données semi-statiques + 52w live).
    """
    ticker = ticker.upper().strip()
    cache_key = f"fundamentals_v2_{ticker}"

    cached = cache.get(cache_key)
    if cached is not None:
        data = FundamentalData(ticker=ticker)
        for k, v in cached.items():
            if hasattr(data, k):
                setattr(data, k, v)
        return data

    data = FundamentalData(ticker=ticker, cours_actuel=cours_actuel)

    # 1. Données statiques (BPA, dividende, secteur, pays, nb_actions)
    _apply_static_data(data)

    # 2. 52 semaines high/low depuis SikaFinance
    sika_id = TICKER_TO_SIKA_ID.get(ticker, ticker)
    _fetch_52w_from_sika(data, sika_id)

    # 3. Calculs dynamiques avec cours live
    if cours_actuel and cours_actuel > 0:
        data.cours_actuel = cours_actuel
        _compute_derived(data, cours_actuel)

    # 4. Score fondamental
    data.score_fondamental, data.score_detail = _compute_fundamental_score(data)

    # Cache 6h
    cache_data = {
        k: v for k, v in data.__dict__.items()
        if not k.startswith("_") and k != "source_errors"
    }
    cache.set(cache_key, cache_data, ttl=21600)

    return data


# ─── Données statiques ────────────────────────────────────────────────────────

def _apply_static_data(data: FundamentalData) -> None:
    """Applique les données du fichier statique JSON."""
    entry = _STATIC.get(data.ticker)
    if not entry:
        logger.debug(f"[Fundamentals] {data.ticker} absent du fichier statique")
        return

    data.secteur = entry.get("secteur", "")
    data.pays = entry.get("pays", "")
    data.nb_actions_millions = entry.get("nb_actions_millions")
    data.confiance_donnees = entry.get("confiance", "estimee")

    bpa = entry.get("bpa")
    if bpa and bpa > 0:
        data.bpa = float(bpa)

    div = entry.get("dividende")
    if div and div > 0:
        data.dividende_par_action = float(div)
        data.dividende_annee = str(entry.get("annee_dividende", "2023"))
        data.dividende_source = f"Rapport annuel {data.dividende_annee}"


# ─── Calculs dynamiques ───────────────────────────────────────────────────────

def _compute_derived(data: FundamentalData, cours: float) -> None:
    """Calcule PER, rendement dividende et capitalisation depuis le cours live."""
    # PER = cours / BPA
    if data.bpa and data.bpa > 0:
        data.per = round(cours / data.bpa, 2)
        data.per_source = f"Calculé (BPA {data.dividende_annee})"

    # Rendement dividende = dividende / cours
    if data.dividende_par_action and data.dividende_par_action > 0:
        data.rendement_dividende = round(data.dividende_par_action / cours * 100, 2)

    # Capitalisation = cours × nb_actions
    if data.nb_actions_millions and data.nb_actions_millions > 0:
        data.capitalisation = round(cours * data.nb_actions_millions, 0)
        data.capitalisation_source = "Calculé (cours × nb actions)"

    # Distance du plus haut 52S
    if data.high_52w and data.high_52w > 0:
        data.pct_from_52w_high = round((cours - data.high_52w) / data.high_52w * 100, 2)


# ─── 52 semaines SikaFinance ──────────────────────────────────────────────────

def _fetch_52w_from_sika(data: FundamentalData, sika_id: str) -> None:
    """
    Récupère uniquement le plus haut et plus bas 52 semaines depuis SikaFinance.
    Ces valeurs changent chaque jour — impossible à mettre en statique.
    """
    url = f"{SIKA_BASE_URL}/marches/cotation/{sika_id}"

    try:
        time.sleep(REQUEST_DELAY_SECONDS)
        resp = _session.get(url, timeout=REQUEST_TIMEOUT)
        if resp.status_code != 200:
            logger.debug(f"[SikaFinance 52w] HTTP {resp.status_code} pour {sika_id}")
            return

        soup = BeautifulSoup(resp.text, "html.parser")

        for table in soup.find_all("table"):
            for row in table.find_all("tr"):
                cells = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
                if len(cells) < 2:
                    continue
                label = cells[0].lower()
                value = cells[-1]

                if "52" in label or "annuel" in label:
                    if ("haut" in label or "max" in label) and data.high_52w is None:
                        h = _parse_number(value)
                        if h and h > 0:
                            data.high_52w = round(h, 2)
                    elif ("bas" in label or "min" in label) and data.low_52w is None:
                        l = _parse_number(value)
                        if l and l > 0:
                            data.low_52w = round(l, 2)

                # Fallback : chercher dans les spans data-*
                if data.high_52w is None or data.low_52w is None:
                    for el in soup.select("[data-original-title]"):
                        title = el.get("data-original-title", "").lower()
                        val = el.get_text(strip=True)
                        if "haut" in title and "52" in title and data.high_52w is None:
                            h = _parse_number(val)
                            if h and h > 0:
                                data.high_52w = round(h, 2)
                        elif "bas" in title and "52" in title and data.low_52w is None:
                            l = _parse_number(val)
                            if l and l > 0:
                                data.low_52w = round(l, 2)

        if data.high_52w or data.low_52w:
            logger.debug(f"[SikaFinance 52w] {data.ticker}: H={data.high_52w}, L={data.low_52w}")

    except requests.RequestException as e:
        logger.debug(f"[SikaFinance 52w] Erreur réseau pour {sika_id}: {e}")


# ─── Score fondamental ────────────────────────────────────────────────────────

def _compute_fundamental_score(data: FundamentalData) -> tuple:
    """
    Score fondamental 0–10 :
    - Valorisation (PER)       : 0–3 pts
    - Rendement dividende       : 0–3 pts
    - Position vs 52 semaines   : 0–2 pts
    - Capitalisation            : 0–2 pts
    """
    detail = {}
    total = 0.0
    max_possible = 0.0

    # ── PER ──
    if data.per is not None and data.per > 0:
        max_possible += 3
        if data.per < 8:
            pts, comment = 3.0, f"PER={data.per:.1f} — très attractif"
        elif data.per < 12:
            pts, comment = 2.0, f"PER={data.per:.1f} — raisonnable"
        elif data.per < 20:
            pts, comment = 1.0, f"PER={data.per:.1f} — moyen"
        elif data.per < 30:
            pts, comment = 0.5, f"PER={data.per:.1f} — élevé"
        else:
            pts, comment = 0.0, f"PER={data.per:.1f} — très élevé"
        total += pts
        detail["valorisation"] = {"points": pts, "max": 3, "comment": comment}

    # ── Rendement dividende ──
    if data.rendement_dividende is not None:
        max_possible += 3
        rdt = data.rendement_dividende
        if rdt >= 6:
            pts, comment = 3.0, f"Rendement {rdt:.1f}% — très attractif"
        elif rdt >= 4:
            pts, comment = 2.0, f"Rendement {rdt:.1f}% — bon"
        elif rdt >= 2:
            pts, comment = 1.0, f"Rendement {rdt:.1f}% — modeste"
        elif rdt > 0:
            pts, comment = 0.5, f"Rendement {rdt:.1f}% — faible"
        else:
            pts, comment = 0.0, "Pas de dividende"
        total += pts
        detail["dividende"] = {"points": pts, "max": 3, "comment": comment}

    # ── Position vs 52S ──
    if data.pct_from_52w_high is not None:
        max_possible += 2
        pct = data.pct_from_52w_high
        if pct > -5:
            pts, comment = 0.5, f"{pct:+.1f}% du plus haut — près du sommet"
        elif pct > -15:
            pts, comment = 1.0, f"{pct:+.1f}% du plus haut — zone médiane"
        elif pct > -30:
            pts, comment = 1.5, f"{pct:+.1f}% du plus haut — potentiel de rattrapage"
        else:
            pts, comment = 2.0, f"{pct:+.1f}% du plus haut — forte décote"
        total += pts
        detail["position_52s"] = {"points": pts, "max": 2, "comment": comment}

    # ── Capitalisation ──
    if data.capitalisation is not None and data.capitalisation > 0:
        max_possible += 2
        cap = data.capitalisation
        if cap > 500_000:
            pts, comment = 2.0, f"{cap:,.0f}M FCFA — grande cap (liquidité)"
        elif cap > 50_000:
            pts, comment = 1.5, f"{cap:,.0f}M FCFA — cap moyenne"
        elif cap > 10_000:
            pts, comment = 1.0, f"{cap:,.0f}M FCFA — petite cap"
        else:
            pts, comment = 0.5, f"{cap:,.0f}M FCFA — micro cap"
        total += pts
        detail["capitalisation"] = {"points": pts, "max": 2, "comment": comment}

    if max_possible == 0:
        return None, detail

    score = round(total / max_possible * 10, 1)
    return score, detail


# ─── Utilitaire ──────────────────────────────────────────────────────────────

def _parse_number(text: str) -> Optional[float]:
    if not text:
        return None
    cleaned = re.sub(r"[^\d,.\-]", "", text.strip())
    if not cleaned:
        return None
    cleaned = cleaned.replace(",", ".")
    parts = cleaned.split(".")
    if len(parts) > 2:
        cleaned = "".join(parts[:-1]) + "." + parts[-1]
    try:
        return float(cleaned)
    except ValueError:
        return None


# ─── Accès direct au registre statique ───────────────────────────────────────

def get_static_registry() -> dict:
    """Retourne le registre statique complet (pour screening/ranking)."""
    return _STATIC


def get_sector(ticker: str) -> str:
    """Retourne le secteur d'un ticker (depuis le registre statique)."""
    return _STATIC.get(ticker.upper(), {}).get("secteur", "")


def get_pays(ticker: str) -> str:
    """Retourne le pays d'un ticker (depuis le registre statique)."""
    return _STATIC.get(ticker.upper(), {}).get("pays", "")
