"""
close_market_report.py - Rapport de cloture BRVM.

Declenche par GitHub Actions a 15:00 UTC (cloture marche BRVM).
Scanne les 46 titres de l'univers, compare avec les positions ouvertes
du journal de trading (tracking.py) et envoie un email actionnable.

Contenu du rapport :
  1. Nouvelles opportunites  - signaux ACHAT/VENTE avec entree / TP / SL
  2. Positions a fermer      - TP/SL atteints ou signal inverse
  3. Ajustements SL          - trailing stop vers breakeven ou +25% gain
  4. Positions stables       - rien a faire, recap PnL courant

Variables d'environnement (GitHub Secrets) :
  ALERT_EMAIL_FROM      - adresse Gmail expeditrice
  ALERT_EMAIL_PASSWORD  - mot de passe d'application Google (App Password)
  ALERT_EMAIL_TO        - adresse destinataire

Usage manuel :
  python close_market_report.py
"""

import logging
import os
import smtplib
import sys
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))

from analysis import nb_actions_entier
from config import (
    CAPITAL_DEFAUT,
    DEFAULT_HORIZON,
    TICKER_NAMES,
    TICKER_TO_SIKA_ID,
)
from indicators import compute_indicators
from scraper import get_ohlcv
from scoring import compute_score
from tracking import get_open_trades, update_open_trades

# Capital de reference : variable d'environnement CAPITAL_TOTAL ou valeur config
_CAPITAL = int(os.environ.get("CAPITAL_TOTAL", CAPITAL_DEFAUT))

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# Tickers exclus du scan (indices composes)
_INDEX_TICKERS: frozenset = frozenset(
    {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}
)

# Trailing stop : seuils de progression vers le TP
_TRAIL_BREAKEVEN_PCT = 0.50   # >= 50% du chemin vers TP -> SL au breakeven
_TRAIL_LOCK25_PCT    = 0.75   # >= 75% -> SL a +25% du gain potentiel


# ---------------------------------------------------------------------------
# 1. Scan de l'univers
# ---------------------------------------------------------------------------

def scan_all_tickers(horizon: str = DEFAULT_HORIZON) -> list[dict]:
    """
    Scanne tous les tickers BRVM et retourne les resultats de scoring.

    Returns:
        Liste de dicts {ticker, nom, signal, score, confiance,
                        entry_price, take_profit, stop_loss, rr, position_pct}
    """
    tickers = [t for t in TICKER_TO_SIKA_ID if t not in _INDEX_TICKERS]
    results = []

    for ticker in tickers:
        logger.info("[Scan] %s...", ticker)
        try:
            df = get_ohlcv(ticker, days=365)
            if df is None or df.empty:
                logger.warning("[Scan] %s - donnees vides", ticker)
                continue

            ind   = compute_indicators(df, ticker=ticker, horizon=horizon)
            score = compute_score(ind)

            results.append({
                "ticker":       ticker,
                "nom":          TICKER_NAMES.get(ticker, ticker),
                "signal":       score.signal,
                "score":        score.score_total,
                "confiance":    score.confiance,
                "entry_price":  ind.cours_actuel,
                "take_profit":  score.take_profit,
                "stop_loss":    score.stop_loss,
                "rr":           _compute_rr(
                    ind.cours_actuel, score.stop_loss,
                    score.take_profit, score.signal,
                ),
                "position_pct": score.position_size_pct,
            })
        except Exception as exc:
            logger.warning("[Scan] %s - erreur : %s", ticker, exc)

    return results


def _compute_rr(
    entry: float,
    sl: Optional[float],
    tp: Optional[float],
    signal: str,
) -> Optional[float]:
    if None in (entry, sl, tp) or entry <= 0:
        return None
    risk   = abs(entry - sl)
    reward = abs(tp - entry)
    return round(reward / risk, 2) if risk > 0 else None


# ---------------------------------------------------------------------------
# 2. Actions sur positions ouvertes
# ---------------------------------------------------------------------------

