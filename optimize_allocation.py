"""
optimize_allocation.py - Recherche de la politique d'allocation optimale BRVM.

Probleme : sur la BRVM on ne peut acheter que des actions entieres.
Pour un capital C et un prix P, l'allocation reelle = floor(C*f/P) * P
ce qui introduit une perte par arrondi pouvant atteindre P/(C*f).

Ce script fait une grid search sur (risk_pct, max_position_pct, min_shares_policy)
en executant le backtest complet pour chaque combinaison sur les donnees cachees.

Metriques de classement :
  1. Expectancy ponderee (E x taille moy de position / 100)
  2. Total return
  3. Sharpe approche (return / drawdown)

Usage :
  python optimize_allocation.py
  python optimize_allocation.py --capital 5000000 --tickers SNTS ORAC SGBC
"""

import argparse
import itertools
import logging
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

from backtest import ALL_TICKERS, INITIAL_CAP, fetch_and_backtest
from config import CAPITAL_DEFAUT
from scraper import get_ohlcv

logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")

# ---------------------------------------------------------------------------
# Grille de parametres
# ---------------------------------------------------------------------------

GRID = {
    "risk_pct":          [0.5, 1.0, 1.5, 2.0, 2.5, 3.0],
    "max_position_pct":  [10.0, 15.0, 20.0, 25.0],
    "min_shares_policy": [False, True],
}

METRICS_HEADER = [
    "risk_pct", "max_pct", "min_shares",
    "n_trades", "n_skipped_0shares",
    "win_rate", "expectancy", "exp_weighted",
    "total_return", "gain_fcfa",
    "avg_holding", "avg_pos_pct",
    "sharpe_approx",
]


# ---------------------------------------------------------------------------
# Fetch des donnees (une seule fois, partagees entre tous les runs)
# ---------------------------------------------------------------------------

def fetch_universe(tickers: list[str], days: int = 730) -> dict:
    """Fetche OHLCV pour tous les tickers. Utilise le cache si disponible."""
    print(f"[Optim] Fetch de {len(tickers)} tickers ({days}j)...")
    data = {}
    for i, ticker in enumerate(tickers, 1):
        try:
            df = get_ohlcv(ticker, days=days)
            if df is not None and not df.empty:
                data[ticker] = df
        except Exception as exc:
            logging.debug("[Optim] %s fetch KO: %s", ticker, exc)
        if i % 10 == 0:
            print(f"  {i}/{len(tickers)} tickers charges")
    print(f"[Optim] {len(data)} tickers charges avec succes.")
    return data


# ---------------------------------------------------------------------------
# Run unique
# ---------------------------------------------------------------------------

def run_one(
    ticker_data: dict,
    capital: float,
    risk_pct: float,
    max_position_pct: float,
    min_shares_policy: bool,
) -> dict:
    """Execute un backtest et retourne les metriques cles."""
    try:
        result = fetch_and_backtest(
            tickers=list(ticker_data.keys()),
            initial_capital=capital,
            risk_pct=risk_pct,
            max_position_pct=max_position_pct,
            min_shares_policy=min_shares_policy,
            ticker_data_override=ticker_data,
        )
        s = result.summary

        if s.get("status") == "no_trades":
            return {
                "risk_pct": risk_pct, "max_pct": max_position_pct,
                "min_shares": min_shares_policy,
                "n_trades": 0, "n_skipped_0shares": None,
                "win_rate": None, "expectancy": None, "exp_weighted": None,
                "total_return": None, "gain_fcfa": None,
                "avg_holding": None, "avg_pos_pct": None,
                "sharpe_approx": None,
            }

        # Compter les trades sautes par manque de capital (0 actions)
        trades_df = result.trades
        n_skipped = int((trades_df["nb_actions"] == 0).sum()) if "nb_actions" in trades_df.columns else None

        total_return = s.get("total_return_pct", 0.0)
        gain_fcfa    = s.get("gain_net_fcfa", 0.0)
        exp          = s.get("expectancy_pct", 0.0)
        exp_w        = s.get("expectancy_weighted_pct") or 0.0
        avg_hold     = s.get("avg_holding_days")
        avg_pos      = s.get("avg_position_pct")
        win_rate     = s.get("win_rate_pct")

        # Sharpe approche : return / max_drawdown (si dispo)
        max_dd = abs(s.get("max_drawdown_pct", -1.0) or -1.0)
        sharpe = round(total_return / max_dd, 2) if max_dd > 0 else None

        return {
            "risk_pct":          risk_pct,
            "max_pct":           max_position_pct,
            "min_shares":        min_shares_policy,
            "n_trades":          s.get("n_trades", 0),
            "n_skipped_0shares": n_skipped,
            "win_rate":          win_rate,
            "expectancy":        exp,
            "exp_weighted":      exp_w,
            "total_return":      total_return,
            "gain_fcfa":         gain_fcfa,
            "avg_holding":       avg_hold,
            "avg_pos_pct":       avg_pos,
            "sharpe_approx":     sharpe,
        }
    except Exception as exc:
        logging.warning("[Optim] run KO risk=%.1f max=%.0f: %s", risk_pct, max_position_pct, exc)
        return {k: None for k in METRICS_HEADER}


