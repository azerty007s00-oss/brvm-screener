"""
alert_checker.py - Vérification automatique des alertes portfolio BRVM.

Déclenché par GitHub Actions à l'ouverture (09:00 UTC) et à la clôture
(15:00 UTC) du marché, du lundi au vendredi.

Variables d'environnement requises (GitHub Secrets) :
  ALERT_EMAIL_FROM      - adresse Gmail expéditrice
  ALERT_EMAIL_PASSWORD  - mot de passe d'application Google (App Password)
  ALERT_EMAIL_TO        - adresse destinataire (peut être identique à FROM)

Usage manuel :
  python alert_checker.py "Ouverture du marché"
"""

import json
import os
import smtplib
import sys
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from scraper import get_ohlcv

PORTFOLIO_FILE = Path(__file__).parent / "portfolio.json"
ALERT_STOP_PCT = 5.0
ALERT_TGT_PCT  = 3.0


def load_portfolio() -> list[dict]:
    if PORTFOLIO_FILE.exists():
        return json.loads(PORTFOLIO_FILE.read_text(encoding="utf-8"))
    return []


def save_portfolio(positions: list[dict]) -> None:
    PORTFOLIO_FILE.write_text(
        json.dumps(positions, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def fetch_price(ticker: str) -> float | None:
    try:
        df = get_ohlcv(ticker, days=5)
        if df is not None and not df.empty:
            return float(df["close"].iloc[-1])
    except Exception:
        pass
    return None


def check_alerts(positions: list[dict]) -> list[dict]:
    alerts = []
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    for pos in positions:
        ticker = pos["ticker"]
        ep     = float(pos.get("entry_price", 0))
        sl     = pos.get("stop_loss")
        tp     = pos.get("take_profit")

        cp = fetch_price(ticker)
        print(f"  {ticker}: prix={cp}")
        if cp is None:
            continue

        pos["current_price"] = cp
        pos["refreshed_at"]  = now_str

        if sl and float(sl) > 0:
            sl = float(sl)
            if cp <= sl:
                alerts.append(dict(level="CRITICAL", type="STOP_TOUCHE",
                                   ticker=ticker, price=cp, threshold=sl, entry=ep))
            elif (cp - sl) / cp * 100 <= ALERT_STOP_PCT:
                alerts.append(dict(level="WARNING", type="STOP_PROCHE",
                                   ticker=ticker, price=cp, threshold=sl, entry=ep))

        if tp and float(tp) > 0:
            tp = float(tp)
            if cp >= tp:
                alerts.append(dict(level="SUCCESS", type="TARGET_ATTEINT",
                                   ticker=ticker, price=cp, threshold=tp, entry=ep))
            elif (tp - cp) / cp * 100 <= ALERT_TGT_PCT:
                alerts.append(dict(level="INFO", type="TARGET_PROCHE",
                                   ticker=ticker, price=cp, threshold=tp, entry=ep))

    return alerts


def build_email_body(alerts: list[dict], context: str) -> str:
    ts = datetime.now().strftime("%d/%m/%Y à %H:%M UTC")
    lines = [
        f"<h2 style='color:#1a3c5e'>📊 BRVM Portfolio - {context}</h2>",
        f"<p style='color:#666'>Vérification automatique du {ts}</p>",
        "<hr style='border:1px solid #ddd'>",
    ]

    critical = [a for a in alerts if a["level"] in ("CRITICAL", "SUCCESS")]
    warnings = [a for a in alerts if a["level"] in ("WARNING", "INFO")]

    if critical:
        lines.append("<h3>🚨 Actions immédiates requises</h3>")
        for a in critical:
            pnl = (a["price"] - a["entry"]) / a["entry"] * 100 if a["entry"] else 0
            if a["type"] == "STOP_TOUCHE":
                lines.append(
                    f"<div style='background:#fff0f0;border-left:4px solid red;padding:12px;margin:8px 0'>"
                    f"<b style='color:red'>🚨 STOP TOUCHÉ - {a['ticker']}</b><br>"
                    f"Prix actuel : <b>{a['price']:,.0f} FCFA</b> | "
                    f"Stop : {a['threshold']:,.0f} FCFA | "
                    f"Entrée : {a['entry']:,.0f} FCFA | "
                    f"PnL : <b style='color:red'>{pnl:+.2f}%</b><br>"
                    f"<i>→ Clôture de position recommandée</i>"
                    f"</div>"
                )
            elif a["type"] == "TARGET_ATTEINT":
                lines.append(
                    f"<div style='background:#f0fff0;border-left:4px solid green;padding:12px;margin:8px 0'>"
                    f"<b style='color:green'>🎯 TARGET ATTEINT - {a['ticker']}</b><br>"
                    f"Prix actuel : <b>{a['price']:,.0f} FCFA</b> | "
                    f"Target : {a['threshold']:,.0f} FCFA | "
                    f"Entrée : {a['entry']:,.0f} FCFA | "
                    f"PnL : <b style='color:green'>{pnl:+.2f}%</b><br>"
                    f"<i>→ Prise de bénéfice possible</i>"
                    f"</div>"
                )

    if warnings:
        lines.append("<h3>⚠️ Niveaux à surveiller</h3>")
        for a in warnings:
            if a["type"] == "STOP_PROCHE":
                dist = (a["price"] - a["threshold"]) / a["price"] * 100
                lines.append(
                    f"<p>⚠️ <b>{a['ticker']}</b> - prix {a['price']:,.0f} FCFA "
                    f"à {dist:.1f}% du stop ({a['threshold']:,.0f} FCFA)</p>"
                )
            elif a["type"] == "TARGET_PROCHE":
                dist = (a["threshold"] - a["price"]) / a["price"] * 100
                lines.append(
                    f"<p>🟢 <b>{a['ticker']}</b> - target {a['threshold']:,.0f} FCFA "
                    f"à {dist:.1f}% ({a['price']:,.0f} FCFA actuel)</p>"
                )

    lines.append(
        "<hr><p style='color:#aaa;font-size:12px'>"
        "Alerte automatique BRVM Screener - "
        "<a href='https://brvm-screener.streamlit.app'>Ouvrir le screener</a></p>"
    )
    return "\n".join(lines)


def send_email(alerts: list[dict], context: str) -> None:
    email_from = os.environ.get("ALERT_EMAIL_FROM", "").strip()
    email_pass = os.environ.get("ALERT_EMAIL_PASSWORD", "").strip()
    email_to   = os.environ.get("ALERT_EMAIL_TO", email_from).strip()

    if not email_from or not email_pass:
        print("[Alert] Email non configuré - ajoutez ALERT_EMAIL_FROM et ALERT_EMAIL_PASSWORD dans les GitHub Secrets")
        return

    n_critical = sum(1 for a in alerts if a["level"] in ("CRITICAL", "SUCCESS"))
    prefix = "🚨" if any(a["level"] == "CRITICAL" for a in alerts) else \
             "🎯" if any(a["level"] == "SUCCESS"  for a in alerts) else "⚠️"
    subject = (
        f"{prefix} [BRVM] {len(alerts)} alerte(s) - {context} "
        f"- {datetime.now().strftime('%d/%m/%Y')}"
    )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = email_from
    msg["To"]      = email_to
    msg.attach(MIMEText(build_email_body(alerts, context), "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as server:
            server.login(email_from, email_pass)
            server.sendmail(email_from, email_to, msg.as_string())
        print(f"[Alert] Email envoyé → {email_to} ({len(alerts)} alerte(s))")
    except smtplib.SMTPAuthenticationError as e:
        print(
            f"[Alert] Échec authentification SMTP : {e}\n"
            "[Alert] ACTION REQUISE : régénérer un App Password Gmail et mettre à jour "
            "le secret GitHub ALERT_EMAIL_PASSWORD."
        )
    except Exception as e:
        print(f"[Alert] Échec envoi email (non bloquant) : {e}")


if __name__ == "__main__":
    context = sys.argv[1] if len(sys.argv) > 1 else "Vérification manuelle"
    print(f"[Alert] === {context} - {datetime.now().strftime('%Y-%m-%d %H:%M UTC')} ===")

    positions = load_portfolio()
    if not positions:
        print("[Alert] Portfolio vide - rien à vérifier")
        sys.exit(0)

    print(f"[Alert] {len(positions)} position(s) dans le portfolio")
    alerts = check_alerts(positions)

    save_portfolio(positions)
    print(f"[Alert] portfolio.json mis à jour (prix refreshés)")

    print(f"[Alert] {len(alerts)} alerte(s) détectée(s)")
    for a in alerts:
        print(f"  [{a['level']}] {a['ticker']} - {a['type']} | prix={a['price']:,.0f} seuil={a['threshold']:,.0f}")

    if alerts:
        send_email(alerts, context)
    else:
        print("[Alert] Tout nominal - aucun email envoyé")
