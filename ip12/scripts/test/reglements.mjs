/*
 * Rejoue pour de vrai le reglement d'une penalite, contre un PostgreSQL portant
 * le schema de production et ses migrations.
 *
 * POURQUOI CELUI-CI EXECUTE, LA OU `requetes.mjs` SE CONTENTE D'ANALYSER.
 *
 * `requetes.mjs` passe chaque requete par EXPLAIN : il attrape une colonne
 * renommee, jamais un resultat faux. Or ce chemin-ci touche a l'argent et se
 * joue en plusieurs ecritures enchainees -- une ligne scindee, une quantite
 * decrementee, un statut bascule. Une faute n'y produit pas une erreur : elle
 * produit une dette fausse, qu'on ne decouvre qu'au moment ou un membre conteste.
 *
 * Les actions ne sont pas reecrites ici : leur source est recopiee telle quelle,
 * ses acces au reseau (session, courriel, journal) remplaces par des doublures,
 * et la base remplacee par le PostgreSQL local. Ce qui est verifie est donc le
 * code qui tourne en production, pas une imitation.
 *
 * Lancement : npm run verif:reglements
 */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const RACINE = process.cwd();
const BASE = "ip12_reglements";
const ATELIER = ".reglements";
let controles = 0;
const verifier = (condition, quoi) => {
  controles++;
  assert.ok(condition, quoi);
};
const egal = (obtenu, attendu, quoi) => {
  controles++;
  assert.equal(obtenu, attendu, `${quoi} — attendu ${attendu}, obtenu ${obtenu}`);
};

/* --------------------------------------------------------------- la base */

