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
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import datetime
from urllib.parse import quote

import requests
import streamlit as st


# --- Configuration -----------------------------------------------------------

def get_config():
    """Recupere la configuration depuis st.secrets."""
    return {
        "admin_email": st.secrets.get("ADMIN_EMAIL", ""),
        "gmail_user": st.secrets.get("GMAIL_USER", ""),
        "gmail_app_password": st.secrets.get("GMAIL_APP_PASSWORD", ""),
        "github_token": st.secrets.get("GITHUB_TOKEN", ""),
        "github_repo": st.secrets.get("GITHUB_REPO", ""),
        "secret_key": st.secrets.get("SECRET_KEY", "brvm-screener-default-key"),
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

def _hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def _generate_password(length=10):
    chars = string.ascii_letters + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))

def _generate_token(email):
    config = get_config()
    return hmac.new(
        config["secret_key"].encode(), email.encode(), hashlib.sha256
    ).hexdigest()[:32]

def _verify_token(email, token):
    return hmac.compare_digest(_generate_token(email), token)


# --- Email -------------------------------------------------------------------

def _send_email(to, subject, html_body):
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


def _send_access_request_email(name, email, reason):
    config = get_config()
    token = _generate_token(email)
    app_url = config["app_url"]
    email_enc = quote(email)
    approve_link = f"{app_url}?action=approve&email={email_enc}&token={token}"
    reject_link = f"{app_url}?action=reject&email={email_enc}&token={token}"
    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2>BRVM Screener - Nouvelle demande d acces</h2>
        <table style="border-collapse:collapse;width:100%;">
            <tr><td style="padding:8px;font-weight:bold;">Nom</td><td style="padding:8px;">{name}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Email</td><td style="padding:8px;">{email}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Raison</td><td style="padding:8px;">{reason}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Date</td><td style="padding:8px;">{datetime.now().strftime('%d/%m/%Y %H:%M')}</td></tr>
        </table>
        <br/>
        <p>
            <a href="{approve_link}" style="background-color:#0F6E56;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;margin-right:16px;">Accepter</a>
            <a href="{reject_link}" style="background-color:#A32D2D;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">Refuser</a>
        </p>
    </div>
    """
    return _send_email(config["admin_email"], f"[BRVM Screener] Demande d acces de {name}", html)


def _send_approval_email(email, password):
    config = get_config()
    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2>BRVM Screener - Acces approuve !</h2>
        <p>Votre demande d acces a ete <b style="color:#0F6E56;">acceptee</b>.</p>
        <p>Voici vos identifiants :</p>
        <table style="border-collapse:collapse;background:#f8f8f8;width:100%;">
            <tr><td style="padding:8px;font-weight:bold;">Email</td><td style="padding:8px;">{email}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Mot de passe</td><td style="padding:8px;"><code>{password}</code></td></tr>
        </table>
        <br/>
        <p><a href="{config['app_url']}" style="color:#0F6E56;font-weight:bold;">Acceder au BRVM Screener</a></p>
        <p><i>Conservez bien votre mot de passe.</i></p>
    </div>
    """
    return _send_email(email, "[BRVM Screener] Acces approuve", html)


def _send_rejection_email(email):
    html = """
    <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2>BRVM Screener - Demande refusee</h2>
        <p>Votre demande d acces au BRVM Screener a ete <b style="color:#A32D2D;">refusee</b>.</p>
        <p>Pour toute question, contactez l administrateur.</p>
    </div>
    """
    return _send_email(email, "[BRVM Screener] Demande refusee", html)


# --- Actions d approbation / rejet -------------------------------------------

def _handle_approval_action():
    """Gere les liens d approbation/rejet recus par email."""
    params = st.query_params
    action = params.get("action")
    email = params.get("email")
    token = params.get("token")
    if not action or not email or not token:
        return False
    if not _verify_token(email, token):
        st.error("Lien invalide ou expire.")
        st.query_params.clear()
        return True
    users = _get_users_from_github()
    if action == "approve":
        if email in users and users[email].get("status") == "pending":
            password = _generate_password()
            users[email]["status"] = "approved"
            users[email]["password_hash"] = _hash_password(password)
            users[email]["approved_at"] = datetime.now().isoformat()
            _save_users_to_github(users)
            _send_approval_email(email, password)
            st.success(f"Acces approuve pour {email}. Un mot de passe lui a ete envoye.")
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


# --- Interface principale d authentification ---------------------------------

def check_auth():
    """Verifie l authentification. Retourne True si connecte."""
    if _handle_approval_action():
        st.stop()
    if st.session_state.get("authenticated"):
        return True
    st.title("BRVM Screener")
    st.caption("Investment Pioneers")
    st.divider()
    tab_login, tab_request = st.tabs(["Connexion", "Demander l acces"])
    with tab_login:
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
                        if user.get("password_hash") == _hash_password(password):
                            st.session_state["authenticated"] = True
                            st.session_state["user_email"] = email
                            st.session_state["user_name"] = user.get("name", email)
                            st.rerun()
                        else:
                            st.error("Mot de passe incorrect.")
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
                        if _send_access_request_email(req_name, req_email, req_reason):
                            st.success("Demande envoyee ! Vous recevrez un email des que l administrateur aura traite votre demande.")
                        else:
                            st.warning("Demande enregistree mais l email n a pas pu etre envoye.")
    return False


def logout_button():
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
