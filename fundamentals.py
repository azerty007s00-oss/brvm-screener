"""
fundamentals.py — Analyse fondamentale pour actions BRVM.

Récupère et normalise les données fondamentales publiques :
- Capitalisation boursière (BRVM.org / SikaFinance)
- Dividendes (RichBourse / SikaFinance)
- PER — Price/Earnings Ratio (RichBourse / SikaFinance)
- Plus haut / plus bas 52 semaines
- Score fondamental simple

Sources :
- https://www.brvm.org (capitalisation, 52S)
- https://www.sikafinance.com (données générales, PER)
- https://www.richbourse.com (dividendes, ratios)

Contrainte : uniquement des données publiques et accessibles librement.
"""

import logging
import time
import re
from dataclasses import dataclass, field
from typing import Optional

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
    SIKA_BASE_URL,
    RICHBOURSE_BASE_URL,
    TICKER_TO_SIKA_ID,
    MACRO_CACHE_TTL_SECONDS,
)
from cache import cache

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


# ─── Dataclass résultat ──────────────────────────────────────────────────────

@dataclass
class FundamentalData:
    """Données fondamentales normalisées pour un ticker BRVM."""

    ticker: str

    # Capitalisation
    capitalisation: Optional[float] = None       # en millions FCFA
    capitalisation_source: str = ""

    # Dividendes
    dividende_par_action: Optional[float] = None  # FCFA
    rendement_dividende: Optional[float] = None    # %
    dividende_annee: str = ""                      # ex: "2024"
    dividende_source: str = ""

    # Valorisation
    per: Optional[float] = None                    # Price/Earnings Ratio
    per_source: str = ""
    bpa: Optional[float] = None                    # Bénéfice Par Action (FCFA)

    # Plus haut / plus bas 52 semaines
    high_52w: Optional[float] = None
    low_52w: Optional[float] = None
    pct_from_52w_high: Optional[float] = None

    # Cours actuel (pour calculs)
    cours_actuel: Optional[float] = None

    # Score fondamental (0–10)
    score_fondamental: Optional[float] = None
    score_detail: dict = field(default_factory=dict)

    # Statut
    source_errors: list[str] = field(default_factory=list)


# ─── Point d'entrée principal ────────────────────────────────────────────────

def get_fundamentals(ticker: str, cours_actuel: Optional[float] = None) -> FundamentalData:
    """
    Récupère les données fondamentales pour un ticker BRVM.

    Utilise un cache de 24h car ces données changent rarement.

    Args:
        ticker:        Symbole boursier (ex: "SNTS", "BICC")
        cours_actuel:  Cours actuel pour calcul du rendement dividende

    Returns:
        FundamentalData avec toutes les données disponibles
    """
    ticker = ticker.upper().strip()
    cache_key = f"fundamentals_{ticker}"

    cached = cache.get(cache_key)
    if cached is not None:
        data = FundamentalData(ticker=ticker)
        for k, v in cached.items():
            if hasattr(data, k):
                setattr(data, k, v)
        return data

    data = FundamentalData(ticker=ticker, cours_actuel=cours_actuel)
    sika_id = TICKER_TO_SIKA_ID.get(ticker, ticker)

    # 1. SikaFinance — page cotation (capitalisation, PER, dividendes)
    _fetch_sika_fundamentals(data, sika_id)

    # 2. RichBourse — page titre (dividendes, ratios)
    _fetch_richbourse_fundamentals(data, ticker)

    # 3. Calculs dérivés
    if cours_actuel:
        data.cours_actuel = cours_actuel
        if data.dividende_par_action and data.dividende_par_action > 0:
            data.rendement_dividende = round(
                data.dividende_par_action / cours_actuel * 100, 2
            )
        if data.bpa and data.bpa > 0 and data.per is None:
            data.per = round(cours_actuel / data.bpa, 2)

    # 4. Score fondamental
    data.score_fondamental, data.score_detail = _compute_fundamental_score(data)

    # Cache 24h
    cache_data = {
        k: v for k, v in data.__dict__.items()
        if not k.startswith("_") and k != "source_errors"
    }
    cache.set(cache_key, cache_data, ttl=MACRO_CACHE_TTL_SECONDS)

    return data


# ─── SikaFinance scraping ────────────────────────────────────────────────────