function psql(base, sql, arreterSurErreur = true) {
  const port = process.env.PGPORT_TEST ?? 5433;
  const stop = arreterSurErreur ? "-v ON_ERROR_STOP=1" : "";
  try {
    return execFileSync(
      "su",
      ["postgres", "-c", `psql -h /tmp -p ${port} -d ${base} ${stop} -q -t -A -f - 2>&1`],
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (e) {
    /*
     * LE MESSAGE DE POSTGRES, NON CELUI DE L'INTERPRETEUR.
     *
     * `execFileSync` leve « Command failed: su postgres -c psql ... », ou le nom
     * de la contrainte violee n'apparait pas -- il est sur la sortie. Le code
     * verifie, lui, reconnait un conflit d'unicite a ce nom, comme le fait le
     * pilote Neon en production. Sans cette reprise, le controle mesurerait une
     * particularite de son propre outillage.
     */
    throw new Error(String(e.stdout ?? "") || String(e.message));
  }
}

try {
  psql("postgres", "select 1;");
} catch {
  console.log(
    "PostgreSQL de test injoignable : controle ignore.\n" +
      "Demarrez-le, puis relancez. Ce controle ne bloque pas les autres.",
  );
  process.exit(0);
}

psql("postgres", `drop database if exists ${BASE};`);
psql("postgres", `create database ${BASE};`);
psql(BASE, readFileSync(join(RACINE, "scripts/test/schema-local.sql"), "utf8"));
for (const m of readdirSync("scripts").filter((f) => /^migration-.*\.sql$/.test(f)).sort()) {
  psql(BASE, readFileSync(join(RACINE, "scripts", m), "utf8"));
}

/* ------------------------------------------------- la doublure de `db()` */

/**
 * Traduit un gabarit `sql`...`` en une requete litterale, executee par psql.
 *
 * Les valeurs sont celles de ce controle, connues et maitrisees ; elles sont
 * malgre tout echappees, pour qu'une apostrophe dans un motif ne casse pas le
 * controle et ne se fasse passer pour un defaut du code.
 */
function litteral(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function requete(morceaux, ...valeurs) {
  let sql = "";
  morceaux.forEach((m, i) => {
    sql += m;
    if (i < valeurs.length) sql += litteral(valeurs[i]);
  });
  const texte = sql.trim().replace(/;$/, "");
  const lecture = /^(select|with)/i.test(texte);
  const rendDesLignes = lecture || /returning/i.test(texte);
  /*
   * Une ecriture avec RETURNING ne s'imbrique pas dans un FROM : Postgres ne
   * l'accepte que comme expression de tete d'un WITH. Deux enveloppes, donc.
   */
  const enveloppe = !rendDesLignes
    ? `${texte};`
    : lecture
      ? `select coalesce(json_agg(t), '[]'::json)::text from (${texte}) t;`
      : `with t as (${texte}) select coalesce(json_agg(t), '[]'::json)::text from t;`;
  const sortie = psql(BASE, enveloppe).trim();
  if (/^psql:/m.test(sortie)) throw new Error(sortie);
  if (!rendDesLignes) return Promise.resolve([]);
  return Promise.resolve(JSON.parse(sortie || "[]"));
}

/* ------------------------------------------------- les actions, telles quelles */

rmSync(`${RACINE}/${ATELIER}`, { recursive: true, force: true });
rmSync(`${RACINE}/${ATELIER}-js`, { recursive: true, force: true });
mkdirSync(`${RACINE}/${ATELIER}`, { recursive: true });

/** Memes substitutions pour tout module recopie : un seul jeu de regles. */
const brancher = (texte) =>
  texte
    .replace('import "server-only";\n', "")
    .replace('"use server";\n', "")
    .replace(/from "next\/cache"/g, 'from "./doublures.js"')
    .replace(
      /from "@\/lib\/(db|auth|journal|avis|justificatifs|queries|droits)"/g,
      'from "./doublures.js"',
    )
    .replace(/from "@\/lib\/constat"/g, 'from "./constat.js"')
    .replace(/from "@\/lib\/settings"/g, 'from "../src/lib/settings.js"')
    .replace(/from "@\/lib\/penalites"/g, 'from "../src/lib/penalites.js"')
    .replace(/from "@\/lib\/valeurs"/g, 'from "../src/lib/valeurs.js"')
    .replace(/from "\.\/auth"/g, 'from "./doublures.js"');

writeFileSync(
  `${RACINE}/${ATELIER}/penalites.ts`,
  brancher(readFileSync(`${RACINE}/src/app/actions/penalites.ts`, "utf8")),
);
/* Le constat vit dans sa propre bibliotheque depuis qu'il sert aussi la relance. */
writeFileSync(
  `${RACINE}/${ATELIER}/constat.ts`,
  brancher(readFileSync(`${RACINE}/src/lib/constat.ts`, "utf8")),
);
/*
 * Le plafond des demandes de reinitialisation : un chemin ouvert SANS CONNEXION,
 * qui ecrit au president. Ce qui le borne doit etre verifie en base, et non sur
 * la foi d'une requete relue.
 */
writeFileSync(
  `${RACINE}/${ATELIER}/tentatives.ts`,
  brancher(readFileSync(`${RACINE}/src/lib/tentatives.ts`, "utf8")).replace(
    /from "\.\/db"/g,
    'from "./doublures.js"',
  ),
);

writeFileSync(`${RACINE}/${ATELIER}/doublures.ts`, `
export type EtatFormulaire = { ok: boolean; message?: string; erreur?: string };
export type Acteur = { id: string; nom: string };
/* Qui agit : le controle en change entre deux appels. */
export const session: { acteur: Acteur } = { acteur: { id: "", nom: "" } };
type Requete = (
  morceaux: TemplateStringsArray,
  ...valeurs: unknown[]
) => Promise<Record<string, unknown>[]>;
export const db = (): Requete => (globalThis as unknown as { __sql: Requete }).__sql;
export const exigerMembre = async (): Promise<Acteur> => session.acteur;
export const exigerDroit = async (_d?: unknown): Promise<Acteur> => session.acteur;
export const journaliser = async (..._a: unknown[]) => {};
export const revalidatePath = (..._a: unknown[]) => {};
export const avertirReglementPenalite = async (..._a: unknown[]) => 0;
export const enregistrerJustificatif = async (..._a: unknown[]) => ({ joint: false });
/*
 * Les lectures qui n'alimentent que le constat, hors du chemin verifie ici :
 * typees au plus large, faute de quoi il faudrait recopier tout le modele de
 * donnees pour compiler un code que ce controle n'execute pas.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const absencesParMembre = async (): Promise<any[]> => [];
/*
 * La borne de reprise, posee par le controle. Sa DERIVATION (les lignes
 * 'reprise_penalites:%' du registre) est une requete a part, verifiee par
 * ailleurs ; ce qui se joue ici est la regle : un mois couvert par la reprise du
 * tresorier n'est jamais recompte.
 */
export const bornes: Map<string, string> = new Map();
export const bornesReprisePenalites = async () => bornes;
export const reglagesEffectifs = async () => ({
  cotisationMensuelle: 5000, tauxPenalite: 0.1,
  penaliteAbsence: 2000, absencesParTranche: 3,
});
/* Ce que le controle veut faire lire au constat : il le pose avant d'appeler. */
export const donnees: { situations: any[] } = { situations: [] };
export const situationsClub = async (): Promise<any[]> => donnees.situations;
export const listerMembres = async (): Promise<any[]> => [];
/*
 * Le registre, lu pour de vrai. Seules les quatre colonnes dont le rapprochement
 * se sert sont projetees ici ; la requete de production, plus large, a ses noms
 * verifies par le controle des requetes.
 */
export const listerPenalites = async (_f?: unknown): Promise<any[]> => {
  const sql = db();
  return (await sql\`
    select member_id as membre_id, kind as nature,
           to_char(incurred_on, 'YYYY-MM-DD') as date_constat, source_key
    from penalties
  \`) as any[];
};
/*
 * Reduite au droit dont le constat se sert. Le choix du signataire n'est donc
 * pas ce que ce controle mesure : il verifie ce que le constat ECRIT, sur des
 * situations posees a la main.
 */
export const DROITS = { gererPenalites: ["tresorier", "president"] } as const;
`);

const penalitesTs = `${RACINE}/src/lib/penalites.ts`;
const original = readFileSync(penalitesTs, "utf8");
writeFileSync(penalitesTs, original.replace('from "./settings"', 'from "./settings.js"'));
try {
  execFileSync(
    "npx",
    ["tsc", `${ATELIER}/penalites.ts`, `${ATELIER}/constat.ts`, `${ATELIER}/tentatives.ts`,
      "--target", "es2022", "--module", "es2022",
      "--moduleResolution", "bundler", "--strict", "--outDir", `${ATELIER}-js`,
      "--rootDir", "."],
    { cwd: RACINE, stdio: "inherit" },
  );
} finally {
  writeFileSync(penalitesTs, original);
}
writeFileSync(`${RACINE}/${ATELIER}-js/package.json`, '{"type":"module"}');
globalThis.__sql = requete;
const actions = await import(`${RACINE}/${ATELIER}-js/${ATELIER}/penalites.js`);
const constat = await import(`${RACINE}/${ATELIER}-js/${ATELIER}/constat.js`);
const auth = await import(`${RACINE}/${ATELIER}-js/${ATELIER}/tentatives.js`);
const { session, donnees, bornes } = await import(
  `${RACINE}/${ATELIER}-js/${ATELIER}/doublures.js`,
);

/* ------------------------------------------------------------- les acteurs */

const uns = (sql) => psql(BASE, sql).trim().split("\n")[0];
const membre = {
  id: uns(`insert into members (full_name, email, role, password_hash, joined_on)
           values ('KONE Bourama','b@ip12.ci','membre','x',current_date) returning id;`),
  nom: "KONE Bourama",
};
const tresorier = {
  id: uns(`insert into members (full_name, email, role, password_hash, joined_on)
           values ('Tresorier','t@ip12.ci','tresorier','x',current_date) returning id;`),
  nom: "Tresorier",
};

const formulaire = (champs) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, String(v));
  return f;
};
const nouvellePenalite = (quantite, unitaire = 500, qui = membre.id) =>
  uns(`insert into penalties (member_id, kind, quantity, unit_amount, status, created_by)
       values ('${qui}','retard',${quantite},${unitaire},'due','${tresorier.id}') returning id;`);
const lire = (sql) => uns(sql);
const AUJOURDHUI = new Date().toISOString().slice(0, 10);

/* =================================================== 1. declaration partielle */

const ligne = nouvellePenalite(15);
session.acteur = membre;
/*
 * Le membre ne choisit plus la ligne : il declare un montant, qui s'impute de
 * la plus ancienne a la plus recente, en unites entieres. 2 000 FCFA font ici
 * quatre penalites de 500 sur la seule ligne due.
 */
let r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 2000, datePaiement: AUJOURDHUI, mode: "mobile_money" }),
);
verifier(r.ok, `la declaration doit passer : ${r.erreur ?? ""}`);

