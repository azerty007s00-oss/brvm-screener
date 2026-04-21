"""
exports.py — Export Excel/CSV des résultats d'analyse BRVM.

Génère un fichier Excel multi-onglets avec :
- Résumé (signal, score, indicateurs clés)
- Score technique détaillé
- Données fondamentales
- OHLCV brut
- Actualités
"""

import io
import logging
from datetime import datetime

import pandas as pd

from utils import get_company_name

logger = logging.getLogger(__name__)


# ─── Helpers risk ─────────────────────────────────────────────────────────────

def _rr(score, ind) -> float | None:
    """R/R = distance_target / distance_stop, en multiples d'ATR."""
    if score.stop_loss is None or score.take_profit is None:
        return None
    if ind.atr is None or ind.atr <= 0:
        return None
    k1 = abs(score.stop_loss  - ind.cours_actuel) / ind.atr
    k2 = abs(score.take_profit - ind.cours_actuel) / ind.atr
    return round(k2 / k1, 2) if k1 > 0 else None


def _risk_label(score, rr: float | None) -> str:
    """Classification rapide pour tri Excel : A+ > A > B > C."""
    if score.signal == "NEUTRE" or rr is None:
        return ""
    if rr >= 2.0 and score.confiance == "forte":
        return "A+"
    if rr >= 2.0:
        return "A"
    if rr >= 1.5:
        return "B"
    return "C"


def export_to_excel(results: dict) -> io.BytesIO:
    """
    Génère un fichier Excel multi-onglets à partir des résultats d'analyse.

    Args:
        results: dict {ticker: result_dict} (même format que dans app.py)

    Returns:
        BytesIO contenant le fichier Excel
    """
    output = io.BytesIO()

    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        # ── Onglet 1 : Résumé ────────────────────────────────────────────────
        summary_rows = []
        for ticker, result in results.items():
            if result is None:
                continue
            ind = result["ind"]
            score = result["score"]
            fundamentals = result.get("fundamentals")

            rr_val = _rr(score, ind)
            rl     = _risk_label(score, rr_val)

            row = {
                "Ticker": ticker,
                "Société": get_company_name(ticker),
                "Signal": score.signal,
                "Risk Label": rl,
                "Score technique": score.score_total,
                "Confiance": score.confiance,
                "Cours (FCFA)": ind.cours_actuel,
                "Stop Loss": score.stop_loss,
                "Take Profit": score.take_profit,
                "R/R": rr_val,
                "Position (%)": score.position_size_pct,
                "ATR (%)": round(ind.atr_pct, 2) if ind.atr_pct is not None else None,
                "Data Quality": getattr(ind, "data_quality_flag", "ok"),
                "Var J-1 (%)": ind.variation_j1_pct,
                "RSI": ind.rsi,
                "Stoch %K": ind.stoch_k,
                "ADX": ind.adx,
                "MA Signal": ind.ma_signal,
                "MACD": ind.macd_signal,
                "Perf 1M (%)": ind.perf_1m,
                "Perf 3M (%)": ind.perf_3m,
                "Alpha 1M vs BRVMC (%)": ind.perf_vs_index_1m,
                "Volatilité 3M (%)": getattr(ind, "volatilite_3m", None),
                "Drawdown max 3M (%)": getattr(ind, "drawdown_max_3m", None),
                "52S Haut": getattr(ind, "high_52w", None),
                "52S Bas": getattr(ind, "low_52w", None),
                "Support": ind.support,
                "Résistance": ind.resistance,
                "Config chartiste": ind.config_chartiste,
                "Div. RSI": ind.rsi_divergence,
            }

            if fundamentals:
                row.update({
                    "Capitalisation (M FCFA)": fundamentals.capitalisation,
                    "PER": fundamentals.per,
                    "Dividende/Action (FCFA)": fundamentals.dividende_par_action,
                    "Rendement div. (%)": fundamentals.rendement_dividende,
                    "Score fondamental (/10)": fundamentals.score_fondamental,
                })

            summary_rows.append(row)

        if summary_rows:
            df_summary = pd.DataFrame(summary_rows)
            df_summary.to_excel(writer, sheet_name="Résumé", index=False)

        # ── Onglet 2 : Score technique détaillé ──────────────────────────────
        score_rows = []
        for ticker, result in results.items():
            if result is None:
                continue
            score = result["score"]
            for critere in score.criteres:
                score_rows.append({
                    "Ticker": ticker,
                    "Société": get_company_name(ticker),
                    "Critère": critere.nom,
                    "Valeur": critere.valeur,
                    "Points": critere.points,
                    "Interprétation": critere.interpretation,
                })

        if score_rows:
            df_scores = pd.DataFrame(score_rows)
            df_scores.to_excel(writer, sheet_name="Score technique", index=False)

        # ── Onglet 3 : Données fondamentales ─────────────────────────────────
        fund_rows = []
        for ticker, result in results.items():
            if result is None:
                continue
            f = result.get("fundamentals")
            if f:
                fund_rows.append({
                    "Ticker": ticker,
                    "Société": get_company_name(ticker),
                    "Capitalisation (M FCFA)": f.capitalisation,
                    "Source cap.": f.capitalisation_source,
                    "PER": f.per,
                    "Source PER": f.per_source,
                    "BPA (FCFA)": f.bpa,
                    "Dividende/Action (FCFA)": f.dividende_par_action,
                    "Rendement div. (%)": f.rendement_dividende,
                    "Source div.": f.dividende_source,
                    "52S Haut": f.high_52w,
                    "52S Bas": f.low_52w,
                    "Score fondamental (/10)": f.score_fondamental,
                })

        if fund_rows:
            df_fund = pd.DataFrame(fund_rows)
            df_fund.to_excel(writer, sheet_name="Fondamentaux", index=False)

        # ── Onglet 4 : OHLCV (un onglet par ticker, max 5) ──────────────────
        for i, (ticker, result) in enumerate(results.items()):
            if result is None or i >= 5:
                continue
            df = result["df"]
            if df is not None:
                df_export = df.copy()
                df_export.index = df_export.index.strftime("%Y-%m-%d")
                sheet_name = f"OHLCV_{ticker}"[:31]  # Excel limite à 31 caractères
                df_export.to_excel(writer, sheet_name=sheet_name)

        # ── Onglet 5 : Actualités ────────────────────────────────────────────
        news_rows = []
        for ticker, result in results.items():
            if result is None:
                continue
            for article in result.get("news", []):
                news_rows.append({
                    "Ticker": ticker,
                    "Société": get_company_name(ticker),
                    "Titre": article.get("titre", ""),
                    "Date": article.get("date", ""),
                    "Source": article.get("source", ""),
                    "URL": article.get("url", ""),
                    "Résumé": article.get("resume", ""),
                })

        if news_rows:
            df_news = pd.DataFrame(news_rows)
            df_news.to_excel(writer, sheet_name="Actualités", index=False)

        # ── Onglet 6 : Événements techniques ─────────────────────────────────
        event_rows = []
        for ticker, result in results.items():
            if result is None:
                continue
            ind = result["ind"]
            for event in getattr(ind, "events", []):
                event_rows.append({
                    "Ticker": ticker,
                    "Société": get_company_name(ticker),
                    "Date": event.get("date", ""),
                    "Type": event.get("type", ""),
                    "Description": event.get("description", ""),
                    "Importance": event.get("importance", ""),
                })

        if event_rows:
            df_events = pd.DataFrame(event_rows)
            df_events.to_excel(writer, sheet_name="Événements", index=False)

    output.seek(0)
    return output


