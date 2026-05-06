"""
analyse_signal_mensuel.py - Validité du signal sur 5 ans de données mensuelles.

Source : SikaFinance API xperiod=30 → 60 mois OHLCV (mai 2021 - avr 2026)
Objectif : vérifier si le signal ACHAT prédit positivement le mois suivant,
sur un horizon 5 fois plus long que l'analyse journalière.

Note : les données mensuelles ne peuvent pas tester les stops intraday ni
la durée de détention. Elles testent la qualité directionnelle du scoring.
"""
import logging
import warnings
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import time

from config import TICKER_TO_SIKA_ID, COUNTRY_SUFFIXES
from indicators import compute_indicators
from scoring import compute_score
from backtest import ALL_TICKERS

# ── Fetch données mensuelles ───────────────────────────────────────────────────

def fetch_monthly(ticker: str) -> pd.DataFrame | None:
    """Récupère 60 mois OHLCV via SikaFinance API (xperiod=30)."""
    # Résolution sika_id
    sika_id = TICKER_TO_SIKA_ID.get(ticker)
    if not sika_id:
        sika_id = f"{ticker}.ci"  # défaut Côte d'Ivoire

    today = datetime.now()
    payload = {
        "ticker": sika_id,
        "datedeb": (today - timedelta(days=365 * 10)).strftime("%Y-%m-%d"),
        "datefin": today.strftime("%Y-%m-%d"),
        "xperiod": "30",
    }
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": "https://www.sikafinance.com",
        "Referer": f"https://www.sikafinance.com/marches/historiques/{sika_id}",
    }
    try:
        time.sleep(0.3)
        r = requests.post("https://www.sikafinance.com/api/general/GetHistos",
                          json=payload, headers=headers, timeout=15)
        if r.status_code != 200:
            return None
        lst = r.json().get("lst", [])
        if not lst:
            return None

        rows = []
        for row in lst:
            try:
                d = datetime.strptime(str(row["Date"]), "%d/%m/%Y")
                rows.append({
                    "date":   d,
                    "open":   float(row.get("Open",  row["Close"])),
                    "high":   float(row.get("High",  row["Close"])),
                    "low":    float(row.get("Low",   row["Close"])),
                    "close":  float(row["Close"]),
                    "volume": float(row.get("Volume", 0)),
                })
            except (KeyError, ValueError):
                continue

        if not rows:
            return None
        df = pd.DataFrame(rows).sort_values("date")
        df = df.drop_duplicates("date").set_index("date")
        df.index = pd.to_datetime(df.index)
        return df[["open", "high", "low", "close", "volume"]]

    except Exception:
        return None


# ── Fetch toutes les données ───────────────────────────────────────────────────

print("Chargement donnees mensuelles (60 mois par ticker)...")
monthly_data = {}
for t in ALL_TICKERS:
    df = fetch_monthly(t)
    if df is not None and len(df) >= 12:
        monthly_data[t] = df
    else:
        # Tenter suffixes alternatifs
        for sfx in [".bj", ".sn", ".bf", ".ml", ".tg", ".gn", ".ci"]:
            sika_id_alt = f"{t}{sfx}"
            try:
                today = datetime.now()
                payload = {
                    "ticker": sika_id_alt,
                    "datedeb": (today - timedelta(days=365 * 10)).strftime("%Y-%m-%d"),
                    "datefin": today.strftime("%Y-%m-%d"),
                    "xperiod": "30",
                }
                headers = {
                    "User-Agent": "Mozilla/5.0",
                    "Content-Type": "application/json;charset=UTF-8",
                    "Origin": "https://www.sikafinance.com",
                }
                r = requests.post("https://www.sikafinance.com/api/general/GetHistos",
                                  json=payload, headers=headers, timeout=10)
                if r.status_code == 200:
                    lst = r.json().get("lst", [])
                    if lst and len(lst) >= 12:
                        rows = []
                        for row in lst:
                            try:
                                d = datetime.strptime(str(row["Date"]), "%d/%m/%Y")
                                rows.append({"date": d, "open": float(row.get("Open", row["Close"])),
                                             "high": float(row.get("High", row["Close"])),
                                             "low": float(row.get("Low", row["Close"])),
                                             "close": float(row["Close"]),
                                             "volume": float(row.get("Volume", 0))})
                            except Exception:
                                continue
                        if rows:
                            df_alt = pd.DataFrame(rows).sort_values("date").drop_duplicates("date").set_index("date")
                            df_alt.index = pd.to_datetime(df_alt.index)
                            monthly_data[t] = df_alt[["open", "high", "low", "close", "volume"]]
                            break
            except Exception:
                continue
        time.sleep(0.15)

