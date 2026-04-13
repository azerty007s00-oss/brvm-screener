"""
app.py — Interface Streamlit du BRVM Stock Screener (Investment Pioneers)

Lancement : streamlit run app.py
"""

import logging
import sys
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots

from analysis import build_analyse
from cache import cache
from config import PERIODES_DISPONIBLES, BRVM_INDEX_TICKER, MA_SHORT, MA_MID, MA_LONG, HORIZON_PROFILES, DEFAULT_HORIZON, TICKER_NAMES, TICKER_GROUPS
from indicators import compute_indicators
from scoring import compute_score
from scraper import get_ohlcv, get_news, TickerNotFoundError, InsufficientDataError, SourceStructureChangedError

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


# ─── Configuration Streamlit ──────────────────────────────────────────────────

st.set_page_config(
    page_title="BRVM Screener — Investment Pioneers",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded",
)

# CSS personnalisé
st.markdown("""
<style>
    .signal-achat  { color: #0F6E56; font-weight: 600; font-size: 1.3rem; }
    .signal-vente  { color: #A32D2D; font-weight: 600; font-size: 1.3rem; }
    .signal-neutre { color: #BA7517; font-weight: 600; font-size: 1.3rem; }
    .score-badge   { font-size: 1rem; padding: 2px 10px; border-radius: 8px; }
    .critere-row   { font-size: 0.85rem; margin: 2px 0; }
    .alerte        { font-size: 0.85rem; margin: 2px 0; }
    .section-label { font-size: 0.75rem; text-transform: uppercase;
                     letter-spacing: 0.08em; color: #888; margin-bottom: 2px; }
</style>
""", unsafe_allow_html=True)


# ─── Sidebar ──────────────────────────────────────────────────────────────────

