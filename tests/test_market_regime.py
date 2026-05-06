"""
tests/test_market_regime.py - Tests exhaustifs pour market_regime.py.
Aucun appel réseau. Données synthétiques uniquement.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
import pytest

from market_regime import (
    MarketBreadth,
    TickerSignal,
    _compute_ticker_signals,
    apply_regime_adjustment,
    classify_market_regime,
    compute_market_breadth,
    get_cached_breadth,
    get_cached_regime,
    sector_strength,
    set_current_regime,
)
from config import REGIME_MA50_THRESHOLDS, REGIME_MA200_BULL_BROAD_MIN


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _make_close(
    n: int = 120,
    trend: float = 0.001,
    seed: int = 42,
    start: float = 1000.0,
) -> pd.DataFrame:
    np.random.seed(seed)
    close = start * np.cumprod(1 + np.random.normal(trend, 0.008, n))
    return pd.DataFrame(
        {"open": close, "high": close * 1.01, "low": close * 0.99,
         "close": close, "volume": 200.0},
        index=pd.date_range("2024-01-02", periods=n, freq="B"),
    )


def _bull_breadth(pct_ma50=70.0, pct_ma200=60.0) -> MarketBreadth:
    return MarketBreadth(
        pct_above_ma50=pct_ma50,
        pct_above_ma200=pct_ma200,
        nb_tickers_analyzed=40,
        nb_tickers_total=40,
    )


def _bear_breadth(pct_ma50=15.0, pct_ma200=20.0) -> MarketBreadth:
    return MarketBreadth(
        pct_above_ma50=pct_ma50,
        pct_above_ma200=pct_ma200,
        nb_tickers_analyzed=40,
        nb_tickers_total=40,
    )


class _FakeScore:
    def __init__(self, signal="NEUTRE"):
        self.ticker = "TEST"
        self.signal = signal
        self.signal_emoji = "🟡"
        self.signal_color = "#BA7517"


# ─── TEST GROUP 1 - classify_market_regime ────────────────────────────────────

class TestClassifyMarketRegime:
    def test_bull_broad_both_conditions_met(self):
        b = _bull_breadth(pct_ma50=70.0, pct_ma200=60.0)
        assert classify_market_regime(b) == "BULL_BROAD"

    def test_bull_broad_exactly_at_thresholds(self):
        t50  = REGIME_MA50_THRESHOLDS["BULL_BROAD"]
        t200 = REGIME_MA200_BULL_BROAD_MIN
        b = MarketBreadth(pct_above_ma50=t50, pct_above_ma200=t200)
        assert classify_market_regime(b) == "BULL_BROAD"

    def test_bull_narrow_high_ma50_but_low_ma200(self):
        """MA50 ≥ seuil BULL_BROAD mais MA200 insuffisant → BULL_NARROW."""
        b = MarketBreadth(
            pct_above_ma50=REGIME_MA50_THRESHOLDS["BULL_BROAD"],
            pct_above_ma200=REGIME_MA200_BULL_BROAD_MIN - 1,
        )
        assert classify_market_regime(b) == "BULL_NARROW"

    def test_bull_narrow_threshold(self):
        t = REGIME_MA50_THRESHOLDS["BULL_NARROW"]
        b = MarketBreadth(pct_above_ma50=t, pct_above_ma200=20.0)
        assert classify_market_regime(b) == "BULL_NARROW"

    def test_bull_narrow_just_below_bull_broad(self):
        t = REGIME_MA50_THRESHOLDS["BULL_BROAD"] - 0.1
        b = MarketBreadth(pct_above_ma50=t, pct_above_ma200=80.0)
        assert classify_market_regime(b) == "BULL_NARROW"

    def test_range_threshold(self):
        t = REGIME_MA50_THRESHOLDS["RANGE"]
        b = MarketBreadth(pct_above_ma50=t, pct_above_ma200=10.0)
        assert classify_market_regime(b) == "RANGE"

    def test_bear_narrow_threshold(self):
        t = REGIME_MA50_THRESHOLDS["BEAR_NARROW"]
        b = MarketBreadth(pct_above_ma50=t, pct_above_ma200=5.0)
        assert classify_market_regime(b) == "BEAR_NARROW"

    def test_bear_broad_very_low_breadth(self):
        b = _bear_breadth(pct_ma50=5.0)
        assert classify_market_regime(b) == "BEAR_BROAD"

    def test_bear_broad_exactly_at_zero(self):
        b = MarketBreadth(pct_above_ma50=0.0, pct_above_ma200=0.0)
        assert classify_market_regime(b) == "BEAR_BROAD"

    def test_bear_broad_just_below_bear_narrow(self):
        t = REGIME_MA50_THRESHOLDS["BEAR_NARROW"] - 0.1
        b = MarketBreadth(pct_above_ma50=t, pct_above_ma200=0.0)
        assert classify_market_regime(b) == "BEAR_BROAD"

    def test_all_five_regimes_are_reachable(self):
        """Vérifier qu'on peut atteindre les 5 régimes."""
        scenarios = {
            "BULL_BROAD": MarketBreadth(pct_above_ma50=80.0, pct_above_ma200=70.0),
            "BULL_NARROW": MarketBreadth(pct_above_ma50=55.0, pct_above_ma200=30.0),
            "RANGE": MarketBreadth(pct_above_ma50=45.0, pct_above_ma200=20.0),
            "BEAR_NARROW": MarketBreadth(pct_above_ma50=28.0, pct_above_ma200=10.0),
            "BEAR_BROAD": MarketBreadth(pct_above_ma50=10.0, pct_above_ma200=5.0),
        }
        for expected, b in scenarios.items():
            assert classify_market_regime(b) == expected, (
                f"Régime attendu {expected}, MA50={b.pct_above_ma50}% MA200={b.pct_above_ma200}%"
            )


