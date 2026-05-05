"""
config.py — Constantes et configuration du BRVM Screener
"""

# ─── Sources de données ────────────────────────────────────────────────────────

NEWS_ENABLED = True

SIKA_BASE_URL = "https://www.sikafinance.com"

# Page historiques HTML (source la plus fiable)
SIKA_HISTORY_URL = "https://www.sikafinance.com/marches/historiques"

# Endpoint chart data XHR (JSON)
SIKA_CHART_URL = "https://www.sikafinance.com/marches/chartdata"

# Page cotation du jour
SIKA_QUOTE_URL = "https://www.sikafinance.com/marches/cotation"

# Page A à Z (listing complet)
SIKA_AAZ_URL = "https://www.sikafinance.com/marches/aaz"

# Fallback Rich Bourse
RICHBOURSE_BASE_URL = "https://www.richbourse.com"

# ─── Flux RSS actualités BRVM ─────────────────────────────────────────────────
# Testés dans l'ordre. Les flux sans contenu BRVM sont naturellement filtrés
# par le matching de mots-clés dans rss_feeds.py.

RSS_FEEDS: list[str] = [
    "https://www.sikafinance.com/rss/actualites",
    "https://www.sikafinance.com/feed",
    "https://www.financialafrik.com/feed/",
    "https://www.agenceecofin.com/feed",
    "https://lereussitefinanciere.com/feed/",
    "https://www.invest.ci/feed/",
    "https://www.abidjan.net/services/rss/economie.asp",
    "https://apanews.net/feed/",
    "https://www.jeuneafrique.com/feed/",
]

# ─── Mapping Ticker → ID Sika Finance ─────────────────────────────────────────
# Sur Sika Finance, les tickers portent un suffixe pays : BICC.ci, BOAB.bj, etc.
# Les indices n'ont pas de suffixe : BRVMC, BRVM30, etc.
# Ce mapping couvre les tickers les plus courants de la BRVM.

TICKER_TO_SIKA_ID: dict[str, str] = {
    # ── Actions Côte d'Ivoire (.ci) ──
    "ABJC":   "ABJC.ci",      # Abidjan Catering (reclassé)
    "BICC":   "BICC.ci",      # BICICI
    "BNBC":   "BNBC.ci",      # NSIA Banque CI
    "BOAC":   "BOAC.ci",      # Bank of Africa CI  ← ticker réel (ex-BOAN)
    "CABC":   "CABC.ci",      # Sicable CI
    "CFAC":   "CFAC.ci",      # CFAO Motors CI
    "CIEC":   "CIEC.ci",      # CIE CI
    "ECOC":   "ECOC.ci",      # Ecobank CI
    "FTSC":   "FTSC.ci",      # Filtisac CI
    "NEIC":   "NEIC.ci",      # NEI-CEDA CI
    "NSBC":   "NSBC.ci",      # NSIA CI (assurance)
    "NTLC":   "NTLC.ci",      # Nestlé CI
    "ORAC":   "ORAC.ci",      # Orange CI
    "PALC":   "PALC.ci",      # Palm CI
    "PRSC":   "PRSC.ci",      # Bernabé CI
    "SAFC":   "SAFC.ci",      # SAFCA CI
    "SDCC":   "SDCC.ci",      # SODECI
    "SDSC":   "SDSC.ci",      # Africa Global Logistics CI
    "SEMC":   "SEMC.ci",      # Crown SIEM CI
    "SGBC":   "SGBC.ci",      # Société Générale CI
    "SHEC":   "SHEC.ci",      # Vivo Energy CI
    "SIBC":   "SIBC.ci",      # SIB CI
    "SICC":   "SICC.ci",      # SICOR CI
    "SIVC":   "SIVC.ci",      # Servair Abidjan CI
    "SLBC":   "SLBC.ci",      # Solibra CI
    "SMBC":   "SMBC.ci",      # SMB CI
    "SOGC":   "SOGC.ci",      # SOGB CI
    "SPHC":   "SPHC.ci",      # SAPH CI
    "STAC":   "STAC.ci",      # SETAO CI
    "STBC":   "STBC.ci",      # SITAB CI
    "TTLC":   "TTLC.ci",      # TotalEnergies CI
    "UNLC":   "UNLC.ci",      # Unilever CI
    "UNXC":   "UNXC.ci",      # Uniwax CI

    # ── Actions Sénégal (.sn) ──
    "SNTS":   "SNTS.sn",      # Sonatel
    "TTLS":   "TTLS.sn",      # Total Sénégal
    "BOAS":   "BOAS.sn",      # Bank of Africa Sénégal  ← suffixe .sn (pas .ne)

    # ── Actions Togo (.tg) ──
    "ETIT":   "ETIT.tg",      # Ecobank Transnational Inc.
    "ORGT":   "ORGT.tg",      # Oragroup Togo

    # ── Actions Burkina Faso (.bf) ──
    "ONTBF":  "ONTBF.bf",     # Onatel Burkina Faso
    "BOABF":  "BOABF.bf",     # Bank of Africa Burkina Faso
    "CBIBF":  "CBIBF.bf",     # Coris Bank International BF

    # ── Actions Bénin (.bj) ──
    "BOAB":   "BOAB.bj",      # Bank of Africa Bénin
    "LNBB":   "LNBB.bj",      # Loterie Nationale du Bénin

    # ── Actions Mali (.ml) ──
    "BOAM":   "BOAM.ml",      # Bank of Africa Mali

    # ── Indices principaux ──
    "BRVMC":   "BRVMC",       # BRVM Composite
    "BRVM30":  "BRVM30",      # BRVM 30

    # ── Indices sectoriels ──
    "BRVM-IN": "BRVM-IN",     # BRVM Industriels      (BRVM00000022)
    "BRVM-TEL":"BRVM-TEL",    # BRVM Télécommunications (BRVM00000025)
    "BRVM-EN": "BRVM-EN",     # BRVM Énergie          (BRVM00000021)
}

