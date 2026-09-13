// Verification de la logique metier : calculs de performance et regime des retards.
// Lancement : npm run verif
import { strict as assert } from "node:assert";

const { tri, dietzModifie, repartirParts } = await import("../.verif/perf.mjs");
const { situationMembre, calculerPenalites, issueR5, moisARelancer } = await import(
  "../.verif/penalites.mjs"
);

/* ------------------------------------------------------------- performance */

const r = tri([
  { date: "2025-01-01", montant: -1_000_000 },
  { date: "2026-01-01", montant: 1_344_000 },
]);
assert.ok(r !== null && Math.abs(r - 0.344) < 0.005, `TRI attendu ~0,344, obtenu ${r}`);

const d = dietzModifie(
  2_166_323,
  3_274_828,
  [
    { date: "2026-02-15", montant: 160_000 },
    { date: "2026-04-15", montant: 159_000 },
    { date: "2026-06-15", montant: 159_000 },
  ],
  "2026-01-01",
  "2026-07-12",
);
assert.equal(d.apportsPeriode, 478_000);
assert.equal(d.gain, 3_274_828 - 2_166_323 - 478_000);
assert.ok(d.rendement !== null && d.rendement > 0.2 && d.rendement < 0.32);

const parts = repartirParts(
  [
    { membreId: "a", nom: "A", verse: 200_000 },
    { membreId: "b", nom: "B", verse: 100_000 },
  ],
  600_000,
);
assert.ok(Math.abs(parts[0].part - 2 / 3) < 1e-9);
assert.equal(Math.round(parts[0].valeur), 400_000);
assert.equal(Math.round(parts[1].plusValue), 100_000);

/* ----------------------------------------------------------- penalites art. 9 */

// Un seul mois de retard : 10 % de 5 000 = 500, sans doublement.
const p1 = calculerPenalites(["2026-06-01"]);
assert.equal(p1.length, 1);
assert.equal(p1[0].montant, 500);
assert.equal(p1[0].doublee, false);

// Deux mois : toujours 10 % chacun (R4 ne s'applique qu'a partir de 3).
const p2 = calculerPenalites(["2026-05-01", "2026-06-01"]);
assert.equal(p2.reduce((s, p) => s + p.montant, 0), 1_000);
assert.ok(p2.every((p) => !p.doublee));

// Trois mois : R4 double les 3 derniers -> 3 x 1 000 = 3 000 (soit 60 % de 5 000).
const p3 = calculerPenalites(["2026-04-01", "2026-05-01", "2026-06-01"]);
assert.equal(p3.reduce((s, p) => s + p.montant, 0), 3_000);
assert.ok(p3.every((p) => p.doublee));

// Cinq mois : seuls les 3 plus recents doublent, les 2 plus anciens restent a 10 %.
const p5 = calculerPenalites([
  "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01",
]);
assert.equal(p5.filter((p) => p.doublee).length, 3);
assert.equal(p5.reduce((s, p) => s + p.montant, 0), 2 * 500 + 3 * 1_000);

/* ------------------------------------------------- situation mensuelle d'un membre */

const moisTest = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
const aout = new Date("2026-08-20T12:00:00Z");

// Un versement en attente de validation ne doit pas compter comme un retard.
const enAttente = situationMembre(
  "m1",
  moisTest,
  [
    { mois_couvert: "2026-05-01", montant: 5000, statut: "valide", date_versement: "2026-05-03" },
    { mois_couvert: "2026-06-01", montant: 5000, statut: "en_attente", date_versement: "2026-06-04" },
    { mois_couvert: "2026-07-01", montant: 5000, statut: "valide", date_versement: "2026-07-02" },
    { mois_couvert: "2026-08-01", montant: 5000, statut: "en_attente", date_versement: "2026-08-05" },
  ],
  [],
  aout,
);
assert.equal(enAttente.nbMoisRetard, 0, "un versement en attente ne doit pas etre un retard");
assert.equal(enAttente.totalPenalites, 0);

// Deux mois impayes : retard, penalites, et R3 exigible.
const enRetard = situationMembre(
  "m2",
  moisTest,
  [{ mois_couvert: "2026-05-01", montant: 5000, statut: "valide", date_versement: "2026-05-03" }],
  [],
  aout,
);
assert.equal(enRetard.nbMoisRetard, 3, `attendu 3 mois impayes, obtenu ${enRetard.nbMoisRetard}`);
assert.ok(enRetard.declarationRequise, "R3 doit etre exigee des le 2e mois");
assert.ok(enRetard.voteSuspendu, "R2 doit suspendre le vote au-dela de 30 jours");
assert.ok(enRetard.exclusionEncourue, "art. 20 encouru a 3 mois");