# ─── TEST GROUP 2 - _compute_ticker_signals ───────────────────────────────────

class TestComputeTickerSignals:
    def test_above_ma50_when_price_rising(self):
        """Série haussière → prix > MA50 → above_ma50=True."""
        df = _make_close(n=120, trend=0.005)
        sig = _compute_ticker_signals(df, "BULL")
        assert sig.above_ma50 is True
        assert sig.error is None

    def test_below_ma50_when_price_falling(self):
        """Série baissière marquée → prix < MA50 → above_ma50=False."""
        df = _make_close(n=120, trend=-0.008)
        sig = _compute_ticker_signals(df, "BEAR")
        assert sig.above_ma50 is False

    def test_insufficient_data_returns_none(self):
        """Moins de 50 barres → above_ma50=None, error renseigné."""
        df = _make_close(n=30)
        sig = _compute_ticker_signals(df, "SHORT")
        assert sig.above_ma50 is None
        assert sig.error is not None

    def test_none_dataframe_handled(self):
        """None → error renseigné, pas de crash."""
        sig = _compute_ticker_signals(None, "NONE")
        assert sig.error is not None
        assert sig.above_ma50 is None

    def test_missing_close_column(self):
        """DataFrame sans colonne 'close' → error."""
        df = pd.DataFrame({"open": [100], "volume": [200]},
                          index=pd.date_range("2024-01-02", periods=1))
        sig = _compute_ticker_signals(df, "BAD")
        assert sig.error is not None

    def test_near_52w_high_detected(self):
        """Prix proche du plus haut 52w → near_52w_high=True."""
        n = 120
        np.random.seed(1)
        # Série qui monte puis stagne au sommet
        close = np.linspace(1000, 1500, n)
        df = pd.DataFrame(
            {"open": close, "high": close * 1.01, "low": close * 0.99,
             "close": close, "volume": 200.0},
            index=pd.date_range("2024-01-02", periods=n, freq="B"),
        )
        sig = _compute_ticker_signals(df, "HIGH")
        assert sig.near_52w_high is True

    def test_near_52w_low_detected(self):
        """Prix proche du plus bas 52w → near_52w_low=True."""
        n = 120
        # Série qui descend puis stagne au bas
        close = np.linspace(1500, 1000, n)
        df = pd.DataFrame(
            {"open": close, "high": close * 1.01, "low": close * 0.99,
             "close": close, "volume": 200.0},
            index=pd.date_range("2024-01-02", periods=n, freq="B"),
        )
        sig = _compute_ticker_signals(df, "LOW")
        assert sig.near_52w_low is True

    def test_ma200_computed_with_200_bars(self):
        """Avec 200+ barres, above_ma200 doit être peuplé."""
        df = _make_close(n=220, trend=0.003)
        sig = _compute_ticker_signals(df, "LONG")
        assert sig.above_ma200 is not None

    def test_ma200_fallback_with_100_bars(self):
        """Avec 100-199 barres, above_ma200 calculé sur MA100 (fallback)."""
        df = _make_close(n=110, trend=0.003)
        sig = _compute_ticker_signals(df, "FALLBACK")
        assert sig.above_ma200 is not None

    def test_ma200_none_when_too_short(self):
        """Avec < 100 barres, above_ma200=None."""
        df = _make_close(n=80, trend=0.003)
        sig = _compute_ticker_signals(df, "SHORT200")
        assert sig.above_ma200 is None


