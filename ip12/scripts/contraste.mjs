// Contraste des couples fond/encre poses en style en ligne.
// Lancement : npm run verif:contraste
//
// HUIT FOIS la meme faute est passee : une encre posee sur un fond trop proche
// d'elle. Elle ne se voit pas a la lecture -- le code dit « --sunk » d'un cote
// et « --sunk » de l'autre, ce qui n'a rien d'alarmant -- et ne se voit qu'en
// ouvrant la page, dans le bon theme.
//
// Les deux premieres versions lisaient le fichier a l'expression reguliere, et
// ne mesuraient qu'un objet de style declarant A LA FOIS un fond et une encre.
// Elles ont donc laisse passer la huitieme : l'explication des reglages
// manquants, `color: var(--line-2)` seul, sur un fond d'alerte herite du bloc
// parent -- 1,22:1, illisible, et c'etait justement le texte qui dit ce qui
// manque.
//
// Cette version lit l'arbre du fichier avec le compilateur TypeScript. Elle
// suit donc la VRAIE imbrication des elements : une encre declaree seule est
// mesuree contre le fond de son ancetre le plus proche, et a defaut contre le
// fond de la page. Aucune heuristique d'indentation, donc aucune fausse alerte
// -- la seule chose qu'un controle ne doit jamais produire.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const RACINE = new URL("..", import.meta.url).pathname;
const CSS = readFileSync(join(RACINE, "src/app/globals.css"), "utf8");

/* ------------------------------------------------------------- les jetons */

/** Les declarations brutes d'un bloc, sans y toucher. */
function declarationsDuBloc(bloc) {
  const table = {};
  for (const [, nom, valeur] of bloc.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    table[nom] = valeur.trim();
  }
  return table;
}

/**
 * Les jetons d'un theme, resolus jusqu'a la couleur.
 *
 * ON RESOUT APRES AVOIR FUSIONNE, jamais avant.
 *
 * Une version precedente resolvait le theme clair, puis partait de ce resultat
 * pour le theme sombre. Or `--discret: var(--ink-2)` n'est declare qu'une fois,
 * dans :root : le bloc sombre ne redefinit que `--ink-2`. En resolvant trop
 * tot, l'alias devenait le brun clair et ne suivait plus -- le controle voyait
 * alors un texte invisible la ou le navigateur, qui resout `var()` a l'emploi,
 * affiche un texte parfaitement lisible.
 *
 * Un jeton peut en designer un autre sur deux ou trois rangs ; on deroule avec
 * une borne, sinon une boucle de references ferait tourner le controle au lieu
 * de le faire echouer.
 */
function resoudre(...blocs) {
  const table = Object.assign({}, ...blocs);
  const resolu = {};
  for (const nom of Object.keys(table)) {
    let v = table[nom];
    for (let i = 0; i < 5 && typeof v === "string" && v.startsWith("var("); i++) {
      v = table[v.slice(4, v.indexOf(")"))];
    }
    if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim())) resolu[nom] = v.trim();
  }
  return resolu;
}

function bloc(selecteur) {
  const i = CSS.indexOf(selecteur);
  if (i === -1) return "";
  const debut = CSS.indexOf("{", i);
  return CSS.slice(debut, CSS.indexOf("\n}", debut));
}

const palette = declarationsDuBloc(bloc("@theme {"));
const racine = declarationsDuBloc(bloc("\n:root {"));
const nuit = declarationsDuBloc(bloc(':root[data-theme="dark"] {'));

const clair = resoudre(palette, racine);
const sombre = resoudre(palette, racine, nuit);

/* -------------------------------------------------------------- la mesure */

const canal = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex) {
  const [r, v, b] = [1, 3, 5].map((i) => canal(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * v + 0.0722 * b;
}

function contraste(a, b) {
  const [haut, bas] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (haut + 0.05) / (bas + 0.05);
}

/* ------------------------------------------------------------ les couleurs */

/** Une valeur CSS ramenee a un #rrggbb, ou null si elle ne s'y ramene pas. */
function couleur(valeur, jetons, dessous) {
  const v = String(valeur).trim();
  if (v.startsWith("var(")) {
    const nom = v.slice(4, v.indexOf(")")).trim();
    return jetons[nom] ?? null;
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("");

  /*
   * Un rgba() translucide se pose sur ce qu'il y a dessous : on le compose avec
   * lui, sinon on mesurerait une couleur qui n'existe nulle part.
   */
  const rgba = v.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/,
  );
  if (rgba) {
    const [r, g, b] = rgba.slice(1, 4).map(Number);
    const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
    const base = dessous ?? jetons["--page"] ?? "#ffffff";
    const fond = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16));
    const melange = [r, g, b].map((c, i) => Math.round(c * a + fond[i] * (1 - a)));
    return "#" + melange.map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  return null;
}

/* --------------------------------------------------------------- l'arbre */

function fichiers(dossier) {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) return fichiers(chemin);
    return chemin.endsWith(".tsx") ? [chemin] : [];
  });
}