# ─── Noms publics des tickers ─────────────────────────────────────────────────
# Utilisé pour l'affichage dans la liste déroulante de sélection

TICKER_NAMES: dict[str, str] = {
    # ── Côte d'Ivoire ──
    "BICC":    "BICICI — Banque Int. CI",
    "BNBC":    "NSIA Banque CI",
    "BOAC":    "Bank of Africa CI",
    "CABC":    "Sicable CI",
    "CFAC":    "CFAO Motors CI",
    "CIEC":    "CIE — Électricité CI",
    "ECOC":    "Ecobank CI",
    "FTSC":    "Filtisac CI",
    "NEIC":    "NEI-CEDA CI",
    "NSBC":    "NSIA Assurances CI",
    "NTLC":    "Nestlé CI",
    "ORAC":    "Orange CI",
    "PALC":    "Palm CI — Palmiculture",
    "PRSC":    "Bernabé CI",
    "SAFC":    "SAFCA CI",
    "SDCC":    "SODECI — Eau CI",
    "SDSC":    "Africa Global Logistics CI",
    "SEMC":    "Crown SIEM CI",
    "SGBC":    "Société Générale CI",
    "SHEC":    "Vivo Energy CI",
    "SIBC":    "SIB — Soc. Ivoirienne de Banque",
    "SICC":    "SICOR CI",
    "SIVC":    "Servair Abidjan CI",
    "SLBC":    "Solibra CI",
    "SMBC":    "SMB CI",
    "SOGC":    "SOGB CI",
    "SPHC":    "SAPH CI — Caoutchouc",
    "STAC":    "SETAO CI",
    "STBC":    "SITAB CI — Tabac",
    "TTLC":    "TotalEnergies CI",
    "UNLC":    "Unilever CI",
    "UNXC":    "Uniwax CI",
    # ── Sénégal ──
    "SNTS":    "Sonatel — Orange Sénégal",
    "TTLS":    "TotalEnergies Sénégal",
    "BOAS":    "Bank of Africa Sénégal",
    # ── Togo ──
    "ETIT":    "Ecobank Transnational (ETI)",
    "ORGT":    "Oragroup Togo",
    # ── Burkina Faso ──
    "ONTBF":   "Onatel Burkina Faso",
    "BOABF":   "Bank of Africa Burkina Faso",
    "CBIBF":   "Coris Bank International BF",
    # ── Bénin ──
    "BOAB":    "Bank of Africa Bénin",
    "LNBB":    "Loterie Nationale du Bénin",
    # ── Mali ──
    "BOAM":    "Bank of Africa Mali",
    # ── Indices principaux ──
    "BRVMC":   "BRVM Composite",
    "BRVM30":  "BRVM 30",
    # ── Indices sectoriels ──
    "BRVM-IN": "BRVM Industriels",
    "BRVM-TEL":"BRVM Télécommunications",
    "BRVM-EN": "BRVM Énergie",
}

