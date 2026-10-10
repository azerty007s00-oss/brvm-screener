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
  .replace(/from "@\/lib\/(db|queries|courriel|constat)"/g, 'from "./doublures.js"')
  .replace('from "@/lib/settings"', 'from "../src/lib/settings.js"')
  .replace('from "@/lib/penalites"', 'from "../src/lib/penalites.js"');
writeFileSync(`${RACINE}/${ATELIER}/relance.ts`, source);

/*
 * `courriel.ts` porte le rendu HTML du courrier. Il est recopie et compile avec
 * le reste : ce qui est verifie est le texte ET la forme sous laquelle il part.
 */
writeFileSync(
  `${RACINE}/${ATELIER}/courriel.ts`,
  readFileSync(`${RACINE}/src/lib/courriel.ts`, "utf8")
    .replace('import "server-only";\n', "")
    .replace(/from "@\/lib\/(settings)"/g, 'from "../src/lib/$1.js"')
    .replace(/from "@\/lib\/(version|queries|db)"/g, 'from "./doublures.js"')
    .replace("function enHtml(", "export function enHtml("),
);

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
  penalites: { mois: string; montant: number; doublee: boolean; figee: boolean }[];
};
export type DetteMembre = { nb: number; montant: number; nbRetard: number; montantRetard: number };
export type AvanceExigee = {
  membreId: string; mois: number; montantExige: number; avanceDetenue: number;
  respectee: boolean; auSeuil: boolean; pourMaintenir: number; fin: string | null;
  moisRequis: number; moisRestants: number | null;
};
type Requete = (...a: unknown[]) => Promise<never[]>;
export function db(): Requete { throw new Error("aucune base dans ce controle"); }
export const situationsClub = async (_a?: unknown): Promise<SituationClub[]> => [];
export const avancesExigees = async (_a?: unknown): Promise<AvanceExigee[]> => [];
export const penalitesDuesDetaillees = async () => new Map<string, DetteMembre>();
export const circuitReglementsPret = async () => true;
export const versionDeployee = () => ({ revision: null, titre: null });
/*
 * La part qui court sans etre inscrite est posee par le controle, cas par cas :
 * ce qui se mesure ici est ce que le courrier EN DIT, la lecture du registre
 * ayant son propre controle, execute sur PostgreSQL.
 */
export const penalitesNonInscrites = async (
  _s?: unknown,
): Promise<Map<string, { nb: number; montant: number; mois: string[] }> | null> => null;
export const listerPenalites = async (_f?: unknown): Promise<{
  membre_id: string; nature: string; date_constat: string; source_key: string | null;
}[]> => [];
export const bornesReprisePenalites = async () => new Map<string, string>();
export type PlanRedressement = {
  membreId: string; membreNom: string; debut: string | null; fin: string | null;
  note: string | null;
};
export const plansRedressement = async () => new Map<string, PlanRedressement>();
export type RegleMembre = {
  id: string; membreId: string; membreNom: string; nature: string;
  valeur: number | null; debut: string | null; fin: string | null; note: string | null;
  actif: boolean;
};
export const reglesParMembre = async () => new Map<string, RegleMembre[]>();
export const reglesImminentes = async (_m?: unknown, _j?: unknown) =>
  new Map<string, RegleMembre[]>();
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
    ["tsc", `${ATELIER}/relance.ts`, `${ATELIER}/courriel.ts`,
      "--target", "es2022", "--module", "es2022",
      "--moduleResolution", "bundler", "--outDir", `${ATELIER}-js`, "--rootDir", "."],
    { cwd: RACINE, stdio: "inherit" },
  );
} finally {
  writeFileSync(penalites, penalitesOriginal);
}
writeFileSync(`${RACINE}/${ATELIER}-js/package.json`, '{"type":"module"}');
const { enHtml } = await import(`${RACINE}/${ATELIER}-js/${ATELIER}/courriel.js`);
const { texteRelance, sujetRelance: sujetRelanceBrut, doitRecevoir } = await import(
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
    penalites: [
      { mois: "2026-08-01", montant: 500, doublee: false, figee: false },
      { mois: "2026-09-01", montant: 500, doublee: false, figee: false },
    ],
  },
  arrieres: ["2026-08-01"],
  echeanceDuJour: "2026-09-01",
  dette: { nb: 15, montant: 7500, nbRetard: 15, montantRetard: 7500 },
  /* Aout et septembre : l'art. 9 court, le registre ne les porte pas encore. */
  nonInscrites: { nb: 2, montant: 1000, mois: ["2026-08-01", "2026-09-01"] },
  plan: null,
  regles: [],
  reglesAVenir: [],
  avanceManquante: null,
  avanceAuSeuil: null,
  avanceFinissante: null,
};
const LE_30 = new Date("2026-09-30T08:00:00Z");
const SITE = "https://ip12-alpha.vercel.app";
/*
 * `fcfa` separe les milliers par une espace insecable, pour qu'un montant ne se
 * coupe jamais en fin de ligne. Les controles comparent donc sur un texte
 * normalise, faute de quoi ils mesureraient la typographie et non le propos.
 * Les accents suivent la meme regle : ils ont leur controle a part, plus bas.
 */
const sansAccents = (texte) => texte.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const lettre = (d, quand = LE_30) =>
  sansAccents(texteRelance(d, SITE, quand).replace(/\u00a0/g, " "));
const sujetRelance = (...args) => sansAccents(sujetRelanceBrut(...args));

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

/* ----------------------------- les deux dettes de penalites, et leur somme */

