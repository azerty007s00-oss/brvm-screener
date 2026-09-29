// Contraste des couples fond/encre poses en style en ligne.
// Lancement : npm run verif:contraste
//
// SEPT FOIS la meme faute est passee : un fond et une encre pointes sur le meme
// jeton, ou sur deux jetons trop proches. Elle ne se voit pas a la lecture -- le
// code dit « --sunk » d'un cote et « --sunk » de l'autre, ce qui n'a rien
// d'alarmant -- et ne se voit qu'en ouvrant la page, dans le bon theme.
//
// La premiere version de ce controle en a trouve six, puis en a laisse passer
// une septieme : la pastille « Acces total » de l'administration, fond en rgba()
// litteral et encre en jeton, sur deux lignes separees. Elle s'affichait vide
// sur le site en ligne. Ce script lit donc l'objet de style entier, sur autant
// de lignes qu'il en occupe, et ramene a une couleur aussi bien les jetons que
// le #rrggbb et le rgba() -- ce dernier compose avec le fond de la page.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
 * La premiere version resolvait le theme clair, puis partait de ce resultat
 * pour le theme sombre. Or `--discret: var(--ink-2)` n'est declare qu'une fois,
 * dans :root : le bloc sombre ne redefinit que `--ink-2`. En resolvant trop
 * tot, l'alias devenait le brun clair et ne suivait plus -- le controle voyait
 * alors un texte invisible la ou le navigateur, qui resout `var()` a l'emploi,
 * affiche un texte parfaitement lisible. Il a signale une faute qui n'existait
 * pas, ce qui est la seule chose qu'un controle ne doit jamais faire.
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
function couleur(valeur, jetons) {
  const v = valeur.trim();
  if (v.startsWith("var(")) return jetons[v.slice(4, v.indexOf(")"))] ?? null;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("");

  /*
   * Un rgba() translucide se pose sur le fond de la page : on le compose avec
   * lui, sinon on mesurerait une couleur qui n'existe nulle part.
   */
  const rgba = v.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/,
  );
  if (rgba) {
    const [r, g, b] = rgba.slice(1, 4).map(Number);
    const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
    const page = jetons["--page"] ?? "#ffffff";
    const fond = [1, 3, 5].map((i) => parseInt(page.slice(i, i + 2), 16));
    const melange = [r, g, b].map((c, i) => Math.round(c * a + fond[i] * (1 - a)));
    return "#" + melange.map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  return null;
}

/* ------------------------------------------------------------- les couples */

function fichiers(dossier) {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) return fichiers(chemin);
    return chemin.endsWith(".tsx") ? [chemin] : [];
  });
}

/** Un objet de style JSX, quelle que soit sa mise en page. */
const OBJET = /style=\{\{([\s\S]*?)\}\}/g;
const declaration = (nom, corps) =>
  corps.match(new RegExp(`(?:^|[,{\\s])${nom}\\s*:\\s*"([^"]+)"`));

let mesures = 0;
const fautes = [];

for (const chemin of fichiers(join(RACINE, "src"))) {
  const source = readFileSync(chemin, "utf8");
  for (const trouve of source.matchAll(OBJET)) {
    const corps = trouve[1];
    const fond = declaration("background", corps);
    const encre = declaration("color", corps);
    if (!fond || !encre) continue;
    const ligne = source.slice(0, trouve.index).split("\n").length;

    for (const [theme, jetons] of [
      ["clair", clair],
      ["sombre", sombre],
    ]) {
      const f = couleur(fond[1], jetons);
      const e = couleur(encre[1], jetons);
      // Une valeur qu'on ne sait pas ramener a une couleur -- « inherit »,
      // « currentColor » -- n'est pas une faute : elle n'est pas mesurable ici.
      if (!f || !e) continue;
      mesures++;
      const r = contraste(f, e);
      if (r < 4.5) {
        fautes.push(
          `${chemin.replace(RACINE, "")}:${ligne} — ${fond[1]} sous ${encre[1]}, ` +
            `${r.toFixed(2)}:1 en ${theme}${r < 3 ? " (invisible)" : ""}`,
        );
      }
    }
  }
}

if (fautes.length > 0) {
  console.error(`ECHEC — ${fautes.length} couple(s) illisible(s) :\n  ` + fautes.join("\n  "));
  process.exit(1);
}

console.log(`OK - ${mesures} couples fond/encre mesures, clair et sombre, tous au-dela de 4,5:1.`);
