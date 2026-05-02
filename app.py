"""
app.py — Interface Streamlit du BRVM Stock Screener (Investment Pioneers)

Lancement : streamlit run app.py
"""

import json
import logging
import os
import sys
from datetime import date as date_type, datetime
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots

from analysis import build_analyse
from cache import cache
from config import PERIODES_DISPONIBLES, BRVM_INDEX_TICKER, HORIZON_PROFILES, DEFAULT_HORIZON, TICKER_NAMES, TICKER_GROUPS
from indicators import compute_indicators
from scoring import compute_score
from scraper import get_ohlcv, get_news, TickerNotFoundError, InsufficientDataError, SourceStructureChangedError
from fundamentals import get_fundamentals, FundamentalData
from exports import export_to_excel, export_to_csv
from utils import get_company_name, format_ticker_display, format_fcfa, format_pct, format_variation
from auth import check_auth, logout_button
from tracking import log_signal, update_open_trades

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


# ─── Authentification ────────────────────────────────────────────────────────

if not check_auth():
    st.stop()


# ─── Sidebar ──────────────────────────────────────────────────────────────────

with st.sidebar:
    logout_button()
    st.title("📈 BRVM Screener")
    st.caption("Investment Pioneers")
    st.divider()

    # ── Vue principale ────────────────────────────────────────────────────────
    vue = st.radio(
        "Vue",
        ["📈 Screener", "📒 Journal", "🔬 Backtest", "💼 Portfolio"],
        horizontal=True,
        label_visibility="collapsed",
    )
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

        try:
            log_signal(ind, score)
        except Exception:
            logger.debug(f"[Tracking] log_signal KO pour {ticker}")

        news = []
        try:
            news = get_news(ticker, max_items=5)
            analyse.actualites = news
        except Exception:
            logger.debug(f"Actualités non disponibles pour {ticker}")

        # Données fondamentales
        fundamentals = None
        try:
            fundamentals = get_fundamentals(ticker, cours_actuel=ind.cours_actuel)
        except Exception:
            logger.debug(f"Données fondamentales non disponibles pour {ticker}")

        return {
            "ticker": ticker, "df": df, "ind": ind, "score": score,
            "analyse": analyse, "news": news, "fundamentals": fundamentals,
        }

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
    company = get_company_name(score.ticker)
    col1, col2, col3, col4 = st.columns([3, 2, 2, 2])

    with col1:
        st.markdown(f"### {score.ticker} — {company}")
        var_text, var_color = format_variation(ind.variation_j1_pct)
        st.markdown(
            f"**{format_fcfa(ind.cours_actuel)}** &nbsp;"
            f"<span style='color:{var_color};font-size:0.9rem'>{var_text}</span>"
            f"&nbsp;&nbsp;<span style='font-size:0.78rem;color:#888'>{horizon_emoji} {horizon_label}</span>",
            unsafe_allow_html=True
        )
        # Plus haut / plus bas 52 semaines
        if ind.high_52w and ind.low_52w:
            st.caption(f"52S : {ind.low_52w:,.0f} — {ind.high_52w:,.0f} FCFA"
                       f" ({ind.pct_from_52w_high:+.1f}% du plus haut)" if ind.pct_from_52w_high is not None
                       else f"52S : {ind.low_52w:,.0f} — {ind.high_52w:,.0f} FCFA")

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

    # ── Niveaux de risque D1 ─────────────────────────────────────────────────
    if score.stop_loss is not None and score.take_profit is not None and ind.atr and ind.atr > 0:
        with st.expander("🎯 Niveaux de risque (ATR-based)", expanded=True):
            prix = ind.cours_actuel
            k1 = abs(score.stop_loss  - prix) / ind.atr
            k2 = abs(score.take_profit - prix) / ind.atr
            pct_stop   = (score.stop_loss  - prix) / prix * 100
            pct_target = (score.take_profit - prix) / prix * 100
            rr = k2 / k1 if k1 > 0 else 0.0
            rr_color = "#0F6E56" if rr >= 2.0 else ("#BA7517" if rr >= 1.5 else "#A32D2D")
            rr_label  = "Excellent" if rr >= 2.0 else ("Acceptable" if rr >= 1.5 else "Faible")
            r1, r2, r3, r4 = st.columns(4)
            with r1:
                st.metric(
                    "Stop Loss",
                    f"{score.stop_loss:,.0f} FCFA",
                    delta=f"{pct_stop:+.1f}% / -{k1:.1f} ATR",
                    delta_color="inverse",
                )
            with r2:
                st.metric("Cours actuel", f"{prix:,.0f} FCFA")
            with r3:
                st.metric(
                    "Take Profit",
                    f"{score.take_profit:,.0f} FCFA",
                    delta=f"{pct_target:+.1f}% / +{k2:.1f} ATR",
                )
            with r4:
                st.metric("R/R", f"{rr:.2f}")
                st.markdown(
                    f"<span style='color:{rr_color};font-size:0.8em;font-weight:600'>"
                    f"{rr_label}</span>",
                    unsafe_allow_html=True,
                )
            st.caption(
                f"Confiance {score.confiance} → k1={k1:.1f}×ATR / k2={k2:.1f}×ATR  |  "
                f"ATR = {ind.atr_pct:.2f}% ({ind.atr:,.0f} FCFA)"
            )
            if score.position_size_pct is not None:
                st.info(
                    f"**Sizing indicatif (risque 1% capital, avec haircut liquidité)** : "
                    f"allouer ~{score.position_size_pct:.1f}% du portefeuille sur ce titre.",
                    icon="📐",
                )

    # ── Bouton ajout / clôture portfolio ─────────────────────────────────────
    if score.signal in ("ACHAT", "VENTE"):
        _positions_now = _load_portfolio()
        _in_portfolio  = any(p["ticker"] == score.ticker for p in _positions_now)

        if score.signal == "ACHAT":
            if not _in_portfolio:
                if st.button("➕ Ajouter au Portfolio", key=f"add_port_{score.ticker}", type="primary"):
                    _positions_now.append({
                        "ticker":        score.ticker,
                        "entry_price":   float(ind.cours_actuel),
                        "quantity":      1,
                        "stop_loss":     float(score.stop_loss)   if score.stop_loss   is not None else None,
                        "take_profit":   float(score.take_profit) if score.take_profit is not None else None,
                        "entry_date":    str(date_type.today()),
                        "current_price": float(ind.cours_actuel),
                        "refreshed_at":  datetime.now().strftime("%Y-%m-%d %H:%M"),
                        "signal":        score.signal,
                        "confiance":     score.confiance,
                    })
                    _save_portfolio(_positions_now)
                    st.toast(f"✅ {score.ticker} ajouté au Portfolio !", icon="💼")
                    st.rerun()
            else:
                st.info(f"**{score.ticker}** est déjà dans votre Portfolio.", icon="✅")
                c_upd, c_close = st.columns(2)
                with c_upd:
                    if st.button("✏️ Mettre à jour", key=f"upd_port_{score.ticker}"):
                        for p in _positions_now:
                            if p["ticker"] == score.ticker:
                                p["current_price"] = float(ind.cours_actuel)
                                p["stop_loss"]     = float(score.stop_loss)   if score.stop_loss   is not None else p.get("stop_loss")
                                p["take_profit"]   = float(score.take_profit) if score.take_profit is not None else p.get("take_profit")
                                p["refreshed_at"]  = datetime.now().strftime("%Y-%m-%d %H:%M")
                        _save_portfolio(_positions_now)
                        st.toast(f"✅ {score.ticker} mis à jour.", icon="✏️")
                        st.rerun()
                with c_close:
                    if st.button("📤 Clôturer", key=f"close_port_{score.ticker}", type="secondary"):
                        _positions_now = [p for p in _positions_now if p["ticker"] != score.ticker]
                        _save_portfolio(_positions_now)
                        st.toast(f"📤 Position {score.ticker} clôturée.", icon="📤")
                        st.rerun()

        elif score.signal == "VENTE" and _in_portfolio:
            st.warning(f"**{score.ticker}** : signal VENTE — vous détenez ce titre.", icon="⚠️")
            if st.button("📤 Clôturer la position", key=f"close_port_sell_{score.ticker}", type="primary"):
                _positions_now = [p for p in _positions_now if p["ticker"] != score.ticker]
                _save_portfolio(_positions_now)
                st.toast(f"📤 Position {score.ticker} clôturée.", icon="📤")
                st.rerun()

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

        # Ligne complète pour la vue 3 mois et événements
        if analyse.section_3mois and "insuffisantes" not in analyse.section_3mois:
            st.markdown("<div class='section-label'>Analyse 3 mois</div>", unsafe_allow_html=True)
            st.write(analyse.section_3mois)

        if analyse.section_events and "Aucun" not in analyse.section_events:
            st.markdown("<div class='section-label'>Événements techniques récents</div>", unsafe_allow_html=True)
            st.write(analyse.section_events)

        if analyse.alertes:
            st.markdown("---")
            st.markdown("<div class='section-label'>Alertes</div>", unsafe_allow_html=True)
            for alerte in analyse.alertes:
                st.markdown(f"<div class='alerte'>{alerte}</div>", unsafe_allow_html=True)

    # ── Données fondamentales ────────────────────────────────────────────────
    fundamentals = result.get("fundamentals")
    has_fundamental_data = fundamentals and (
        fundamentals.per or fundamentals.dividende_par_action
        or fundamentals.capitalisation or fundamentals.secteur
    )
    if has_fundamental_data:
        _CONFIANCE_LABEL = {"haute": "✅ Rapport officiel", "moyenne": "🔵 Source publique", "estimee": "🟡 Estimation"}
        confiance_label = _CONFIANCE_LABEL.get(fundamentals.confiance_donnees, "")

        expander_title = "🏦 Données fondamentales"
        if fundamentals.secteur:
            expander_title += f" — {fundamentals.secteur}"
        with st.expander(expander_title, expanded=True):
            # Ligne info : secteur / pays / qualité donnée
            meta_parts = []
            if fundamentals.secteur:
                meta_parts.append(f"**Secteur :** {fundamentals.secteur}")
            if fundamentals.pays:
                meta_parts.append(f"**Pays :** {fundamentals.pays}")
            if confiance_label:
                meta_parts.append(f"{confiance_label} ({fundamentals.dividende_annee})")
            if meta_parts:
                st.caption("  ·  ".join(meta_parts))

            fcol1, fcol2, fcol3, fcol4 = st.columns(4)
            with fcol1:
                if fundamentals.capitalisation:
                    cap_val = fundamentals.capitalisation
                    if cap_val >= 1_000_000:
                        cap_str = f"{cap_val/1_000_000:.2f}T FCFA"
                    elif cap_val >= 1_000:
                        cap_str = f"{cap_val/1_000:.1f}Mrd FCFA"
                    else:
                        cap_str = f"{cap_val:,.0f}M FCFA"
                    st.metric("Capitalisation", cap_str)
                    st.caption(fundamentals.capitalisation_source)
                else:
                    st.metric("Capitalisation", "N/D")
            with fcol2:
                if fundamentals.per:
                    per_color = "#0F6E56" if fundamentals.per < 12 else "#BA7517" if fundamentals.per < 20 else "#A32D2D"
                    per_label = "Décoté" if fundamentals.per < 12 else "Raisonnable" if fundamentals.per < 20 else "Cher"
                    st.metric("PER", f"{fundamentals.per:.1f}×")
                    st.markdown(
                        f"<span style='font-size:0.75rem;color:{per_color}'>{per_label}</span>",
                        unsafe_allow_html=True,
                    )
                else:
                    st.metric("PER", "N/D")
            with fcol3:
                if fundamentals.dividende_par_action:
                    st.metric("Dividende/Action", f"{fundamentals.dividende_par_action:,.0f} FCFA")
                    if fundamentals.rendement_dividende:
                        rdt = fundamentals.rendement_dividende
                        rdt_color = "#0F6E56" if rdt >= 5 else "#BA7517" if rdt >= 3 else "#888"
                        st.markdown(
                            f"<span style='font-size:0.75rem;color:{rdt_color}'>Rendement : {rdt:.1f}%</span>",
                            unsafe_allow_html=True,
                        )
                else:
                    st.metric("Dividende", "N/D")
            with fcol4:
                if fundamentals.score_fondamental is not None:
                    score_color = "#0F6E56" if fundamentals.score_fondamental >= 6 else "#BA7517" if fundamentals.score_fondamental >= 4 else "#A32D2D"
                    st.markdown(
                        f"<div style='text-align:center'>"
                        f"<span style='font-size:2rem;color:{score_color};font-weight:700'>"
                        f"{fundamentals.score_fondamental:.0f}</span>"
                        f"<span style='color:#888'>/10</span>"
                        f"<br><span style='font-size:0.75rem;color:#888'>Score fondamental</span>"
                        f"</div>",
                        unsafe_allow_html=True,
                    )
                else:
                    st.metric("Score fondamental", "N/D")

            # BPA affiché séparément si disponible
            if fundamentals.bpa:
                st.caption(
                    f"BPA : {fundamentals.bpa:,.0f} FCFA  ·  "
                    f"Nb actions : {fundamentals.nb_actions_millions:.1f}M"
                    if fundamentals.nb_actions_millions else f"BPA : {fundamentals.bpa:,.0f} FCFA"
                )

            # Détail du score
            if fundamentals.score_detail:
                with st.expander("Détail du score fondamental"):
                    for key, val in fundamentals.score_detail.items():
                        pts_color = "#0F6E56" if val["points"] >= val["max"] * 0.6 else "#BA7517" if val["points"] >= val["max"] * 0.3 else "#A32D2D"
                        st.markdown(
                            f"<div class='critere-row'>"
                            f"<span style='color:{pts_color};font-weight:600'>"
                            f"{val['points']:.1f}/{val['max']}</span> "
                            f"<b>{key.replace('_', ' ').capitalize()}</b> : {val['comment']}"
                            f"</div>",
                            unsafe_allow_html=True,
                        )

    # ── Actualités ────────────────────────────────────────────────────────────────────────────
    news = result.get("news", [])
    ticker_for_news = score.ticker
    SOURCE_COLORS = {
        "Sika Finance": "#1B5E20", "Financial Afrik": "#0D47A1",
        "Agence Ecofin": "#4A148C", "BRVM Officielle": "#BF360C",
        "La Réussite Financière": "#006064", "Abidjan.net": "#827717",
        "Jeune Afrique": "#1A237E",
    }
    def _source_badge(source):
        color = SOURCE_COLORS.get(source, "#555")
        return f"<span style='background:{color};color:white;font-size:0.7rem;padding:1px 7px;border-radius:10px;font-weight:600'>{source}</span>"
    expander_label = f"📰 Actualités ({len(news)} article{'s' if len(news) != 1 else ''})" if news else "📰 Actualités"
    with st.expander(expander_label, expanded=bool(news)):
        if not st.session_state.get("news_enabled", True):
            st.info("Actualités désactivées. Réactiver via le toggle 📰 dans la sidebar.")
        elif news:
            if any(a.get("date") for a in news):
                st.caption("📅 Articles des 3 derniers mois, triés du plus récent")
            for i, article in enumerate(news):
                titre = article.get("titre", "")
                url = article.get("url", "")
                date = article.get("date", "")
                resume = article.get("resume", "")
                source = article.get("source", "")
                if url:
                    st.markdown(f"<a href='{url}' target='_blank' style='font-weight:600;font-size:0.95rem;text-decoration:none;color:inherit'>🔗 {titre}</a>", unsafe_allow_html=True)
                else:
                    st.markdown(f"**{titre}**")
                meta_parts = []
                if date:
                    meta_parts.append(f"<span style='color:#888;font-size:0.8rem'>📅 {date}</span>")
                if source:
                    meta_parts.append(_source_badge(source))
                if meta_parts:
                    st.markdown(" &nbsp; ".join(meta_parts), unsafe_allow_html=True)
                if resume:
                    st.caption(resume)
                if i < len(news) - 1:
                    st.markdown("---")
            try:
                from news_sources import TICKER_IR_URLS
                ir_url = TICKER_IR_URLS.get(ticker_for_news)
                if ir_url:
                    st.markdown(f"<div style='margin-top:10px;font-size:0.8rem'>📋 <a href='{ir_url}' target='_blank'>Relations Investisseurs — page officielle</a></div>", unsafe_allow_html=True)
            except ImportError:
                pass
        else:
            st.info("Aucune actualité récente trouvée pour ce titre.")
            _SIKA_EXT = {"BOABF": "bf", "CBIBF": "bf", "ONTBF": "bf", "BOAML": "ml", "BOAN": "ne", "BOASN": "sn", "SNTS": "sn", "TTLS": "sn", "ETIT": "tg", "ORAT": "tg", "BOAB": "bj", "BICIB": "bj", "LNBB": "bj"}
            _ext = _SIKA_EXT.get(ticker_for_news.upper(), "ci")
            sika_url = f"https://www.sikafinance.com/marches/cotation_{ticker_for_news.upper()}.{_ext}"
            st.markdown(f"[🔍 Voir la fiche {ticker_for_news} sur Sika Finance]({sika_url})")

    # ── Graphiques ────────────────────────────────────────────────────────────
    with st.expander("📊 Graphiques", expanded=True):
        _render_charts(result)