with st.sidebar:
    st.title("📈 BRVM Screener")
    st.caption("Investment Pioneers")
    st.divider()

    # ── Sélection des tickers ─────────────────────────────────────────────────
    st.markdown("**Sélection des titres**")

    # Construire les options avec noms publics, groupées
    all_ticker_options = []
    for group, tickers_in_group in TICKER_GROUPS.items():
        for t in tickers_in_group:
            label = f"{t} — {TICKER_NAMES.get(t, t)}"
            all_ticker_options.append((t, label, group))

    option_labels = [opt[1] for opt in all_ticker_options]
    option_tickers = [opt[0] for opt in all_ticker_options]

    selected_labels = st.multiselect(
        "Choisir dans la liste",
        options=option_labels,
        default=[],
        placeholder="Orange CI, Sonatel, BICICI...",
        label_visibility="collapsed",
    )
    tickers_from_select = [option_tickers[option_labels.index(lbl)] for lbl in selected_labels]

    tickers_input_manual = st.text_input(
        "Ou saisir manuellement",
        placeholder="ex: BICC, ONTBF (séparés par virgules)",
        label_visibility="visible",
    )
    tickers_from_manual = [t.strip().upper() for t in tickers_input_manual.split(",") if t.strip()]

    # Fusion (multiselect prioritaire + saisie manuelle, sans doublon)
    tickers_combined = list(dict.fromkeys(tickers_from_select + tickers_from_manual))

    # ── Horizon d'analyse ─────────────────────────────────────────────────────
    st.markdown("**Horizon d'analyse**")
    horizon_options = list(HORIZON_PROFILES.keys())
    horizon_labels = {k: f"{HORIZON_PROFILES[k]['emoji']} {HORIZON_PROFILES[k]['label']}" for k in horizon_options}

    horizon = st.radio(
        "Horizon",
        options=horizon_options,
        format_func=lambda k: horizon_labels[k],
        index=horizon_options.index(DEFAULT_HORIZON),
        label_visibility="collapsed",
    )
    profile = HORIZON_PROFILES[horizon]

    # Info dynamique sur l'horizon sélectionné
    jours_min = profile["jours_min"]
    p = profile["periods"]
    with st.expander("🔍 Paramètres de l'horizon", expanded=False):
        st.caption(
            f"RSI({p['rsi']}) · MA{p['ma_short']}/{p['ma_mid']}/{p['ma_long']} · "
            f"MACD({p['macd_fast']},{p['macd_slow']},{p['macd_signal']}) · "
            f"Stoch({p['stoch_k']},{p['stoch_d']}) · ADX({p['adx']})"
        )
        w = profile["weights"]
        active = [k for k, v in w.items() if v > 0]
        boosted = [k for k, v in w.items() if v > 1]
        disabled = [k for k, v in w.items() if v == 0]
        if boosted:
            st.caption(f"🔼 Boostés (×2) : {', '.join(boosted)}")
        if disabled:
            st.caption(f"⛔ Ignorés : {', '.join(disabled)}")
        st.caption(f"Seuil achat : ≥ {profile['seuil_achat']} | Seuil vente : ≤ {profile['seuil_vente']}")

    st.divider()

    # ── Période de données ────────────────────────────────────────────────────
    periodes_filtrees = {k: v for k, v in PERIODES_DISPONIBLES.items() if v >= jours_min}
    if not periodes_filtrees:
        periodes_filtrees = PERIODES_DISPONIBLES  # fallback

    periode_label = st.selectbox(
        "Période de données",
        options=list(periodes_filtrees.keys()),
        index=len(periodes_filtrees) - 1,
        help=f"Horizon sélectionné : {jours_min} jours min. recommandés"
    )
    days = periodes_filtrees[periode_label]

    analyser_btn = st.button("🔍 Analyser", type="primary", use_container_width=True)

    st.divider()
    with st.expander("ℹ️ Aide — Tickers BRVM"):
        st.markdown("""
**Exemples de tickers :**
- `BICC` — Bici Côte d'Ivoire
- `SGBC` — Société Générale CI
- `ONTBF` — Onatel Burkina Faso
- `PALC` — Palm CI
- `SNTS` — Sonatel Sénégal
- `ETIT` — Ecobank Transnational

[Liste complète sur sikafinance.com](https://www.sikafinance.com)
        """)

    with st.expander("🔧 Cache"):
        stats = cache.stats()
        st.caption(f"Entrées : {stats['entries']} | Taille : {stats['total_size_kb']} Ko")
        if st.button("Vider le cache", use_container_width=True):
            n = cache.clear_all()
            st.success(f"{n} entrée(s) supprimée(s)")


# ─── Logique principale ───────────────────────────────────────────────────────

def _analyser_ticker_worker(ticker: str, days: int, horizon: str) -> dict:
    """
    Pipeline complet pour un ticker, sans appels Streamlit (thread-safe).
    Retourne toujours un dict avec au minimum {"ticker": ticker}.
    En cas d'erreur, ajoute la clé "error" avec l'exception.
    """
    try:
        df = get_ohlcv(ticker, days=days)

        df_index = None
        try:
            df_index = get_ohlcv(BRVM_INDEX_TICKER, days=days)
        except Exception:
            logger.debug(f"Indice BRVMC non disponible pour {ticker}")

        ind = compute_indicators(df, ticker, df_index=df_index, horizon=horizon)
        score = compute_score(ind)
        analyse = build_analyse(ind, score, df)

        news = []
        try:
            news = get_news(ticker, max_items=5)
            analyse.actualites = news
        except Exception:
            logger.debug(f"Actualités non disponibles pour {ticker}")

        return {"ticker": ticker, "df": df, "ind": ind, "score": score, "analyse": analyse, "news": news}

    except (TickerNotFoundError, InsufficientDataError, SourceStructureChangedError) as e:
        return {"ticker": ticker, "error": e, "error_type": type(e).__name__}
    except Exception as e:
        logger.exception(f"Erreur inattendue pour {ticker}")
        return {"ticker": ticker, "error": e, "error_type": "unexpected"}


