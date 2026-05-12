#!/usr/bin/env python3
"""
dashboard.py — Tableau de bord BRVM (données locales CSV).

Scan automatique de tous les tickers BRVM sans réseau :
  - Régime de marché (breadth MA50 / MA200)
  - Signaux CT / MT / LT (config optimisée finale)
  - Top fondamentaux (div yield + PER)

Lancement : streamlit run dashboard.py
"""
import sys
import warnings
import logging
from pathlib import Path
from datetime import timedelta

import pandas as pd
import numpy as np
import plotly.graph_objects as go
import plotly.express as px
import streamlit as st

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))

import config as cfg
from indicators import _fill_ohlcv_gaps, compute_indicators
from scoring import compute_score
from fundamentals_loader import get_loader
from market_regime import (
    _compute_ticker_signals,
    classify_market_regime,
    sector_strength,
    MarketBreadth,
)

# ─── Constantes ──────────────────────────────────────────────────────────────

DATA_DIR   = REPO / "data" / "daily"
BLACKLIST  = {"SPHC", "LNBB"}
INDEX_TICKERS = {"BRVMC", "BRVM30", "BRVM-IN", "BRVM-TEL", "BRVM-EN"}

HORIZONS   = ["Court terme", "Moyen terme", "Long terme"]
HORIZON_ICONS = {"Court terme": "⚡", "Moyen terme": "📈", "Long terme": "🏦"}

REGIME_COLOR = {
    "BULL_BROAD":  "#0F6E56",
    "BULL_NARROW": "#2E8B57",
    "RANGE":       "#BA7517",
    "BEAR_NARROW": "#C0392B",
    "BEAR_BROAD":  "#7B241C",
    "INCONNU":     "#888888",
}
REGIME_LABEL = {
    "BULL_BROAD":  "🟢 BULL BROAD",
    "BULL_NARROW": "🟩 BULL NARROW",
    "RANGE":       "🟡 RANGE",
    "BEAR_NARROW": "🟠 BEAR NARROW",
    "BEAR_BROAD":  "🔴 BEAR BROAD",
    "INCONNU":     "⚫ INCONNU",
}

# ─── Page config ─────────────────────────────────────────────────────────────

st.set_page_config(
    page_title="BRVM Dashboard",
    page_icon="📊",
    layout="wide",
    initial_sidebar_state="collapsed",
)

st.markdown("""
<style>
    .metric-card {
        background:#f8f9fa; border-radius:8px; padding:12px 16px; margin:4px 0;
    }
    .regime-badge {
        font-size:1.4rem; font-weight:700; border-radius:8px;
        padding:8px 20px; display:inline-block; margin-bottom:8px;
    }
    .signal-achat  { color:#0F6E56; font-weight:700; }
    .signal-vente  { color:#A32D2D; font-weight:700; }
    .signal-neutre { color:#BA7517; }
    .tbl-ticker    { font-weight:600; font-family:monospace; }
    div[data-testid="stMetric"] label { font-size:.75rem; color:#555; }
    div[data-testid="stMetric"] div[data-testid="stMetricValue"] { font-size:1.6rem; font-weight:700; }
</style>
""", unsafe_allow_html=True)


# ─── Chargement et cache ──────────────────────────────────────────────────────

@st.cache_data(ttl=3600, show_spinner="Chargement des données locales…")
def load_ohlcv() -> dict[str, pd.DataFrame]:
    """Charge tous les CSV daily (sauf blacklist et indices)."""
    td = {}
    for f in sorted(DATA_DIR.glob("*.csv")):
        t = f.stem
        if t in BLACKLIST or t in INDEX_TICKERS:
            continue
        try:
            df = pd.read_csv(f, parse_dates=["date"])
        except Exception:
            continue
        df = df.sort_values("date").set_index("date")
        if len(df) < 70:
            continue
        df, _ = _fill_ohlcv_gaps(df)
        td[t] = df
    return td


