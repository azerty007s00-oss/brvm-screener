// Verification de la logique metier : calculs de performance et regime des retards.
// Lancement : npm run verif
import { strict as strict0 } from "node:assert";

/*
 * Le nombre annonce en fin de course etait tenu a la main, et il avait derive :
 * 102 y etait ecrit quand le fichier en portait davantage, sans compter celles
 * qui tournent dans une boucle. Il se compte desormais tout seul, et ne peut
 * plus mentir.
 */
let verifications = 0;
const assert = new Proxy(strict0, {
  apply(cible, _ceci, arguments_) {
    verifications++;
    return Reflect.apply(cible, undefined, arguments_);
  },
  get(cible, propriete) {
    const valeur = Reflect.get(cible, propriete);
    if (typeof valeur !== "function") return valeur;
    return (...arguments_) => {
      verifications++;
      return valeur.apply(cible, arguments_);
    };
  },
});

const { tri, dietzModifie, repartirParts, dureeEnAnnees, dureeEnClair } = await import(
  "../.verif/perf.mjs"
);
const {
  situationMembre, calculerPenalites, issueR5, moisARelancer, tranchesAbsence,
  dejaAuRegistre, cleRetard, echeanceDuMois,
} = await import("../.verif/penalites.mjs");
const { tauxNormalise, deMois, lienDuSite, premierDuMois, decalerMois } = await import(
  "../.verif/settings.mjs"
);

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

/* ------------------------------------------- repartition : avances et penalites */

const m = (membreId, nom, acquis, avance = 0, dues = 0) => ({ membreId, nom, acquis, avance, dues });

// Sans avance ni penalite : simple prorata du capital acquis.
const simple = repartirParts([m("a", "A", 200_000), m("b", "B", 100_000)], 600_000);
assert.ok(Math.abs(simple.find((p) => p.membreId === "a").part - 2 / 3) < 1e-9);
assert.equal(simple.find((p) => p.membreId === "a").valeur, 400_000);

/*
 * L'exemple du club : deux membres a capital acquis egal, un avoir de 50, dont
 * 5 avances par l'un. La part de l'autre vaut (50 - 5)/2 ; la sienne, (50 - 5)/2 + 5.
 */
const avanceParts = repartirParts([m("a", "A", 10, 5), m("b", "B", 10)], 50);
const aAvance = avanceParts.find((p) => p.membreId === "a");
const bAvance = avanceParts.find((p) => p.membreId === "b");
assert.equal(bAvance.valeur, 22.5, `attendu 22,5 pour B, obtenu ${bAvance.valeur}`);
assert.equal(aAvance.valeur, 27.5, `attendu 27,5 pour A, obtenu ${aAvance.valeur}`);
assert.equal(aAvance.valeur + bAvance.valeur, 50);

// L'avance ne rapporte rien : sur un avoir en hausse, elle reste rendue au nominal.
const gain = repartirParts([m("a", "A", 10, 5), m("b", "B", 10)], 105);
assert.equal(gain.find((p) => p.membreId === "a").valeur, 5 + 50);
assert.equal(gain.find((p) => p.membreId === "b").valeur, 50);

// Trois membres inegaux, une avance : le pot ampute se partage au prorata de l'acquis.
const trois = repartirParts([m("a", "A", 30, 5), m("b", "B", 20), m("c", "C", 10)], 100);
// A un centieme pres : le prorata s'applique avant la multiplication, l'ordre
// des operations decale le dernier bit.
const proche = (obtenu, attendu, quoi) =>
  assert.ok(Math.abs(obtenu - attendu) < 1e-9, `${quoi} : attendu ${attendu}, obtenu ${obtenu}`);
proche(trois.find((p) => p.membreId === "a").valeur, 5 + (95 * 30) / 60, "A");
proche(trois.find((p) => p.membreId === "b").valeur, (95 * 20) / 60, "B");
assert.ok(Math.abs(trois.reduce((t, p) => t + p.valeur, 0) - 100) < 1e-9);

