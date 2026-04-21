"""
batch_brvm_test.py — Validation empirique sur 12 tickers BRVM réels.

Couvre : large caps, mid caps, small caps illiquides.
Métriques : score, signal, confiance, R/R, sizing, data_quality_flag.

Usage : python -X utf8 batch_brvm_test.py
"""

import sys
import time
import logging
logging.basicConfig(level=logging.WARNING)   # silence scraper logs

from scraper import get_ohlcv, TickerNotFoundError, InsufficientDataError
from indicators import compute_indicators
from scoring import compute_score
from analysis import compute_risk_levels, compute_position_size

# ─── Panel BRVM (large → mid → small) ────────────────────────────────────────

TICKERS = [
    # Large caps liquides
    "SNTS",    # Sonatel (Orange Sénégal)
    "ETIT",    # Ecobank Transnational
    "BICC",    # BICI Côte d'Ivoire
    "SGBC",    # Société Générale CI
    "BOAC",    # Bank of Africa CI
    # Mid caps
    "PALC",    # Palm CI
    "SIVC",    # SIV CI
    "ONTBF",   # Orange Burkina
    "CIEC",    # CIE CI
    # Small caps / illiquides
    "CFAC",    # Compagnie Forestière et Agricole
    "NEIC",    # NEI-CEDA
    "UNLC",    # Union des Lacs CI
]

DAYS = 365


# ─── Seuil R/R ───────────────────────────────────────────────────────────────

RR_MIN = 1.5   # en dessous = signal à éliminer


# ─── Runner ──────────────────────────────────────────────────────────────────

def run_ticker(ticker: str) -> dict:
    try:
        df = get_ohlcv(ticker, days=DAYS)
        ind = compute_indicators(df, ticker=ticker)
        score = compute_score(ind)
        score.stop_loss, score.take_profit = compute_risk_levels(score, ind)
        score.position_size_pct = compute_position_size(score, ind)

        rr = None
        if (score.stop_loss is not None and score.take_profit is not None
                and ind.atr and ind.atr > 0):
            k1 = abs(score.stop_loss  - ind.cours_actuel) / ind.atr
            k2 = abs(score.take_profit - ind.cours_actuel) / ind.atr
            rr = round(k2 / k1, 2) if k1 > 0 else None

        return {
            "ticker":       ticker,
            "status":       "OK",
            "prix":         ind.cours_actuel,
            "score":        score.score_total,
            "signal":       score.signal,
            "confiance":    score.confiance,
            "atr_pct":      ind.atr_pct,
            "rsi":          ind.rsi,
            "adx":          ind.adx,
            "vol_moy20":    ind.volume_moy20,
            "data_quality": ind.data_quality_flag,
            "stop":         score.stop_loss,
            "target":       score.take_profit,
            "rr":           rr,
            "sizing_pct":   score.position_size_pct,
            "n_rows":       len(df),
        }
    except (TickerNotFoundError, InsufficientDataError) as e:
        return {"ticker": ticker, "status": "ERR", "error": str(e)[:80]}
    except Exception as e:
        return {"ticker": ticker, "status": "ERR", "error": f"{type(e).__name__}: {str(e)[:60]}"}


# ─── Affichage ────────────────────────────────────────────────────────────────

def print_row(r: dict):
    if r["status"] == "ERR":
        print(f"  {r['ticker']:<10} ERREUR : {r.get('error','?')}")
        return

    signal_icon = {"ACHAT": "+", "VENTE": "-", "NEUTRE": "~"}.get(r["signal"], "?")
    rr_str = f"{r['rr']:.2f}" if r["rr"] else "  —  "
    rr_flag = "" if r["rr"] is None else (" !" if r["rr"] < RR_MIN else "")
    sz_str = f"{r['sizing_pct']:.1f}%" if r["sizing_pct"] else " — "
    dq = r["data_quality"]
    dq_flag = " [GAP]" if dq == "gaps" else " [SPARSE]" if dq == "sparse" else ""
    atr = f"{r['atr_pct']:.2f}%" if r["atr_pct"] else " N/A"
    rsi = f"{r['rsi']:.0f}" if r["rsi"] else "N/A"
    adx = f"{r['adx']:.0f}" if r["adx"] else "N/A"

    print(
        f"  {r['ticker']:<10} {signal_icon} {r['signal']:<6} "
        f"score={r['score']:+d}  conf={r['confiance']:<8} "
        f"ATR={atr}  RSI={rsi:<5} ADX={adx:<5} "
        f"R/R={rr_str}{rr_flag}  sz={sz_str}{dq_flag}"
    )


def print_summary(results: list[dict]):
    ok = [r for r in results if r["status"] == "OK"]
    if not ok:
        return

    achats  = [r for r in ok if r["signal"] == "ACHAT"]
    ventes  = [r for r in ok if r["signal"] == "VENTE"]
    neutres = [r for r in ok if r["signal"] == "NEUTRE"]
    rr_vals = [r["rr"] for r in ok if r["rr"] is not None]
    rr_ok   = [v for v in rr_vals if v >= RR_MIN]
    sparse  = [r for r in ok if r["data_quality"] in ("sparse", "gaps")]

    print(f"\n  Distribution : ACHAT={len(achats)}  VENTE={len(ventes)}  NEUTRE={len(neutres)} / {len(ok)}")
    if rr_vals:
        print(f"  R/R moyen    : {sum(rr_vals)/len(rr_vals):.2f}  "
              f"| >= {RR_MIN}: {len(rr_ok)}/{len(rr_vals)}")
    if sparse:
        print(f"  Data quality : {len(sparse)} ticker(s) avec gaps/sparse")

    # Alertes R/R faible sur signaux actifs
    rr_faible = [r for r in ok if r["signal"] != "NEUTRE" and r["rr"] is not None and r["rr"] < RR_MIN]
    if rr_faible:
        tks = ", ".join(r["ticker"] for r in rr_faible)
        print(f"  ! R/R < {RR_MIN} sur signaux actifs : {tks}")


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("\nBATCH TEST BRVM — modele Phase 2 + D1/D2")
    print("=" * 78)
    print(f"  {'Ticker':<10} {'':2} {'Signal':<6}  {'Score':>5}  {'Conf':<8}  "
          f"{'ATR':>6}  {'RSI':<5} {'ADX':<5} {'R/R':<6}  {'Sizing'}")
    print("-" * 78)

    results = []
    for ticker in TICKERS:
        r = run_ticker(ticker)
        results.append(r)
        print_row(r)
        time.sleep(1.5)   # respecter le rate limit Sika Finance

    print("=" * 78)
    print_summary(results)
    print()