def _render_charts(result: dict) -> None:
    """Affiche les graphiques Plotly pour un ticker (6 sous-plots + heatmap)."""
    df = result["df"]
    ind = result["ind"]
    series = ind.series
    company = get_company_name(ind.ticker)

    if df is None or len(df) < 5:
        st.warning("Données insuffisantes pour les graphiques")
        return

    tab_main, tab_heatmap = st.tabs(["Graphique complet", "Heatmap rendements"])

    with tab_main:
        fig = make_subplots(
            rows=6, cols=1,
            shared_xaxes=True,
            row_heights=[0.35, 0.12, 0.12, 0.11, 0.12, 0.18],
            vertical_spacing=0.025,
            subplot_titles=(
                f"{company} — Prix + MM + Bollinger",
                "MACD", "RSI", "Stochastic",
                "ADX / +DI / -DI", "Volume",
            ),
        )

        # ── Chandelier ────────────────────────────────────────────────────────
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

        p = HORIZON_PROFILES.get(ind.horizon, HORIZON_PROFILES[DEFAULT_HORIZON])["periods"]
        if "ma20" in series:
            _add_ma(series["ma20"], f"MA{p['ma_short']}", "#378ADD")
        if "ma50" in series:
            _add_ma(series["ma50"], f"MA{p['ma_mid']}", "#BA7517")
        if "ma200" in series:
            _add_ma(series["ma200"], f"MA{p['ma_long']}", "#A32D2D")
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

        # ── Annotations d'événements sur le graphique prix ────────────────────
        events = getattr(ind, "events", [])
        event_symbols = {
            "golden_cross": ("triangle-up", "#0F6E56", "GC"),
            "death_cross": ("triangle-down", "#A32D2D", "DC"),
            "breakout_up": ("arrow-up", "#2196F3", "BO"),
            "breakout_down": ("arrow-down", "#FF5722", "BO"),
            "volume_spike": ("diamond", "#FF9800", "VS"),
            "macd_crossover": ("circle", "#9C27B0", "MC"),
            "rsi_extreme": ("star", "#E91E63", "RSI"),
        }
        for event in events[:8]:
            sym_info = event_symbols.get(event["type"], ("circle", "#888", "?"))
            event_date = pd.Timestamp(event["date"])
            if event_date in df.index:
                price_at_event = float(df.loc[event_date, "high"]) * 1.02
                fig.add_trace(go.Scatter(
                    x=[event_date], y=[price_at_event],
                    mode="markers+text",
                    marker=dict(symbol=sym_info[0], size=10, color=sym_info[1]),
                    text=[sym_info[2]],
                    textposition="top center",
                    textfont=dict(size=8, color=sym_info[1]),
                    name=event["description"][:40],
                    hovertext=event["description"],
                    showlegend=False,
                ), row=1, col=1)

        # ── MACD (row 2) ─────────────────────────────────────────────────────
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
                    marker_color=hist_colors, opacity=0.6,
                ), row=2, col=1)

            fig.add_hline(y=0, line_dash="dash", line_color="#888", line_width=1, row=2, col=1)

        # ── RSI (row 3) ──────────────────────────────────────────────────────
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

        # ── Stochastic (row 4) ───────────────────────────────────────────────
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

        # ── ADX + DI (row 5) ─────────────────────────────────────────────────
        if "adx" in series:
            adx_dates = list(series["adx"].keys())
            adx_vals = list(series["adx"].values())
            fig.add_trace(go.Scatter(
                x=adx_dates, y=adx_vals, name="ADX",
                line=dict(color="#9C27B0", width=2),
            ), row=5, col=1)
            fig.add_hline(y=25, line_dash="dash", line_color="#888",
                          line_width=1, row=5, col=1,
                          annotation_text="Seuil tendance")

        if "plus_di" in series:
            dates_pdi = list(series["plus_di"].keys())
            vals_pdi = list(series["plus_di"].values())
            fig.add_trace(go.Scatter(
                x=dates_pdi, y=vals_pdi, name="+DI",
                line=dict(color="#0F6E56", width=1.2, dash="dot"),
            ), row=5, col=1)
        if "minus_di" in series:
            dates_mdi = list(series["minus_di"].keys())
            vals_mdi = list(series["minus_di"].values())
            fig.add_trace(go.Scatter(
                x=dates_mdi, y=vals_mdi, name="-DI",
                line=dict(color="#A32D2D", width=1.2, dash="dot"),
            ), row=5, col=1)

        # ── Volume (row 6) ───────────────────────────────────────────────────
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
            ), row=6, col=1)

        fig.update_layout(
            height=1200,
            showlegend=True,
            legend=dict(orientation="h", y=1.02, x=0),
            xaxis_rangeslider_visible=False,
            plot_bgcolor="white",
            paper_bgcolor="white",
            font=dict(size=11),
            margin=dict(l=60, r=40, t=50, b=40),
        )
        fig.update_yaxes(gridcolor="#f0f0f0")
        fig.update_xaxes(
            gridcolor="#f0f0f0",
            rangebreaks=[dict(bounds=["sat", "mon"])],
        )
        fig.update_yaxes(range=[0, 100], row=3, col=1)  # RSI
        fig.update_yaxes(range=[0, 100], row=4, col=1)  # Stochastic

        st.plotly_chart(fig, use_container_width=True)

    # ── Heatmap des rendements hebdomadaires ─────────────────────────────────
    with tab_heatmap:
        _render_heatmap(df, company)