def _fetch_sika_fundamentals(data: FundamentalData, sika_id: str) -> None:
    """Récupère les données fondamentales depuis la page cotation SikaFinance."""
    url = f"{SIKA_BASE_URL}/marches/cotation/{sika_id}"

    try:
        time.sleep(REQUEST_DELAY_SECONDS)
        resp = _session.get(url, timeout=REQUEST_TIMEOUT)
        if resp.status_code != 200:
            data.source_errors.append(f"SikaFinance: HTTP {resp.status_code}")
            return

        soup = BeautifulSoup(resp.text, "html.parser")

        # Extraire les données depuis les tableaux de la page
        for table in soup.find_all("table"):
            rows = table.find_all("tr")
            for row in rows:
                cells = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
                if len(cells) < 2:
                    continue

                label = cells[0].lower()
                value = cells[-1]

                # Capitalisation
                if "capitalisation" in label and data.capitalisation is None:
                    cap = _parse_number(value)
                    if cap and cap > 0:
                        # Convertir en millions si > 1 milliard
                        if cap > 1e9:
                            data.capitalisation = round(cap / 1e6, 2)
                        else:
                            data.capitalisation = round(cap, 2)
                        data.capitalisation_source = "SikaFinance"

                # PER
                if ("per" in label or "p/e" in label or "price/earning" in label) and data.per is None:
                    per = _parse_number(value)
                    if per and 0 < per < 200:
                        data.per = round(per, 2)
                        data.per_source = "SikaFinance"

                # BPA
                if ("bpa" in label or "bénéfice par action" in label or "benefice par action" in label) and data.bpa is None:
                    bpa = _parse_number(value)
                    if bpa:
                        data.bpa = round(bpa, 2)

                # Dividende
                if ("dividende" in label or "div/action" in label) and data.dividende_par_action is None:
                    div = _parse_number(value)
                    if div and div > 0:
                        data.dividende_par_action = round(div, 2)
                        data.dividende_source = "SikaFinance"

                # Rendement dividende
                if "rendement" in label and "div" in label and data.rendement_dividende is None:
                    rdt = _parse_number(value)
                    if rdt and 0 < rdt < 50:
                        data.rendement_dividende = round(rdt, 2)

                # Plus haut / plus bas 52S
                if "52" in label or "annuel" in label:
                    if "haut" in label or "max" in label:
                        h = _parse_number(value)
                        if h and h > 0:
                            data.high_52w = round(h, 2)
                    elif "bas" in label or "min" in label:
                        l = _parse_number(value)
                        if l and l > 0:
                            data.low_52w = round(l, 2)

        # Chercher aussi dans les spans et divs avec attributs data-*
        for el in soup.select("[data-original-title], .info-value, .stock-info span"):
            text = el.get_text(strip=True)
            title = (el.get("data-original-title") or el.get("title") or "").lower()
            if "capitalisation" in title and data.capitalisation is None:
                cap = _parse_number(text)
                if cap and cap > 0:
                    data.capitalisation = round(cap / 1e6, 2) if cap > 1e9 else round(cap, 2)
                    data.capitalisation_source = "SikaFinance"

        logger.info(f"[SikaFinance Fondamentaux] {data.ticker}: "
                     f"cap={data.capitalisation}, PER={data.per}, div={data.dividende_par_action}")

    except requests.RequestException as e:
        data.source_errors.append(f"SikaFinance: {e}")
        logger.debug(f"[SikaFinance Fondamentaux] Erreur pour {sika_id}: {e}")


# ─── RichBourse scraping ─────────────────────────────────────────────────────

def _fetch_richbourse_fundamentals(data: FundamentalData, ticker: str) -> None:
    """Récupère les données fondamentales depuis RichBourse."""
    base = ticker.split(".")[0].lower()
    urls = [
        f"{RICHBOURSE_BASE_URL}/cours-bourse/brvm/{base}",
        f"{RICHBOURSE_BASE_URL}/bourse/brvm/cours/{base}",
    ]

    for url in urls:
        try:
            time.sleep(REQUEST_DELAY_SECONDS)
            resp = _session.get(url, timeout=REQUEST_TIMEOUT)
            if resp.status_code != 200:
                continue

            soup = BeautifulSoup(resp.text, "html.parser")

            for table in soup.find_all("table"):
                rows = table.find_all("tr")
                for row in rows:
                    cells = [td.get_text(strip=True) for td in row.find_all(["td", "th"])]
                    if len(cells) < 2:
                        continue

                    label = cells[0].lower()
                    value = cells[-1]

                    # PER
                    if ("per" in label or "p/e" in label) and data.per is None:
                        per = _parse_number(value)
                        if per and 0 < per < 200:
                            data.per = round(per, 2)
                            data.per_source = "RichBourse"

                    # BPA
                    if ("bpa" in label or "bénéfice" in label) and data.bpa is None:
                        bpa = _parse_number(value)
                        if bpa:
                            data.bpa = round(bpa, 2)

                    # Dividende
                    if "dividende" in label and data.dividende_par_action is None:
                        div = _parse_number(value)
                        if div and div > 0:
                            data.dividende_par_action = round(div, 2)
                            data.dividende_source = "RichBourse"

                    # Capitalisation
                    if "capitalisation" in label and data.capitalisation is None:
                        cap = _parse_number(value)
                        if cap and cap > 0:
                            data.capitalisation = round(cap / 1e6, 2) if cap > 1e9 else round(cap, 2)
                            data.capitalisation_source = "RichBourse"

            if data.per is not None or data.dividende_par_action is not None:
                logger.info(f"[RichBourse Fondamentaux] {ticker}: PER={data.per}, div={data.dividende_par_action}")
                break

        except requests.RequestException as e:
            data.source_errors.append(f"RichBourse: {e}")
            logger.debug(f"[RichBourse Fondamentaux] Erreur pour {ticker}: {e}")


