import { DocumentPdf, couleur } from "./pdf";
import { CLUB, dateCourte, fcfa, moisLong } from "./settings";

/**
 * LE RAPPORT DE REUNION.
 *
 * Preparer une reunion demandait d'ouvrir cinq pages du site et de recopier
 * leurs chiffres dans un message : ce qui est entre en caisse depuis la
 * derniere seance, qui est en retard et ou en sont ses droits, les penalites,
 * la caisse, les votes. Le site les rassemble ici, sur la periode qui separe
 * deux reunions, en un ordre du jour, un PDF et un texte pour WhatsApp.
 *
 * Rien n'y est recalcule : chaque chiffre vient du registre et des pages qui
 * le montrent deja. Ce module ne fait que la mise en forme ; il est pur, et
 * la verification le rejoue.
 */

export type DonneesRapport = {
  /** La reunion, AAAA-MM-JJ. */
  date: string;
  heure: string | null;
  lieu: string | null;
  /** La reunion precedente, debut de la periode ; null pour la premiere. */
  depuis: string | null;
  /** Le jour ou les chiffres sont arretes. */
  arrete: string;
  portefeuille: { valeur: number; dateValeur: string; variation: number | null } | null;
  objectif: { taux: number; intitule: string } | null;
  /** Les mois de la periode, du plus ancien au plus recent. */
  cotisations: { mois: string; attendu: number; encaisse: number; aLHeure: number; dus: number; impayes: number }[];
  encaisse: number;
  aJour: { n: number; total: number };
  retards: { nom: string; mois: string[]; jours: number; suspendu: boolean; declarationExigee: boolean; declare: boolean }[];
  penalites: { inscrites: number; reglees: number; absences: number };
  caisse: { mouvements: { date: string; libelle: string; montant: number; depense: boolean }[]; solde: number | null };
  votes: { question: string; etat: string }[];
  points: string[];
  presences: { presents: string[]; excuses: string[]; absents: string[] } | null;
};

/** « +2,0 % ». */
export function variationEnClair(x: number): string {
  const v = (Math.round(x * 1000) / 10).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${x > 0 ? "+" : x < 0 ? "−" : ""}${v.replace("-", "")} %`;
}

/** « octobre », « septembre et octobre ». */
function listeMois(mois: string[]): string {
  const noms = mois.map((m) => moisLong(m).split(" ")[0]);
  return noms.length <= 1 ? (noms[0] ?? "") : `${noms.slice(0, -1).join(", ")} et ${noms.at(-1)}`;
}

/** La phrase d'un retard : « octobre impayé, 47 jours. Droit de vote suspendu (R2). » */
export function phraseRetard(r: DonneesRapport["retards"][number]): string {
  const mois = `${listeMois(r.mois)} ${r.mois.length > 1 ? "impayés" : "impayé"}, ${r.jours} ${r.jours > 1 ? "jours" : "jour"} de retard.`;
  const r3 = r.declarationExigee ? (r.declare ? " Retard déclaré au groupe (R3)." : " Retard non déclaré au groupe (R3).") : "";
  const r2 = r.suspendu ? " Droit de vote suspendu (R2)." : "";
  return `${mois}${r2}${r3}`;
}

/**
 * L'ordre du jour : ce que le site met d'office (le portefeuille, chaque
 * retard, chaque vote en cours), puis les points ajoutes par le bureau.
 */
export function ordreDuJour(d: DonneesRapport): string[] {
  return [
    "Point sur le portefeuille et les cotisations",
    ...d.retards.map((r) => `Retard de ${r.nom}`),
    ...d.votes.filter((v) => v.etat.startsWith("en cours")).map((v) => `Vote en cours : ${v.question}`),
    ...d.points.filter((p) => p.trim() !== ""),
  ];
}

function periode(d: DonneesRapport): string {
  return d.depuis ? `du ${dateCourte(d.depuis)} au ${dateCourte(d.arrete)}` : `jusqu'au ${dateCourte(d.arrete)}`;
}

