"""
tests/test_auth.py — Tests unitaires pour les fonctions de hachage/vérification.
Aucun appel réseau, aucun st.secrets.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hashlib
import pytest

# Si l'import échoue à cause de streamlit en environnement minimal,
# on mock st.secrets avant l'import.
try:
    from auth import _hash_password, _verify_password
except Exception:
    import unittest.mock as mock
    # Mock st.secrets au niveau module
    import types
    st_mock = types.ModuleType("streamlit")
    st_mock.secrets = {}
    sys.modules["streamlit"] = st_mock
    from auth import _hash_password, _verify_password


# ─── TEST 1 — Hash bcrypt commence par $2b$ ────────────────────────────────────

def test_hash_bcrypt_prefix():
    """_hash_password doit retourner un hash bcrypt commençant par $2."""
    h = _hash_password("monmotdepasse")
    assert h.startswith("$2"), (
        f"Hash devrait commencer par '$2' (bcrypt), obtenu : {h[:10]}..."
    )


# ─── TEST 2 — Vérification bcrypt correcte ────────────────────────────────────

def test_verify_bcrypt_correct():
    """_verify_password doit valider le bon mot de passe et rejeter le mauvais."""
    h = _hash_password("monmotdepasse")
    assert _verify_password("monmotdepasse", h) is True, (
        "Vérification bcrypt correcte devrait retourner True"
    )
    assert _verify_password("mauvais", h) is False, (
        "Vérification bcrypt incorrecte devrait retourner False"
    )


# ─── TEST 3 — Migration SHA-256 legacy fonctionne ─────────────────────────────

def test_verify_legacy_sha256():
    """_verify_password doit gérer les anciens hashes SHA-256."""
    legacy_hash = hashlib.sha256("motdepasse123".encode()).hexdigest()
    assert _verify_password("motdepasse123", legacy_hash) is True, (
        "Vérification SHA-256 legacy correcte devrait retourner True"
    )
    assert _verify_password("mauvais", legacy_hash) is False, (
        "Vérification SHA-256 legacy incorrecte devrait retourner False"
    )


# ─── TEST 4 — Hash différent à chaque appel (salt aléatoire) ──────────────────

def test_hash_unique_par_appel():
    """bcrypt génère un salt aléatoire → deux hashes du même mot de passe sont différents."""
    h1 = _hash_password("test")
    h2 = _hash_password("test")
    assert h1 != h2, (
        "Deux hashes du même mot de passe devraient être différents (salt aléatoire)"
    )