@st.cache_data(ttl=3600, show_spinner="Calcul du régime de marché…")
def compute_breadth_local(td_json: str) -> dict:
    """
    Calcule la MarketBreadth depuis les DataFrames locaux.
    td_json est une clé de cache stable (timestamp du fichier le plus récent).
    """
    td = load_ohlcv()
    ticker_signals = {}
    for t, df in td.items():
        try:
            sig = _compute_ticker_signals(df, t)
        except Exception:
            from market_regime import TickerSignal
            sig = TickerSignal(ticker=t, error="erreur calcul")
        ticker_signals[t] = sig

    valid_ma50  = [s for s in ticker_signals.values() if s.above_ma50  is not None]
    valid_ma200 = [s for s in ticker_signals.values() if s.above_ma200 is not None]
    valid_52wh  = [s for s in ticker_signals.values() if s.near_52w_high is not None]
    valid_52wl  = [s for s in ticker_signals.values() if s.near_52w_low  is not None]

    n = len(valid_ma50)
    breadth = MarketBreadth(
        nb_tickers_total=len(td),
        nb_tickers_analyzed=n,
        ticker_signals=ticker_signals,
    )
    if n > 0:
        n_above = sum(1 for s in valid_ma50 if s.above_ma50)
        breadth.pct_above_ma50 = round(100.0 * n_above / n, 1)
        n_below = n - n_above
        breadth.advance_decline_ratio = round(n_above / n_below, 2) if n_below > 0 else float("inf")
    if valid_ma200:
        breadth.pct_above_ma200 = round(
            100.0 * sum(1 for s in valid_ma200 if s.above_ma200) / len(valid_ma200), 1
        )
    if valid_52wh:
        breadth.pct_near_52w_high = round(
            100.0 * sum(1 for s in valid_52wh if s.near_52w_high) / len(valid_52wh), 1
        )
    if valid_52wl:
        breadth.pct_near_52w_low = round(
            100.0 * sum(1 for s in valid_52wl if s.near_52w_low) / len(valid_52wl), 1
        )
    breadth.sector_scores = sector_strength(ticker_signals, cfg.TICKER_GROUPS)
    breadth.regime = classify_market_regime(breadth) if n > 0 else "INCONNU"
    return breadth


@st.cache_data(ttl=3600, show_spinner="Calcul des signaux…")
def compute_all_signals(td_json: str) -> pd.DataFrame:
    """
    Calcule compute_score pour chaque ticker × horizon sur la dernière date disponible.
    Retourne un DataFrame avec colonnes :
      ticker, nom, horizon, signal, confiance, score, prix, rsi, ma_signal, vol_rel, secteur
    """
    td   = load_ohlcv()
    fund = get_loader()

    rows = []
    for t, df in td.items():
        nom      = cfg.TICKER_NAMES.get(t, t)
        secteur  = next(
            (g for g, ts in cfg.TICKER_GROUPS.items() if t in ts and "Indic" not in g),
            "Autre",
        )
        latest_date = (df.index[-1].date() if hasattr(df.index[-1], "date")
                       else df.index[-1])

        for horizon in HORIZONS:
            try:
                ind = compute_indicators(df.copy(), ticker=t, horizon=horizon,
                                         df_index=None, fill_gaps=False)
            except Exception:
                continue

            # Injecter fondamentaux
            cours = ind.cours_actuel or 0
            if cours > 0:
                try:
                    dy, per, annee = fund.get_signals(t, latest_date, cours)
                    ind.fund_div_yield    = dy
                    ind.fund_per_implied  = per
                    ind.fund_annee        = annee
                except Exception:
                    pass

            try:
                sr = compute_score(ind)
            except Exception:
                continue

            vol_rel = (
                round(ind.volume_actuel / ind.volume_moy20, 2)
                if ind.volume_actuel and ind.volume_moy20 and ind.volume_moy20 > 0
                else None
            )
            rows.append({
                "ticker":    t,
                "nom":       nom,
                "horizon":   horizon,
                "signal":    sr.signal,
                "confiance": sr.confiance,
                "score":     sr.score_total,
                "prix":      ind.cours_actuel or 0,
                "rsi":       round(ind.rsi, 1) if ind.rsi is not None else None,
                "ma_signal": ind.ma_signal or "",
                "vol_rel":   vol_rel,
                "secteur":   secteur,
                "div_yield": getattr(ind, "fund_div_yield", None),
                "per":       getattr(ind, "fund_per_implied", None),
                "data_date": str(latest_date),
            })

    return pd.DataFrame(rows)


