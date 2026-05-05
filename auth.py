"""
auth.py — Systeme d'authentification pour BRVM Screener
Gestion des demandes d'acces par email avec approbation admin.
"""
import hashlib
import hmac
import json
import secrets
import smtplib
import string
import base64
import html as _html
import bcrypt
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import datetime, timedelta
from urllib.parse import quote

import requests
import streamlit as st


# --- Configuration -----------------------------------------------------------

_MAX_LOGIN_ATTEMPTS = 5
_TOKEN_TTL_HOURS = 48


def get_config():
    """Recupere la configuration depuis st.secrets."""
    secret_key = st.secrets.get("SECRET_KEY", "")
    if not secret_key:
        st.error("⛔ SECRET_KEY manquant dans st.secrets — configurer .streamlit/secrets.toml")
        st.stop()
    return {
        "admin_email": st.secrets.get("ADMIN_EMAIL", ""),
        "gmail_user": st.secrets.get("GMAIL_USER", ""),
        "gmail_app_password": st.secrets.get("GMAIL_APP_PASSWORD", ""),
        "github_token": st.secrets.get("GITHUB_TOKEN", ""),
        "github_repo": st.secrets.get("GITHUB_REPO", ""),
        "secret_key": secret_key,
        "app_url": st.secrets.get("APP_URL", ""),
    }


# --- GitHub Storage ----------------------------------------------------------

def _get_users_from_github():
    """Lit le fichier users.json depuis le repo GitHub."""
    config = get_config()
    url = f"https://api.github.com/repos/{config['github_repo']}/contents/users.json"
    headers = {
        "Authorization": f"token {config['github_token']}",
        "Accept": "application/vnd.github.v3+json",
    }
    resp = requests.get(url, headers=headers, timeout=10)
    if resp.status_code == 404:
        return {}
    resp.raise_for_status()
    data = resp.json()
    content = base64.b64decode(data["content"]).decode("utf-8")
    return json.loads(content)


def _save_users_to_github(users):
    """Sauvegarde users.json dans le repo GitHub."""
    config = get_config()
    url = f"https://api.github.com/repos/{config['github_repo']}/contents/users.json"
    headers = {
        "Authorization": f"token {config['github_token']}",
        "Accept": "application/vnd.github.v3+json",
    }
    content_b64 = base64.b64encode(
        json.dumps(users, indent=2, ensure_ascii=False).encode()
    ).decode()
    resp = requests.get(url, headers=headers, timeout=10)
    sha = resp.json().get("sha") if resp.status_code == 200 else None
    payload = {"message": "Update users.json", "content": content_b64}
    if sha:
        payload["sha"] = sha
    requests.put(url, headers=headers, json=payload, timeout=10)


# --- Helpers -----------------------------------------------------------------

def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _verify_password(password: str, stored_hash: str) -> bool:
    if stored_hash.startswith("$2"):
        # Hash bcrypt moderne
        return bcrypt.checkpw(password.encode(), stored_hash.encode())
    else:
        # Hash SHA-256 legacy — migration transparente au prochain login
        legacy = hashlib.sha256(password.encode()).hexdigest()
        return hmac.compare_digest(legacy, stored_hash)


def _generate_password(length: int = 10) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def _generate_approval_token(email: str, users: dict) -> str:
    """Génère un token aléatoire URL-safe, le stocke dans users[email] avec TTL 48h."""
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now() + timedelta(hours=_TOKEN_TTL_HOURS)).isoformat()
    users[email]["approval_token"] = token
    users[email]["token_expires_at"] = expires_at
    _save_users_to_github(users)
    return token


def _verify_token(email: str, token: str) -> bool:
    """Vérifie le token : correspondance constante-time + TTL 48h."""
    users = _get_users_from_github()
    user = users.get(email)
    if not user:
        return False
    stored = user.get("approval_token", "")
    expires_str = user.get("token_expires_at", "")
    if not stored or not expires_str:
        return False
    try:
        if datetime.now() > datetime.fromisoformat(expires_str):
            return False
    except ValueError:
        return False
    return hmac.compare_digest(stored, token)


def _invalidate_token(email: str) -> None:
    """Supprime le token après usage unique — empêche toute réutilisation du lien."""
    users = _get_users_from_github()
    if email in users:
        users[email].pop("approval_token", None)
        users[email].pop("token_expires_at", None)
        _save_users_to_github(users)


# --- Email -------------------------------------------------------------------

def _send_email(to: str, subject: str, html_body: str) -> bool:
    config = get_config()
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = config["gmail_user"]
        msg["To"] = to
        msg.attach(MIMEText(html_body, "html"))
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(config["gmail_user"], config["gmail_app_password"])
            server.sendmail(config["gmail_user"], to, msg.as_string())
        return True
    except Exception as exc:
        st.error(f"Erreur d envoi d email : {exc}")
        return False


