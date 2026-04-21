"""
tracking.py — Journal de tracking des signaux BRVM.

Un enregistrement = 1 signal exploitable (ACHAT/VENTE + D1 actif) à t0.
Persiste dans journal_signaux.csv. Mise à jour des sorties à chaque run.

Intégration dans build_analyse() (analysis.py) :
    from tracking import log_signal
    log_signal(ind, score)          # après compute_risk_levels + compute_position_size

Intégration dans le screener (app.py) :
    from tracking import update_open_trades
    update_open_trades({ticker: ind.cours_actuel for ticker, ... in results.items()})
"""

import logging
from datetime import date
from pathlib import Path
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)


# ─── Config ──────────────────────────────────────────────────────────────────

JOURNAL_PATH = Path(__file__).parent / "journal_signaux.csv"

_TIMEOUT_DAYS = 20   # clôture forcée si ni stop ni target atteints en N séances

_COLUMNS = [
    "date", "ticker", "signal", "score", "confiance",
    "entry_price", "stop_loss", "take_profit", "rr", "position_pct",
    "atr_pct", "data_quality",
    "exit_price", "exit_date", "exit_reason", "pnl_pct",
]


# ─── I/O CSV ─────────────────────────────────────────────────────────────────

def _load() -> pd.DataFrame:
    if not JOURNAL_PATH.exists():
        return pd.DataFrame(columns=_COLUMNS)
    df = pd.read_csv(JOURNAL_PATH, dtype=str)
    for col in _COLUMNS:          # compatibilité si colonnes ajoutées ultérieurement
        if col not in df.columns:
            df[col] = ""
    return df[_COLUMNS]


def _save(df: pd.DataFrame) -> None:
    df.to_csv(JOURNAL_PATH, index=False)


# ─── Log signal ──────────────────────────────────────────────────────────────

def log_signal(ind, score, today: Optional[date] = None) -> bool:
    """
    Enregistre un signal exploitable dans le journal CSV.

    Filtre : signal ACHAT/VENTE ET stop_loss non None (D1 actif).
    Dédoublonnage : même ticker + même date + même signal → ignoré.

    Returns:
        True si enregistré, False si filtré ou doublon.
    """
    if score.signal not in ("ACHAT", "VENTE") or score.stop_loss is None:
        return False

    today_str = (today or date.today()).isoformat()
    df = _load()

    if not df.empty:
        dup = (
            (df["ticker"] == str(ind.ticker))
            & (df["date"] == today_str)
            & (df["signal"] == score.signal)
        )
        if dup.any():
            logger.debug(f"[Tracking] Doublon ignoré — {ind.ticker} {today_str}")
            return False

    rr = None
    if (score.stop_loss is not None and score.take_profit is not None
            and ind.atr and ind.atr > 0):
        k1 = abs(score.stop_loss  - ind.cours_actuel) / ind.atr
        k2 = abs(score.take_profit - ind.cours_actuel) / ind.atr
        rr = round(k2 / k1, 2) if k1 > 0 else None

    row = {
        "date":         today_str,
        "ticker":       ind.ticker,
        "signal":       score.signal,
        "score":        score.score_total,
        "confiance":    score.confiance,
        "entry_price":  ind.cours_actuel,
        "stop_loss":    score.stop_loss,
        "take_profit":  score.take_profit,
        "rr":           rr,
        "position_pct": score.position_size_pct,
        "atr_pct":      round(ind.atr_pct, 2) if ind.atr_pct is not None else None,
        "data_quality": getattr(ind, "data_quality_flag", "ok"),
        "exit_price":   None,
        "exit_date":    None,
        "exit_reason":  None,
        "pnl_pct":      None,
    }

    df = pd.concat([df, pd.DataFrame([row])], ignore_index=True)
    _save(df)
    logger.info(f"[Tracking] Signal loggé — {ind.ticker} {score.signal} @ {ind.cours_actuel}")
    return True


# ─── Mise à jour des trades ouverts ──────────────────────────────────────────