/*
 * LA PENALITE NE BOUGE PAS. C'est tout l'objet du circuit : rien n'entre en
 * caisse sur parole, et la dette que la relance annonce ne baisse pas d'un
 * franc tant que le tresorier ne s'est pas prononce.
 */
egal(lire(`select quantity from penalties where id='${ligne}';`), "15",
  "la ligne doit rester entiere tant que rien n'est valide");
egal(lire(`select status from penalties where id='${ligne}';`), "due",
  "la ligne doit rester due tant que rien n'est valide");
egal(lire(`select coalesce(sum(quantity),0) from penalties
           where member_id='${membre.id}' and status='due' and kind='retard';`), "15",
  "le compte qui decide du seuil R5 ne doit pas bouger sur une declaration");
egal(lire(`select status from penalty_settlements where penalty_id='${ligne}';`), "en_attente",
  "la declaration doit etre inscrite en attente");

/* ------------------------------ une seule declaration en attente par ligne */

r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 1000, datePaiement: AUJOURDHUI, mode: "especes" }),
);
verifier(!r.ok && /deja une declaration en attente/.test(r.erreur ?? ""),
  "une ligne deja declaree est enjambee, et s'il n'en reste pas d'autre le refus le dit");

/* ------------------------------------- personne ne declare pour un autre */