// Penalite impayee : elle quitte le capital du fautif et dilue sa part au profit des autres.
const penalise = repartirParts([m("a", "A", 30, 0, 6), m("b", "B", 30)], 60);
const aPen = penalise.find((p) => p.membreId === "a");
const bPen = penalise.find((p) => p.membreId === "b");
assert.ok(Math.abs(aPen.valeur - (60 * 24) / 54) < 1e-9, `obtenu ${aPen.valeur}`);
assert.ok(Math.abs(bPen.valeur - (60 * 30) / 54) < 1e-9);
assert.ok(aPen.valeur < 30 && bPen.valeur > 30, "la penalite doit diluer le fautif");
assert.ok(Math.abs(aPen.valeur + bPen.valeur - 60) < 1e-9, "le partage reste exhaustif");

/*
 * Regularisation : la penalite reglee entre en caisse, donc dans l'avoir, et le
 * poids du membre est restaure. Les parts se reequilibrent -- mais l'argent, lui,
 * est sorti de sa poche : c'est en cela que la sanction demeure.
 */
const regularise = repartirParts([m("a", "A", 30), m("b", "B", 30)], 66);
assert.equal(regularise.find((p) => p.membreId === "a").valeur, 33);
assert.equal(regularise.find((p) => p.membreId === "b").valeur, 33);

// Penalites superieures au capital : le poids tombe a zero, jamais en dessous.
const ruine = repartirParts([m("a", "A", 10, 0, 50), m("b", "B", 30)], 60);
assert.equal(ruine.find((p) => p.membreId === "a").valeur, 0);
assert.equal(ruine.find((p) => p.membreId === "b").valeur, 60);

// Avances superieures a l'avoir constate : rien de negatif n'est reparti.
const excedent = repartirParts([m("a", "A", 10, 100), m("b", "B", 10)], 50);
assert.ok(excedent.every((p) => p.valeur >= 0));

// La plus-value se mesure sur tout ce qui a ete verse, avance comprise.
assert.equal(aAvance.verse, 15);
assert.equal(aAvance.plusValue, 27.5 - 15);

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

/* ------------------ penalites indissociables des cotisations (effet differe) */

const avantEffet = new Date("2026-12-31T12:00:00Z");
const apresEffet = new Date("2027-01-10T12:00:00Z");

// Cotisations a jour, trois penalites impayees : rien avant la date d'effet.
const aJourAvant = situationMembre("m", ["2026-01-01"], [
  { mois_couvert: "2026-01-01", montant: 5000, statut: "valide", date_versement: "2026-01-05" },
], [], avantEffet, undefined, {}, 3);
assert.equal(aJourAvant.exclusionParPenalites, false, "la regle ne retroagit pas");
assert.equal(aJourAvant.exclusionEncourue, false);

// La meme situation, a la date d'effet : exclusion encourue par les seules penalites.
const aJourApres = situationMembre("m", ["2026-01-01"], [
  { mois_couvert: "2026-01-01", montant: 5000, statut: "valide", date_versement: "2026-01-05" },
], [], apresEffet, undefined, {}, 3);
assert.equal(aJourApres.exclusionParPenalites, true);
assert.equal(aJourApres.exclusionEncourue, true, "3 penalites impayees exposent a l'exclusion");

// Deux penalites ne suffisent pas : le seuil est bien de trois.
const deuxSeulement = situationMembre("m", ["2026-01-01"], [
  { mois_couvert: "2026-01-01", montant: 5000, statut: "valide", date_versement: "2026-01-05" },
], [], apresEffet, undefined, {}, 2);
assert.equal(deuxSeulement.exclusionEncourue, false);

// Cotisations a jour + penalites : exclusion de plein droit, R3 n'a pas a proteger.
const parPenalites = issueR5(0, true, false, 3, apresEffet);
assert.equal(parPenalites.applicable, true);
assert.equal(parPenalites.voie, "exclusion_plein_droit");
assert.ok(/indissociables/.test(parPenalites.texte));

// Avant la date d'effet, la meme situation n'ouvre aucune voie.
assert.equal(issueR5(0, true, false, 3, avantEffet).applicable, false);

/*
 * Le membre en retard de cotisations qui a declare (R3) garde son plan : la regle
 * nouvelle ne doit pas rendre lettre morte la branche que R5 lui reserve. Mais le
 * plan porte alors sur l'ensemble de sa dette, penalites comprises.
 */