def analyser_ticker(ticker: str, days: int, horizon: str = DEFAULT_HORIZON) -> Optional[dict]:
    """
    Wrapper Streamlit autour du worker : affiche les messages d'erreur UI.
    Utilisé pour l'analyse ticker unique (hors batch parallèle).
    """
    result = _analyser_ticker_worker(ticker, days, horizon)

    if "error" in result:
        e = result["error"]
        etype = result.get("error_type", "")
        if etype == "TickerNotFoundError":
            st.error(f"❌ **{ticker}** : ticker introuvable sur toutes les sources.\n\n{e}")
        elif etype == "InsufficientDataError":
            st.warning(f"⚠️ **{ticker}** : données insuffisantes.\n\n{e}")
        elif etype == "SourceStructureChangedError":
            st.error(f"🔧 **{ticker}** : structure du site modifiée — mise à jour du scraper requise.\n\n{e}")
        else:
            st.error(f"💥 **{ticker}** : erreur inattendue — {e}")
        return None

    return result


def render_signal_card(result: dict) -> None:
    """Affiche le bloc principal d'un ticker : signal + scorecard + analyse."""
    score = result["score"]
    ind = result["ind"]
    analyse = result["analyse"]
    horizon_label = HORIZON_PROFILES.get(ind.horizon, {}).get("label", ind.horizon)
    horizon_emoji = HORIZON_PROFILES.get(ind.horizon, {}).get("emoji", "📈")

    # ── En-tête ticker ────────────────────────────────────────────────────────
    col1, col2, col3, col4 = st.columns([3, 2, 2, 2])

    with col1:
        st.markdown(f"### {score.ticker}")
        variation_color = "green" if ind.variation_j1_pct >= 0 else "red"
        sign = "+" if ind.variation_j1_pct >= 0 else ""
        st.markdown(
            f"**{ind.cours_actuel:,.0f} FCFA** &nbsp;"
            f"<span style='color:{variation_color};font-size:0.9rem'>"
            f"{sign}{ind.variation_j1_pct:.2f}%</span>"
            f"&nbsp;&nbsp;<span style='font-size:0.78rem;color:#888'>{horizon_emoji} {horizon_label}</span>",
            unsafe_allow_html=True
        )

    with col2:
        signal_class = f"signal-{score.signal.lower()}"
        st.markdown(
            f"<div class='{signal_class}'>{score.signal_emoji} {score.signal}</div>",
            unsafe_allow_html=True
        )
        st.caption(f"Score : {score.score_total:+d} | Confiance : {score.confiance}")

    with col3:
        rsi_label = f"{ind.rsi:.1f}" if ind.rsi else "N/D"
        stoch_label = f"{ind.stoch_k:.0f}/{ind.stoch_d:.0f}" if ind.stoch_k else "N/D"
        st.metric("RSI (14)", rsi_label)
        st.caption(f"Stoch: {stoch_label}")

    with col4:
        st.metric(
            "Perf 1M",
            f"{ind.perf_1m:+.1f}%" if ind.perf_1m is not None else "N/D",
            delta=f"Alpha: {ind.perf_vs_index_1m:+.1f}%" if ind.perf_vs_index_1m is not None else None,
        )
        if ind.adx is not None:
            st.caption(f"ADX: {ind.adx:.0f} ({'forte' if ind.adx > 25 else 'faible'})")

    # ── Scorecard détaillée ───────────────────────────────────────────────────
    with st.expander("📋 Scorecard détaillée", expanded=True):
        for critere in score.criteres:
            points_color = (
                "#0F6E56" if critere.points > 0
                else "#A32D2D" if critere.points < 0
                else "#888"
            )
            points_str = f"{critere.points:+d}" if critere.points != 0 else " 0"
            st.markdown(
                f"<div class='critere-row'>"
                f"<span style='color:{points_color};font-weight:600;min-width:28px;display:inline-block'>{points_str}</span> "
                f"<b>{critere.nom}</b> : {critere.valeur} — "
                f"<span style='color:#666'>{critere.interpretation}</span>"
                f"</div>",
                unsafe_allow_html=True
            )
        st.markdown(
            f"<div style='margin-top:8px;font-weight:600'>Score total : {score.score_total:+d}</div>",
            unsafe_allow_html=True
        )

    # ── Analyse narrative ─────────────────────────────────────────────────────
    with st.expander("🔍 Analyse complète", expanded=True):
        col_a, col_b = st.columns(2)

        with col_a:
            st.markdown("<div class='section-label'>Tendance</div>", unsafe_allow_html=True)
            st.write(analyse.section_tendance)

            st.markdown("<div class='section-label'>Momentum</div>", unsafe_allow_html=True)
            st.write(analyse.section_momentum)

            st.markdown("<div class='section-label'>Niveaux clés</div>", unsafe_allow_html=True)
            st.write(analyse.section_niveaux)

            st.markdown("<div class='section-label'>Stochastic</div>", unsafe_allow_html=True)
            st.write(analyse.section_stochastic)

        with col_b:
            st.markdown("<div class='section-label'>Configuration chartiste</div>", unsafe_allow_html=True)
            st.write(analyse.section_chartiste)

            st.markdown("<div class='section-label'>Volume</div>", unsafe_allow_html=True)
            st.write(analyse.section_volume)

            st.markdown("<div class='section-label'>Force de tendance (ADX)</div>", unsafe_allow_html=True)
            st.write(analyse.section_adx)

            st.markdown("<div class='section-label'>Divergence RSI</div>", unsafe_allow_html=True)
            st.write(analyse.section_divergence)

        if analyse.alertes:
            st.markdown("---")
            st.markdown("<div class='section-label'>Alertes</div>", unsafe_allow_html=True)
            for alerte in analyse.alertes:
                st.markdown(f"<div class='alerte'>{alerte}</div>", unsafe_allow_html=True)

    # ── Actualités ────────────────────────────────────────────────────────────
    news = result.get("news", [])
    with st.expander(f"📰 Actualités ({len(news)} article{'s' if len(news) != 1 else ''})", expanded=bool(news)):
        if news:
            for article in news:
                titre = article.get("titre", "")
                url = article.get("url", "")
                date = article.get("date", "")
                resume = article.get("resume", "")
                source = article.get("source", "")

                if url:
                    st.markdown(f"**[{titre}]({url})**")
                else:
                    st.markdown(f"**{titre}**")
                meta_parts = []
                if date:
                    meta_parts.append(date)
                if source:
                    meta_parts.append(source)
                if meta_parts:
                    st.caption(" — ".join(meta_parts))
                if resume:
                    st.write(resume)
                st.markdown("---")
        else:
            st.info("Aucune actualité récente trouvée pour ce titre.")

    # ── Graphiques ────────────────────────────────────────────────────────────
    with st.expander("📊 Graphiques", expanded=True):
        _render_charts(result)