def update_open_trades(
    ticker_prices: dict,
    today: Optional[date] = None,
) -> list[dict]:
    """
    Vérifie stop / target / timeout sur tous les trades ouverts.

    Args:
        ticker_prices: {ticker: prix_actuel} — tous les tickers du screener
        today:         date du jour (défaut = date.today())

    Returns:
        Liste des trades clôturés lors de cet appel (pour log/affichage).
    """
    today_dt = today or date.today()
    df = _load()
    if df.empty:
        return []

    open_mask = df["exit_date"].isna() | (df["exit_date"] == "")
    closed_this_run = []

    for idx in df[open_mask].index:
        row = df.loc[idx]
        ticker = str(row["ticker"])
        if ticker not in ticker_prices:
            continue

        current_price = ticker_prices[ticker]
        signal = str(row["signal"])

        try:
            entry   = float(row["entry_price"])
            stop    = float(row["stop_loss"])
            target  = float(row["take_profit"])
            entry_d = date.fromisoformat(str(row["date"]))
        except (ValueError, TypeError):
            continue

        days_held   = (today_dt - entry_d).days
        exit_reason = None

        if signal == "ACHAT":
            if current_price <= stop:
                exit_reason = "stop"
            elif current_price >= target:
                exit_reason = "target"
        elif signal == "VENTE":
            if current_price >= stop:    # stop = au-dessus pour un short
                exit_reason = "stop"
            elif current_price <= target:
                exit_reason = "target"

        if exit_reason is None and days_held >= _TIMEOUT_DAYS:
            exit_reason = "timeout"

        if exit_reason:
            pnl = _pnl(signal, entry, current_price)
            df.loc[idx, "exit_price"]  = round(current_price, 2)
            df.loc[idx, "exit_date"]   = today_dt.isoformat()
            df.loc[idx, "exit_reason"] = exit_reason
            df.loc[idx, "pnl_pct"]     = round(pnl, 2)
            closed_this_run.append({
                "ticker":      ticker,
                "signal":      signal,
                "entry":       entry,
                "exit":        current_price,
                "exit_reason": exit_reason,
                "pnl_pct":     round(pnl, 2),
                "days_held":   days_held,
            })
            logger.info(
                f"[Tracking] Clôture {ticker} {exit_reason} "
                f"pnl={pnl:+.1f}% ({days_held}j)"
            )

    if closed_this_run:
        _save(df)

    return closed_this_run


def _pnl(signal: str, entry: float, exit_price: float) -> float:
    if entry <= 0:
        return 0.0
    if signal == "ACHAT":
        return (exit_price - entry) / entry * 100
    elif signal == "VENTE":
        return (entry - exit_price) / entry * 100
    return 0.0


# ─── Lecture ─────────────────────────────────────────────────────────────────

def get_open_trades() -> pd.DataFrame:
    """Trades encore ouverts (exit_date vide)."""
    df = _load()
    if df.empty:
        return df
    mask = df["exit_date"].isna() | (df["exit_date"] == "")
    return df[mask].copy()


def get_closed_trades() -> pd.DataFrame:
    """Trades clôturés (exit_date renseignée)."""
    df = _load()
    if df.empty:
        return df
    mask = df["exit_date"].notna() & (df["exit_date"] != "")
    return df[mask].copy()


# ─── KPIs ────────────────────────────────────────────────────────────────────

def get_kpis() -> dict:
    """
    KPIs sur les trades clôturés.

    Clés retournées :
        hit_rate_pct, avg_pnl_pct, avg_win_pct, avg_loss_pct,
        win_loss_ratio, by_reason, by_confiance
    """
    closed = get_closed_trades()
    if closed.empty:
        return {"status": "no_data", "n_closed": 0, "n_open": len(get_open_trades())}

    closed = closed.copy()
    closed["pnl_pct"] = pd.to_numeric(closed["pnl_pct"], errors="coerce")
    valid = closed.dropna(subset=["pnl_pct"])

    if valid.empty:
        return {"status": "no_data", "n_closed": len(closed), "n_open": len(get_open_trades())}

    wins  = valid[valid["pnl_pct"] > 0]
    loses = valid[valid["pnl_pct"] <= 0]

    wl_ratio = None
    if not wins.empty and not loses.empty and loses["pnl_pct"].mean() != 0:
        wl_ratio = round(abs(wins["pnl_pct"].mean() / loses["pnl_pct"].mean()), 2)

    kpis: dict = {
        "status":         "ok",
        "n_closed":       len(valid),
        "n_open":         len(get_open_trades()),
        "hit_rate_pct":   round(len(wins) / len(valid) * 100, 1),
        "avg_pnl_pct":    round(valid["pnl_pct"].mean(), 2),
        "avg_win_pct":    round(wins["pnl_pct"].mean(),  2) if not wins.empty  else None,
        "avg_loss_pct":   round(loses["pnl_pct"].mean(), 2) if not loses.empty else None,
        "win_loss_ratio": wl_ratio,
        "by_reason":      (
            valid.groupby("exit_reason")["pnl_pct"]
            .agg(n="count", avg_pnl="mean")
            .round(2)
            .to_dict(orient="index")
        ),
    }

    # Ventilation par niveau de confiance — la clé du modèle C1
    by_conf = {}
    for conf in ("forte", "modérée", "faible"):
        sub = valid[valid["confiance"] == conf]
        if not sub.empty:
            by_conf[conf] = {
                "n":            len(sub),
                "hit_rate_pct": round((sub["pnl_pct"] > 0).mean() * 100, 1),
                "avg_pnl_pct":  round(sub["pnl_pct"].mean(), 2),
            }
    if by_conf:
        kpis["by_confiance"] = by_conf

    return kpis