def _cache_key(td: dict) -> str:
    """Clé de cache basée sur la date max des données."""
    latest = max(
        (df.index[-1] for df in td.values() if len(df) > 0),
        default=pd.Timestamp("2000-01-01"),
    )
    return str(latest)


# ─── Composants visuels ───────────────────────────────────────────────────────

def render_breadth_gauge(pct: float, label: str) -> go.Figure:
    color = REGIME_COLOR.get(label, "#888")
    fig = go.Figure(go.Indicator(
        mode="gauge+number",
        value=pct,
        number={"suffix": "%", "font": {"size": 32}},
        gauge={
            "axis": {"range": [0, 100], "tickwidth": 1,
                     "tickcolor": "#aaa", "tickvals": [20, 35, 50, 65, 100]},
            "bar":  {"color": color},
            "steps": [
                {"range": [0,  20], "color": "#7B241C"},
                {"range": [20, 35], "color": "#C0392B"},
                {"range": [35, 50], "color": "#BA7517"},
                {"range": [50, 65], "color": "#2E8B57"},
                {"range": [65, 100], "color": "#0F6E56"},
            ],
        },
        title={"text": "% titres > MA50", "font": {"size": 14}},
    ))
    fig.update_layout(height=220, margin=dict(l=20, r=20, t=40, b=10))
    return fig


def render_sector_bars(sector_scores: dict) -> go.Figure:
    # Exclure indices
    scores = {
        k.split(" - ")[-1].strip(): v
        for k, v in sector_scores.items()
        if "Indic" not in k
    }
    if not scores:
        return go.Figure()
    labels = list(scores.keys())
    values = list(scores.values())
    colors = [
        REGIME_COLOR.get(
            classify_market_regime(
                type("B", (), {"pct_above_ma50": v, "pct_above_ma200": 50})()
            ),
            "#888",
        )
        for v in values
    ]
    fig = go.Figure(go.Bar(
        x=values, y=labels, orientation="h",
        marker_color=colors,
        text=[f"{v:.0f}%" for v in values],
        textposition="outside",
    ))
    fig.update_layout(
        height=max(180, len(labels) * 32),
        margin=dict(l=5, r=60, t=10, b=10),
        xaxis=dict(range=[0, 110], showticklabels=False),
        yaxis=dict(autorange="reversed"),
        plot_bgcolor="white",
    )
    return fig


def signal_color_html(signal: str) -> str:
    css = {"ACHAT": "signal-achat", "VENTE": "signal-vente", "NEUTRE": "signal-neutre"}
    cls = css.get(signal, "")
    return f'<span class="{cls}">{signal}</span>'


def fmt_ma(ma_signal: str) -> str:
    icons = {
        "golden_cross": "🌟 Golden cross",
        "bullish":       "↗ Haussier",
        "bearish":       "↘ Baissier",
        "death_cross":  "💀 Death cross",
        "consolidation": "↔ Consolidation",
    }
    return icons.get(ma_signal, ma_signal or "—")


def fmt_confiance(c: str) -> str:
    icons = {"forte": "🟢", "modérée": "🟡", "faible": "🔴"}
    return f"{icons.get(c, '')} {c}"


# ─── Sections ─────────────────────────────────────────────────────────────────

def section_regime(breadth: MarketBreadth) -> None:
    regime = breadth.regime
    color  = REGIME_COLOR.get(regime, "#888")
    label  = REGIME_LABEL.get(regime, regime)

    st.markdown(
        f'<div class="regime-badge" style="background:{color}20;color:{color};'
        f'border:2px solid {color}">{label}</div>',
        unsafe_allow_html=True,
    )

    col_gauge, col_metrics, col_sectors = st.columns([1.5, 1, 2])

    with col_gauge:
        st.plotly_chart(render_breadth_gauge(breadth.pct_above_ma50, regime),
                        use_container_width=True)

    with col_metrics:
        st.metric("MA50 breadth",  f"{breadth.pct_above_ma50:.1f}%")
        st.metric("MA200 breadth", f"{breadth.pct_above_ma200:.1f}%")
        ad = breadth.advance_decline_ratio
        st.metric("Advance / Decline", f"{ad:.2f}" if ad != float("inf") else "∞")
        st.metric("Proches 52w High",  f"{breadth.pct_near_52w_high:.1f}%")
        st.metric("Proches 52w Low",   f"{breadth.pct_near_52w_low:.1f}%")
        st.caption(
            f"Univers : {breadth.nb_tickers_analyzed}/{breadth.nb_tickers_total} titres"
        )

    with col_sectors:
        st.markdown("**Force par secteur (% > MA50)**")
        st.plotly_chart(render_sector_bars(breadth.sector_scores),
                        use_container_width=True)