r = await actions.declarerReglementPenalite(
  {},
  formulaire({ membreId: tresorier.id, montant: 500, datePaiement: AUJOURDHUI, mode: "especes" }),
);
verifier(!r.ok && /que pour soi/.test(r.erreur ?? ""),
  "un membre ne doit pas pouvoir declarer le reglement d'un autre");

/* ----------------------------------------- ni une quantite hors de la ligne */

const ligneCourte = nouvellePenalite(2);
/*
 * La premiere ligne porte une attente et est enjambee ; la seconde ne compte
 * que deux penalites. 1 500 n'y entrent pas : 1 000 seulement s'imputent, et
 * la difference serait encaissee sans etre portee nulle part.
 */
r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 1500, datePaiement: AUJOURDHUI, mode: "especes" }),
);
verifier(!r.ok && /se regle entiere/.test(r.erreur ?? ""),
  "declarer plus que ce qui peut s'imputer doit etre refuse, en nommant la part declarable");

r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 500, datePaiement: "2099-01-01", mode: "especes" }),
);
verifier(!r.ok && /futur/.test(r.erreur ?? ""), "une date de paiement future doit etre refusee");

/* ==================================================== 2. validation partielle */

const declaration = lire(`select id from penalty_settlements
                          where penalty_id='${ligne}' and status='en_attente';`);
session.acteur = tresorier;
r = await actions.validerReglementPenalite({}, formulaire({ id: declaration }));
verifier(r.ok, `la validation doit passer : ${r.erreur ?? ""}`);

/*
 * La ligne est SCINDEE, non amputee : quatre partent soldes, onze restent dus.
 * Le total du club tombe juste sans qu'aucune colonne ait a etre ajoutee.
 */
egal(lire(`select quantity from penalties where id='${ligne}';`), "11",
  "la ligne d'origine doit conserver ce qui reste dû");
egal(lire(`select status from penalties where id='${ligne}';`), "due",
  "ce qui reste dû reste dû");
egal(lire(`select count(*) from penalties
           where member_id='${membre.id}' and status='payee' and quantity=4;`), "1",
  "la part reglee doit exister comme ligne soldee");
egal(lire(`select coalesce(sum(quantity),0) from penalties
           where member_id='${membre.id}' and status='due' and kind='retard';`), "13",
  "le compte du seuil R5 doit tomber a 11 sur cette ligne, plus les 2 de l'autre");
egal(lire(`select coalesce(sum(quantity*unit_amount),0) from penalties
           where member_id='${membre.id}' and status='payee';`), "2000",
  "la caisse doit voir 4 × 500 encaisses, et rien de plus");
egal(lire(`select status from penalty_settlements where id='${declaration}';`), "validee",
  "la declaration doit etre marquee validee");

/* ------------------------------- la meme declaration ne se valide pas deux fois */

r = await actions.validerReglementPenalite({}, formulaire({ id: declaration }));
verifier(!r.ok, "une declaration deja examinee ne doit pas pouvoir etre validee a nouveau");

/* ============================================== 3. personne ne se valide soi-meme */