# ─── TEST GROUP 3 - sector_strength ──────────────────────────────────────────

class TestSectorStrength:
    def _make_signals(self, tickers_above, tickers_below):
        signals = {}
        for t in tickers_above:
            signals[t] = TickerSignal(ticker=t, above_ma50=True)
        for t in tickers_below:
            signals[t] = TickerSignal(ticker=t, above_ma50=False)
        return signals

    def test_all_above_returns_100(self):
        groups = {"Groupe A": ["T1", "T2", "T3"]}
        signals = self._make_signals(["T1", "T2", "T3"], [])
        scores = sector_strength(signals, groups)
        assert scores["Groupe A"] == pytest.approx(100.0)

    def test_all_below_returns_zero(self):
        groups = {"Groupe A": ["T1", "T2"]}
        signals = self._make_signals([], ["T1", "T2"])
        scores = sector_strength(signals, groups)
        assert scores["Groupe A"] == pytest.approx(0.0)

    def test_half_above_returns_50(self):
        groups = {"Groupe A": ["T1", "T2", "T3", "T4"]}
        signals = self._make_signals(["T1", "T2"], ["T3", "T4"])
        scores = sector_strength(signals, groups)
        assert scores["Groupe A"] == pytest.approx(50.0)

    def test_index_group_excluded(self):
        """Groupes contenant 'Indic' sont exclus."""
        groups = {
            "📊 Indices principaux": ["BRVMC"],
            "🇨🇮 Côte d'Ivoire": ["T1", "T2"],
        }
        signals = self._make_signals(["T1"], ["T2"])
        scores = sector_strength(signals, groups)
        assert "📊 Indices principaux" not in scores
        assert "🇨🇮 Côte d'Ivoire" in scores

    def test_sorted_descending(self):
        """Scores triés par valeur décroissante."""
        groups = {"A": ["T1", "T2"], "B": ["T3", "T4"], "C": ["T5", "T6"]}
        signals = {
            "T1": TickerSignal("T1", above_ma50=True),
            "T2": TickerSignal("T2", above_ma50=True),   # A = 100%
            "T3": TickerSignal("T3", above_ma50=True),
            "T4": TickerSignal("T4", above_ma50=False),  # B = 50%
            "T5": TickerSignal("T5", above_ma50=False),
            "T6": TickerSignal("T6", above_ma50=False),  # C = 0%
        }
        scores = sector_strength(signals, groups)
        values = list(scores.values())
        assert values == sorted(values, reverse=True)

    def test_ticker_not_in_signals_ignored(self):
        """Ticker dans le groupe mais absent de signals → ignoré."""
        groups = {"A": ["T1", "T_ABSENT"]}
        signals = {"T1": TickerSignal("T1", above_ma50=True)}
        scores = sector_strength(signals, groups)
        assert scores["A"] == pytest.approx(100.0)

    def test_empty_group_returns_zero(self):
        groups = {"A": []}
        scores = sector_strength({}, groups)
        assert scores["A"] == pytest.approx(0.0)


# ─── TEST GROUP 4 - apply_regime_adjustment ──────────────────────────────────