# Groupes de tickers pour la liste déroulante
TICKER_GROUPS: dict[str, list[str]] = {
    "🇨🇮 Côte d'Ivoire — Finance":             ["BICC", "BNBC", "BOAC", "ECOC", "SGBC", "SIBC", "NSBC"],
    "🇨🇮 Côte d'Ivoire — Industrie & Services": ["CABC", "CFAC", "CIEC", "FTSC", "NEIC", "NTLC", "ORAC", "PALC", "PRSC", "SAFC", "SDCC", "SDSC", "SEMC", "SHEC", "SICC", "SIVC", "SLBC", "SMBC", "SOGC", "SPHC", "STAC", "STBC", "TTLC", "UNLC", "UNXC"],
    "🇸🇳 Sénégal":                              ["SNTS", "TTLS", "BOAS"],
    "🇹🇬 Togo":                                 ["ETIT", "ORGT"],
    "🇧🇫 Burkina Faso":                         ["ONTBF", "BOABF", "CBIBF"],
    "🇧🇯 Bénin":                                ["BOAB"],
    "📊 Indices principaux":                    ["BRVMC", "BRVM30"],
    "📊 Indices sectoriels":                    ["BRVM-IN", "BRVM-TEL", "BRVM-EN"],
}
COUNTRY_SUFFIXES = [".ci", ".sn", ".tg", ".bf", ".bj", ".ml", ".ne", ""]

# ─── Cache ─────────────────────────────────────────────────────────────────────

CACHE_DIR = ".cache"
CACHE_TTL_SECONDS = 3600       # 1 heure (OHLCV — valeur par défaut)
NEWS_CACHE_TTL_SECONDS = 1800  # 30 minutes (actualités)
NEWS_MAX_AGE_DAYS = 90
NEWS_MAX_ITEMS_DEFAULT = 10
MACRO_CACHE_TTL_SECONDS = 86400  # 24 heures (données macro)

# ─── Rate limiting ─────────────────────────────────────────────────────────────

REQUEST_DELAY_SECONDS = 2
REQUEST_TIMEOUT = 15
REQUEST_MAX_RETRIES = 3
REQUEST_BACKOFF_FACTOR = 1.0

# ─── Indicateurs techniques (valeurs par défaut — moyen terme) ─────────────────

RSI_PERIOD = 14
MA_SHORT = 20
MA_MID = 50
MA_LONG = 200
MA_LONG_FALLBACK = 100   # Fallback quand < 200 séances disponibles
MACD_FAST = 12
MACD_SLOW = 26
MACD_SIGNAL = 9
BOLLINGER_PERIOD = 20
BOLLINGER_STD = 2
VOLUME_AVG_PERIOD = 20
MIN_DATA_POINTS = 30  # Minimum de jours pour calculer les indicateurs

# ─── Indicateurs techniques calibrés BRVM (fixing journalier) ─────────────────
# Un tick = un jour de trading réel → périodes plus longues et seuils resserrés
# vs marchés liquides continus (RSI 30/70, MACD 12/26/9, BB std 2.0).

BRVM_RSI_PERIOD     = 20
BRVM_RSI_OVERSOLD   = 35
BRVM_RSI_OVERBOUGHT = 65
BRVM_MACD_FAST      = 8
BRVM_MACD_SLOW      = 21
BRVM_MACD_SIGNAL    = 5
BRVM_BB_PERIOD      = 20   # inchangé vs standard
BRVM_BB_STD         = 1.5  # marché moins volatile → bandes plus serrées

# Stochastic
STOCH_K_PERIOD = 14
STOCH_D_PERIOD = 3

# ADX (Average Directional Index)
ADX_PERIOD = 14

# ─── Profils d'horizon ─────────────────────────────────────────────────────────
#
# Chaque profil définit :
#   - periods : paramètres des indicateurs
#   - weights : poids de chaque critère de scoring
#       rsi, ma_config, tendance_lt, macd, perf_relative, stochastic
#   - seuil_achat / seuil_vente : seuils signal
#   - jours_min : jours de données recommandés

