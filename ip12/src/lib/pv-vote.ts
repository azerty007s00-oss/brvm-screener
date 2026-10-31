import { DocumentPdf, couleur } from "./pdf";
import { CLUB, dateCourte } from "./settings";
import { CHOIX, MAJORITES, phraseResultat, pourcent, type Bulletin, type Electeur, type Majorite, type Resultat } from "./scrutin";

/**
 * Le proces-verbal d'un vote clos : la question, la regle, le resultat, et
 * qui a vote quoi avec son poids. Le vote est public : le PV l'est aussi, et
 * se garde avec les rapports de reunion. Mise en forme pure.
 */
export type DonneesPv = {
  question: string;
  details: string | null;
  majorite: Majorite;
  auteur: string;
  ouvertLe: string;
  closLe: string;
  vise: string | null;
  electeurs: Electeur[];
  bulletins: Bulletin[];
  resultat: Resultat;
};

const DISCRET = couleur("#625950");
const FILET = couleur("#e8e2d9");
const FOND = couleur("#efebe5");
const VERT = couleur("#2e7d52");
const ROUGE = couleur("#a8322c");

export function pvVotePdf(d: DonneesPv): Buffer {
  const doc = new DocumentPdf();
  const marge = 50;
  const droite = doc.largeurPage - marge;
  let y = doc.hauteurPage - 60;
  const place = (h: number) => {
    if (y - h < 70) {
      doc.nouvellePage();
      y = doc.hauteurPage - 60;
    }
  };
  const paragraphe = (t: string, corps = 10, teinte = couleur("#1c1713")) => {
    const lignes = doc.lignes(t, droite - marge, corps);
    place(13 * lignes.length + 6);
    lignes.forEach((l, i) => doc.texte(marge, y - i * (corps + 3), l, { corps, couleur: teinte }));
    y -= (corps + 3) * lignes.length + 8;
  };

  doc.texte(marge, y, `${CLUB.sigle} · ${CLUB.nom}`, { corps: 9, couleur: DISCRET });
  y -= 26;
  doc.texte(marge, y, "Procès-verbal de vote", { corps: 19, gras: true });
  y -= 24;
  paragraphe(d.question, 13);
  if (d.details) paragraphe(d.details, 10, DISCRET);
  paragraphe(
    `Proposé par ${d.auteur} le ${dateCourte(d.ouvertLe)}, clos le ${dateCourte(d.closLe)}. Majorité requise : ${MAJORITES[d.majorite].regle}, ` +
      "au prorata des parts (art. 12), sur l'ensemble des voix qui peuvent voter." +
      (d.vise ? ` Le vote concerne ${d.vise}, qui ne vote pas.` : ""),
    10,
    DISCRET,
  );
  y -= 4;
  place(40);
  doc.texte(marge, y, d.resultat.adopte ? "Adopté" : "Rejeté", { corps: 17, gras: true, couleur: d.resultat.adopte ? VERT : ROUGE });
  y -= 20;
  paragraphe(phraseResultat(d.resultat, d.majorite));
  const r = d.resultat;
  const part = (p: number) => pourcent(r.base > 0 ? p / r.base : 0);
  paragraphe(
    `Pour : ${part(r.pour)} · Contre : ${part(r.contre)} · Abstention : ${part(r.abstention)}` +
      (r.silence > 0.0005 ? ` · Sans vote : ${part(r.silence)}` : "") +
      ` · ${r.votants} ${r.votants > 1 ? "votants" : "votant"} sur ${r.admis}.`,
  );

  y -= 8;
  place(60);
  doc.texte(marge, y, "Qui a voté quoi", { corps: 12, gras: true });
  y -= 18;
  doc.aplat(marge, y - 6, droite - marge, 20, FOND);
  doc.texte(marge + 8, y, "Membre", { corps: 8.5, gras: true, couleur: DISCRET });
  doc.texte(marge + 330, y, "Poids", { corps: 8.5, gras: true, couleur: DISCRET, aDroite: true });
  doc.texte(marge + 350, y, "Vote", { corps: 8.5, gras: true, couleur: DISCRET });
  y -= 22;
  const choixDe = new Map(d.bulletins.map((b) => [b.membreId, b.choix]));
  for (const e of [...d.electeurs].sort((a, b) => b.poids - a.poids || a.nom.localeCompare(b.nom, "fr"))) {
    place(20);
    const c = choixDe.get(e.membreId);
    const vote =
      e.exclu === "vise" ? "concerné, ne vote pas" : e.exclu === "suspendu" ? "suspendu (R2)" : c ? (CHOIX.find((x) => x.cle === c)?.libelle ?? c) : "n'a pas voté";
    doc.texte(marge + 8, y, e.nom, { corps: 10 });
    doc.texte(marge + 330, y, pourcent(e.poids), { corps: 10, aDroite: true });
    doc.texte(marge + 350, y, vote, { corps: 10 });
    doc.trait(marge, y - 7, droite, y - 7, FILET, 0.5);
    y -= 20;
  }
  y -= 14;
  paragraphe("Poids figés à la clôture. Procès-verbal établi par le site du club, à partir des bulletins déposés en ligne.", 8.5, DISCRET);
  return doc.octets(`Procès-verbal : ${d.question}`);
}
