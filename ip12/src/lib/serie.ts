import type { StatutMois } from "./penalites";

/**
 * LA SERIE DE PONCTUALITE.
 *
 * Payer avant le 10 ne se voyait nulle part : seul le retard laissait une
 * trace, une penalite. La serie compte les mois payes a l'heure, d'affilee,
 * jusqu'au mois en cours ; elle tombe a zero au premier mois paye en retard
 * ou impaye. Un mois paye d'avance compte : il etait regle avant l'echeance.
 * Le record est la plus longue serie atteinte.
 *
 * Les alertes ont le ton du club, a l'ivoirienne, et se tutoient. Rien n'est
 * public au-dela du nombre de membres en serie : la serie de chacun ne se
 * lit que sur son accueil.
 *
 * Calcul pur : la verification le rejoue.
 */

export type MoisSerie = { mois: string; statut: StatutMois };

/**
 * La serie en cours au mois `moisCourant` (AAAA-MM-01). Le mois courant compte
 * s'il est deja paye a l'heure ; non encore echu ou en attente de visa, il ne
 * compte pas encore, mais ne casse rien.
 */
export function serieEnCours(cellules: MoisSerie[], moisCourant: string): number {
  const passes = cellules.filter((c) => c.mois <= moisCourant && c.statut !== "hors_periode").sort((a, b) => b.mois.localeCompare(a.mois));
  let n = 0;
  for (const c of passes) {
    if (c.statut === "paye") n++;
    else if (c.mois === moisCourant && (c.statut === "a_venir" || c.statut === "en_attente")) continue;
    else break;
  }
  return n;
}

/** La plus longue suite de mois payes a l'heure, jusqu'au mois courant. */
export function record(cellules: MoisSerie[], moisCourant: string): number {
  let meilleur = 0;
  let courant = 0;
  for (const c of [...cellules].filter((x) => x.mois <= moisCourant && x.statut !== "hors_periode").sort((a, b) => a.mois.localeCompare(b.mois))) {
    if (c.statut === "paye") {
      courant++;
      meilleur = Math.max(meilleur, courant);
    } else if (!(c.mois === moisCourant && (c.statut === "a_venir" || c.statut === "en_attente"))) {
      courant = 0;
    }
  }
  return meilleur;
}

export type CaseFrise = { mois: string; etat: "ok" | "retard" | "attente" | "vide" };

/** Les douze derniers mois, jusqu'au courant, pour la frise de l'accueil. */
export function frise(cellules: MoisSerie[], moisCourant: string, n = 12): CaseFrise[] {
  const fin = new Date(`${moisCourant}T00:00:00Z`);
  const cases: CaseFrise[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() - i, 1));
    const mois = d.toISOString().slice(0, 10);
    const c = cellules.find((x) => x.mois === mois);
    const etat: CaseFrise["etat"] =
      !c || c.statut === "hors_periode"
        ? "vide"
        : c.statut === "paye"
          ? "ok"
          : c.statut === "a_venir" || c.statut === "en_attente"
            ? "attente"
            : "retard";
    cases.push({ mois, etat });
  }
  return cases;
}

/* ------------------------------------------------------------------ alertes */

export type TexteSerie = { titre: string; corps: string };

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const nomMois = (mois: string) => MOIS[Number(mois.slice(5, 7)) - 1];
const majuscule = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const mois = (n: number) => `${n} mois`;

/** Un versement a l'heure vient d'etre valide : la serie monte, ou bat le record. */
export function alerteSerieValidee(n: number, recordAvant: number, moisPaye: string, jourEcheance: number): TexteSerie {
  if (n >= 3 && n > recordAvant) {
    return { titre: `Nouveau record : ${mois(n)} !`, corps: "Tu es devenu le môgô fort de la cotisation. Le club peut faroter tranquille." };
  }
  if (n >= 2) {
    const ecart = recordAvant - n + 1;
    return {
      titre: `Tu as gâté mal même, man ! ${mois(n)} d'affilée`,
      corps:
        `${majuscule(nomMois(moisPaye))} payé avant le ${jourEcheance}, c'est doux.` +
        (ecart > 0 && ecart <= 3 ? ` Encore ${mois(ecart)} et ton record est dans le sac.` : "") +
        " Atalaku pour toi !",
    };
  }
  return {
    titre: "C'est parti : 1 mois à l'heure",
    corps: `${majuscule(nomMois(moisPaye))} payé avant le ${jourEcheance}. Garde le rythme, frérot, et la série va monter.`,
  };
}