def _render_charts(result: dict) -> None:
    """Affiche les 3 graphiques Plotly pour un ticker."""
    df = result["df"]
    ind = result["ind"]
    series = ind.series

    if df is None or len(df) < 5:
        st.warning("Données insuffisantes pour les graphiques")
        return

    fig = make_subplots(
        rows=5, cols=1,
        shared_xaxes=True,
        row_heights=[0.42, 0.14, 0.14, 0.14, 0.16],
        vertical_spacing=0.03,
        subplot_titles=("Prix + Moyennes Mobiles + Bollinger", "MACD", "RSI", "Stochastic", "Volume"),
    )

    # ── Chandelier ────────────────────────────────────────────────────────────
    fig.add_trace(go.Candlestick(
        x=df.index,
        open=df["open"], high=df["high"],
        low=df["low"], close=df["close"],
        name="Prix",
        increasing_line_color="#0F6E56",
        decreasing_line_color="#A32D2D",
    ), row=1, col=1)

    # Moyennes mobiles
    def _add_ma(series_dict, label, color, row=1):
        if series_dict:
            dates = list(series_dict.keys())
            vals = list(series_dict.values())
            fig.add_trace(go.Scatter(
                x=dates, y=vals, name=label,
                line=dict(color=color, width=1.5),
                hovertemplate=f"{label}: %{{y:,.0f}}<extra></extra>",
            ), row=row, col=1)

    if "ma20" in series:
        _add_ma(series["ma20"], f"MA{MA_SHORT}", "#378ADD")
    if "ma50" in series:
        _add_ma(series["ma50"], f"MA{MA_MID}", "#BA7517")
    if "ma200" in series:
        _add_ma(series["ma200"], f"MA{MA_LONG}", "#A32D2D")
    elif "ma_lt" in series:
        _add_ma(series["ma_lt"], f"MA{ind.ma_lt_period}", "#A32D2D")

    # Bollinger
    if "bb_upper" in series and "bb_lower" in series:
        for key, label, color in [("bb_upper", "BB Haut", "rgba(127,119,221,0.4)"), ("bb_lower", "BB Bas", "rgba(127,119,221,0.4)")]:
            dates = list(series[key].keys())
            vals = list(series[key].values())
            fig.add_trace(go.Scatter(
                x=dates, y=vals, name=label,
                line=dict(color=color, width=1, dash="dot"),
                hovertemplate=f"{label}: %{{y:,.0f}}<extra></extra>",
            ), row=1, col=1)

    # S/R
    if ind.support:
        fig.add_hline(y=ind.support, line_dash="dash", line_color="#0F6E56",
                      annotation_text=f"S {ind.support:,.0f}", row=1, col=1)
    if ind.resistance:
        fig.add_hline(y=ind.resistance, line_dash="dash", line_color="#A32D2D",
                      annotation_text=f"R {ind.resistance:,.0f}", row=1, col=1)

    # ── MACD (row 2) ──────────────────────────────────────────────────────────
    if "macd" in series and "macd_signal" in series:
        macd_dates = list(series["macd"].keys())
        macd_vals = list(series["macd"].values())
        sig_dates = list(series["macd_signal"].keys())
        sig_vals = list(series["macd_signal"].values())

        fig.add_trace(go.Scatter(
            x=macd_dates, y=macd_vals, name="MACD",
            line=dict(color="#2196F3", width=1.5),
        ), row=2, col=1)
        fig.add_trace(go.Scatter(
            x=sig_dates, y=sig_vals, name="Signal MACD",
            line=dict(color="#FF9800", width=1.2, dash="dot"),
        ), row=2, col=1)

        # Histogramme MACD (vert si positif, rouge si négatif)
        if "macd_hist" in series:
            hist_dates = list(series["macd_hist"].keys())
            hist_vals = list(series["macd_hist"].values())
            hist_colors = ["#0F6E56" if v >= 0 else "#A32D2D" for v in hist_vals]
            fig.add_trace(go.Bar(
                x=hist_dates, y=hist_vals, name="Histogramme MACD",
                marker_color=hist_colors,
                opacity=0.6,
            ), row=2, col=1)

        # Ligne zéro MACD
        fig.add_hline(y=0, line_dash="dash", line_color="#888", line_width=1, row=2, col=1)

    # ── RSI (row 3) ───────────────────────────────────────────────────────────
    if "rsi" in series:
        dates = list(series["rsi"].keys())
        vals = list(series["rsi"].values())
        fig.add_trace(go.Scatter(
            x=dates, y=vals, name="RSI",
            line=dict(color="#7F77DD", width=1.5),
            fill="tozeroy", fillcolor="rgba(127,119,221,0.1)",
        ), row=3, col=1)
        for level, color in [(30, "#0F6E56"), (70, "#A32D2D")]:
            fig.add_hline(y=level, line_dash="dash", line_color=color,
                          line_width=1, row=3, col=1)

    # ── Stochastic (row 4) ────────────────────────────────────────────────────
    if "stoch_k" in series:
        dates_k = list(series["stoch_k"].keys())
        vals_k = list(series["stoch_k"].values())
        fig.add_trace(go.Scatter(
            x=dates_k, y=vals_k, name="%K",
            line=dict(color="#2196F3", width=1.5),
        ), row=4, col=1)
    if "stoch_d" in series:
        dates_d = list(series["stoch_d"].keys())
        vals_d = list(series["stoch_d"].values())
        fig.add_trace(go.Scatter(
            x=dates_d, y=vals_d, name="%D",
            line=dict(color="#FF9800", width=1.2, dash="dot"),
        ), row=4, col=1)
    if "stoch_k" in series or "stoch_d" in series:
        for level, color in [(20, "#0F6E56"), (80, "#A32D2D")]:
            fig.add_hline(y=level, line_dash="dash", line_color=color,
                          line_width=1, row=4, col=1)

    # ── Volume (row 5) ────────────────────────────────────────────────────────
    if "volume" in series and "close" in series:
        dates = list(series["volume"].keys())
        vols = list(series["volume"].values())
        closes = list(series["close"].values())
        colors_vol = [
            "#0F6E56" if i == 0 or closes[i] >= closes[i - 1] else "#A32D2D"
            for i in range(len(closes))
        ]
        fig.add_trace(go.Bar(
            x=dates, y=vols, name="Volume",
            marker_color=colors_vol,
        ), row=5, col=1)

    fig.update_layout(
        height=1000,
        showlegend=True,
        legend=dict(orientation="h", y=1.02, x=0),
        xaxis_rangeslider_visible=False,
        plot_bgcolor="white",
        paper_bgcolor="white",
        font=dict(size=11),
        margin=dict(l=60, r=40, t=40, b=40),
    )
    fig.update_yaxes(gridcolor="#f0f0f0")

    # Supprimer les gaps weekends et jours sans cotation (BRVM fermée sam/dim)
    fig.update_xaxes(
        gridcolor="#f0f0f0",
        rangebreaks=[
            dict(bounds=["sat", "mon"]),  # saute sam→lun
        ]
    )

    # Fixer les axes Y des oscillateurs
    fig.update_yaxes(range=[0, 100], row=3, col=1)   # RSI
    fig.update_yaxes(range=[0, 100], row=4, col=1)   # Stochastic

    st.plotly_chart(fig, use_container_width=True)


