/**
 * LE CALENDRIER DES REUNIONS ET LE SONDAGE DE DATE.
 *
 * Le club se reunit tous les deux mois, entre le 10 et le 17. Fixer le jour
 * prenait une soiree de messages WhatsApp ou chacun repondait a une question
 * differente. Le site pose donc la question lui-meme, le 3 du mois de
 * reunion : chaque membre coche les jours qui lui vont, le sondage ferme le 9
 * a 20 h, et le soir meme le president recoit le jour qui reunit le plus de
 * monde. Il valide d'un toucher ; tout le monde est prevenu, et rappele la
 * veille.
 *
 * Le site passe une fois par jour, a 21 h : apres la cloture du 9, pour que
 * le president ait le resultat le soir meme, et la veille d'une seance, pour
 * que le rappel tombe quand on prepare sa journee du lendemain.
 *
 * Tout ce qui suit est un calcul pur, sans base ni horloge : les dates
 * arrivent en arguments, pour que la verification puisse le rejouer. Les
 * heures sont celles d'Abidjan, qui vit a l'heure UTC toute l'annee.
 */

/** L'etat d'un sondage, colonne `meeting_polls.status`. Des codes : sans accent. */
export const STATUT_SONDAGE = {
  ouvert: "ouvert",
  /** Clos : le jour retenu attend le president. */
  aValider: "a_valider",
  valide: "valide",
} as const;
export type StatutSondage = (typeof STATUT_SONDAGE)[keyof typeof STATUT_SONDAGE];

/** Le rythme des reunions : tous les `intervalle` mois, a partir de `depart` (AAAA-MM-01). */
export type Rythme = { intervalle: number; depart: string };

/** Novembre 2026, puis tous les deux mois : ce que le president a fixe. */
export const RYTHME_PAR_DEFAUT: Rythme = { intervalle: 2, depart: "2026-11-01" };

/** La cle de la table `settings`, au format « 2:2026-11-01 ». Un code : sans accent. */
export const CLE_RYTHME = "reunions_rythme";

/** Les jours du mois qui bornent le sondage, et l'heure de sa cloture. */
export const FENETRE = {
  /** Le sondage s'ouvre ce jour-la, au passage du soir. */
  ouverture: 3,
  /** ... et ferme ce jour-la, a `heureCloture` heures : la veille du premier jour propose. */
  cloture: 9,
  heureCloture: 20,
  /** Les jours proposes : du 10 au 17 inclus. */
  premier: 10,
  dernier: 17,
};

/**
 * La relance des retardataires part quand il reste moins de 36 heures : le
 * passage du soir, la veille de la cloture.
 */
export const RELANCE_AVANT_CLOTURE_MS = 36 * 3_600_000;

/** Le president qui n'a pas valide est relance une fois, le lendemain soir. */
export const RAPPEL_PRESIDENT_APRES_MS = 20 * 3_600_000;

export function lireRythme(brut: string | null | undefined): Rythme {
  const m = /^(\d{1,2}):(\d{4}-\d{2})(?:-01)?$/.exec((brut ?? "").trim());
  if (!m) return RYTHME_PAR_DEFAUT;
  const intervalle = Number(m[1]);
  if (intervalle < 1 || intervalle > 12) return RYTHME_PAR_DEFAUT;
  return { intervalle, depart: `${m[2]}-01` };
}

export function ecrireRythme(r: Rythme): string {
  return `${r.intervalle}:${r.depart.slice(0, 7)}-01`;
}

/** Nombre de mois de `a` a `b` (AAAA-MM-...), negatif si `b` precede `a`. */
function ecartEnMois(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
}

/** Le mois tient-il une reunion ? Avant le depart du rythme, aucun. */
export function estMoisDeReunion(mois: string, r: Rythme): boolean {
  const ecart = ecartEnMois(r.depart, mois);
  return ecart >= 0 && ecart % r.intervalle === 0;
}

