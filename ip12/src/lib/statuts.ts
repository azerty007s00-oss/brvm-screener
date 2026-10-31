/**
 * LES STATUTS DU CLUB, ET CE QUI LES PRECISE.
 *
 * Le texte des statuts n'est pas dans le code : le depot du code est public,
 * et l'art. 5 veut que tout ce qui se dit au club y reste. Le president
 * importe le PDF signe depuis le site ; le site en lit les articles et le
 * garde en base, avec le PDF. Une version corrigee et re-signee s'importe de
 * la meme facon et remplace la precedente.
 *
 * Les resolutions se tiennent a cote, chacune rattachee aux articles qu'elle
 * precise. Mise en forme pure : la verification la rejoue.
 */

export type Article = { numero: number; chapitre: string; texte: string };

/** Les intitules des chapitres, avec leurs accents : le PDF les ecrit en capitales nues. */
const CHAPITRES: Record<string, string> = {
  "CREATION ET OBJET": "Création et objet",
  "RESSOURCES DU CLUB": "Ressources du club",
  "FONCTIONNEMENT ET ADMINISTRATION": "Fonctionnement et administration",
  "ADMISSION, DEMISSION, EXCLUSION, DECES": "Admission, démission, exclusion, décès",
  "COMPTABILITE ET REPARTITION DES PRODUITS": "Comptabilité et répartition des produits",
  DISSOLUTION: "Dissolution",
  "ACTE CONSTITUTIF": "Acte constitutif",
};

function intitule(ligne: string): string {
  const cle = ligne.trim().replace(/\s+/g, " ");
  if (CHAPITRES[cle]) return CHAPITRES[cle];
  const bas = cle.toLowerCase();
  return bas.charAt(0).toUpperCase() + bas.slice(1);
}

/** Un intitule de chapitre : une ligne en capitales, sans chiffre, qui n'ouvre pas un article. */
function estChapitre(ligne: string): boolean {
  const t = ligne.trim();
  return t.length >= 6 && t.length <= 60 && !/\d/.test(t) && t === t.toUpperCase() && /[A-Z]{4}/.test(t) && !/^ART/i.test(t);
}

/**
 * Les articles, a partir des lignes du PDF dans l'ordre de lecture. Un article
 * s'ouvre sur « Art. 9 : » ; ses lignes se rejoignent, un mot coupe en fin de
 * ligne (« ci-\napres ») se recolle, une puce ouvre une nouvelle ligne. Le
 * texte s'arrete aux signatures : elles restent dans le PDF.
 */
export function decouperStatuts(lignes: string[]): Article[] {
  const articles: Article[] = [];
  let chapitre = "";
  let courant: Article | null = null;
  for (const brute of lignes) {
    const ligne = brute.replace(/\s+/g, " ").trim();
    if (!ligne) continue;
    if (/^Membres fondateurs/i.test(ligne)) break;
    const debut = /^Art\.?\s*(\d+)\s*:\s*(.*)$/i.exec(ligne);
    if (debut) {
      courant = { numero: Number(debut[1]), chapitre, texte: debut[2] };
      articles.push(courant);
      continue;
    }
    if (estChapitre(ligne)) {
      chapitre = intitule(ligne);
      courant = null;
      continue;
    }
    if (!courant) continue;
    if (/^[•·▪-]\s/.test(ligne)) {
      courant.texte += `\n• ${ligne.replace(/^[•·▪-]\s*/, "")}`;
    } else if (/[a-zà-ÿ]-$/i.test(courant.texte)) {
      courant.texte += ligne;
    } else {
      courant.texte += ` ${ligne}`;
    }
  }
  return articles.map((a) => ({ ...a, texte: a.texte.replace(/ +\n/g, "\n").trim() }));
}

/** Un titre court par article, pour le sommaire. */
export const TITRES: Record<number, string> = {
  1: "Constitution et durée",
  2: "Objet du club",
  3: "Nombre de membres",
  4: "Fiscalité",
  5: "Confidentialité",
  6: "Versement mensuel",
  7: "Parts",
  8: "Échéance de paiement",
  9: "Retards et pénalités",
  10: "Usage des sommes",
  11: "Réunions",
  12: "Décisions et voix",
  13: "Délégations",
  14: "Le bureau",
  15: "L'intermédiaire financier",
  16: "Admission",
  17: "Évaluation à l'admission",
  18: "Retrait d'un membre",
  19: "Décès d'un membre",
  20: "Exclusion",
  21: "Exercice et produits",
  22: "Dissolution à l'échéance",
  23: "Dissolution anticipée",
  24: "Partage des avoirs",
  25: "Acte constitutif",
};

/**
 * Les renvois faux du texte signe : une note les redresse, tant que le texte
 * les porte. Une version corrigee et re-signee les fait disparaitre d'elle-meme.
 */