def _render_heatmap(df: pd.DataFrame, company_name: str) -> None:
    """Affiche la heatmap des rendements hebdomadaires par mois."""
    if len(df) < 20:
        st.info("Pas assez de données pour la heatmap des rendements.")
        return

    df_weekly = df["close"].resample("W").last().pct_change() * 100
    df_weekly = df_weekly.dropna()

    if df_weekly.empty:
        st.info("Pas assez de données pour la heatmap.")
        return

    # Construire matrice mois × semaine
    df_weekly_frame = pd.DataFrame({"rendement": df_weekly})
    df_weekly_frame["mois"] = df_weekly_frame.index.strftime("%Y-%m")
    df_weekly_frame["semaine"] = df_weekly_frame.index.isocalendar().week.values

    pivot = df_weekly_frame.pivot_table(
        index="mois", columns="semaine", values="rendement", aggfunc="mean"
    )

    # Limiter aux 6 derniers mois pour lisibilité
    pivot = pivot.tail(6)

    fig = go.Figure(data=go.Heatmap(
        z=pivot.values,
        x=[f"S{int(c)}" for c in pivot.columns],
        y=pivot.index.tolist(),
        colorscale=[
            [0, "#A32D2D"], [0.35, "#FCEBEB"],
            [0.5, "#FFFFFF"],
            [0.65, "#E1F5EE"], [1, "#0F6E56"],
        ],
        zmid=0,
        text=[[f"{v:.1f}%" if pd.notna(v) else "" for v in row] for row in pivot.values],
        texttemplate="%{text}",
        hovertemplate="Mois: %{y}<br>Semaine: %{x}<br>Rendement: %{z:.1f}%<extra></extra>",
    ))

    fig.update_layout(
        title=f"Rendements hebdomadaires — {company_name}",
        height=300,
        plot_bgcolor="white",
        paper_bgcolor="white",
        margin=dict(l=80, r=40, t=50, b=40),
    )
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
            "Titre": f"{ticker} — {get_company_name(ticker)}",
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
            "Stop Loss": f"{score.stop_loss:,.0f}" if score.stop_loss is not None else "—",
            "Take Profit": f"{score.take_profit:,.0f}" if score.take_profit is not None else "—",
            "Sizing (%)": f"{score.position_size_pct:.1f}%" if score.position_size_pct is not None else "—",
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