/*
 * LES DEUX SONT DUES. Le registre porte les penalites constatees ; l'art. 9 court
 * sur les mois encore impayes, avant tout constat. Le courrier avait d'abord
 * annonce les deux chiffres sans un mot sur leur rapport, puis -- correction plus
 * mauvaise que le defaut -- n'en avait plus annonce qu'un, taisant une dette
 * reelle. Il les additionne.
 */
const sommes = (texte) =>
  texte.split("\n").filter((l) => /^(Penalites?|S'y ajoute|Total des penalites)/.test(l));

const lettreSansCircuit = () =>
  sansAccents(texteRelance(bourama, SITE, LE_30, false).replace(/\u00a0/g, " "));
const troisLignes = sommes(texteBourama);
verifier(
  troisLignes.some((l) => /inscrites a votre compte : 15, pour un total de 7 500/.test(l)),
  "ce que le registre porte doit etre annonce comme tel",
);
verifier(
  troisLignes.some((l) => /S'y ajoute la penalite de l'art\. 9 .* 1 000/.test(l)),
  "la penalite qui court sans etre constatee doit s'ajouter, non disparaitre",
);
/*
 * Le courrier ne parle pas au membre de l'etat du registre : « pas encore portee
 * a votre compte » decrivait un retard de l'outil et appelait la question qu'il
 * ne pouvait pas repondre.
 */
verifier(
  !/pas encore portee/.test(texteBourama) && !/prochain constat/.test(texteBourama),
  "le courrier ne doit pas exposer au membre le retard du registre",
);
verifier(
  troisLignes.some((l) => /Total des penalites dues a ce jour : 8 500/.test(l)),
  "le courrier doit donner la somme des deux : 7 500 + 1 000",
);

/*
 * Rien au registre : un seul chiffre, et il se dit pour ce qu'il est. Pas de
 * ligne « Total », qui n'aurait rien a totaliser.
 */
const muet = { ...bourama, dette: { nb: 0, montant: 0, nbRetard: 0, montantRetard: 0 } };
verifier(
  /Penalite de l'art\. 9 sur 2 mois encore impayes/.test(lettre(muet)),
  "registre muet : la penalite courue reste annoncee",
);
verifier(
  !/Total des penalites/.test(lettre(muet)),
  "registre muet : rien a totaliser, donc pas de ligne de total",
);
verifier(
  !/A partir de 3 penalites/.test(lettre(muet)),
  "rien au registre : l'exclusion n'a pas a etre evoquee pour une penalite qui vient de naitre",
);

/*
 * Tout constate : la ligne d'appoint disparait, et avec elle le total. C'est ce
 * qui empeche de compter deux fois le meme mois une fois le constat passe.
 */
const toutInscrit = { ...bourama, nonInscrites: { nb: 0, montant: 0, mois: [] } };
verifier(
  !/S'y ajoute/.test(lettre(toutInscrit)),
  "une fois les mois constates, ils ne s'ajoutent plus : ils sont dans le registre",
);
verifier(
  !/Total des penalites/.test(lettre(toutInscrit)),
  "un seul chiffre ne se totalise pas",
);

/* Retards et absences : le detail, l'appoint, puis la somme des trois natures. */
const avecAbsences = {
  ...bourama,
  dette: { nb: 17, montant: 11500, nbRetard: 15, montantRetard: 7500 },
};
verifier(
  /dont 15 de retard \(7 500 FCFA\) et 2 d'absence ou autre \(4 000 FCFA\)/.test(lettre(avecAbsences)),
  "le detail par nature doit tenir, le seuil R5 ne comptant que les retards",
);
verifier(
  /Total des penalites dues a ce jour : 12 500/.test(lettre(avecAbsences)),
  "la somme doit porter sur toutes les natures plus l'appoint : 11 500 + 1 000",
);

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
  texteBourama.includes("choisissez ce que vous reglez") &&
    texteBourama.includes("une cotisation ou une penalite"),
  "des que le courrier reclame des penalites, il doit dire comment les declarer",
);
verifier(
  texteBourama.includes("La penalite reste due jusqu'a cette verification"),
  "le courrier doit prevenir qu'une relance peut encore reclamer ce qui est declare",
);
const sansDette = { ...bourama, dette: { nb: 0, montant: 0, nbRetard: 0, montantRetard: 0 } };
verifier(
  !lettre(sansDette).includes("une penalite") &&
    lettre(sansDette).includes("COMMENT ENREGISTRER VOTRE COTISATION"),
  "sans penalite reclamee, le choix de la penalite n'a pas a encombrer le courrier",
);
/*
 * La migration qui cree la table s'execute a la main : entre la mise en ligne et
 * ce geste, le courrier ne doit pas envoyer chercher un bouton absent.
 */
verifier(
  !/choisissez ce que vous reglez|choisissez « une penalite »/.test(lettreSansCircuit()),
  "circuit absent : le courrier ne doit pas donner une consigne qui ne mene nulle part",
);
verifier(
  /inscrites a votre compte : 15/.test(lettreSansCircuit()),
  "circuit absent ou non, la dette s'annonce",
);

/* ------------------------------------------- les mesures disciplinaires */

/*
 * AUCUNE DE CES LIGNES N'ETAIT CONTROLEE, et c'est ce qui a laisse passer le
 * defaut : le plan de redressement, que le bureau peut accorder depuis
 * Administration et que R5 ne donne qu'une fois sur la duree du club, n'etait
 * relu par personne. Un membre sous plan recevait la meme relance que tout
 * autre -- sans un mot sur la mesure qui le protege, ni sur son terme.
 */
const sousPlan = {
  ...bourama,
  plan: {
    membreId: "b",
    membreNom: "KONE Bourama",
    debut: "2026-09-01",
    fin: "2027-03-31",
    note: "5 000 FCFA par mois en sus de la cotisation",
  },
};
const texteSousPlan = lettre(sousPlan);

verifier(
  /MESURE DISCIPLINAIRE : plan de redressement \(R5\)/.test(texteSousPlan),
  "le plan accorde doit paraitre dans la relance, et non rester au registre",
);
verifier(
  texteSousPlan.includes("5 000 FCFA par mois en sus de la cotisation"),
  "les termes convenus doivent etre rappeles : c'est ce que le membre doit tenir",
);
verifier(
  /court jusqu'au 31\/03\/2027/.test(texteSousPlan),
  "le terme du plan doit etre dit : sans date, le membre le croit sans fin",
);
verifier(
  texteSousPlan.includes("ne s'accorde qu'une fois"),
  "R5 n'accorde le plan qu'une fois : le courrier doit le dire",
);
verifier(
  texteSousPlan.includes("vote de l'assemblee (art. 20)"),
  "et dire ce qui suit s'il n'est pas tenu",
);
verifier(
  !/MESURE DISCIPLINAIRE/.test(texteBourama),
  "sans mesure, aucun bloc disciplinaire n'encombre le courrier",
);
verifier(
  lettre({ ...sousPlan, plan: { ...sousPlan.plan, fin: null } }).includes("sans terme fixe"),
  "un plan sans terme doit le dire",
);
verifier(
  sujetRelance(sousPlan, "2026-09-01", LE_30).includes("plan de redressement"),
  "l'objet doit nommer le plan, non un simple retard",
);

/*
 * Le courrier annoncait le seuil atteint et l'exclusion de plein droit, puis
 * expliquait plus bas qu'un plan l'ecarte : deux paragraphes qui se
 * contredisaient. Le plan porte sur l'ensemble de la dette, penalites comprises.
 */
verifier(
  /Elles entrent dans le plan de redressement/.test(texteSousPlan),
  "sous plan, les penalites doivent etre dites couvertes par lui",
);
verifier(
  !/ce cumul emportera l'exclusion de plein droit/.test(texteSousPlan),
  "sous plan, le courrier ne doit pas annoncer l'exclusion que le plan ecarte",
);
verifier(
  /ce cumul emportera l'exclusion de plein droit/.test(texteBourama),
  "sans plan, l'avertissement du seuil tient",
);

/* --------------------------------------------- l'avance obligatoire */

const sousAvance = {
  ...bourama,
  avanceManquante: { mois: 3, montantExige: 15000, avanceDetenue: 5000, fin: "2027-06-30" },
};
const texteAvance = lettre(sousAvance);

verifier(
  /MESURE DISCIPLINAIRE : avance obligatoire/.test(texteAvance),
  "l'avance imposee doit paraitre",
);
verifier(
  texteAvance.includes("il manque 10 000 FCFA"),
  "le courrier doit dire ce qui manque, non le seul montant exige",
);
verifier(
  /court jusqu'au 30\/06\/2027/.test(texteAvance),
  "l'obligation datee doit porter sa date : un delai qu'on ignore ne se tient pas",
);
verifier(
  sujetRelance(sousAvance, "2026-09-01", LE_30).includes("avance obligatoire non constituee"),
  "l'avance non tenue prime dans l'objet",
);

/* Les deux mesures ensemble : aucune n'efface l'autre. */
const lesDeux = lettre({ ...sousPlan, avanceManquante: sousAvance.avanceManquante });
verifier(
  /plan de redressement/.test(lesDeux) && /avance obligatoire/.test(lesDeux),
  "un membre sous deux mesures doit lire les deux",
);

/* ------------------------------------------- les regles individuelles */

/*
 * ELLES PESAIENT SANS SE DIRE. Une cotisation particuliere et des penalites
 * majorees changent les montants reclames, et le courrier n'en disait rien : le
 * membre voyait ses penalites doublees sans savoir pourquoi, et pouvait croire a
 * une erreur du site. Celui qui n'avait rien a se reprocher, lui, ne recevait
 * aucun courrier : la mesure votee en assemblee ne lui etait jamais rappelee.
 */
const REGLES_DEUX = [
  {
    id: "r1", membreId: "b", membreNom: "KONE Bourama", nature: "penalite_multiplicateur",
    valeur: 2, debut: "2026-07-01", fin: "2027-06-30", note: "*Sanction* de l'assemblee du 28/06", actif: true,
  },
  {
    id: "r2", membreId: "b", membreNom: "KONE Bourama", nature: "cotisation",
    valeur: 7500, debut: null, fin: null, note: null, actif: true,
  },
];
const texteRegles = lettre({ ...bourama, regles: REGLES_DEUX });

verifier(/VOTRE REGIME PARTICULIER/.test(texteRegles), "les regles en vigueur doivent paraitre");
verifier(
  /Penalites majorees : vos penalites de retard sont multipliees par 2/.test(texteRegles),
  "la majoration doit etre dite : sans elle, le montant parait faux",
);
verifier(
  /a compter du 01\/07\/2026, jusqu'au 30\/06\/2027/.test(texteRegles),
  "la fenetre de la regle doit etre dite : une derogation sans terme est un regime durable",
);
verifier(
  texteRegles.includes("Sanction de l'assemblee du 28/06"),
  "le motif inscrit au dossier doit etre rappele",
);
verifier(
  /Cotisation particuliere : 7 500 FCFA par mois/.test(texteRegles),
  "une cotisation particuliere doit etre dite, et non subie",
);
verifier(
  !/VOTRE REGIME PARTICULIER/.test(texteBourama),
  "sans regle, la section n'encombre pas le courrier",
);

/*
 * L'AVANCE, SELON QU'ELLE EST TENUE OU NON.
 *
 * Elle n'avait de bloc que lorsqu'elle etait EN DEFAUT. Un membre qui la
 * respecte, destinataire pour un simple retard de cotisation, ne lisait rien de
 * l'obligation qui pese sur lui : il pouvait la croire levee, puis la rompre en
 * retirant son avance. La mesure n'existait pour lui qu'au moment ou il y
 * manquait -- c'est-a-dire trop tard.
 */
const REGLE_AVANCE = {
  id: "r3", membreId: "b", membreNom: "KONE Bourama", nature: "avance_min",
  valeur: 3, debut: null, fin: null, note: null, actif: true,
};

/* En defaut : le bloc disciplinaire, et pas de doublon dans le regime. */
const avanceEnDefaut = lettre({
  ...bourama,
  regles: [REGLE_AVANCE],
  avanceManquante: sousAvance.avanceManquante,
});
verifier(
  !/VOTRE REGIME PARTICULIER/.test(avanceEnDefaut),
  "en defaut, l'avance a son propre bloc : la repeter dans le regime la diluerait",
);
verifier(
  /MESURE DISCIPLINAIRE : avance obligatoire/.test(avanceEnDefaut),
  "et ce bloc-la doit bien paraitre",
);

/* Tenue : elle se rappelle, au lieu de disparaitre. */
const avanceTenue = lettre({ ...bourama, regles: [REGLE_AVANCE] });
verifier(
  /Avance minimale : vous devez detenir en permanence 3 mois/.test(avanceTenue),
  "l'avance tenue doit etre rappelee : sinon le membre la croit levee",
);
verifier(
  /Cette obligation est tenue a ce jour/.test(avanceTenue),
  "et le courrier doit dire qu'elle l'est, sans reproche",
);
verifier(
  !/MESURE DISCIPLINAIRE/.test(avanceTenue),
  "une obligation tenue n'est pas une mesure a annoncer comme un manquement",
);

/* --------------- a jour de tout, mais sous regle : un autre courrier */

const aJourSousRegle = {
  ...bourama,
  situation: { ...bourama.situation, moisEnRetard: [], joursDeRetard: 0, cellules: [] },
  arrieres: [],
  echeanceDuJour: null,
  dette: { nb: 0, montant: 0, nbRetard: 0, montantRetard: 0 },
  nonInscrites: { nb: 0, montant: 0, mois: [] },
  regles: REGLES_DEUX,
};
const texteAJour = lettre(aJourSousRegle);

verifier(
  sujetRelance(aJourSousRegle, "2026-09-01", LE_30).includes("rappel de votre regime particulier"),
  "a jour de tout, l'objet ne doit pas annoncer une relance",
);
verifier(
  texteAJour.includes("ce courrier ne vous reclame rien"),
  "et le courrier doit le dire des la premiere ligne",
);
verifier(
  /VOTRE REGIME PARTICULIER/.test(texteAJour),
  "c'est bien le regime qui lui est rappele",
);
/* ------------------------------- le mois par lequel il faut reprendre */

/*
 * LES MOIS SE REGLENT DANS L'ORDRE, ET LE COURRIER DOIT LE DIRE.
 *
 * « Indiquez le mois couvert » laissait croire a une liberte qui n'existe pas :
 * le site refuse une declaration qui saute un mois ouvert. Sans cette ligne, le
 * courrier envoyait le membre vers un refus. Bourama doit aout et septembre :
 * c'est par aout qu'il reprend.
 */
/*
 * LE TOTAL DES COTISATIONS, COMME CELUI DES PENALITES.
 *
 * Le courrier chiffrait le seul mois courant -- « votre versement de 5 000
 * FCFA pour septembre » -- puis listait aout sans montant. Les penalites, elles,
 * recevaient leur total. Bourama doit aout et septembre : 10 000 FCFA.
 */
verifier(
  /Total des cotisations a regler pour etre a jour : 10 000 FCFA\./.test(texteBourama),
  "le courrier doit donner le total des cotisations a regler, non le seul mois courant",
);
verifier(
  texteBourama.indexOf("Total des cotisations a regler") >
    texteBourama.indexOf("Mois anterieurs encore manquants"),
  "le total suit la liste des mois qu'il additionne",
);

verifier(
  /s'impute sur aout 2026, le plus ancien/.test(texteBourama),
  "le courrier doit nommer le mois sur lequel l'argent ira, non le mois courant",
);
verifier(
  /puis sur les suivants s'il le depasse/.test(texteBourama),
  "et dire que le surplus continue dans l'ordre",
);
verifier(
  !/indiquez le mois couvert/.test(texteBourama),
  "le courrier ne doit plus decrire un champ que le formulaire ne demande plus",
);
verifier(
  /indiquez le montant verse/.test(texteBourama),
  "il doit decrire le seul champ qui reste",
);

verifier(
  !/COMMENT ENREGISTRER VOTRE COTISATION/.test(texteAJour),
  "le mode d'emploi ne sert qu'a qui doit verser",
);
verifier(
  !/en retard|penalite de l'art\. 9 court/.test(texteAJour),
  "rien ne doit lui etre reproche",
);
verifier(
  /^Courrier du 30\/09\/2026\.$/m.test(texteAJour) && !/^Relance du/m.test(texteAJour),
  "le pied ne doit pas dire « relance » sur un courrier qui ne reclame rien",
);
verifier(
  /^Relance du 30\/09\/2026\.$/m.test(texteBourama),
  "et doit bien le dire quand il en est une",
);

/* ================= les quatre defauts du courrier reellement envoye */

/*
 * Le 7 octobre, dix membres ont recu la relance. Ces controles portent sur ce
 * qui est parti ce matin-la, et qu'aucune donnee fabriquee n'avait montre.
 */

/* --- DRAME Khalil : une seule penalite, d'absence, aucune de retard ------ */

const absenceSeule = {
  ...bourama,
  situation: { ...bourama.situation, moisEnRetard: [], joursDeRetard: 0 },
  arrieres: [],
  dette: { nb: 1, montant: 2000, nbRetard: 0, montantRetard: 0 },
  nonInscrites: { nb: 0, montant: 0, mois: [] },
};
const texteAbsence = lettre(absenceSeule);

/*
 * Le courrier annoncait « dont 0 de retard (0 FCFA) et 1 d'absence » : le detail
 * ne se justifie que si les deux natures existent. Un zero annonce fait chercher
 * ce qu'il cache.
 */
verifier(!/0 de retard/.test(texteAbsence), "aucune composante nulle ne doit etre annoncee");
verifier(
  /Penalite d'absence ou autre, inscrite a votre compte : 1, pour un total de 2 000/.test(
    texteAbsence,
  ),
  "une penalite d'absence seule se dit pour ce qu'elle est, au singulier",
);