def export_to_csv(results: dict) -> str:
    """
    Génère un résumé CSV de tous les tickers analysés.

    Returns:
        Contenu CSV en string
    """
    rows = []
    for ticker, result in results.items():
        if result is None:
            continue
        ind = result["ind"]
        score = result["score"]
        fundamentals = result.get("fundamentals")

        rr_val = _rr(score, ind)
        rl     = _risk_label(score, rr_val)

        row = {
            "Ticker": ticker,
            "Société": get_company_name(ticker),
            "Signal": score.signal,
            "Risk_Label": rl,
            "Score_tech": score.score_total,
            "Confiance": score.confiance,
            "Cours": ind.cours_actuel,
            "Stop_Loss": score.stop_loss,
            "Take_Profit": score.take_profit,
            "RR": rr_val,
            "Position_pct": score.position_size_pct,
            "ATR_pct": round(ind.atr_pct, 2) if ind.atr_pct is not None else None,
            "Data_Quality": getattr(ind, "data_quality_flag", "ok"),
            "Var_J1_pct": ind.variation_j1_pct,
            "RSI": ind.rsi,
            "Stoch_K": ind.stoch_k,
            "ADX": ind.adx,
            "MA_Signal": ind.ma_signal,
            "MACD": ind.macd_signal,
            "Perf_1M_pct": ind.perf_1m,
            "Perf_3M_pct": ind.perf_3m,
            "Alpha_1M_pct": ind.perf_vs_index_1m,
            "Volatilite_3M_pct": getattr(ind, "volatilite_3m", None),
            "Drawdown_max_3M_pct": getattr(ind, "drawdown_max_3m", None),
            "Support": ind.support,
            "Resistance": ind.resistance,
            "Div_RSI": ind.rsi_divergence,
        }

        if fundamentals:
            row.update({
                "Capitalisation_MFCFA": fundamentals.capitalisation,
                "PER": fundamentals.per,
                "Dividende_FCFA": fundamentals.dividende_par_action,
                "Rendement_div_pct": fundamentals.rendement_dividende,
                "Score_fondamental": fundamentals.score_fondamental,
            })

        rows.append(row)

    if not rows:
        return ""

    df = pd.DataFrame(rows)
    return df.to_csv(index=False)