HORIZON_PROFILES: dict[str, dict] = {
    "Court terme": {
        "label": "Court terme (1–4 semaines)",
        "emoji": "⚡",
        "max_holding_days": 30,
        "review_interval_days": 5,
        "periods": {
            "rsi": 7,
            "ma_short": 10,
            "ma_mid": 20,
            "ma_long": 50,
            "ma_long_fallback": 50,
            "macd_fast": 8,
            "macd_slow": 17,
            "macd_signal": 9,
            "stoch_k": 5,
            "stoch_d": 3,
            "adx": 10,
            "bollinger": 15,
            "bb_std": 2.0,
            "rsi_oversold": 30,
            "rsi_overbought": 70,
        },
        "weights": {
            # Critère : multiplicateur (1 = poids normal, 2 = double, 0 = ignoré)
            "rsi": 1,
            "ma_config": 1,
            "tendance_lt": 0,    # LT non pertinent pour CT
            "macd": 2,           # MACD prioritaire en CT
            "perf_relative": 0,  # Non pertinent en CT
            "stochastic": 2,     # Stochastic prioritaire en CT
        },
        "seuil_achat": 2,   # recalibré post-A5 (group caps réduisent le range pratique)
        "seuil_vente": -2,
        "jours_min": 60,
    },
    "Moyen terme": {
        "label": "Moyen terme (1–6 mois)",
        "emoji": "📈",
        "max_holding_days": 90,
        "review_interval_days": 14,  # bi-mensuel : optimum TF-BRVM (frais/2 vs 7j, Sharpe OOS +1.41)
        "periods": {
            "rsi": BRVM_RSI_PERIOD,
            "ma_short": 20,
            "ma_mid": 50,
            "ma_long": 200,
            "ma_long_fallback": 100,
            "macd_fast": BRVM_MACD_FAST,
            "macd_slow": BRVM_MACD_SLOW,
            "macd_signal": BRVM_MACD_SIGNAL,
            "stoch_k": 14,
            "stoch_d": 3,
            "adx": 14,
            "bollinger": 20,
            "bb_std": BRVM_BB_STD,
            "rsi_oversold": BRVM_RSI_OVERSOLD,
            "rsi_overbought": BRVM_RSI_OVERBOUGHT,
        },
        "weights": {
            "rsi": 1,
            "ma_config": 1,
            "tendance_lt": 1,
            "macd": 1,
            "perf_relative": 1,
            "stochastic": 1,
        },
        "seuil_achat": 2,   # recalibré post-A5
        "seuil_vente": -2,
        "jours_min": 120,
    },
    "Long terme": {
        "label": "Long terme (6 mois+)",
        "emoji": "🏦",
        "max_holding_days": 180,
        "review_interval_days": 14,
        "periods": {
            "rsi": 21,
            "ma_short": 50,
            "ma_mid": 100,
            "ma_long": 200,
            "ma_long_fallback": 150,
            "macd_fast": 12,
            "macd_slow": 26,
            "macd_signal": 9,
            "stoch_k": 21,
            "stoch_d": 7,
            "adx": 21,
            "bollinger": 30,
            "bb_std": 2.0,
            "rsi_oversold": 30,
            "rsi_overbought": 70,
        },
        "weights": {
            "rsi": 1,
            "ma_config": 2,       # Configuration MA très importante en LT
            "tendance_lt": 2,     # Tendance LT capitale
            "macd": 1,
            "perf_relative": 2,   # Alpha vs indice clé en LT
            "stochastic": 0,      # Stochastic peu fiable sur LT
        },
        "seuil_achat": 3,   # recalibré post-A5 (reste plus sélectif que CT/MT)
        "seuil_vente": -3,
        "jours_min": 250,
    },
}

DEFAULT_HORIZON = "Moyen terme"

# ─── Scoring ──────────────────────────────────────────────────────────────────

SCORE_ACHAT_SEUIL = 3
SCORE_VENTE_SEUIL = -3

# ─── Indice de référence BRVM ──────────────────────────────────────────────────

BRVM_INDEX_TICKER = "BRVMC"

# ─── Périodes disponibles dans l'interface ────────────────────────────────────

PERIODES_DISPONIBLES = {
    "90 jours": 90,
    "180 jours": 180,
    "365 jours": 365,
}

# ─── Headers HTTP (éviter les blocages basiques) ──────────────────────────────

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Referer": "https://www.sikafinance.com/",
}

# ─── Calendrier jours fériés UEMOA (communs à toute la zone) ─────────────────

UEMOA_FIXED_HOLIDAYS: list[tuple[int, int]] = [
    (1,  1),   # Jour de l'An
    (5,  1),   # Fête du Travail
    (8, 15),   # Assomption
    (11, 1),   # Toussaint
    (12, 25),  # Noël
]

CI_FIXED_HOLIDAYS: list[tuple[int, int]] = [
    (8,  7),   # Fête Nationale CI
    (11, 15),  # Fête Nationale CI (Proclamation République)
]


def is_brvm_holiday(dt) -> bool:
    """Retourne True si dt est un jour non ouvré BRVM (week-end ou férié UEMOA/CI)."""
    if hasattr(dt, "date"):
        d = dt.date()
    else:
        d = dt
    if d.weekday() >= 5:  # Samedi=5, Dimanche=6
        return True
    for m, j in UEMOA_FIXED_HOLIDAYS + CI_FIXED_HOLIDAYS:
        if d.month == m and d.day == j:
            return True
    return False
