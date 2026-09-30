/*
 * Rejoue le courrier de relance sur des cas construits, et verifie ce qu'il dit.
 *
 * POURQUOI CE CONTROLE EXISTE. Les fautes de la relance ne sont pas des fautes
 * de calcul : le courrier annoncait quinze penalites de retard puis expliquait
 * ce qui arriverait « a partir de trois » ; il titrait « versement en retard
 * (1 mois) » a qui en devait deux ; il donnait deux totaux de penalites sans
 * dire lequel regler. Aucun compilateur ne voit cela, et `verif.mjs` travaille
 * sur des fonctions pures -- `texteRelance` vit dans un module `server-only`
 * qui parle a la base.
 *
 * Le texte est donc fabrique ici pour de vrai : le source de `relance.ts` est
 * recopie tel quel, ses acces a la base remplaces par des doublures, puis
 * compile. Rien n'est duplique -- une phrase modifiee dans `relance.ts` est
 * relue au controle suivant.
 *
 * Lancement : npm run verif:lettre
 */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RACINE = process.cwd();
const ATELIER = ".lettre";
let controles = 0;
const verifier = (condition, quoi) => {
  controles++;
  assert.ok(condition, quoi);
};

/* ------------------------------------------------------- fabrique du texte */

rmSync(`${RACINE}/${ATELIER}`, { recursive: true, force: true });
rmSync(`${RACINE}/${ATELIER}-js`, { recursive: true, force: true });
mkdirSync(`${RACINE}/${ATELIER}`, { recursive: true });

const source = readFileSync(`${RACINE}/src/lib/relance.ts`, "utf8")
  .replace('import "server-only";\n', "")
  .replace(/from "@\/lib\/(db|queries|courriel)"/g, 'from "./doublures.js"')
  .replace('from "@/lib/settings"', 'from "../src/lib/settings.js"')
  .replace('from "@/lib/penalites"', 'from "../src/lib/penalites.js"');
writeFileSync(`${RACINE}/${ATELIER}/relance.ts`, source);

/* Les doublures ne servent qu'a satisfaire les imports : aucune n'est appelee. */
writeFileSync(`${RACINE}/${ATELIER}/doublures.ts`, `
export type Cellule = {
  mois: string; statut: string; montant: number; requis: number; manque: number;
  dateVersement: string | null;
};
export type SituationClub = {
  membreId: string; nom: string; email: string; role: string; cellules: Cellule[];
  moisEnRetard: string[]; joursDeRetard: number; nbPenalitesImpayees: number;
  totalPenalites: number;
};
export type DetteMembre = { nb: number; montant: number; nbRetard: number; montantRetard: number };
export type AvanceExigee = {
  membreId: string; mois: number; montantExige: number; avanceDetenue: number;
  respectee: boolean; fin: string | null;
};
type Requete = (...a: unknown[]) => Promise<never[]>;
export function db(): Requete { throw new Error("aucune base dans ce controle"); }
export const situationsClub = async (_a?: unknown): Promise<SituationClub[]> => [];
export const avancesExigees = async (_a?: unknown): Promise<AvanceExigee[]> => [];
export const penalitesDuesDetaillees = async () => new Map<string, DetteMembre>();
export const circuitReglementsPret = async () => true;
export const envoyerCourriel = async (_a?: unknown) => ({ ok: true });
export const transportConfigure = () => "aucun" as string;
`);

/* `penalites.ts` importe `./settings` sans extension : ESM en exige une. */
const penalites = `${RACINE}/src/lib/penalites.ts`;
const penalitesOriginal = readFileSync(penalites, "utf8");
writeFileSync(penalites, penalitesOriginal.replace('from "./settings"', 'from "./settings.js"'));
try {
  execFileSync(
    "npx",
    ["tsc", `${ATELIER}/relance.ts`, "--target", "es2022", "--module", "es2022",
      "--moduleResolution", "bundler", "--outDir", `${ATELIER}-js`, "--rootDir", "."],
    { cwd: RACINE, stdio: "inherit" },
  );
} finally {
  writeFileSync(penalites, penalitesOriginal);
}
writeFileSync(`${RACINE}/${ATELIER}-js/package.json`, '{"type":"module"}');
const { texteRelance, sujetRelance } = await import(
  `${RACINE}/${ATELIER}-js/${ATELIER}/relance.js`
);

/* ------------------------------------------------------------------ les cas */

const cellule = (mois, montant, requis) => ({
  mois, statut: montant >= requis ? "paye" : montant > 0 ? "partiel" : "retard",
  montant, requis, manque: Math.max(0, requis - montant), dateVersement: null,
});

/* Le courrier recu le 30/09/2026 : aout et septembre impayes. */
const bourama = {
  situation: {
    membreId: "b", nom: "KONE Bourama", email: "b@ip12.ci", role: "membre",
    cellules: [cellule("2026-08-01", 0, 5000), cellule("2026-09-01", 0, 5000)],
    moisEnRetard: ["2026-08-01", "2026-09-01"],
    joursDeRetard: 51, nbPenalitesImpayees: 1, totalPenalites: 1000,
  },
  arrieres: ["2026-08-01"],
  echeanceDuJour: "2026-09-01",
  dette: { nb: 15, montant: 7500, nbRetard: 15, montantRetard: 7500 },
  avanceManquante: null,
};
const LE_30 = new Date("2026-09-30T08:00:00Z");
const SITE = "https://ip12-alpha.vercel.app";
const lettre = (d, quand = LE_30) => texteRelance(d, SITE, quand);