/*
 * Et il enchainait sur « a partir de 3 penalites DE RETARD impayees,
 * l'exclusion sera encourue » juste sous l'annonce de son unique penalite
 * d'absence : de quoi se croire au tiers d'un seuil dont on est a zero.
 */
verifier(
  !/A partir de 3 penalites de retard/.test(texteAbsence),
  "sans aucune penalite de retard, le seuil R5 n'a pas a etre evoque",
);
verifier(
  /A partir de 3 penalites de retard/.test(
    lettre({ ...absenceSeule, dette: { nb: 2, montant: 2500, nbRetard: 1, montantRetard: 500 } }),
  ),
  "mais des qu'il y a une penalite de retard, l'avertissement tient",
);

/* --- YOUSSOUF Mohamed : a jour de ses versements, 7 penalites de retard -- */

const penalitesSeules = {
  ...bourama,
  situation: { ...bourama.situation, moisEnRetard: [], joursDeRetard: 0 },
  arrieres: [],
  echeanceDuJour: null,
  dette: { nb: 7, montant: 3500, nbRetard: 7, montantRetard: 3500 },
  nonInscrites: { nb: 0, montant: 0, mois: [] },
};
const textePenalites = lettre(penalitesSeules);

/*
 * Il recevait cinq etapes sur la declaration d'un VERSEMENT -- « indiquez le
 * mois couvert » -- alors qu'il n'en doit aucun. On lui expliquait longuement
 * ce qu'il n'a pas a faire, avant les trois lignes qui le concernent.
 */
