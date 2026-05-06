"""
tests/test_brvm_aware.py - Tests exhaustifs pour brvm_aware.py.
Aucun appel réseau. Données synthétiques uniquement.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
import pytest

import config  # on va monkey-patcher LIQUIDITY_TIERS dans certains tests

from brvm_aware import (
    VOLUME_SIGNAL_MIN_MEDIAN,
    UNADJUSTED_EVENT_THRESHOLD_PCT,
    SESSION_GAP_CALENDAR_DAYS,
    adjust_volume_signal,
    apply_brvm_critere_adjustments,
    apply_confiance_override,
    detect_session_gap,
    detect_unadjusted_event,
    get_liquidity_tier,
    should_compute_indicator,
)


# ─── Fixtures & helpers ───────────────────────────────────────────────────────

def _close_series(n: int = 100, seed: int = 42) -> pd.Series:
    np.random.seed(seed)
    close = 1000.0 * np.cumprod(1 + np.random.normal(0.001, 0.005, n))
    return pd.Series(close, index=pd.date_range("2024-01-02", periods=n, freq="B"))


def _patch_tiers(monkeypatch, tiers: dict):
    """Monkey-patche config.LIQUIDITY_TIERS ET brvm_aware.LIQUIDITY_TIERS."""
    monkeypatch.setattr(config, "LIQUIDITY_TIERS", tiers)
    import brvm_aware
    monkeypatch.setattr(brvm_aware, "LIQUIDITY_TIERS", tiers)


# ─── Dataclasses factices (évite import de TechnicalIndicators / ScoreResult) ──

class _FakeInd:
    def __init__(self, ticker="TEST", tier="INCONNU", vol_median=200.0):
        self.ticker = ticker
        self.liquidity_tier = tier
        self.volume_median_nonzero = vol_median


class _FakeCritere:
    def __init__(self, nom, points, interpretation=""):
        self.nom = nom
        self.points = points
        self.interpretation = interpretation


class _FakeResult:
    def __init__(self, confiance="forte"):
        self.confiance = confiance


# ─── TEST GROUP 1 - get_liquidity_tier ───────────────────────────────────────

class TestGetLiquidityTier:
    def test_known_ticker_returns_tier(self, monkeypatch):
        _patch_tiers(monkeypatch, {"SNTS": "LIQUIDE"})
        assert get_liquidity_tier("SNTS") == "LIQUIDE"

    def test_unknown_ticker_returns_inconnu(self, monkeypatch):
        _patch_tiers(monkeypatch, {})
        assert get_liquidity_tier("XXXX") == "INCONNU"

    def test_semi_liquide_tier(self, monkeypatch):
        _patch_tiers(monkeypatch, {"PALC": "SEMI_LIQUIDE"})
        assert get_liquidity_tier("PALC") == "SEMI_LIQUIDE"

    def test_illiquid_tier(self, monkeypatch):
        _patch_tiers(monkeypatch, {"BOAM": "ILLIQUIDE"})
        assert get_liquidity_tier("BOAM") == "ILLIQUIDE"


# ─── TEST GROUP 2 - should_compute_indicator ──────────────────────────────────

class TestShouldComputeIndicator:
    def test_adx_disabled_for_illiquid(self, monkeypatch):
        _patch_tiers(monkeypatch, {"LNBB": "ILLIQUIDE"})
        assert should_compute_indicator("LNBB", "ADX") is False

    def test_stochastic_disabled_for_illiquid(self, monkeypatch):
        _patch_tiers(monkeypatch, {"BOAM": "ILLIQUIDE"})
        assert should_compute_indicator("BOAM", "Stochastic") is False

    def test_rsi_enabled_even_for_illiquid(self, monkeypatch):
        _patch_tiers(monkeypatch, {"BOAM": "ILLIQUIDE"})
        assert should_compute_indicator("BOAM", "RSI") is True

    def test_macd_enabled_for_illiquid(self, monkeypatch):
        _patch_tiers(monkeypatch, {"BOAM": "ILLIQUIDE"})
        assert should_compute_indicator("BOAM", "MACD") is True

    def test_adx_enabled_for_liquide(self, monkeypatch):
        _patch_tiers(monkeypatch, {"SNTS": "LIQUIDE"})
        assert should_compute_indicator("SNTS", "ADX") is True

    def test_stochastic_enabled_for_semi_liquide(self, monkeypatch):
        _patch_tiers(monkeypatch, {"PALC": "SEMI_LIQUIDE"})
        assert should_compute_indicator("PALC", "Stochastic") is True

    def test_unknown_tier_enables_all(self, monkeypatch):
        _patch_tiers(monkeypatch, {})
        assert should_compute_indicator("XXXX", "ADX") is True
        assert should_compute_indicator("XXXX", "Stochastic") is True

    def test_case_sensitive_indicator_name(self, monkeypatch):
        """Nom en minuscule ne correspond pas → indicateur activé."""
        _patch_tiers(monkeypatch, {"BOAM": "ILLIQUIDE"})
        assert should_compute_indicator("BOAM", "adx") is True


# ─── TEST GROUP 3 - adjust_volume_signal ─────────────────────────────────────

class TestAdjustVolumeSignal:
    def test_neutralized_when_median_below_threshold(self):
        """Médiane < seuil → ratio neutralisé à 1.0."""
        ratio = adjust_volume_signal("BOAM", ratio=5.0, volume_median=10.0)
        assert ratio == pytest.approx(1.0)

    def test_unchanged_when_median_above_threshold(self):
        """Médiane ≥ seuil → ratio retourné inchangé."""
        ratio = adjust_volume_signal("SNTS", ratio=3.5, volume_median=500.0)
        assert ratio == pytest.approx(3.5)

    def test_exactly_at_threshold_passes(self):
        """Médiane = exactement le seuil → ratio passé (non neutralisé)."""
        ratio = adjust_volume_signal("TEST", ratio=2.0, volume_median=float(VOLUME_SIGNAL_MIN_MEDIAN))
        assert ratio == pytest.approx(2.0)

    def test_just_below_threshold_neutralizes(self):
        """Médiane = seuil-1 → neutralisé."""
        ratio = adjust_volume_signal("TEST", ratio=4.0, volume_median=float(VOLUME_SIGNAL_MIN_MEDIAN - 1))
        assert ratio == pytest.approx(1.0)

    def test_zero_median_neutralizes(self):
        """Médiane = 0 (aucune séance non-zéro) → neutralisé."""
        ratio = adjust_volume_signal("VIDE", ratio=10.0, volume_median=0.0)
        assert ratio == pytest.approx(1.0)

    def test_ratio_one_unchanged_regardless(self):
        """Un ratio déjà neutre (1.0) reste 1.0 dans tous les cas."""
        assert adjust_volume_signal("X", 1.0, 0.0) == pytest.approx(1.0)
        assert adjust_volume_signal("X", 1.0, 1000.0) == pytest.approx(1.0)


# ─── TEST GROUP 4 - detect_session_gap ───────────────────────────────────────

class TestDetectSessionGap:
    def test_no_gap_normal_series(self):
        """Série continue sans trou → stale=False."""
        series = _close_series(60)
        result = detect_session_gap(series)
        assert result["stale"] is False

    def test_large_gap_detected(self):
        """Trou de 10j calendaires → stale=True."""
        series = _close_series(60)
        # Insérer un trou de 10 jours en ne prenant pas les barres 30-35
        idx = list(series.index)
        gap_idx = idx[30:36]
        series_gapped = series.drop(labels=gap_idx)
        result = detect_session_gap(series_gapped)
        assert result["stale"] is True
        assert result["gap_days"] >= SESSION_GAP_CALENDAR_DAYS

    def test_small_gap_not_flagged(self):
        """Trou de 2 jours calendaires → pas flagué."""
        series = _close_series(60)
        idx = list(series.index)
        # Retirer 1 seule barre (≈ 1 jour ouvré = ~1 jour cal.)
        series_gapped = series.drop(labels=[idx[20]])
        result = detect_session_gap(series_gapped)
        assert result["stale"] is False

    def test_gap_start_end_dates_populated(self):
        """Quand stale=True, gap_start et gap_end doivent être remplis."""
        series = _close_series(60)
        idx = list(series.index)
        series_gapped = series.drop(labels=idx[25:31])
        result = detect_session_gap(series_gapped)
        if result["stale"]:
            assert result["gap_start"] != ""
            assert result["gap_end"] != ""

    def test_none_series_returns_no_gap(self):
        """None → stale=False sans crash."""
        result = detect_session_gap(None)
        assert result["stale"] is False

    def test_too_short_series_returns_no_gap(self):
        """Série de 1 élément → pas de gap possible."""
        s = pd.Series([1000.0], index=pd.date_range("2024-01-02", periods=1))
        result = detect_session_gap(s)
        assert result["stale"] is False

    def test_gap_message_populated(self):
        """Quand stale=True, message doit contenir le nombre de jours."""
        series = _close_series(60)
        idx = list(series.index)
        series_gapped = series.drop(labels=idx[25:32])
        result = detect_session_gap(series_gapped)
        if result["stale"]:
            assert str(result["gap_days"]) in result["message"]


# ─── TEST GROUP 5 - detect_unadjusted_event ──────────────────────────────────

class TestDetectUnadjustedEvent:
    def test_no_event_on_stable_series(self):
        """Série stable → aucun événement détecté."""
        series = _close_series(100)
        events = detect_unadjusted_event(series)
        assert events == []

    def test_spike_with_reversal_detected(self):
        """
        Saut de +50% suivi d'un retour de -30% en 5j → événement détecté
        avec reverted=True.
        """
        series = _close_series(80)
        spike_pos = 40

        # Saut de +50%
        series.iloc[spike_pos] = series.iloc[spike_pos - 1] * 1.50
        # Retour de -30% sur les 3 séances suivantes
        for k in range(1, 4):
            series.iloc[spike_pos + k] = series.iloc[spike_pos] * 0.90

        events = detect_unadjusted_event(series)
        assert len(events) >= 1

        reverted_events = [e for e in events if e["reverted"]]
        assert len(reverted_events) >= 1
        assert abs(reverted_events[0]["jump_pct"]) >= UNADJUSTED_EVENT_THRESHOLD_PCT

    def test_spike_without_reversal_detected_but_not_reverted(self):
        """
        Saut de +30% sans retour → événement détecté mais reverted=False.
        """
        series = _close_series(80)
        spike_pos = 40
        # Saut sans retour
        for i in range(spike_pos, 80):
            series.iloc[i] = series.iloc[spike_pos - 1] * 1.30

        events = detect_unadjusted_event(series)
        spike_events = [e for e in events if abs(e["jump_pct"]) >= UNADJUSTED_EVENT_THRESHOLD_PCT]
        if spike_events:
            assert spike_events[0]["reverted"] is False

    def test_small_move_not_detected(self):
        """Variation de 10% → sous le seuil, pas détecté."""
        series = _close_series(80)
        series.iloc[40] = series.iloc[39] * 1.10
        events = detect_unadjusted_event(series)
        # Aucun événement avec jump_pct ≥ 20%
        big_events = [e for e in events if abs(e["jump_pct"]) >= UNADJUSTED_EVENT_THRESHOLD_PCT]
        assert big_events == []

    def test_none_series_returns_empty(self):
        """None → liste vide sans crash."""
        events = detect_unadjusted_event(None)
        assert events == []

    def test_too_short_series_returns_empty(self):
        """Série trop courte → liste vide."""
        s = pd.Series([1000.0, 1050.0], index=pd.date_range("2024-01-02", periods=2))
        events = detect_unadjusted_event(s)
        assert events == []

    def test_event_dict_structure(self):
        """Chaque événement doit contenir les clés requises."""
        series = _close_series(80)
        series.iloc[40] = series.iloc[39] * 1.50
        events = detect_unadjusted_event(series)
        for ev in events:
            for key in ("date", "jump_pct", "reversal_pct", "reverted", "message"):
                assert key in ev, f"Clé '{key}' manquante dans l'événement"

    def test_negative_spike_detected(self):
        """Chute de -40% → détectée comme événement."""
        series = _close_series(80)
        series.iloc[40] = series.iloc[39] * 0.55  # -45%
        events = detect_unadjusted_event(series)
        negative_events = [e for e in events if e["jump_pct"] < -UNADJUSTED_EVENT_THRESHOLD_PCT]
        assert len(negative_events) >= 1


# ─── TEST GROUP 6 - apply_brvm_critere_adjustments ───────────────────────────

class TestApplyBrvmCritereAdjustments:
    def test_adx_zeroed_for_illiquid(self):
        """ADX avec points != 0 → neutralisé si tier=ILLIQUIDE."""
        ind = _FakeInd(tier="ILLIQUIDE", vol_median=500.0)
        criteres = [
            _FakeCritere("ADX", +1, "Tendance forte"),
            _FakeCritere("RSI", +1, "Zone neutre"),
        ]
        result = apply_brvm_critere_adjustments(ind, criteres)

        adx = next(c for c in result if c.nom == "ADX")
        rsi = next(c for c in result if c.nom == "RSI")
        assert adx.points == 0
        assert "[ILLIQUIDE]" in adx.interpretation
        assert rsi.points == +1  # RSI inchangé

    def test_stochastic_zeroed_for_illiquid(self):
        """Stochastic → neutralisé si tier=ILLIQUIDE."""
        ind = _FakeInd(tier="ILLIQUIDE", vol_median=200.0)
        criteres = [_FakeCritere("Stochastic", -1, "Surachat")]
        result = apply_brvm_critere_adjustments(ind, criteres)
        stoch = result[0]
        assert stoch.points == 0
        assert "[ILLIQUIDE]" in stoch.interpretation

    def test_adx_preserved_for_liquide(self):
        """ADX conservé pour ticker LIQUIDE."""
        ind = _FakeInd(tier="LIQUIDE", vol_median=500.0)
        criteres = [_FakeCritere("ADX", +1)]
        result = apply_brvm_critere_adjustments(ind, criteres)
        assert result[0].points == +1

    def test_adx_preserved_for_semi_liquide(self):
        """ADX conservé pour ticker SEMI_LIQUIDE."""
        ind = _FakeInd(tier="SEMI_LIQUIDE", vol_median=100.0)
        criteres = [_FakeCritere("ADX", -1)]
        result = apply_brvm_critere_adjustments(ind, criteres)
        assert result[0].points == -1

    def test_volume_zeroed_when_median_too_low(self):
        """Volume neutralisé si volume_median_nonzero < seuil."""
        ind = _FakeInd(tier="LIQUIDE", vol_median=float(VOLUME_SIGNAL_MIN_MEDIAN - 1))
        criteres = [_FakeCritere("Volume", +1, "Volume élevé")]
        result = apply_brvm_critere_adjustments(ind, criteres)
        vol = result[0]
        assert vol.points == 0
        assert f"{VOLUME_SIGNAL_MIN_MEDIAN}" in vol.interpretation

    def test_volume_preserved_when_median_above_threshold(self):
        """Volume conservé si médiane ≥ seuil."""
        ind = _FakeInd(tier="LIQUIDE", vol_median=float(VOLUME_SIGNAL_MIN_MEDIAN + 10))
        criteres = [_FakeCritere("Volume", +1)]
        result = apply_brvm_critere_adjustments(ind, criteres)
        assert result[0].points == +1

    def test_empty_criteres_list(self):
        """Liste vide → retourné sans crash."""
        ind = _FakeInd(tier="ILLIQUIDE")
        result = apply_brvm_critere_adjustments(ind, [])
        assert result == []

    def test_multiple_adjustments_combined(self):
        """ILLIQUIDE + volume faible → ADX, Stochastic et Volume neutralisés."""
        ind = _FakeInd(tier="ILLIQUIDE", vol_median=10.0)
        criteres = [
            _FakeCritere("ADX", +1),
            _FakeCritere("Stochastic", -1),
            _FakeCritere("Volume", +1),
            _FakeCritere("RSI", +2),
            _FakeCritere("MACD", -1),
        ]
        result = apply_brvm_critere_adjustments(ind, criteres)

        by_name = {c.nom: c for c in result}
        assert by_name["ADX"].points == 0
        assert by_name["Stochastic"].points == 0
        assert by_name["Volume"].points == 0
        assert by_name["RSI"].points == +2      # inchangé
        assert by_name["MACD"].points == -1     # inchangé


# ─── TEST GROUP 7 - apply_confiance_override ──────────────────────────────────

class TestApplyConfianceOverride:
    def test_forte_forced_to_faible_for_illiquid(self):
        """confiance='forte' → forcée à 'faible' si ILLIQUIDE."""
        result = _FakeResult(confiance="forte")
        ind = _FakeInd(tier="ILLIQUIDE")
        out = apply_confiance_override(result, ind)
        assert out.confiance == "faible"

    def test_moderee_forced_to_faible_for_illiquid(self):
        """confiance='modérée' → forcée à 'faible' si ILLIQUIDE."""
        result = _FakeResult(confiance="modérée")
        ind = _FakeInd(tier="ILLIQUIDE")
        out = apply_confiance_override(result, ind)
        assert out.confiance == "faible"

    def test_already_faible_unchanged(self):
        """confiance déjà 'faible' → inchangée."""
        result = _FakeResult(confiance="faible")
        ind = _FakeInd(tier="ILLIQUIDE")
        out = apply_confiance_override(result, ind)
        assert out.confiance == "faible"

    def test_liquide_does_not_override(self):
        """ticker LIQUIDE → confiance='forte' conservée."""
        result = _FakeResult(confiance="forte")
        ind = _FakeInd(tier="LIQUIDE")
        out = apply_confiance_override(result, ind)
        assert out.confiance == "forte"

    def test_semi_liquide_does_not_override(self):
        """ticker SEMI_LIQUIDE → confiance conservée."""
        result = _FakeResult(confiance="modérée")
        ind = _FakeInd(tier="SEMI_LIQUIDE")
        out = apply_confiance_override(result, ind)
        assert out.confiance == "modérée"

    def test_inconnu_does_not_override(self):
        """tier=INCONNU → confiance conservée (pas de pénalité si non classé)."""
        result = _FakeResult(confiance="forte")
        ind = _FakeInd(tier="INCONNU")
        out = apply_confiance_override(result, ind)
        assert out.confiance == "forte"


# ─── TEST GROUP 8 - Intégration avec indicators.py / scoring.py ───────────────

class TestIntegrationWithIndicators:
    """
    Vérifie que les nouveaux champs sont bien présents dans TechnicalIndicators
    et peuplés par compute_indicators().
    """

    def _make_df(self, n=60, volume=200.0):
        np.random.seed(7)
        close = 1000.0 * np.cumprod(1 + np.random.normal(0.001, 0.005, n))
        return pd.DataFrame(
            {"open": close, "high": close * 1.01, "low": close * 0.99,
             "close": close, "volume": volume},
            index=pd.date_range("2024-01-02", periods=n, freq="B"),
        )

    def test_liquidity_tier_field_exists(self):
        from indicators import compute_indicators
        df = self._make_df()
        result = compute_indicators(df, ticker="XXXX")
        assert hasattr(result, "liquidity_tier"), "Champ liquidity_tier absent de TechnicalIndicators"

    def test_liquidity_tier_inconnu_when_not_in_config(self, monkeypatch):
        """Ticker inconnu → liquidity_tier='INCONNU'."""
        monkeypatch.setattr(config, "LIQUIDITY_TIERS", {})
        from indicators import compute_indicators
        df = self._make_df()
        result = compute_indicators(df, ticker="XXXX")
        assert result.liquidity_tier == "INCONNU"

    def test_liquidity_tier_set_when_in_config(self, monkeypatch):
        """Ticker dans config → liquidity_tier peuplé."""
        monkeypatch.setattr(config, "LIQUIDITY_TIERS", {"SNTS": "LIQUIDE"})
        from indicators import compute_indicators
        import importlib, indicators as ind_mod
        # Recharger pour que LIQUIDITY_TIERS soit re-lu
        df = self._make_df()
        result = compute_indicators(df, ticker="SNTS")
        assert result.liquidity_tier == "LIQUIDE"

    def test_volume_median_nonzero_field_exists(self):
        from indicators import compute_indicators
        df = self._make_df()
        result = compute_indicators(df, ticker="TEST")
        assert hasattr(result, "volume_median_nonzero")
        assert result.volume_median_nonzero >= 0.0

    def test_volume_median_nonzero_zero_when_all_volume_zero(self):
        """Quand tout le volume est 0, volume_median_nonzero doit être 0."""
        from indicators import compute_indicators
        df = self._make_df(volume=0.0)
        result = compute_indicators(df, ticker="TEST")
        assert result.volume_median_nonzero == 0.0

    def test_scoring_hooks_do_not_crash(self, monkeypatch):
        """
        Vérifier que les hooks brvm_aware dans compute_score()
        ne font pas planter le scoring normal.
        """
        monkeypatch.setattr(config, "LIQUIDITY_TIERS", {"SNTS": "LIQUIDE"})
        from indicators import compute_indicators
        from scoring import compute_score
        df = self._make_df(n=100)
        ind = compute_indicators(df, ticker="SNTS")
        score = compute_score(ind)
        assert score is not None
        assert score.signal in ("ACHAT", "NEUTRE", "VENTE")

    def test_illiquid_scoring_confiance_faible(self, monkeypatch):
        """
        Ticker ILLIQUIDE dans config → confiance doit être 'faible'
        après compute_score(), indépendamment des critères directionnels.
        """
        monkeypatch.setattr(config, "LIQUIDITY_TIERS", {"TSTILL": "ILLIQUIDE"})
        import brvm_aware
        monkeypatch.setattr(brvm_aware, "LIQUIDITY_TIERS", {"TSTILL": "ILLIQUIDE"})

        from indicators import compute_indicators
        from scoring import compute_score

        df = self._make_df(n=100)
        ind = compute_indicators(df, ticker="TSTILL")
        assert ind.liquidity_tier == "ILLIQUIDE"

        score = compute_score(ind)
        assert score.confiance == "faible", (
            f"confiance attendue 'faible' pour ILLIQUIDE, obtenu '{score.confiance}'"
        )
