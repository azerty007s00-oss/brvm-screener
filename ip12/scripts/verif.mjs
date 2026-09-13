// Verification de la logique metier : calculs de performance et regime des retards.
// Lancement : npm run verif
import { strict as assert } from "node:assert";

const { tri, dietzModifie, repartirParts, dureeEnAnnees, dureeEnClair } = await import(
  "../.verif/perf.mjs"
);
const { situationMembre, calculerPenalites, issueR5, moisARelancer, tranchesAbsence } =
  await import("../.verif/penalites.mjs");

/* ------------------------------------------------------------- performance */

const r = tri([
  { date: "2025-01-01", montant: -1_000_000 },
  { date: "2026-01-01", montant: 1_344_000 },
]);
assert.ok(r !== null && Math.abs(r - 0.344) < 0.005, `TRI attendu ~0,344, obtenu ${r}`);

// Le taux rendu est annuel quelle que soit la duree : six mois a +20 % en tout
// s'annualisent a environ +44 %, et non a +20 %.
const rSemestre = tri([
  { date: "2026-01-01", montant: -1_000_000 },
  { date: "2026-07-02", montant: 1_200_000 },
]);
assert.ok(
  rSemestre !== null && rSemestre > 0.43 && rSemestre < 0.45,
  `TRI semestriel annualise attendu ~0,44, obtenu ${rSemestre}`,
);

// Et il porte sur toute la duree, chaque versement comptant depuis sa propre date :
// 1 000 000 verses en deux fois et valant 1 210 000 au bout de deux ans donnent 13,4 %
// par an -- 50x^2 + 50x = 121 pour x = 1 + r -- la ou le rapport brut, +21 % sur le
// total verse, melange deux annees de placement pour la premiere moitie et une pour
// la seconde.
const rEtale = tri([
  { date: "2024-09-13", montant: -500_000 },
  { date: "2025-09-13", montant: -500_000 },
  { date: "2026-09-13", montant: 1_210_000 },
]);
const attendu = (-50 + Math.sqrt(50 * 50 + 4 * 50 * 121)) / 100 - 1;
assert.ok(
  rEtale !== null && Math.abs(rEtale - attendu) < 1e-6,
  `TRI etale attendu ${attendu}, obtenu ${rEtale}`,
);

assert.ok(Math.abs(dureeEnAnnees("2025-01-01", "2026-01-01") - 1) < 0.01);
assert.equal(dureeEnClair(2.25), "2 ans et 3 mois");
assert.equal(dureeEnClair(1), "1 an");
assert.equal(dureeEnClair(0.5), "6 mois");

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

/* ------------------------------------------------- absences en reunion */

const reglesAbsence = { penaliteAbsence: 2_000, absencesParTranche: 2 };

// Une absence isolee ne coute rien : c'est la repetition qui est sanctionnee.
assert.deepEqual(tranchesAbsence(0, reglesAbsence), []);
assert.deepEqual(tranchesAbsence(1, reglesAbsence), []);

// La deuxieme ferme la tranche.
const uneTranche = tranchesAbsence(2, reglesAbsence);
assert.equal(uneTranche.length, 1);
assert.equal(uneTranche[0].rang, 1);
assert.equal(uneTranche[0].absenceDeclenchante, 2);
assert.equal(uneTranche[0].montant, 2_000);

// La troisieme ne rouvre rien ; la quatrieme ouvre la deuxieme tranche.
assert.equal(tranchesAbsence(3, reglesAbsence).length, 1);
const deuxTranches = tranchesAbsence(4, reglesAbsence);
assert.equal(deuxTranches.length, 2);
assert.equal(deuxTranches[1].rang, 2);
assert.equal(deuxTranches[1].absenceDeclenchante, 4);

// Les rangs sont stables : reconstater apres une absence de plus laisse les
// tranches deja portees au registre sous la meme cle.
assert.deepEqual(
  tranchesAbsence(5, reglesAbsence).slice(0, 2),
  tranchesAbsence(4, reglesAbsence),
);

// Un reglage absurde ne fait pas naitre de dette.
assert.deepEqual(tranchesAbsence(10, { penaliteAbsence: 2_000, absencesParTranche: 0 }), []);

/* ------------------------------------------------- regles individuelles */

// Regime commun : 10 % de 5 000.
assert.equal(calculerPenalites(["2026-07-01"])[0].montant, 500);

// Cotisation particuliere : la penalite suit la cotisation du membre.
assert.equal(
  calculerPenalites(["2026-07-01"], [], { cotisationMensuelle: 10_000 })[0].montant,
  1_000,
);

// Penalites majorees : le multiplicateur s'applique par-dessus le taux.
assert.equal(
  calculerPenalites(["2026-07-01"], [], { multiplicateurPenalite: 2 })[0].montant,
  1_000,
);

// Et par-dessus le doublement R4, sans le remplacer : 10 % x 2 (R4) x 2 (regle).
const majoreesR4 = calculerPenalites(
  ["2026-05-01", "2026-06-01", "2026-07-01"],
  [],
  { multiplicateurPenalite: 2 },
);
assert.equal(majoreesR4.length, 3);
assert.ok(majoreesR4.every((p) => p.doublee));
assert.equal(majoreesR4[0].montant, 2_000);

// Une derogation absente laisse le regime commun intact.
assert.equal(calculerPenalites(["2026-07-01"], [], {})[0].montant, 500);

console.log("OK - 51 verifications : performance, penalites art. 9 et R4, regles individuelles, retards, absences, R3, R5, relance");