verifier(
  !/COMMENT ENREGISTRER VOTRE COTISATION/.test(textePenalites),
  "qui ne doit aucune cotisation n'a que faire du mode d'emploi des versements",
);
verifier(
  /COMMENT ENREGISTRER LE REGLEMENT DE VOS PENALITES/.test(textePenalites),
  "en revanche le chemin des penalites, lui, le concerne",
);
/*
 * Et ce chemin doit alors se suffire : sans le bloc des cotisations au-dessus,
 * personne ne lui a dit d'ouvrir le site ni ou toucher.
 */
verifier(
  /1\. Ouvrez https/.test(textePenalites) &&
    /2\. Touchez « Versements »/.test(textePenalites) &&
    /choisissez « une penalite »/.test(textePenalites),
  "seul, le chemin des penalites part de Versements et nomme le choix a faire",
);
/*
 * UN SEUL CHEMIN, UN SEUL MODE D'EMPLOI. Le courrier en portait deux, dix
 * lignes a qui devait cotisation et penalite, parce que les deux se
 * declaraient sur deux pages.
 */
verifier(
  (texteBourama.match(/COMMENT ENREGISTRER/g) ?? []).length === 1 &&
    (texteBourama.match(/1\. Ouvrez/g) ?? []).length === 1,
  "qui doit les deux lit un seul mode d'emploi, non deux",
);
/*
 * Mais il doit quand meme dire OU : le membre vient d'etre envoye sur
 * « Versements », et le bouton n'y est pas.
 */