print(f"  {len(monthly_data)} tickers charges\n")

if len(monthly_data) < 5:
    print("Trop peu de données - arrêt.")
    exit()

# ── Analyse signal mensuel ─────────────────────────────────────────────────────
# Pour chaque ticker, pour chaque mois M :
#   1. Calculer le score sur les N mois precédents (signal a la fin du mois M)
#   2. Calculer le retour du mois M+1 (close[M+1] / close[M] - 1)
#   3. Comparer : retour moyen quand signal=ACHAT vs retour base rate

records = []
MIN_WARMUP_MONTHS = 12  # minimum de mois pour calculer les indicateurs

print("Calcul signaux mensuels...")
for ticker, df in monthly_data.items():
    for i in range(MIN_WARMUP_MONTHS, len(df) - 1):
        df_slice = df.iloc[:i + 1]  # données jusqu'au mois M inclus
        ts_entry  = df.index[i]
        ts_exit   = df.index[i + 1]
        next_ret  = (df["close"].iloc[i + 1] / df["close"].iloc[i] - 1) * 100

        try:
            # Utiliser compute_indicators sur données mensuelles
            # On passe df_slice tel quel - les indicateurs (MA, ATR, etc.) s'adaptent
            ind = compute_indicators(df_slice, ticker=ticker, horizon="medium")
            score = compute_score(ind)
            signal   = score.signal
            confiance = score.confiance
            score_val = score.score_total if hasattr(score, "score_total") else getattr(score, "score", 0)
            atr_pct  = ind.atr_pct

            records.append({
                "ticker":    ticker,
                "date":      ts_entry,
                "signal":    signal,
                "confiance": confiance,
                "score":     score_val,
                "atr_pct":   atr_pct,
                "ret_m1":    round(next_ret, 2),
                "win_m1":    next_ret > 0,
            })
        except Exception:
            continue

df_sig = pd.DataFrame(records)
if df_sig.empty:
    print("Aucun signal calculé - vérifier compatibilité des indicateurs.")
    exit()

print(f"  {len(df_sig)} observations ({df_sig['ticker'].nunique()} tickers, "
      f"{df_sig['date'].dt.to_period('Y').nunique()} ans)\n")

SEP = "-" * 65

# ── 1. Vue globale ─────────────────────────────────────────────────────────────
total_wr = df_sig["win_m1"].mean() * 100
total_ret = df_sig["ret_m1"].mean()

achat = df_sig[df_sig["signal"] == "ACHAT"]
neutre = df_sig[df_sig["signal"] != "ACHAT"]

print(f"{'='*65}")
print(f"  VUE GLOBALE - {len(df_sig)} observations mensuelles")
print(f"{'='*65}")
print(f"  Base rate (toutes obs.)   : WR={total_wr:.1f}%  ret_moy={total_ret:+.2f}%")
print(f"  Signal ACHAT ({len(achat):>4} obs)  : "
      f"WR={achat['win_m1'].mean()*100:.1f}%  ret_moy={achat['ret_m1'].mean():+.2f}%")
if len(neutre) > 0:
    print(f"  Signal NEUTRE ({len(neutre):>4} obs) : "
          f"WR={neutre['win_m1'].mean()*100:.1f}%  ret_moy={neutre['ret_m1'].mean():+.2f}%")
