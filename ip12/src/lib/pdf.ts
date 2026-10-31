/**
 * Un PDF minimal : du texte en Helvetica, des traits et des aplats, sur des pages A4.
 *
 * POURQUOI ECRIT A LA MAIN. Le releve joint a une relance n'a besoin que de
 * cela : quelques lignes, deux tableaux, un filet. Une bibliotheque PDF pese
 * plusieurs centaines de kilo-octets dans la fonction serveur et apporte sa
 * propre gestion des polices ; les quatorze polices standard du format, elles,
 * sont dans tous les lecteurs, sans rien embarquer. Le prix : les caracteres
 * hors de l'encodage WinAnsi -- qui couvre le francais, accents, guillemets et
 * apostrophe typographique compris -- deviennent « ? ».
 */

const A4 = { largeur: 595.28, hauteur: 841.89 };

/** WinAnsi : Latin-1, plus la plage 0x80-0x9F que Windows a garnie. */
const HORS_LATIN1: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "Œ": 0x8c, "‘": 0x91, "’": 0x92, "“": 0x93,
  "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "œ": 0x9c, "Ÿ": 0x9f,
  // Les espaces insecables etroites des montants (« 5 000 ») : une espace insecable.
  " ": 0xa0, " ": 0x20,
};

function octet(c: string): number {
  const code = c.charCodeAt(0);
  if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return code;
  return HORS_LATIN1[c] ?? 0x3f;
}

/** Les chasses d'Helvetica, en milliemes de corps (fichier AFM d'Adobe). */
const CHASSES =
  "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556," +
  "556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833," +
  "722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556," +
  "556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334," +
  "260,334,584";
const ASCII = CHASSES.split(",").map(Number);

function chasse(o: number): number {
  if (o >= 32 && o <= 126) return ASCII[o - 32];
  if (o === 0xa0) return 278;
  if (o === 0x92 || o === 0x91) return 222;
  if (o === 0xe7) return 500; // ç
  if (o >= 0xec && o <= 0xef) return 278; // ì í î ï
  if (o >= 0xc0 && o <= 0xc6) return 667; // À Â …
  if (o >= 0xc8 && o <= 0xcb) return 667; // É È …
  return 556;
}

function enOctets(texte: string): number[] {
  return [...texte].map(octet);
}

/** La largeur d'un texte en points : sert a aligner a droite et a couper les lignes. */
export function largeur(texte: string, corps: number, gras = false): number {
  const brute = enOctets(texte).reduce((t, o) => t + chasse(o), 0);
  // Le gras d'Helvetica est un peu plus large hors des chiffres : 5 % suffisent a aligner.
  return (brute * corps * (gras ? 1.05 : 1)) / 1000;
}

type Couleur = [number, number, number];

/** « #1e3a5f » en composantes de 0 a 1. */
export function couleur(hex: string): Couleur {
  const v = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as Couleur;
}

const nombre = (x: number) => (Math.round(x * 100) / 100).toString();

export class DocumentPdf {
  private pages: number[][] = [];
  private courante: number[] = [];

  constructor() {
    this.pages.push(this.courante);
  }

  readonly largeurPage = A4.largeur;
  readonly hauteurPage = A4.hauteur;

  nouvellePage(): void {
    this.courante = [];
    this.pages.push(this.courante);
  }

  private ecrire(texte: string): void {
    for (const c of texte) this.courante.push(c.charCodeAt(0));
  }

  /** Un texte pose sur sa ligne de base, en (x, y) depuis le coin inferieur gauche. */
  texte(
    x: number,
    y: number,
    contenu: string,
    options: { corps?: number; gras?: boolean; couleur?: Couleur; aDroite?: boolean } = {},
  ): void {
    const corps = options.corps ?? 10;
    const gras = options.gras ?? false;
    const [r, g, b] = options.couleur ?? [0.11, 0.09, 0.07];
    const depart = options.aDroite ? x - largeur(contenu, corps, gras) : x;
    this.ecrire(`BT /${gras ? "F2" : "F1"} ${corps} Tf ${nombre(r)} ${nombre(g)} ${nombre(b)} rg `);
    this.ecrire(`${nombre(depart)} ${nombre(y)} Td (`);
    for (const o of enOctets(contenu)) {
      if (o === 0x28 || o === 0x29 || o === 0x5c) this.courante.push(0x5c);
      this.courante.push(o === 0x0a || o === 0x0d ? 0x20 : o);
    }
    this.ecrire(") Tj ET\n");
  }