verifier(
  /Si un meme transfert couvre les\s+deux, declarez chacun a part\./.test(texteBourama),
  "un transfert qui paie les deux se declare en deux fois, et le courrier le dit",
);
verifier(
  /Une penalite se regle entiere, de la plus ancienne a la plus recente\./.test(texteBourama),
  "la regle d'imputation des penalites est dite, comme celle des cotisations",
);

/* --- l'objet, lu par dix personnes ------------------------------------- */

verifier(
  sujetRelance(absenceSeule, "2026-10-01", LE_30) === "IP12 : 1 penalite impayee",
  "« 1 penalite(s) impayee(s) » : le nombre est connu au moment d'ecrire",
);
verifier(
  sujetRelance(penalitesSeules, "2026-10-01", LE_30) === "IP12 : 7 penalites impayees",
  "et le pluriel s'accorde quand il le faut",
);

/* ============ la mesure datee, annoncee avant sa date ================== */

/*
 * LE CAS DE BLA AIME ANGE DAVID, 7 OCTOBRE 2026.
 *
 * L'assemblee lui impose trois mois de cotisation d'avance « a compter du
 * 10/10/2026 », et sa resolution precise : « doit etre regularisee par
 * l'interesse AVANT le 10 octobre 2026 », faute de quoi l'exclusion est
 * automatique. Les regles n'etant lues qu'une fois en vigueur, son courrier du
 * 7 n'en disait rien : il aurait appris la mesure le jour ou il etait trop tard
 * pour s'y conformer.
 */