const sienne = nouvellePenalite(1, 500, tresorier.id);
r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 500, datePaiement: AUJOURDHUI, mode: "especes" }),
);
verifier(r.ok, `le tresorier doit pouvoir declarer pour lui-meme : ${r.erreur ?? ""}`);
const laSienne = lire(`select id from penalty_settlements where penalty_id='${sienne}';`);
r = await actions.validerReglementPenalite({}, formulaire({ id: laSienne }));
verifier(!r.ok && /votre propre declaration/.test(r.erreur ?? ""),
  "nul ne valide sa propre declaration, fut-il tresorier");
egal(lire(`select status from penalties where id='${sienne}';`), "due",
  "la penalite du tresorier reste due tant que le president n'a pas tranche");

/* ========================================================= 4. le refus */

/*
 * Onze penalites restent sur la ligne d'origine, et deux sur la ligne courte,
 * constatees le meme jour. La premiere inscrite passe la premiere : 5 500
 * soldent les onze de la ligne d'origine, et seulement elles.
 */
session.acteur = membre;
r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 5500, datePaiement: AUJOURDHUI, mode: "virement" }),
);
verifier(r.ok, `declarer le solde entier doit passer : ${r.erreur ?? ""}`);
egal(lire(`select count(*) from penalty_settlements
           where penalty_id='${ligneCourte}' and status='en_attente';`), "0",
  "a date de constat egale, la premiere inscrite est reglee la premiere");
const aRefuser = lire(`select id from penalty_settlements
                       where penalty_id='${ligne}' and status='en_attente';`);
session.acteur = tresorier;
r = await actions.rejeterReglementPenalite({}, formulaire({ id: aRefuser, motif: "aucun transfert recu" }));
verifier(r.ok, `le refus doit passer : ${r.erreur ?? ""}`);
egal(lire(`select quantity from penalties where id='${ligne}';`), "11",
  "un refus ne touche pas a la penalite");
egal(lire(`select status from penalties where id='${ligne}';`), "due",
  "apres un refus, la penalite reste due");
egal(lire(`select review_note from penalty_settlements where id='${aRefuser}';`),
  "aucun transfert recu", "le motif du refus doit etre conserve pour le membre");

/* ------------------- et la ligne redevient declarable apres l'examen */

session.acteur = membre;
r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 5500, datePaiement: AUJOURDHUI, mode: "virement" }),
);
verifier(r.ok, "une ligne examinee doit pouvoir etre declaree a nouveau");

/* ================================================ 5. solde total de la ligne */

const derniere = lire(`select id from penalty_settlements
                       where penalty_id='${ligne}' and status='en_attente';`);
session.acteur = tresorier;
r = await actions.validerReglementPenalite({}, formulaire({ id: derniere }));
verifier(r.ok, `le solde entier doit passer : ${r.erreur ?? ""}`);
egal(lire(`select status from penalties where id='${ligne}';`), "payee",
  "declaration sans quantite : la ligne entiere doit etre soldee");
egal(lire(`select quantity from penalties where id='${ligne}';`), "11",
  "une ligne soldee en entier n'est pas scindee : sa quantite est intacte");
egal(lire(`select coalesce(sum(quantity*unit_amount),0) from penalties
           where member_id='${membre.id}' and status='payee';`), "7500",
  "les 15 penalites de 500 doivent avoir rapporte 7 500 FCFA, ni plus ni moins");
egal(lire(`select coalesce(sum(quantity),0) from penalties
           where member_id='${membre.id}' and status='due' and kind='retard';`), "2",
  "ne doivent rester dues que les 2 de la ligne restee intacte");

/* ========================= 5 bis. un versement, un geste du tresorier */

/*
 * Un versement reparti sur plusieurs penalites ecrit une declaration par
 * ligne, reliees par leur lot. Le tresorier les validait une a une : trois
 * gestes pour un transfert, et le risque d'en laisser une en attente. Il
 * valide ou refuse desormais le lot entier.
 *
 * Un membre a part, pour ne rien deranger des comptes qui precedent.
 */
const autre = {
  id: uns(`insert into members (full_name, email, role, password_hash, joined_on)
           values ('DIALLO Awa','a@ip12.ci','membre','x',current_date) returning id;`),
  nom: "DIALLO Awa",
};
const ancienne = nouvellePenalite(2, 500, autre.id);
const recente = nouvellePenalite(1, 1000, autre.id);
session.acteur = autre;
r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 2000, datePaiement: AUJOURDHUI, mode: "mobile_money" }),
);
verifier(r.ok, `un versement sur deux lignes doit passer : ${r.erreur ?? ""}`);
const lotAwa = lire(`select batch_id from penalty_settlements where penalty_id='${ancienne}';`);
egal(lire(`select count(*) from penalty_settlements where batch_id='${lotAwa}';`), "2",
  "deux lignes reglees d'un seul versement : deux declarations, un seul lot");