/** Le premier mois de reunion a partir de `mois` inclus (AAAA-MM-01). */
export function prochainMoisDeReunion(mois: string, r: Rythme): string {
  const ecart = ecartEnMois(r.depart, mois);
  const saut = ecart <= 0 ? -ecart : (r.intervalle - (ecart % r.intervalle)) % r.intervalle;
  const d = new Date(Date.UTC(Number(mois.slice(0, 4)), Number(mois.slice(5, 7)) - 1 + saut, 1));
  return d.toISOString().slice(0, 10);
}

/** Les jours proposes au vote, AAAA-MM-JJ, du 10 au 17 du mois. */
export function joursDuSondage(mois: string): string[] {
  const jours: string[] = [];
  for (let j = FENETRE.premier; j <= FENETRE.dernier; j++) jours.push(`${mois.slice(0, 7)}-${String(j).padStart(2, "0")}`);
  return jours;
}

/** Le moment ou le sondage d'un mois ferme : le 9 a 20 h. */
export function clotureDuSondage(mois: string): Date {
  return new Date(`${mois.slice(0, 7)}-${String(FENETRE.cloture).padStart(2, "0")}T${String(FENETRE.heureCloture).padStart(2, "0")}:00:00Z`);
}

/**
 * Le sondage a ouvrir ce jour, s'il y en a un : le mois de reunion en cours,
 * entre le 3 et la veille de la cloture. Un passage manque le 3 se rattrape
 * le 4 ; le jour de la cloture, il est trop tard pour demander leur avis aux
 * membres, et le president convoque lui-meme.
 */
export function moisAOuvrir(maintenant: Date, r: Rythme): string | null {
  const mois = maintenant.toISOString().slice(0, 7) + "-01";
  const jour = maintenant.getUTCDate();
  if (!estMoisDeReunion(mois, r)) return null;
  if (jour < FENETRE.ouverture || jour >= FENETRE.cloture) return null;
  return mois;
}

/* ----------------------------------------------------------------- decompte */

/** La reponse d'un membre : les jours du mois qui lui vont (10, 11...). Vide : aucun. */
export type Reponse = { membreId: string; jours: number[] };

export type CompteDuJour = { jour: string; n: number; membres: string[] };

/** Combien de membres sont disponibles chaque jour propose. */
export function decompte(jours: string[], reponses: Reponse[]): CompteDuJour[] {
  return jours.map((jour) => {
    const quantieme = Number(jour.slice(8, 10));
    const membres = reponses.filter((r) => r.jours.includes(quantieme)).map((r) => r.membreId);
    return { jour, n: membres.length, membres };
  });
}

/**
 * Le jour qui reunit le plus de monde. A egalite, le plus tot : une reunion
 * qui peut se tenir le 12 n'a pas de raison d'attendre le 16. Personne de
 * disponible, aucun jour : le president choisit seul.
 */
export function jourRetenu(comptes: CompteDuJour[]): CompteDuJour | null {
  let meilleur: CompteDuJour | null = null;
  for (const c of comptes) if (c.n > 0 && (meilleur === null || c.n > meilleur.n)) meilleur = c;
  return meilleur;
}

