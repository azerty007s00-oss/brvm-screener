import { DocumentPdf, couleur } from "./pdf";
import { CLUB, dateCourte, deMois, fcfa } from "./settings";
import { periode } from "./fil";
import { libelleMode } from "./valeurs";

/**
 * LE RECU D'UN VERSEMENT VALIDE.
 *
 * Un membre qui payait n'avait pour trace que la ligne du registre : rien a
 * garder, rien a montrer. Chaque versement valide a desormais son recu PDF,
 * numerote dans l'annee de sa validation (2026-0142), qu'on retrouve et
 * qu'on verifie dans Moi › Historique. Mise en forme pure : la verification
 * la rejoue.
 */
export type DonneesRecu = {
  numero: string;
  valideLe: string;
  membre: string;
  /** Les mois couverts, AAAA-MM-01, et le montant total. */
  mois: string[];
  montant: number;
  payeLe: string;
  mode: string;
  reference: string | null;
  /** Chaque mois regle au plus tard a son echeance. */
  aLHeure: boolean;
  validePar: string | null;
  /** Le titre du valideur : son poste au bureau. */
  qualite: string | null;
  /** Le recu d'une part rachetee : le nom du detenteur. */
  detenteur: string | null;
};

/** 2026, 142 : « 2026-0142 ». */
export function numeroRecu(annee: number | string, rang: number): string {
  return `${annee}-${String(rang).padStart(4, "0")}`;
}

/** « Cotisation d'octobre 2026 », « Cotisations : novembre 2026 à janvier 2027 (3 mois) ». */
export function objetRecu(mois: string[]): string {
  const distincts = [...new Set(mois.map((m) => `${m.slice(0, 7)}-01`))];
  if (distincts.length === 1) return `Cotisation ${deMois(distincts[0])}`;
  const p = periode(distincts);
  return `Cotisations : ${p.charAt(0).toLowerCase()}${p.slice(1)}`;
}

/** Chaque mois paye au plus tard le jour de son echeance. */
export function payeALHeure(mois: string[], payeLe: string, jourEcheance: number): boolean {
  return mois.every((m) => payeLe <= `${m.slice(0, 7)}-${String(jourEcheance).padStart(2, "0")}`);
}

/** « par Wave », « en espèces », « par chèque ». */
export function parMode(mode: string): string {
  const libelle = libelleMode(mode);
  if (mode === "especes") return "en espèces";
  return `par ${libelle === "Wave" ? libelle : libelle.toLowerCase()}`;
}

const ENCRE = couleur("#1c1713");
const DISCRET = couleur("#625950");
const PALE = couleur("#756b60");
const FILET = couleur("#e8e2d9");
const FOND = couleur("#efebe5");
const MARQUE = couleur("#1e3a5f");

export function recuPdf(d: DonneesRecu): Buffer {
  const doc = new DocumentPdf();
  const marge = 56;
  const droite = doc.largeurPage - marge;
  let y = doc.hauteurPage - 70;

  doc.texte(marge, y, `${CLUB.sigle} · ${CLUB.nom}`, { corps: 9.5, couleur: DISCRET });
  doc.texte(droite, y, `N° ${d.numero}`, { corps: 11, gras: true, couleur: MARQUE, aDroite: true });
  y -= 28;
  doc.texte(marge, y, "Reçu de versement", { corps: 22, gras: true, couleur: ENCRE });
  doc.texte(droite, y + 14, `Validé le ${dateCourte(d.valideLe)}`, { corps: 9.5, couleur: DISCRET, aDroite: true });
  y -= 22;
  doc.trait(marge, y, droite, y, FILET, 1);
  y -= 30;

  const ligne = (libelle: string, valeur: string, fort = false) => {
    doc.texte(marge, y, libelle, { corps: 9.5, couleur: PALE });
    const lignes = doc.lignes(valeur, droite - marge - 120, fort ? 15 : 11.5, fort);
    lignes.forEach((l, i) => doc.texte(marge + 120, y - i * (fort ? 19 : 15), l, { corps: fort ? 15 : 11.5, gras: fort, couleur: ENCRE }));
    y -= (fort ? 19 : 15) * lignes.length + 14;
  };
  ligne("Reçu de", d.membre + (d.detenteur ? ` (part détenue par ${d.detenteur})` : ""));
  ligne("Montant", fcfa(d.montant), true);
  ligne("Objet", objetRecu(d.mois));
  ligne(
    "Payé le",
    `${dateCourte(d.payeLe)} ${parMode(d.mode)}` +
      (d.reference ? `, réf. ${d.reference}` : ""),
  );

  y -= 6;
  const phrase =
    `Versement reçu et porté au registre des cotisations du club${d.aLHeure ? ", à l'heure" : ""}.` +
    (d.validePar ? ` Validé par ${d.validePar}${d.qualite ? `, ${d.qualite.toLowerCase()}` : ""}.` : "");
  const lignes = doc.lignes(phrase, droite - marge - 28, 10.5);
  const h = lignes.length * 14 + 22;
  doc.aplat(marge, y - h + 16, droite - marge, h, FOND);
  lignes.forEach((l, i) => doc.texte(marge + 14, y - i * 14, l, { corps: 10.5, couleur: ENCRE }));
  y -= h + 18;

  for (const l of doc.lignes(
    `Reçu établi par le site du club. Il se vérifie sur le site, rubrique Historique du menu Moi, avec son numéro ${d.numero}.`,
    droite - marge,
    8.5,
  )) {
    doc.texte(marge, y, l, { corps: 8.5, couleur: PALE });
    y -= 11;
  }
  return doc.octets(`Reçu de versement ${d.numero}`);
}
