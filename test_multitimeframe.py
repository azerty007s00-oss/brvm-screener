"""
test_multitimeframe.py - Test confirmation multi-timeframe.

Principe : n'entrer que si le signal hebdomadaire est aussi ACHAT.
Evite les entrees sur des corrections courtes dans une tendance baissiere.

Donnees : daily (260 bars) + weekly (53 bars) via SikaFinance xperiod=5
"""
import logging, warnings, time, requests
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

import pandas as pd
from datetime import datetime, timedelta, date

from backtest import (BacktestEngine, ALL_TICKERS, INITIAL_CAP, WARMUP_BARS,
    REVIEW_INTERVAL_DAYS, MAX_HOLDING_DAYS, MAX_ATR_PCT, MIN_PRICE,
    BacktestResult)
from config import DEFAULT_HORIZON, TICKER_TO_SIKA_ID
from analysis import compute_risk_levels, compute_position_size
from indicators import compute_indicators
from scoring import compute_score
from scraper import get_ohlcv

# ── Fetch weekly data ──────────────────────────────────────────────────────────

def fetch_weekly(ticker: str) -> pd.DataFrame | None:
    sika_id = TICKER_TO_SIKA_ID.get(ticker, f"{ticker}.ci")
    today   = datetime.now()
    payload = {
        "ticker":  sika_id,
        "datedeb": (today - timedelta(days=365 * 3)).strftime("%Y-%m-%d"),
        "datefin": today.strftime("%Y-%m-%d"),
        "xperiod": "5",
    }
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": "https://www.sikafinance.com",
    }
    try:
        time.sleep(0.25)
        r = requests.post("https://www.sikafinance.com/api/general/GetHistos",
                          json=payload, headers=headers, timeout=15)
        if r.status_code != 200:
            return None
        lst = r.json().get("lst", [])
        if not lst:
            # Essayer suffixes alternatifs
            for sfx in [".bj", ".sn", ".bf", ".ml", ".tg"]:
                payload["ticker"] = f"{ticker}{sfx}"
                r2 = requests.post("https://www.sikafinance.com/api/general/GetHistos",
                                   json=payload, headers=headers, timeout=10)
                if r2.status_code == 200:
                    lst = r2.json().get("lst", [])
                    if lst:
                        break
        if not lst:
            return None
        rows = []
        for row in lst:
            try:
                d = datetime.strptime(str(row["Date"]), "%d/%m/%Y")
                rows.append({"date": d,
                             "open":   float(row.get("Open",  row["Close"])),
                             "high":   float(row.get("High",  row["Close"])),
                             "low":    float(row.get("Low",   row["Close"])),
                             "close":  float(row["Close"]),
                             "volume": float(row.get("Volume", 0))})
            except Exception:
                continue
        if not rows:
            return None
        df = pd.DataFrame(rows).sort_values("date").drop_duplicates("date")
        df.set_index("date", inplace=True)
        df.index = pd.to_datetime(df.index)
        return df[["open", "high", "low", "close", "volume"]]
    except Exception:
        return None


print("Chargement donnees quotidiennes (cache)...")
data_daily = {}
for t in ALL_TICKERS:
    try:
        data_daily[t] = get_ohlcv(t, days=730)
    except:
        pass

print(f"  {len(data_daily)} tickers quotidiens")
print("Chargement donnees hebdomadaires (API)...")
data_weekly = {}
for t in ALL_TICKERS:
    df = fetch_weekly(t)
    if df is not None and len(df) >= 8:
        data_weekly[t] = df
print(f"  {len(data_weekly)} tickers hebdomadaires\n")

BASE_KWARGS = dict(
    initial_capital=INITIAL_CAP, horizon=DEFAULT_HORIZON,
    warmup_bars=WARMUP_BARS, review_interval_days=REVIEW_INTERVAL_DAYS,
    max_holding_days=MAX_HOLDING_DAYS, max_atr_pct=MAX_ATR_PCT,
    min_price=MIN_PRICE, fee_pct=0.0,
)


# ── Moteur multi-timeframe ─────────────────────────────────────────────────────

