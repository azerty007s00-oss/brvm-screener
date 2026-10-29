import { dateCourte, decalerMois, deMois, nomCourt } from "./settings";
import { libelleMode, CANAL_RELANCE, STATUT_PENALITE, STATUT_REGLEMENT, STATUT_VERSEMENT } from "./valeurs";

/**
 * LE FIL D'UN MEMBRE : CE QUI EST ARRIVE A SA PART, DU PLUS RECENT AU PLUS ANCIEN.
 *
 * « J'ai declare mon versement il y a dix jours, ou en est-il ? », « On m'a
 * inscrit une penalite, pourquoi ? », « Le rappel du 9, je l'ai recu ? » : les
 * reponses etaient dispersees entre le registre, les penalites et la boite aux
 * lettres. Le fil les met bout a bout, chaque evenement avec sa date, son
 * montant et ce qu'il est devenu.
 *
 * Calcul pur : les lignes arrivent des requetes (lib/historique), deja
 * restreintes au membre et aux parts qu'il detient.
 */

export type Famille = "versements" | "penalites" | "rappels";
export type Genre = "ok" | "attente" | "refus" | "penalite" | "courrier" | "info";

export type Evenement = {
  cle: string;
  /** ISO, date ou horodatage : sert au tri et au regroupement par mois. */
  date: string;
  famille: Famille;
  genre: Genre;
  titre: string;
  montant: number | null;
  detail: string;
  /** « declare le 21/10 · valide le 22/10 » */
  quand: string;
  motif: string | null;
};

export type LigneVersement = {
  lot: string;
  membre_id: string;
  mois: string;
  montant: number | string;
  mode: string;
  reference: string | null;
  note: string | null;
  statut: string;
  motif: string | null;
  cree_le: string;
  vise_le: string | null;
  declare_par: string | null;
  declare_par_nom: string | null;
  vise_par_nom: string | null;
};

export type LignePenalite = {
  id: string;
  membre_id: string;
  nature: string;
  montant: number | string;
  motif: string | null;
  constatee_le: string;
  statut: string;
  reglee_le: string | null;
  note_reglement: string | null;
  resolue_le: string | null;
  resolu_par_nom: string | null;
};

export type LigneReglement = {
  lot: string;
  penalite_id: string;
  membre_id: string;
  montant: number | string;
  mode: string;
  statut: string;
  motif_rejet: string | null;
  cree_le: string;
  vise_le: string | null;
  vise_par_nom: string | null;
  nature: string;
  motif_penalite: string | null;
};

export type LigneRappel = { membre_id: string; canal: string; mois: string; envoye_le: string };

export type LigneRachat = { achete_le: string; fraction: number | string; prix: number | string; vendeur: string };

export type Faits = {
  versements: LigneVersement[];
  penalites: LignePenalite[];
  reglements: LigneReglement[];
  rappels: LigneRappel[];
  rachats: LigneRachat[];
};

const NATURE: Record<string, string> = {
  retard: "Retard de versement",
  absence: "Absence en réunion",
  autre: "Pénalité",
};

/** « 21/10 » : l'annee est dans l'intitule du mois qui regroupe. */
const jour = (iso: string | null) => (iso ? dateCourte(iso).slice(0, 5) : "--");