def _send_access_request_email(name: str, email: str, reason: str, users: dict) -> bool:
    config = get_config()
    token = _generate_approval_token(email, users)
    app_url = config["app_url"]
    email_enc = quote(email)
    approve_link = f"{app_url}?action=approve&email={email_enc}&token={token}"
    reject_link = f"{app_url}?action=reject&email={email_enc}&token={token}"
    name_h = _html.escape(name)
    email_h = _html.escape(email)
    reason_h = _html.escape(reason)
    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2>BRVM Screener - Nouvelle demande d acces</h2>
        <table style="border-collapse:collapse;width:100%;">
            <tr><td style="padding:8px;font-weight:bold;">Nom</td><td style="padding:8px;">{name_h}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Email</td><td style="padding:8px;">{email_h}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Raison</td><td style="padding:8px;">{reason_h}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Date</td><td style="padding:8px;">{datetime.now().strftime('%d/%m/%Y %H:%M')}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Expiration lien</td><td style="padding:8px;">Dans {_TOKEN_TTL_HOURS}h (usage unique)</td></tr>
        </table>
        <br/>
        <p>
            <a href="{approve_link}" style="background-color:#0F6E56;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;margin-right:16px;">Accepter</a>
            <a href="{reject_link}" style="background-color:#A32D2D;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">Refuser</a>
        </p>
    </div>
    """
    return _send_email(config["admin_email"], f"[BRVM Screener] Demande d acces de {name_h}", html)


def _send_approval_email(email: str, password: str) -> bool:
    config = get_config()
    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2>BRVM Screener - Acces approuve !</h2>
        <p>Votre demande d acces a ete <b style="color:#0F6E56;">acceptee</b>.</p>
        <p>Voici vos identifiants de premiere connexion :</p>
        <table style="border-collapse:collapse;background:#f8f8f8;width:100%;">
            <tr><td style="padding:8px;font-weight:bold;">Email</td><td style="padding:8px;">{_html.escape(email)}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Mot de passe temporaire</td><td style="padding:8px;"><code>{_html.escape(password)}</code></td></tr>
        </table>
        <br/>
        <p style="color:#555;"><b>Vous serez invite a definir un nouveau mot de passe lors de votre premiere connexion.</b></p>
        <p><a href="{config['app_url']}" style="color:#0F6E56;font-weight:bold;">Acceder au BRVM Screener</a></p>
    </div>
    """
    return _send_email(email, "[BRVM Screener] Acces approuve", html)


def _send_rejection_email(email: str) -> bool:
    html = """
    <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2>BRVM Screener - Demande refusee</h2>
        <p>Votre demande d acces au BRVM Screener a ete <b style="color:#A32D2D;">refusee</b>.</p>
        <p>Pour toute question, contactez l administrateur.</p>
    </div>
    """
    return _send_email(email, "[BRVM Screener] Demande refusee", html)


# --- Actions d approbation / rejet -------------------------------------------

def _handle_approval_action() -> bool:
    """Gere les liens d approbation/rejet recus par email."""
    params = st.query_params
    action = params.get("action")
    email = params.get("email")
    token = params.get("token")
    if not action or not email or not token:
        return False
    if not _verify_token(email, token):
        st.error("Lien invalide ou expire (validite : 48h, usage unique).")
        st.query_params.clear()
        return True
    _invalidate_token(email)
    users = _get_users_from_github()
    if action == "approve":
        if email in users and users[email].get("status") == "pending":
            password = _generate_password()
            users[email]["status"] = "approved"
            users[email]["password_hash"] = _hash_password(password)
            users[email]["must_change_password"] = True
            users[email]["approved_at"] = datetime.now().isoformat()
            _save_users_to_github(users)
            _send_approval_email(email, password)
            st.success(f"Acces approuve pour {email}. Un mot de passe temporaire lui a ete envoye.")
        elif email in users and users[email].get("status") == "approved":
            st.info(f"{email} a deja ete approuve.")
        else:
            st.warning(f"Aucune demande en attente pour {email}.")
    elif action == "reject":
        if email in users and users[email].get("status") == "pending":
            users[email]["status"] = "rejected"
            users[email]["rejected_at"] = datetime.now().isoformat()
            _save_users_to_github(users)
            _send_rejection_email(email)
            st.error(f"Acces refuse pour {email}.")
        else:
            st.warning(f"Aucune demande en attente pour {email}.")
    st.query_params.clear()
    return True


# --- Changement de mot de passe (premiere connexion) -------------------------