# ─── Score fondamental ───────────────────────────────────────────────────────

def _compute_fundamental_score(data: FundamentalData) -> tuple[Optional[float], dict]:
    """
    Calcule un score fondamental simple (0–10) basé sur :
    - Valorisation (PER) : 0–3 points
    - Rendement dividende : 0–3 points
    - Position vs 52S : 0–2 points
    - Capitalisation : 0–2 points

    Returns:
        (score, detail_dict)
    """
    detail = {}
    total = 0.0
    max_possible = 0.0

    # ── Valorisation (PER) — 0 à 3 pts ──
    if data.per is not None and data.per > 0:
        max_possible += 3
        if data.per < 8:
            pts = 3.0
            comment = f"PER={data.per} — très attractif"
        elif data.per < 12:
            pts = 2.0
            comment = f"PER={data.per} — raisonnable"
        elif data.per < 20:
            pts = 1.0
            comment = f"PER={data.per} — moyen"
        elif data.per < 30:
            pts = 0.5
            comment = f"PER={data.per} — élevé"
        else:
            pts = 0.0
            comment = f"PER={data.per} — très élevé"
        total += pts
        detail["valorisation"] = {"points": pts, "max": 3, "comment": comment}

    # ── Rendement dividende — 0 à 3 pts ──
    if data.rendement_dividende is not None:
        max_possible += 3
        rdt = data.rendement_dividende
        if rdt >= 6:
            pts = 3.0
            comment = f"Rendement {rdt:.1f}% — très attractif"
        elif rdt >= 4:
            pts = 2.0
            comment = f"Rendement {rdt:.1f}% — bon"
        elif rdt >= 2:
            pts = 1.0
            comment = f"Rendement {rdt:.1f}% — modeste"
        elif rdt > 0:
            pts = 0.5
            comment = f"Rendement {rdt:.1f}% — faible"
        else:
            pts = 0.0
            comment = "Pas de dividende"
        total += pts
        detail["dividende"] = {"points": pts, "max": 3, "comment": comment}

    # ── Position vs 52 semaines — 0 à 2 pts ──
    if data.pct_from_52w_high is not None:
        max_possible += 2
        pct = data.pct_from_52w_high
        if pct > -5:
            pts = 0.5
            comment = f"{pct:+.1f}% du plus haut 52S — près du sommet"
        elif pct > -15:
            pts = 1.0
            comment = f"{pct:+.1f}% du plus haut 52S — zone médiane"
        elif pct > -30:
            pts = 1.5
            comment = f"{pct:+.1f}% du plus haut 52S — potentiel de rattrapage"
        else:
            pts = 2.0
            comment = f"{pct:+.1f}% du plus haut 52S — forte décote"
        total += pts
        detail["position_52s"] = {"points": pts, "max": 2, "comment": comment}

    # ── Capitalisation — 0 à 2 pts ──
    if data.capitalisation is not None and data.capitalisation > 0:
        max_possible += 2
        cap_mfcfa = data.capitalisation
        if cap_mfcfa > 500_000:
            pts = 2.0
            comment = f"Cap. {cap_mfcfa:,.0f}M FCFA — grande capitalisation (liquidité)"
        elif cap_mfcfa > 50_000:
            pts = 1.5
            comment = f"Cap. {cap_mfcfa:,.0f}M FCFA — capitalisation moyenne"
        elif cap_mfcfa > 10_000:
            pts = 1.0
            comment = f"Cap. {cap_mfcfa:,.0f}M FCFA — petite capitalisation"
        else:
            pts = 0.5
            comment = f"Cap. {cap_mfcfa:,.0f}M FCFA — micro capitalisation"
        total += pts
        detail["capitalisation"] = {"points": pts, "max": 2, "comment": comment}

    if max_possible == 0:
        return None, detail

    # Normaliser sur 10
    score = round(total / max_possible * 10, 1)
    return score, detail


# ─── Utilitaires ─────────────────────────────────────────────────────────────

def _parse_number(text: str) -> Optional[float]:
    """Parse un nombre depuis un texte formaté (espaces, virgules, symboles)."""
    if not text:
        return None
    # Supprimer les caractères non numériques sauf point, virgule, signe
    cleaned = re.sub(r"[^\d,.\-]", "", text.strip())
    if not cleaned:
        return None
    # Gérer virgule décimale
    cleaned = cleaned.replace(",", ".")
    # Si plusieurs points (séparateur milliers), garder le dernier comme décimal
    parts = cleaned.split(".")
    if len(parts) > 2:
        cleaned = "".join(parts[:-1]) + "." + parts[-1]
    try:
        return float(cleaned)
    except ValueError:
        return None
