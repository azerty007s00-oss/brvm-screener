"""
utils.py — Utilitaires partagés du BRVM Screener.

Fonctions de formatage, résolution de noms, helpers communs.
"""

from config import TICKER_NAMES


def get_company_name(ticker: str, fallback_to_ticker: bool = True) -> str:
    """
    Retourne le nom complet de la société pour un ticker BRVM.

    Args:
        ticker:             Symbole boursier (ex: "SNTS", "BICC")
        fallback_to_ticker: Si True, retourne le ticker si le nom est inconnu

    Returns:
        Nom complet (ex: "Sonatel — Orange Sénégal") ou le ticker en fallback
    """
    ticker = ticker.upper().strip()
    name = TICKER_NAMES.get(ticker)
    if name:
        return name
    return ticker if fallback_to_ticker else ""


def format_ticker_display(ticker: str) -> str:
    """
    Formate un ticker pour l'affichage : TICKER — Nom Complet.

    Ex: "SNTS — Sonatel — Orange Sénégal"
    """
    name = get_company_name(ticker, fallback_to_ticker=False)
    if name:
        return f"{ticker} — {name}"
    return ticker


def format_fcfa(value: float, decimals: int = 0) -> str:
    """Formate un montant en FCFA avec séparateur de milliers."""
    if decimals == 0:
        return f"{value:,.0f} FCFA"
    return f"{value:,.{decimals}f} FCFA"


def format_pct(value: float, sign: bool = True, decimals: int = 1) -> str:
    """Formate un pourcentage avec signe optionnel."""
    if sign:
        return f"{value:+.{decimals}f}%"
    return f"{value:.{decimals}f}%"


def format_variation(value: float) -> tuple[str, str]:
    """
    Formate une variation avec couleur CSS.

    Returns:
        (texte_formaté, couleur_hex)
    """
    color = "#0F6E56" if value >= 0 else "#A32D2D"
    text = format_pct(value, sign=True, decimals=2)
    return text, color


def format_volume(volume: float) -> str:
    """Formate un volume avec unités lisibles (K, M)."""
    if volume >= 1_000_000:
        return f"{volume / 1_000_000:.1f}M"
    if volume >= 1_000:
        return f"{volume / 1_000:.0f}K"
    return f"{volume:,.0f}"