// Le tresorier valide le lot : les deux lignes sont soldees d'un geste.
session.acteur = tresorier;
r = await actions.validerReglementPenalite({}, formulaire({ lot: lotAwa }));
verifier(r.ok, `la validation du lot doit passer : ${r.erreur ?? ""}`);
egal(lire(`select status from penalties where id='${ancienne}';`), "payee",
  "la premiere ligne du lot est soldee");
egal(lire(`select status from penalties where id='${recente}';`), "payee",
  "la seconde aussi, du meme geste");
egal(lire(`select count(*) from penalty_settlements
           where batch_id='${lotAwa}' and status='validee';`), "2",
  "et les deux declarations sont marquees validees");
r = await actions.validerReglementPenalite({}, formulaire({ lot: lotAwa }));
verifier(!r.ok, "un lot deja examine ne se valide pas une seconde fois");

// Un transfert non recu l'est pour toutes les lignes qu'il pretendait regler.
const l1 = nouvellePenalite(1, 500, autre.id);
const l2 = nouvellePenalite(1, 500, autre.id);
session.acteur = autre;
r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 1000, datePaiement: AUJOURDHUI, mode: "especes" }),
);
verifier(r.ok, `le second versement doit passer : ${r.erreur ?? ""}`);
const lotRefuse = lire(`select batch_id from penalty_settlements where penalty_id='${l1}';`);
session.acteur = tresorier;
r = await actions.rejeterReglementPenalite({}, formulaire({ lot: lotRefuse, motif: "rien recu" }));
verifier(r.ok, `le refus du lot doit passer : ${r.erreur ?? ""}`);
egal(lire(`select count(*) from penalty_settlements
           where batch_id='${lotRefuse}' and status='rejetee' and review_note='rien recu';`), "2",
  "le refus porte sur tout le lot, motif compris");
egal(lire(`select count(*) from penalties
           where id in ('${l1}','${l2}') and status='due';`), "2",
  "et les deux penalites restent dues");

// Nul ne valide son propre lot, fut-il tresorier.
const t1 = nouvellePenalite(1, 500, tresorier.id);
nouvellePenalite(1, 500, tresorier.id);
session.acteur = tresorier;
r = await actions.declarerReglementPenalite(
  {},
  formulaire({ montant: 1000, datePaiement: AUJOURDHUI, mode: "especes" }),
);
verifier(r.ok, `le tresorier declare pour lui-meme : ${r.erreur ?? ""}`);
const lotTresorier = lire(`select batch_id from penalty_settlements
                           where penalty_id='${t1}' and status='en_attente';`);
r = await actions.validerReglementPenalite({}, formulaire({ lot: lotTresorier }));
verifier(!r.ok && /votre propre declaration/.test(r.erreur ?? ""),
  "un lot declare par le tresorier ne se valide pas par lui");
egal(lire(`select count(*) from penalty_settlements
           where batch_id='${lotTresorier}' and status='en_attente';`), "2",
  "aucune de ses lignes n'est touchee : le lot se refuse en entier");

/* ============================ 6. le constat, desormais automatique */

/*
 * POURQUOI CE CONSTAT EST VERIFIE ICI.
 *
 * Il n'avait qu'un appelant, le bouton de la page Penalites : le registre
 * n'avancait que quand le bureau y pensait, alors que l'art. 9 court de plein
 * droit. Le seuil de R5 ne comptant que les penalites INSCRITES, l'oubli du clic
 * protegeait d'une regle votee. La relance l'appelle donc avant d'ecrire ses
 * courriers -- une ecriture automatique dans un livre de comptes, qui doit etre
 * exacte et rejouable.
 */
const seul = uns(`insert into members (full_name, email, role, password_hash, joined_on)
                  values ('Membre Neuf','n@ip12.ci','membre','x',current_date) returning id;`);

/* Deux mois impayes, a 500 FCFA de penalite chacun. */
donnees.situations = [
  {
    membreId: seul,
    penalites: [
      { mois: "2026-08-01", montant: 500, doublee: false, figee: false },
      { mois: "2026-09-01", montant: 500, doublee: false, figee: false },
    ],
  },
];

