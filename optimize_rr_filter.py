#!/usr/bin/env python3
"""
optimize_rr_filter.py — Test du filtre R/R naturel Donchian sur CT/MT/LT.

Probleme : compute_risk_levels() étire le TP pour forcer R/R >= 1.5 même
quand le marché ne le justifie pas. Sur la BRVM illiquide, certains setups
ont un R/R structurel < 1.5 → on entre quand même et la performance souffre.

Idée : calculer le R/R "naturel" AVANT l'étirement (= Donchian brut :
  TP_nat = highest_high(N), SL_nat = lowest_low(N))
et rejeter l'entrée si R/R_nat < seuil.

On teste 3 variantes :
  F0 : aucun filtre     (baseline)
  F1 : nat_rr >= 1.5   (recommande)
  F2 : nat_rr >= 2.0   (restrictif)

Périodes :
  IS   : 2021-2025  (in-sample complet)
  H1   : 2021-2022  (première moitié IS)
  H2   : 2023-2024  (deuxième moitié IS)
  OOS  : 2025       (out-of-sample - données réelles)

Critère de validation : F1 > F0 sur IS ET OOS (même logique que optimize_regime.py)

Usage :
  python optimize_rr_filter.py
  python optimize_rr_filter.py --horizons "Court terme"
"""

import sys
import warnings
import logging
import argparse
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))

from indicators import _fill_ohlcv_gaps, precompute_backtest_indicators
from backtest import (
    BacktestEngine, _compute_metrics,
    WARMUP_BARS, INITIAL_CAP, REVIEW_INTERVAL_DAYS, MAX_HOLDING_DAYS,
    MIN_PRICE, MAX_ATR_PCT,
)
from config import ALLOCATION_RISK_PCT, ALLOCATION_MAX_POSITION_PCT, ALLOCATION_MIN_SHARES_POLICY
from fundamentals_loader import get_loader

# ─── Périodes ────────────────────────────────────────────────────────────────

IS_START  = date(2021, 1, 1);  IS_END  = date(2025, 12, 31)
H1_START  = date(2021, 1, 1);  H1_END  = date(2022, 12, 31)
H2_START  = date(2023, 1, 1);  H2_END  = date(2024, 12, 31)
OOS_START = date(2025, 1, 1);  OOS_END = date(2025, 12, 31)

# Données chargées depuis le début de H1 - 200j de warmup
LOAD_FROM = date(2020, 1, 1)

DATA_DIR  = REPO / "data" / "daily"
BLACKLIST = {"SPHC", "LNBB"}
INDICES   = {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}

# Configs finales par horizon (issues d'optimize_strategy.py)
HORIZONS = {
    "Court terme": {
        "mh":  45, "rev": 14,
        "confiance": ["forte"],
    },
    "Moyen terme": {
        "mh":  90, "rev": 14,
        "confiance": ["forte", "modérée"],
    },
    "Long terme": {
        "mh": 180, "rev": 14,
        "confiance": ["forte", "modérée"],
    },
}

FILTRES = {
    "F0 aucun (baseline)": 0.0,
    "F1 nat_rr >= 1.5":    1.5,
    "F2 nat_rr >= 2.0":    2.0,
}


# ─── Chargement données ───────────────────────────────────────────────────────

def load_all(end: date = IS_END) -> dict[str, pd.DataFrame]:
    """Charge tous les CSV daily de LOAD_FROM à end (warmup compris)."""
    td = {}
    for f in sorted(DATA_DIR.glob("*.csv")):
        t = f.stem
        if t in BLACKLIST or t in INDICES:
            continue
        try:
            df = pd.read_csv(f, parse_dates=["date"])
        except Exception:
            continue
        df = df.sort_values("date").set_index("date")
        df = df[
            (df.index >= pd.Timestamp(LOAD_FROM))
            & (df.index <= pd.Timestamp(end))
        ]
        if len(df) < WARMUP_BARS + 10:
            continue
        df, _ = _fill_ohlcv_gaps(df)
        td[t] = df
    return td


# ─── Précompute (réutilisé entre F0/F1/F2 du même horizon) ───────────────────

def build_precomp(td: dict[str, pd.DataFrame], horizon: str) -> dict:
    pc = {}
    for t, df in td.items():
        try:
            pc[t] = precompute_backtest_indicators(
                df, ticker=t, df_index=None,
                horizon=horizon, warmup_bars=WARMUP_BARS,
            )
        except Exception:
            pass
    return pc


def enrich_fund(pc: dict, fund) -> None:
    """Injecte les données fondamentales dans le précompute (in-place)."""
    if not fund.is_available():
        return
    for ticker, date_map in pc.items():
        for ts, ind in date_map.items():
            rd = ts.date() if hasattr(ts, "date") else ts
            cours = ind.cours_actuel if ind.cours_actuel and ind.cours_actuel > 0 else 0
            if cours > 0:
                dy, per, annee = fund.get_signals(ticker, rd, cours)
                ind.fund_div_yield   = dy
                ind.fund_per_implied = per
                ind.fund_annee       = annee


