/**
 * LE VOTE EN LIGNE, PONDERE PAR LES PARTS.
 *
 * Les decisions se prenaient dans le groupe WhatsApp, au pouce leve : on ne
 * savait ni qui avait vote, ni si la majorite des statuts etait atteinte, et
 * personne ne comptait les voix au prorata des parts comme le veut l'art. 12.
 * Tout membre peut desormais soumettre une question au vote ; chacun vote
 * pour, contre ou s'abstient, et peut changer d'avis jusqu'a la cloture.
 *
 * Le vote est public : chacun voit qui a vote quoi, comme a main levee.
 *
 * La base de la majorite est l'ensemble des voix qui peuvent voter, et non
 * les seules voix exprimees : une abstention, un silence comptent contre
 * l'adoption. Ne votent pas : un membre dont le droit de vote est suspendu
 * (R2, plus de 30 jours de retard) et le membre vise par une exclusion.
 *
 * Calcul pur, sans base ni horloge : la verification le rejoue.
 */

export const MAJORITES = {
  simple: {
    libelle: "Majorité simple",
    aide: "Plus de la moitié des voix qui peuvent voter. Pour les décisions courantes : un achat de titres, un objectif.",
    regle: "plus de la moitié des voix",
  },
  trois_quarts: {
    libelle: "Les 3/4 des voix",
    aide: "Pour modifier les statuts ou exclure un membre (art. 20).",
    regle: "les 3/4 des voix",
  },
  unanimite: {
    libelle: "Unanimité",
    aide: "Toutes les voix qui peuvent voter, sans abstention.",
    regle: "l'unanimité des voix",
  },
} as const;
export type Majorite = keyof typeof MAJORITES;

export const CHOIX = [
  { cle: "pour", libelle: "Pour" },
  { cle: "contre", libelle: "Contre" },
  { cle: "abstention", libelle: "Abstention" },
] as const;
export type Choix = (typeof CHOIX)[number]["cle"];

/** L'etat d'un vote, colonne `votes.status`. Des codes : sans accent. */
export const STATUT_VOTE = { ouvert: "ouvert", clos: "clos", annule: "annule" } as const;
export type StatutVote = (typeof STATUT_VOTE)[keyof typeof STATUT_VOTE];

/** L'heure de cloture d'un vote : 20 h GMT, heure d'Abidjan. */
export const HEURE_CLOTURE = 20;

/** La relance de ceux qui n'ont pas vote : au premier passage a moins de 36 heures de la cloture. */
export const RELANCE_VOTE_AVANT_MS = 36 * 3_600_000;

export function estMajorite(v: string): v is Majorite {
  return v in MAJORITES;
}
export function estChoix(v: string): v is Choix {
  return CHOIX.some((c) => c.cle === v);
}

/* ----------------------------------------------------------------- electeurs */

export type Exclusion = "suspendu" | "vise";

export type Electeur = {
  membreId: string;
  nom: string;
  /** Sa part du club, de 0 a 1 : son poids dans le vote (art. 12). */
  poids: number;
  /** Pourquoi il ne vote pas ; null s'il vote. */
  exclu: Exclusion | null;
};

/**
 * Le poids de chaque personne : sa part du club, plus celle des parts
 * rachetees qu'elle detient sans les avoir encore fusionnees.
 */
export function poidsDesPersonnes(
  parts: { membreId: string; part: number }[],
  titulaires: Map<string, string | null>,
): Map<string, number> {
  const poids = new Map<string, number>();
  for (const p of parts) {
    const personne = titulaires.get(p.membreId) ?? p.membreId;
    poids.set(personne, (poids.get(personne) ?? 0) + Math.max(0, p.part));
  }
  return poids;
}

export function electeurs(
  personnes: { id: string; nom: string }[],
  poids: Map<string, number>,
  suspendus: Set<string>,
  vise: string | null,
): Electeur[] {
  return personnes.map((p) => ({
    membreId: p.id,
    nom: p.nom,
    poids: poids.get(p.id) ?? 0,
    exclu: p.id === vise ? "vise" : suspendus.has(p.id) ? "suspendu" : null,
  }));
}

/* ---------------------------------------------------------------- depouillement */

export type Bulletin = { membreId: string; choix: Choix };