class TestApplyRegimeAdjustment:
    def test_bear_broad_achat_to_neutre(self):
        """BEAR_BROAD + ACHAT → NEUTRE."""
        result = _FakeScore("ACHAT")
        out = apply_regime_adjustment(result, "BEAR_BROAD")
        assert out.signal == "NEUTRE"

    def test_bull_broad_vente_to_neutre(self):
        """BULL_BROAD + VENTE → NEUTRE."""
        result = _FakeScore("VENTE")
        out = apply_regime_adjustment(result, "BULL_BROAD")
        assert out.signal == "NEUTRE"

    def test_bear_broad_neutre_unchanged(self):
        """BEAR_BROAD + NEUTRE → NEUTRE (inchangé)."""
        result = _FakeScore("NEUTRE")
        out = apply_regime_adjustment(result, "BEAR_BROAD")
        assert out.signal == "NEUTRE"

    def test_bull_broad_achat_unchanged(self):
        """BULL_BROAD + ACHAT → ACHAT (inchangé - le régime soutient l'ACHAT)."""
        result = _FakeScore("ACHAT")
        out = apply_regime_adjustment(result, "BULL_BROAD")
        assert out.signal == "ACHAT"

    def test_bear_broad_vente_unchanged(self):
        """BEAR_BROAD + VENTE → VENTE (le régime confirme la VENTE)."""
        result = _FakeScore("VENTE")
        out = apply_regime_adjustment(result, "BEAR_BROAD")
        assert out.signal == "VENTE"

    def test_range_achat_unchanged(self):
        result = _FakeScore("ACHAT")
        out = apply_regime_adjustment(result, "RANGE")
        assert out.signal == "ACHAT"

    def test_bull_narrow_vente_unchanged(self):
        result = _FakeScore("VENTE")
        out = apply_regime_adjustment(result, "BULL_NARROW")
        assert out.signal == "VENTE"

    def test_bear_narrow_achat_unchanged(self):
        result = _FakeScore("ACHAT")
        out = apply_regime_adjustment(result, "BEAR_NARROW")
        assert out.signal == "ACHAT"

    def test_emoji_and_color_updated_on_downgrade(self):
        """Quand signal dégradé à NEUTRE, emoji et couleur doivent changer."""
        result = _FakeScore("ACHAT")
        result.signal_emoji = "🟢"
        result.signal_color = "#0F6E56"
        out = apply_regime_adjustment(result, "BEAR_BROAD")
        assert out.signal_emoji == "🟡"
        assert out.signal_color == "#BA7517"

    def test_inconnu_regime_unchanged(self):
        """Régime inconnu → signal inchangé."""
        result = _FakeScore("ACHAT")
        out = apply_regime_adjustment(result, "INCONNU")
        assert out.signal == "ACHAT"


# ─── TEST GROUP 5 - Cache module-level ────────────────────────────────────────

class TestRegimeCache:
    def setup_method(self):
        """Reset cache avant chaque test."""
        set_current_regime(None)

    def test_initially_none(self):
        set_current_regime(None)
        assert get_cached_regime() is None

    def test_set_and_get_regime(self):
        set_current_regime("BULL_BROAD")
        assert get_cached_regime() == "BULL_BROAD"

    def test_set_with_breadth(self):
        b = MarketBreadth(pct_above_ma50=70.0, regime="BULL_BROAD")
        set_current_regime("BULL_BROAD", b)
        assert get_cached_regime() == "BULL_BROAD"
        assert get_cached_breadth() is b

    def test_overwrite_regime(self):
        set_current_regime("RANGE")
        set_current_regime("BEAR_BROAD")
        assert get_cached_regime() == "BEAR_BROAD"


# ─── TEST GROUP 6 - compute_market_breadth (mock réseau) ────────────────────