const majuscule = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function nomDuMois(iso: string): string {
  return new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Les mois d'un versement, dits en peu de mots : « Novembre 2026 », « Novembre
 * 2026 à janvier 2027 (3 mois) », « Août et octobre 2026 ».
 */
export function periode(mois: string[]): string {
  const tries = [...new Set(mois.map((m) => `${m.slice(0, 7)}-01`))].sort();
  if (tries.length === 0) return "";
  if (tries.length === 1) return majuscule(nomDuMois(tries[0]));
  const suivis = tries.every((m, i) => i === 0 || decalerMois(tries[i - 1], 1) === m);
  if (suivis) {
    return `${majuscule(nomDuMois(tries[0]))} à ${nomDuMois(tries.at(-1)!)} (${tries.length} mois)`;
  }
  const noms = tries.map(nomDuMois);
  return majuscule(`${noms.slice(0, -1).join(", ")} et ${noms.at(-1)}`);
}

const REPRISE = "Reprise de l'historique";

function libelleRappel(canal: string): string {
  if (canal === CANAL_RELANCE.automatique) return "Rappel automatique";
  if (canal === CANAL_RELANCE.groupee) return "Rappel du bureau";
  if (canal === CANAL_RELANCE.individuelle) return "Rappel personnel du bureau";
  return "Rappel";
}

/**
 * Le fil complet, du plus recent au plus ancien.
 *
 * @param membreId  le membre qui lit : ses propres declarations disent « declare
 *                  le », celles du bureau a sa place « saisi par »
 * @param partsDetenues  les parts rachetees qu'il detient sans les avoir
 *                  fusionnees, par identifiant : leurs evenements le nomment
 */
export function filDuMembre(
  membreId: string,
  f: Faits,
  partsDetenues: Map<string, string> = new Map(),
): Evenement[] {
  const sortie: Evenement[] = [];
  const dePart = (id: string) => (partsDetenues.has(id) ? ` Part de ${partsDetenues.get(id)}.` : "");

  /* Les versements, une declaration par lot : deux mois payes d'un coup sont un seul geste. */
  const lots = new Map<string, LigneVersement[]>();
  for (const v of f.versements) {
    const cle = `${v.membre_id}:${v.lot}`;
    lots.set(cle, [...(lots.get(cle) ?? []), v]);
  }
  /*
   * Les versements valides le meme jour, par la meme personne et de la meme
   * facon, ne font qu'une ligne : la saisie de quarante mois anciens en un
   * apres-midi, ou deux mois declares separement le meme soir, se lisent mieux
   * en une periode qu'en quarante lignes identiques. Une declaration en
   * attente ou refusee garde la sienne : chacune attend ou porte son motif.
   */
  const fusionnes = new Map<string, LigneVersement[]>();
  for (const [cle, lignes] of lots) {
    const v = lignes[0];
    const cleFusion =
      v.statut === STATUT_VERSEMENT.valide && v.note !== REPRISE
        ? [v.membre_id, v.cree_le.slice(0, 10), (v.vise_le ?? "").slice(0, 10), v.declare_par, v.mode, v.note ?? "", v.reference ?? ""].join("|")
        : cle;
    fusionnes.set(cleFusion, [...(fusionnes.get(cleFusion) ?? []), ...lignes]);
  }
  for (const lignes of fusionnes.values()) {
    const v = lignes[0];
    const cle = `${v.membre_id}:${v.lot}`;
    const montant = lignes.reduce((t, l) => t + Number(l.montant), 0);
    const mois = lignes.map((l) => l.mois);
    if (v.note === REPRISE) {
      sortie.push({
        cle: `v:${cle}`,
        date: v.vise_le ?? v.cree_le,
        famille: "versements",
        genre: "info",
        titre: "Historique repris",
        montant,
        detail: `${lignes.length} mois marqués payés : ${periode(mois)}.${dePart(v.membre_id)}`,
        quand: `repris le ${jour(v.vise_le ?? v.cree_le)}`,
        motif: null,
      });
      continue;
    }
    const parLui = v.declare_par === v.membre_id || (v.declare_par === membreId && !partsDetenues.has(v.membre_id));
    const avance = mois.every((m) => m.slice(0, 7) > v.cree_le.slice(0, 7));
    const morceaux = [
      periode(mois) + (avance ? ", payé d'avance" : ""),
      libelleMode(v.mode),
      v.reference ? `réf. ${v.reference}` : null,
    ].filter(Boolean);
    const note = v.note ? ` ${v.note.replace(/\.?$/, ".")}` : "";
    let detail = `${morceaux.join(" · ")}.${note}${dePart(v.membre_id)}`;

    if (v.statut === STATUT_VERSEMENT.enAttente) {
      sortie.push({
        cle: `v:${cle}`,
        date: v.cree_le,
        famille: "versements",
        genre: "attente",
        titre: "Versement déclaré",
        montant,
        detail: `${detail} En attente du visa du trésorier.`,
        quand: `déclaré le ${jour(v.cree_le)}`,
        motif: null,
      });
    } else if (v.statut === STATUT_VERSEMENT.rejete) {
      sortie.push({
        cle: `v:${cle}`,
        date: v.vise_le ?? v.cree_le,
        famille: "versements",
        genre: "refus",
        titre: "Versement refusé",
        montant,
        detail,
        quand: `déclaré le ${jour(v.cree_le)} · refusé le ${jour(v.vise_le)}`,
        motif: v.motif ? `Motif : ${v.motif}` : null,
      });
    } else {
      if (v.vise_par_nom && parLui) detail += ` Visé par ${nomCourt(v.vise_par_nom)}.`;
      sortie.push({
        cle: `v:${cle}`,
        date: v.vise_le ?? v.cree_le,
        famille: "versements",
        genre: "ok",
        titre: parLui ? "Versement validé" : "Versement enregistré",
        montant,
        detail,
        quand: parLui
          ? `déclaré le ${jour(v.cree_le)} · validé le ${jour(v.vise_le ?? v.cree_le)}`
          : `saisi${v.declare_par_nom ? ` par ${nomCourt(v.declare_par_nom)}` : ""} le ${jour(v.vise_le ?? v.cree_le)}`,
        motif: null,
      });
    }
  }

  /* Les reglements de penalite declares, eux aussi par lot. */
  const reglees = new Set<string>();
  const lotsReglement = new Map<string, LigneReglement[]>();
  for (const r of f.reglements) {
    lotsReglement.set(r.lot, [...(lotsReglement.get(r.lot) ?? []), r]);
    if (r.statut === STATUT_REGLEMENT.validee) reglees.add(r.penalite_id);
  }
  for (const [lot, lignes] of lotsReglement) {
    const r = lignes[0];
    const montant = lignes.reduce((t, l) => t + Number(l.montant), 0);
    const objet = r.motif_penalite || NATURE[r.nature] || "Pénalité";
    const detail =
      (lignes.length > 1 ? `${objet}, et ${lignes.length - 1} autre${lignes.length > 2 ? "s" : ""}` : objet) +
      ` · ${libelleMode(r.mode)}.${dePart(r.membre_id)}`;
    if (r.statut === STATUT_REGLEMENT.enAttente) {
      sortie.push({
        cle: `r:${lot}`, date: r.cree_le, famille: "penalites", genre: "attente",
        titre: "Règlement de pénalité déclaré", montant,
        detail: `${detail} En attente du visa du trésorier.`,
        quand: `déclaré le ${jour(r.cree_le)}`, motif: null,
      });
    } else if (r.statut === STATUT_REGLEMENT.rejetee) {
      sortie.push({
        cle: `r:${lot}`, date: r.vise_le ?? r.cree_le, famille: "penalites", genre: "refus",
        titre: "Règlement de pénalité refusé", montant, detail,
        quand: `déclaré le ${jour(r.cree_le)} · refusé le ${jour(r.vise_le)}`,
        motif: r.motif_rejet ? `Motif : ${r.motif_rejet}` : null,
      });
    } else {
      sortie.push({
        cle: `r:${lot}`, date: r.vise_le ?? r.cree_le, famille: "penalites", genre: "ok",
        titre: "Pénalité réglée", montant,
        detail: detail + (r.vise_par_nom ? ` Visé par ${nomCourt(r.vise_par_nom)}.` : ""),
        quand: `déclaré le ${jour(r.cree_le)} · validé le ${jour(r.vise_le ?? r.cree_le)}`, motif: null,
      });
    }
  }

  /* Les penalites : leur inscription, puis ce qu'elles sont devenues hors declaration. */
  for (const p of f.penalites) {
    const objet = p.motif || NATURE[p.nature] || "Pénalité";
    const montant = Number(p.montant);
    sortie.push({
      cle: `p:${p.id}`, date: p.constatee_le, famille: "penalites", genre: "penalite",
      titre: "Pénalité inscrite", montant,
      /* Le rappel de l'art. 9 seulement quand le motif ne le porte pas deja. */
      detail: `${objet.replace(/\.?$/, ".")}${p.nature === "retard" && !p.motif ? " Reste due même après régularisation du mois (art. 9)." : ""}${dePart(p.membre_id)}`,
      quand: `le ${jour(p.constatee_le)}`, motif: null,
    });
    if (p.statut === STATUT_PENALITE.payee && !reglees.has(p.id)) {
      const le = p.reglee_le ?? p.resolue_le ?? p.constatee_le;
      sortie.push({
        cle: `p:${p.id}:reglee`, date: le, famille: "penalites", genre: "ok",
        titre: "Pénalité réglée", montant,
        detail: `${objet.replace(/\.?$/, ".")}${p.note_reglement ? ` ${p.note_reglement.replace(/\.?$/, ".")}` : ""}${dePart(p.membre_id)}`,
        quand: `réglée le ${jour(le)}${p.resolu_par_nom ? ` · enregistré par ${nomCourt(p.resolu_par_nom)}` : ""}`,
        motif: null,
      });
    } else if (p.statut === STATUT_PENALITE.annulee) {
      const le = p.resolue_le ?? p.constatee_le;
      sortie.push({
        cle: `p:${p.id}:annulee`, date: le, famille: "penalites", genre: "info",
        titre: "Pénalité annulée", montant,
        detail: `${objet.replace(/\.?$/, ".")}${p.note_reglement ? ` ${p.note_reglement.replace(/\.?$/, ".")}` : ""}${dePart(p.membre_id)}`,
        quand: `annulée le ${jour(le)}${p.resolu_par_nom ? ` par ${nomCourt(p.resolu_par_nom)}` : ""}`,
        motif: null,
      });
    }
  }

  /* Les rappels recus : seuls ceux qui sont partis, un courrier en echec n'a rien dit au membre. */
  for (const r of f.rappels) {
    sortie.push({
      cle: `m:${r.membre_id}:${r.envoye_le}:${r.canal}`, date: r.envoye_le, famille: "rappels", genre: "courrier",
      titre: libelleRappel(r.canal), montant: null,
      detail: `Par courriel, au sujet de la cotisation ${deMois(r.mois)}.${dePart(r.membre_id)}`,
      quand: `le ${jour(r.envoye_le)}`, motif: null,
    });
  }

  for (const b of f.rachats) {
    const pc = Math.round(Number(b.fraction) * 100);
    sortie.push({
      cle: `b:${b.achete_le}:${b.vendeur}`, date: b.achete_le, famille: "versements", genre: "info",
      titre: "Part rachetée", montant: Number(b.prix),
      detail: `${pc} % de la part de ${b.vendeur}, intégrée à la mienne.`,
      quand: `le ${jour(b.achete_le)}`, motif: null,
    });
  }

  /* Du plus recent au plus ancien ; a date egale, l'ordre d'arrivee reste stable. */
  return sortie.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Les evenements regroupes par mois, dans l'ordre ou ils arrivent. */
export function parMois(evenements: Evenement[]): { mois: string; evenements: Evenement[] }[] {
  const groupes: { mois: string; evenements: Evenement[] }[] = [];
  for (const e of evenements) {
    const mois = `${e.date.slice(0, 7)}-01`;
    const dernier = groupes.at(-1);
    if (dernier && dernier.mois === mois) dernier.evenements.push(e);
    else groupes.push({ mois, evenements: [e] });
  }
  return groupes;
}