/* --------------------------------- l'objet compte les mois reellement dus */

verifier(
  sujetRelance(bourama, "2026-09-01", LE_30).includes("(2 mois)"),
  "l'objet doit compter aout ET septembre, non les seuls mois anterieurs",
);

/* ------------------------------------ le seuil R5 se juge sur le registre */

const texteBourama = lettre(bourama);
verifier(
  texteBourama.includes("15 penalites de retard impayees atteignent deja le seuil"),
  "quinze penalites au registre doivent declencher la phrase du seuil atteint",
);
verifier(
  !texteBourama.includes("A partir de 3 penalites"),
  "la phrase reservee a qui est sous le seuil ne doit pas suivre un nombre qui le depasse",
);

const sousLeSeuil = { ...bourama, dette: { nb: 2, montant: 1000, nbRetard: 2, montantRetard: 1000 } };
verifier(
  lettre(sousLeSeuil).includes("A partir de 3 penalites de retard impayees"),
  "sous le seuil, le courrier doit annoncer le seuil a venir",
);

/* Passee la date d'effet, l'exclusion n'est plus annoncee au futur. */
const en2027 = lettre(bourama, new Date("2027-02-01T08:00:00Z"));
verifier(
  en2027.includes("l'exclusion est") && en2027.includes("encourue de plein droit (R5)"),
  "apres la date d'effet, l'exclusion doit etre dite acquise",
);

/* ------------------------------------- un seul total de penalites, jamais deux */

for (const [nom, cas] of [
  ["registre garni", bourama],
  ["registre muet", { ...bourama, dette: { nb: 0, montant: 0, nbRetard: 0, montantRetard: 0 } }],
  ["retards et absences",
   { ...bourama, dette: { nb: 17, montant: 11500, nbRetard: 15, montantRetard: 7500 } }],
]) {
  const texte = lettre(cas);
  const totaux = texte
    .split("\n")
    .filter((l) => /^Penalites? (de retard )?(impayees|dues|en cours)|^Penalite de l'art\. 9/.test(l));
  verifier(
    totaux.length === 1,
    `${nom} : le courrier doit annoncer un seul total de penalites, il en annonce ${totaux.length}`,
  );
}

/* ------------------------- la liste ne promet pas plus qu'elle ne contient */

verifier(
  texteBourama.includes("Mois anterieurs encore manquants"),
  "quand le mois courant est traite a part, la liste doit se dire anterieure",
);
const sansMoisCourant = { ...bourama, echeanceDuJour: null };
verifier(
  lettre(sansMoisCourant).includes("Versements encore manquants"),
  "sans mois courant, la liste porte bien tous les versements manquants",
);

/* ------------------------------------ R2 constate, et nomme le bon retard */

verifier(
  texteBourama.includes("51 jours"),
  "R2 doit nommer le retard du plus ancien mois, que la phrase d'ouverture ne donne pas",
);
verifier(
  texteBourama.includes("le votre l'est donc des a present"),
  "la suspension du vote est acquise quand la phrase parait : elle doit se dire au present",
);
const recent = {
  ...bourama,
  situation: { ...bourama.situation, joursDeRetard: 20, moisEnRetard: ["2026-09-01"] },
};
verifier(!lettre(recent).includes("Rappel R2"), "sous 30 jours, R2 ne doit pas paraitre");

/* ---------------------------------------- le chemin donne mene quelque part */

verifier(
  texteBourama.includes("dans la barre du bas sur telephone"),
  "le mode d'emploi doit decrire la navigation actuelle",
);

/*
 * Le courrier reclamait des penalites et n'expliquait que la declaration d'une
 * cotisation -- « indiquez le mois couvert », qu'une penalite n'a pas. Qui
 * payait ses penalites n'avait rien a toucher.
 */
verifier(
  texteBourama.includes("COMMENT ENREGISTRER LE REGLEMENT D'UNE PENALITE"),
  "des que le courrier reclame des penalites, il doit dire comment les declarer",
);
verifier(
  texteBourama.includes("La penalite reste due jusqu'a cette verification"),
  "le courrier doit prevenir qu'une relance peut encore reclamer ce qui est declare",
);
const sansDette = { ...bourama, dette: { nb: 0, montant: 0, nbRetard: 0, montantRetard: 0 } };
verifier(
  !lettre(sansDette).includes("COMMENT ENREGISTRER LE REGLEMENT D'UNE PENALITE"),
  "sans penalite reclamee, ce chemin n'a pas a encombrer le courrier",
);
/*
 * La migration qui cree la table s'execute a la main : entre la mise en ligne et
 * ce geste, le courrier ne doit pas envoyer chercher un bouton absent.
 */
verifier(
  !texteRelance(bourama, SITE, LE_30, false).includes("Declarer un reglement"),
  "circuit absent : le courrier ne doit pas donner une consigne qui ne mene nulle part",
);
verifier(
  texteRelance(bourama, SITE, LE_30, false).includes("Penalites de retard impayees : 15"),
  "circuit absent ou non, la dette s'annonce",
);

rmSync(`${RACINE}/${ATELIER}`, { recursive: true, force: true });
rmSync(`${RACINE}/${ATELIER}-js`, { recursive: true, force: true });
console.log(
  `OK - ${controles} controles du courrier de relance : objet, seuil R5, ` +
    "total unique des penalites, liste des mois, R2, mode d'emploi des cotisations " +
    "et des penalites",
);