function phrasePenalitesCaisse(d: DonneesRapport): string {
  const pen =
    `Pénalités inscrites : ${fcfa(d.penalites.inscrites)}` +
    (d.penalites.absences > 0 ? `, dont ${d.penalites.absences} ${d.penalites.absences > 1 ? "absences" : "absence"}` : "") +
    `. Réglées : ${fcfa(d.penalites.reglees)}.`;
  const mvts = d.caisse.mouvements;
  const caisse =
    mvts.length === 0
      ? " Caisse : aucun mouvement."
      : ` Caisse : ${mvts.map((m) => `${m.depense ? "dépense" : "recette"} de ${fcfa(m.montant)} (${m.libelle})`).join(", ")}.`;
  return `${pen}${caisse}${d.caisse.solde !== null ? ` Solde : ${fcfa(d.caisse.solde)}.` : ""}`;
}

/**
 * Le meme rapport en texte, pour le groupe WhatsApp : les asterisques y
 * mettent en gras, et rien n'y depasse ce qu'un telephone lit sans defiler
 * longtemps.
 */
export function rapportTexte(d: DonneesRapport): string {
  const l: string[] = [];
  l.push(`*${CLUB.sigle} · Réunion du ${dateCourte(d.date)}*${d.heure ? ` à ${d.heure} GMT` : ""}${d.lieu ? `, ${d.lieu}` : ""}`);
  l.push(`Période ${periode(d)}`);
  l.push("");
  if (d.portefeuille) {
    l.push(
      `Portefeuille : ${fcfa(d.portefeuille.valeur)} au ${dateCourte(d.portefeuille.dateValeur)}` +
        (d.portefeuille.variation !== null ? ` (${variationEnClair(d.portefeuille.variation)} sur la période)` : ""),
    );
  }
  if (d.objectif) l.push(`Objectif ${d.objectif.intitule} : ${Math.round(d.objectif.taux * 100)} %`);
  l.push(`Versements reçus : ${fcfa(d.encaisse)} · À jour : ${d.aJour.n} sur ${d.aJour.total}`);
  if (d.retards.length > 0) {
    l.push("");
    l.push("*Retards*");
    for (const r of d.retards) l.push(`- ${r.nom} : ${phraseRetard(r)}`);
  }
  l.push("");
  l.push("*Pénalités et caisse*");
  l.push(phrasePenalitesCaisse(d));
  if (d.votes.length > 0) {
    l.push("");
    l.push("*Votes*");
    for (const v of d.votes) l.push(`- ${v.question} : ${v.etat}`);
  }
  l.push("");
  l.push("*Ordre du jour*");
  ordreDuJour(d).forEach((p, i) => l.push(`${i + 1}. ${p}`));
  return l.join("\n");
}

const ENCRE = couleur("#1c1713");
const DISCRET = couleur("#625950");
const FILET = couleur("#e8e2d9");
const FOND = couleur("#efebe5");

