#!/usr/bin/env python3
"""
collecte_calendrier.py - Collecte le calendrier BRVM des mises en paiement.

Alimente data/dividendes_paiements.csv, qui sert a crediter le dividende a sa
date reelle dans recherche/etude_facteurs.py et a afficher la repartition de
tresorerie dans strategie/panier.py.

Le fichier contient deja 113 lignes saisies a la main (2021-04 -> 2024-06).
Ce module ne les ecrase jamais : il fusionne et deduplique sur
(date, ticker, exercice). Une ligne saisie a la main gagne sur une ligne
collectee, parce qu'elle a ete relue.

Ce conteneur n'a pas acces aux sites sources : la politique reseau les refuse.
Le module est donc ecrit pour tourner dans GitHub Actions, ou les workflows
existants atteignent deja SikaFinance. Il est defensif en consequence : il
essaie plusieurs URL candidates, et quand aucune ne donne de ligne exploitable
il ecrit un diagnostic de ce qu'il a recu au lieu d'echouer en silence.

Usage :
    python collecte_calendrier.py                  # collecte et fusionne
    python collecte_calendrier.py --pages 20       # remonte plus loin
    python collecte_calendrier.py --dry-run        # n'ecrit rien
    python collecte_calendrier.py --diagnostic     # dump du HTML recu
"""

import argparse
import html as html_lib
import os
import re
import sys
import unicodedata
from datetime import datetime

import pandas as pd

RACINE = os.path.dirname(os.path.abspath(__file__))
FICHIER = os.path.join(RACINE, "data", "dividendes_paiements.csv")

COLONNES = ["date", "societe", "ticker", "exercice", "type", "note"]

# Pages candidates. L'ordre compte : la premiere qui rend des lignes gagne.
# A corriger depuis les logs d'une execution reelle si aucune ne repond.
URLS_CANDIDATES = [
    "https://www.sikafinance.com/marches/agenda",
    "https://www.sikafinance.com/bourse/agenda",
    "https://www.richbourse.com/common/agenda",
]

EN_TETES = {
    "User-Agent": ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
    "Accept-Language": "fr-FR,fr;q=0.9",
}

# Correspondance raison sociale -> ticker, relevee sur le calendrier officiel.
# Les libelles varient d'une annee a l'autre (BOA CI / BANK OF AFRICA CI,
# BOLLORE TRANSPORT & LOGISTICS CI devenu AFRICA GLOBAL LOGISTICS CI), d'ou
# une table d'alias plutot qu'un rapprochement sur TICKER_NAMES.
ALIAS = {
    "societe generale ci": "SGBC", "societe generale": "SGBC", "sgb ci": "SGBC",
    "orange ci": "ORAC",
    "sicable ci": "CABC", "sicable": "CABC",
    "ecobank ci": "ECOC",
    "boa mali": "BOAM", "bank of africa mali": "BOAM",
    "sonatel sn": "SNTS", "sonatel": "SNTS", "sonatel senegal": "SNTS",
    "boa benin": "BOAB", "boa-benin": "BOAB", "bank of africa benin": "BOAB",
    "boa bf": "BOABF", "boa burkina faso": "BOABF", "bank of africa bf": "BOABF",
    "boa ci": "BOAC", "boa cote d'ivoire": "BOAC", "bank of africa ci": "BOAC",
    "boa senegal": "BOAS", "bank of africa senegal": "BOAS",
    "boa sn": "BOAS", "bank of africa sn": "BOAS",
    "vivo energy ci": "SHEC", "vivo energy": "SHEC",
    "africa global logistics ci": "SDSC",
    "bollore transport & logistics ci": "SDSC",
    "bollore transport et logistics": "SDSC",
    "saph ci": "SPHC", "saph": "SPHC",
    "total ci": "TTLC",
    "total sn": "TTLS", "total senegal": "TTLS",
    "nei-ceda ci": "NEIC", "nei ceda ci": "NEIC",
    "cfao motors ci": "CFAC",
    "sodeci": "SDCC", "sode ci": "SDCC",
    "sib ci": "SIBC", "societe ivoirienne de banque": "SIBC",
    "smb ci": "SMBC", "smb": "SMBC",
    "servair abidjan ci": "SIVC", "servair abidjan": "SIVC",
    "servair abidjan cote d'ivoire": "SIVC",
    "nestle ci": "NTLC",
    "bici ci": "BICC", "bicici": "BICC",
    "sitab ci": "STBC",
    "bernabe ci": "PRSC", "bernabe": "PRSC",
    "cie ci": "CIEC",
    "sogb ci": "SOGC", "sogb": "SOGC",
    "palm ci": "PALC",
    "nsia banque ci": "BNBC", "nsia banque": "BNBC",
    "coris bank international bf": "CBIBF",
    "coris bank international": "CBIBF",
    "coris bank international burkina faso": "CBIBF",
    "onatel bf": "ONTBF", "onatel": "ONTBF",
    "ecobank transnational incorporated tg": "ETIT", "eti tg": "ETIT",
    "solibra ci": "SLBC", "solibra": "SLBC",
    "uniwax ci": "UNXC", "uniwax": "UNXC",
    "setao ci": "STAC",
    "filtisac ci": "FTSC", "filtisac": "FTSC", "filtisac ci ": "FTSC",
    "crown siem ci": "SEMC",
    "oragroup tg": "ORGT", "oragroup": "ORGT",
    "sicor ci": "SICC", "sicor": "SICC",
}