# ---------------------------------------------------------------------------
# Grid search
# ---------------------------------------------------------------------------

def grid_search(
    ticker_data: dict,
    capital: float,
    grid: dict = GRID,
) -> pd.DataFrame:
    combos = list(itertools.product(
        grid["risk_pct"],
        grid["max_position_pct"],
        grid["min_shares_policy"],
    ))
    n = len(combos)
    print(f"\n[Optim] {n} combinaisons a tester sur {len(ticker_data)} tickers / capital={capital:,.0f} FCFA\n")

    rows = []
    for i, (risk_pct, max_pct, min_shares) in enumerate(combos, 1):
        t0 = time.time()
        row = run_one(ticker_data, capital, risk_pct, max_pct, min_shares)
        elapsed = time.time() - t0
        status = (
            f"return={row['total_return']:+.1f}%  exp={row['expectancy']:+.2f}%  "
            f"trades={row['n_trades']}"
            if row["total_return"] is not None else "no_trades"
        )
        print(
            f"  [{i:02d}/{n}] risk={risk_pct:.1f}% max={max_pct:.0f}% "
            f"min1={min_shares!s:<5} | {status}  ({elapsed:.1f}s)"
        )
        rows.append(row)

    df = pd.DataFrame(rows)
    return df


# ---------------------------------------------------------------------------
# Rapport
# ---------------------------------------------------------------------------

def print_report(df: pd.DataFrame, top_n: int = 10) -> None:
    valid = df.dropna(subset=["expectancy", "total_return", "n_trades"])
    valid = valid[valid["n_trades"] >= 5]   # ignore les configs avec trop peu de trades

    if valid.empty:
        print("[Optim] Aucune combinaison valide (< 5 trades).")
        return

    # Score composite : expectancy ponderee * 0.5 + return * 0.3 + sharpe * 0.2
    def _norm(col):
        r = valid[col]
        if r.max() == r.min():
            return pd.Series(0.5, index=r.index)
        return (r - r.min()) / (r.max() - r.min())

    valid = valid.copy()
    valid["score"] = (
        _norm("exp_weighted") * 0.50
        + _norm("total_return") * 0.30
        + _norm("sharpe_approx").fillna(0) * 0.20
    )
    valid = valid.sort_values("score", ascending=False)

    print("\n" + "=" * 80)
    print(f"TOP {top_n} POLITIQUES D'ALLOCATION (sur {len(valid)} combinaisons valides)")
    print("=" * 80)

    cols_display = [
        "risk_pct", "max_pct", "min_shares",
        "n_trades", "win_rate", "expectancy", "exp_weighted",
        "total_return", "avg_pos_pct", "sharpe_approx", "score",
    ]
    pd.set_option("display.float_format", "{:.2f}".format)
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 120)
    print(valid[cols_display].head(top_n).to_string(index=False))

    best = valid.iloc[0]
    print("\n" + "=" * 80)
    print("POLITIQUE OPTIMALE RECOMMANDEE :")
    print(f"  risk_pct          = {best['risk_pct']:.1f}%")
    print(f"  max_position_pct  = {best['max_pct']:.0f}%")
    print(f"  min_shares_policy = {best['min_shares']}")
    print(f"  -> Expectancy ponderee : {best['exp_weighted']:+.3f}%")
    print(f"  -> Total return        : {best['total_return']:+.1f}%")
    print(f"  -> Trades generes      : {best['n_trades']:.0f}")
    print(f"  -> Win rate            : {best['win_rate']:.1f}%")
    print(f"  -> Taille moy position : {best['avg_pos_pct']:.1f}%")
    print("=" * 80)

    return best


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Optimisation de la politique d'allocation BRVM")
    parser.add_argument("--capital",  type=float, default=float(CAPITAL_DEFAUT),
                        help="Capital en FCFA (defaut config.CAPITAL_DEFAUT)")
    parser.add_argument("--tickers",  nargs="*", default=None,
                        help="Sous-ensemble de tickers (defaut : ALL_TICKERS)")
    parser.add_argument("--days",     type=int,   default=730,
                        help="Fenetre de donnees en jours (defaut : 730)")
    parser.add_argument("--top",      type=int,   default=10,
                        help="Nombre de resultats affichés (defaut : 10)")
    parser.add_argument("--out",      type=str,   default="allocation_optim.csv",
                        help="Fichier CSV de sortie (defaut : allocation_optim.csv)")
    args = parser.parse_args()

    tickers = args.tickers or ALL_TICKERS
    capital = args.capital

    print(f"[Optim] Capital : {capital:,.0f} FCFA | Tickers : {len(tickers)} | Fenetre : {args.days}j")

    # Fetch une seule fois
    ticker_data = fetch_universe(tickers, days=args.days)

    if len(ticker_data) < 3:
        print("[Optim] Trop peu de donnees disponibles. Verifiez la connexion.")
        sys.exit(1)

    # Grid search
    df_results = grid_search(ticker_data, capital)

    # Sauvegarde CSV
    df_results.to_csv(args.out, index=False)
    print(f"\n[Optim] Resultats sauvegardes dans {args.out}")

    # Rapport
    print_report(df_results, top_n=args.top)