  /** Coupe un texte en lignes qui tiennent dans une largeur donnee. */
  lignes(contenu: string, largeurMax: number, corps = 10, gras = false): string[] {
    const lignes: string[] = [];
    let ligne = "";
    for (const mot of contenu.split(/\s+/)) {
      const essai = ligne ? `${ligne} ${mot}` : mot;
      if (ligne && largeur(essai, corps, gras) > largeurMax) {
        lignes.push(ligne);
        ligne = mot;
      } else ligne = essai;
    }
    if (ligne) lignes.push(ligne);
    return lignes;
  }

  trait(x1: number, y1: number, x2: number, y2: number, teinte: Couleur = [0.91, 0.89, 0.85], epaisseur = 0.75): void {
    const [r, g, b] = teinte;
    this.ecrire(`${nombre(r)} ${nombre(g)} ${nombre(b)} RG ${epaisseur} w ${nombre(x1)} ${nombre(y1)} m ${nombre(x2)} ${nombre(y2)} l S\n`);
  }

  aplat(x: number, y: number, l: number, h: number, teinte: Couleur): void {
    const [r, g, b] = teinte;
    this.ecrire(`${nombre(r)} ${nombre(g)} ${nombre(b)} rg ${nombre(x)} ${nombre(y)} ${nombre(l)} ${nombre(h)} re f\n`);
  }

  /** Le fichier : catalogue, pages, deux polices standard, et la table des renvois. */
  octets(titre = ""): Buffer {
    const morceaux: Buffer[] = [];
    const renvois: number[] = [];
    let position = 0;
    const pousser = (b: Buffer) => {
      morceaux.push(b);
      position += b.length;
    };
    const objet = (numero: number, corps: Buffer) => {
      renvois[numero] = position;
      pousser(Buffer.from(`${numero} 0 obj\n`, "latin1"));
      pousser(corps);
      pousser(Buffer.from("\nendobj\n", "latin1"));
    };

    // 1 catalogue, 2 pages, 3 et 4 polices, 5 informations, puis page et contenu par page.
    const premierePage = 6;
    const numerosPages = this.pages.map((_, i) => premierePage + i * 2);

    pousser(Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1"));
    objet(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
    objet(
      2,
      Buffer.from(`<< /Type /Pages /Kids [${numerosPages.map((n) => `${n} 0 R`).join(" ")}] /Count ${this.pages.length} >>`, "latin1"),
    );
    objet(3, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "latin1"));
    objet(4, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>", "latin1"));
    const titreEchappe = Buffer.from(
      enOctets(titre).flatMap((o) => (o === 0x28 || o === 0x29 || o === 0x5c ? [0x5c, o] : [o])),
    );
    objet(
      5,
      Buffer.concat([Buffer.from("<< /Title (", "latin1"), titreEchappe, Buffer.from(") /Producer (IP12) >>", "latin1")]),
    );
    this.pages.forEach((contenu, i) => {
      const numero = numerosPages[i];
      objet(
        numero,
        Buffer.from(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.largeur} ${A4.hauteur}] ` +
            `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${numero + 1} 0 R >>`,
          "latin1",
        ),
      );
      const flux = Buffer.from(contenu);
      objet(
        numero + 1,
        Buffer.concat([
          Buffer.from(`<< /Length ${flux.length} >>\nstream\n`, "latin1"),
          flux,
          Buffer.from("\nendstream", "latin1"),
        ]),
      );
    });

    const total = premierePage + this.pages.length * 2;
    const debutTable = position;
    const lignes = ["xref", `0 ${total}`, "0000000000 65535 f "];
    for (let n = 1; n < total; n++) lignes.push(`${String(renvois[n]).padStart(10, "0")} 00000 n `);
    pousser(
      Buffer.from(
        `${lignes.join("\n")}\ntrailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${debutTable}\n%%EOF\n`,
        "latin1",
      ),
    );
    return Buffer.concat(morceaux);
  }
}