def render_recap_table(results: dict) -> None:
    """Affiche le tableau récapitulatif multi-tickers."""
    rows = []
    for ticker, result in results.items():
        if result is None:
            continue
        ind = result["ind"]
        score = result["score"]
        rows.append({
            "Ticker": ticker,
            "Cours (FCFA)": f"{ind.cours_actuel:,.0f}",
            "Var J-1 (%)": f"{ind.variation_j1_pct:+.2f}%",
            "RSI": f"{ind.rsi:.1f}" if ind.rsi else "N/D",
            "Div. RSI": {"haussiere_forte": "↗↗", "haussiere": "↗", "baissiere_forte": "↘↘", "baissiere": "↘"}.get(ind.rsi_divergence, "—"),
            "Stoch %K": f"{ind.stoch_k:.0f}" if ind.stoch_k else "N/D",
            "ADX": f"{ind.adx:.0f}" if ind.adx else "N/D",
            "MA Signal": score_to_ma_label(ind.ma_signal),
            "MACD": ind.macd_signal.capitalize() if ind.macd_signal else "N/D",
            "Perf 1M": f"{ind.perf_1m:+.1f}%" if ind.perf_1m is not None else "N/D",
            "Score": f"{score.score_total:+d}",
            "Signal": f"{score.signal_emoji} {score.signal}",
            "Confiance": score.confiance.capitalize(),
        })

    if not rows:
        return

    df_recap = pd.DataFrame(rows)

    def highlight_signal(val):
        if "ACHAT" in str(val):
            return "background-color: #E1F5EE; color: #0F6E56; font-weight: 600"
        if "VENTE" in str(val):
            return "background-color: #FCEBEB; color: #A32D2D; font-weight: 600"
        if "NEUTRE" in str(val):
            return "background-color: #FAEEDA; color: #BA7517; font-weight: 600"
        return ""

    def highlight_divergence(val):
        s = str(val)
        if "↗↗" in s:
            return "background-color: #E1F5EE; color: #0F6E56; font-weight: 700"
        if "↗" in s:
            return "color: #0F6E56; font-weight: 600"
        if "↘↘" in s:
            return "background-color: #FCEBEB; color: #A32D2D; font-weight: 700"
        if "↘" in s:
            return "color: #A32D2D; font-weight: 600"
        return ""

    styled = df_recap.style.map(highlight_signal, subset=["Signal"]).map(highlight_divergence, subset=["Div. RSI"])
    st.dataframe(styled, use_container_width=True, hide_index=True)