export type Resultat = {
  /** Le total des voix qui peuvent voter : la base de la majorite. */
  base: number;
  pour: number;
  contre: number;
  abstention: number;
  /** Les voix admises qui ne se sont pas exprimees. */
  silence: number;
  /** Part des voix pour dans la base, de 0 a 1. */
  tauxPour: number;
  admis: number;
  votants: number;
  adopte: boolean;
};

/** Une marge d'arrondi : 3/4 de 1 doit valoir 0,75, pas 0,7499999. */
const EPSILON = 1e-9;

export function depouiller(liste: Electeur[], bulletins: Bulletin[], majorite: Majorite): Resultat {
  const admis = liste.filter((e) => e.exclu === null);
  const base = admis.reduce((t, e) => t + e.poids, 0);
  const choixDe = new Map(bulletins.map((b) => [b.membreId, b.choix]));
  let pour = 0;
  let contre = 0;
  let abstention = 0;
  let votants = 0;
  for (const e of admis) {
    const c = choixDe.get(e.membreId);
    if (!c) continue;
    votants++;
    if (c === "pour") pour += e.poids;
    else if (c === "contre") contre += e.poids;
    else abstention += e.poids;
  }
  const tauxPour = base > 0 ? pour / base : 0;
  const adopte =
    base > 0 &&
    (majorite === "simple"
      ? tauxPour > 0.5 + EPSILON
      : majorite === "trois_quarts"
        ? tauxPour >= 0.75 - EPSILON
        : admis.every((e) => choixDe.get(e.membreId) === "pour"));
  return {
    base,
    pour,
    contre,
    abstention,
    silence: Math.max(0, base - pour - contre - abstention),
    tauxPour,
    admis: admis.length,
    votants,
    adopte,
  };
}

/** Le seuil d'une majorite, pour la barre du resultat : 0,5, 0,75 ou 1. */
export function seuil(majorite: Majorite): number {
  return majorite === "simple" ? 0.5 : majorite === "trois_quarts" ? 0.75 : 1;
}

/** « 77,8 % ». */
export function pourcent(x: number): string {
  return `${(Math.round(x * 1000) / 10).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

/** La phrase du resultat : « 77,8 % des voix pour, au-dessus des 75 % exigés. » */
export function phraseResultat(r: Resultat, majorite: Majorite): string {
  const s = seuil(majorite);
  const exige = majorite === "simple" ? "plus de 50 %" : majorite === "trois_quarts" ? "75 %" : "l'unanimité";
  if (majorite === "unanimite") {
    return r.adopte
      ? "Toutes les voix qui pouvaient voter se sont prononcées pour."
      : `${pourcent(r.tauxPour)} des voix pour : l'unanimité n'est pas atteinte.`;
  }
  return r.adopte
    ? `${pourcent(r.tauxPour)} des voix pour, au-dessus des ${exige} exigés.`
    : `${pourcent(r.tauxPour)} des voix pour, ${r.tauxPour >= s - EPSILON ? "sans dépasser" : "sous"} les ${exige} exigés.`;
}

/* ------------------------------------------------------------------ alertes */

/*
 * Le ton du club : on se tutoie, a l'ivoirienne. `cloture` est deja ecrite
 * (« dimanche 15/11 à 20 h GMT »), `local` l'heure du membre s'il vit ailleurs.
 */
type Local = { heure: string; lieu: string } | null;
const precision = (local: Local) => (local ? ` (${local.lieu} : ${local.heure})` : "");

export function alerteInvitation(question: string, cloture: string, local: Local = null): { titre: string; corps: string } {
  return {
    titre: "On vote, môgô !",
    corps: `« ${question} » Ta voix compte au prorata de ta part. Vote avant le ${cloture}${precision(local)}.`,
  };
}

export function alerteRelanceVote(question: string, cloture: string, local: Local = null): { titre: string; corps: string } {
  return {
    titre: "Ta voix manque dêh",
    corps: `« ${question} » ferme le ${cloture}${precision(local)}. Pour, contre ou abstention : un toucher, c'est réglé.`,
  };
}

export function alerteResultat(question: string, r: Resultat, majorite: Majorite): { titre: string; corps: string } {
  return {
    titre: r.adopte ? "Adopté !" : "Rejeté",
    corps: `« ${question} » ${phraseResultat(r, majorite)}`,
  };
}

export function alerteAnnulation(question: string, motif: string): { titre: string; corps: string } {
  return { titre: "Vote annulé", corps: `« ${question} » est annulé : ${motif}` };
}