let issue = await constat.porterRetardsAuRegistre(tresorier.id);
egal(issue.creees, 2, "les deux mois doivent etre portes au registre");
egal(lire(`select coalesce(sum(quantity*unit_amount),0) from penalties
           where member_id='${seul}' and status='due';`), "1000",
  "le registre doit porter 1 000 FCFA apres le constat");

/* ------------------------------------------- rejouable, et non repetitif */

issue = await constat.porterRetardsAuRegistre(tresorier.id);
egal(issue.creees, 0, "un second constat ne doit rien recreer");
egal(lire(`select count(*) from penalties where member_id='${seul}';`), "2",
  "le registre ne doit pas doubler a chaque passage de la relance");

/* ------------------------------- R4 : le montant se reajuste, la ligne reste */

donnees.situations[0].penalites[0].montant = 1000;
issue = await constat.porterRetardsAuRegistre(tresorier.id);
egal(issue.reajustees, 1, "un montant double par R4 doit etre reajuste");
egal(lire(`select count(*) from penalties where member_id='${seul}';`), "2",
  "le reajustement corrige la ligne, il n'en cree pas une seconde");
egal(lire(`select coalesce(sum(quantity*unit_amount),0) from penalties
           where member_id='${seul}' and status='due';`), "1500",
  "le total doit suivre le doublement de R4");

/* ------------------------- une penalite reglee n'est jamais ressuscitee */

const aout = lire(`select id from penalties
                   where member_id='${seul}' and incurred_on='2026-08-10';`);
psql(BASE, `update penalties set status='payee', settled_on=current_date where id='${aout}';`);
donnees.situations[0].penalites[0].montant = 500;
issue = await constat.porterRetardsAuRegistre(tresorier.id);
egal(issue.intactes, 1, "une ligne soldee doit etre comptee intacte");
egal(lire(`select status from penalties where id='${aout}';`), "payee",
  "le constat ne doit pas remettre en du ce qui a ete regle");
egal(lire(`select count(*) from penalties where member_id='${seul}';`), "2",
  "ni recreer a cote une penalite pour le meme mois");

/* --------------------- la borne de reprise du tresorier est respectee */

const reprise = uns(`insert into members (full_name, email, role, password_hash, joined_on)
                     values ('Membre Reprise','r@ip12.ci','membre','x',current_date) returning id;`);
psql(BASE, `insert into penalties (member_id, kind, quantity, unit_amount, status,
              created_by, incurred_on, source_key)
            values ('${reprise}','retard',10,500,'due','${tresorier.id}',
                    '2026-06-10','reprise_penalites:${reprise}');`);
bornes.set(reprise, "2026-06-01");
donnees.situations = [
  {
    membreId: reprise,
    penalites: [
      { mois: "2026-05-01", montant: 500, doublee: false, figee: false },
      { mois: "2026-09-01", montant: 500, doublee: false, figee: false },
    ],
  },
];
issue = await constat.porterRetardsAuRegistre(tresorier.id);
egal(issue.couvertes, 1, "un mois anterieur a la borne releve de la reprise, non du constat");
egal(issue.creees, 1, "le mois posterieur a la borne, lui, doit etre porte");
egal(lire(`select coalesce(sum(quantity),0) from penalties
           where member_id='${reprise}' and status='due';`), "11",
  "10 de reprise plus 1 constate : jamais le mois deja compte dans la reprise");

/* ============ 7. ce qui court sans etre inscrit, vu par les trois ecrans */

/*
 * Le courrier de relance, le recapitulatif du bureau et la page « Mon compte »
 * annoncent la meme somme : la dette inscrite plus ce qui court. Ils lisent tous
 * `penalitesNonInscrites`, et c'est cette lecture qui doit tomber juste -- trois
 * calculs separes avaient deja donne trois chiffres differents.
 */
const vierge = uns(`insert into members (full_name, email, role, password_hash, joined_on)
                    values ('Membre Vierge','v@ip12.ci','membre','x',current_date) returning id;`);
bornes.clear();
const situationVierge = [
  {
    membreId: vierge,
    penalites: [
      { mois: "2026-08-01", montant: 500, doublee: false, figee: false },
      { mois: "2026-09-01", montant: 500, doublee: false, figee: false },
    ],
  },
];