const planAvecPenalites = issueR5(3, true, false, 3, apresEffet);
assert.equal(planAvecPenalites.voie, "plan_redressement");
assert.ok(/l'ensemble de sa dette/.test(planAvecPenalites.texte));

// Retard non declare : l'exclusion de plein droit prime, comme avant.
assert.equal(issueR5(3, false, false, 3, apresEffet).voie, "exclusion_plein_droit");

/* --------------------------- taux de penalite : deux conventions, une lecture */

// La convention du code : une fraction.
assert.equal(tauxNormalise(0.1), 0.1);
assert.equal(tauxNormalise(1), 1);

/*
 * Celle de l'application precedente : un pourcentage. Lu tel quel, 10 valait
 * 1 000 %, et la penalite d'un mois passait de 500 a 50 000 FCFA.
 */
assert.equal(tauxNormalise(10), 0.1, "10 doit se lire 10 %");
assert.equal(tauxNormalise(60), 0.6);
assert.equal(tauxNormalise(100), 1);

// Au-dela de 100 %, ce n'est plus un taux : on le rejette plutot que de l'appliquer.
assert.equal(tauxNormalise(101), null);
assert.equal(tauxNormalise(1000), null);
assert.equal(tauxNormalise(0), null);
assert.equal(tauxNormalise(-5), null);
assert.equal(tauxNormalise(Number.NaN), null);

// Le calcul obeit au taux regle par le bureau, non a la seule constante.
assert.equal(calculerPenalites(["2026-07-01"], [], { tauxPenalite: 0.2 })[0].montant, 1000);
assert.equal(calculerPenalites(["2026-07-01"], [], { tauxPenalite: 0.1 })[0].montant, 500);

// Et il se combine au doublement R4 comme le taux des statuts.
const r4Regle = calculerPenalites(
  ["2026-05-01", "2026-06-01", "2026-07-01"],
  [],
  { tauxPenalite: 0.2 },
);
assert.ok(r4Regle.every((p) => p.doublee));
assert.equal(r4Regle[0].montant, 2000);

/* --------------------------------------- elision devant les mois a voyelle */

/*
 * Trois mois commencent par une voyelle -- avril, aout, octobre -- et « de
 * octobre » saute aux yeux dans un courrier adresse a dix personnes. On teste
 * le prefixe, non le nom du mois : celui-ci porte des accents que la locale
 * rend, et les reecrire ici n'eprouverait que ma copie.
 */
for (const mois of ["2026-04-01", "2026-08-01", "2026-10-01"]) {
  assert.ok(deMois(mois).startsWith("d'"), `${mois} doit prendre l'elision : ${deMois(mois)}`);
}
for (const mois of ["2026-01-01", "2026-03-01", "2026-12-01"]) {
  assert.ok(deMois(mois).startsWith("de "), `${mois} ne prend pas l'elision : ${deMois(mois)}`);
}
assert.equal(deMois("2026-10-01"), "d'octobre 2026");
assert.equal(deMois("2026-01-01"), "de janvier 2026");

/* ------------------------------------------------ versements partiels (2026-09) */

/*
 * Decision d'assemblee : un mois paye en partie reste en retard, le complement
 * reste possible, et la penalite porte sur la cotisation entiere. Les trois
 * regles se tiennent -- sans la premiere, verser 100 F suffirait a effacer une
 * penalite ; sans la deuxieme, un acompte fermerait le mois a jamais.
 */
const septembre = new Date("2026-09-20T12:00:00Z");
const moisPartiel = ["2026-09-01"];

// 2 000 sur 5 000, echeance passee : le mois reste du, et il est dit incomplet.
const partiel = situationMembre(
  "p1",
  moisPartiel,
  [{ mois_couvert: "2026-09-01", montant: 2000, statut: "valide", date_versement: "2026-09-03" }],
  [],
  septembre,
);
assert.equal(partiel.cellules[0].statut, "partiel", "un mois incomplet n'est pas un mois paye");
assert.equal(partiel.cellules[0].montant, 2000);
assert.equal(partiel.cellules[0].manque, 3000, "le reste a verser doit etre affiche");
assert.equal(partiel.nbMoisRetard, 1, "un mois incomplet compte comme un retard");

// La penalite porte sur la cotisation entiere, jamais sur le seul reliquat.
assert.equal(
  partiel.totalPenalites,
  500,
  `penalite attendue 500 (10 % de 5 000), obtenue ${partiel.totalPenalites}`,
);
const rienVerse = situationMembre("p2", moisPartiel, [], [], septembre);
assert.equal(
  partiel.totalPenalites,
  rienVerse.totalPenalites,
  "verser un acompte ne doit pas reduire la penalite",
);

// Le complement solde le mois : deux lignes, 2 000 puis 3 000.
const complete = situationMembre(
  "p3",
  moisPartiel,
  [
    { mois_couvert: "2026-09-01", montant: 2000, statut: "valide", date_versement: "2026-09-03" },
    { mois_couvert: "2026-09-01", montant: 3000, statut: "valide", date_versement: "2026-09-08" },
  ],
  [],
  septembre,
);
assert.equal(complete.cellules[0].statut, "paye", "deux acomptes avant le 10 soldent le mois");
assert.equal(complete.cellules[0].montant, 5000);
assert.equal(complete.cellules[0].manque, 0);
assert.equal(complete.nbMoisRetard, 0);
assert.equal(complete.totalPenalites, 0);

/*
 * Le mois est solde a la date du versement qui le complete, non a celle du
 * premier acompte : 2 000 le 5, 3 000 le 15, c'est une regularisation en retard.
 * La penalite de l'art. 9 reste due, "definitivement acquise au benefice du club".
 */
const tardif = situationMembre(
  "p4",
  moisPartiel,
  [
    { mois_couvert: "2026-09-01", montant: 2000, statut: "valide", date_versement: "2026-09-05" },
    { mois_couvert: "2026-09-01", montant: 3000, statut: "valide", date_versement: "2026-09-15" },
  ],
  [],
  septembre,
);
assert.equal(tardif.cellules[0].statut, "paye_en_retard", "c'est la date du solde qui compte");
assert.equal(tardif.cellules[0].dateVersement, "2026-09-15");
assert.equal(tardif.nbMoisRetard, 0, "le mois est couvert, il n'est plus un retard");
assert.equal(tardif.totalPenalites, 500, "mais la penalite de retard reste due");

// Le compte n'y est qu'avec une declaration non validee : c'est au tresorier de trancher.
const attenteDeSolde = situationMembre(
  "p5",
  moisPartiel,
  [
    { mois_couvert: "2026-09-01", montant: 2000, statut: "valide", date_versement: "2026-09-03" },
    { mois_couvert: "2026-09-01", montant: 3000, statut: "en_attente", date_versement: "2026-09-04" },
  ],
  [],
  septembre,
);
assert.equal(attenteDeSolde.cellules[0].statut, "en_attente");
assert.equal(attenteDeSolde.nbMoisRetard, 0, "la validation est en cours, pas un retard");

// Un acompte avant l'echeance ne fait pas un retard, mais le manque est connu.
const acompteTot = situationMembre(
  "p6",
  moisPartiel,
  [{ mois_couvert: "2026-09-01", montant: 2000, statut: "valide", date_versement: "2026-09-02" }],
  [],
  new Date("2026-09-05T12:00:00Z"),
);
assert.equal(acompteTot.cellules[0].statut, "a_venir");
assert.equal(acompteTot.cellules[0].manque, 3000);
assert.equal(acompteTot.nbMoisRetard, 0);

// Cotisation particuliere : le seuil de couverture suit la derogation.
const derogue = situationMembre(
  "p7",
  moisPartiel,
  [{ mois_couvert: "2026-09-01", montant: 3000, statut: "valide", date_versement: "2026-09-03" }],
  [],
  septembre,
  undefined,
  { cotisationMensuelle: 3000 },
);
assert.equal(derogue.cellules[0].statut, "paye", "3 000 soldent un membre a 3 000");
assert.equal(derogue.cellules[0].requis, 3000);
assert.equal(derogue.nbMoisRetard, 0);


/* ------------------------------------- frais preleves dans le compte-titres */

/*
 * La SGI preleve sa commission directement dans le compte-titres, sans virement
 * qui l'accompagne. Une telle ligne porte un montant nul.
 *
 * Le taux ne s'en trouve pas change : un flux nul ne pese pas dans la valeur
 * actuelle nette, quelle que soit sa date. C'est verifie ici parce que j'avais
 * suppose l'inverse -- et que la raison d'ecarter ces lignes du calcul n'est
 * donc pas le taux, mais la periode affichee a cote de lui, qui partirait du
 * jour d'un prelevement de frais et annoncerait un placement plus ancien qu'il
 * n'est.
 */
const triSansFluxNul = tri([
  { date: "2026-01-01", montant: -1_000_000 },
  { date: "2027-01-01", montant: 1_200_000 },
]);
const triAvecFluxNul = tri([
  { date: "2025-01-01", montant: 0 },
  { date: "2026-01-01", montant: -1_000_000 },
  { date: "2027-01-01", montant: 1_200_000 },
]);
assert.ok(triSansFluxNul !== null && triAvecFluxNul !== null, "les deux TRI doivent etre calculables");
assert.ok(
  Math.abs(triSansFluxNul - triAvecFluxNul) < 1e-9,
  `un flux nul ne doit pas deplacer le taux (${triSansFluxNul} contre ${triAvecFluxNul})`,
);
assert.ok(
  Math.abs(triSansFluxNul - 0.2) < 0.001,
  `TRI attendu ~0,20, obtenu ${triSansFluxNul}`,
);


/* ------------------------------------------------- adresse du site */

/*
 * Les courriers accrochent des chemins a l'adresse du site. Une barre oblique
 * finale -- celle que laisse un copier-coller depuis la barre du navigateur --
 * donnerait « https://site//versements ». Elle est retiree a la lecture.
 */
for (const [pose, attendu] of [
  ["https://ip12.vercel.app", "https://ip12.vercel.app"],
  ["https://ip12.vercel.app/", "https://ip12.vercel.app"],
  ["https://ip12.vercel.app///", "https://ip12.vercel.app"],
  ["  https://ip12.vercel.app/  ", "https://ip12.vercel.app"],
  ["", ""],
]) {
  process.env.NEXT_PUBLIC_SITE_URL = pose;
  assert.equal(lienDuSite(), attendu, `adresse « ${pose} » mal normalisee`);
}
delete process.env.NEXT_PUBLIC_SITE_URL;
assert.equal(lienDuSite(), "", "adresse absente : chaine vide, jamais undefined");


/* --------------------------------------------- mois saisi au navigateur */

/*
 * Un `<input type="month">` envoie sept caracteres, « 2026-08 », quand la base
 * range les periodes au premier du mois. L'action de declaration en exigeait
 * dix : aucune declaration ne pouvait aboutir, et le message accusait
 * l'utilisateur d'une faute qu'il n'avait pas commise. Defaut trouve en
 * production par le tresorier, un mois apres la mise en ligne.
 */
assert.equal(premierDuMois("2026-08"), "2026-08-01", "le champ mois du navigateur doit passer");
assert.equal(premierDuMois("2026-08-17"), "2026-08-01", "une date complete est ramenee au 1er");
assert.equal(premierDuMois("  2026-08  "), "2026-08-01", "les espaces autour ne genent pas");
assert.equal(premierDuMois("2026-1"), null, "un mois sans zero initial est refuse");
assert.equal(premierDuMois("2026-13"), null, "le treizieme mois n'existe pas");
assert.equal(premierDuMois("2026-00"), null, "le mois zero n'existe pas");
assert.equal(premierDuMois(""), null, "une saisie vide est refusee");
assert.equal(premierDuMois("aout 2026"), null, "du texte est refuse");

/*
 * Le cas signale : trois mois d'avance a partir d'aout 2026. Les periodes
 * ecrites doivent etre aout, septembre et octobre, chacune au premier du mois.
 */
const depart = premierDuMois("2026-08");
const couverts = [0, 1, 2].map((i) => decalerMois(depart, i));
assert.deepEqual(
  couverts,
  ["2026-08-01", "2026-09-01", "2026-10-01"],
  `trois mois a partir d'aout 2026 : ${couverts.join(", ")}`,
);


/* --------------------------------- rapprochement avec le registre des penalites */

/*
 * La page listait « a constater » ce que l'action reconnaissait deja : elle ne
 * rapprochait que par la cle, l'action rapprochait aussi par le couple
 * membre-echeance et sautait ce que la reprise du tresorier couvrait. Le bureau
 * appuyait sur le bouton, rien ne se creait, et la liste ne desemplissait pas.
 * La regle est desormais unique, et tenue ici.
 */
const MEMBRE = "11111111-1111-1111-1111-111111111111";
assert.equal(cleRetard(MEMBRE, "2026-08-01"), `retard:${MEMBRE}:2026-08-01`);
assert.equal(echeanceDuMois("2026-08-01"), "2026-08-10", "l'echeance est le 10 du mois");

// Rien au registre : la penalite est bien a constater.
assert.equal(dejaAuRegistre(MEMBRE, "2026-08-01", []), false);

// Portee sous la cle actuelle.
assert.equal(
  dejaAuRegistre(MEMBRE, "2026-08-01", [
    { membreId: MEMBRE, nature: "retard", dateConstat: "2026-08-10", cle: cleRetard(MEMBRE, "2026-08-01") },
  ]),
  true,
);

// Portee par une version anterieure : cle absente, mais membre et echeance concordent.
assert.equal(
  dejaAuRegistre(MEMBRE, "2026-08-01", [
    { membreId: MEMBRE, nature: "retard", dateConstat: "2026-08-10", cle: null },
  ]),
  true,
  "une ligne sans cle mais a la bonne echeance est deja portee",
);

// Une cle d'une autre convention, meme echeance : reconnue aussi.
assert.equal(
  dejaAuRegistre(MEMBRE, "2026-08-01", [
    { membreId: MEMBRE, nature: "retard", dateConstat: "2026-08-10T00:00:00Z", cle: "retard:2026-08" },
  ]),
  true,
  "l'horodatage complet ne doit pas empecher le rapprochement",
);

// Le bon mois, mais un autre membre : toujours a constater.
assert.equal(
  dejaAuRegistre(MEMBRE, "2026-08-01", [
    { membreId: "22222222-2222-2222-2222-222222222222", nature: "retard", dateConstat: "2026-08-10", cle: null },
  ]),
  false,
);

// Le bon membre, mais une absence : une nature ne vaut pas l'autre.
assert.equal(
  dejaAuRegistre(MEMBRE, "2026-08-01", [
    { membreId: MEMBRE, nature: "absence", dateConstat: "2026-08-10", cle: null },
  ]),
  false,
);

// Couverte par la reprise manuelle du tresorier.
assert.equal(dejaAuRegistre(MEMBRE, "2026-06-01", [], "2026-07-01"), true, "sous la borne : deja compte");
assert.equal(dejaAuRegistre(MEMBRE, "2026-08-01", [], "2026-07-01"), false, "au-dela : a constater");


/* ------------------------------- ouverture du compte-titres et periode du TRI */

/*
 * Les premiers virements portent la date a laquelle l'argent a quitte la
 * caisse, plusieurs semaines avant l'ouverture du compte chez la SGI : il a
 * dormi en transit, il n'etait pas place. Les compter comme investis des ce
 * jour-la allonge la periode et abaisse le taux annualise -- le club
 * annoncerait moins que ce qu'il a obtenu.
 *
 * La regle : un flux anterieur a l'ouverture est ramene au jour de l'ouverture.
 */
const OUVERTURE = "2023-07-17";
const ramener = (d) => (d < OUVERTURE ? OUVERTURE : d);
assert.equal(ramener("2023-06-01"), OUVERTURE, "un virement anterieur est ramene a l'ouverture");
assert.equal(ramener("2023-07-17"), "2023-07-17", "le jour meme ne bouge pas");
assert.equal(ramener("2024-05-13"), "2024-05-13", "un virement posterieur garde sa date");

// A capital et valeur finale egaux, une periode plus courte donne un taux plus eleve.
const fluxLong = [
  { date: "2023-06-01", montant: -1_000_000 },
  { date: "2026-09-17", montant: 3_000_000 },
];
const fluxCourt = [
  { date: OUVERTURE, montant: -1_000_000 },
  { date: "2026-09-17", montant: 3_000_000 },
];
const tLong = tri(fluxLong);
const tCourt = tri(fluxCourt);
assert.ok(tLong !== null && tCourt !== null, "les deux taux doivent etre calculables");
assert.ok(
  tCourt > tLong,
  `ramener le depart releve le taux annualise (${tLong} contre ${tCourt})`,
);

// La duree annoncee suit le depart retenu, non la date de sortie de caisse.
assert.ok(
  dureeEnAnnees(OUVERTURE, "2026-09-17") < dureeEnAnnees("2023-06-01", "2026-09-17"),
  "la periode affichee se raccourcit d'autant",
);


console.log(
  `OK - ${verifications} verifications : performance, parts et avances, ` +
    "penalites art. 9, R4 et indissociabilite, versements partiels, regles " +
    "individuelles, retards, absences, R3, R5, relance",
);
