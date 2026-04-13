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
from config import (
    PERIODES_DISPONIBLES, BRVM_INDEX_TICKER, MA_SHORT, MA_MID, MA_LONG,
    HORIZON_PROFILES, DEFAULT_HORIZON, TICKER_NAMES, TICKER_GROUPS,
)
from evolution import compute_evolution
from export import generate_excel, generate_csv
from fundamentals import get_fundamentals
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
    .fd-metric     { font-size: 0.9rem; padding: 6px 10px; border-radius: 6px;
                     background: #f8f9fa; margin: 4px 0; }
</style>
""", unsafe_allow_html=True)


# ─── Sidebar ──────────────────────────────────────────────────────────────────

with st.sidebar:
    st.title("📈 BRVM Screener")
    st.caption("Investment Pioneers")
    st.divider()

    # ── Sélection des tickers ─────────────────────────────────────────────────
    st.markdown("**Sélection des titres**")

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

    jours_min = profile["jours_min"]
    p = profile["periods"]
    with st.expander("🔍 Paramètres de l'horizon", expanded=False):
        st.caption(
            f"RSI({p['rsi']}) · MA{p['ma_short']}/{p['ma_mid']}/{p['ma_long']} · "
            f"MACD({p['macd_fast']},{p['macd_slow']},{p['macd_signal']}) · "
            f"Stoch({p['stoch_k']},{p['stoch_d']}) · ADX({p['adx']})"
        )
        w = profile["weights"]
        boosted = [k for k, v in w.items() if v > 1]
        disabled = [k for k, v in w.items() if v == 0]
        if boosted:
            st.caption(f"🔼 Boostés (×2) : {', '.join(boosted)}")
        if disabled:
            st.caption(f"⛔ Ignorés : {', '.join(disabled)}")
        st.caption(f"Seuil achat : ≥ {profile['seuil_achat']} | Seuil vente : ≤ {profile['seuil_vente']}")

    st.divider()

    periodes_filtrees = {k: v for k, v in PERIODES_DISPONIBLES.items() if v >= jours_min}
    if not periodes_filtrees:
        periodes_filtrees = PERIODES_DISPONIBLES

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


# ─── Worker d'analyse ─────────────────────────────────────────────────────────

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

        # ── Phase 2 : évolution 3M ────────────────────────────────────────────
        evo = None
        try:
            evo = compute_evolution(df, ticker, df_index=df_index)
        except Exception as e:
            logger.debug(f"Évolution non disponible pour {ticker}: {e}")

        # ── Phase 2 : données fondamentales ──────────────────────────────────
        fd = None
        try:
            fd = get_fundamentals(ticker)
        except Exception as e:
            logger.debug(f"Fondamentaux non disponibles pour {ticker}: {e}")

        return {
            "ticker": ticker,
            "df": df,
            "ind": ind,
            "score": score,
            "analyse": analyse,
            "news": news,
            "evolution": evo,
            "fundamentals": fd,
        }

    except (TickerNotFoundError, InsufficientDataError, SourceStructureChangedError) as e:
        return {"ticker": ticker, "error": e, "error_type": type(e).__name__}
    except Exception as e:
        logger.exception(f"Erreur inattendue pour {ticker}")
        return {"ticker": ticker, "error": e, "error_type": "unexpected"}


def analyser_ticker(ticker: str, days: int, horizon: str = DEFAULT_HORIZON) -> Optional[dict]:
    """Wrapper Streamlit autour du worker."""
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


# ─── Rendu des cartes ticker ──────────────────────────────────────────────────

def render_signal_card(result: dict) -> None:
    """Affiche le bloc principal d'un ticker avec onglets Phase 2."""
    score = result["score"]
    ind = result["ind"]
    analyse = result["analyse"]
    evo = result.get("evolution")
    fd = result.get("fundamentals")
    horizon_label = HORIZON_PROFILES.get(ind.horizon, {}).get("label", ind.horizon)
    horizon_emoji = HORIZON_PROFILES.get(ind.horizon, {}).get("emoji", "📈")

    # ── En-tête ticker ────────────────────────────────────────────────────────
    col1, col2, col3, col4 = st.columns([3, 2, 2, 2])

    with col1:
        st.markdown(f"### {score.ticker}")
        variation_color = "green" if (ind.variation_j1_pct or 0) >= 0 else "red"
        sign = "+" if (ind.variation_j1_pct or 0) >= 0 else ""
        var_str = f"{sign}{ind.variation_j1_pct:.2f}%" if ind.variation_j1_pct is not None else "N/D"
        cours_str = f"{ind.cours_actuel:,.0f} FCFA" if ind.cours_actuel else "N/D"
        st.markdown(
            f"**{cours_str}** &nbsp;"
            f"<span style='color:{variation_color};font-size:0.9rem'>{var_str}</span>"
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

    # ── Onglets Phase 2 ───────────────────────────────────────────────────────
    tab_labels = ["📊 Graphiques", "📋 Scorecard", "🔍 Analyse"]
    if evo is not None:
        tab_labels.append("📅 Évolution 3M")
    if fd is not None and fd.donnees_disponibles:
        tab_labels.append("🏦 Fondamentaux")
    tab_labels.append("📰 Actualités")

    tabs = st.tabs(tab_labels)
    tab_idx = 0

    # ── Onglet Graphiques ─────────────────────────────────────────────────────
    with tabs[tab_idx]:
        _render_charts(result)
    tab_idx += 1

    # ── Onglet Scorecard ──────────────────────────────────────────────────────
    with tabs[tab_idx]:
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
    tab_idx += 1

    # ── Onglet Analyse ────────────────────────────────────────────────────────
    with tabs[tab_idx]:
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
    tab_idx += 1

    # ── Onglet Évolution 3M ───────────────────────────────────────────────────
    if evo is not None:
        with tabs[tab_idx]:
            _render_evolution(evo)
        tab_idx += 1

    # ── Onglet Fondamentaux ───────────────────────────────────────────────────
    if fd is not None and fd.donnees_disponibles:
        with tabs[tab_idx]:
            _render_fondamentaux(fd)
        tab_idx += 1

    # ── Onglet Actualités ─────────────────────────────────────────────────────
    with tabs[tab_idx]:
        news = result.get("news", [])
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


# ─── Rendu Évolution 3M ───────────────────────────────────────────────────────

def _render_evolution(evo) -> None:
    """Affiche l'onglet évolution 3 mois d'un ticker."""
    # Métriques clés
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        perf_val = f"{evo.perf_totale_pct:+.1f}%" if evo.perf_totale_pct is not None else "N/D"
        st.metric("Performance 3M", perf_val)
    with col2:
        vol_val = f"{evo.volatilite_63j:.1f}%" if evo.volatilite_63j else "N/D"
        st.metric("Volatilité annualisée", vol_val)
    with col3:
        dd_val = f"{evo.max_drawdown_pct:.1f}%" if evo.max_drawdown_pct else "N/D"
        st.metric("Max Drawdown", dd_val)
    with col4:
        sharpe_val = f"{evo.sharpe_ratio:.2f}" if evo.sharpe_ratio is not None else "N/D"
        st.metric("Sharpe Ratio", sharpe_val)

    st.markdown("---")

    # Performances glissantes
    if evo.periodes_glissantes:
        st.markdown("**Performances glissantes**")
        perf_rows = []
        for p in evo.periodes_glissantes:
            perf_rows.append({
                "Période": p.label,
                "Début": p.debut.strftime("%d/%m/%Y"),
                "Fin": p.fin.strftime("%d/%m/%Y"),
                "Performance": f"{p.perf_pct:+.2f}%",
                "Alpha vs BRVMC": f"{p.vs_index_pct:+.2f}%" if p.vs_index_pct is not None else "N/D",
            })

        df_perf = pd.DataFrame(perf_rows)

        def color_perf(val):
            s = str(val)
            if s.startswith("+") and s != "+0.00%":
                return "color: #0F6E56; font-weight: 600"
            if s.startswith("-"):
                return "color: #A32D2D; font-weight: 600"
            return ""

        styled = df_perf.style.map(color_perf, subset=["Performance", "Alpha vs BRVMC"])
        st.dataframe(styled, use_container_width=True, hide_index=True)

    # Graphique des rendements journaliers (heatmap simplifiée)
    if evo.heatmap_data:
        st.markdown("**Rendements journaliers**")
        # Transformer la liste plate en bar chart
        dates = [d["date"] for d in evo.heatmap_data[-63:]]
        returns = [d["return_pct"] for d in evo.heatmap_data[-63:]]
        colors = ["#0F6E56" if r >= 0 else "#A32D2D" for r in returns]

        fig_bar = go.Figure(go.Bar(
            x=dates,
            y=returns,
            marker_color=colors,
            name="Rendement %",
            hovertemplate="%{x|%d/%m/%Y}: %{y:+.2f}%<extra></extra>",
        ))
        fig_bar.add_hline(y=0, line_color="#888", line_width=1)
        fig_bar.update_layout(
            height=250,
            margin=dict(l=40, r=20, t=20, b=40),
            plot_bgcolor="white",
            paper_bgcolor="white",
            showlegend=False,
            yaxis_title="Rendement (%)",
        )
        st.plotly_chart(fig_bar, use_container_width=True)

    # Événements détectés
    if evo.evenements:
        st.markdown("**Événements détectés**")
        ev_rows = []
        for ev in evo.evenements:
            ev_rows.append({
                "Date": ev.date.strftime("%d/%m/%Y"),
                "Type": ev.type.replace("_", " ").title(),
                "Prix (FCFA)": f"{ev.prix:,.0f}" if ev.prix else "N/D",
                "Intensité": ev.intensite.capitalize(),
                "Description": ev.description,
            })
        st.dataframe(pd.DataFrame(ev_rows), use_container_width=True, hide_index=True)


# ─── Rendu Fondamentaux ───────────────────────────────────────────────────────

def _render_fondamentaux(fd) -> None:
    """Affiche l'onglet fondamentaux d'un ticker."""
    # Signal fondamental
    signal_color = (
        "#0F6E56" if "ACHAT" in fd.signal_fondamental or "SOLIDE" in fd.signal_fondamental
        else "#A32D2D" if "VENTE" in fd.signal_fondamental or "FAIBLE" in fd.signal_fondamental
        else "#BA7517"
    )
    st.markdown(
        f"<div style='font-size:1.2rem;font-weight:600;color:{signal_color}'>"
        f"{fd.signal_emoji} {fd.signal_fondamental} "
        f"<span style='font-size:0.9rem;color:#666'>(Score : {fd.score_fondamental:+d})</span>"
        f"</div>",
        unsafe_allow_html=True
    )
    st.markdown("---")

    # Métriques principales
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        cap_str = _fmt_large(fd.capitalisation_fcfa)
        st.metric("Capitalisation", cap_str)
    with col2:
        per_str = f"{fd.per:.1f}×" if fd.per else "N/D"
        st.metric("PER", per_str)
    with col3:
        div_str = f"{fd.rendement_dividende_pct:.1f}%" if fd.rendement_dividende_pct else "N/D"
        st.metric("Rdt Dividende", div_str)
    with col4:
        pos_str = f"{fd.position_52s_pct:.0f}%" if fd.position_52s_pct is not None else "N/D"
        st.metric("Position 52 sem.", pos_str)

    # Range 52 semaines
    if fd.plus_haut_52s and fd.plus_bas_52s and fd.position_52s_pct is not None:
        st.markdown(f"""
        **Range 52 semaines** : {fd.plus_bas_52s:,.0f} FCFA → {fd.plus_haut_52s:,.0f} FCFA
        *(position actuelle : {fd.position_52s_pct:.0f}% du range)*
        """)

    if fd.nombre_titres:
        st.caption(f"Nombre de titres : {_fmt_large(fd.nombre_titres)} | Source : {fd.source}")

    # Scorecard fondamentale
    if fd.criteres_fondamentaux:
        st.markdown("**Scorecard fondamentale**")
        for c in fd.criteres_fondamentaux:
            points_color = (
                "#0F6E56" if c["points"] > 0
                else "#A32D2D" if c["points"] < 0
                else "#888"
            )
            st.markdown(
                f"<div class='critere-row'>"
                f"<span style='color:{points_color};font-weight:600;min-width:28px;display:inline-block'>{c['points']:+d}</span> "
                f"<b>{c['nom']}</b> : {c['valeur']} — "
                f"<span style='color:#666'>{c['interpretation']}</span>"
                f"</div>",
                unsafe_allow_html=True
            )


def _fmt_large(value) -> str:
    """Formate un grand nombre lisible."""
    if value is None:
        return "N/D"
    if value >= 1e9:
        return f"{value / 1e9:.1f} Mds"
    if value >= 1e6:
        return f"{value / 1e6:.0f} M"
    if value >= 1e3:
        return f"{value / 1e3:.0f} K"
    return f"{value:,.0f}"


# ─── Rendu graphiques ─────────────────────────────────────────────────────────

def _add_event_annotations(fig, evo, row: int = 1) -> None:
    """Ajoute des annotations verticales pour les événements détectés."""
    if evo is None or not evo.evenements:
        return

    event_colors = {
        "golden_cross": "#0F6E56",
        "death_cross": "#A32D2D",
        "breakout": "#2196F3",
        "breakdown": "#FF5722",
        "volume_spike": "#9C27B0",
        "rsi_extreme": "#FF9800",
    }
    event_symbols = {
        "golden_cross": "☀",
        "death_cross": "💀",
        "breakout": "▲",
        "breakdown": "▼",
        "volume_spike": "⬛",
        "rsi_extreme": "⚡",
    }

    for ev in evo.evenements:
        color = event_colors.get(ev.type, "#888")
        symbol = event_symbols.get(ev.type, "●")
        x_str = ev.date.strftime("%Y-%m-%d") if hasattr(ev.date, "strftime") else str(ev.date)
        fig.add_vline(
            x=x_str,
            line_dash="dot",
            line_color=color,
            line_width=1,
            row=row, col=1,
        )


def _render_charts(result: dict) -> None:
    """Affiche les graphiques Plotly pour un ticker."""
    df = result["df"]
    ind = result["ind"]
    evo = result.get("evolution")
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
        for key, label, color in [
            ("bb_upper", "BB Haut", "rgba(127,119,221,0.4)"),
            ("bb_lower", "BB Bas", "rgba(127,119,221,0.4)"),
        ]:
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

    # Annotations événements
    _add_event_annotations(fig, evo, row=1)

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

        if "macd_hist" in series:
            hist_dates = list(series["macd_hist"].keys())
            hist_vals = list(series["macd_hist"].values())
            hist_colors = ["#0F6E56" if v >= 0 else "#A32D2D" for v in hist_vals]
            fig.add_trace(go.Bar(
                x=hist_dates, y=hist_vals, name="Histogramme MACD",
                marker_color=hist_colors,
                opacity=0.6,
            ), row=2, col=1)

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
    fig.update_xaxes(
        gridcolor="#f0f0f0",
        rangebreaks=[dict(bounds=["sat", "mon"])],
    )
    fig.update_yaxes(range=[0, 100], row=3, col=1)
    fig.update_yaxes(range=[0, 100], row=4, col=1)

    st.plotly_chart(fig, use_container_width=True)


# ─── Tableau récapitulatif ────────────────────────────────────────────────────

def render_recap_table(results: dict) -> None:
    """Affiche le tableau récapitulatif multi-tickers avec colonnes Phase 2."""
    rows = []
    for ticker, result in results.items():
        if result is None:
            continue
        ind = result["ind"]
        score = result["score"]
        evo = result.get("evolution")
        fd = result.get("fundamentals")

        row = {
            "Ticker": ticker,
            "Cours (FCFA)": f"{ind.cours_actuel:,.0f}" if ind.cours_actuel else "N/D",
            "Var J-1": f"{ind.variation_j1_pct:+.2f}%" if ind.variation_j1_pct is not None else "N/D",
            "RSI": f"{ind.rsi:.1f}" if ind.rsi else "N/D",
            "Div. RSI": {"haussiere_forte": "↗↗", "haussiere": "↗", "baissiere_forte": "↘↘", "baissiere": "↘"}.get(ind.rsi_divergence, "—"),
            "MACD": ind.macd_signal.capitalize() if ind.macd_signal else "N/D",
            "ADX": f"{ind.adx:.0f}" if ind.adx else "N/D",
            "Perf 1M": f"{ind.perf_1m:+.1f}%" if ind.perf_1m is not None else "N/D",
            "Alpha": f"{ind.perf_vs_index_1m:+.1f}%" if ind.perf_vs_index_1m is not None else "N/D",
            "Score": f"{score.score_total:+d}",
            "Signal": f"{score.signal_emoji} {score.signal}",
            "Confiance": score.confiance.capitalize(),
        }

        if evo is not None:
            row["Volat. 3M"] = f"{evo.volatilite_63j:.1f}%" if evo.volatilite_63j else "N/D"
            row["Max DD"] = f"{evo.max_drawdown_pct:.1f}%" if evo.max_drawdown_pct else "N/D"

        if fd is not None and fd.donnees_disponibles:
            row["PER"] = f"{fd.per:.1f}×" if fd.per else "N/D"
            row["Rdt Div."] = f"{fd.rendement_dividende_pct:.1f}%" if fd.rendement_dividende_pct else "N/D"
            row["Score Fond."] = f"{fd.score_fondamental:+d}" if fd.donnees_disponibles else "N/D"

        rows.append(row)

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

    style_cols = {"Signal": highlight_signal, "Div. RSI": highlight_divergence}
    styled = df_recap.style
    for col, fn in style_cols.items():
        if col in df_recap.columns:
            styled = styled.map(fn, subset=[col])

    st.dataframe(styled, use_container_width=True, hide_index=True)


# ─── Comparateur ─────────────────────────────────────────────────────────────

def render_comparateur(results: dict) -> None:
    """Affiche le comparateur multi-tickers (performances normalisées, risque, scores)."""
    valid = {t: r for t, r in results.items() if r is not None}
    if len(valid) < 2:
        return

    st.subheader("📊 Comparateur multi-titres")
    tab_perf, tab_risk, tab_scores = st.tabs(["Performance normalisée", "Risque", "Scores comparés"])

    # ── Performance normalisée (base 100) ────────────────────────────────────
    with tab_perf:
        fig_norm = go.Figure()
        for ticker, result in valid.items():
            df = result.get("df")
            if df is None or df.empty or "close" not in df.columns:
                continue
            close = df["close"].dropna()
            if len(close) < 5:
                continue
            base = close.iloc[0]
            if base == 0:
                continue
            normalized = (close / base * 100).round(2)
            fig_norm.add_trace(go.Scatter(
                x=normalized.index,
                y=normalized.values,
                name=ticker,
                mode="lines",
                hovertemplate=f"{ticker}: %{{y:.1f}}<extra></extra>",
            ))

        fig_norm.add_hline(y=100, line_dash="dash", line_color="#888", line_width=1)
        fig_norm.update_layout(
            height=400,
            plot_bgcolor="white",
            paper_bgcolor="white",
            yaxis_title="Base 100",
            legend=dict(orientation="h", y=1.05),
            margin=dict(l=50, r=20, t=30, b=40),
        )
        st.plotly_chart(fig_norm, use_container_width=True)

    # ── Risque (volatilité vs drawdown) ──────────────────────────────────────
    with tab_risk:
        risk_rows = []
        for ticker, result in valid.items():
            evo = result.get("evolution")
            ind = result.get("ind")
            if evo is None:
                continue
            risk_rows.append({
                "Ticker": ticker,
                "Volatilité 3M (%)": round(evo.volatilite_63j, 2) if evo.volatilite_63j else None,
                "Max Drawdown (%)": round(evo.max_drawdown_pct, 2) if evo.max_drawdown_pct else None,
                "Drawdown actuel (%)": round(evo.drawdown_actuel_pct, 2) if evo.drawdown_actuel_pct else None,
                "Sharpe": round(evo.sharpe_ratio, 2) if evo.sharpe_ratio else None,
                "Perf 3M (%)": round(evo.perf_totale_pct, 2) if evo.perf_totale_pct else None,
            })

        if risk_rows:
            df_risk = pd.DataFrame(risk_rows)
            st.dataframe(df_risk, use_container_width=True, hide_index=True)

            # Scatter volatilité vs performance
            df_valid_risk = df_risk.dropna(subset=["Volatilité 3M (%)", "Perf 3M (%)"])
            if len(df_valid_risk) >= 2:
                fig_scatter = go.Figure(go.Scatter(
                    x=df_valid_risk["Volatilité 3M (%)"],
                    y=df_valid_risk["Perf 3M (%)"],
                    mode="markers+text",
                    text=df_valid_risk["Ticker"],
                    textposition="top center",
                    marker=dict(size=12, color="#2196F3"),
                    hovertemplate="<b>%{text}</b><br>Volatilité: %{x:.1f}%<br>Perf 3M: %{y:+.1f}%<extra></extra>",
                ))
                fig_scatter.add_hline(y=0, line_dash="dash", line_color="#888")
                fig_scatter.update_layout(
                    height=350,
                    xaxis_title="Volatilité annualisée (%)",
                    yaxis_title="Performance 3M (%)",
                    plot_bgcolor="white",
                    paper_bgcolor="white",
                    margin=dict(l=50, r=20, t=30, b=40),
                )
                st.plotly_chart(fig_scatter, use_container_width=True)
        else:
            st.info("Données d'évolution non disponibles pour la comparaison de risque.")

    # ── Scores comparés ───────────────────────────────────────────────────────
    with tab_scores:
        score_rows = []
        for ticker, result in valid.items():
            score = result.get("score")
            fd = result.get("fundamentals")
            ind = result.get("ind")
            if score is None:
                continue
            row = {
                "Ticker": ticker,
                "Score technique": score.score_total,
                "Signal": f"{score.signal_emoji} {score.signal}",
                "Confiance": score.confiance.capitalize(),
                "RSI": round(ind.rsi, 1) if ind.rsi else None,
                "ADX": round(ind.adx, 0) if ind.adx else None,
                "Perf 1M (%)": round(ind.perf_1m, 1) if ind.perf_1m is not None else None,
            }
            if fd is not None and fd.donnees_disponibles:
                row["Score fondamental"] = fd.score_fondamental
                row["PER"] = round(fd.per, 1) if fd.per else None
                row["Rdt Div. (%)"] = round(fd.rendement_dividende_pct, 1) if fd.rendement_dividende_pct else None
            score_rows.append(row)

        if score_rows:
            df_scores = pd.DataFrame(score_rows).sort_values("Score technique", ascending=False)

            def hl_signal(val):
                if "ACHAT" in str(val):
                    return "background-color: #E1F5EE; color: #0F6E56; font-weight: 600"
                if "VENTE" in str(val):
                    return "background-color: #FCEBEB; color: #A32D2D; font-weight: 600"
                if "NEUTRE" in str(val):
                    return "background-color: #FAEEDA; color: #BA7517"
                return ""

            styled_scores = df_scores.style.map(hl_signal, subset=["Signal"])
            st.dataframe(styled_scores, use_container_width=True, hide_index=True)


# ─── Export ───────────────────────────────────────────────────────────────────

def render_export_buttons(results: dict) -> None:
    """Affiche les boutons de téléchargement Excel et CSV."""
    valid = {k: v for k, v in results.items() if v is not None}
    if not valid:
        return

    st.subheader("📥 Export")
    col_xl, col_csv, col_spacer = st.columns([2, 2, 4])

    with col_xl:
        try:
            excel_bytes = generate_excel(valid, include_ohlcv=True, include_news=True)
            st.download_button(
                label="⬇️ Télécharger Excel",
                data=excel_bytes,
                file_name=f"brvm_screener_{_today_str()}.xlsx",
                mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                use_container_width=True,
            )
        except Exception as e:
            st.error(f"Erreur génération Excel : {e}")

    with col_csv:
        try:
            csv_bytes = generate_csv(valid)
            st.download_button(
                label="⬇️ Télécharger CSV",
                data=csv_bytes,
                file_name=f"brvm_screener_{_today_str()}.csv",
                mime="text/csv",
                use_container_width=True,
            )
        except Exception as e:
            st.error(f"Erreur génération CSV : {e}")


def _today_str() -> str:
    from datetime import date
    return date.today().strftime("%Y%m%d")


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

**Nouveautés Phase 2 :**
- 📅 Évolution 3M : performances glissantes, volatilité, drawdown, événements (Golden Cross, Breakout…)
- 🏦 Fondamentaux : PER, dividende, capitalisation, position 52 semaines
- 📊 Comparateur : performances normalisées, risque, scores croisés
- 📥 Export Excel multi-onglets et CSV

**Indicateurs techniques :**
RSI, Stochastic, ADX, Moyennes Mobiles, Golden/Death Cross, MACD, Bollinger,
Volume relatif, Performance vs BRVMC, Supports/Résistances
        """)
        return

    tickers = list(dict.fromkeys(tickers_combined))

    if not tickers:
        st.warning("Aucun ticker valide saisi.")
        return

    # Analyser en parallèle
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
                        st.error(f"❌ **{ticker}** : ticker introuvable.\n\n{e}")
                    elif etype == "InsufficientDataError":
                        st.warning(f"⚠️ **{ticker}** : données insuffisantes.\n\n{e}")
                    elif etype == "SourceStructureChangedError":
                        st.error(f"🔧 **{ticker}** : structure du site modifiée.\n\n{e}")
                    else:
                        st.error(f"💥 **{ticker}** : erreur inattendue — {e}")
                    results[ticker] = None
                else:
                    results[ticker] = result

    # Remettre dans l'ordre de sélection
    results = {t: results.get(t) for t in tickers}

    valid_results = {k: v for k, v in results.items() if v is not None}

    if not valid_results:
        st.error("Aucun ticker n'a pu être analysé.")
        return

    # Tableau récapitulatif (multi-tickers)
    if len(valid_results) > 1:
        st.subheader("📊 Tableau récapitulatif")
        render_recap_table(valid_results)
        st.divider()

    # Comparateur (si plusieurs tickers)
    if len(valid_results) > 1:
        render_comparateur(valid_results)
        st.divider()

    # Export
    render_export_buttons(valid_results)
    st.divider()

    # Carte détaillée par ticker
    for ticker, result in valid_results.items():
        with st.container():
            render_signal_card(result)
            st.divider()


if __name__ == "__main__":
    main()
