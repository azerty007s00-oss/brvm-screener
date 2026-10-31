/**
 * LE PORTEFEUILLE DU CLUB, A LA BOURSE DU SOIR.
 *
 * La valeur du portefeuille n'etait connue qu'au releve mensuel de la SGI,
 * recopie a la main. Le site lit desormais chaque soir les cours de cloture
 * et l'indice BRVM Composite sur brvm.org ; le bureau n'inscrit que ce que
 * seul le club sait : ses achats, ses ventes, ses dividendes. Le releve PDF
 * de la SGI, lu par le site, fixe le point de depart et sert de controle :
 * chaque nouveau releve recale les positions et les liquidites.
 *
 * Tout ce qui suit est un calcul pur, sans base ni reseau : la verification
 * le rejoue sur des pages et un releve figes.
 */

/* ------------------------------------------------------------------ nombres */

/** « 11 213.616 », « 1 249 216.016 », « -56 232.999 », « 2,13 » : un nombre, ou null. */
export function lireNombre(texte: string): number | null {
  const t = texte.replace(/[\s  ]/g, "").replace(/,/g, ".").replace(/[−–]/g, "-");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « 30 octobre 2026 » ou « Vendredi, 30 octobre, 2026 » : AAAA-MM-JJ, ou null. */
export function lireDateEnLettres(texte: string): string | null {
  const m = /(\d{1,2})\s+([a-zéû]+),?\s+(\d{4})/i.exec(texte);
  if (!m) return null;
  const mois = MOIS.indexOf(m[2].toLowerCase()) + 1;
  if (mois === 0) return null;
  return `${m[3]}-${String(mois).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/* ------------------------------------------------------------- brvm.org */

/** `variation` : celle du jour, en fraction (0,0213 pour +2,13 %). */
export type Cours = { symbole: string; nom: string; cloture: number; variation: number };
export type Indice = { cloture: number; variationJour: number; variationAnnee: number };

function texteDe(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#039;|&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** La date de la seance : « Dernière mise à jour : Vendredi, 30 octobre, 2026 - 18:15 ». */
export function dateDeSeance(html: string): string | null {
  const t = texteDe(html);
  const m = /Derni[èe]re mise [àa] jour\s*:\s*([^-]+?\d{4})/i.exec(t);
  return m ? lireDateEnLettres(m[1]) : null;
}

/**
 * Le tableau des cours (brvm.org/fr/cours-actions/0) : symbole, nom, volume,
 * cours veille, ouverture, cloture, variation. Une ligne se reconnait a son
 * symbole, quatre a six capitales.
 */
export function lireCoursBrvm(html: string): Cours[] {
  const cours: Cours[] = [];
  for (const ligne of html.split(/<tr[\s>]/i).slice(1)) {
    const cellules = [...ligne.split(/<\/tr>/i)[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => texteDe(m[1]));
    if (cellules.length < 7 || !/^[A-Z]{3,6}$/.test(cellules[0])) continue;
    const cloture = lireNombre(cellules[5]);
    const variation = lireNombre(cellules[6]);
    if (cloture === null || cloture <= 0) continue;
    cours.push({ symbole: cellules[0], nom: cellules[1], cloture, variation: (variation ?? 0) / 100 });
  }
  return cours;
}

/** L'indice BRVM Composite (brvm.org/fr/indices) : cloture, variation du jour et depuis le 31 decembre. */
export function lireIndiceComposite(html: string): Indice | null {
  const t = texteDe(html);
  const m = /BRVM\s*-\s*COMPOSITE\s+([\d\s.,]+?)\s+([\d\s.,]+?)\s+(-?[\d.,]+)\s+(-?[\d.,]+)/i.exec(t);
  if (!m) return null;
  const cloture = lireNombre(m[2]);
  const jour = lireNombre(m[3]);
  const annee = lireNombre(m[4]);
  if (cloture === null || jour === null || annee === null) return null;
  return { cloture, variationJour: jour / 100, variationAnnee: annee / 100 };
}

/* --------------------------------------------------------- releve de la SGI */

/**
 * Les noms abreges du releve de la SGI, et le symbole de la cote qu'ils
 * designent. Un nom absent se retrouve par le cours : le releve donne celui
 * de la derniere seance, que brvm.org donne aussi.
 */
export const CORRESPONDANCES: Record<string, string> = {
  "NSIA BANQUE COTE DIV": "NSBC",
  "NESTLE CI": "NTLC",
  "ONATEL BF": "ONTBF",
  PALMCI: "PALC",
  "BOLLORE AFRICA LOGIS": "SDSC",
  SGBCI: "SGBC",
  "VIVO ENERGY CI": "SHEC",
  "SMB CI": "SMBC",
  "SONATEL SN": "SNTS",
  "SOGB CI": "SOGC",
  SETAO: "STAC",
  "SITAB CI": "STBC",
  "TOTAL SENEGAL": "TTLS",
  "UNIWAX CI": "UNXC",
  "SERVAIR ABIDJAN CI": "ABJC",
  "CIE CI": "CIEC",
  BIIC: "BICB",
  "BANK OF AFRICA BENIN": "BOAB",
  "BANK OF AFRICA CI": "BOAC",
  CFAO: "CFAC",
  "ECOBANK COTE D IVOIR": "ECOC",
  "ORANGE CI": "ORAC",
  "ORAGROUP TOGO": "ORGT",
  "TOTAL CI": "TTLC",
  "SOLIBRA CI": "SLBC",
  "SAPH CI": "SPHC",
  "SICABLE CI": "CABC",
  "FILTISAC CI": "FTSC",
  "SUCRIVOIRE": "SCRC",
  "SIB CI": "SIBC",
  "BICI CI": "BICC",
  "UNILEVER CI": "UNLC",
  "SODECI": "SDCC",
  "ETI TOGO": "ETIT",
  "CORIS BANK BF": "CBIBF",
};

/** Le nom d'usage de chaque titre, pour la page : la cote les ecrit en capitales et sans accents. */
export const NOMS: Record<string, string> = {
  ABJC: "Servair Abidjan",
  BICB: "BIIC Bénin",
  BOAB: "Bank of Africa Bénin",
  BOAC: "Bank of Africa Côte d'Ivoire",
  CFAC: "CFAO Motors Côte d'Ivoire",
  CIEC: "CIE Côte d'Ivoire",
  ECOC: "Ecobank Côte d'Ivoire",
  NSBC: "NSIA Banque Côte d'Ivoire",
  NTLC: "Nestlé Côte d'Ivoire",
  ONTBF: "Onatel Burkina Faso",
  ORAC: "Orange Côte d'Ivoire",
  ORGT: "Oragroup Togo",
  PALC: "Palm Côte d'Ivoire",
  SDSC: "Africa Global Logistics",
  SGBC: "Société Générale Côte d'Ivoire",
  SHEC: "Vivo Energy Côte d'Ivoire",
  SMBC: "SMB Côte d'Ivoire",
  SNTS: "Sonatel",
  SOGC: "SOGB Côte d'Ivoire",
  STAC: "Setao Côte d'Ivoire",
  STBC: "Sitab Côte d'Ivoire",
  TTLC: "TotalEnergies Côte d'Ivoire",
  TTLS: "TotalEnergies Sénégal",
  UNXC: "Uniwax Côte d'Ivoire",
};

export type LigneReleve = { nom: string; symbole: string | null; quantite: number; cmp: number; cours: number; valeur: number };
export type Releve = { date: string | null; liquidites: number; lignes: LigneReleve[]; total: number | null };

/**
 * Le releve, a partir de ses lignes de texte (chaque ligne : ses cellules
 * de gauche a droite). Une ligne de titre porte sept cellules : nom,
 * quantite, prix moyen, cours, plus-value, ponderation, valeur.
 */
export function lireReleve(lignes: string[][], cours: Cours[] = []): Releve {
  let date: string | null = null;
  let liquidites = 0;
  let total: number | null = null;
  const titres: LigneReleve[] = [];
  for (const cellules of lignes) {
    const texte = cellules.join(" ");
    if (!date && /situation au/i.test(texte)) date = lireDateEnLettres(texte);
    if (/^Liquidit/i.test(cellules[0] ?? "") && cellules.length >= 2) {
      liquidites += lireNombre(cellules.at(-1)!) ?? 0;
      continue;
    }
    if (/^TOTAL$/i.test(cellules[0] ?? "") && cellules.length >= 2) {
      total = lireNombre(cellules.at(-1)!);
      continue;
    }
    if (cellules.length !== 7) continue;
    const [nom, q, cmp, prix, , , valeur] = cellules;
    const nombres = [q, cmp, prix, valeur].map(lireNombre);
    if (nombres.some((n) => n === null) || /^\d/.test(nom)) continue;
    const [quantite, cmpN, coursN, valeurN] = nombres as number[];
    titres.push({ nom: nom.trim(), symbole: symboleDe(nom, coursN, cours), quantite, cmp: cmpN, cours: coursN, valeur: valeurN });
  }
  return { date, liquidites: Math.round(liquidites * 1000) / 1000, lignes: titres, total };
}

/** Le symbole d'un titre du releve : par son nom connu, sinon par son cours du jour, s'il est seul a l'avoir. */
export function symboleDe(nom: string, prix: number, cours: Cours[]): string | null {
  const connu = CORRESPONDANCES[nom.trim().toUpperCase()];
  if (connu) return connu;
  const memes = cours.filter((c) => Math.abs(c.cloture - prix) < 0.5);
  return memes.length === 1 ? memes[0].symbole : null;
}

/* -------------------------------------------------------- positions et argent */

export type NatureMouvement = "achat" | "vente" | "dividende";
export type Mouvement = {
  date: string;
  nature: NatureMouvement;
  symbole: string;
  quantite: number;
  prix: number;
  frais: number;
  /** Le net recu, pour un dividende. */
  montant: number;
};
export type Position = { symbole: string; nom: string; quantite: number; cmp: number };

/** L'effet d'un mouvement sur les liquidites du compte-titres. */
export function effetLiquidites(m: Mouvement): number {
  if (m.nature === "achat") return -(m.quantite * m.prix + m.frais);
  if (m.nature === "vente") return m.quantite * m.prix - m.frais;
  return m.montant;
}

/**
 * Les positions apres le releve : celles du releve, puis les achats (le prix
 * moyen s'ajuste, frais compris) et les ventes (le prix moyen ne bouge pas),
 * dans l'ordre des dates. Une position vendue en entier disparait.
 */
export function positionsApres(releve: { lignes: LigneReleve[] }, mouvements: Mouvement[]): Position[] {
  const p = new Map<string, Position>();
  for (const l of releve.lignes) {
    if (!l.symbole) continue;
    p.set(l.symbole, { symbole: l.symbole, nom: l.nom, quantite: l.quantite, cmp: l.cmp });
  }
  for (const m of [...mouvements].sort((a, b) => a.date.localeCompare(b.date))) {
    if (m.nature === "dividende") continue;
    const avant = p.get(m.symbole) ?? { symbole: m.symbole, nom: m.symbole, quantite: 0, cmp: 0 };
    if (m.nature === "achat") {
      const q = avant.quantite + m.quantite;
      const cout = avant.quantite * avant.cmp + m.quantite * m.prix + m.frais;
      p.set(m.symbole, { ...avant, quantite: q, cmp: q > 0 ? cout / q : 0 });
    } else {
      p.set(m.symbole, { ...avant, quantite: avant.quantite - m.quantite });
    }
  }
  return [...p.values()].filter((x) => x.quantite > 0);
}

export type LigneValorisee = Position & { cours: number; valeur: number; variation: number | null; plusValue: number };

/**
 * La valeur du soir : les liquidites, plus chaque titre a son dernier cours
 * (a defaut, celui du releve). Triee de la plus grosse ligne a la plus petite.
 */
export function valoriser(
  positions: Position[],
  cours: Map<string, { cloture: number; variation: number }>,
  repli: Map<string, number>,
  liquidites: number,
): { lignes: LigneValorisee[]; titres: number; total: number } {
  const lignes = positions
    .map((p) => {
      const c = cours.get(p.symbole);
      const prix = c?.cloture ?? repli.get(p.symbole) ?? p.cmp;
      return { ...p, cours: prix, valeur: p.quantite * prix, variation: c ? c.variation : null, plusValue: p.quantite * (prix - p.cmp) };
    })
    .sort((a, b) => b.valeur - a.valeur);
  const titres = lignes.reduce((t, l) => t + l.valeur, 0);
  return { lignes, titres, total: titres + liquidites };
}

/**
 * La performance d'une periode, apports retires (Dietz simple) : ce que la
 * gestion a fait de l'argent, et non ce que les cotisations y ont ajoute.
 */
export function performance(debut: number, fin: number, apportsNets: number): number | null {
  const base = debut + apportsNets / 2;
  return base > 0 ? (fin - debut - apportsNets) / base : null;
}

/**
 * La serie base 100 du club, jour apres jour : chaque jour, le rendement hors
 * apports de la veille au jour. `points` : valeur et apports du jour.
 */
export function indiceBase100(points: { date: string; valeur: number; apports: number }[]): { date: string; indice: number }[] {
  const sortie: { date: string; indice: number }[] = [];
  let indice = 100;
  let veille: number | null = null;
  for (const p of [...points].sort((a, b) => a.date.localeCompare(b.date))) {
    if (veille !== null && veille > 0) indice *= (p.valeur - p.apports) / veille;
    sortie.push({ date: p.date, indice });
    veille = p.valeur;
  }
  return sortie;
}

/**
 * Les liquidites du soir : celles du releve, plus les virements arrives
 * depuis (la SGI garde ses frais a l'arrivee), plus l'effet de chaque
 * mouvement inscrit apres le releve.
 */
export function liquiditesApres(
  releve: { date: string; liquidites: number },
  virements: { date: string; net: number; frais: number }[],
  mouvements: Mouvement[],
): number {
  const apres = (d: string) => d > releve.date;
  return (
    releve.liquidites +
    virements.filter((v) => apres(v.date)).reduce((t, v) => t + v.net - v.frais, 0) +
    mouvements.filter((m) => apres(m.date)).reduce((t, m) => t + effetLiquidites(m), 0)
  );
}

/**
 * Le point de depart de l'annee : le dernier releve au plus tard le 1er
 * janvier, a defaut le premier de l'annee. Null sans releve.
 */
export function departDeLAnnee(releves: { date: string; total: number }[], annee: number): { date: string; total: number } | null {
  const premier = `${annee}-01-01`;
  const tries = [...releves].sort((a, b) => a.date.localeCompare(b.date));
  return tries.filter((r) => r.date <= premier).at(-1) ?? tries.find((r) => r.date.startsWith(String(annee))) ?? null;
}

/* --------------------------------------------------------------- dividendes */

/**
 * Un avis de paiement de dividende, tel que brvm.org le publie
 * (brvm.org/fr/esv/paiement-de-dividendes) : la societe, l'exercice, la date
 * de paiement, la date ex-dividende, le montant net par action, et l'avis.
 */
export type AvisDividende = {
  emetteur: string;
  exercice: string;
  paiement: string;
  ex: string;
  /** Net par action, en FCFA ; null si l'avis le donne dans une autre monnaie. */
  montant: number | null;
  avis: string | null;
};

export function lireDividendesBrvm(html: string): AvisDividende[] {
  const debut = html.search(/Date ex-dividende/i);
  if (debut < 0) return [];
  const avis: AvisDividende[] = [];
  for (const ligne of html.slice(debut).split(/<tr[\s>]/i).slice(1)) {
    const corps = ligne.split(/<\/tr>/i)[0];
    const c = [...corps.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => texteDe(m[1]));
    if (c.length < 7) continue;
    const paiement = lireDateEnLettres(c[4]);
    const ex = lireDateEnLettres(c[5]);
    if (!c[0] || !paiement || !ex) continue;
    const m = /^(?:XOF\s*)?([\d\s.,]+?)\s*(?:F\s*CFA|FCFA|XOF)?$/i.exec(c[6]);
    const enFcfa = /F\s*CFA|XOF/i.test(c[6]);
    avis.push({
      emetteur: c[0],
      exercice: c[3],
      paiement,
      ex,
      montant: m && enFcfa ? lireNombre(m[1]) : null,
      avis: /href="([^"]+)"/i.exec(corps)?.[1] ?? null,
    });
  }
  return avis;
}

/**
 * Le titre d'un avis. brvm.org nomme les societes a sa facon (« SGCI »,
 * « TOTAL », « BANK OF AFRICA BN ») ; le nom du fichier de l'avis, plus
 * regulier, depart les cas douteux (« TOTAL » : Cote d'Ivoire ou Senegal).
 * Un avis qui designe zero ou plusieurs titres n'en designe aucun : le site
 * ne devine pas.
 */
const mot = (m: string) => new RegExp(`(^|[^a-z])${m}([^a-z]|$)`);
const EMETTEURS: [RegExp, string][] = [
  [/agl_ci|bollore/, "SDSC"],
  [/tractafric/, "PRSC"],
  [mot("smb"), "SMBC"],
  [/sodeci|sode_ci/, "SDCC"],
  [/nei-ceda/, "NEIC"],
  [/vivo/, "SHEC"],
  [/totalenergies_marketing_ci/, "TTLC"],
  [/totalenergies_marketing_sn|total senegal/, "TTLS"],
  [/saph/, "SPHC"],
  [/sgci|societe_generale/, "SGBC"],
  [/nestle/, "NTLC"],
  [/cfao/, "CFAC"],
  [/sitab/, "STBC"],
  [/sogb/, "SOGC"],
  [/nsbc|nsia/, "NSBC"],
  [mot("lnb"), "LNBB"],
  [/loterie/, "LNBB"],
  [/solibra/, "SLBC"],
  [/cie[ _]ci/, "CIEC"],
  [/biic/, "BICB"],
  [/servair/, "ABJC"],
  [/eti_tg|ecobank tg/, "ETIT"],
  [mot("sib"), "SIBC"],
  [/bici/, "BICC"],
  [/palm/, "PALC"],
  [/coris/, "CBIBF"],
  [/orange[ _]ci/, "ORAC"],
  [mot("onatel"), "ONTBF"],
  [/sicable/, "CABC"],
  [/boam|bank of africa ml/, "BOAM"],
  [/ecobank[ _]ci/, "ECOC"],
  [/boa_sn|bank of africa sn/, "BOAS"],
  [/boab([^a-z]|$)|bank of africa bn/, "BOAB"],
  [/boa_ci|bank of africa ci/, "BOAC"],
  [/boa_bf|bank of africa bf/, "BOABF"],
  [/boa_ne|bank of africa ne/, "BOAN"],
  [/sonatel/, "SNTS"],
  [/filtisac/, "FTSC"],
  [/setao/, "STAC"],
  [/uniwax/, "UNXC"],
  [/oragroup/, "ORGT"],
  [/bridge/, "BBGC"],
  [/sucrivoire/, "SCRC"],
  [/unilever/, "UNLC"],
  [/safca/, "SAFC"],
];

export function symboleDuDividende(a: Pick<AvisDividende, "emetteur" | "avis">): string | null {
  const texte = `${a.emetteur} ${(a.avis ?? "").split("/").at(-1) ?? ""}`.toLowerCase();
  const trouves = new Set(EMETTEURS.filter(([r]) => r.test(texte)).map(([, s]) => s));
  return trouves.size === 1 ? [...trouves][0] : null;
}

/**
 * Les actions detenues a la veille de la date ex-dividende : seules elles
 * touchent le dividende. A partir du releve, en avancant (mouvements entre le
 * releve et la veille) ou en reculant (mouvements entre la date ex et le
 * releve, qui y sont deja comptes).
 */
export function quantiteALaVeille(symbole: string, ex: string, releve: { date: string; lignes: LigneReleve[] }, mouvements: Mouvement[]): number {
  let q = releve.lignes.filter((l) => l.symbole === symbole).reduce((t, l) => t + l.quantite, 0);
  for (const m of mouvements) {
    if (m.symbole !== symbole || m.nature === "dividende") continue;
    const signe = m.nature === "achat" ? 1 : -1;
    if (ex > releve.date && m.date > releve.date && m.date < ex) q += signe * m.quantite;
    if (ex <= releve.date && m.date >= ex && m.date <= releve.date) q -= signe * m.quantite;
  }
  return Math.max(0, q);
}
