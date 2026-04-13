"""
cache.py — Cache JSON local avec TTL pour éviter le re-scraping systématique
"""

import json
import os
import time
import hashlib
import logging
from pathlib import Path
from typing import Optional, Any

from config import CACHE_DIR, CACHE_TTL_SECONDS, NEWS_CACHE_TTL_SECONDS, MACRO_CACHE_TTL_SECONDS

logger = logging.getLogger(__name__)


class CacheManager:
    """Gestionnaire de cache JSON local avec expiration TTL."""

    def __init__(self, cache_dir: str = CACHE_DIR, ttl: int = CACHE_TTL_SECONDS) -> None:
        self.cache_dir = Path(cache_dir)
        self.ttl = ttl
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _key_to_path(self, key: str) -> Path:
        """Convertit une clé en chemin de fichier cache sécurisé."""
        safe_key = hashlib.md5(key.encode()).hexdigest()
        return self.cache_dir / f"{safe_key}.json"

    def get(self, key: str) -> Optional[Any]:
        """
        Récupère une valeur depuis le cache si elle n'est pas expirée.

        Returns:
            La valeur cachée ou None si absente/expirée.
        """
        path = self._key_to_path(key)
        if not path.exists():
            return None

        try:
            with open(path, "r", encoding="utf-8") as f:
                entry = json.load(f)

            age = time.time() - entry.get("timestamp", 0)
            # Utilise le TTL stocké dans l'entrée (si présent) ou le TTL global
            effective_ttl = entry.get("ttl", self.ttl)
            if age > effective_ttl:
                logger.debug(f"Cache expiré pour la clé '{key}' ({age:.0f}s > {effective_ttl}s)")
                path.unlink(missing_ok=True)
                return None

            logger.debug(f"Cache hit pour '{key}' (âge: {age:.0f}s)")
            return entry.get("data")

        except (json.JSONDecodeError, KeyError, OSError) as e:
            logger.warning(f"Erreur lecture cache pour '{key}': {e}")
            path.unlink(missing_ok=True)
            return None

    def set(self, key: str, data: Any, ttl: Optional[int] = None) -> None:
        """
        Enregistre une valeur dans le cache avec timestamp.

        Args:
            key:  Clé de cache
            data: Données à stocker
            ttl:  TTL en secondes (prioritaire sur le TTL global du manager).
                  Utiliser NEWS_CACHE_TTL_SECONDS pour les news,
                  MACRO_CACHE_TTL_SECONDS pour les données macro.
        """
        path = self._key_to_path(key)
        entry = {
            "key": key,
            "timestamp": time.time(),
            "ttl": ttl if ttl is not None else self.ttl,  # TTL stocké avec l'entrée
            "data": data,
        }
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(entry, f, ensure_ascii=False, indent=2)
            logger.debug(f"Cache écrit pour '{key}' (TTL: {entry['ttl']}s)")
        except OSError as e:
            logger.warning(f"Impossible d'écrire le cache pour '{key}': {e}")

    def invalidate(self, key: str) -> None:
        """Supprime une entrée du cache."""
        path = self._key_to_path(key)
        path.unlink(missing_ok=True)
        logger.debug(f"Cache invalidé pour '{key}'")

    def clear_all(self) -> int:
        """Vide tout le cache. Retourne le nombre de fichiers supprimés."""
        count = 0
        for f in self.cache_dir.glob("*.json"):
            f.unlink()
            count += 1
        logger.info(f"Cache vidé : {count} fichier(s) supprimé(s)")
        return count

    def stats(self) -> dict:
        """Retourne des statistiques sur le cache."""
        files = list(self.cache_dir.glob("*.json"))
        total_size = sum(f.stat().st_size for f in files)
        return {
            "entries": len(files),
            "total_size_kb": round(total_size / 1024, 2),
            "cache_dir": str(self.cache_dir),
            "ttl_seconds": self.ttl,
        }


# Instance globale
cache = CacheManager()