export function rapportPdf(d: DonneesRapport): Buffer {
  const doc = new DocumentPdf();
  const marge = 50;
  const droite = doc.largeurPage - marge;
  let y = doc.hauteurPage - 60;
  const place = (hauteur: number) => {
    if (y - hauteur < 70) {
      doc.nouvellePage();
      y = doc.hauteurPage - 60;
    }
  };
  const titre = (t: string) => {
    y -= 10;
    place(40);
    doc.texte(marge, y, t, { corps: 12.5, gras: true });
    y -= 18;
  };
  const paragraphe = (t: string) => {
    const lignes = doc.lignes(t, droite - marge, 10);
    place(13 * lignes.length + 6);
    lignes.forEach((ligne, i) => doc.texte(marge, y - i * 13, ligne, { corps: 10 }));
    y -= 13 * lignes.length + 8;
  };

  doc.texte(marge, y, `${CLUB.sigle} · ${CLUB.nom}`, { corps: 9, couleur: DISCRET });
  y -= 26;
  doc.texte(marge, y, `Rapport de la réunion du ${dateCourte(d.date)}`, { corps: 19, gras: true });
  y -= 18;
  const sous =
    `Période ${periode(d)}` +
    (d.heure ? ` · réunion à ${d.heure} GMT, heure d'Abidjan` : "") +
    (d.lieu ? `, ${d.lieu}` : "");
  doc.lignes(sous, droite - marge, 10).forEach((ligne) => {
    doc.texte(marge, y, ligne, { corps: 10, couleur: DISCRET });
    y -= 13;
  });
  y -= 14;

  /* Les chiffres de tete. */
  const tetes: [string, string][] = [];
  if (d.portefeuille) tetes.push(["Portefeuille", fcfa(d.portefeuille.valeur)]);
  if (d.portefeuille?.variation != null) tetes.push(["Sur la période", variationEnClair(d.portefeuille.variation)]);
  tetes.push(["Versements reçus", fcfa(d.encaisse)]);
  tetes.push(["À jour", `${d.aJour.n} sur ${d.aJour.total}`]);
  if (d.objectif) tetes.push(["Objectif", `${Math.round(d.objectif.taux * 100)} %`]);
  const colonne = (droite - marge) / tetes.length;
  doc.trait(marge, y + 14, droite, y + 14, FILET);
  tetes.forEach(([libelle, valeur], i) => {
    const x = marge + i * colonne;
    doc.texte(x, y, libelle, { corps: 8.5, couleur: DISCRET });
    doc.texte(x, y - 17, valeur, { corps: 12, gras: true, couleur: ENCRE });
  });
  y -= 32;
  doc.trait(marge, y, droite, y, FILET);
  y -= 20;

  /* 1. Cotisations */
  titre("1. Cotisations");
  if (d.cotisations.length === 0) {
    paragraphe("Aucun mois échu sur la période.");
  } else {
    const col = [marge + 8, marge + 220, marge + 310, marge + 330];
    doc.aplat(marge, y - 6, droite - marge, 20, FOND);
    doc.texte(col[0], y, "Mois", { corps: 8.5, gras: true, couleur: DISCRET });
    doc.texte(col[1], y, "Attendu", { corps: 8.5, gras: true, couleur: DISCRET, aDroite: true });
    doc.texte(col[2], y, "Encaissé", { corps: 8.5, gras: true, couleur: DISCRET, aDroite: true });
    doc.texte(col[3], y, "À l'heure", { corps: 8.5, gras: true, couleur: DISCRET });
    y -= 22;
    for (const c of d.cotisations) {
      place(20);
      doc.texte(col[0], y, moisLong(c.mois), { corps: 10 });
      doc.texte(col[1], y, fcfa(c.attendu), { corps: 10, aDroite: true });
      doc.texte(col[2], y, fcfa(c.encaisse), { corps: 10, aDroite: true });
      doc.texte(col[3], y, `${c.aLHeure} sur ${c.dus}${c.impayes > 0 ? `, ${c.impayes} ${c.impayes > 1 ? "impayés" : "impayé"}` : ""}`, { corps: 10 });
      doc.trait(marge, y - 7, droite, y - 7, FILET, 0.5);
      y -= 20;
    }
    y -= 6;
  }

  /* 2. Retards */
  titre("2. Retards et règles");
  if (d.retards.length === 0) paragraphe("Aucun membre en retard.");
  for (const r of d.retards) paragraphe(`${r.nom} : ${phraseRetard(r)}`);

  /* 3. Penalites et caisse */
  titre("3. Pénalités et caisse");
  paragraphe(phrasePenalitesCaisse(d));

  /* 4. Votes */
  if (d.votes.length > 0) {
    titre("4. Votes");
    for (const v of d.votes) paragraphe(`${v.question} : ${v.etat}.`);
  }

  /* 5. Ordre du jour */
  titre(`${d.votes.length > 0 ? 5 : 4}. Ordre du jour`);
  ordreDuJour(d).forEach((p, i) => paragraphe(`${i + 1}. ${p}`));

  /* La feuille de presence, une fois saisie. */
  if (d.presences) {
    titre("Présences");
    const { presents, excuses, absents } = d.presences;
    paragraphe(`Présents (${presents.length}) : ${presents.join(", ") || "aucun"}.`);
    if (excuses.length > 0) paragraphe(`Excusés (${excuses.length}) : ${excuses.join(", ")}.`);
    if (absents.length > 0) paragraphe(`Absents (${absents.length}) : ${absents.join(", ")}.`);
  }

  y -= 10;
  const note =
    `Chiffres arrêtés au ${dateCourte(d.arrete)} par le site du club. ` +
    (d.presences ? "La feuille de présence est celle saisie par le secrétaire." : "La feuille de présence s'ajoute au rapport une fois saisie par le secrétaire.");
  const lignesNote = doc.lignes(note, droite - marge, 8.5);
  place(12 * lignesNote.length);
  lignesNote.forEach((ligne, i) => doc.texte(marge, y - i * 12, ligne, { corps: 8.5, couleur: DISCRET }));

  return doc.octets(`Rapport de la réunion du ${dateCourte(d.date)}`);
}

/** « rapport-ip12-2026-11-15.pdf ». */
export function nomFichierRapport(date: string): string {
  return `rapport-ip12-${date}.pdf`;
}