class BacktestEngineMultiTF(BacktestEngine):
    """
    Ajoute confirmation hebdomadaire : signal journalier ACHAT accepte
    uniquement si le signal hebdomadaire est aussi ACHAT.
    """

    def __init__(self, *args, weekly_data: dict = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.weekly_data = weekly_data or {}

    def run(self, ticker_data: dict) -> BacktestResult:
        if not ticker_data:
            raise ValueError("ticker_data est vide")

        all_dates = sorted({
            idx.date() if hasattr(idx, "date") else idx
            for df in ticker_data.values()
            for idx in df.index
        })

        self._equity_history.append({"date": all_dates[0], "equity": self._equity})

        for current_date in all_dates:
            ts = pd.Timestamp(current_date)

            for ticker, df_full in ticker_data.items():
                df_slice = df_full[df_full.index <= ts]
                if ts not in df_full.index:
                    continue
                if len(df_slice) < self.warmup_bars:
                    continue

                current_bar   = df_full.loc[ts]
                current_price = float(current_bar["close"])
                current_high  = float(current_bar.get("high", current_price))
                current_low   = float(current_bar.get("low",  current_price))

                if ticker in self._open:
                    pos = self._open[ticker]
                    days_held = (current_date - pos.entry_date).days
                    if days_held >= self.max_holding_days:
                        self._close(ticker, current_price, current_date, "timeout_3m")
                    else:
                        self._check_stop_target(ticker, current_low, current_high, current_date)

                next_rev = self._next_review.get(ticker)
                if next_rev is None or current_date >= next_rev:
                    self._next_review[ticker] = current_date + timedelta(
                        days=self.review_interval_days)

                    if ticker not in self._open:
                        try:
                            ind   = compute_indicators(df_slice, ticker=ticker,
                                                       horizon=self.horizon)
                            score = compute_score(ind)
                            score.stop_loss, score.take_profit = compute_risk_levels(score, ind)
                            score.position_size_pct = compute_position_size(score, ind)
                        except Exception:
                            continue

                        if ind.atr_pct is not None and ind.atr_pct < self.min_atr_pct:
                            continue

                        # -- Confirmation hebdomadaire --
                        if ticker in self.weekly_data:
                            df_w = self.weekly_data[ticker]
                            # Prendre uniquement les barres hebdo <= date courante
                            df_w_slice = df_w[df_w.index <= ts]
                            if len(df_w_slice) >= 8:
                                try:
                                    ind_w   = compute_indicators(df_w_slice, ticker=ticker,
                                                                 horizon=self.horizon)
                                    score_w = compute_score(ind_w)
                                    if score_w.signal != "ACHAT":
                                        continue  # signal hebdo non favorable -> passer
                                except Exception:
                                    pass  # si erreur hebdo, laisser passer

                        if (score.signal == "ACHAT"
                                and score.confiance in self.confiance_filter
                                and score.stop_loss is not None
                                and score.take_profit is not None
                                and score.position_size_pct is not None
                                and ind.cours_actuel >= self.min_price
                                and (ind.atr_pct is None or ind.atr_pct <= self.max_atr_pct)
                                and self._deployed_pct + score.position_size_pct <= 100.0):
                            self._open_position(ticker, score, ind, current_date)

            self._equity_history.append({"date": current_date, "equity": self._equity})

        last_date = all_dates[-1]
        for ticker in list(self._open.keys()):
            ts_last = pd.Timestamp(last_date)
            if ticker in ticker_data and ts_last in ticker_data[ticker].index:
                last_price = float(ticker_data[ticker].loc[ts_last, "close"])
                self._close(ticker, last_price, last_date, "end_of_backtest")

        return self._build_result()


# ── Run scenarios ──────────────────────────────────────────────────────────────

def row(label, r: BacktestResult, base: BacktestResult = None):
    s = r.summary
    if s.get("status") != "ok":
        print(f"  {label:<40}  AUCUN TRADE"); return
    df = r.trades
    s13 = len(df[(df["exit_reason"].isin(["stop","stop_extreme"])) & (df["holding_days"]<=3)])
    delta = ""
    if base and base.summary.get("status") == "ok":
        bs = base.summary
        delta = f"  [dRet={r.summary['total_return_pct']-bs['total_return_pct']:+.1f}%  dExp={r.summary['expectancy_pct']-bs['expectancy_pct']:+.2f}%]"
    print(f"  {label:<40}  n={s['n_trades']:>3}  WR={s['win_rate_pct']:>5.1f}%  "
          f"Exp={s['expectancy_pct']:>+6.2f}%  Ret={s['total_return_pct']:>+7.1f}%  "
          f"DD={s['max_drawdown_pct']:>5.1f}%  st1-3j={s13}{delta}")

print(f"{'='*110}")
print(f"  {'Scenario':<40}  {'n':>4}  {'WR':>7}  {'Exp':>8}  {'Return':>9}  {'MaxDD':>7}  {'st1-3j'}")
print(f"  {'-'*40}  {'-'*4}  {'-'*7}  {'-'*8}  {'-'*9}  {'-'*7}  {'-'*7}")

r0 = BacktestEngine(**BASE_KWARGS).run(data_daily)
row("0. Baseline (post A+B+C)", r0)

rM = BacktestEngineMultiTF(**BASE_KWARGS, weekly_data=data_weekly).run(data_daily)
row("M1. Multi-TF (daily + weekly ACHAT)", rM, r0)

# Combiner avec regime filter si BRVMC hebdo dispo
try:
    df_brvmc_w = fetch_weekly("BRVMC")
    if df_brvmc_w is not None:
        print(f"  BRVMC hebdo: {len(df_brvmc_w)} barres")
except:
    df_brvmc_w = None

print(f"{'='*110}")

# Analyse qualitative des trades filtres
filtered_in  = r0.trades
filtered_out_n = r0.summary["n_trades"] - rM.summary["n_trades"]

print(f"\n  Trades bloques par le filtre hebdo : {filtered_out_n}")
print(f"  Trades conserves                  : {rM.summary['n_trades']}")

# Quels tickers sont le plus filtrés ?
df0 = r0.trades.copy()
dfM = rM.trades.copy()
tickers_base = df0.groupby("ticker").size().rename("n_base")
tickers_mtf  = dfM.groupby("ticker").size().rename("n_mtf")
diff = pd.concat([tickers_base, tickers_mtf], axis=1).fillna(0)
diff["filtered"] = diff["n_base"] - diff["n_mtf"]
diff = diff[diff["filtered"] > 0].sort_values("filtered", ascending=False)
if not diff.empty:
    print(f"\n  Tickers les plus filtres (trades bloques) :")
    for tk, row_d in diff.head(10).iterrows():
        print(f"    {tk:<8}  base={int(row_d['n_base'])}  mtf={int(row_d['n_mtf'])}  bloque={int(row_d['filtered'])}")

# Qualite des trades conserves vs filtres
print(f"\n  Qualite comparative :")
print(f"  Baseline : WR={r0.summary['win_rate_pct']}%  exp={r0.summary['expectancy_pct']:+.2f}%  ret={r0.summary['total_return_pct']:+.2f}%")
print(f"  MultiTF  : WR={rM.summary['win_rate_pct']}%  exp={rM.summary['expectancy_pct']:+.2f}%  ret={rM.summary['total_return_pct']:+.2f}%")

print(f"\n{'='*110}")