# ─── Backtest ────────────────────────────────────────────────────────────────

def render_backtest_page() -> None:
    """Page Backtest — stratégie long-only, revue bi-mensuelle, tous tickers BRVM hors indices."""
    from backtest import fetch_and_backtest, WARMUP_BARS, INITIAL_CAP, REVIEW_INTERVAL_DAYS, ALL_TICKERS, INDICES

    st.title("🔬 Backtest BRVM")
    st.caption(
        "Long-only · Stop/target Donchian · Frais asymétriques · "
        "Tous les tickers actions BRVM (hors indices) · Aucun look-ahead."
    )

    # ── Paramètres ────────────────────────────────────────────────────────────
    with st.form("backtest_form"):
        col1, col2, col3 = st.columns(3)

        with col1:
            # Tous les tickers actions (hors indices) sélectionnés par défaut
            tickers_bt = st.multiselect(
                "Tickers (hors indices)",
                options=ALL_TICKERS,
                default=ALL_TICKERS,
                format_func=lambda t: f"{t} — {TICKER_NAMES.get(t, t)}",
                help="Tous les tickers actions BRVM. Les indices sont exclus.",
            )
            data_period_bt = st.radio(
                "Historique",
                options=["daily", "monthly"],
                format_func=lambda x: "📅 1 an — journalier (~260 barres)" if x == "daily" else "📆 5 ans — mensuel (~60 barres)",
                index=0,
                help="Journalier : API SikaFinance ~260 barres. Mensuel : ~60 barres mensuelles couvrant 5 ans (2021–2026).",
            )

        with col2:
            horizon_bt = st.selectbox(
                "Horizon d'analyse",
                options=list(HORIZON_PROFILES.keys()),
                index=list(HORIZON_PROFILES.keys()).index(DEFAULT_HORIZON),
                format_func=lambda k: f"{HORIZON_PROFILES[k]['emoji']} {HORIZON_PROFILES[k]['label']}",
            )
            _hp = HORIZON_PROFILES.get(horizon_bt, {})
            if data_period_bt == "monthly":
                _default_review  = 30
                _default_holding = _hp.get("max_holding_days", 90) * 2
                _rev_max, _hold_max = 60, 730
            else:
                _default_review  = _hp.get("review_interval_days", REVIEW_INTERVAL_DAYS)
                _default_holding = _hp.get("max_holding_days", 90)
                _rev_max, _hold_max = 30, 200
            review_bt = st.slider(
                "Fréquence de revue (jours)",
                min_value=3, max_value=_rev_max, value=_default_review, step=1,
                help="Tous les N jours calendaires : réévaluation des signaux + ouvertures éventuelles.",
            )
            holding_bt = st.slider(
                "Durée max de détention (jours)",
                min_value=15, max_value=_hold_max, value=_default_holding, step=5,
                help="Court terme ~30j · Moyen terme ~90j · Long terme ~180j",
            )

        with col3:
            capital_bt = st.number_input(
                "Capital initial (FCFA)",
                min_value=100_000,
                max_value=100_000_000,
                value=int(INITIAL_CAP),
                step=100_000,
                format="%d",
            )
            _warmup_default = 12 if data_period_bt == "monthly" else WARMUP_BARS
            _warmup_max     = 20 if data_period_bt == "monthly" else 55
            warmup_bt = st.slider(
                "Warmup (barres min)",
                min_value=5, max_value=_warmup_max, value=_warmup_default, step=1,
                help="Barres nécessaires avant le 1er signal.",
            )
            use_fees_bt = st.checkbox(
                "Inclure les frais de transaction",
                value=True,
                help="Décocher pour voir la performance brute sans friction.",
            )
            fee_bt = st.number_input(
                "Frais par côté (%)",
                min_value=0.0, max_value=5.0, value=1.43, step=0.05, format="%.2f",
                help="Phoenix Capital Management : ~1.43% par côté (entrée sur valeur achat, sortie sur valeur vente).",
                disabled=not use_fees_bt,
            )
            debug_bt = st.checkbox("Mode debug (console)", value=False)

        st.markdown("**Filtrer par niveau de confiance**")
        c1, c2, c3 = st.columns(3)
        with c1:
            cb_forte   = st.checkbox("💪 Forte",   value=True, key="bt_conf_forte")
        with c2:
            cb_moderee = st.checkbox("📊 Modérée", value=True, key="bt_conf_moderee")
        with c3:
            cb_faible  = st.checkbox("🔸 Faible",  value=True, key="bt_conf_faible")

        run_btn = st.form_submit_button("▶ Lancer le backtest", type="primary", use_container_width=True)

    if not run_btn:
        st.info(
            f"**Stratégie** : entrée sur signal ACHAT lors de chaque revue (/{review_bt if 'review_bt' in dir() else REVIEW_INTERVAL_DAYS}j), "
            f"sortie sur stop loss, take profit ou signal ≠ ACHAT à la revue suivante. "
            f"Pas de short (interdit sur la BRVM)."
        )
        return

    if not tickers_bt:
        st.warning("Sélectionnez au moins un ticker.")
        return

    confiances_bt = [c for c, v in [("forte", cb_forte), ("modérée", cb_moderee), ("faible", cb_faible)] if v]
    if not confiances_bt:
        st.warning("Cochez au moins un niveau de confiance.")
        return

    _period_label = "mensuel 5 ans" if data_period_bt == "monthly" else "journalier 1 an"
    with st.spinner(f"Backtest en cours — {len(tickers_bt)} tickers, {_period_label}, revue /{review_bt}j…"):
        try:
            _days = 60 if data_period_bt == "monthly" else 730
            _max_atr = 25.0 if data_period_bt == "monthly" else 4.0
            _min_atr = 3.0  if data_period_bt == "monthly" else 2.0
            result = fetch_and_backtest(
                tickers_bt,
                days=_days,
                data_period=data_period_bt,
                initial_capital=float(capital_bt),
                horizon=horizon_bt,
                warmup_bars=warmup_bt,
                review_interval_days=review_bt,
                max_holding_days=holding_bt,
                confiance_filter=confiances_bt,
                max_atr_pct=_max_atr,
                min_atr_pct=_min_atr,
                fee_entry_pct=float(fee_bt) if use_fees_bt else 0.0,
                fee_exit_pct=float(fee_bt) if use_fees_bt else 0.0,
                debug=debug_bt,
            )
        except RuntimeError as e:
            st.error(f"Erreur : {e}")
            return
        except Exception as e:
            st.error(f"Erreur inattendue : {e}")
            logger.exception("Backtest erreur")
            return

    s = result.summary

    if s.get("status") != "ok":
        st.warning(f"Aucun trade généré ({s.get('status')}). Augmentez l'historique ou ajoutez des tickers.")
        return

    # ── KPIs globaux ─────────────────────────────────────────────────────────
    st.subheader("Résultats globaux")
    m1, m2, m3, m4, m5 = st.columns(5)
    m1.metric("Trades", s["n_trades"], f"W={s['n_wins']} / L={s['n_losses']}")
    m2.metric("Win Rate", f"{s['win_rate_pct']}%", help="Break-even ≈ 33% avec R/R=2.0")
    m3.metric("Expectancy", f"{s['expectancy_pct']:+.2f}%")
    m4.metric("Return total", f"{s['total_return_pct']:+.2f}%")
    m5.metric("Max Drawdown", f"{s['max_drawdown_pct']:.1f}%", delta_color="inverse")

    r1, r2, r3, r4, r5 = st.columns(5)
    r1.metric("Capital final", f"{s['final_capital']:,.0f} FCFA",
              delta=f"{s['total_return_pct']:+.1f}%")
    gain_net = s.get("gain_net_fcfa", 0)
    r2.metric("Gain net", f"{gain_net:+,.0f} FCFA",
              delta=f"{s['total_return_pct']:+.2f}%",
              delta_color="normal")
    r3.metric("R réalisé moy.", f"{s['avg_r_realise']}R" if s.get("avg_r_realise") else "—")
    r4.metric("Durée moy.", f"{s['avg_holding_days']:.0f}j")
    r5.metric("Expectancy pondérée", f"{s['expectancy_weighted']:.3f}%" if s.get("expectancy_weighted") else "—",
              help="E × position moy. / 100")

    st.divider()

    # ── Equity curve ─────────────────────────────────────────────────────────
    if not result.equity_curve.empty:
        st.subheader("Courbe d'équité")
        eq = result.equity_curve.copy()
        eq["date"] = pd.to_datetime(eq["date"])

        fig_eq = go.Figure()
        fig_eq.add_trace(go.Scatter(
            x=eq["date"], y=eq["equity"],
            name="Capital", mode="lines",
            line=dict(color="#0F6E56", width=2),
            fill="tozeroy", fillcolor="rgba(15,110,86,0.08)",
        ))
        fig_eq.add_hline(
            y=float(capital_bt), line_dash="dash",
            line_color="#888", annotation_text="Capital initial",
        )
        fig_eq.update_layout(
            height=320, plot_bgcolor="white", paper_bgcolor="white",
            yaxis_title="Capital (FCFA)", margin=dict(l=60, r=40, t=30, b=40),
        )
        fig_eq.update_yaxes(gridcolor="#f0f0f0")
        fig_eq.update_xaxes(gridcolor="#f0f0f0")
        st.plotly_chart(fig_eq, use_container_width=True)

        # Drawdown
        fig_dd = go.Figure()
        fig_dd.add_trace(go.Scatter(
            x=eq["date"], y=-eq["drawdown_pct"],
            name="Drawdown", mode="lines",
            line=dict(color="#A32D2D", width=1.5),
            fill="tozeroy", fillcolor="rgba(163,45,45,0.12)",
        ))
        fig_dd.update_layout(
            height=180, plot_bgcolor="white", paper_bgcolor="white",
            yaxis_title="Drawdown (%)", margin=dict(l=60, r=40, t=10, b=40),
        )
        fig_dd.update_yaxes(gridcolor="#f0f0f0")
        fig_dd.update_xaxes(gridcolor="#f0f0f0")
        st.plotly_chart(fig_dd, use_container_width=True)

    st.divider()

    # ── Distribution des sorties ──────────────────────────────────────────────
    by_exit = s.get("by_exit_reason", {})
    if by_exit:
        st.subheader("Distribution des sorties")
        icons = {"stop": "🔴", "target": "🟢", "timeout": "⏱️", "end_of_backtest": "⏹️"}
        ec = st.columns(max(len(by_exit), 1))
        for i, (reason, stats) in enumerate(by_exit.items()):
            with ec[i]:
                st.metric(
                    f"{icons.get(reason, '')} {reason.replace('_', ' ').capitalize()}",
                    f"{stats['n']} trades",
                    f"PnL moy : {stats['avg_pnl']:+.1f}%",
                )
                st.caption(f"Durée moy. : {stats['avg_days']:.0f}j")
        st.divider()

    # ── Par confiance ─────────────────────────────────────────────────────────
    if result.by_confiance:
        st.subheader("Performance par confiance (C1)")
        st.caption("Test clé : *forte* surperforme-t-elle *faible* ?")
        cc = st.columns(3)
        for i, conf in enumerate(["forte", "modérée", "faible"]):
            stats = result.by_confiance.get(conf)
            with cc[i]:
                if stats:
                    st.markdown(f"**{conf.capitalize()}** — n={stats['n']}")
                    st.metric("Win Rate",   f"{stats['win_rate_pct']}%")
                    st.metric("Expectancy", f"{stats['expectancy_pct']:+.2f}%")
                    st.caption(f"Durée moy. : {stats['avg_days']:.0f}j")
                else:
                    st.markdown(f"**{conf.capitalize()}** — aucun trade")
        st.divider()

    # ── Par ticker ────────────────────────────────────────────────────────────
    if result.by_ticker:
        st.subheader("Performance par ticker")
        bt_rows = []
        for ticker, stats in result.by_ticker.items():
            bt_rows.append({
                "Ticker": f"{ticker} — {TICKER_NAMES.get(ticker, ticker)}",
                "Trades": stats["n"],
                "Win Rate": f"{stats['win_rate_pct']}%",
                "PnL moyen": f"{stats['avg_pnl_pct']:+.2f}%",
                "PnL total": f"{stats['total_pnl_pct']:+.2f}%",
                "Durée moy.": f"{stats['avg_days']:.0f}j",
            })
        st.dataframe(
            pd.DataFrame(bt_rows).sort_values("PnL moyen", ascending=False),
            use_container_width=True, hide_index=True,
        )
        st.divider()

    # ── Historique des trades ─────────────────────────────────────────────────
    if not result.trades.empty:
        st.subheader(f"Historique des trades ({len(result.trades)})")
        disp = result.trades[[
            "entry_date", "exit_date", "ticker", "confiance", "score",
            "position_pct", "capital_investi_fcfa",
            "entry_price", "exit_price", "exit_reason",
            "pnl_pct", "gain_fcfa", "r_realise", "holding_days",
        ]].copy()
        disp.columns = [
            "Entrée", "Sortie", "Ticker", "Confiance", "Score",
            "Alloc %", "Capital investi (FCFA)",
            "Prix entrée", "Prix sortie", "Raison",
            "PnL (%)", "Gain (FCFA)", "R réalisé", "Durée (j)",
        ]
        disp["PnL (%)"] = pd.to_numeric(disp["PnL (%)"], errors="coerce").round(2)
        disp["Gain (FCFA)"] = pd.to_numeric(disp["Gain (FCFA)"], errors="coerce")
        disp["Capital investi (FCFA)"] = pd.to_numeric(disp["Capital investi (FCFA)"], errors="coerce")

        def _color_num(val):
            try:
                v = float(val)
                if v > 0:
                    return "color: #0F6E56; font-weight: 600"
                if v < 0:
                    return "color: #A32D2D; font-weight: 600"
            except (ValueError, TypeError):
                pass
            return ""

        styled = (
            disp.sort_values("Entrée", ascending=False)
            .style
            .map(_color_num, subset=["PnL (%)", "Gain (FCFA)"])
            .format({
                "Capital investi (FCFA)": "{:,.0f}",
                "Gain (FCFA)":            "{:+,.0f}",
                "PnL (%)":                "{:+.2f}",
                "Alloc %":                "{:.1f}%",
            }, na_rep="—")
        )
        st.dataframe(styled, use_container_width=True, hide_index=True)