/**
 * Les valeurs possibles d'une expression de style, en texte.
 *
 * Un ternaire donne ses deux branches : `ici ? "var(--ink)" : "var(--ink-2)"`
 * pose deux encres sur le meme fond, et les deux doivent tenir. Tout ce qui
 * n'est pas une chaine connue a l'avance -- un appel, une variable -- ne se
 * mesure pas ici et ne compte pas comme une faute.
 */
function valeursPossibles(noeud) {
  if (ts.isStringLiteral(noeud) || ts.isNoSubstitutionTemplateLiteral(noeud)) return [noeud.text];
  if (ts.isConditionalExpression(noeud)) {
    return [...valeursPossibles(noeud.whenTrue), ...valeursPossibles(noeud.whenFalse)];
  }
  if (ts.isParenthesizedExpression(noeud)) return valeursPossibles(noeud.expression);
  /* `a ?? "var(--ink)"` : la branche de droite est celle qu'on peut mesurer. */
  if (ts.isBinaryExpression(noeud) && noeud.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return valeursPossibles(noeud.right);
  }
  return [];
}

/** Le fond et l'encre declares par l'attribut `style` d'une balise. */
function styleDeLaBalise(ouvrante) {
  const sortie = { fonds: [], encres: [] };
  const attr = ouvrante.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === "style",
  );
  if (!attr || !attr.initializer || !ts.isJsxExpression(attr.initializer)) return sortie;
  const objet = attr.initializer.expression;
  if (!objet || !ts.isObjectLiteralExpression(objet)) return sortie;

  for (const prop of objet.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const nom = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (nom === "background" || nom === "backgroundColor") {
      sortie.fonds.push(...valeursPossibles(prop.initializer));
    } else if (nom === "color") {
      sortie.encres.push(...valeursPossibles(prop.initializer));
    }
  }
  return sortie;
}

/* -------------------------------------------------------------- le controle */

let mesures = 0;
const fautes = [];
const vus = new Set();

for (const chemin of fichiers(join(RACINE, "src"))) {
  const source = readFileSync(chemin, "utf8");
  const arbre = ts.createSourceFile(chemin, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

  /*
   * On descend l'arbre en portant le dernier fond declare au-dessus. Le fond
   * de depart est celui de la page : aucune classe utilitaire de fond n'existe
   * dans ce projet -- tous les fonds passent par un objet `style` --, donc ce
   * qui n'a pas d'ancetre colore est bien pose sur la page.
   */
  const descendre = (noeud, herite) => {
    let ici = herite;
    const ouvrante = ts.isJsxElement(noeud)
      ? noeud.openingElement
      : ts.isJsxSelfClosingElement(noeud)
        ? noeud
        : null;

    if (ouvrante) {
      const { fonds, encres } = styleDeLaBalise(ouvrante);
      if (fonds.length > 0) ici = fonds;
      const ligne = arbre.getLineAndCharacterOfPosition(ouvrante.getStart()).line + 1;

      for (const encre of encres) {
        for (const fond of ici) {
          for (const [theme, jetons] of [
            ["clair", clair],
            ["sombre", sombre],
          ]) {
            const f = couleur(fond, jetons, null);
            const e = couleur(encre, jetons, f);
            /*
             * Une valeur qu'on ne sait pas ramener a une couleur -- « inherit »,
             * « currentColor », un degrade -- n'est pas une faute : elle n'est
             * pas mesurable ici.
             */
            if (!f || !e) continue;
            const cle = `${chemin}:${ligne}:${fond}:${encre}:${theme}`;
            if (vus.has(cle)) continue;
            vus.add(cle);
            mesures++;
            const r = contraste(f, e);
            if (r < 4.5) {
              fautes.push(
                `${chemin.replace(RACINE, "")}:${ligne} — ${fond} sous ${encre}, ` +
                  `${r.toFixed(2)}:1 en ${theme}${r < 3 ? " (invisible)" : ""}`,
              );
            }
          }
        }
      }
    }

    ts.forEachChild(noeud, (enfant) => descendre(enfant, ici));
  };

  descendre(arbre, ["var(--page)"]);
}

if (fautes.length > 0) {
  console.error(`ECHEC — ${fautes.length} couple(s) illisible(s) :\n  ` + fautes.join("\n  "));
  process.exit(1);
}

console.log(`OK - ${mesures} couples fond/encre mesures, clair et sombre, tous au-dela de 4,5:1.`);