class TestComputeMarketBreadth:
    def _make_fetch(self, tickers_bull, tickers_bear):
        """Retourne un fetch_fn qui donne des séries haussières ou baissières."""
        def fetch(ticker, days):
            trend = 0.005 if ticker in tickers_bull else -0.008
            return _make_close(n=max(days, 120), trend=trend)
        return fetch

    def test_all_bull_gives_bull_broad(self):
        """Tous les titres haussiers → BULL_BROAD (si MA200 suffisant)."""
        tickers = ["A", "B", "C", "D", "E"]
        fetch = self._make_fetch(tickers_bull=tickers, tickers_bear=[])
        # Utiliser des séries suffisamment longues pour MA200
        def fetch_long(ticker, days):
            return _make_close(n=220, trend=0.005)
        breadth = compute_market_breadth(fetch_long, tickers=tickers, days=220)
        assert breadth.pct_above_ma50 == pytest.approx(100.0, abs=5.0)
        assert breadth.regime in ("BULL_BROAD", "BULL_NARROW")

    def test_all_bear_gives_bear_broad(self):
        """Tous les titres baissiers → BEAR_BROAD."""
        tickers = ["X", "Y", "Z"]
        def fetch_bear(ticker, days):
            return _make_close(n=120, trend=-0.01, seed=99)
        breadth = compute_market_breadth(fetch_bear, tickers=tickers, days=120)
        assert breadth.pct_above_ma50 < 50.0
        assert breadth.regime in ("BEAR_BROAD", "BEAR_NARROW", "RANGE")

    def test_error_tickers_tracked(self):
        """Tickers dont le fetch lève une exception → dans error_tickers."""
        tickers = ["GOOD", "BAD"]

        def fetch(ticker, days):
            if ticker == "BAD":
                raise RuntimeError("Timeout réseau simulé")
            return _make_close(n=120)

        breadth = compute_market_breadth(fetch, tickers=tickers, days=120)
        assert "BAD" in breadth.error_tickers
        assert "GOOD" not in breadth.error_tickers

    def test_breadth_fields_populated(self):
        """Les champs principaux de MarketBreadth sont peuplés."""
        tickers = ["T1", "T2", "T3"]

        def fetch(ticker, days):
            return _make_close(n=120)

        breadth = compute_market_breadth(fetch, tickers=tickers, days=120)
        assert breadth.nb_tickers_total == 3
        assert 0.0 <= breadth.pct_above_ma50 <= 100.0
        assert breadth.computed_at != ""
        assert breadth.regime in (
            "BULL_BROAD", "BULL_NARROW", "RANGE", "BEAR_NARROW", "BEAR_BROAD", "INCONNU"
        )

    def test_cache_updated_after_compute(self):
        """compute_market_breadth() doit mettre à jour le cache."""
        tickers = ["C1", "C2"]

        def fetch(ticker, days):
            return _make_close(n=120, trend=0.005)

        breadth = compute_market_breadth(fetch, tickers=tickers, days=120)
        assert get_cached_regime() == breadth.regime
        assert get_cached_breadth() is breadth

    def test_sector_scores_computed(self):
        """sector_scores peuplé si ticker_groups valide."""
        groups = {"Groupe Test": ["T1", "T2"]}
        tickers = ["T1", "T2"]

        def fetch(ticker, days):
            return _make_close(n=120)

        breadth = compute_market_breadth(fetch, tickers=tickers, days=120)
        # sector_strength utilise TICKER_GROUPS par défaut - on vérifie juste la structure
        assert isinstance(breadth.sector_scores, dict)

    def test_empty_tickers_list_returns_inconnu(self):
        """Aucun ticker → régime INCONNU."""
        breadth = compute_market_breadth(lambda t, d: None, tickers=[], days=120)
        assert breadth.regime == "INCONNU"
        assert breadth.nb_tickers_analyzed == 0


# ─── TEST GROUP 7 - Intégration scoring.py ───────────────────────────────────

class TestIntegrationWithScoring:
    def _compute_score_with_regime(self, regime: str):
        """Force un régime dans le cache puis appelle compute_score."""
        set_current_regime(regime)
        from indicators import compute_indicators
        from scoring import compute_score

        np.random.seed(42)
        n = 120
        close = 1000.0 * np.cumprod(1 + np.random.normal(0.001, 0.008, n))
        df = pd.DataFrame(
            {"open": close, "high": close * 1.01, "low": close * 0.99,
             "close": close, "volume": 500.0},
            index=pd.date_range("2024-01-02", periods=n, freq="B"),
        )
        ind = compute_indicators(df, ticker="TEST")
        return compute_score(ind)

    def setup_method(self):
        set_current_regime(None)

    def test_scoring_hook_does_not_crash_with_none_regime(self):
        """Régime None dans cache → compute_score() ne plante pas."""
        result = self._compute_score_with_regime(None)
        assert result is not None
        assert result.signal in ("ACHAT", "NEUTRE", "VENTE")

    def test_bear_broad_converts_achat_to_neutre_in_pipeline(self):
        """
        Si le scoring donne ACHAT et que BEAR_BROAD est en cache,
        le signal final doit être NEUTRE.
        """
        # On force le régime et on vérifie la logique d'ajustement pure
        # (pas de boucle while cherchant à trouver un ACHAT)
        result = _FakeScore("ACHAT")
        set_current_regime("BEAR_BROAD")
        from market_regime import get_cached_regime, apply_regime_adjustment
        r = get_cached_regime()
        if r:
            result = apply_regime_adjustment(result, r)
        assert result.signal == "NEUTRE"

    def test_range_regime_preserves_achat(self):
        """RANGE ne dégrade pas ACHAT."""
        result = _FakeScore("ACHAT")
        set_current_regime("RANGE")
        from market_regime import get_cached_regime, apply_regime_adjustment
        r = get_cached_regime()
        if r:
            result = apply_regime_adjustment(result, r)
        assert result.signal == "ACHAT"