def section_signals(df_all: pd.DataFrame) -> None:
    tabs = st.tabs([
        f"{HORIZON_ICONS[h]} {h}" for h in HORIZONS
    ])

    for tab, horizon in zip(tabs, HORIZONS):
        with tab:
            df_h = df_all[df_all["horizon"] == horizon].copy()

            # KPIs
            n_achat  = (df_h["signal"] == "ACHAT").sum()
            n_vente  = (df_h["signal"] == "VENTE").sum()
            n_neutre = (df_h["signal"] == "NEUTRE").sum()
            n_total  = len(df_h)

            k1, k2, k3, k4 = st.columns(4)
            k1.metric("🟢 ACHAT",  f"{n_achat}",
                      help=f"{n_achat/n_total*100:.0f}% du marché" if n_total else "")
            k2.metric("🔴 VENTE",  f"{n_vente}")
            k3.metric("🟡 NEUTRE", f"{n_neutre}")
            k4.metric("📊 Total",  f"{n_total} titres")

            col_a, col_v = st.columns([3, 2])

            # ── ACHAT ─────────────────────────────────────────────────────────
            with col_a:
                df_achat = (
                    df_h[df_h["signal"] == "ACHAT"]
                    .sort_values(["confiance", "score"], ascending=[True, False])
                )
                # Confiance forte en premier
                order = {"forte": 0, "modérée": 1, "faible": 2}
                df_achat = df_achat.iloc[
                    df_achat["confiance"].map(order).fillna(9).argsort()
                ]

                st.markdown(f"**🟢 Signaux ACHAT** ({len(df_achat)})")
                if df_achat.empty:
                    st.info("Aucun signal ACHAT sur cet horizon.")
                else:
                    rows_html = ""
                    for _, r in df_achat.iterrows():
                        conf_icon = {"forte": "🟢", "modérée": "🟡", "faible": "🔴"}.get(
                            r["confiance"], ""
                        )
                        rsi_str = f"{r['rsi']:.0f}" if r["rsi"] is not None else "—"
                        vol_str = f"×{r['vol_rel']:.1f}" if r["vol_rel"] is not None else "—"
                        prix_str = (
                            f"{r['prix']:,.0f} F"
                            if r["prix"] and r["prix"] > 0 else "—"
                        )
                        rows_html += (
                            f"<tr>"
                            f"<td class='tbl-ticker'>{r['ticker']}</td>"
                            f"<td style='max-width:140px;overflow:hidden;white-space:nowrap;'>{r['nom']}</td>"
                            f"<td style='text-align:center'>{conf_icon} <b>{r['score']:+d}</b></td>"
                            f"<td style='text-align:right'>{prix_str}</td>"
                            f"<td style='text-align:center'>{rsi_str}</td>"
                            f"<td style='text-align:center;font-size:.8rem'>{fmt_ma(r['ma_signal'])}</td>"
                            f"<td style='text-align:center;color:#666'>{vol_str}</td>"
                            f"</tr>"
                        )
                    st.markdown(
                        f"""<table style='width:100%;font-size:.85rem;border-collapse:collapse'>
                        <thead><tr style='border-bottom:2px solid #ddd;font-size:.75rem;color:#555'>
                        <th>Ticker</th><th>Société</th><th>Conf/Score</th>
                        <th>Prix</th><th>RSI</th><th>MA</th><th>VolRel</th>
                        </tr></thead><tbody>{rows_html}</tbody></table>""",
                        unsafe_allow_html=True,
                    )

            # ── VENTE ─────────────────────────────────────────────────────────
            with col_v:
                df_vente = df_h[df_h["signal"] == "VENTE"].sort_values(
                    "score", ascending=True
                )
                st.markdown(f"**🔴 Signaux VENTE** ({len(df_vente)})")
                if df_vente.empty:
                    st.info("Aucun signal VENTE.")
                else:
                    rows_html = ""
                    for _, r in df_vente.iterrows():
                        rsi_str = f"{r['rsi']:.0f}" if r["rsi"] is not None else "—"
                        prix_str = (
                            f"{r['prix']:,.0f} F"
                            if r["prix"] and r["prix"] > 0 else "—"
                        )
                        rows_html += (
                            f"<tr>"
                            f"<td class='tbl-ticker'>{r['ticker']}</td>"
                            f"<td style='max-width:120px;overflow:hidden;white-space:nowrap;'>{r['nom']}</td>"
                            f"<td style='text-align:center;color:#A32D2D'><b>{r['score']:+d}</b></td>"
                            f"<td style='text-align:right'>{prix_str}</td>"
                            f"<td style='text-align:center'>{rsi_str}</td>"
                            f"</tr>"
                        )
                    st.markdown(
                        f"""<table style='width:100%;font-size:.85rem;border-collapse:collapse'>
                        <thead><tr style='border-bottom:2px solid #ddd;font-size:.75rem;color:#555'>
                        <th>Ticker</th><th>Société</th><th>Score</th>
                        <th>Prix</th><th>RSI</th>
                        </tr></thead><tbody>{rows_html}</tbody></table>""",
                        unsafe_allow_html=True,
                    )