# ─── Point d'entrée ───────────────────────────────────────────────────────────

def _render_open_trades(open_df: pd.DataFrame, today) -> None:
    from tracking import _TIMEOUT_DAYS
    st.subheader(f"Trades ouverts ({len(open_df)})")
    disp = open_df[["date", "ticker", "signal", "confiance", "score",
                     "entry_price", "stop_loss", "take_profit", "rr",
                     "position_pct", "atr_pct"]].copy()
    disp["jours"] = pd.to_datetime(disp["date"]).apply(
        lambda x: (today - x.date()).days
    )
    disp["restants"] = (_TIMEOUT_DAYS - disp["jours"]).clip(lower=0)
    disp.columns = [
        "Date", "Ticker", "Signal", "Confiance", "Score",
        "Entrée", "Stop", "Target", "R/R", "Pos%", "ATR%",
        "Jours détenus", "Jours restants",
    ]
    st.dataframe(
        disp.sort_values("Jours détenus", ascending=False),
        use_container_width=True,
        hide_index=True,
    )


def render_journal_dashboard() -> None:
    """Dashboard KPI branché sur journal_signaux.csv."""
    from tracking import get_kpis, get_open_trades, get_closed_trades
    # date_type already imported at module level

    st.title("📒 Journal de Trading")
    st.caption("Signaux ACHAT/VENTE enregistrés automatiquement — sortie sur stop / target / timeout 20 séances")

    kpis  = get_kpis()
    today = date_type.today()

    # ── Section 1 : métriques globales ───────────────────────────────────────
    n_closed = kpis.get("n_closed", 0)
    n_open   = kpis.get("n_open",   0)

    if kpis.get("status") == "no_data":
        st.info("📭 Aucun signal enregistré. Le journal se remplit automatiquement à chaque analyse.")
        open_df = get_open_trades()
        if not open_df.empty:
            _render_open_trades(open_df, today)
        return

    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("Clôturés",   n_closed)
    c2.metric("Ouverts",    n_open)
    c3.metric("Hit Rate",   f"{kpis['hit_rate_pct']}%")
    c4.metric("Expectancy", f"{kpis['expectancy_pct']:+.1f}%",
              help="Break-even ≈ 0%. Avec R/R=2.0, rentable dès ~33% hit rate.")
    c5.metric("Durée moy.", f"{kpis['avg_holding_days']:.0f}j")

    # Ligne 2 — métriques capital-adjusted
    r1, r2, r3, r4 = st.columns(4)
    exp_w = kpis.get("expectancy_weighted_pct")
    avg_r = kpis.get("avg_r_realise")
    avg_p = kpis.get("avg_position_pct")
    r1.metric("Expectancy pondérée",
              f"{exp_w:.2f}%" if exp_w is not None else "—",
              help="E × position moy. / 100 — rendement réel sur capital alloué")
    r2.metric("R réalisé moyen",
              f"{avg_r:.2f}R" if avg_r is not None else "—",
              help="PnL / risque initial normalisé (cross-tickers)")
    r3.metric("Position moy.",
              f"{avg_p:.1f}%" if avg_p is not None else "—",
              help="Taille moyenne allouée par trade (D2)")
    r4.metric("Break-even hit rate",
              "33%" if kpis.get("win_loss_ratio") else "—",
              help="Avec R/R=2.0 : seuil de profitabilité théorique")

    st.divider()

    # ── Section 2 : trades ouverts ────────────────────────────────────────────
    open_df = get_open_trades()
    if not open_df.empty:
        _render_open_trades(open_df, today)
        st.divider()

    # ── Section 3 : ventilation par confiance (C1) ────────────────────────────
    by_conf = kpis.get("by_confiance", {})
    if by_conf:
        st.subheader("Performance par niveau de confiance (C1)")
        st.caption("Le test clé : est-ce que *forte* surperforme *faible* ?")
        cols = st.columns(3)
        for i, conf in enumerate(["forte", "modérée", "faible"]):
            stats = by_conf.get(conf)
            with cols[i]:
                if stats:
                    delta_color = "normal" if stats["hit_rate_pct"] >= 50 else "inverse"
                    st.markdown(f"**{conf.capitalize()}** — n={stats['n']}")
                    st.metric("Hit Rate",   f"{stats['hit_rate_pct']}%")
                    st.metric("Expectancy", f"{stats['expectancy_pct']:+.1f}%")
                    st.caption(f"Durée moy. : {stats['avg_days']:.0f}j")
                else:
                    st.markdown(f"**{conf.capitalize()}** — aucun trade")
        st.divider()

    # ── Section 4 : distribution des sorties ─────────────────────────────────
    by_reason = kpis.get("by_reason", {})
    if by_reason:
        st.subheader("Distribution des sorties")
        icons   = {"stop": "🔴", "target": "🟢", "timeout": "⏱️"}
        r_cols  = st.columns(max(len(by_reason), 1))
        for i, (reason, stats) in enumerate(by_reason.items()):
            with r_cols[i]:
                st.metric(
                    f"{icons.get(reason, '')} {reason.capitalize()}",
                    f"{stats['n']} trades",
                    f"PnL moy : {stats['avg_pnl']:+.1f}%",
                )
                st.caption(f"Durée moy. : {stats['avg_days']:.0f}j")
        st.divider()

    # ── Section 5 : historique ────────────────────────────────────────────────
    st.subheader("Historique des trades clôturés")
    closed_df = get_closed_trades()
    if not closed_df.empty:
        disp = closed_df[[
            "date", "ticker", "signal", "confiance", "score",
            "entry_price", "exit_price", "exit_reason", "pnl_pct", "rr",
        ]].copy()
        disp.columns = [
            "Date", "Ticker", "Signal", "Confiance", "Score",
            "Entrée", "Sortie", "Raison", "PnL (%)", "R/R",
        ]
        disp["PnL (%)"] = pd.to_numeric(disp["PnL (%)"], errors="coerce").round(2)
        st.dataframe(
            disp.sort_values("Date", ascending=False),
            use_container_width=True,
            hide_index=True,
        )