def get_position_actions(scan_results: list[dict]) -> list[dict]:
    """
    Pour chaque trade ouvert dans le journal, determine l'action recommandee.

    Actions possibles :
      FERMER_TP      - target atteint, prendre les benefices
      FERMER_SL      - stop touche, couper la perte
      FERMER_SIGNAL  - signal inverse (ACHAT -> VENTE ou vice versa)
      AJUSTER_SL_BE  - deplacer SL au breakeven (>= 50% chemin vers TP)
      AJUSTER_SL_25  - SL a +25% gain potentiel (>= 75% chemin)
      CONSERVER      - rien a faire

    Returns:
        Liste triee : fermetures en premier, ajustements ensuite, stable en fin.
    """
    open_trades = get_open_trades()
    if open_trades.empty:
        return []

    scan_by_ticker = {r["ticker"]: r for r in scan_results}
    actions = []

    for _, row in open_trades.iterrows():
        ticker = str(row["ticker"])
        signal = str(row["signal"])

        try:
            entry  = float(row["entry_price"])
            sl     = float(row["stop_loss"])
            tp     = float(row["take_profit"])
        except (ValueError, TypeError):
            continue

        scan_row = scan_by_ticker.get(ticker)
        if scan_row is None:
            continue

        current        = float(scan_row["entry_price"])
        current_signal = scan_row.get("signal", "NEUTRE")

        # Priorite 1 - cloture TP/SL
        action = _check_close(signal, sl, tp, current)

        # Priorite 2 - signal inverse
        if action == "CONSERVER":
            if signal == "ACHAT" and current_signal == "VENTE":
                action = "FERMER_SIGNAL"
            elif signal == "VENTE" and current_signal == "ACHAT":
                action = "FERMER_SIGNAL"

        # Priorite 3 - trailing stop
        new_sl = None
        if action == "CONSERVER":
            action, new_sl = _check_trail(signal, entry, sl, tp, current)

        pnl_pct = _pnl(signal, entry, current)

        actions.append({
            "ticker":         ticker,
            "nom":            TICKER_NAMES.get(ticker, ticker),
            "signal":         signal,
            "entry_price":    entry,
            "current_price":  current,
            "stop_loss":      sl,
            "take_profit":    tp,
            "new_sl":         new_sl,
            "pnl_pct":        round(pnl_pct, 2),
            "action":         action,
            "current_signal": current_signal,
        })

    # Tri : fermetures > ajustements > stable
    _priority = {"FERMER": 0, "AJUSTER": 1, "CONSERVER": 2}
    return sorted(actions, key=lambda x: _priority.get(x["action"][:7], 2))


def _check_close(signal: str, sl: float, tp: float, current: float) -> str:
    if signal == "ACHAT":
        if current <= sl:
            return "FERMER_SL"
        if current >= tp:
            return "FERMER_TP"
    elif signal == "VENTE":
        if current >= sl:
            return "FERMER_SL"
        if current <= tp:
            return "FERMER_TP"
    return "CONSERVER"


def _check_trail(
    signal: str,
    entry: float,
    sl: float,
    tp: float,
    current: float,
) -> tuple:
    """Retourne (action, new_sl) ou ("CONSERVER", None)."""
    distance = abs(tp - entry)
    if distance <= 0:
        return "CONSERVER", None

    if signal == "ACHAT":
        progress = (current - entry) / distance
        if progress >= _TRAIL_LOCK25_PCT:
            new_sl = round(entry + 0.25 * distance, 0)
            if new_sl > sl:
                return "AJUSTER_SL_25", new_sl
        elif progress >= _TRAIL_BREAKEVEN_PCT:
            new_sl = round(entry, 0)
            if new_sl > sl:
                return "AJUSTER_SL_BE", new_sl

    elif signal == "VENTE":
        progress = (entry - current) / distance
        if progress >= _TRAIL_LOCK25_PCT:
            new_sl = round(entry - 0.25 * distance, 0)
            if new_sl < sl:
                return "AJUSTER_SL_25", new_sl
        elif progress >= _TRAIL_BREAKEVEN_PCT:
            new_sl = round(entry, 0)
            if new_sl < sl:
                return "AJUSTER_SL_BE", new_sl

    return "CONSERVER", None


def _pnl(signal: str, entry: float, current: float) -> float:
    if entry <= 0:
        return 0.0
    if signal == "ACHAT":
        return (current - entry) / entry * 100
    if signal == "VENTE":
        return (entry - current) / entry * 100
    return 0.0