const RENVOIS: { article: number; motif: RegExp; note: string }[] = [
  { article: 1, motif: /article 25/i, note: "La dissolution anticipée est prévue à l'art. 23, et non à l'art. 25." },
  { article: 9, motif: /article 22/i, note: "L'exclusion relève de l'art. 20, et non de l'art. 22." },
  { article: 22, motif: /article 3\b/i, note: "La durée de dix ans est fixée à l'art. 1, et non à l'art. 3." },
];

export function noteDe(a: Pick<Article, "numero" | "texte">): string | null {
  return RENVOIS.find((r) => r.article === a.numero && r.motif.test(a.texte))?.note ?? null;
}

/* -------------------------------------------------------------- resolutions */

export const STATUT_RESOLUTION = { adoptee: "adoptee", aConfirmer: "a_confirmer", remplacee: "remplacee" } as const;
export type StatutResolution = (typeof STATUT_RESOLUTION)[keyof typeof STATUT_RESOLUTION];

export const LIBELLE_STATUT: Record<StatutResolution, string> = {
  adoptee: "Adoptée",
  a_confirmer: "À confirmer",
  remplacee: "Remplacée",
};

export type Resolution = {
  code: string;
  /** La premiere date connue, AAAA-MM-JJ : sert au tri. */
  decideeLe: string;
  /** La date telle qu'on la dit : « 04/01/2026 → 10/03/2026 ». */
  quand: string;
  titre: string;
  detail: string;
  vote: string;
  articles: number[];
  statut: StatutResolution;
  /** Ce que le statut demande de savoir : « Adoptée, puis reprise des mensualités ». */
  precision: string | null;
};

function sansMarques(t: string): string {
  return t.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function dateIso(t: string): string | null {
  const m = /(\d{2})(?:-\d{2})?\/(\d{2})\/(\d{4})/.exec(t);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Les resolutions d'un recensement en Markdown : les lignes du tableau dont la
 * premiere cellule est un code (S1, R4). Le titre est le passage en gras ; le
 * reste de la phrase est le detail. Les decisions de fonctionnement et
 * d'investissement, sans code, ne sont pas reprises.
 */
export function lireRecensement(md: string): Resolution[] {
  const sortie: Resolution[] = [];
  for (const ligne of md.split("\n")) {
    const cellules = ligne.split("|").slice(1, -1).map((c) => c.trim());
    if (cellules.length < 6 || !/^[A-Z]\d{1,2}$/.test(cellules[0])) continue;
    const [code, quand, texte, vote, article, statutBrut] = cellules;
    const gras = /\*\*(.+?)\*\*/.exec(texte)?.[1];
    const phrase = sansMarques(texte);
    const titre = gras ? sansMarques(gras) : phrase.split(/[.:]/)[0];
    const titreMaj = titre.charAt(0).toUpperCase() + titre.slice(1);
    /* Le titre ouvre la phrase : le detail en est la suite. Sinon, la phrase entiere. */
    const detail = (phrase.startsWith(titre) ? phrase.slice(titre.length).replace(/^[\s.:,;]+/, "") : phrase).replace(
      /^./,
      (c) => c.toUpperCase(),
    );
    const s = sansMarques(statutBrut);
    const statut: StatutResolution = /^Adopt/i.test(s)
      ? STATUT_RESOLUTION.adoptee
      : /remplac/i.test(s)
        ? STATUT_RESOLUTION.remplacee
        : STATUT_RESOLUTION.aConfirmer;
    let precision = s
      .replace(/^(Adoptée|À confirmer)\s*/i, "")
      .replace(/,?\s*voir points de vigilance/i, "")
      .replace(/^,\s*/, "")
      .trim();
    if (precision.startsWith("(") && precision.endsWith(")")) precision = precision.slice(1, -1).trim();
    sortie.push({
      code,
      decideeLe: dateIso(quand) ?? "1970-01-01",
      quand: sansMarques(quand),
      titre: titreMaj.replace(/[.\s]+$/, ""),
      detail,
      vote: sansMarques(vote),
      articles: [...article.matchAll(/(\d+)/g)].map((m) => Number(m[1])),
      statut,
      precision: precision ? precision.charAt(0).toUpperCase() + precision.slice(1) : null,
    });
  }
  return sortie;
}

/** Les resolutions qui precisent un article, de la plus recente a la plus ancienne. */
export function resolutionsDe(numero: number, resolutions: Resolution[]): Resolution[] {
  return resolutions.filter((r) => r.articles.includes(numero)).sort((a, b) => b.decideeLe.localeCompare(a.decideeLe));
}

/** Un article correspond-il a la recherche ? Sans accents ni casse : « penalite » trouve « pénalité ». */
export function correspond(a: Pick<Article, "numero" | "texte">, recherche: string): boolean {
  const plat = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = plat(recherche.trim());
  if (!q) return true;
  if (/^(art\.?\s*)?\d+$/.test(q)) return a.numero === Number(q.replace(/\D/g, ""));
  return plat(`${TITRES[a.numero] ?? ""} ${a.texte}`).includes(q);
}