let courues = await constat.penalitesNonInscrites(situationVierge);
egal(courues.get(vierge).montant, 1000,
  "registre vide : les deux mois courent et ne sont pas inscrits");
egal(courues.get(vierge).nb, 2, "deux mois, donc deux penalites qui courent");

/* Apres le constat, plus rien ne court : tout est au registre. */
donnees.situations = situationVierge;
await constat.porterRetardsAuRegistre(tresorier.id);
courues = await constat.penalitesNonInscrites(situationVierge);
egal(courues.get(vierge).montant, 0,
  "apres le constat, rien ne court plus : sinon le courrier compterait deux fois");

/*
 * C'EST LA LE GARDE-FOU DU DOUBLE COMPTE. La dette inscrite vaut desormais
 * 1 000 ; si `penalitesNonInscrites` rendait encore 1 000, le courrier
 * annoncerait un total de 2 000 pour une dette de 1 000.
 */
egal(lire(`select coalesce(sum(quantity*unit_amount),0) from penalties
           where member_id='${vierge}' and status='due';`), "1000",
  "le registre porte exactement ce qui courait");

/* Une penalite reglee ne se remet pas a courir. */
psql(BASE, `update penalties set status='payee', settled_on=current_date
            where member_id='${vierge}';`);
courues = await constat.penalitesNonInscrites(situationVierge);
egal(courues.get(vierge).montant, 0,
  "une penalite reglee reste inscrite : elle ne doit pas se remettre a courir");

/* ========== 8. le plafond des demandes de reinitialisation ============== */

/*
 * POURQUOI CELUI-CI EST VERIFIE EN BASE.
 *
 * « Mot de passe oublie ? » est le seul chemin du site ouvert SANS CONNEXION
 * qui declenche un courriel. Ce qui le borne n'est donc pas un confort : sans
 * plafond, n'importe qui connaissant l'adresse du site inonde le president.
 *
 * Le compte est tenu dans `login_attempts`, sous une cle prefixee. Deux choses
 * doivent tenir, et aucune ne se lit dans le code : que le plafond morde, et
 * qu'il ne se melange pas aux echecs de connexion -- sans quoi il bloquerait le
 * membre qui vient justement d'oublier son mot de passe.
 */
const QUI = "oubli@ip12.ci";

egal(await auth.tropDeDemandes(QUI), false, "aucune demande : rien ne bloque");

await auth.tracerDemande(QUI);
await auth.tracerDemande(QUI);
egal(await auth.tropDeDemandes(QUI), false, "deux demandes restent sous le plafond");

await auth.tracerDemande(QUI);
egal(await auth.tropDeDemandes(QUI), true, "la troisieme ferme le robinet");

/* La cle est prefixee : la demande ne compte pas comme un echec de connexion. */
egal(
  lire(`select count(*) from login_attempts where lower(email) = '${QUI}';`),
  "0",
  "une demande ne s'inscrit pas sous l'adresse nue",
);
egal(
  lire(`select count(*) from login_attempts where lower(email) = 'reinit:${QUI}';`),
  "3",
  "elle s'inscrit sous sa propre cle",
);
egal(await auth.tropDeTentatives(QUI), false,
  "et le membre bloque en demandes peut toujours tenter de se connecter");

/*
 * L'inverse aussi : huit echecs de connexion bloquent la connexion, pas la
 * demande -- c'est precisement a ce moment qu'on veut pouvoir la faire.
 */
const AUTRE = "bloque@ip12.ci";
for (let i = 0; i < 8; i++) await auth.tracerTentative(AUTRE, false);
egal(await auth.tropDeTentatives(AUTRE), true, "huit echecs bloquent la connexion");
egal(await auth.tropDeDemandes(AUTRE), false,
  "mais pas la demande de reinitialisation : c'est alors qu'elle sert");

rmSync(`${RACINE}/${ATELIER}`, { recursive: true, force: true });
rmSync(`${RACINE}/${ATELIER}-js`, { recursive: true, force: true });
psql("postgres", `drop database if exists ${BASE};`);
console.log(
  `OK - ${controles} controles du reglement declare, executes sur PostgreSQL : ` +
    "declaration sans effet sur la dette, unicite de l'attente, quantites, " +
    "scission a la validation, refus, solde total, constat rejouable, R4, " +
    "lignes soldees intactes, borne de reprise, ce qui court sans etre inscrit, " +
    "plafond des demandes de reinitialisation",
);