def score_to_ma_label(ma_signal: str) -> str:
    labels = {
        "golden_cross": "🚀 Golden Cross",
        "bullish": "⬆️ Bullish",
        "bearish": "⬇️ Bearish",
        "death_cross": "💀 Death Cross",
        "neutre": "➡️ Neutre",
    }
    return labels.get(ma_signal, ma_signal)


# ─── Point d'entrée ───────────────────────────────────────────────────────────

def main() -> None:
    st.title("📈 BRVM Stock Screener")
    st.caption("Analyse technique multi-critères pour actions BRVM — Investment Pioneers")

    if not analyser_btn or not tickers_combined:
        st.info("👈 Sélectionnez un ou plusieurs titres dans le panneau gauche puis cliquez sur **Analyser**.")
        st.markdown(f"""
**Horizons disponibles :**
- ⚡ **Court terme** (1–4 semaines) : MACD×2, Stochastic×2 — paramètres rapides (RSI 7, MA 10/20/50)
- 📈 **Moyen terme** (1–6 mois) : critères équilibrés — paramètres standards (RSI 14, MA 20/50/200)
- 🏦 **Long terme** (6 mois+) : MA Config×2, Tendance LT×2, Perf relative×2 — paramètres lents (RSI 21, MA 50/100/200)

**Indicateurs calculés :**
RSI, Stochastic, ADX, Moyennes Mobiles adaptatives, Golden/Death Cross, MACD, Bandes de Bollinger,
Volume relatif, Performance vs BRVMC, Supports/Résistances, Configuration chartiste

**Système de scoring :** critères pondérés selon l'horizon → Signal ACHAT / NEUTRE / VENTE
        """)
        return

    tickers = list(dict.fromkeys(tickers_combined))

    if not tickers:
        st.warning("Aucun ticker valide saisi.")
        return

    # Analyser les tickers en parallèle (ThreadPoolExecutor)
    # max_workers = min(nb tickers, 5) pour ne pas surcharger les sources
    results: dict = {}
    max_workers = min(len(tickers), 5)

    with st.spinner(f"Analyse en cours pour {len(tickers)} titre(s)…"):
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_ticker = {
                executor.submit(_analyser_ticker_worker, t, days, horizon): t
                for t in tickers
            }
            for future in as_completed(future_to_ticker):
                ticker = future_to_ticker[future]
                result = future.result()

                if "error" in result:
                    e = result["error"]
                    etype = result.get("error_type", "")
                    if etype == "TickerNotFoundError":
                        st.error(f"❌ **{ticker}** : ticker introuvable sur toutes les sources.\n\n{e}")
                    elif etype == "InsufficientDataError":
                        st.warning(f"⚠️ **{ticker}** : données insuffisantes.\n\n{e}")
                    elif etype == "SourceStructureChangedError":
                        st.error(f"🔧 **{ticker}** : structure du site modifiée.\n\n{e}")
                    else:
                        st.error(f"💥 **{ticker}** : erreur inattendue — {e}")
                    results[ticker] = None
                else:
                    results[ticker] = result

    # Remettre dans l'ordre de sélection (as_completed ne préserve pas l'ordre)
    results = {t: results.get(t) for t in tickers}

    valid_results = {k: v for k, v in results.items() if v is not None}

    if not valid_results:
        st.error("Aucun ticker n'a pu être analysé.")
        return

    # Tableau récapitulatif (si plusieurs tickers)
    if len(valid_results) > 1:
        st.subheader("📊 Tableau récapitulatif")
        render_recap_table(valid_results)
        st.divider()

    # Carte détaillée par ticker
    for ticker, result in valid_results.items():
        with st.container():
            render_signal_card(result)
            st.divider()


if __name__ == "__main__":
    main()
