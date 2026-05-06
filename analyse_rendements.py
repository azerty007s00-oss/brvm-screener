"""
analyse_rendements.py - Analyse des déterminants de performance.
Cherche les patterns qui distinguent les trades gagnants des perdants.
"""
import logging
import sys
import warnings
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

import pandas as pd
import numpy as np
from backtest import (BacktestEngine, ALL_TICKERS, INITIAL_CAP, WARMUP_BARS,
    REVIEW_INTERVAL_DAYS, MAX_HOLDING_DAYS, MAX_ATR_PCT, MIN_PRICE)
from config import DEFAULT_HORIZON
from scraper import get_ohlcv

# ── Fetch ──────────────────────────────────────────────────────────────────
print("Chargement donnees...")
data = {}
for t in ALL_TICKERS:
    try:
        data[t] = get_ohlcv(t, days=730)
    except:
        pass
print(f"  {len(data)} tickers\n")

engine = BacktestEngine(
    initial_capital=INITIAL_CAP, horizon=DEFAULT_HORIZON,
    warmup_bars=WARMUP_BARS, review_interval_days=REVIEW_INTERVAL_DAYS,
    max_holding_days=MAX_HOLDING_DAYS, max_atr_pct=MAX_ATR_PCT,
    min_price=MIN_PRICE, fee_pct=0.0,
)
result = engine.run(data)
df = result.trades.copy()

if df.empty:
    print("Aucun trade.")
    sys.exit()

df["win"] = df["pnl_pct"] > 0
df["entry_date"] = pd.to_datetime(df["entry_date"])
df["mois_entree"] = df["entry_date"].dt.month
df["trimestre"] = df["entry_date"].dt.quarter

SEP = "-" * 55

def tbl(label, grp, sort_col="exp_pct", n=None):
    print(f"\n{SEP}")
    print(f"  {label}")
    print(f"{SEP}")
    grp = grp.copy()
    if n:
        grp = grp.head(n)
    cols = list(grp.columns)
    header = "  " + "  ".join(f"{c:>14}" for c in cols)
    print(header)
    print("  " + "-" * (len(header) - 2))
    for _, row in grp.iterrows():
        line = "  "
        for c in cols:
            v = row[c]
            if isinstance(v, float):
                line += f"{v:>+13.2f}  " if "pct" in c or "exp" in c or "pnl" in c else f"{v:>13.1f}  "
            elif isinstance(v, (int, np.integer)):
                line += f"{v:>13d}  "
            else:
                line += f"{str(v):>13}  "
        print(line)

# ── 1. Vue globale ──────────────────────────────────────────────────────────
valid = df.dropna(subset=["pnl_pct"])
wins  = valid[valid["win"]]
loses = valid[~valid["win"]]
wr    = len(wins)/len(valid)
exp   = wr * wins["pnl_pct"].mean() + (1-wr) * loses["pnl_pct"].mean()

print(f"\n{'='*55}")
print(f"  VUE GLOBALE - {len(valid)} trades")
print(f"{'='*55}")
print(f"  Win rate        : {wr*100:.1f}%")
print(f"  Expectancy      : {exp:+.2f}%")
print(f"  PnL moyen W     : {wins['pnl_pct'].mean():+.2f}%")
print(f"  PnL moyen L     : {loses['pnl_pct'].mean():+.2f}%")
print(f"  Duree moy W     : {wins['holding_days'].mean():.0f}j")
print(f"  Duree moy L     : {loses['holding_days'].mean():.0f}j")
print(f"  ATR% moy entree : {valid['atr_pct'].mean():.2f}%")

# ── 2. Par confiance ────────────────────────────────────────────────────────
def stats_grp(g):
    w = g[g["win"]]; l = g[~g["win"]]
    wr_ = len(w)/len(g) if len(g) else 0
    exp_ = wr_*w["pnl_pct"].mean()+(1-wr_)*l["pnl_pct"].mean() if len(g) else 0
    return pd.Series({
        "n": len(g), "win_pct": round(wr_*100,1),
        "exp_pct": round(exp_,2),
        "avg_pnl": round(g["pnl_pct"].mean(),2),
        "avg_days": round(g["holding_days"].mean(),1),
    })

grp_conf = valid.groupby("confiance").apply(stats_grp).reset_index()
tbl("PAR CONFIANCE", grp_conf.sort_values("exp_pct", ascending=False))

# ── 3. Par score ────────────────────────────────────────────────────────────
valid["score_bucket"] = pd.cut(valid["score"], bins=[-20,-5,-2,0,2,5,20],
    labels=["<=-5","[-5,-2]","[-2,0]","[0,2]","[2,5]",">=5"])
grp_score = valid.groupby("score_bucket", observed=True).apply(stats_grp).reset_index()
tbl("PAR SCORE A L'ENTREE", grp_score.sort_values("exp_pct", ascending=False))

