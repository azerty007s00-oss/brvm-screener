/*
 * Rejoue chaque requete SQL du site contre un PostgreSQL portant le schema de
 * production.
 *
 * Ce que ce controle attrape : une colonne renommee, une table oubliee, une
 * faute de frappe dans un nom, une jointure sur un champ qui n'existe plus.
 * Autant de fautes qu'aucun compilateur ne voit -- le SQL n'est qu'une chaine
 * pour TypeScript -- et qui n'eclatent qu'au moment ou un membre ouvre la page
 * concernee.
 *
 * Ce qu'il n'attrape pas : une requete juste qui donne un mauvais resultat. La
 * justesse des calculs se verifie dans `verif.mjs`, sur des donnees en memoire.
 *
 * Aucune requete n'est executee : chacune passe par EXPLAIN, qui l'analyse et
 * la planifie sans la lancer, le tout dans une transaction annulee. Les valeurs
 * interpolees deviennent NULL, ce qui suffit a la verification des noms et des
 * types sans qu'aucune donnee soit touchee.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const RACINE = process.cwd();
const SCHEMA = "scripts/test/schema-local.sql";

/* ------------------------------------------------------------- extraction */

/** Les fichiers qui parlent a la base. */
function sources(dossier, trouves = []) {
  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) sources(chemin, trouves);
    else if (/\.tsx?$/.test(entree) && readFileSync(chemin, "utf8").includes("sql`")) {
      trouves.push(chemin);
    }
  }
  return trouves;
}

/**
 * Decoupe les gabarits `sql`...`` d'un fichier.
 *
 * Un balayage caractere par caractere plutot qu'une expression reguliere : le
 * corps d'un gabarit contient des `${...}` qui peuvent eux-memes contenir des
 * accolades, et une expression reguliere s'arreterait a la premiere.
 */
function gabarits(source) {
  const sortie = [];
  for (let i = 0; i < source.length; i++) {
    if (!source.startsWith("sql`", i)) continue;
    /* Ecarter `monSql` ou `nosql` : le caractere precedent doit etre un separateur. */
    if (i > 0 && /[\w.$]/.test(source[i - 1])) continue;
    let j = i + 4;
    let profondeur = 0;
    let corps = "";
    for (; j < source.length; j++) {
      const c = source[j];
      if (c === "\\") { corps += c + source[++j]; continue; }
      if (c === "$" && source[j + 1] === "{") { profondeur++; corps += "${"; j++; continue; }
      if (c === "}" && profondeur > 0) { profondeur--; corps += "}"; continue; }
      if (c === "`" && profondeur === 0) break;
      corps += c;
    }
    sortie.push({ corps, ligne: source.slice(0, i).split("\n").length });
    i = j;
  }
  return sortie;
}

/** Les constantes de projection injectees par `sql.unsafe`, relevees dans le fichier. */
function constantes(source) {
  const table = new Map();
  const re = /^const (CHAMPS_\w+) = `([\s\S]*?)`;/gm;
  let m;
  while ((m = re.exec(source))) table.set(m[1], m[2]);
  return table;
}

/*
 * `listerApports` compose sa projection par une fonction, selon que la colonne
 * `fees` existe ou non : les deux formes sont verifiees.
 */
const PROJECTIONS_CALCULEES = {
  "projection(avecFrais)": [
    `t.id, to_char(t.transfer_date, 'YYYY-MM-DD') as date_transfert,
     t.amount as montant, t.fees as frais,
     t.direction as sens, t.note, c.full_name as saisi_par_nom`,
    `t.id, to_char(t.transfer_date, 'YYYY-MM-DD') as date_transfert,
     t.amount as montant, 0 as frais,
     t.direction as sens, t.note, c.full_name as saisi_par_nom`,
  ],
};