# ─── Exécution d'un run ───────────────────────────────────────────────────────

def run_period(
    td: dict[str, pd.DataFrame],
    pc: dict,
    horizon: str,
    hparams: dict,
    start: date,
    end: date,
    min_rr: float,
) -> dict:
    """
    Exécute BacktestEngine sur [start, end] avec min_rr.
    td doit déjà être filtré sur l'end correct.
    Retourne un dict de métriques.
    """
    try:
        result = BacktestEngine(
            initial_capital      = INITIAL_CAP,
            horizon              = horizon,
            warmup_bars          = WARMUP_BARS,
            review_interval_days = hparams["rev"],
            max_holding_days     = hparams["mh"],
            max_atr_pct          = MAX_ATR_PCT,
            min_atr_pct          = 2.0,
            min_price            = MIN_PRICE,
            confiance_filter     = hparams["confiance"],
            fee_entry_pct        = 0.0065,
            fee_exit_pct         = 0.0065,
            regime_filter        = False,   # on teste le filtre R/R indépendamment
            risk_pct             = ALLOCATION_RISK_PCT,
            max_position_pct     = ALLOCATION_MAX_POSITION_PCT,
            min_shares_policy    = ALLOCATION_MIN_SHARES_POLICY,
            start_date           = start,
            min_rr               = min_rr,
        ).run(td, _precomp_cache=pc)
    except Exception as exc:
        return {"error": str(exc), "n_trades": 0, "sharpe": -999.0}

    s = result.summary
    if s.get("status") != "ok" or s.get("n_trades", 0) == 0:
        return {"n_trades": 0, "sharpe": -999.0, "win_rate": 0.0,
                "total_return": 0.0, "years_pos": 0, "avg_rr": None, "by_year": {}}

    # Sharpe depuis courbe d'équité
    if len(result.equity_curve) >= 2:
        eq = result.equity_curve.set_index("date")["equity"]
        metrics = _compute_metrics(eq)
        sharpe = metrics.get("sharpe", 0.0)
        total_ret = metrics.get("total_return", 0.0) * 100
    else:
        sharpe = s.get("sharpe", 0.0) or 0.0
        total_ret = s.get("total_return_pct", 0.0) or 0.0

    n = s.get("n_trades", 0)
    wr = s.get("win_rate_pct", 0.0) or 0.0
    avg_rr = s.get("avg_r_realise")

    # Années positives depuis by_year
    by_year = result.by_year or {}
    yrs_pos = sum(
        1 for v in by_year.values()
        if v.get("return_pct") is not None and v["return_pct"] > 0
    )
    n_years = sum(
        1 for v in by_year.values()
        if v.get("return_pct") is not None
    )

    # Résumé par année (return %)
    yr_summary = {
        y: round(v["return_pct"], 0)
        for y, v in sorted(by_year.items())
        if v.get("return_pct") is not None
    }

    return {
        "n_trades":    n,
        "sharpe":      round(sharpe, 3),
        "win_rate":    round(wr, 1),
        "total_return": round(total_ret, 1),
        "years_pos":   yrs_pos,
        "n_years":     n_years,
        "avg_rr":      round(avg_rr, 2) if avg_rr else None,
        "by_year":     yr_summary,
    }


# ─── Main ────────────────────────────────────────────────────────────────────