# ---------------------------------------------------------------------------
# 3. Construction de l'email HTML
# ---------------------------------------------------------------------------

def build_html_report(
    scan_results: list[dict],
    position_actions: list[dict],
) -> str:
    ts          = datetime.now().strftime("%d/%m/%Y a %H:%M UTC")
    open_tickers = {a["ticker"] for a in position_actions}

    # Nouvelles opportunites = signaux hors positions deja ouvertes
    new_signals = [
        r for r in scan_results
        if r["signal"] in ("ACHAT", "VENTE")
        and r["ticker"] not in open_tickers
        and r["stop_loss"] is not None
    ]
    new_signals.sort(key=lambda x: x.get("score", 0), reverse=True)

    fermer    = [a for a in position_actions if a["action"].startswith("FERMER")]
    ajuster   = [a for a in position_actions if a["action"].startswith("AJUSTER")]
    conserver = [a for a in position_actions if a["action"] == "CONSERVER"]

    p = []
    p.append(
        "<div style='font-family:Arial,sans-serif;max-width:720px;margin:auto'>"
        "<h2 style='color:#1a3c5e;border-bottom:2px solid #1a3c5e;padding-bottom:8px'>"
        "BRVM - Rapport de cloture</h2>"
        f"<p style='color:#666;font-size:13px'>Rapport automatique du {ts}</p>"
    )

    # --- Section 1 : nouvelles opportunites ---
    p.append(
        f"<h3 style='color:#0F6E56'>Nouvelles opportunites ({len(new_signals)})</h3>"
    )
    if new_signals:
        p.append(
            "<table style='width:100%;border-collapse:collapse;font-size:13px'>"
            "<tr style='background:#1a3c5e;color:white'>"
            "<th style='padding:8px;text-align:left'>Ticker</th>"
            "<th>Signal</th><th>Entree (FCFA)</th>"
            "<th>Stop Loss</th><th>Take Profit</th>"
            f"<th>Nb actions</th><th>Montant</th>"
            "<th>R/R</th><th>Confiance</th>"
            "</tr>"
        )
        for i, r in enumerate(new_signals):
            bg        = "#f9f9f9" if i % 2 else "white"
            sig_color = "#0F6E56" if r["signal"] == "ACHAT" else "#A32D2D"
            sig_arrow = "+" if r["signal"] == "ACHAT" else "-"
            rr_str    = f"{r['rr']:.1f}x" if r["rr"] else "-"
            sl_str    = f"{r['stop_loss']:,.0f}" if r["stop_loss"] else "-"
            tp_str    = f"{r['take_profit']:,.0f}" if r["take_profit"] else "-"
            nb        = nb_actions_entier(_CAPITAL, r.get("position_pct"), r["entry_price"])
            montant   = nb * r["entry_price"] if nb > 0 else 0
            p.append(
                f"<tr style='background:{bg}'>"
                f"<td style='padding:7px;border-bottom:1px solid #eee'>"
                f"<b>{r['ticker']}</b>"
                f"<br><span style='color:#888;font-size:11px'>{r['nom'][:25]}</span></td>"
                f"<td style='text-align:center;color:{sig_color}'>"
                f"<b>{sig_arrow} {r['signal']}</b></td>"
                f"<td style='text-align:right'>{r['entry_price']:,.0f}</td>"
                f"<td style='text-align:right;color:#A32D2D'>{sl_str}</td>"
                f"<td style='text-align:right;color:#0F6E56'>{tp_str}</td>"
                f"<td style='text-align:center'><b>{nb}</b></td>"
                f"<td style='text-align:right'>{montant:,.0f}</td>"
                f"<td style='text-align:center'><b>{rr_str}</b></td>"
                f"<td style='text-align:center'>{r['confiance']}</td>"
                f"</tr>"
            )
        p.append("</table>")
    else:
        p.append(
            "<p style='color:#888;font-style:italic'>"
            "Aucune nouvelle opportunite detectee aujourd'hui.</p>"
        )

    # --- Section 2 : positions a fermer ---
    if fermer:
        p.append(
            f"<h3 style='color:#A32D2D'>Positions a fermer ({len(fermer)})</h3>"
        )
        for a in fermer:
            pnl_color = "#0F6E56" if a["pnl_pct"] >= 0 else "#A32D2D"
            pnl_sign  = "+" if a["pnl_pct"] >= 0 else ""

            if a["action"] == "FERMER_TP":
                label  = "Target atteint - prendre les benefices"
                bg     = "#f0fff0"
                border = "#0F6E56"
            elif a["action"] == "FERMER_SL":
                label  = "Stop Loss touche - couper la perte"
                bg     = "#fff0f0"
                border = "#A32D2D"
            else:
                label  = f"Signal inverse -> {a['current_signal']} - cloturer"
                bg     = "#fff8e1"
                border = "#BA7517"

            p.append(
                f"<div style='background:{bg};border-left:4px solid {border};"
                f"padding:12px;margin:8px 0;border-radius:4px'>"
                f"<b>{a['ticker']}</b> - {a['nom'][:30]}<br>"
                f"<b>{label}</b><br>"
                f"Entree : {a['entry_price']:,.0f} | "
                f"Prix actuel : <b>{a['current_price']:,.0f}</b> | "
                f"PnL : <b style='color:{pnl_color}'>{pnl_sign}{a['pnl_pct']:.2f}%</b><br>"
                f"<span style='color:#888;font-size:12px'>"
                f"SL : {a['stop_loss']:,.0f} | TP : {a['take_profit']:,.0f}</span>"
                f"</div>"
            )

    # --- Section 3 : ajustements SL ---
    if ajuster:
        p.append(
            f"<h3 style='color:#BA7517'>Ajustements SL recommandes ({len(ajuster)})</h3>"
        )
        for a in ajuster:
            pnl_color = "#0F6E56" if a["pnl_pct"] >= 0 else "#A32D2D"
            pnl_sign  = "+" if a["pnl_pct"] >= 0 else ""

            if a["action"] == "AJUSTER_SL_BE":
                adj = (
                    f"Deplacer SL au breakeven : "
                    f"<b>{a['new_sl']:,.0f} FCFA</b> "
                    f"(position a >50% du chemin vers TP)"
                )
            else:
                adj = (
                    f"Deplacer SL a <b>{a['new_sl']:,.0f} FCFA</b> "
                    f"(securise 25% du gain potentiel - >75% du chemin vers TP)"
                )

            p.append(
                f"<div style='background:#fff8e1;border-left:4px solid #BA7517;"
                f"padding:12px;margin:8px 0;border-radius:4px'>"
                f"<b>{a['ticker']}</b> - {a['nom'][:30]}<br>"
                f"{adj}<br>"
                f"Entree : {a['entry_price']:,.0f} | "
                f"Prix : <b>{a['current_price']:,.0f}</b> | "
                f"PnL : <b style='color:{pnl_color}'>{pnl_sign}{a['pnl_pct']:.2f}%</b><br>"
                f"<span style='color:#888;font-size:12px'>"
                f"SL actuel : {a['stop_loss']:,.0f} -> Nouveau SL : {a['new_sl']:,.0f} | "
                f"TP : {a['take_profit']:,.0f}</span>"
                f"</div>"
            )

    # --- Section 4 : positions stables ---
    if conserver:
        p.append(
            f"<h3 style='color:#1A6E9A'>Positions stables - rien a faire ({len(conserver)})</h3>"
        )
        p.append(
            "<table style='width:100%;border-collapse:collapse;font-size:13px'>"
            "<tr style='background:#f0f0f0'>"
            "<th style='padding:7px;text-align:left'>Ticker</th>"
            "<th>Direction</th><th>Entree</th><th>Prix actuel</th>"
            "<th>Stop Loss</th><th>Take Profit</th><th>PnL</th>"
            "</tr>"
        )
        for i, a in enumerate(conserver):
            bg        = "#f9f9f9" if i % 2 else "white"
            pnl_color = "#0F6E56" if a["pnl_pct"] >= 0 else "#A32D2D"
            pnl_sign  = "+" if a["pnl_pct"] >= 0 else ""
            p.append(
                f"<tr style='background:{bg}'>"
                f"<td style='padding:7px;border-bottom:1px solid #eee'>"
                f"<b>{a['ticker']}</b></td>"
                f"<td style='text-align:center'>{a['signal']}</td>"
                f"<td style='text-align:right'>{a['entry_price']:,.0f}</td>"
                f"<td style='text-align:right'><b>{a['current_price']:,.0f}</b></td>"
                f"<td style='text-align:right;color:#A32D2D'>{a['stop_loss']:,.0f}</td>"
                f"<td style='text-align:right;color:#0F6E56'>{a['take_profit']:,.0f}</td>"
                f"<td style='text-align:right;color:{pnl_color}'>"
                f"<b>{pnl_sign}{a['pnl_pct']:.2f}%</b></td>"
                f"</tr>"
            )
        p.append("</table>")

    # Footer
    n_actions = len(fermer) + len(ajuster)
    p.append(
        "<hr style='border:1px solid #ddd;margin-top:20px'>"
        f"<p style='color:#888;font-size:12px'>"
        f"{len(new_signals)} nouvelle(s) opportunite(s) | "
        f"{n_actions} action(s) requise(s) | "
        f"{len(conserver)} position(s) stable(s)<br>"
        "Rapport automatique BRVM Screener - "
        "<a href='https://brvm-screener.streamlit.app'>Ouvrir le screener</a>"
        "</p></div>"
    )

    return "\n".join(p)


