import { DocumentPdf, couleur } from "./pdf";
import { LIBELLE_STATUT } from "./etats";
import type { CelluleMois } from "./penalites";
import { CLUB, REGLES, dateCourte, fcfa, moisLong } from "./settings";

/**
 * Le releve d'un membre, joint a sa relance.
 *
 * Le courrier dit ce qui est du ; le releve montre d'ou vient le chiffre, mois
 * par mois, pour que le membre puisse le refaire et le contester avant de
 * payer plutot qu'apres. Rien n'y est recalcule : les mois sont ceux de la
 * grille du registre, les penalites celles du registre, les totaux ceux du
 * courrier qu'il accompagne.
 */
export type DonneesReleve = {
  nom: string;
  date: string;
  cellules: CelluleMois[];
  penalites: { date: string; nature: string; motif: string | null; montant: number }[];
  cotisationsARegler: number;
  penalitesDues: number;
  verse: number;
};

const ENCRE = couleur("#1c1713");
const DISCRET = couleur("#625950");
const FILET = couleur("#e8e2d9");
const FOND = couleur("#efebe5");
const ROUGE = couleur("#a8322c");
const AMBRE = couleur("#8a5f0f");

export function relevePdf(d: DonneesReleve): Buffer {
  const doc = new DocumentPdf();
  const marge = 50;
  const droite = doc.largeurPage - marge;
  let y = doc.hauteurPage - 60;

  /* Une ligne de tableau ne commence pas sous la marge basse : elle passe a la page suivante. */
  const place = (hauteur: number) => {
    if (y - hauteur < 70) {
      doc.nouvellePage();
      y = doc.hauteurPage - 60;
    }
  };

  doc.texte(marge, y, `${CLUB.sigle} · ${CLUB.nom}`, { corps: 9, couleur: DISCRET });
  y -= 26;
  doc.texte(marge, y, "Relevé de cotisations", { corps: 20, gras: true });
  y -= 20;
  doc.texte(marge, y, d.nom, { corps: 12, gras: true });
  doc.texte(droite, y, `au ${dateCourte(d.date)}`, { corps: 10, couleur: DISCRET, aDroite: true });
  y -= 30;

  /* La synthese : les quatre chiffres que le courrier annonce. */
  const total = d.cotisationsARegler + d.penalitesDues;
  const chiffres: [string, number, boolean][] = [
    ["Cotisations à régler", d.cotisationsARegler, false],
    ["Pénalités dues", d.penalitesDues, false],
    ["Total à régler", total, true],
    ["Versé et validé", d.verse, false],
  ];
  const colonne = (droite - marge) / chiffres.length;
  doc.trait(marge, y + 14, droite, y + 14, FILET);
  chiffres.forEach(([libelle, montant, fort], i) => {
    const x = marge + i * colonne;
    doc.texte(x, y, libelle, { corps: 8.5, couleur: DISCRET });
    doc.texte(x, y - 17, fcfa(montant), { corps: 12.5, gras: true, couleur: fort && montant > 0 ? ROUGE : ENCRE });
  });
  y -= 32;
  doc.trait(marge, y, droite, y, FILET);
  y -= 34;

  /* Les douze derniers mois, du plus recent au plus ancien. */
  const mois = d.cellules.filter((c) => c.statut !== "hors_periode").slice(-12).reverse();
  doc.texte(marge, y, "Les douze derniers mois", { corps: 12, gras: true });
  y -= 18;
  const colonnes = [marge + 8, marge + 180, marge + 270, marge + 290];
  doc.aplat(marge, y - 6, droite - marge, 20, FOND);
  doc.texte(colonnes[0], y, "Mois", { corps: 8.5, gras: true, couleur: DISCRET });
  doc.texte(colonnes[1], y, "Dû", { corps: 8.5, gras: true, couleur: DISCRET, aDroite: true });
  doc.texte(colonnes[2], y, "Versé", { corps: 8.5, gras: true, couleur: DISCRET, aDroite: true });
  doc.texte(colonnes[3], y, "État", { corps: 8.5, gras: true, couleur: DISCRET });
  y -= 22;
  for (const c of mois) {
    place(20);
    const manque = c.statut === "retard" || c.statut === "partiel";
    const etat =
      c.statut === "partiel"
        ? `Incomplet : il manque ${fcfa(c.manque)}`
        : c.statut === "retard"
          ? `En retard : ${fcfa(c.manque > 0 ? c.manque : c.requis)} dus depuis le ${REGLES.jourEcheance}`
          : LIBELLE_STATUT[c.statut];
    doc.texte(colonnes[0], y, moisLong(c.mois), { corps: 10 });
    doc.texte(colonnes[1], y, fcfa(c.requis), { corps: 10, aDroite: true });
    doc.texte(colonnes[2], y, c.montant > 0 ? fcfa(c.montant) : "--", { corps: 10, aDroite: true });
    doc.texte(colonnes[3], y, etat, {
      corps: 10,
      gras: manque,
      couleur: manque ? ROUGE : c.statut === "en_attente" ? AMBRE : ENCRE,
    });
    doc.trait(marge, y - 7, droite, y - 7, FILET, 0.5);
    y -= 20;
  }

  /* Les penalites dues, ligne par ligne, telles que le registre les porte. */
  if (d.penalites.length > 0) {
    y -= 20;
    place(60);
    doc.texte(marge, y, "Pénalités dues", { corps: 12, gras: true });
    y -= 18;
    doc.aplat(marge, y - 6, droite - marge, 20, FOND);
    doc.texte(marge + 8, y, "Constatée le", { corps: 8.5, gras: true, couleur: DISCRET });
    doc.texte(marge + 90, y, "Objet", { corps: 8.5, gras: true, couleur: DISCRET });
    doc.texte(droite - 8, y, "Montant", { corps: 8.5, gras: true, couleur: DISCRET, aDroite: true });
    y -= 22;
    for (const p of d.penalites) {
      /* Un motif automatique commence deja par la nature : ne pas la dire deux fois. */
      const objet = !p.motif ? p.nature : p.motif.startsWith(p.nature) ? p.motif : `${p.nature} : ${p.motif}`;
      const lignes = doc.lignes(objet, droite - 8 - 90 - marge - 80, 10);
      place(14 * lignes.length + 8);
      doc.texte(marge + 8, y, dateCourte(p.date), { corps: 10 });
      lignes.forEach((l, i) => doc.texte(marge + 90, y - i * 13, l, { corps: 10 }));
      doc.texte(droite - 8, y, fcfa(p.montant), { corps: 10, aDroite: true });
      y -= 13 * lignes.length;
      doc.trait(marge, y + 6, droite, y + 6, FILET, 0.5);
      y -= 7;
    }
  }

  /* Le rappel des statuts, en pied : ce qui fonde les montants. */
  y -= 24;
  const note =
    `La cotisation est exigible le ${REGLES.jourEcheance} de chaque mois (art. 8). La pénalité de l'art. 9 ` +
    "reste acquise au club, même après régularisation du mois. Un versement déclaré n'est compté qu'une fois " +
    "validé par le trésorier. Relevé établi par le site du club ; une erreur se signale au bureau en " +
    "répondant au courriel qui l'accompagne.";
  const lignesNote = doc.lignes(note, droite - marge, 8.5);
  place(12 * lignesNote.length);
  lignesNote.forEach((l, i) => doc.texte(marge, y - i * 12, l, { corps: 8.5, couleur: DISCRET }));

  return doc.octets(`Relevé de ${d.nom} au ${dateCourte(d.date)}`);
}

/** Le nom du fichier joint : sans accent ni espace, pour toutes les messageries. */
export function nomFichierReleve(nom: string, date: string): string {
  const simple = nom
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `releve-${simple}-${date.slice(0, 10)}.pdf`;
}