def _show_change_password_form() -> None:
    st.title("BRVM Screener")
    st.subheader("Definir votre mot de passe")
    st.info("Pour votre securite, definissez un mot de passe personnel avant d acceder a l application.")
    with st.form("change_password_form"):
        new_pwd = st.text_input("Nouveau mot de passe (min. 8 caracteres)", type="password")
        confirm_pwd = st.text_input("Confirmer le mot de passe", type="password")
        submitted = st.form_submit_button("Enregistrer et continuer", type="primary", use_container_width=True)
        if submitted:
            if len(new_pwd) < 8:
                st.error("Le mot de passe doit contenir au moins 8 caracteres.")
            elif new_pwd != confirm_pwd:
                st.error("Les mots de passe ne correspondent pas.")
            else:
                email = st.session_state.get("user_email")
                users = _get_users_from_github()
                if email and email in users:
                    users[email]["password_hash"] = _hash_password(new_pwd)
                    users[email]["must_change_password"] = False
                    _save_users_to_github(users)
                    st.session_state["must_change_password"] = False
                    st.session_state["authenticated"] = True
                    st.rerun()


# --- Interface principale d authentification ---------------------------------

def check_auth() -> bool:
    """Verifie l authentification. Retourne True si connecte."""
    if _handle_approval_action():
        st.stop()

    if st.session_state.get("must_change_password"):
        _show_change_password_form()
        return False

    if st.session_state.get("authenticated"):
        return True

    st.title("BRVM Screener")
    st.caption("Investment Pioneers")
    st.divider()
    tab_login, tab_request = st.tabs(["Connexion", "Demander l acces"])

    with tab_login:
        attempts = st.session_state.get("login_attempts", 0)
        if attempts >= _MAX_LOGIN_ATTEMPTS:
            st.error("⛔ Trop de tentatives de connexion (5/5). Rechargez la page pour reessayer.")
        else:
            with st.form("login_form"):
                email = st.text_input("Email")
                password = st.text_input("Mot de passe", type="password")
                submitted = st.form_submit_button("Se connecter", type="primary", use_container_width=True)
                if submitted:
                    if not email or not password:
                        st.error("Veuillez remplir tous les champs.")
                    else:
                        users = _get_users_from_github()
                        user = users.get(email)
                        if user and user.get("status") == "approved":
                            if _verify_password(password, user.get("password_hash", "")):
                                st.session_state["login_attempts"] = 0
                                st.session_state["user_email"] = email
                                st.session_state["user_name"] = user.get("name", email)
                                if user.get("must_change_password"):
                                    st.session_state["must_change_password"] = True
                                else:
                                    st.session_state["authenticated"] = True
                                st.rerun()
                            else:
                                new_attempts = attempts + 1
                                st.session_state["login_attempts"] = new_attempts
                                remaining = _MAX_LOGIN_ATTEMPTS - new_attempts
                                if remaining > 0:
                                    st.error(f"Mot de passe incorrect. {remaining} tentative(s) restante(s).")
                                else:
                                    st.error("⛔ Compte verrouille. Rechargez la page pour reessayer.")
                        elif user and user.get("status") == "pending":
                            st.warning("Votre demande est en cours de traitement.")
                        elif user and user.get("status") == "rejected":
                            st.error("Votre demande d acces a ete refusee.")
                        else:
                            st.error("Aucun compte trouve. Demandez l acces dans l onglet suivant.")

    with tab_request:
        st.markdown("Remplissez le formulaire ci-dessous. L administrateur recevra votre demande par email.")
        with st.form("request_form"):
            req_name = st.text_input("Votre nom complet")
            req_email = st.text_input("Votre email")
            req_reason = st.text_area("Pourquoi souhaitez-vous acceder au BRVM Screener ?", max_chars=500)
            req_submitted = st.form_submit_button("Envoyer la demande", type="primary", use_container_width=True)
            if req_submitted:
                if not req_name or not req_email:
                    st.error("Veuillez remplir votre nom et email.")
                elif "@" not in req_email:
                    st.error("Email invalide.")
                else:
                    users = _get_users_from_github()
                    if req_email in users:
                        status = users[req_email].get("status")
                        if status == "approved":
                            st.info("Vous avez deja un compte. Utilisez l onglet Connexion.")
                        elif status == "pending":
                            st.warning("Votre demande est deja en cours de traitement.")
                        elif status == "rejected":
                            st.error("Votre demande precedente a ete refusee.")
                    else:
                        users[req_email] = {
                            "name": req_name,
                            "email": req_email,
                            "reason": req_reason,
                            "status": "pending",
                            "requested_at": datetime.now().isoformat(),
                        }
                        _save_users_to_github(users)
                        if _send_access_request_email(req_name, req_email, req_reason, users):
                            st.success("Demande envoyee ! Vous recevrez un email des que l administrateur aura traite votre demande.")
                        else:
                            st.warning("Demande enregistree mais l email n a pas pu etre envoye.")
    return False


def logout_button() -> None:
    """Affiche un bouton de deconnexion dans la sidebar."""
    with st.sidebar:
        user_name = st.session_state.get("user_name", "")
        if user_name:
            st.caption(f"Connecte : {user_name}")
        if st.button("Deconnexion", use_container_width=True):
            st.session_state["authenticated"] = False
            st.session_state["user_email"] = None
            st.session_state["user_name"] = None
            st.rerun()