# ─── Portfolio Tracker ────────────────────────────────────────────────────────

_PORTFOLIO_FILE = os.path.join(os.path.dirname(__file__), "portfolio.json")
_GH_PORT_FILE   = "portfolio.json"
_PORT_SS_KEY    = "_portfolio_data"   # clé session_state

ALERT_STOP_PCT  = 5.0   # rouge si prix à moins de X% du stop
ALERT_TGT_PCT   = 3.0   # vert si prix à moins de X% du target (ou dépassé)


def _gh_port_creds() -> tuple:
    try:
        token = st.secrets.get("GITHUB_TOKEN", "")
        repo  = st.secrets.get("GITHUB_REPO",  "")
        if token and repo:
            return token, repo
    except Exception:
        pass
    return None, None


def _portfolio_from_disk() -> list[dict]:
    """Charge depuis GitHub puis local — utilisé uniquement au démarrage."""
    import base64, requests as _req
    token, repo = _gh_port_creds()
    if token:
        try:
            url  = f"https://api.github.com/repos/{repo}/contents/{_GH_PORT_FILE}"
            hdrs = {"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
            resp = _req.get(url, headers=hdrs, timeout=10)
            if resp.status_code == 200:
                return json.loads(base64.b64decode(resp.json()["content"]).decode("utf-8"))
            if resp.status_code == 404:
                return []
        except Exception as e:
            logger.warning(f"[Portfolio] GitHub load failed — {e}")
    if os.path.exists(_PORTFOLIO_FILE):
        try:
            with open(_PORTFOLIO_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []


def _load_portfolio() -> list[dict]:
    """Lit depuis session_state (chargé depuis disque au 1er appel de la session)."""
    if _PORT_SS_KEY not in st.session_state:
        st.session_state[_PORT_SS_KEY] = _portfolio_from_disk()
    return list(st.session_state[_PORT_SS_KEY])


def _persist_portfolio_bg(positions: list[dict]) -> None:
    """Persiste en arrière-plan (thread) — ne bloque jamais le UI."""
    import base64, requests as _req, threading

    def _run():
        token, repo = _gh_port_creds()
        if token:
            try:
                url     = f"https://api.github.com/repos/{repo}/contents/{_GH_PORT_FILE}"
                hdrs    = {"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
                content = base64.b64encode(json.dumps(positions, ensure_ascii=False, indent=2).encode()).decode()
                sha_r   = _req.get(url, headers=hdrs, timeout=10)
                sha     = sha_r.json().get("sha") if sha_r.status_code == 200 else None
                payload = {"message": "portfolio: mise à jour", "content": content}
                if sha:
                    payload["sha"] = sha
                _req.put(url, headers=hdrs, json=payload, timeout=15)
                return
            except Exception as e:
                logger.warning(f"[Portfolio] GitHub save failed — {e}")
        try:
            with open(_PORTFOLIO_FILE, "w", encoding="utf-8") as f:
                json.dump(positions, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"[Portfolio] Local save failed — {e}")

    threading.Thread(target=_run, daemon=True).start()


def _save_portfolio(positions: list[dict]) -> None:
    """Met à jour session_state immédiatement (sync), puis persiste en background."""
    st.session_state[_PORT_SS_KEY] = list(positions)
    _persist_portfolio_bg(positions)


def _fetch_price(ticker: str) -> float | None:
    try:
        df = get_ohlcv(ticker, days=5)
        if df is not None and not df.empty:
            return float(df["close"].iloc[-1])
    except Exception:
        pass
    return None


def render_portfolio_page() -> None:
    st.title("💼 Portfolio Tracker")
    st.caption("Suivi en temps réel de vos positions — P&L, distance stop/target, alertes")

    positions = _load_portfolio()

    # ── Rafraîchir les prix ────────────────────────────────────────────────────
    if st.button("🔄 Rafraîchir les prix", key="port_refresh"):
        for pos in positions:
            p = _fetch_price(pos["ticker"])
            if p is not None:
                pos["current_price"] = p
                pos["refreshed_at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
        _save_portfolio(positions)
        st.rerun()

    # ── Alertes ───────────────────────────────────────────────────────────────
    alerts_stop   = []
    alerts_target = []
    for pos in positions:
        cp = pos.get("current_price")
        if cp is None:
            continue
        ep = pos["entry_price"]
        sl = pos.get("stop_loss")
        tp = pos.get("take_profit")
        if sl and sl > 0:
            dist_stop_pct = (cp - sl) / cp * 100
            if dist_stop_pct <= ALERT_STOP_PCT:
                alerts_stop.append((pos["ticker"], cp, sl, dist_stop_pct))
        if tp and tp > 0:
            dist_tgt_pct = (tp - cp) / cp * 100
            if dist_tgt_pct <= ALERT_TGT_PCT:
                alerts_target.append((pos["ticker"], cp, tp, dist_tgt_pct))

    if alerts_stop:
        for tk, cp, sl, d in alerts_stop:
            st.error(f"🔴 **{tk}** — Prix actuel {cp:,.0f} FCFA à seulement {d:.1f}% au-dessus du stop ({sl:,.0f} FCFA)")
    if alerts_target:
        for tk, cp, tp, d in alerts_target:
            st.success(f"🟢 **{tk}** — Target {tp:,.0f} FCFA à portée ! Prix actuel {cp:,.0f} FCFA (écart {d:.1f}%)")

    # ── Tableau des positions ─────────────────────────────────────────────────
    if positions:
        rows = []
        total_invested = 0.0
        total_pnl_fcfa = 0.0
        for pos in positions:
            cp   = pos.get("current_price")
            ep   = pos["entry_price"]
            qty  = pos["quantity"]
            sl   = pos.get("stop_loss")
            tp   = pos.get("take_profit")
            inv  = ep * qty

            if cp is not None:
                pnl_pct  = (cp - ep) / ep * 100
                pnl_fcfa = (cp - ep) * qty
                dist_stop_pct = (cp - sl) / cp * 100 if (sl and sl > 0) else None
                dist_tgt_pct  = (tp - cp) / cp * 100 if (tp and tp > 0) else None
                if pnl_pct >= 3:
                    statut = "🟢"
                elif pnl_pct <= -3:
                    statut = "🔴"
                else:
                    statut = "🟡"
            else:
                pnl_pct = pnl_fcfa = dist_stop_pct = dist_tgt_pct = None
                statut = "⚪"

            total_invested += inv
            if pnl_fcfa is not None:
                total_pnl_fcfa += pnl_fcfa

            rows.append({
                "": statut,
                "Ticker": pos["ticker"],
                "Entrée": f"{ep:,.0f}",
                "Qté": qty,
                "Actuel": f"{cp:,.0f}" if cp else "—",
                "PnL %": f"{pnl_pct:+.2f}%" if pnl_pct is not None else "—",
                "PnL FCFA": f"{pnl_fcfa:+,.0f}" if pnl_fcfa is not None else "—",
                "Investi FCFA": f"{inv:,.0f}",
                "Dist. Stop": f"{dist_stop_pct:.1f}%" if dist_stop_pct is not None else "—",
                "Dist. Target": f"{dist_tgt_pct:.1f}%" if dist_tgt_pct is not None else "—",
                "Stop": f"{sl:,.0f}" if sl else "—",
                "Target": f"{tp:,.0f}" if tp else "—",
                "Date entrée": pos.get("entry_date", "—"),
                "MàJ": pos.get("refreshed_at", "—"),
            })

        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

        # Totaux
        c1, c2, c3 = st.columns(3)
        c1.metric("Capital investi", f"{total_invested:,.0f} FCFA")
        c2.metric("P&L total", f"{total_pnl_fcfa:+,.0f} FCFA",
                  delta=f"{total_pnl_fcfa / total_invested * 100:+.2f}%" if total_invested else None)
        c3.metric("Positions ouvertes", len(positions))
        st.divider()

    # ── Ajouter une position ───────────────────────────────────────────────────
    with st.expander("➕ Ajouter une position", expanded=not positions):
        all_tickers = sorted(TICKER_NAMES.keys())

        def _on_ticker_change():
            t = st.session_state.get("port_ticker", all_tickers[0])
            p = _fetch_price(t)
            if p:
                st.session_state["port_entry"] = float(p)

        col1, col2, col3 = st.columns(3)
        with col1:
            new_ticker = st.selectbox("Ticker", all_tickers, key="port_ticker",
                                      on_change=_on_ticker_change)
            new_qty    = st.number_input("Quantité (actions)", min_value=1, value=100, key="port_qty")
        if "port_entry" not in st.session_state:
            _p = _fetch_price(new_ticker)
            st.session_state["port_entry"] = float(_p) if _p else 1000.0
        with col2:
            new_entry  = st.number_input("Prix d'entrée (FCFA)", min_value=0.0,
                                          step=1.0, format="%.0f", key="port_entry")
            new_stop   = st.number_input("Stop loss (FCFA, 0 = aucun)", min_value=0.0, value=0.0,
                                          step=1.0, format="%.0f", key="port_stop")
        with col3:
            new_target = st.number_input("Take profit (FCFA, 0 = aucun)", min_value=0.0, value=0.0,
                                          step=1.0, format="%.0f", key="port_target")
            new_date   = st.date_input("Date d'entrée", value=date_type.today(), key="port_date")

        if st.button("Ajouter", key="port_add"):
            current_p = _fetch_price(new_ticker)
            new_pos = {
                "ticker":        new_ticker,
                "entry_price":   float(new_entry),
                "quantity":      int(new_qty),
                "stop_loss":     float(new_stop) if new_stop > 0 else None,
                "take_profit":   float(new_target) if new_target > 0 else None,
                "entry_date":    str(new_date),
                "current_price": current_p,
                "refreshed_at":  datetime.now().strftime("%Y-%m-%d %H:%M"),
            }
            positions.append(new_pos)
            _save_portfolio(positions)
            st.success(f"Position {new_ticker} ajoutée.")
            st.rerun()

    # ── Supprimer une position ─────────────────────────────────────────────────
    if positions:
        with st.expander("🗑️ Supprimer une position"):
            tickers_open = [p["ticker"] for p in positions]
            to_delete = st.selectbox("Ticker à supprimer", tickers_open, key="port_del_sel")
            if st.button("Supprimer", key="port_del_btn"):
                positions = [p for p in positions if p["ticker"] != to_delete]
                _save_portfolio(positions)
                st.success(f"Position {to_delete} supprimée.")
                st.rerun()


# ─── Routing ──────────────────────────────────────────────────────────────────

def main() -> None:
    if "Journal" in vue:
        render_journal_dashboard()
        return

    if "Backtest" in vue:
        render_backtest_page()
        return

    if "Portfolio" in vue:
        render_portfolio_page()
        return

    st.title("📈 BRVM Stock Screener")
    st.caption("Analyse technique multi-critères pour actions BRVM — Investment Pioneers")

    # Si pas de nouvelle analyse, réutiliser les résultats en cache (pour que les
    # boutons portfolio survivent au rerun déclenché par le clic sur ces boutons)
    if not analyser_btn or not tickers_combined:
        cached = st.session_state.get("screener_valid_results")
        if cached:
            valid_results = cached
        else:
            st.info("👈 Sélectionnez un ou plusieurs titres dans le panneau gauche puis cliquez sur **Analyser**.")
            st.markdown("""
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
    else:
        tickers = list(dict.fromkeys(tickers_combined))

        if not tickers:
            st.warning("Aucun ticker valide saisi.")
            return

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

        results = {t: results.get(t) for t in tickers}
        valid_results = {k: v for k, v in results.items() if v is not None}

        if not valid_results:
            st.error("Aucun ticker n'a pu être analysé.")
            return

        st.session_state["screener_valid_results"] = valid_results

    # ── Mise à jour des trades ouverts (stop / target / timeout) ─────────────
    try:
        ticker_prices = {t: r["ind"].cours_actuel for t, r in valid_results.items()}
        closed = update_open_trades(ticker_prices)
        if closed:
            for c in closed:
                sign = "+" if c["pnl_pct"] >= 0 else ""
                st.toast(
                    f"📒 {c['ticker']} clôturé ({c['exit_reason']}) — "
                    f"{sign}{c['pnl_pct']:.1f}% en {c['days_held']}j",
                    icon="✅" if c["pnl_pct"] >= 0 else "🔴",
                )
    except Exception:
        logger.debug("[Tracking] update_open_trades KO")

    # ── Tableau de synthèse — signaux forts, anomalies, tendances ────────────
    _render_synthesis_dashboard(valid_results)

    # ── Tableau récapitulatif (si plusieurs tickers) ─────────────────────────
    if len(valid_results) > 1:
        st.subheader("📊 Tableau récapitulatif")
        render_recap_table(valid_results)
        st.divider()

    # ── Comparateur de titres (si plusieurs tickers) ─────────────────────────
    if len(valid_results) > 1:
        _render_comparator(valid_results)
        st.divider()

    # ── Export Excel/CSV ─────────────────────────────────────────────────────
    _render_export_buttons(valid_results)
    st.divider()

    # ── Carte détaillée par ticker ───────────────────────────────────────────
    for ticker, result in valid_results.items():
        with st.container():
            render_signal_card(result)
            st.divider()


# ─── Tableau de synthèse ─────────────────────────────────────────────────────

def _render_synthesis_dashboard(results: dict) -> None:
    """Affiche un tableau de synthèse avec signaux forts, anomalies et tendances."""
    signals_forts = []
    anomalies = []
    tendances = []

    for ticker, result in results.items():
        ind = result["ind"]
        score = result["score"]
        company = get_company_name(ticker)
        label = f"**{ticker}** ({company})"

        # Signaux forts
        if score.signal == "ACHAT" and score.confiance in ("forte", "modérée"):
            signals_forts.append(f"🟢 {label} — ACHAT (score {score.score_total:+d}, confiance {score.confiance})")
        elif score.signal == "VENTE" and score.confiance in ("forte", "modérée"):
            signals_forts.append(f"🔴 {label} — VENTE (score {score.score_total:+d}, confiance {score.confiance})")

        # Anomalies
        if ind.rsi is not None and (ind.rsi < 20 or ind.rsi > 80):
            zone = "survente extrême" if ind.rsi < 20 else "surachat extrême"
            anomalies.append(f"⚠️ {label} — RSI {ind.rsi:.0f} ({zone})")
        if ind.volume_relatif_pct > 100:
            anomalies.append(f"📊 {label} — Volume +{ind.volume_relatif_pct:.0f}% vs moy20j")
        if hasattr(ind, "drawdown_current") and ind.drawdown_current is not None and ind.drawdown_current < -15:
            anomalies.append(f"📉 {label} — Drawdown {ind.drawdown_current:.1f}%")
        if ind.rsi_divergence in ("haussiere_forte", "baissiere_forte"):
            anomalies.append(f"🔀 {label} — Divergence RSI {ind.rsi_divergence.replace('_', ' ')}")

        # Tendances
        if ind.ma_signal == "golden_cross":
            tendances.append(f"🚀 {label} — Golden Cross actif")
        elif ind.ma_signal == "death_cross":
            tendances.append(f"💀 {label} — Death Cross actif")

        events = getattr(ind, "events", [])
        strong_events = [e for e in events if e.get("importance") == "forte"]
        for e in strong_events[:1]:
            tendances.append(f"🔔 {label} — {e['description']} ({e['date']})")

    if signals_forts or anomalies or tendances:
        st.subheader("🎯 Synthèse rapide")
        col1, col2, col3 = st.columns(3)
        with col1:
            st.markdown("**Signaux forts**")
            if signals_forts:
                for s in signals_forts:
                    st.markdown(s)
            else:
                st.caption("Aucun signal fort")
        with col2:
            st.markdown("**Anomalies**")
            if anomalies:
                for a in anomalies:
                    st.markdown(a)
            else:
                st.caption("Aucune anomalie")
        with col3:
            st.markdown("**Tendances & événements**")
            if tendances:
                for t in tendances:
                    st.markdown(t)
            else:
                st.caption("Aucune tendance marquée")
        st.divider()


# ─── Comparateur de titres ───────────────────────────────────────────────────

def _render_comparator(results: dict) -> None:
    """Affiche le comparateur multi-titres (performance, volatilité, indicateurs)."""
    with st.expander("📏 Comparateur de titres", expanded=False):
        # Graphique de performance relative
        fig_perf = go.Figure()
        for ticker, result in results.items():
            if result is None:
                continue
            df = result["df"]
            if df is None or len(df) < 5:
                continue
            close = df["close"]
            # Normaliser à 100
            normalized = (close / close.iloc[0]) * 100
            company = get_company_name(ticker)
            fig_perf.add_trace(go.Scatter(
                x=normalized.index, y=normalized.values,
                name=f"{ticker} — {company}",
                mode="lines",
                hovertemplate=f"{ticker}: %{{y:.1f}}<extra></extra>",
            ))

        fig_perf.add_hline(y=100, line_dash="dash", line_color="#888", line_width=1)
        fig_perf.update_layout(
            title="Performance relative (base 100)",
            height=400,
            plot_bgcolor="white",
            paper_bgcolor="white",
            legend=dict(orientation="h", y=-0.15),
            yaxis_title="Performance (base 100)",
            margin=dict(l=60, r=40, t=50, b=60),
        )
        fig_perf.update_xaxes(
            rangebreaks=[dict(bounds=["sat", "mon"])],
            gridcolor="#f0f0f0",
        )
        fig_perf.update_yaxes(gridcolor="#f0f0f0")
        st.plotly_chart(fig_perf, use_container_width=True)

        # Tableau comparatif
        comp_rows = []
        for ticker, result in results.items():
            if result is None:
                continue
            ind = result["ind"]
            score = result["score"]
            fundamentals = result.get("fundamentals")
            comp_rows.append({
                "Titre": f"{ticker} — {get_company_name(ticker)}",
                "Perf 1M": f"{ind.perf_1m:+.1f}%" if ind.perf_1m is not None else "N/D",
                "Perf 3M": f"{ind.perf_3m:+.1f}%" if ind.perf_3m is not None else "N/D",
                "Volatilité": f"{ind.volatilite_3m:.1f}%" if getattr(ind, "volatilite_3m", None) else "N/D",
                "Drawdown 3M": f"{ind.drawdown_max_3m:.1f}%" if getattr(ind, "drawdown_max_3m", None) else "N/D",
                "RSI": f"{ind.rsi:.0f}" if ind.rsi else "N/D",
                "ADX": f"{ind.adx:.0f}" if ind.adx else "N/D",
                "Score tech": f"{score.score_total:+d}",
                "Score fond.": f"{fundamentals.score_fondamental:.0f}/10" if fundamentals and fundamentals.score_fondamental else "N/D",
                "Signal": f"{score.signal_emoji} {score.signal}",
            })

        if comp_rows:
            df_comp = pd.DataFrame(comp_rows)
            st.dataframe(df_comp, use_container_width=True, hide_index=True)


# ─── Export ──────────────────────────────────────────────────────────────────

def _render_export_buttons(results: dict) -> None:
    """Affiche les boutons d'export Excel et CSV."""
    tickers_str = "_".join(list(results.keys())[:3])
    col1, col2, col3 = st.columns([2, 2, 6])

    with col1:
        try:
            excel_data = export_to_excel(results)
            st.download_button(
                label="📥 Export Excel",
                data=excel_data,
                file_name=f"BRVM_analyse_{tickers_str}.xlsx",
                mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                use_container_width=True,
            )
        except Exception as e:
            logger.warning(f"Erreur export Excel: {e}")
            st.caption("Export Excel indisponible")

    with col2:
        try:
            csv_data = export_to_csv(results)
            st.download_button(
                label="📥 Export CSV",
                data=csv_data,
                file_name=f"BRVM_analyse_{tickers_str}.csv",
                mime="text/csv",
                use_container_width=True,
            )
        except Exception as e:
            logger.warning(f"Erreur export CSV: {e}")
            st.caption("Export CSV indisponible")


if __name__ == "__main__":
    main()
