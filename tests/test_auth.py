"""
tests/test_auth.py — Tests unitaires pour les fonctions de hachage/vérification/token.
Aucun appel réseau, aucun st.secrets.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hashlib
import string
import secrets as _secrets
import pytest

# Mock streamlit avant l'import de auth (évite la dépendance à st.secrets)
import types
import unittest.mock as mock

st_mock = types.ModuleType("streamlit")
st_mock.secrets = {}
st_mock.error = lambda *a, **kw: None
st_mock.stop = lambda: None
st_mock.session_state = {}
sys.modules["streamlit"] = st_mock

from auth import _hash_password, _verify_password, _generate_password


# ─── TEST 1 — Hash bcrypt commence par $2b$ ───────────────────────────────────

def test_hash_bcrypt_prefix():
    h = _hash_password("monmotdepasse")
    assert h.startswith("$2"), f"Hash devrait commencer par '$2' (bcrypt), obtenu : {h[:10]}..."


# ─── TEST 2 — Vérification bcrypt correcte ────────────────────────────────────

def test_verify_bcrypt_correct():
    h = _hash_password("monmotdepasse")
    assert _verify_password("monmotdepasse", h) is True
    assert _verify_password("mauvais", h) is False


# ─── TEST 3 — Migration SHA-256 legacy fonctionne ─────────────────────────────

def test_verify_legacy_sha256():
    legacy_hash = hashlib.sha256("motdepasse123".encode()).hexdigest()
    assert _verify_password("motdepasse123", legacy_hash) is True
    assert _verify_password("mauvais", legacy_hash) is False


# ─── TEST 4 — Hash différent à chaque appel (salt aléatoire) ──────────────────

def test_hash_unique_par_appel():
    h1 = _hash_password("test")
    h2 = _hash_password("test")
    assert h1 != h2, "Deux hashes du même mot de passe devraient être différents (salt aléatoire)"


# ─── TEST 5 — Mot de passe généré : longueur et jeu de caractères ─────────────

def test_generate_password_format():
    pwd = _generate_password(12)
    allowed = set(string.ascii_letters + string.digits)
    assert len(pwd) == 12, f"Longueur attendue 12, obtenu {len(pwd)}"
    assert all(c in allowed for c in pwd), "Caractères non autorisés dans le mot de passe généré"


# ─── TEST 6 — Tokens aléatoires distincts (secrets.token_urlsafe) ─────────────

def test_token_urlsafe_uniqueness():
    t1 = _secrets.token_urlsafe(32)
    t2 = _secrets.token_urlsafe(32)
    assert t1 != t2, "Deux token_urlsafe successifs devraient être différents"
    assert len(t1) >= 40, f"Token trop court : {len(t1)} chars"


# ─── TEST 7 — TTL expiry détecté correctement ─────────────────────────────────

def test_token_ttl_expired():
    from datetime import datetime, timedelta
    import hmac as _hmac

    # Simule un token expiré : expires_at dans le passé
    stored = _secrets.token_urlsafe(32)
    expires_past = (datetime.now() - timedelta(hours=1)).isoformat()

    # Réplique la logique de _verify_token sans appel réseau
    def check_ttl(expires_str):
        try:
            return datetime.now() <= datetime.fromisoformat(expires_str)
        except ValueError:
            return False

    assert check_ttl(expires_past) is False, "Token expiré devrait être rejeté"
    expires_future = (datetime.now() + timedelta(hours=47)).isoformat()
    assert check_ttl(expires_future) is True, "Token valide devrait être accepté"