# ── 4. Par ATR% à l'entrée ──────────────────────────────────────────────────
valid2 = valid.dropna(subset=["atr_pct"])
valid2["atr_bucket"] = pd.cut(valid2["atr_pct"], bins=[0,1,1.5,2,2.5,3,10],
    labels=["<1%","1-1.5%","1.5-2%","2-2.5%","2.5-3%",">3%"])
grp_atr = valid2.groupby("atr_bucket", observed=True).apply(stats_grp).reset_index()
tbl("PAR ATR% A L'ENTREE (volatilite)", grp_atr.sort_values("exp_pct", ascending=False))

# ── 5. Par mois d'entrée ────────────────────────────────────────────────────
MOIS = {1:"Jan",2:"Fev",3:"Mar",4:"Avr",5:"Mai",6:"Jun",
        7:"Jul",8:"Aou",9:"Sep",10:"Oct",11:"Nov",12:"Dec"}
valid["mois_label"] = valid["mois_entree"].map(MOIS)
grp_mois = valid.groupby("mois_entree").apply(stats_grp).reset_index()
grp_mois["mois"] = grp_mois["mois_entree"].map(MOIS)
grp_mois = grp_mois.drop("mois_entree", axis=1)
tbl("PAR MOIS D'ENTREE (saisonnalite)", grp_mois.sort_values("exp_pct", ascending=False))

# ── 6. Par ticker (top/flop) ────────────────────────────────────────────────
grp_ticker = valid.groupby("ticker").apply(stats_grp).reset_index()
print(f"\n{SEP}")
print(f"  TOP 10 TICKERS (expectancy)")
print(f"{SEP}")
top = grp_ticker[grp_ticker["n"] >= 3].sort_values("exp_pct", ascending=False).head(10)
for _, r in top.iterrows():
    print(f"  {r['ticker']:<8}  n={r['n']:>3}  wr={r['win_pct']:>5.1f}%  exp={r['exp_pct']:>+6.2f}%  {r['avg_days']:.0f}j")
print(f"\n  FLOP 10 TICKERS")
flop = grp_ticker[grp_ticker["n"] >= 3].sort_values("exp_pct").head(10)
for _, r in flop.iterrows():
    print(f"  {r['ticker']:<8}  n={r['n']:>3}  wr={r['win_pct']:>5.1f}%  exp={r['exp_pct']:>+6.2f}%  {r['avg_days']:.0f}j")

# ── 7. Par raison de sortie ────────────────────────────────────────────────
grp_exit = valid.groupby("exit_reason").apply(stats_grp).reset_index()
tbl("PAR RAISON DE SORTIE", grp_exit.sort_values("exp_pct", ascending=False))

# ── 8. Par durée de détention ───────────────────────────────────────────────
valid["days_bucket"] = pd.cut(valid["holding_days"], bins=[0,3,7,14,30,90],
    labels=["1-3j","4-7j","8-14j","15-30j",">30j"])
grp_days = valid.groupby("days_bucket", observed=True).apply(stats_grp).reset_index()
tbl("PAR DUREE DE DETENTION", grp_days.sort_values("exp_pct", ascending=False))

# ── 9. Corrélations clés ────────────────────────────────────────────────────
print(f"\n{SEP}")
print(f"  CORRELATIONS avec PnL%")
print(f"{SEP}")
for col in ["score", "atr_pct", "position_pct", "rr", "holding_days"]:
    if col in valid.columns:
        corr = valid[["pnl_pct", col]].dropna().corr().iloc[0,1]
        print(f"  {col:<20} r = {corr:+.3f}")

# ── 10. Seuil de score optimal ───────────────────────────────────────────────
print(f"\n{SEP}")
print(f"  SEUIL DE SCORE OPTIMAL (win rate et expectancy)")
print(f"{SEP}")
print(f"  {'score_min':>10}  {'n':>5}  {'wr':>7}  {'exp':>8}  {'return_sim':>11}")
for seuil in range(2, 9):
    sub = valid[valid["score"] >= seuil]
    if len(sub) < 5:
        break
    w_ = sub[sub["win"]]; l_ = sub[~sub["win"]]
    wr_ = len(w_)/len(sub)
    exp_ = wr_*w_["pnl_pct"].mean()+(1-wr_)*l_["pnl_pct"].mean()
    ret_sim = sub["capital_gain_pct"].sum() if "capital_gain_pct" in sub else 0
    print(f"  score >= {seuil:>2}    {len(sub):>5}  {wr_*100:>6.1f}%  {exp_:>+7.2f}%  {ret_sim:>+10.1f}%")

print(f"\n{'='*55}")
print("  FIN ANALYSE")
print(f"{'='*55}")