print(f"  Lift ACHAT vs base rate   : {achat['ret_m1'].mean() - total_ret:+.2f}%/mois")

# ── 2. Par confiance ───────────────────────────────────────────────────────────
print(f"\n{SEP}")
print(f"  PAR CONFIANCE (signal ACHAT uniquement)")
print(f"{SEP}")
print(f"  {'Confiance':<12} {'n':>5}  {'WR':>7}  {'ret_moy':>8}  {'vs_base':>8}")
for conf in ["forte", "modérée", "faible"]:
    g = achat[achat["confiance"] == conf]
    if len(g) < 5:
        continue
    wr  = g["win_m1"].mean() * 100
    ret = g["ret_m1"].mean()
    vs  = ret - total_ret
    print(f"  {conf:<12} {len(g):>5}  {wr:>6.1f}%  {ret:>+7.2f}%  {vs:>+7.2f}%")

# ── 3. Par score ───────────────────────────────────────────────────────────────
print(f"\n{SEP}")
print(f"  PAR SCORE (toutes obs.)")
print(f"{SEP}")
print(f"  {'Score_bucket':<14} {'n':>5}  {'%ACHAT':>8}  {'WR_next':>8}  {'ret_moy':>8}")
df_sig["score_bucket"] = pd.cut(df_sig["score"], bins=[-20,-5,-2,0,2,5,20],
    labels=["<=-5","[-5,-2]","[-2,0]","[0,2]","[2,5]",">=5"])
for bkt, g in df_sig.groupby("score_bucket", observed=True):
    pct_achat = (g["signal"] == "ACHAT").mean() * 100
    wr  = g["win_m1"].mean() * 100
    ret = g["ret_m1"].mean()
    print(f"  {str(bkt):<14} {len(g):>5}  {pct_achat:>7.1f}%  {wr:>7.1f}%  {ret:>+7.2f}%")

# ── 4. Décile de score → retour mensuel ────────────────────────────────────────
print(f"\n{SEP}")
print(f"  DECILE SCORE -> RETOUR MENSUEL SUIVANT")
print(f"{SEP}")
print(f"  {'Décile score':<18} {'score_min':>10}  {'n':>5}  {'WR':>7}  {'ret_moy':>8}")
df_sig["score_decile"] = pd.qcut(df_sig["score"], q=10, duplicates="drop")
for bkt, g in df_sig.groupby("score_decile", observed=True):
    wr  = g["win_m1"].mean() * 100
    ret = g["ret_m1"].mean()
    smin = g["score"].min()
    print(f"  {str(bkt):<18} {smin:>10.0f}  {len(g):>5}  {wr:>6.1f}%  {ret:>+7.2f}%")

# ── 5. Par ATR% mensuel ────────────────────────────────────────────────────────
print(f"\n{SEP}")
print(f"  PAR ATR% MENSUEL (signal ACHAT uniquement)")
print(f"{SEP}")
print(f"  {'ATR_bucket':<14} {'n':>5}  {'WR':>7}  {'ret_moy':>8}")
achat2 = achat.dropna(subset=["atr_pct"])
if len(achat2) > 20:
    try:
        achat2 = achat2.copy()
        achat2["atr_b"] = pd.cut(achat2["atr_pct"],
            bins=[0,1,2,3,5,8,100], labels=["<1%","1-2%","2-3%","3-5%","5-8%",">8%"])
        for bkt, g in achat2.groupby("atr_b", observed=True):
            if len(g) < 5:
                continue
            wr  = g["win_m1"].mean() * 100
            ret = g["ret_m1"].mean()
            print(f"  {str(bkt):<14} {len(g):>5}  {wr:>6.1f}%  {ret:>+7.2f}%")
    except Exception:
        pass