/** Les jours valides d'une saisie : entiers du 10 au 17, sans doublon, tries. */
export function joursSaisis(valeurs: string[]): number[] {
  const jours = new Set<number>();
  for (const v of valeurs) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= FENETRE.premier && n <= FENETRE.dernier) jours.add(n);
  }
  return [...jours].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ libelles */

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « dimanche 15/11 ». */
export function jourEnClair(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return `${JOURS[d.getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** « dim. 15/11 », pour les lignes du sondage. */
export function jourCourt(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return `${JOURS[d.getUTCDay()].slice(0, 3)}. ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** « novembre ». */
export function nomDuMois(mois: string): string {
  return MOIS[Number(mois.slice(5, 7)) - 1];
}

/** « de novembre », « d'août », « d'avril », « d'octobre ». */
export function duMois(mois: string): string {
  const nom = nomDuMois(mois);
  return /^[aeiou]/.test(nom) ? `d'${nom}` : `de ${nom}`;
}

/** « samedi 7/11 à 20 h ». */
export function momentEnClair(d: Date): string {
  const iso = d.toISOString();
  const heure = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  return `${JOURS[d.getUTCDay()]} ${Number(iso.slice(8, 10))}/${iso.slice(5, 7)} à ${heure} h${minutes ? String(minutes).padStart(2, "0") : ""}`;
}

/** « ce soir », « demain soir », « samedi soir » : la cloture vue du moment de l'alerte. */
export function clotureRelative(cloture: Date, maintenant: Date): string {
  const jourCloture = cloture.toISOString().slice(0, 10);
  const aujourdhui = maintenant.toISOString().slice(0, 10);
  const demain = new Date(maintenant.getTime() + 86_400_000).toISOString().slice(0, 10);
  const moment = cloture.getUTCHours() >= 18 ? "soir" : `à ${cloture.getUTCHours()} h`;
  if (jourCloture === aujourdhui) return moment === "soir" ? "ce soir" : `aujourd'hui ${moment}`;
  if (jourCloture === demain) return `demain ${moment}`;
  return `${JOURS[cloture.getUTCDay()]} ${moment}`;
}

/* ------------------------------------------------------------------ alertes */

/*
 * Le ton des alertes est celui du club : on se tutoie, on se taquine, a
 * l'ivoirienne. Les pages, elles, restent au vouvoiement.
 */
export type TexteAlerte = { titre: string; corps: string };

export function alerteOuverture(cloture: Date, maintenant: Date): TexteAlerte {
  return {
    titre: "On dit quoi pour la réunion ?",
    corps:
      `Coche tes jours entre le ${FENETRE.premier} et le ${FENETRE.dernier} avant ${clotureRelative(cloture, maintenant)}. ` +
      "Sinon on choisit sans toi, faut pas venir pleurer après.",
  };
}

export function alerteRelance(cloture: Date, maintenant: Date): TexteAlerte {
  return {
    titre: "Ton avis manque, môgô",
    corps: `Le sondage de la réunion ferme ${clotureRelative(cloture, maintenant)}. Coche tes jours, c'est 10 secondes chrono.`,
  };
}

export function alertePresident(retenu: CompteDuJour | null, total: number): TexteAlerte {
  if (!retenu) {
    return {
      titre: "Président, personne n'a coché",
      corps: "Le sondage est clos sans un seul jour coché. À toi de fixer la date : un toucher pour choisir.",
    };
  }
  return {
    titre: "Le peuple a parlé, président",
    corps:
      `${retenu.n} ${retenu.n > 1 ? "membres" : "membre"} sur ${total} ${retenu.n > 1 ? "sont dispo" : "est dispo"} le ${jourEnClair(retenu.jour)}. ` +
      "On cale ça ? Un toucher pour valider.",
  };
}

export function alerteRappelPresident(mois: string, retenu: CompteDuJour | null): TexteAlerte {
  return {
    titre: "Président, on attend ton feu vert",
    corps: retenu
      ? `La réunion ${duMois(mois)} n'a pas encore de date. Un toucher pour valider le ${jourEnClair(retenu.jour)}.`
      : `La réunion ${duMois(mois)} n'a pas encore de date. Un toucher pour la fixer.`,
  };
}

export function alerteCalee(jour: string, heure: string, choixDeLaMajorite: boolean): TexteAlerte {
  return {
    titre: `C'est calé : ${jourEnClair(jour)} à ${heure}`,
    corps: choixDeLaMajorite
      ? "La majorité a parlé. Mets ça dans ton agenda : pas de chaise vide, et pas de pénalité d'absence dêh."
      : "Le président a tranché. Mets ça dans ton agenda : pas de chaise vide, et pas de pénalité d'absence dêh.",
  };
}

export function alerteVeille(heure: string, lieu: string | null): TexteAlerte {
  return {
    titre: `C'est demain : réunion à ${heure}`,
    corps: `${lieu ? `Rendez-vous : ${lieu}. ` : ""}Viens avec tes idées, pas avec tes excuses.`,
  };
}