// Le mois courant n'est pas exigible avant le 10.
const avantEcheance = situationMembre("m3", ["2026-08-01"], [], [], new Date("2026-08-05T12:00:00Z"));
assert.equal(avantEcheance.cellules[0].statut, "a_venir");
const apresEcheance = situationMembre("m3", ["2026-08-01"], [], [], new Date("2026-08-11T12:00:00Z"));
assert.equal(apresEcheance.cellules[0].statut, "retard");

// Les mois anterieurs a l'adhesion sont hors periode.
const nouveau = situationMembre("m4", moisTest, [], [], aout, "2026-07-01");
assert.equal(nouveau.cellules[0].statut, "hors_periode");
assert.equal(nouveau.cellules[1].statut, "hors_periode");
assert.equal(nouveau.nbMoisRetard, 2);

/* ------------------------------------ art. 9 : la penalite survit au rattrapage */

// Un mois regle apres le 10 conserve sa penalite : elle est "definitivement acquise".
const rattrapeTard = situationMembre(
  "m5",
  ["2026-06-01"],
  [{ mois_couvert: "2026-06-01", montant: 5000, statut: "valide", date_versement: "2026-06-28" }],
  [],
  aout,
);
assert.equal(rattrapeTard.cellules[0].statut, "paye_en_retard");
assert.equal(rattrapeTard.nbMoisRetard, 0, "le mois est regle : plus d'arriere");
assert.equal(rattrapeTard.totalPenalites, 500, "mais la penalite reste due (art. 9)");
assert.equal(rattrapeTard.penalites[0].figee, true);
assert.equal(rattrapeTard.penalites[0].doublee, false, "un mois regle ne peut plus s'aggraver");

// Paye le 10 meme : dans les delais, aucune penalite.
const paiementLimite = situationMembre(
  "m6",
  ["2026-06-01"],
  [{ mois_couvert: "2026-06-01", montant: 5000, statut: "valide", date_versement: "2026-06-10" }],
  [],
  aout,
);
assert.equal(paiementLimite.cellules[0].statut, "paye");
assert.equal(paiementLimite.totalPenalites, 0);

// Une avance versee avant le mois couvert n'est evidemment pas un retard.
const avance = situationMembre(
  "m7",
  ["2026-08-01"],
  [{ mois_couvert: "2026-08-01", montant: 5000, statut: "valide", date_versement: "2026-06-05" }],
  [],
  aout,
);
assert.equal(avance.cellules[0].statut, "paye");
assert.equal(avance.totalPenalites, 0);

// Melange : 2 mois regles en retard (figees, 10 %) et 3 impayes (doubles par R4).
const melange = situationMembre(
  "m8",
  ["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"],
  [
    { mois_couvert: "2026-02-01", montant: 5000, statut: "valide", date_versement: "2026-03-20" },
    { mois_couvert: "2026-03-01", montant: 5000, statut: "valide", date_versement: "2026-04-02" },
  ],
  [],
  aout,
);
assert.equal(melange.nbMoisRetard, 3);
assert.equal(melange.moisRegularisesEnRetard.length, 2);
assert.equal(melange.penalites.filter((p) => p.figee).length, 2);
assert.equal(melange.penalites.filter((p) => p.doublee).length, 3);
// 2 figees a 500 + 3 impayes doubles a 1000
assert.equal(melange.totalPenalites, 2 * 500 + 3 * 1000);

/* --------------------------------------------------------------------- R5 */

assert.equal(issueR5(2, false, false).applicable, false);
assert.equal(issueR5(3, false, false).voie, "exclusion_plein_droit");
assert.equal(issueR5(3, true, false).voie, "plan_redressement");
assert.equal(issueR5(3, true, true).voie, "vote_art20");

/* ---------------------------------------------------- mois vise par la relance */

// Le 10 au matin, l'echeance du mois court encore : la relance porte sur le mois precedent.
assert.equal(moisARelancer(new Date("2026-09-10T08:00:00Z")), "2026-08-01");
// Le 11, le mois de septembre est devenu exigible.
assert.equal(moisARelancer(new Date("2026-09-11T08:00:00Z")), "2026-09-01");

console.log("OK - 29 verifications : performance, penalites art. 9 et R4, retards, R3, R5, relance");