def section_fundamentals(df_all: pd.DataFrame) -> None:
    # On prend les données MT (une ligne par ticker) pour les fondamentaux
    df_mt = df_all[df_all["horizon"] == "Moyen terme"].copy()

    col_div, col_per = st.columns(2)

    # ── Top Dividende ─────────────────────────────────────────────────────────
    with col_div:
        st.markdown("**💰 Top Rendement Dividende**")
        df_div = (
            df_mt[df_mt["div_yield"].notna() & (df_mt["div_yield"] > 0)]
            .sort_values("div_yield", ascending=False)
            .head(10)
        )
        if df_div.empty:
            st.info("Aucune donnée dividende disponible.")
        else:
            rows = ""
            for _, r in df_div.iterrows():
                sig_color = {"ACHAT": "#0F6E56", "VENTE": "#A32D2D", "NEUTRE": "#BA7517"}.get(
                    r["signal"], "#888"
                )
                rows += (
                    f"<tr>"
                    f"<td class='tbl-ticker'>{r['ticker']}</td>"
                    f"<td style='max-width:150px;overflow:hidden;white-space:nowrap;'>{r['nom']}</td>"
                    f"<td style='text-align:right;font-weight:700;color:#0F6E56'>{r['div_yield']:.1f}%</td>"
                    f"<td style='text-align:center;font-size:.8rem;color:{sig_color}'>{r['signal']}</td>"
                    f"</tr>"
                )
            st.markdown(
                f"""<table style='width:100%;font-size:.85rem;border-collapse:collapse'>
                <thead><tr style='border-bottom:2px solid #ddd;font-size:.75rem;color:#555'>
                <th>Ticker</th><th>Société</th><th>Div Yield</th><th>Signal MT</th>
                </tr></thead><tbody>{rows}</tbody></table>""",
                unsafe_allow_html=True,
            )

    # ── Top PER (sous-évalué = PER bas) ──────────────────────────────────────
    with col_per:
        st.markdown("**📊 Meilleures Valorisations (PER bas)**")
        df_per = (
            df_mt[df_mt["per"].notna() & (df_mt["per"] > 0) & (df_mt["per"] < 50)]
            .sort_values("per", ascending=True)
            .head(10)
        )
        if df_per.empty:
            st.info("Aucune donnée PER disponible.")
        else:
            rows = ""
            for _, r in df_per.iterrows():
                sig_color = {"ACHAT": "#0F6E56", "VENTE": "#A32D2D", "NEUTRE": "#BA7517"}.get(
                    r["signal"], "#888"
                )
                rows += (
                    f"<tr>"
                    f"<td class='tbl-ticker'>{r['ticker']}</td>"
                    f"<td style='max-width:150px;overflow:hidden;white-space:nowrap;'>{r['nom']}</td>"
                    f"<td style='text-align:right;font-weight:700;color:#2E4A7A'>{r['per']:.1f}x</td>"
                    f"<td style='text-align:center;font-size:.8rem;color:{sig_color}'>{r['signal']}</td>"
                    f"</tr>"
                )
            st.markdown(
                f"""<table style='width:100%;font-size:.85rem;border-collapse:collapse'>
                <thead><tr style='border-bottom:2px solid #ddd;font-size:.75rem;color:#555'>
                <th>Ticker</th><th>Société</th><th>PER</th><th>Signal MT</th>
                </tr></thead><tbody>{rows}</tbody></table>""",
                unsafe_allow_html=True,
            )