# Societes du calendrier absentes de data/daily : on les enregistre sans
# ticker plutot que de les perdre, pour que le fichier reste un releve fidele.
HORS_UNIVERS = {"boa niger", "boa ng", "bank of africa ng", "bank of africa niger",
                "sucrivoire ci", "sucrivoire", "tractafric motors ci",
                "tractrafic motors ci", "ecobank group"}

MOTIF_DATE = re.compile(r"\b(\d{2})/(\d{2})/(\d{4})\b")
MOTIF_EXERCICE = re.compile(r"exercice\s*:?\s*(\d{4})", re.I)


def normaliser(texte: str) -> str:
    """Minuscules sans accents ni espaces multiples, pour le rapprochement."""
    texte = unicodedata.normalize("NFKD", str(texte))
    texte = "".join(c for c in texte if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", texte).strip().lower()


def resoudre_ticker(societe: str) -> tuple[str | None, str]:
    """Retourne (ticker ou None, note). La note explique une non-resolution."""
    cle = normaliser(societe)
    cle = re.sub(r"\s*\(.*?\)\s*", " ", cle).strip()
    if cle in ALIAS:
        return ALIAS[cle], ""
    if cle in HORS_UNIVERS:
        return None, "non couvert par data/daily"
    # tolere un suffixe pays residuel ("sicable ci sa")
    for alias, ticker in ALIAS.items():
        if cle.startswith(alias + " ") or cle == alias:
            return ticker, ""
    return None, "raison sociale non rapprochee"


def classer(libelle: str) -> str | None:
    """Type d'evenement, ou None si la ligne ne concerne pas un dividende."""
    t = normaliser(libelle)
    # "projet d'affectation du resultat" ne contient pas le mot dividende mais
    # c'est l'annonce qui le fixe : c'est une date d'annonce, pas de paiement.
    if "affectation du resultat" in t:
        return "annonce"
    if "dividende" not in t:
        return None
    if "rectificatif" in t:
        return "rectificatif"
    if "annonce" in t or "projet d'affectation" in t or "prorogation" in t:
        return "annonce"
    if "report de paiement" in t:
        return "annonce"
    if "paiement" in t:
        return "paiement"
    return "annonce"


def extraire(html: str) -> pd.DataFrame:
    """
    Extrait les evenements dividende d'une page du calendrier.

    Le calendrier presente des lignes "JJ/MM/AAAA  SOCIETE : libelle". On
    travaille sur le texte brut plutot que sur la structure HTML, qui change
    plus souvent que la mise en forme des lignes.
    """
    texte = re.sub(r"<[^>]+>", "\n", html)
    texte = html_lib.unescape(texte)          # &eacute;, &#39;, &amp;, &nbsp;...
    texte = texte.replace("\xa0", " ")

    lignes, courant = [], None
    for brut in texte.split("\n"):
        morceau = brut.strip()
        if not morceau:
            continue
        trouve = MOTIF_DATE.fullmatch(morceau) or MOTIF_DATE.match(morceau)
        if trouve and morceau.startswith(trouve.group(0)):
            reste = morceau[trouve.end():].strip(" :-")
            courant = {"date": trouve.groups(), "libelle": reste}
            if reste:
                lignes.append(courant)
                courant = None
            continue
        if courant is not None:
            courant["libelle"] = morceau
            lignes.append(courant)
            courant = None

    enregistrements = []
    for ligne in lignes:
        jour, mois, annee = ligne["date"]
        libelle = ligne["libelle"]
        type_evt = classer(libelle)
        if type_evt is None:
            continue
        societe = re.split(r"\s*:\s*", libelle, maxsplit=1)[0].strip()
        if not societe or len(societe) > 90:
            continue
        ticker, note = resoudre_ticker(societe)
        exercice = MOTIF_EXERCICE.search(libelle)
        try:
            quand = datetime(int(annee), int(mois), int(jour)).date()
        except ValueError:
            continue
        enregistrements.append({
            "date":     quand,
            "societe":  societe,
            "ticker":   ticker,
            "exercice": int(exercice.group(1)) if exercice else None,
            "type":     type_evt,
            "note":     note,
        })
    return pd.DataFrame(enregistrements, columns=COLONNES)


def charger_existant() -> pd.DataFrame:
    if not os.path.exists(FICHIER):
        return pd.DataFrame(columns=COLONNES)
    table = pd.read_csv(FICHIER, parse_dates=["date"])
    table["date"] = table["date"].dt.date
    return table


def fusionner(existant: pd.DataFrame, collecte: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """
    Fusionne en gardant la ligne existante en cas de doublon.

    Clef : (date, ticker, exercice). Une ligne sans ticker est dedupliquee sur
    la raison sociale, pour ne pas accumuler les societes non rapprochees.
    """
    if collecte.empty:
        return existant, 0
    collecte = collecte.dropna(subset=["exercice"])
    if collecte.empty:
        return existant, 0

    def clef(table):
        identite = table["ticker"].fillna("~" + table["societe"].map(normaliser))
        return list(zip(table["date"], identite, table["exercice"]))

    connues = set(clef(existant)) if not existant.empty else set()
    nouvelles = collecte[[c not in connues for c in clef(collecte)]]
    if nouvelles.empty:
        return existant, 0
    fusion = pd.concat([existant, nouvelles], ignore_index=True)
    fusion = fusion.sort_values(["date", "societe"]).reset_index(drop=True)
    return fusion, len(nouvelles)


def recuperer(url: str, page: int, diagnostic: bool) -> str | None:
    import requests
    cible = url if page <= 1 else f"{url}?page={page}"
    try:
        reponse = requests.get(cible, headers=EN_TETES, timeout=25)
    except Exception as erreur:                       # noqa: BLE001
        print(f"  {cible} -> {type(erreur).__name__}: {erreur}")
        return None
    print(f"  {cible} -> HTTP {reponse.status_code}, {len(reponse.text)} octets")
    if diagnostic:
        # Imprime dans la sortie standard, et pas seulement dans un fichier :
        # c'est le seul canal lisible depuis une execution GitHub Actions
        # quand on n'a pas acces au site pour corriger les URL.
        extrait = re.sub(r"\s+", " ", reponse.text)[:3000]
        print(f"    --- debut du HTML recu (3000 car.) ---\n{extrait}\n    --- fin ---")
    return reponse.text if reponse.status_code == 200 else None


def main() -> int:
    analyseur = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    analyseur.add_argument("--pages", type=int, default=12,
                           help="nombre de pages a parcourir (defaut 12)")
    analyseur.add_argument("--dry-run", action="store_true",
                           help="affiche ce qui serait ajoute sans ecrire")
    analyseur.add_argument("--diagnostic", action="store_true",
                           help="imprime le HTML recu dans les logs, pour corriger les URL")
    arguments = analyseur.parse_args()

    existant = charger_existant()
    print(f"fichier actuel : {len(existant)} lignes")

    trouvees = []
    for url in URLS_CANDIDATES:
        print(f"\nsource : {url}")
        total_source = 0
        for page in range(1, arguments.pages + 1):
            html = recuperer(url, page, arguments.diagnostic)
            if html is None:
                break
            lot = extraire(html)
            print(f"    {len(lot)} evenement(s) dividende extrait(s)")
            if lot.empty and page == 1:
                break
            total_source += len(lot)
            trouvees.append(lot)
            if lot.empty:
                break
        if total_source:
            print(f"  -> {total_source} evenements depuis cette source")
            break

    collecte = pd.concat(trouvees, ignore_index=True) if trouvees else \
        pd.DataFrame(columns=COLONNES)

    if collecte.empty:
        print("\nAucun evenement collecte.")
        print("Si l'echec est un refus reseau, lancer le workflow")
        print("'BRVM Dividend Calendar Collection' depuis l'onglet Actions.")
        print("Si les pages repondent mais ne donnent rien, relancer avec")
        print("--diagnostic : le HTML recu est imprime dans les logs.")
        return 1

    non_resolues = collecte[collecte["ticker"].isna()
                            & (collecte["note"] == "raison sociale non rapprochee")]
    if not non_resolues.empty:
        print(f"\n{len(non_resolues)} raison(s) sociale(s) non rapprochee(s) :")
        for nom in sorted(set(non_resolues["societe"])):
            print(f"  {nom}")
        print("  -> ajouter ces libelles au dictionnaire ALIAS.")

    fusion, ajoutees = fusionner(existant, collecte)
    print(f"\n{ajoutees} ligne(s) nouvelle(s), total {len(fusion)}")
    if ajoutees and not arguments.dry_run:
        fusion.to_csv(FICHIER, index=False, date_format="%Y-%m-%d")
        print(f"ecrit dans {FICHIER}")
    elif arguments.dry_run:
        print("--dry-run : rien n'a ete ecrit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