# ── 6. Par ticker - top/flop sur signaux ACHAT ────────────────────────────────
print(f"\n{SEP}")
print(f"  TOP 10 TICKERS sur signaux ACHAT (>= 5 obs)")
print(f"{SEP}")
grp_t = achat.groupby("ticker").apply(lambda g: pd.Series({
    "n": len(g), "wr": round(g["win_m1"].mean()*100,1),
    "ret_moy": round(g["ret_m1"].mean(),2),
}), include_groups=False).reset_index()
top_t = grp_t[grp_t["n"] >= 5].sort_values("ret_moy", ascending=False).head(10)
for _, r in top_t.iterrows():
    print(f"  {r['ticker']:<8}  n={r['n']:>3}  WR={r['wr']:>5.1f}%  ret_moy={r['ret_moy']:>+6.2f}%/mois")

print(f"\n  FLOP 10 TICKERS")
flop_t = grp_t[grp_t["n"] >= 5].sort_values("ret_moy").head(10)
for _, r in flop_t.iterrows():
    print(f"  {r['ticker']:<8}  n={r['n']:>3}  WR={r['wr']:>5.1f}%  ret_moy={r['ret_moy']:>+6.2f}%/mois")

# ── 7. Évolution annuelle du signal ───────────────────────────────────────────
print(f"\n{SEP}")
print(f"  QUALITE DU SIGNAL PAR ANNEE (ACHAT uniquement)")
print(f"{SEP}")
print(f"  {'Année':>6}  {'n_achat':>8}  {'WR_achat':>10}  {'ret_moy':>8}  {'base_WR':>8}")
df_sig["year"] = df_sig["date"].dt.year
for yr, g in df_sig.groupby("year"):
    ac = g[g["signal"] == "ACHAT"]
    if len(ac) < 3:
        continue
    base_wr = g["win_m1"].mean() * 100
    wr_ac   = ac["win_m1"].mean() * 100
    ret_ac  = ac["ret_m1"].mean()
    print(f"  {yr:>6}  {len(ac):>8}  {wr_ac:>9.1f}%  {ret_ac:>+7.2f}%  {base_wr:>7.1f}%")

# ── 8. Résumé statistique du lift ─────────────────────────────────────────────
print(f"\n{'='*65}")
print(f"  SYNTHESE - Pertinence statistique du signal")
print(f"{'='*65}")
from scipy import stats as sp_stats

if len(achat) > 0 and len(neutre) > 0:
    t_stat, p_val = sp_stats.ttest_ind(achat["ret_m1"], neutre["ret_m1"])
    print(f"  t-test ACHAT vs NEUTRE : t={t_stat:.2f}  p={p_val:.4f} "
          f"({'SIGNIFICATIF' if p_val < 0.05 else 'non signif.'} @ 5%)")

# Test vs base rate (un sample t-test)
t2, p2 = sp_stats.ttest_1samp(achat["ret_m1"], total_ret)
print(f"  t-test ACHAT vs base   : t={t2:.2f}  p={p2:.4f} "
      f"({'SIGNIFICATIF' if p2 < 0.05 else 'non signif.'} @ 5%)")

# Pearson score vs ret_m1
corr_s, p_corr = sp_stats.pearsonr(df_sig["score"].fillna(0), df_sig["ret_m1"])
print(f"  Corrélation score/ret  : r={corr_s:+.3f}  p={p_corr:.4f} "
      f"({'SIGNIFICATIF' if p_corr < 0.05 else 'non signif.'} @ 5%)")

print(f"\n  Donnees : {df_sig['date'].min().strftime('%b %Y')} -> "
      f"{df_sig['date'].max().strftime('%b %Y')}  "
      f"({df_sig['date'].dt.to_period('Y').nunique()} ans  "
      f"|  {df_sig['ticker'].nunique()} tickers  "
      f"|  {len(df_sig)} observations)")

print(f"\n{'='*65}")
print("  FIN ANALYSE MENSUELLE")
print(f"{'='*65}")