const REGLE_BLA = {
  id: "bla1",
  membreId: "b",
  membreNom: "BLA Aime Ange David",
  nature: "avance_min",
  valeur: 3,
  debut: "2026-10-10",
  fin: "2027-12-31",
  note: "*Resolutions :* *Mesure disciplinaire concernant Bla Ange David :* ultime clemence.",
  actif: true,
};
const texteAVenir = lettre({ ...bourama, reglesAVenir: [REGLE_BLA] });

verifier(/MESURE A VENIR/.test(texteAVenir), "une mesure datee doit s'annoncer avant sa date");
verifier(
  /vous devrez detenir en permanence 3 mois de cotisation d'avance, soit 15 000 FCFA/.test(
    texteAVenir,
  ),
  "et dire ce qu'elle exige, en francs comme en mois",
);
verifier(
  /a compter du 10\/10\/2026 et jusqu'au 31\/12\/2027, dans 10 jours/.test(texteAVenir),
  "et combien de jours il reste : c'est le delai qui fait agir",
);
verifier(
  /et jusqu'au 31\/12\/2027/.test(texteAVenir),
  "le terme de la mesure se dit aussi",
);
verifier(
  !/, dans 10 jours,/.test(texteAVenir),
  "le decompte ferme la phrase, il ne la coupe pas",
);
verifier(
  /C'est avant sa date qu'il faut s'y conformer/.test(texteAVenir),
  "le courrier doit dire que le delai court avant la date, non apres",
);
verifier(
  !/MESURE A VENIR/.test(texteBourama),
  "sans mesure a venir, la section n'encombre pas le courrier",
);

/*
 * La note est collee depuis WhatsApp. Sans nettoyage, le membre lit la
 * ponctuation d'un autre outil au milieu d'une sanction.
 */
verifier(
  /Resolutions : Mesure disciplinaire concernant Bla Ange David : ultime clemence\./.test(
    texteAVenir,
  ),
  "le balisage WhatsApp d'une note ne doit pas partir tel quel",
);
verifier(!/\*/.test(texteAVenir), "aucune etoile ne doit subsister dans le courrier");

/* La meme regle, une fois en vigueur, change de section et de temps. */
const texteEnVigueur = lettre({ ...bourama, regles: [{ ...REGLE_BLA, debut: "2026-09-10" }] });
verifier(
  /VOTRE REGIME PARTICULIER/.test(texteEnVigueur) && !/MESURE A VENIR/.test(texteEnVigueur),
  "en vigueur, elle releve du regime particulier et non des mesures a venir",
);

/* ---------------- un paragraphe, une ligne ----------------------------- */

/*
 * Un paragraphe coupe a la main se recoupe sur un telephone : on lit des lignes
 * longues alternant avec des moignons. Les listes et les etapes gardent leurs
 * retours, eux portent du sens.
 */
for (const ligne of texteBourama.split("\n")) {
  const estListe = /^\s*[-\d]/.test(ligne) || /^\s{4}/.test(ligne);
  const estTitre = ligne === ligne.toUpperCase();
  if (estListe || estTitre || ligne.length < 60) continue;
  verifier(
    /[.:!?»]$/.test(ligne.trim()),
    `paragraphe coupe a la main : « ...${ligne.trim().slice(-42)} »`,
  );
}

/* ============ la forme sous laquelle le courrier part ================== */

/*
 * Le texte reste la source : le HTML n'en est qu'un rendu, et c'est le MEME
 * texte qui est rendu ici. Rien n'est ecrit deux fois, donc rien ne peut
 * diverger -- mais le rendu, lui, peut se degrader en silence.
 */
const html = enHtml(texteAVenir);

/*
 * LES ACCENTS. Le courrier s'ecrit en francais correct : les controles du propos
 * les ignorent, celui-ci les exige. Et un titre accentue reste un titre au rendu.
 */
{
  const brut = texteRelance({ ...bourama, reglesAVenir: [REGLE_BLA] }, SITE, LE_30);
  for (const mot of ["Pénalités", "à régler", "être à jour", "MESURE À VENIR"]) {
    verifier(brut.includes(mot), `le courrier doit porter ses accents : « ${mot} »`);
  }
  verifier(!/\u2014/.test(brut), "aucun tiret cadratin dans le courrier");
  verifier(
    /text-transform:uppercase[^>]*>MESURE À VENIR</.test(enHtml(brut)),
    "un titre en capitales accentuees doit rester un titre",
  );
}

