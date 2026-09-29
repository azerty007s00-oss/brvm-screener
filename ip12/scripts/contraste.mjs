// Contraste des couples fond/encre poses en style en ligne.
// Lancement : npm run verif:contraste
//
// TROIS FOIS la meme faute est passee : un fond et une encre pointes sur le
// meme jeton, ou sur deux jetons trop proches. Elle ne se voit pas a la
// lecture -- le code dit « --sunk » d'un cote et « --sunk » de l'autre, ce qui
// n'a rien d'alarmant -- et elle ne se voit qu'en ouvrant la page, dans le bon
// theme. Une fois c'est une inattention ; trois fois, c'est un controle qui
// manque.
//
// Le script lit les valeurs des jetons dans globals.css, pour le theme clair et
// pour le theme sombre, puis chaque couple `background: var(--x), color:
// var(--y)` pose dans un fichier .tsx, et mesure. En dessous de 4,5:1 le texte
// n'est pas lisible ; en dessous de 3:1 il est invisible.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const RACINE = new URL("..", import.meta.url).pathname;
const CSS = readFileSync(join(RACINE, "src/app/globals.css"), "utf8");

/* ------------------------------------------------------------- les jetons */

/**
 * Les valeurs d'un bloc de declarations, resolues jusqu'a la couleur.
 *
 * Un jeton peut en designer un autre (`--fond: var(--page)`), sur deux ou trois
 * rangs. On deroule, avec une borne : une boucle de references ferait tourner
 * le controle au lieu de le faire echouer.
 */
function jetonsDuBloc(bloc, base = {}) {
  const table = { ...base };
  for (const [, nom, valeur] of bloc.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    table[nom] = valeur.trim();
  }
  const resolu = {};
  for (const nom of Object.keys(table)) {
    let v = table[nom];
    for (let i = 0; i < 5 && v?.startsWith("var("); i++) {
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

const palette = jetonsDuBloc(bloc("@theme {"));
const clair = jetonsDuBloc(bloc("\n:root {"), palette);
const sombre = jetonsDuBloc(bloc(':root[data-theme="dark"] {'), clair);

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

/* ------------------------------------------------------------- les couples */

function fichiers(dossier) {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) return fichiers(chemin);
    return chemin.endsWith(".tsx") ? [chemin] : [];
  });
}

const COUPLE = /background:\s*"var\((--[a-z0-9-]+)\)"\s*,\s*color:\s*"var\((--[a-z0-9-]+)\)"/g;

let mesures = 0;
const fautes = [];

for (const chemin of fichiers(join(RACINE, "src"))) {
  const lignes = readFileSync(chemin, "utf8").split("\n");
  lignes.forEach((ligne, i) => {
    for (const [, fond, encre] of ligne.matchAll(COUPLE)) {
      for (const [theme, jetons] of [
        ["clair", clair],
        ["sombre", sombre],
      ]) {
        const f = jetons[fond];
        const e = jetons[encre];
        // Un jeton non resolu -- une couleur ecrite en rgb(), par exemple --
        // n'est pas une faute : il n'est simplement pas mesurable ici.
        if (!f || !e) continue;
        mesures++;
        const r = contraste(f, e);
        if (r < 4.5) {
          fautes.push(
            `${chemin.replace(RACINE, "")}:${i + 1} — ${fond} sous ${encre}, ` +
              `${r.toFixed(2)}:1 en ${theme}${r < 3 ? " (invisible)" : ""}`,
          );
        }
      }
    }
  });
}

if (fautes.length > 0) {
  console.error(`ECHEC — ${fautes.length} couple(s) illisible(s) :\n  ` + fautes.join("\n  "));
  process.exit(1);
}

console.log(`OK - ${mesures} couples fond/encre mesures, clair et sombre, tous au-dela de 4,5:1.`);
