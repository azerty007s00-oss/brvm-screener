import type { Role } from "./settings";
import type { Membre } from "./auth";

/**
 * Qui a le droit de faire quoi.
 *
 * Rassemble en un point ce qui etait disperse en tests de role dans chaque action.
 * Une reorganisation du bureau se repercute en modifiant ce seul tableau.
 *
 * Le president figure dans presque toutes les lignes : il preside le club et
 * administre le site, et un club de dix personnes ne doit pas se retrouver bloque
 * parce qu'un titulaire est indisponible. Les lignes ou il n'apparait pas sont
 * celles ou sa presence creerait un conflit d'interets.
 */
export const DROITS = {
  /** Valider la declaration d'un membre en attente. */
  validerVersement: ["tresorier", "president"],

  /**
   * Saisir un versement deja encaisse, pour soi ou pour un autre : la saisie vaut
   * validation. Un membre, lui, declare -- sa ligne attend le tresorier.
   */
  saisirVersementValide: ["tresorier", "president"],

  /**
   * Reprendre une ligne deja validee : en corriger les termes, ou l'annuler.
   *
   * Acte plus lourd que la validation, qui touche a une ecriture close et deplace
   * la caisse. Meme titulaires que la validation, mais nomme a part : la trace
   * dit alors sous quel titre la reprise a eu lieu.
   */
  corrigerVersement: ["tresorier", "president"],

  /**
   * Mouvements vers la SGI et releves de portefeuille (art. 14).
   *
   * R1 a mandate le bureau pour souscrire a la bourse en ligne, les ordres etant
   * transmis par le president ou par le tresorier sur delegation. Le circuit par
   * courriel qu'elle remplace avait coute au club l'operation Uniwax : un ordre
   * qui attend une seule signature n'est pas passe. Le tresorier figure donc ici,
   * pour que la trace de l'ordre porte le nom de qui l'a reellement transmis.
   *
   * Le vice-president conserve l'acces qu'il tenait de l'art. 14 : R1 ajoute un
   * titulaire, elle n'en retire aucun.
   */
  gererCompteTitres: ["president", "vice_president", "tresorier"],

  /** Reunions et feuille de presence. */
  gererReunions: ["secretaire", "president"],

  /** Journal de caisse : depenses et recettes hors cotisations. */
  gererCaisse: ["tresorier", "president"],

/**
   * Declencher une relance hors du 10.
   *
   * Le tresorier tient la caisse et sait qui n'a pas verse ; le president preside.
   * Relancer n'engage rien d'irreversible, mais s'adresse a tous : le droit est
   * nomme pour que la trace dise qui a decide d'ecrire au club.
   */
  relancer: ["tresorier", "president"],

  /** Penalites : constat, reglement, annulation. */
  gererPenalites: ["tresorier", "president"],

  /** Profils, roles, mots de passe provisoires. */
  gererMembres: ["president"],

  /** Sorties et exclusions (art. 20), regles individuelles (R5). */
  gererSorties: ["president"],

  /** Montant de la cotisation, echeance, taux de penalite. */
  gererReglages: ["president"],
} as const satisfies Record<string, readonly Role[]>;

export type Droit = keyof typeof DROITS;

export function peut(membre: Pick<Membre, "role"> | null, droit: Droit): boolean {
  if (!membre) return false;
  return (DROITS[droit] as readonly Role[]).includes(membre.role);
}

/** Libelle des titulaires d'un droit, pour expliquer un refus a l'ecran. */
export function titulaires(droit: Droit, roles: Record<Role, string>): string {
  const liste = (DROITS[droit] as readonly Role[]).map((r) => roles[r].toLowerCase());
  if (liste.length === 1) return `au ${liste[0]}`;
  return `au ${liste.slice(0, -1).join(", au ")} et au ${liste.at(-1)}`;
}