verifier(
  !/<p[^>]*>[^<]*Penalites de retard impayees[^<]*Vos 15 penalites/.test(html),
  "deux lignes distinctes ne doivent pas fondre en un seul bloc : le montant de " +
    "la dette et l'avertissement de R5 sont deux choses",
);
verifier(
  /text-transform:uppercase[^>]*>MESURE A VENIR</.test(html),
  "un titre en capitales doit devenir un titre",
);
verifier(
  />MESURE DISCIPLINAIRE</.test(enHtml(texteSousPlan)),
  "un titre suivi d'un tiret cadratin reste un titre : sa precision n'est pas en capitales",
);
verifier(
  /<span style="font-size:14px[^>]*>plan de redressement \(R5\)\.<\/span>/.test(
    enHtml(texteSousPlan),
  ),
  "et cette precision se met en gris, non en capitales",
);
verifier(
  /border-left:2px solid/.test(html),
  "les listes et les etapes doivent se distinguer du corps",
);
verifier(
  /<a href="https:\/\/ip12-alpha\.vercel\.app"/.test(html),
  "l'adresse du site doit etre cliquable : on ne recopie pas une adresse a la main",
);
verifier(
  /font-size:13px[^>]*>Relance du 30\/09\/2026\.<\/p>/.test(html),
  "la date du courrier appartient au pied, non au corps",
);
verifier(
  /font-size:13px[^>]*>Le bureau d'Investment Pioneers<\/p>/.test(html),
  "la signature aussi",
);
verifier(
  !/<p[^>]*>\s*<\/p>/.test(html),
  "aucun paragraphe vide : les lignes vides reglent l'espacement, elles ne le remplissent pas",
);

/*
 * Un courriel n'a pas de feuille de style : tout est en ligne. Et les couleurs
 * sont posees explicitement -- Gmail sur Android inverse les siennes en theme
 * sombre, et un fond laisse implicite devient noir sous une encre noire.
 */
verifier(!/<style|class=/.test(html), "aucune feuille ni classe : un courriel ne les lit pas");
verifier(
  /background:#ffffff/.test(html) && /color:#1f1b16/.test(html),
  "le fond et l'encre du corps sont poses, non laisses au client",
);

/* Ce que le texte ne dit pas, le HTML ne l'invente pas. */
const sansBalise = html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
for (const mot of ["MESURE A VENIR", "15 000 FCFA", "Investment Pioneers"]) {
  verifier(sansBalise.includes(mot), `« ${mot} » doit survivre au rendu`);
}
verifier(
  !/<script|onerror=|onclick=/i.test(html),
  "rien d'executable dans un courrier : les notes viennent du bureau, mais elles sont saisies",
);
verifier(
  enHtml("Un <b>essai</b> & une esperluette").includes("&lt;b&gt;"),
  "une balise saisie dans une note s'affiche, elle ne s'execute pas",
);

/* ------------------------------ l'avance tenue ne declenche que le preavis */

/*
 * LE CAS DE BLA.
 *
 * Tenu a trois mois d'avance, il recevait chaque 10 un « rappel de regime »,
 * meme confortablement au-dessus du minimum. Le bureau a tranche : rien tant
 * qu'il a plus que le minimum, un preavis des qu'il n'en a plus que le minimum,
 * la mesure disciplinaire une fois en defaut.
 */
const LE_10 = new Date("2026-10-10T08:00:00Z");
const LE_7 = new Date("2026-10-07T08:00:00Z");
const regleAvance = {
  id: "ra", membreId: "b", membreNom: "BLA", nature: "avance_min", valeur: 3,
  debut: "2026-10-10", fin: null, note: null, actif: true,
};
const aJourDeTout = {
  ...bourama,
  arrieres: [],
  echeanceDuJour: null,
  dette: { nb: 0, montant: 0, nbRetard: 0, montantRetard: 0 },
  nonInscrites: { nb: 0, montant: 0, mois: [] },
};
const blaConfortable = { ...aJourDeTout, regles: [regleAvance] };
verifier(
  !doitRecevoir(blaConfortable, LE_10),
  "au-dessus du minimum, l'avance tenue ne vaut aucun courrier, meme le 10",
);
verifier(!doitRecevoir(blaConfortable, LE_7), "ni le 7");

const auMinimum = {
  membreId: "b", mois: 3, montantExige: 15000, avanceDetenue: 15000,
  respectee: true, auSeuil: true, pourMaintenir: 5000, fin: null,
  moisRequis: 3, moisRestants: null,
};
const blaAuSeuil = { ...blaConfortable, avanceAuSeuil: auMinimum };
verifier(doitRecevoir(blaAuSeuil, LE_10), "au minimum, le preavis part");
verifier(doitRecevoir(blaAuSeuil, LE_7), "des le 7 : il a jusqu'a l'echeance pour verser");
verifier(
  sujetRelance(blaAuSeuil, "2026-10-01", LE_10) === "IP12 : votre avance obligatoire arrive au minimum",
  "l'objet dit un avertissement, non un retard",
);
const textePreavis = lettre(blaAuSeuil, LE_10);
verifier(
  /VOTRE AVANCE OBLIGATOIRE ARRIVE AU MINIMUM/.test(textePreavis),
  "le preavis a son bloc",
);
verifier(
  /Versez au moins 5 000 FCFA pour la maintenir\./.test(textePreavis),
  "et chiffre ce qu'il faut verser, plutot que de laisser faire le calcul",
);
verifier(!/MESURE DISCIPLINAIRE/.test(textePreavis), "l'obligation est tenue : aucune mesure");
verifier(
  !/VOTRE REGIME PARTICULIER/.test(textePreavis),
  "l'avance a son bloc : elle n'est pas repetee sous le regime particulier",
);
verifier(
  !/ce courrier ne vous reclame rien/.test(textePreavis),
  "un preavis n'est pas un courrier « a jour de tout » : il demande un versement",
);
verifier(
  /COMMENT ENREGISTRER VOTRE COTISATION/.test(textePreavis),
  "il doit verser : le mode d'emploi l'accompagne",
);