def section_distribution(df_all: pd.DataFrame) -> None:
    """Graphique de distribution des signaux par horizon."""
    rows = []
    for horizon in HORIZONS:
        df_h = df_all[df_all["horizon"] == horizon]
        for signal in ["ACHAT", "NEUTRE", "VENTE"]:
            rows.append({
                "Horizon": horizon,
                "Signal":  signal,
                "N":       (df_h["signal"] == signal).sum(),
            })
    df_dist = pd.DataFrame(rows)

    color_map = {"ACHAT": "#0F6E56", "NEUTRE": "#BA7517", "VENTE": "#A32D2D"}
    fig = px.bar(
        df_dist, x="Horizon", y="N", color="Signal",
        color_discrete_map=color_map,
        barmode="group",
        text="N",
        height=280,
    )
    fig.update_traces(textposition="outside")
    fig.update_layout(
        margin=dict(l=0, r=0, t=20, b=0),
        legend=dict(orientation="h", y=1.1),
        plot_bgcolor="white",
        yaxis_title="",
    )
    st.plotly_chart(fig, use_container_width=True)


# ─── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    # ── Titre ─────────────────────────────────────────────────────────────────
    col_title, col_refresh = st.columns([5, 1])
    with col_title:
        st.title("📊 BRVM Dashboard")
        st.caption("Données locales · Config optimisée finale (CT/MT/LT) · Investment Pioneers")
    with col_refresh:
        st.write("")
        if st.button("🔄 Rafraîchir", use_container_width=True):
            st.cache_data.clear()
            st.rerun()

    # ── Chargement ────────────────────────────────────────────────────────────
    td = load_ohlcv()
    if not td:
        st.error("❌ Aucune donnée CSV trouvée dans data/daily/")
        return

    cache_key = _cache_key(td)

    # Date des données
    latest = max(df.index[-1] for df in td.values() if len(df) > 0)
    st.info(
        f"📅 Données au **{pd.Timestamp(latest).strftime('%d/%m/%Y')}** · "
        f"**{len(td)}** tickers analysés"
    )

    # ── Régime de marché ──────────────────────────────────────────────────────
    st.markdown("## 🌐 Régime de marché")
    with st.spinner("Calcul du régime…"):
        breadth = compute_breadth_local(cache_key)
    section_regime(breadth)

    st.divider()

    # ── Signaux ───────────────────────────────────────────────────────────────
    st.markdown("## 📡 Signaux du marché")
    with st.spinner("Calcul des signaux (CT / MT / LT)…"):
        df_all = compute_all_signals(cache_key)

    if df_all.empty:
        st.warning("Aucun signal calculé.")
        return

    # Distribution en mini-graphique
    with st.expander("📊 Distribution des signaux par horizon", expanded=False):
        section_distribution(df_all)

    section_signals(df_all)

    st.divider()

    # ── Fondamentaux ──────────────────────────────────────────────────────────
    st.markdown("## 💡 Fondamentaux BRVM")
    section_fundamentals(df_all)

    st.divider()

    # ── Pied de page ──────────────────────────────────────────────────────────
    st.caption(
        "⚠️ Ce dashboard est un outil d'aide à la décision basé sur des données historiques locales. "
        "Il ne constitue pas un conseil en investissement. "
        "Les signaux sont calculés avec la config optimisée finale (G1/G2 pipeline)."
    )


if __name__ == "__main__":
    main()