def main(horizons_filter: list[str] | None = None):
    SEP = "=" * 82

    print("Chargement fondamentaux...", flush=True)
    fund = get_loader()

    print(f"Chargement OHLCV (data/daily/, warmup depuis {LOAD_FROM})...", flush=True)
    td_full = load_all(IS_END)
    print(f"  {len(td_full)} tickers charges.", flush=True)

    # Sous-ensembles filtrés
    td_h1 = {
        t: df[df.index <= pd.Timestamp(H1_END)].copy()
        for t, df in td_full.items()
        if len(df[df.index <= pd.Timestamp(H1_END)]) >= WARMUP_BARS + 10
    }
    td_h2 = {
        t: df[df.index <= pd.Timestamp(H2_END)].copy()
        for t, df in td_full.items()
        if len(df[df.index <= pd.Timestamp(H2_END)]) >= WARMUP_BARS + 10
    }
    td_oos = td_full   # start_date=2025-01-01 filtrera le début

    print(); print(SEP)
    print("  FILTRE R/R NATUREL DONCHIAN — impact sur config finale (5 ans 2021-2025)")
    print(SEP)

    verdict_lines = []

    for horizon, hparams in HORIZONS.items():
        if horizons_filter and horizon not in horizons_filter:
            continue

        print(f"\n  Precompute {horizon}...", flush=True)
        pc_full = build_precomp(td_full, horizon)
        pc_h1   = build_precomp(td_h1,   horizon)
        pc_h2   = build_precomp(td_h2,   horizon)

        enrich_fund(pc_full, fund)
        enrich_fund(pc_h1,   fund)
        enrich_fund(pc_h2,   fund)

        print(f"\n  >>> {horizon}  (confiance={hparams['confiance']}, "
              f"hold={hparams['mh']}j, rev={hparams['rev']}j)", flush=True)

        hdr = (f"  {'Filtre':<24} {'SH_IS':>7} {'SH_H1':>7} {'SH_H2':>7} "
               f"{'SH_OOS':>7} {'T':>4} {'WR%':>6} {'Yrs+':>6} {'avgRR':>6} {'Ret%':>7}")
        print(hdr)
        print("  " + "-" * 80)

        results_per_filter = {}

        for fname, min_rr in FILTRES.items():
            m_is  = run_period(td_full, pc_full, horizon, hparams, IS_START,  IS_END,  min_rr)
            m_h1  = run_period(td_h1,  pc_h1,   horizon, hparams, H1_START,  H1_END,  min_rr)
            m_h2  = run_period(td_h2,  pc_h2,   horizon, hparams, H2_START,  H2_END,  min_rr)
            m_oos = run_period(td_oos, pc_full,  horizon, hparams, OOS_START, OOS_END, min_rr)

            results_per_filter[fname] = {
                "IS": m_is, "H1": m_h1, "H2": m_h2, "OOS": m_oos
            }

            n_yrs    = m_is.get("n_years", 5)
            yr_label = f"{m_is['years_pos']}/{n_yrs}"
            avg_rr   = m_is.get("avg_rr")
            rr_str   = f"{avg_rr:+.2f}" if avg_rr is not None else "  N/A"
            tag      = " <-- actuel" if min_rr == 0.0 else ""

            print(
                f"  {fname:<24} "
                f"{m_is['sharpe']:+7.3f} {m_h1['sharpe']:+7.3f} "
                f"{m_h2['sharpe']:+7.3f} {m_oos['sharpe']:+7.3f} "
                f"{m_is['n_trades']:>4} {m_is['win_rate']:>6.1f} "
                f"{yr_label:>6} {rr_str:>6} "
                f"{m_is['total_return']:>+7.1f}%{tag}"
            )

            if m_is.get("by_year"):
                yr = "  ".join(
                    f"{y}={'+' if v >= 0 else ''}{v:.0f}%"
                    for y, v in sorted(m_is["by_year"].items())
                )
                print(f"    {yr}")

        # Verdict pour cet horizon
        f0 = results_per_filter.get("F0 aucun (baseline)", {})
        f1 = results_per_filter.get("F1 nat_rr >= 1.5", {})
        sh_f0_is  = f0.get("IS",  {}).get("sharpe", -999)
        sh_f1_is  = f1.get("IS",  {}).get("sharpe", -999)
        sh_f0_oos = f0.get("OOS", {}).get("sharpe", -999)
        sh_f1_oos = f1.get("OOS", {}).get("sharpe", -999)

        if sh_f1_is > sh_f0_is and sh_f1_oos > sh_f0_oos:
            v = f"  {horizon}: F1 VALIDE (SH_IS {sh_f1_is:+.3f} vs {sh_f0_is:+.3f} | SH_OOS {sh_f1_oos:+.3f} vs {sh_f0_oos:+.3f}) -> APPLIQUER min_rr=1.5"
        elif sh_f1_is > sh_f0_is:
            v = f"  {horizon}: F1 partiel (IS ok, OOS KO {sh_f1_oos:+.3f} vs {sh_f0_oos:+.3f}) -> prudence"
        else:
            v = f"  {horizon}: F1 KO (IS {sh_f1_is:+.3f} vs {sh_f0_is:+.3f}) -> garder F0"
        verdict_lines.append(v)

    print(); print(SEP)
    print("  VERDICT")
    print(SEP)
    print("  Critere : F1 > F0 sur IS ET OOS (Sharpe) -> filtre applicable")
    print()
    for line in verdict_lines:
        print(line)
    print()
    print("  Si F1 valide sur >=2 horizons :")
    print("    -> BacktestEngine(min_rr=1.5) est la config live recommandee")
    print("    -> Afficher 'R/R naturel: X.X' dans app.py fiche setup")
    print(SEP)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--horizons",
        nargs="+",
        choices=["Court terme", "Moyen terme", "Long terme"],
        default=None,
        help="Restreindre aux horizons indiques (ex: --horizons 'Court terme' 'Moyen terme')",
    )
    args = parser.parse_args()
    main(horizons_filter=args.horizons)