// La mesure disciplinaire reste ce qu'elle etait, aux trois passages.
const blaEnDefaut = {
  ...blaConfortable,
  avanceManquante: { ...auMinimum, avanceDetenue: 10000, respectee: false, auSeuil: false },
};
verifier(doitRecevoir(blaEnDefaut, LE_7), "en defaut, il est ecrit des le 7");

/*
 * Les autres regles gardent leur rappel mensuel : le bureau n'a tranche que
 * pour l'avance. Une cotisation particuliere ou des penalites majorees,
 * jamais rappelees, tomberaient sans explication.
 */
const sousTarif = {
  ...aJourDeTout,
  regles: [{ ...regleAvance, id: "rc", nature: "cotisation", valeur: 10000 }],
};
verifier(doitRecevoir(sousTarif, LE_10), "une cotisation particuliere garde son rappel du 10");
verifier(!doitRecevoir(sousTarif, LE_7), "mais un seul par mois");
verifier(
  doitRecevoir({ ...blaConfortable, regles: [regleAvance, sousTarif.regles[0]] }, LE_10),
  "une avance tenue n'efface pas le rappel d'une autre regle",
);

/* --------------------------------------- la fin de la mesure, annoncee */

/*
 * DECISION DU BUREAU : BLA, tenu a trois mois d'avance jusqu'au 31/12/2027,
 * est informe de la fin trois mois avant, si tout est verse. En octobre 2027,
 * les trois mois qui restent sont exactement ceux qu'il detient.
 */
const LE_10_OCT_2027 = new Date("2027-10-10T08:00:00Z");
const finDeMesure = {
  ...auMinimum, auSeuil: false, pourMaintenir: 0, fin: "2027-12-31",
  moisRequis: 3, moisRestants: 3,
};
const blaEnFin = { ...blaConfortable, avanceFinissante: finDeMesure };
verifier(doitRecevoir(blaEnFin, LE_10_OCT_2027), "trois mois avant le terme, tout verse : il est informe");
verifier(
  !doitRecevoir(blaEnFin, new Date("2027-10-07T08:00:00Z")),
  "une seule fois, avec le courrier de l'echeance, non aux trois passages",
);
verifier(
  sujetRelance(blaEnFin, "2027-10-01", LE_10_OCT_2027) ===
    "IP12 : fin de votre mesure d'avance le 31/12/2027",
  "l'objet annonce la fin et sa date",
);
const texteFin = lettre(blaEnFin, LE_10_OCT_2027);
verifier(/FIN DE VOTRE MESURE D'AVANCE/.test(texteFin), "la fin a son bloc");
verifier(
  /prend fin le 31\/12\/2027/.test(texteFin) && /plus\s+rien a constituer d'avance/.test(texteFin),
  "elle dit la date, et qu'il n'a plus rien a constituer",
);
verifier(/le regime commun reprend/.test(texteFin), "et ce qui suit le terme");
verifier(!/MESURE DISCIPLINAIRE|ARRIVE AU MINIMUM/.test(texteFin), "ni mesure ni preavis : tout est en ordre");
verifier(
  !/VOTRE REGIME PARTICULIER/.test(texteFin),
  "l'avance a son bloc de fin : elle n'est pas repetee sous le regime particulier",
);

// Novembre : deux mois restent. L'annonce a eu lieu ; rien ne repart.
const blaNovembre = { ...blaConfortable, avanceFinissante: { ...finDeMesure, moisRequis: 2, moisRestants: 2 } };
verifier(
  !doitRecevoir(blaNovembre, new Date("2027-11-10T08:00:00Z")),
  "l'annonce ne se repete pas les mois suivants",
);

// Pas tout verse au moment de l'annonce : pas de courrier pour la seule fin.
verifier(
  !doitRecevoir({ ...blaConfortable, avanceFinissante: { ...finDeMesure, respectee: false } }, LE_10_OCT_2027),
  "l'annonce suppose que tout est en ordre : sinon, c'est la mesure qui ecrit",
);

/*
 * En defaut dans la derniere periode : la mesure se chiffre sur ce qui reste
 * jusqu'au terme. Annoncer « trois mois, soit 5 000 FCFA » se contredirait.
 */
const defautFinal = {
  ...finDeMesure, moisRequis: 2, moisRestants: 2, montantExige: 10000,
  avanceDetenue: 5000, respectee: false,
};
const texteDefautFinal = lettre(
  { ...blaConfortable, avanceManquante: defautFinal, avanceFinissante: defautFinal },
  new Date("2027-11-10T08:00:00Z"),
);
verifier(
  /il n'en reste que 2 a couvrir, soit 10 000 FCFA/.test(texteDefautFinal),
  "en fin de mesure, le defaut se chiffre sur les mois qui restent",
);
verifier(
  /prend fin le 31\/12\/2027/.test(texteDefautFinal),
  "et le courrier qu'il recoit de toute facon dit la fin",
);

rmSync(`${RACINE}/${ATELIER}`, { recursive: true, force: true });
rmSync(`${RACINE}/${ATELIER}-js`, { recursive: true, force: true });
console.log(
  `OK - ${controles} controles du courrier de relance : objet, seuil R5, ` +
    "dettes de penalites et leur somme, liste des mois, R2, mode d'emploi des cotisations " +
    "et des penalites, mesures disciplinaires, regime particulier, mesure a venir, " +
    "notes collees, ordre de reglement des mois, preavis d'avance, fin de mesure, mise en forme et rendu HTML",
);