/** Trois jours avant l'echeance, a qui a une serie en jeu. */
export function alerteSerieJ3(n: number, jourEcheance: number): TexteSerie {
  return {
    titre: `On dit quoi ? Ta série de ${mois(n)} t'attend`,
    corps: `Le ${jourEcheance}, c'est dans 3 jours : fais ça chap chap, avant que ça gâte.`,
  };
}

/** Le jour de l'echeance, le soir, a qui n'a pas encore paye. */
export function alerteSerieJourJ(n: number): TexteSerie {
  return {
    titre: "Dernier jour, faut pas laisser ça gâter !",
    corps: `Avant minuit, tes ${mois(n)} restent zo. Un toucher pour payer, y a pas drap.`,
  };
}

/** Le lendemain de l'echeance, a qui avait une serie et ne l'a pas tenue. */
export function alerteSerieTombee(n: number, moisSuivant: string, jourEcheance: number): TexteSerie {
  return {
    titre: "Yako, la série est tombée à 0",
    corps: `Tes ${mois(n)} d'affilée sont partis. Ça va aller molo molo. On repart propre en ${nomMois(moisSuivant)}. Le ${jourEcheance}, on t'attend dêh.`,
  };
}

/** Tout le club a paye a l'heure : une fois par mois, a tous. */
export function alerteClubAJour(nbMembres: number, jourEcheance: number): TexteSerie {
  return {
    titre: "Ahi ! Tout le club est à l'heure",
    corps: `Les ${nbMembres} môgôs ont payé avant le ${jourEcheance}, c'est l'enjaillement. Même le trésorier a souri.`,
  };
}

/**
 * L'avance : les mois a venir deja payes, d'affilee, a partir du mois
 * suivant. Ils entreront dans la serie d'eux-memes, mois apres mois.
 */
export function avanceDe(avances: MoisSerie[], moisCourant: string): { n: number; jusqua: string | null } {
  let n = 0;
  let jusqua: string | null = null;
  for (const c of [...avances].filter((x) => x.mois > moisCourant).sort((a, b) => a.mois.localeCompare(b.mois))) {
    if (c.statut !== "paye") break;
    n++;
    jusqua = c.mois;
  }
  return { n, jusqua };
}

/** La phrase de l'accueil, sous la frise. */
export function phraseSerie(
  n: number,
  moisCourant: string,
  statutCourant: StatutMois | null,
  jourEcheance: number,
  avance: { n: number; jusqua: string | null } = { n: 0, jusqua: null },
): string {
  const nom = nomMois(moisCourant);
  if (statutCourant === "paye" && avance.n > 0 && avance.jusqua) {
    const annee = avance.jusqua.slice(0, 4) !== moisCourant.slice(0, 4) ? ` ${avance.jusqua.slice(0, 4)}` : "";
    return `Tu es en avance, frérot : tout est payé jusqu'à ${nomMois(avance.jusqua)}${annee}. Ta série montera toute seule jusqu'à ${mois(n + avance.n)}.`;
  }
  if (statutCourant === "paye") return `${majuscule(nom)} est réglé à l'heure : rendez-vous le mois prochain pour passer à ${mois(n + 1)}.`;
  if (statutCourant === "en_attente") return `${majuscule(nom)} est déclaré : dès la validation du trésorier, tu passes à ${mois(n + 1)}.`;
  if (statutCourant === "a_venir") return `Le ${jourEcheance} approche : règle ${nom} d'ici là et passe à ${mois(n + 1)}.`;
  return n === 0 ? `Paie avant le ${jourEcheance} et ta série démarre.` : `Garde le rythme : le ${jourEcheance}, c'est sacré.`;
}
