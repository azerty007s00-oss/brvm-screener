"""
fundamentals_loader.py
=======================
Singleton léger pour charger fundamentals_history.json et fournir
les données fondamentales contextuelles (div_yield, per_implied)
pour le scoring et le backtest.

Timing sans look-ahead bias :
  - Si date.month >= 6 : utiliser les résultats de l'année précédente
    (publiés ~Q1 de l'année courante, disponibles en juin)
  - Si date.month < 6  : utiliser les résultats d'il y a 2 ans
    (publiés ~Q1 de l'année précédente, toujours disponibles)
"""

from __future__ import annotations

import json
import logging
from datetime import date
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DATA_FILE = Path(__file__).parent / "data" / "fundamentals_history.json"


# ─── Dataclass légère (pas de dépendance dataclasses pour éviter cycles) ─────

class FundData:
    """Données fondamentales pour un ticker × année donnés."""
    __slots__ = ("bnpa", "dividende", "per_sika", "resultat_net_millions",
                 "ca_millions", "annee")

    def __init__(self, annee: int, d: dict):
        self.annee                = annee
        self.bnpa                 = d.get("bnpa")
        self.dividende            = d.get("dividende")
        self.per_sika             = d.get("per")
        self.resultat_net_millions = d.get("resultat_net_millions")
        self.ca_millions          = d.get("ca_millions")


class FundamentalsLoader:
    """
    Singleton pour accéder aux fondamentaux historiques BRVM.

    Usage typique (dans le backtest) :
        loader = FundamentalsLoader()
        div_yield, per_impl, annee = loader.get_signals(
            ticker="SNTS", review_date=date(2023, 6, 15), cours=28000)
    """

    _instance: Optional["FundamentalsLoader"] = None
    _loaded   : bool = False

    def __new__(cls) -> "FundamentalsLoader":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        if not self._loaded:
            self._stocks: dict = {}
            self._load()
            FundamentalsLoader._loaded = True

    def _load(self) -> None:
        if not _DATA_FILE.exists():
            logger.warning(
                "fundamentals_history.json introuvable — "
                "critère Valorisation désactivé. "
                "Lancez build_fundamentals_history.py pour le construire."
            )
            return
        try:
            with open(_DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._stocks = data.get("stocks", {})
            logger.info(
                f"[FundamentalsLoader] {len(self._stocks)} tickers chargés "
                f"(mis à jour le {data.get('last_updated', '?')})"
            )
        except Exception as exc:
            logger.error(f"[FundamentalsLoader] Erreur chargement : {exc}")

    # ── API publique ──────────────────────────────────────────────────────────

    def get_raw(self, ticker: str, signal_year: int) -> Optional[FundData]:
        """Retourne FundData pour un ticker × année, ou None si absent."""
        info = self._stocks.get(ticker)
        if not info:
            return None
        year_data = info.get("history", {}).get(str(signal_year))
        if not year_data:
            return None
        return FundData(signal_year, year_data)

    def signal_year_for(self, review_date: date) -> int:
        """
        Détermine l'année fondamentale à utiliser sans look-ahead bias.
        - Jan-Mai : résultats de Y-2 (Y-1 pas encore publiés en BRVM)
        - Juin-Déc : résultats de Y-1 (publiés en Q1 de l'année courante)
        """
        if review_date.month >= 6:
            return review_date.year - 1
        return review_date.year - 2

    def get_signals(
        self,
        ticker: str,
        review_date: date,
        cours: float,
    ) -> tuple[Optional[float], Optional[float], Optional[int]]:
        """
        Retourne (div_yield, per_implied, annee) pour un ticker à une date.

        - div_yield  = dividende / cours_actuel  (None si données manquantes)
        - per_implied = cours_actuel / bnpa       (None si BNPA manquant ou ≤ 0)
        - annee      = année des données utilisées (pour affichage)
        """
        if cours <= 0:
            return None, None, None

        sy = self.signal_year_for(review_date)
        fd = self.get_raw(ticker, sy)
        if fd is None:
            return None, None, None

        div_yield   = None
        per_implied = None

        if fd.dividende and fd.dividende > 0:
            div_yield = fd.dividende / cours

        if fd.bnpa and fd.bnpa > 0:
            per_implied = cours / fd.bnpa

        return div_yield, per_implied, sy

    def is_available(self) -> bool:
        """True si la base de données est chargée et non vide."""
        return bool(self._stocks)

    def reload(self) -> None:
        """Force le rechargement (utile après mise à jour du JSON)."""
        FundamentalsLoader._loaded = False
        self._stocks = {}
        self._load()
        FundamentalsLoader._loaded = True


# ── Instance module-level (singleton) ─────────────────────────────────────────
_loader: Optional[FundamentalsLoader] = None


def get_loader() -> FundamentalsLoader:
    """Retourne l'instance singleton (crée si nécessaire)."""
    global _loader
    if _loader is None:
        _loader = FundamentalsLoader()
    return _loader