# ---------------------------------------------------------------------------
# 4. Envoi de l'email
# ---------------------------------------------------------------------------

def send_report(html_body: str, n_new: int, n_actions: int) -> None:
    email_from = os.environ.get("ALERT_EMAIL_FROM", "").strip()
    email_pass = os.environ.get("ALERT_EMAIL_PASSWORD", "").strip()
    email_to   = os.environ.get("ALERT_EMAIL_TO", email_from).strip()

    if not email_from or not email_pass:
        print(
            "[Rapport] Email non configure - "
            "ajoutez ALERT_EMAIL_FROM et ALERT_EMAIL_PASSWORD dans les GitHub Secrets"
        )
        return

    today  = datetime.now().strftime("%d/%m/%Y")
    prefix = "URGENT" if n_actions > 0 else "INFO"
    subject = (
        f"[BRVM] Cloture {today} - "
        f"{n_new} opportunite(s) | {n_actions} action(s) requise(s) [{prefix}]"
    )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = email_from
    msg["To"]      = email_to
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as server:
            server.login(email_from, email_pass)
            server.sendmail(email_from, email_to, msg.as_string())
        print(f"[Rapport] Email envoye -> {email_to}")
    except Exception as exc:
        print(f"[Rapport] Echec envoi : {exc}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# 5. Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print(
        f"[Rapport] === Cloture BRVM - "
        f"{datetime.now().strftime('%Y-%m-%d %H:%M UTC')} ==="
    )

    # Scan complet de l'univers
    print("[Rapport] Scan en cours sur tous les tickers...")
    scan_results = scan_all_tickers()
    print(f"[Rapport] {len(scan_results)} tickers analyses")

    # Mise a jour du journal : cloture automatique stop/target/timeout
    ticker_prices = {r["ticker"]: r["entry_price"] for r in scan_results}
    closed_today  = update_open_trades(ticker_prices)
    if closed_today:
        print(f"[Rapport] {len(closed_today)} trade(s) cloture(s) par le journal")
        for t in closed_today:
            print(
                f"  {t['ticker']} {t['exit_reason']} "
                f"pnl={t['pnl_pct']:+.1f}% ({t['days_held']}j)"
            )

    # Actions sur positions encore ouvertes
    position_actions = get_position_actions(scan_results)

    n_new     = sum(1 for r in scan_results if r["signal"] in ("ACHAT", "VENTE"))
    n_actions = sum(1 for a in position_actions if a["action"] != "CONSERVER")

    print(f"[Rapport] Nouvelles opportunites : {n_new}")
    print(f"[Rapport] Actions sur positions  : {n_actions}")
    for a in position_actions:
        if a["action"] != "CONSERVER":
            print(f"  {a['ticker']} -> {a['action']} (PnL {a['pnl_pct']:+.2f}%)")

    # Construction et envoi
    html = build_html_report(scan_results, position_actions)
    send_report(html, n_new, n_actions)

    print("[Rapport] Termine.")