/** Rend une requete analysable : projections resolues, valeurs remplacees par NULL. */
function instancier(corps, table, fichier, ligne) {
  const variantes = [];
  const unsafe = [...corps.matchAll(/\$\{\s*sql\.unsafe\(([^)]*\)?[^)]*)\)\s*\}/g)];

  let bases = [corps];
  for (const [entier, argument] of unsafe) {
    const cle = argument.trim();
    let valeurs;
    if (table.has(cle)) valeurs = [table.get(cle)];
    else if (PROJECTIONS_CALCULEES[cle]) valeurs = PROJECTIONS_CALCULEES[cle];
    else {
      throw new Error(
        `${fichier}:${ligne} — projection non resolue : sql.unsafe(${cle}). ` +
          "Ajoutez-la au tableau du script, sinon la requete n'est pas verifiee.",
      );
    }
    bases = bases.flatMap((b) => valeurs.map((v) => b.replace(entier, v)));
  }

  for (const base of bases) {
    if (/\$\{[^}]*sql`/.test(base)) {
      throw new Error(`${fichier}:${ligne} — gabarit imbrique, non gere par ce controle.`);
    }
    /* Toute autre valeur interpolee devient NULL : seuls les noms nous interessent. */
    variantes.push(base.replace(/\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "null").trim());
  }
  return variantes;
}

/* --------------------------------------------------------------- execution */

function psql(base, sql, arreterSurErreur = true) {
  const port = process.env.PGPORT_TEST ?? 5433;
  const stop = arreterSurErreur ? "-v ON_ERROR_STOP=1" : "";
  return execFileSync(
    "su",
    ["postgres", "-c", `psql -h /tmp -p ${port} -d ${base} ${stop} -q -f - 2>&1`],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
  );
}

function baseAccessible() {
  try { psql("postgres", "select 1;"); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ marche */

if (!baseAccessible()) {
  console.log(
    "PostgreSQL de test injoignable : controle ignore.\n" +
      "Demarrez-le, puis relancez. Ce controle ne bloque pas les autres.",
  );
  process.exit(0);
}

const BASE = "ip12_requetes";
psql("postgres", `drop database if exists ${BASE};`);
psql("postgres", `create database ${BASE};`);
psql(BASE, readFileSync(join(RACINE, SCHEMA), "utf8"));

/*
 * Les migrations comptent autant que le schema : `late_declarations` et la
 * colonne `fees` n'existent que par elles. Les omettre ferait echouer des
 * requetes parfaitement justes -- et, pire, laisserait croire que le defaut est
 * dans le code alors qu'il serait dans la base.
 */
const migrations = readdirSync("scripts")
  .filter((f) => /^migration-.*\.sql$/.test(f))
  .sort();
for (const m of migrations) psql(BASE, readFileSync(join(RACINE, "scripts", m), "utf8"));

const fichiers = [...sources("src")].sort();
const aVerifier = [];
const echecs = [];

for (const fichier of fichiers) {
  const source = readFileSync(fichier, "utf8");
  const table = constantes(source);
  for (const { corps, ligne } of gabarits(source)) {
    try {
      for (const sql of instancier(corps, table, fichier, ligne)) {
        aVerifier.push({ fichier, ligne, sql });
      }
    } catch (e) {
      echecs.push({ fichier, ligne, raison: e.message, sql: corps.replace(/\s+/g, " ").trim().slice(0, 120) });
    }
  }
}

/*
 * Une seule session psql pour tout le lot : ouvrir un processus par requete
 * prenait plus d'une minute et rendait le controle trop couteux pour etre
 * lance. Chaque requete est precedee d'un repere, et les erreurs signalees
 * ensuite sont rattachees au dernier repere vu.
 */
const lot = aVerifier
  .map((r, i) => `\\echo ---REQUETE-${i}---\nbegin;\nexplain ${r.sql};\nrollback;`)
  .join("\n");
const sortie = psql(BASE, lot, false);

let courante = -1;
for (const ligne of sortie.split("\n")) {
  const repere = ligne.match(/^---REQUETE-(\d+)---$/);
  if (repere) { courante = Number(repere[1]); continue; }
  if (/^psql:[^:]*:\d+: ERROR:/.test(ligne) && courante >= 0) {
    const r = aVerifier[courante];
    echecs.push({
      fichier: r.fichier,
      ligne: r.ligne,
      raison: ligne.replace(/^psql:[^:]*:\d+: /, ""),
      sql: r.sql.replace(/\s+/g, " ").slice(0, 120),
    });
    courante = -1; /* une erreur par requete suffit */
  }
}

const total = aVerifier.length;

psql("postgres", `drop database if exists ${BASE};`);

if (echecs.length > 0) {
  console.error(`\n${echecs.length} requete(s) en echec sur ${total} :\n`);
  for (const e of echecs) {
    console.error(`  ${e.fichier}:${e.ligne}`);
    console.error(`    ${e.raison}`);
    console.error(`    ${e.sql}\n`);
  }
  process.exit(1);
}

console.log(
  `OK - ${total} requetes analysees contre le schema de production, ` +
    `dans ${fichiers.length} fichiers.`,
);
