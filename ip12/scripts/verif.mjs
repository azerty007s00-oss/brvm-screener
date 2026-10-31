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

const { tri, dietzModifie, repartirParts, dureeEnAnnees, dureeEnClair, pourcent, decompteSortie, etatCaisse, fraisGardeCourus, potAPartager, partagerSortie } = await import(
  "../.verif/perf.mjs"
);
const { courrielSortie, courrielCorrectionSortie, echeanceRemboursement, pointsAVerifier, empreinteSortie, lignesValorisation, lignesPartage, premierMoisDeLaPart, nomDeLaPart, lignesNouvellesParts, courrielValorisation, lignesValeurDeLaPart, arrieresAvant, listeDesMois } = await import("../.verif/sortie.mjs");
const {
  situationMembre, calculerPenalites, issueR5, moisARelancer, tranchesAbsence,
  dejaAuRegistre, cleRetard, echeanceDuMois, phaseSeuilR5,
  prochainReglement, montantsParMois, imputer, imputerPenalites, cotisationsARegler,
  etatAvance, cotisationDuMois,
} = await import("../.verif/penalites.mjs");
const {
  tauxNormalise, deMois, lienDuSite, premierDuMois, decalerMois, nombre, fcfa,
  joursAvantEcheance, etatEcheance, nomCourt } = await import(
  "../.verif/settings.mjs"
);
const { statutLigne, statutAvances, estEntame, moisCourt, initialeMois, resumeFrise, LIBELLE_STATUT } = await import(
  "../.verif/etats.mjs"
);
const { borne, retenus, tracable, reperesTemps } = await import("../.verif/horizons.mjs");
const { netPlaceParDate, decomposer, gainConcorde } = await import("../.verif/placement.mjs");

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
const proche0 = (obtenu, attendu, quoi) =>
  assert.ok(Math.abs(obtenu - attendu) < 1e-6, `${quoi} : attendu ${attendu}, obtenu ${obtenu}`);

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

/*
 * Une part rachetee : son poids (les cotisations du sortant) fixe sa valeur, mais
 * sa plus-value se mesure sur le prix paye au sortant et ses propres cotisations.
 * Le rachat de KONE Bourama : 97 500 de poids recu, 175 000 payes ; elle affichait
 * +78 490, le gain des cotisations du sortant depuis des annees.
 */
const avecPart = repartirParts(
  [m("a", "A", 195_000), { ...m("p", "Part", 97_500 + 7_500), rachat: { poids: 97_500, prix: 175_000 } }],
  550_000,
);
const laPart = avecPart.find((p) => p.membreId === "p");
assert.equal(laPart.verse, 175_000 + 7_500, "verse d'une part : le prix paye et ses propres cotisations");
proche0(laPart.plusValue, laPart.valeur - 182_500, "plus-value d'une part, sur le prix paye");
assert.equal(
  avecPart.find((p) => p.membreId === "a").verse,
  195_000,
  "une personne garde son verse : ses cotisations",
);
assert.ok(Math.abs(laPart.part - 105_000 / 300_000) < 1e-12, "le poids, lui, fixe toujours la part du pot");

// Trois membres inegaux, une avance : le pot ampute se partage au prorata de l'acquis.
const trois = repartirParts([m("a", "A", 30, 5), m("b", "B", 20), m("c", "C", 10)], 100);
// A un centieme pres : le prorata s'applique avant la multiplication, l'ordre
// des operations decale le dernier bit.
const proche = (obtenu, attendu, quoi) =>
  assert.ok(Math.abs(obtenu - attendu) < 1e-9, `${quoi} : attendu ${attendu}, obtenu ${obtenu}`);
proche(trois.find((p) => p.membreId === "a").valeur, 5 + (95 * 30) / 60, "A");
proche(trois.find((p) => p.membreId === "b").valeur, (95 * 20) / 60, "B");
assert.ok(Math.abs(trois.reduce((t, p) => t + p.valeur, 0) - 100) < 1e-9);

// Penalite impayee : une dette a son montant. Le pot la porte comme creance, la part du fautif la rend.
const penalise = repartirParts([m("a", "A", 30, 0, 6), m("b", "B", 30)], 60);
const aPen = penalise.find((p) => p.membreId === "a");
const bPen = penalise.find((p) => p.membreId === "b");
assert.equal(aPen.part, 0.5, "la penalite ne touche plus au poids");
assert.equal(aPen.valeur, 33 - 6, `obtenu ${aPen.valeur}`);
assert.equal(bPen.valeur, 33);
assert.ok(Math.abs(aPen.valeur + bPen.valeur - 60) < 1e-9, "le partage reste exhaustif");

/*
 * Regularisation : la penalite reglee entre en caisse, donc dans l'avoir, et la
 * dette disparait. La part du membre gagne exactement ce qu'il a paye : payer ou
 * ne pas payer ne change rien a sa valeur nette.
 */
const regularise = repartirParts([m("a", "A", 30), m("b", "B", 30)], 66);
assert.equal(regularise.find((p) => p.membreId === "a").valeur, 33);
assert.equal(regularise.find((p) => p.membreId === "b").valeur, 33);
assert.equal(
  regularise.find((p) => p.membreId === "a").valeur - 6,
  aPen.valeur,
  "neutralite : paye ou du, la penalite coute son montant",
);
assert.equal(regularise.find((p) => p.membreId === "b").valeur, bPen.valeur, "l'autre membre n'y gagne ni n'y perd");

// Penalites superieures a sa part : il doit au club plus qu'il n'y detient.
const ruine = repartirParts([m("a", "A", 10, 0, 50), m("b", "B", 30)], 60);
assert.equal(ruine.find((p) => p.membreId === "a").valeur, 110 * 0.25 - 50);
assert.equal(ruine.find((p) => p.membreId === "b").valeur, 110 * 0.75);
assert.equal(ruine.reduce((t, p) => t + p.valeur, 0), 60);

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

/*
 * LA COTISATION DATEE. Une part rachetee fusionnee ajoute sa fraction a partir
 * de la premiere echeance qui suit le rachat, jamais avant : les mois anterieurs,
 * payes 5 000, restent payes. Une cotisation particuliere a debut et fin ne
 * vaut que dans sa periode.
 */
{
  const fusion = { supplements: [{ debut: "2026-11-01", montant: 2_500 }] };
  assert.equal(cotisationDuMois(fusion, "2026-10-01"), 5_000, "avant la fusion, la cotisation d'alors");
  assert.equal(cotisationDuMois(fusion, "2026-11-01"), 7_500, "a partir de novembre, 5 000 + 2 500");
  const datee = { paliers: [{ debut: "2026-06-01", montant: 7_000 }, { debut: "2026-09-01", montant: null }] };
  assert.equal(cotisationDuMois(datee, "2026-05-01"), 5_000, "avant son debut, la cotisation commune");
  assert.equal(cotisationDuMois(datee, "2026-07-01"), 7_000, "pendant sa periode, la cotisation particuliere");
  assert.equal(cotisationDuMois(datee, "2026-09-01"), 5_000, "apres sa fin, retour a la commune");

  const mois = ["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"];
  const vers = [
    { mois_couvert: "2026-08-01", montant: 5000, statut: "valide", date_versement: "2026-08-05" },
    /* La cotisation impayee du sortant, reprise au rachat le 11/10 : en plus des 5 000 du mois. */
    { mois_couvert: "2026-08-01", montant: 2500, statut: "en_attente", date_versement: "2026-10-11" },
    { mois_couvert: "2026-09-01", montant: 5000, statut: "valide", date_versement: "2026-09-05" },
    { mois_couvert: "2026-10-01", montant: 5000, statut: "valide", date_versement: "2026-10-05" },
    { mois_couvert: "2026-11-01", montant: 5000, statut: "valide", date_versement: "2026-10-10" },
  ];
  const avant = situationMembre("f", mois, vers, [], new Date("2026-11-05T12:00:00Z"), undefined, fusion);
  assert.deepEqual(avant.cellules.map((c) => c.statut), ["paye", "paye", "paye", "a_venir"],
    "les mois d'avant la fusion restent payes, la reprise ne les met pas en retard");
  assert.equal(avant.cellules[3].manque, 2_500, "novembre : il manque les 2 500 de la part rachetee");
  assert.equal(avant.totalPenalites, 0, "aucune penalite sur les mois d'avant");
  const apres = situationMembre("f", mois, vers, [], new Date("2026-11-11T12:00:00Z"), undefined, fusion);
  assert.equal(apres.cellules[3].statut, "partiel", "passe le 10, novembre a 5 000 sur 7 500 est en retard");
  assert.equal(apres.penalites.find((x) => x.mois === "2026-11-01").montant, 750, "la penalite porte sur 7 500");
  assert.equal(prochainReglement(apres.cellules, montantsParMois(vers), (m) => cotisationDuMois(fusion, m)).reste,
    2_500, "le formulaire propose les 2 500 qui manquent");
}

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


// Le signe d'un pourcentage : un moins typographique, qui s'aligne sur le plus.
assert.equal(pourcent(0.026), "+2,6 %");
assert.equal(pourcent(-0.051), "\u22125,1 %");
assert.equal(pourcent(null), "--");
assert.equal(pourcent(0.376, 1), "+37,6 %");

/* ------------------------------------------------------- etats et vocabulaire */

const cel = (mois, statut) => ({ mois, statut, montant: 0, requis: 5000, manque: 0, dateVersement: null });

// Les mois nommes suivent le calendrier, quel que soit leur etat. La premiere
// version listait les retards puis les incomplets : « Retard : juin, avr. ».
assert.equal(
  statutLigne([cel("2026-04-01", "partiel"), cel("2026-05-01", "paye"), cel("2026-06-01", "retard")]).texte,
  "Retard : avr., juin",
  "les mois dus se nomment dans l'ordre du calendrier",
);

// Ce qui manque prime sur ce qui attend, et ce qui attend sur ce qui est en regle.
assert.equal(
  statutLigne([cel("2026-05-01", "en_attente"), cel("2026-06-01", "retard")]).texte,
  "Retard : juin",
  "un mois du l'emporte sur un mois en attente",
);
assert.equal(
  statutLigne([cel("2026-05-01", "paye"), cel("2026-06-01", "en_attente")]).texte,
  "En attente : juin",
  "a defaut de retard, l'attente est ce qui reste a dire",
);
assert.equal(statutLigne([cel("2026-05-01", "paye")]).texte, "À jour");

// Au-dela de deux mois, on compte au lieu d'enumerer : la phrase doit tenir a
// cote du nom, sinon le navigateur coupe les deux.
assert.equal(
  statutLigne([
    cel("2026-03-01", "retard"), cel("2026-04-01", "retard"),
    cel("2026-05-01", "retard"), cel("2026-06-01", "retard"),
  ]).texte,
  "Retard : mars, avr. +2",
  "trois mois et plus se resument",
);

// Une avance porte sur un mois futur : elle se dit, sans rien changer aux droits.
{
  const futur = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 2, 1))
    .toISOString()
    .slice(0, 10);
  const r = statutLigne([cel("2026-01-01", "paye"), cel(futur, "paye")]);
  assert.ok(r.texte.startsWith("À jour, avance "), `avance attendue, obtenu « ${r.texte} »`);
}

// Les mois hors periode -- avant l'entree du membre -- ne comptent pas.
assert.equal(statutLigne([cel("2026-01-01", "hors_periode"), cel("2026-02-01", "paye")]).texte, "À jour");

/* Les mois a venir : ce que la vue « À venir » du registre dit de chaque ligne. */
{
  const oct = new Date("2026-10-27T12:00:00Z");
  const fut = (mois, montant, requis = 7500) => {
    const statut = montant >= requis ? "paye" : "a_venir";
    return { mois, statut, montant, requis, manque: Math.max(0, requis - montant), dateVersement: null };
  };
  // Une avance payee a 5 000 quand la cotisation passe a 7 500 : a completer, et le mois nomme.
  const drame = [fut("2026-11-01", 5000), fut("2026-12-01", 5000), fut("2027-01-01", 5000), fut("2027-02-01", 0)];
  assert.ok(estEntame(drame[0]) && !estEntame(drame[3]), "un mois vide n'est pas une avance entamée");
  assert.equal(statutAvances(drame, oct).texte, "À compléter : nov., déc. +1");
  // Une avance complete, sans trou : jusqu'ou elle va, l'annee dite quand elle change.
  const soro = [fut("2026-11-01", 7500), fut("2026-12-01", 7500), fut("2027-01-01", 0)];
  assert.equal(statutAvances(soro, oct).texte, "Payé jusqu'à déc.");
  assert.equal(
    statutAvances([fut("2026-11-01", 5000, 5000), fut("2026-12-01", 5000, 5000), fut("2027-01-01", 5000, 5000)], oct).texte,
    "Payé jusqu'à janv. 2027",
  );
  // Un trou arrete la couverture : fevrier paye ne fait pas une avance jusqu'a fevrier.
  assert.equal(statutAvances([fut("2026-11-01", 0, 5000), fut("2026-12-01", 5000, 5000)], oct).texte, "Pas d'avance");
  assert.equal(
    statutAvances([{ ...fut("2026-11-01", 7500), statut: "en_attente" }], oct).texte,
    "En attente : nov.",
  );
}

// Abreviations : avec leurs accents, comme le reste du site, et distinctes deux a deux.
assert.equal(moisCourt("2026-08-01"), "août");
assert.equal(moisCourt("2026-02-01"), "févr.");
assert.equal(moisCourt("2026-12-01"), "déc.");
assert.equal(moisCourt("2026-01-01"), "janv.");
assert.equal(initialeMois("2026-09-01"), "S");
assert.equal(LIBELLE_STATUT.paye, "Payé", "les libelles d'etat portent leurs accents");

// Le resume parle a qui ecoute la page : il compte, et il ignore le hors-periode.
assert.equal(
  resumeFrise([cel("2026-01-01", "hors_periode"), cel("2026-02-01", "paye"), cel("2026-03-01", "retard")], "Awa"),
  "Awa, 2 mois : 1 payé, 1 en retard",
);


/* ---------------------------------------------- horizons du graphique */

// L'exercice part du 1er janvier de l'annee du dernier releve, et le retient
// s'il tombe ce jour-la : la borne est inclusive.
assert.equal(borne("exercice", "2026-09-28"), "2026-01-01");
assert.equal(borne("origine", "2026-09-28"), null);

// Trois mois se comptent en mois, non en 90 jours.
assert.equal(borne("trimestre", "2026-09-28"), "2026-06-28");
// Et par-dessus le changement d'annee.
assert.equal(borne("trimestre", "2026-02-10"), "2025-11-10");
// Un mois plus court ne fait pas deborder la date sur le suivant : le 31 mai
// moins trois mois donne le 28 fevrier, non le 2 mars.
assert.equal(borne("trimestre", "2026-05-31"), "2026-02-28");
assert.equal(borne("trimestre", "2024-05-31"), "2024-02-29", "annee bissextile");

{
  const releves = [
    { date: "2023-07-17", valeur: 900_000 },
    { date: "2026-01-01", valeur: 2_100_000 },
    { date: "2026-06-28", valeur: 2_820_000 },
    { date: "2026-09-28", valeur: 3_857_845 },
  ];
  assert.equal(retenus(releves, "origine").length, 4);
  // Le releve du 1er janvier appartient a l'exercice.
  assert.equal(retenus(releves, "exercice").length, 3);
  // Celui du 28 juin appartient au trimestre : la borne est inclusive.
  assert.equal(retenus(releves, "trimestre").length, 2);
  assert.ok(tracable(releves, "trimestre"));
}

// Une periode qui ne porte qu'un releve ne se trace pas : l'ecran le dit
// plutot que de dessiner une ligne entre un point et rien.
assert.equal(
  tracable([{ date: "2026-01-05", valeur: 1 }, { date: "2026-09-28", valeur: 2 }], "trimestre"),
  false,
);

/* ------------------------------------------------- net place et gain de gestion */

/*
 * LE GRAND CONTROLE : la decomposition du graphique et le Dietz de la synthese
 * doivent tomber sur le meme gain.
 *
 * Ils suivent deux chemins independants. Le graphique fait
 * (V fin - V debut) - (net place fin - net place debut) a partir des releves
 * traces. La synthese fait V1 - V0 - C a partir des apports bruts. Si les deux
 * divergent, l'un des deux ment, et la page montre deux verites.
 */
{
  const apports = [
    { date: "2025-11-20", montant: 300_000, sens: "vers_titres" },
    { date: "2026-02-10", montant: 400_000, sens: "vers_titres" },
    { date: "2026-05-04", montant: 350_000, sens: "vers_titres" },
    { date: "2026-06-18", montant: 66_280, sens: "retrait" },
    { date: "2026-09-28", montant: 0, sens: "vers_titres" },
  ];
  const net = (a) => (a.sens === "retrait" ? -a.montant : a.montant);
  const flux = apports.map((a) => ({ date: a.date, net: net(a) }));

  const dates = ["2026-01-01", "2026-03-15", "2026-09-28"];
  const places = netPlaceParDate(dates, flux);

  // Le virement du 20 novembre precede l'exercice : il compte au 1er janvier.
  assert.equal(places[0], 300_000);
  assert.equal(places[1], 700_000);
  // Au plus tard ce jour-la : le mouvement du 28 septembre est dans le releve
  // du 28 septembre. L'en exclure ferait passer son montant pour un gain.
  assert.equal(places[2], 300_000 + 400_000 + 350_000 - 66_280);

  const valeurs = [2_166_323, 2_800_000, 3_857_845];
  const traces = dates.map((d, i) => ({ date: d, valeur: valeurs[i], netPlace: places[i] }));
  const part = decomposer(traces);

  assert.equal(part.ecartValeur, 3_857_845 - 2_166_323);
  assert.equal(part.apportsNets, places[2] - places[0]);
  assert.equal(part.gain, part.ecartValeur - part.apportsNets);

  const dietz = dietzModifie(
    valeurs[0],
    valeurs[2],
    apports.map((a) => ({ date: a.date, montant: net(a) })),
    "2026-01-01",
    "2026-09-28",
  );
  assert.equal(part.gain, dietz.gain, "le gain du graphique est celui du bandeau");
  assert.ok(gainConcorde(part.gain, dietz.gain));

  // Et le controle refuse ce qui ne tombe pas juste : un franc passe, deux non.
  assert.ok(gainConcorde(part.gain, dietz.gain + 1));
  assert.equal(gainConcorde(part.gain, dietz.gain + 2), false);
  // Sans reference, on n'affiche rien : l'absence n'est pas une concordance.
  assert.equal(gainConcorde(part.gain, null), false);
}

// Une periode d'un seul releve ne se decompose pas.
assert.equal(decomposer([{ date: "2026-01-01", valeur: 1, netPlace: 1 }]), null);

// Les flux arrivent de la base du plus recent au plus ancien : l'ordre ne
// change rien au cumul.
assert.deepEqual(
  netPlaceParDate(
    ["2026-06-30"],
    [
      { date: "2026-05-01", net: 200 },
      { date: "2026-01-01", net: 100 },
      { date: "2026-12-01", net: 900 },
    ],
  ),
  [300],
);

/* ------------------------------------------------------- montants insecables */

/*
 * Un montant ne se coupe pas en deux. « 3 857 845 FCFA » revenait a la ligne
 * entre le 3 et le 857, et se lisait alors comme deux nombres.
 */
assert.equal(nombre(3857845).includes(" "), false, "aucune espace ordinaire dans un montant");
assert.equal(nombre(3857845), "3 857 845");
assert.equal(fcfa(5000), "5 000 FCFA");
assert.equal(nombre(3857845).includes(" "), false, "pas d'espace fine : elle manque aux polices systeme");

/* ------------------------------------------------------ reperes de l'abscisse */

{
  // Un exercice : les mois, le premier nomme avec son annee.
  const r = reperesTemps("2026-01-01", "2026-09-28", 1000);
  assert.deepEqual(
    r.map((x) => x.libelle),
    ["janv. 2026", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août"],
  );
  // Les derniers pixels appartiennent a la date de fin : septembre s'y
  // superposerait.
  assert.ok(r.every((x) => x.iso <= "2026-08-01"));
}

{
  // Trois ans : on repere les annees, non les mois -- trente-huit etiquettes
  // n'entrent pas dans mille pixels.
  const r = reperesTemps("2023-07-17", "2026-09-28", 1000);
  assert.deepEqual(r.map((x) => x.libelle), ["juil. 2023", "2024", "2025", "2026"]);
}

{
  // Une periode trop courte pour deux etiquettes n'en porte qu'une, et jamais
  // deux collees : l'illisible vaut moins que l'absent.
  const r = reperesTemps("2026-06-30", "2026-09-28", 260);
  // Le premier repere porte l'annee, les suivants non.
  assert.equal(r[0].libelle, "juin 2026");
  // Et il exige plus de place que les autres : il est deux fois plus large,
  // et cale a gauche au lieu d'etre centre.
  const j = (i) => Date.parse(i + "T00:00:00Z") / 86400000;
  const pos = (i) => ((j(i) - j("2026-06-30")) / (j("2026-09-28") - j("2026-06-30"))) * 260;
  if (r.length > 1) assert.ok(pos(r[1].iso) - pos(r[0].iso) >= 100);
  const largeurUtile = 260;
  const jours = (i) => Date.parse(i + "T00:00:00Z") / 86400000;
  const px = r.map((x) => ((jours(x.iso) - jours("2026-06-30")) / (jours("2026-09-28") - jours("2026-06-30"))) * largeurUtile);
  for (let i = 1; i < px.length; i++) assert.ok(px[i] - px[i - 1] >= 60);
}

// Une periode sans duree ne porte aucun repere plutot qu'une division par zero.
assert.deepEqual(reperesTemps("2026-09-28", "2026-09-28", 1000), []);

/* ------------------------------ les deux gains ne sont pas le meme chiffre */

/*
 * DEUX MESURES PORTENT LE NOM « gain de gestion », ET ELLES DIFFERENT.
 *
 * Le cumul depuis l'ouverture a une date : valeur - net place a cette date.
 * Le gain de la periode choisie : (V fin - V debut) - (net fin - net debut).
 *
 * Les afficher tous deux sous le seul mot « gain de gestion » faisait lire une
 * perte la ou il y avait un gain : au 30/06/2026, 1 092 828 au doigt puis
 * 1 007 802 une fois le doigt leve. Ce controle fige l'ecart pour que personne
 * ne les reunisse plus tard en croyant simplifier.
 */
{
  const releves = [
    { date: "2026-01-01", valeur: 2_166_323, netPlace: 1_493_915 },
    { date: "2026-06-30", valeur: 3_270_463, netPlace: 2_177_635 },
    { date: "2026-09-28", valeur: 3_857_845, netPlace: 2_177_635 },
  ];
  const cumul = (r) => r.valeur - r.netPlace;

  assert.equal(cumul(releves[1]), 1_092_828, "cumul depuis l'ouverture au 30/06");
  assert.equal(cumul(releves[2]), 1_680_210, "cumul depuis l'ouverture au 28/09");

  const periode = decomposer(releves);
  assert.equal(periode.gain, 1_007_802, "gain sur l'exercice");

  // Les deux different, et le cumul n'est jamais le gain de periode des que la
  // periode ne part pas de l'ouverture.
  assert.notEqual(cumul(releves[2]), periode.gain);

  // Le cumul monte entre les deux dates : il n'y a pas eu de perte cet ete.
  assert.ok(cumul(releves[2]) > cumul(releves[1]));

  // Et le gain de periode arrive bien au total annonce quand on va au bout.
  assert.equal(decomposer(releves.slice(0, 2)).gain, 420_420);
  assert.equal(cumul(releves[2]) - cumul(releves[0]), periode.gain);
}

/* ------------------------------- les marches se recollent sur la periode */

/*
 * La ligne « depuis le releve precedent » decompose UN intervalle ; celle de la
 * periode en decompose la suite entiere. Les deux doivent se recoller, sinon le
 * president verrait des marches qui ne font pas le total qu'on lui annonce --
 * et il aurait raison de ne plus croire ni l'une ni l'autre.
 */
{
  const releves = [
    { date: "2026-01-01", valeur: 2_166_323, netPlace: 1_493_915 },
    { date: "2026-06-30", valeur: 3_270_463, netPlace: 2_177_635 },
    { date: "2026-09-13", valeur: 3_785_917, netPlace: 2_177_635 },
    { date: "2026-09-24", valeur: 3_760_885, netPlace: 2_177_635 },
    { date: "2026-09-28", valeur: 3_857_845, netPlace: 2_177_635 },
  ];
  const marches = releves.slice(1).map((_, i) => decomposer([releves[i], releves[i + 1]]));
  const total = decomposer(releves);

  const somme = (lire) => marches.reduce((t, m) => t + lire(m), 0);
  assert.equal(somme((m) => m.gain), total.gain, "les gains des marches font le gain de la periode");
  assert.equal(somme((m) => m.apportsNets), total.apportsNets, "et les apports de meme");
  assert.equal(somme((m) => m.ecartValeur), total.ecartValeur);

  // Une marche sans apport ne bouge que par le marche : c'est ce qui permet de
  // distinguer un creux de bourse d'un virement pas encore arrive au releve.
  const creux = marches[2];
  assert.equal(creux.apportsNets, 0);
  assert.equal(creux.gain, 3_760_885 - 3_785_917);

  // Et une marche qui porte un apport arrive laisse le gain tranquille : la
  // valeur monte du meme montant, l'argent se posant en liquidites.
  const arrive = decomposer([
    { date: "2026-10-05", valeur: 3_857_845, netPlace: 2_177_635 },
    { date: "2026-10-31", valeur: 3_857_845 + 125_000, netPlace: 2_177_635 + 125_000 },
  ]);
  assert.equal(arrive.apportsNets, 125_000);
  assert.equal(arrive.gain, 0);
}

/* ------------------------------------------------- l'etat de l'echeance du mois */

/*
 * TROIS ETATS, ET NON DEUX.
 *
 * Le courrier n'en connaissait que deux -- avant le 10, et tout le reste -- et
 * ecrivait donc « est du aujourd'hui, dernier jour de l'echeance statutaire »
 * aussi bien le 10 que le 30. Une relance du 30 septembre a un membre en retard
 * de vingt jours lui annoncait une penalite impayee a la ligne suivante : la
 * phrase le dedouanait de ce qu'on lui reprochait.
 */
assert.equal(etatEcheance(new Date("2026-09-01T08:00:00Z")), "a_venir");
assert.equal(joursAvantEcheance(new Date("2026-09-01T08:00:00Z")), 9);

assert.equal(etatEcheance(new Date("2026-09-10T08:00:00Z")), "aujourdhui");
assert.equal(joursAvantEcheance(new Date("2026-09-10T08:00:00Z")), 0);

// Le 11 au matin, l'echeance est passee : c'est un retard, pas « aujourd'hui ».
assert.equal(etatEcheance(new Date("2026-09-11T08:00:00Z")), "passee");
assert.equal(joursAvantEcheance(new Date("2026-09-30T08:00:00Z")), -20);
assert.equal(etatEcheance(new Date("2026-09-30T08:00:00Z")), "passee");

/*
 * LE SEUIL R5 SE JUGE SUR LE NOMBRE QU'ON ANNONCE.
 *
 * Le courrier lisait le nombre de penalites sur le registre -- somme des
 * quantites, quinze pour un membre -- puis choisissait sa phrase sur un autre
 * compte, le nombre de LIGNES, qui valait un. Resultat : « Penalites de retard
 * impayees : 15 » suivi de « a partir de 3 penalites de retard impayees,
 * l'exclusion sera encourue », la phrase reservee a qui est sous le seuil.
 *
 * La decision ne prend plus qu'un nombre : celui qui vient d'etre ecrit.
 */
const avantSeuilR5 = new Date("2026-09-30T08:00:00Z");
const apresSeuilR5 = new Date("2027-02-01T08:00:00Z");

assert.equal(phaseSeuilR5(0, avantSeuilR5), "sous_le_seuil");
assert.equal(phaseSeuilR5(2, avantSeuilR5), "sous_le_seuil");

// Le cas du courrier de KONE Bourama : quinze penalites, seuil de trois.
assert.equal(phaseSeuilR5(15, avantSeuilR5), "atteint_avant_effet");
assert.equal(phaseSeuilR5(3, avantSeuilR5), "atteint_avant_effet");

/*
 * La regle ne mord qu'a sa date d'effet : avant le 10/01/2027 le seuil est
 * atteint mais l'exclusion n'est pas encore encourue, apres elle l'est.
 */
assert.equal(phaseSeuilR5(3, apresSeuilR5), "atteint_en_vigueur");
assert.equal(phaseSeuilR5(15, apresSeuilR5), "atteint_en_vigueur");
assert.equal(phaseSeuilR5(2, apresSeuilR5), "sous_le_seuil");

/*
 * Et le seuil ainsi juge doit concorder avec l'issue R5 : meme nombre, meme
 * verdict. Un membre a jour de ses cotisations mais portant quinze penalites
 * est exclu de plein droit une fois la regle en vigueur.
 */
assert.equal(issueR5(0, false, false, 15, apresSeuilR5).voie, "exclusion_plein_droit");
assert.equal(issueR5(0, false, false, 15, avantSeuilR5).applicable, false);

/* ------------------------------------------- l'ordre de reglement des mois */

/*
 * ON NE REGLE PAS UN MOIS EN LAISSANT UN MOIS ANTERIEUR OUVERT.
 *
 * `prochainReglement` nomme le mois par lequel reprendre et ce qu'il reste a y
 * porter. Le formulaire propose les deux, la declaration impute dessus : une
 * seule fonction, donc aucun risque que l'ecran et le controle divergent.
 */
const troisMois = ["2026-07-01", "2026-08-01", "2026-09-01"];
const ligne = (mois, montant, statut = "valide", date = `${mois.slice(0, 8)}05`) => ({
  mois_couvert: mois,
  montant,
  statut,
  date_versement: date,
});
/* Le chemin que suit la production : situation, puis montants par mois. */
const aRegler = (versements, requis = 5000, mois = troisMois, ...reste) =>
  prochainReglement(
    situationMembre("x", mois, versements, [], septembre, ...reste).cellules,
    montantsParMois(versements),
    requis,
  );

// Rien de verse : on reprend au premier mois du club pour ce membre.
assert.deepEqual(
  aRegler([]),
  { mois: "2026-07-01", reste: 5000 },
  "sans rien de verse, le reglement commence au mois le plus ancien, cotisation entiere",
);

/*
 * LE CAS QUI MANQUAIT. Juillet impaye, aout et septembre soldes : c'est
 * exactement le trou qu'on pouvait creuser, en payant les mois recents et en
 * laissant le plus ancien derriere.
 */
const trou = [ligne("2026-08-01", 5000), ligne("2026-09-01", 5000)];
assert.equal(
  aRegler(trou).mois,
  "2026-07-01",
  "un mois saute reste le mois a reprendre, meme si les suivants sont payes",
);

// Un acompte ne ferme pas le mois, et le reste annonce est le seul reliquat.
assert.deepEqual(
  aRegler([ligne("2026-07-01", 2000)]),
  { mois: "2026-07-01", reste: 3000 },
  "un acompte laisse le mois ouvert, et il ne reste que le complement a verser",
);

/*
 * Une declaration en attente ferme le mois pour cette regle : le membre a fait
 * sa part, et le delai du tresorier ne doit pas l'empecher de regler le suivant.
 */
assert.equal(
  aRegler([ligne("2026-07-01", 5000, "en_attente"), ligne("2026-08-01", 5000)]).mois,
  "2026-09-01",
  "un mois declare mais pas encore valide ne bloque pas le reglement du suivant",
);

// Avant l'adhesion, rien n'est du : on reprend au premier mois reellement du.
assert.equal(
  aRegler([], 5000, troisMois, "2026-09-01").mois,
  "2026-09-01",
  "les mois anterieurs a l'adhesion ne sont pas des mois a regler",
);

/*
 * Tout solde jusqu'au mois courant : la grille s'arrete la, mais la reponse ne
 * peut pas etre « rien ». Le membre qui vient de solder septembre doit se voir
 * proposer octobre, non septembre, qu'il a paye.
 */
const toutVerse = [
  ligne("2026-07-01", 5000), ligne("2026-08-01", 5000), ligne("2026-09-01", 5000),
];
assert.deepEqual(
  aRegler(toutVerse),
  { mois: "2026-10-01", reste: 5000 },
  "tout solde jusqu'au mois courant : le prochain mois a regler est le suivant",
);

// Une avance repousse d'autant : octobre et novembre payes, on propose decembre.
assert.equal(
  aRegler([...toutVerse, ligne("2026-10-01", 5000), ligne("2026-11-01", 5000)]).mois,
  "2026-12-01",
  "une avance repousse d'autant le prochain mois a regler",
);

// Une avance incomplete ne couvre pas son mois : c'est lui qu'il faut proposer.
assert.deepEqual(
  aRegler([...toutVerse, ligne("2026-10-01", 2000)]),
  { mois: "2026-10-01", reste: 3000 },
  "un acompte d'avance ne solde pas le mois a venir",
);

// Une ligne rejetee ne couvre rien, pas plus en avance qu'ailleurs.
assert.equal(
  aRegler([...toutVerse, ligne("2026-10-01", 5000, "rejete")]).mois,
  "2026-10-01",
  "une avance rejetee laisse son mois a regler",
);

// Un retard l'emporte sur l'avance : qui doit juillet et a paye octobre
// d'avance reprend par juillet, non par novembre.
assert.equal(
  aRegler([ligne("2026-08-01", 5000), ligne("2026-09-01", 5000), ligne("2026-10-01", 5000)]).mois,
  "2026-07-01",
  "le mois en retard passe avant toute avance deja versee",
);

// Une cotisation particuliere deplace le seuil : 10 000 exiges, 5 000 verses.
const sousDerogation = [
  ligne("2026-07-01", 10_000), ligne("2026-08-01", 10_000), ligne("2026-09-01", 10_000),
  ligne("2026-10-01", 5000),
];
assert.deepEqual(
  prochainReglement(
    situationMembre("d", troisMois, sousDerogation, [], septembre, undefined, {
      cotisationMensuelle: 10_000,
    }).cellules,
    montantsParMois(sousDerogation),
    10_000,
  ),
  { mois: "2026-10-01", reste: 5000 },
  "le mois a venir se mesure a la cotisation du membre, non au tarif commun",
);

/* --------------------------------- l'imputation d'un versement sur les mois */

/*
 * LE MEMBRE N'INDIQUE PLUS LE MOIS : IL INDIQUE LE MONTANT.
 *
 * `imputer` repartit ce montant du plus ancien au plus recent. C'est le coeur
 * de la declaration : ce que ces controles decrivent est exactement ce qui
 * sera inscrit en base, une ligne par mois, avec son propre montant.
 */
const repartir = (montant, versements, requis = 5000, mois = troisMois) =>
  imputer(
    montant,
    situationMembre("i", mois, versements, [], septembre).cellules,
    montantsParMois(versements),
    requis,
  );

assert.deepEqual(
  repartir(5000, []),
  [{ mois: "2026-07-01", montant: 5000 }],
  "une cotisation entiere solde le mois le plus ancien",
);

assert.deepEqual(
  repartir(2000, []),
  [{ mois: "2026-07-01", montant: 2000 }],
  "un acompte ne cree qu'une ligne, partielle, sur le mois le plus ancien",
);

// 8 000 sur un juillet deja entame de 2 000 : il complete juillet, puis entame aout.
assert.deepEqual(
  repartir(8000, [ligne("2026-07-01", 2000)]),
  [
    { mois: "2026-07-01", montant: 3000 },
    { mois: "2026-08-01", montant: 5000 },
  ],
  "le versement complete le mois entame avant de passer au suivant",
);

assert.deepEqual(
  repartir(15_000, []),
  [
    { mois: "2026-07-01", montant: 5000 },
    { mois: "2026-08-01", montant: 5000 },
    { mois: "2026-09-01", montant: 5000 },
  ],
  "trois cotisations couvrent trois mois, du plus ancien au plus recent",
);

// Le reliquat reste un reliquat : il ne se perd pas et ne gonfle pas un mois.
assert.deepEqual(
  repartir(12_000, []),
  [
    { mois: "2026-07-01", montant: 5000 },
    { mois: "2026-08-01", montant: 5000 },
    { mois: "2026-09-01", montant: 2000 },
  ],
  "ce qui depasse deux mois entiers entame le troisieme, sans le solder",
);

/*
 * LE TROU EST ENJAMBE. Juillet du, aout paye, septembre du : 10 000 vont sur
 * juillet et septembre. Aout ne recoit rien -- il serait compte deux fois.
 */
assert.deepEqual(
  repartir(10_000, [ligne("2026-08-01", 5000)]),
  [
    { mois: "2026-07-01", montant: 5000 },
    { mois: "2026-09-01", montant: 5000 },
  ],
  "un mois deja solde au milieu du parcours ne recoit rien",
);

// Tout a jour : le versement part en avance sur les mois suivants.
assert.deepEqual(
  repartir(10_000, toutVerse),
  [
    { mois: "2026-10-01", montant: 5000 },
    { mois: "2026-11-01", montant: 5000 },
  ],
  "a jour, le versement s'impute en avance sur les mois a venir",
);

// Un montant nul ou negatif n'impute rien, et ne doit pas inventer de ligne.
assert.deepEqual(repartir(0, []), [], "un montant nul n'impute rien");
assert.deepEqual(repartir(-5000, []), [], "un montant negatif n'impute rien");

/*
 * LA BORNE NE DOIT PAS AVALER LA DIFFERENCE. Au-dela de 24 mois, `imputer`
 * rend ce qu'il a pu placer, et l'action refuse : encaisser un montant sans le
 * porter nulle part serait le pire des deux comportements.
 */
const trente = repartir(30 * 5000, []);
assert.equal(trente.length, 24, "l'imputation s'arrete a 24 mois");
assert.equal(
  trente.reduce((t, i) => t + i.montant, 0),
  24 * 5000,
  "et le total impute est inferieur au montant verse, pour que l'appelant refuse",
);

/* ------------------------------------- l'imputation sur les penalites dues */

/*
 * MEME REGLE QUE LES COTISATIONS, AUTRE UNITE.
 *
 * L'argent eteint la dette la plus ancienne d'abord -- mais une penalite ne se
 * coupe pas : le registre la compte en unites entieres. Un versement n'en
 * solde donc qu'un nombre entier, et ce qui ne suffit pas a en payer une de
 * plus n'est pas impute : l'action refuse plutot que d'encaisser la
 * difference.
 */
const pen = (id, quantite, montantUnitaire, dateConstat) => ({
  id,
  quantite,
  montantUnitaire,
  dateConstat,
});
/* Deux lignes : trois penalites de 500 en juillet, une de 1 000 en septembre. */
const registre = [
  pen("b", 1, 1000, "2026-09-10"),
  pen("a", 3, 500, "2026-07-10"),
];

assert.deepEqual(
  imputerPenalites(500, registre),
  [{ penaliteId: "a", quantite: 1, montant: 500 }],
  "500 soldent une penalite, et la plus ancienne d'abord malgre l'ordre de la liste",
);

assert.deepEqual(
  imputerPenalites(1500, registre),
  [{ penaliteId: "a", quantite: 3, montant: 1500 }],
  "1 500 soldent les trois unites de la ligne la plus ancienne",
);

// Le versement deborde sur la ligne suivante, toujours dans l'ordre.
assert.deepEqual(
  imputerPenalites(2500, registre),
  [
    { penaliteId: "a", quantite: 3, montant: 1500 },
    { penaliteId: "b", quantite: 1, montant: 1000 },
  ],
  "un versement plus large passe a la ligne suivante une fois la premiere soldee",
);

/*
 * Ce qui ne tombe pas juste n'est pas impute : 1 200 soldent deux penalites de
 * 500 et laissent 200, que l'appelant doit refuser plutot qu'encaisser.
 */
const penPartielle = imputerPenalites(1200, registre);
assert.deepEqual(
  penPartielle,
  [{ penaliteId: "a", quantite: 2, montant: 1000 }],
  "une penalite se regle entiere : 1 200 n'en soldent que deux de 500",
);
assert.equal(
  penPartielle.reduce((t, i) => t + i.montant, 0),
  1000,
  "et le total impute reste inferieur au montant verse, pour que l'action refuse",
);

/*
 * Une ligne portant deja une declaration en attente est enjambee : l'index
 * unique de la base n'en accepte qu'une, et le tresorier doit se prononcer.
 * C'est le pendant du mois declare mais pas encore valide.
 */
assert.deepEqual(
  imputerPenalites(1000, registre, new Set(["a"])),
  [{ penaliteId: "b", quantite: 1, montant: 1000 }],
  "une ligne deja declaree est enjambee, la suivante recoit",
);

// Trop peu pour une seule unite : rien n'est impute, et rien n'est invente.
assert.deepEqual(imputerPenalites(300, registre), [], "300 ne soldent aucune penalite de 500");
assert.deepEqual(imputerPenalites(0, registre), [], "un montant nul n'impute rien");
assert.deepEqual(imputerPenalites(-1000, registre), [], "un montant negatif n'impute rien");

/*
 * Meme date de constat : la premiere inscrite passe la premiere. Departager
 * par identifiant -- un tirage aleatoire -- reglerait l'une ou l'autre au
 * hasard.
 */
assert.deepEqual(
  imputerPenalites(500, [
    { ...pen("zz", 1, 500, "2026-09-10"), inscrite: "2026-09-10T08:00:00.000001" },
    { ...pen("aa", 1, 500, "2026-09-10"), inscrite: "2026-09-10T09:00:00.000001" },
  ]),
  [{ penaliteId: "zz", quantite: 1, montant: 500 }],
  "a date egale, l'ordre d'inscription l'emporte sur l'identifiant",
);

/*
 * Un montant unitaire nul ferait boucler sans jamais consommer le versement :
 * la ligne est ecartee, et le tresorier la verra rester due.
 */
assert.deepEqual(
  imputerPenalites(1000, [pen("z", 2, 0, "2026-06-10"), pen("b", 1, 1000, "2026-09-10")]),
  [{ penaliteId: "b", quantite: 1, montant: 1000 }],
  "une ligne au montant unitaire nul est ecartee, non soldee gratuitement",
);

/* ------------------------------------ le total des cotisations a regler */

/*
 * LE CHIFFRE QUE L'ACCUEIL ET LE COURRIER PARTAGENT.
 *
 * Tous deux annoncaient la cotisation du seul mois courant, a cote d'une
 * dette de penalites entiere. Qui devait trois mois lisait 5 000 FCFA.
 */
const quatreMois = ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"];
const auDix = new Date("2026-10-10T07:00:00Z");
const total = (versements, adhesion) =>
  cotisationsARegler(situationMembre("t", quatreMois, versements, [], auDix, adhesion).cellules);

// Le cas signale : juillet, aout, septembre impayes, octobre du ce jour.
assert.deepEqual(
  total([]),
  { total: 20_000, mois: quatreMois },
  "qui doit juillet a octobre doit 20 000 pour etre a jour, non les 5 000 d'octobre",
);

// Un acompte compte pour ce qu'il manque, pas pour une cotisation entiere.
assert.equal(
  total([ligne("2026-07-01", 2000)]).total,
  18_000,
  "un acompte de 2 000 sur juillet ramene le total a 18 000",
);

// Un mois declare, en attente de validation, n'est plus a regler.
assert.equal(
  total([ligne("2026-07-01", 5000, "en_attente")]).total,
  15_000,
  "un mois declare mais pas encore valide n'est pas reclame une seconde fois",
);

// Une ligne rejetee ne couvre rien : le mois reste a regler.
assert.equal(
  total([ligne("2026-07-01", 5000, "rejete")]).total,
  20_000,
  "une ligne rejetee ne diminue pas le total",
);

// Avant l'adhesion, rien n'est du.
assert.deepEqual(
  total([], "2026-09-01"),
  { total: 10_000, mois: ["2026-09-01", "2026-10-01"] },
  "les mois anterieurs a l'adhesion n'entrent pas dans le total",
);

// Tout solde : rien a regler, et une avance n'entre pas dans le compte.
assert.deepEqual(
  total([
    ligne("2026-07-01", 5000), ligne("2026-08-01", 5000), ligne("2026-09-01", 5000),
    ligne("2026-10-01", 5000), ligne("2026-11-01", 5000),
  ]),
  { total: 0, mois: [] },
  "a jour, le total est nul, et l'avance de novembre ne le rend pas negatif",
);

/* ------------------------------------------ l'avance obligatoire, trois etats */

/*
 * RIEN AU-DESSUS DU MINIMUM, UN PREAVIS AU MINIMUM, LA MESURE EN DESSOUS.
 *
 * Trois mois exiges a 5 000, sans terme : le minimum est de 15 000. « Au
 * minimum » veut dire qu'une echeance de plus sans versement le ferait passer
 * dessous -- donc moins de 20 000.
 */
const sansTerme = { moisRequis: 3, moisRestants: null };
assert.deepEqual(
  etatAvance(20_000, 3, 5000),
  { montantExige: 15_000, ...sansTerme, respectee: true, auSeuil: false, manque: 0, pourMaintenir: 0 },
  "quatre mois d'avance : tenue, et rien a dire",
);
assert.deepEqual(
  etatAvance(15_000, 3, 5000),
  { montantExige: 15_000, ...sansTerme, respectee: true, auSeuil: true, manque: 0, pourMaintenir: 5000 },
  "trois mois tout juste : tenue, mais au seuil -- il faut verser un mois pour la maintenir",
);
assert.deepEqual(
  etatAvance(17_500, 3, 5000),
  { montantExige: 15_000, ...sansTerme, respectee: true, auSeuil: true, manque: 0, pourMaintenir: 2500 },
  "trois mois et demi : la prochaine echeance le ferait passer dessous, il manque 2 500",
);
assert.deepEqual(
  etatAvance(10_000, 3, 5000),
  { montantExige: 15_000, ...sansTerme, respectee: false, auSeuil: false, manque: 5000, pourMaintenir: 10_000 },
  "deux mois : en defaut, ce n'est plus un preavis",
);
assert.equal(etatAvance(0, 3, 5000).manque, 15_000, "rien detenu : tout manque");

/*
 * L'EXIGENCE S'ARRETE AU TERME : LE CAS DE BLA.
 *
 * Trois mois d'avance, mesure prenant fin le 31 decembre 2027. Les jours de
 * relance, le mois courant compte dans l'avance tant que son echeance n'est
 * pas passee.
 */
const finBla = "2027-12-31";
const le7 = (mois) => new Date(`2027-${mois}-07T08:00:00Z`);

// Septembre : quatre mois restent (sept. a dec.), trois sont exiges.
const septembre2027 = etatAvance(15_000, 3, 5000, finBla, le7("09"));
assert.equal(septembre2027.moisRestants, 4, "en septembre, quatre mois restent a couvrir");
assert.equal(septembre2027.moisRequis, 3, "et trois sont exiges, comme d'ordinaire");
assert.equal(
  septembre2027.auSeuil && septembre2027.pourMaintenir === 5000,
  true,
  "sept., oct. et nov. detenus : decembre manquera a l'echeance, preavis de 5 000",
);

/*
 * Octobre : les trois mois qui restent sont exactement ceux qu'il detient. Il
 * a tout verse jusqu'au terme -- c'est le moment de lui annoncer la fin, et
 * surtout pas de lui reclamer janvier 2028.
 */
const octobre2027 = etatAvance(15_000, 3, 5000, finBla, le7("10"));
assert.equal(octobre2027.moisRestants, 3, "en octobre, trois mois restent : oct., nov., dec.");
assert.equal(octobre2027.respectee, true, "detenant ces trois mois, il est en regle");
assert.equal(octobre2027.auSeuil, false, "et aucun preavis : rien ne reste a constituer");

// Novembre : deux mois restent. Les detenir suffit -- plus de defaut absurde.
const novembre2027 = etatAvance(10_000, 3, 5000, finBla, le7("11"));
assert.equal(novembre2027.moisRequis, 2, "en novembre, deux mois seulement sont exiges");
assert.equal(
  novembre2027.respectee,
  true,
  "novembre et decembre detenus : en regle, sans janvier 2028 qui sort de la mesure",
);
assert.equal(
  etatAvance(5000, 3, 5000, finBla, le7("11")).manque,
  5000,
  "novembre seul detenu : il manque decembre, et seulement decembre",
);

/*
 * Une mesure qui s'eteint avant l'echeance du mois n'exige pas ce mois : le
 * 10 novembre, terme d'une mesure, la cotisation de novembre est due le jour
 * meme -- mais un terme au 5 decembre n'exige pas decembre, du le 10.
 */
const le7Novembre = new Date("2026-11-07T08:00:00Z");
const finLe10 = etatAvance(15_000, 3, 5000, "2026-11-10", le7Novembre);
assert.equal(finLe10.auSeuil, false, "une mesure qui s'eteint a l'echeance n'appelle aucun preavis");
assert.equal(finLe10.respectee, true, "et reste tenue : seul le preavis tombe");
assert.equal(
  etatAvance(0, 3, 5000, "2027-12-05", le7("11")).moisRestants,
  1,
  "un terme au 5 decembre laisse novembre seul a couvrir",
);


/* ------------------------------------------- sortie d'un membre : decompte */

{
  /*
   * Decisions du bureau (octobre 2026) : provision de cession de 1,4 % sur la
   * quote-part des actions, quote-part des frais de garde courus, transfert de
   * 2 % hors avance.
   */
  const taux = { venteActions: 0.014, transfert: 0.02 };
  const club = { actions: 709_300, fraisGardeCourus: 0 };

  // Part de 100 000 sans avance, dont 70 930 en actions.
  const d = decompteSortie({ valeur: 100_000, avance: 0, part: 0.1 }, club, taux);
  assert.equal(d.pocheActions, 70_930);
  assert.equal(d.fraisVente, 993, "1,4 % de la seule poche actions");
  assert.equal(d.fraisTransfert, 1_980, "2 % de ce qui reste a virer");
  assert.equal(d.net, 97_027);

  // L'avance est rendue intacte : ni cession, ni transfert.
  const avecAvance = decompteSortie({ valeur: 115_000, avance: 15_000, part: 0.1 }, club, taux);
  assert.equal(avecAvance.fraisVente, 993);
  assert.equal(avecAvance.fraisTransfert, 1_980, "le transfert ne touche pas l'avance");
  assert.equal(avecAvance.net, 115_000 - 993 - 1_980);

  // Sans releve, rien a vendre : seul le transfert reste.
  const sansReleve = decompteSortie({ valeur: 50_000, avance: 0, part: 0.1 }, { actions: 0, fraisGardeCourus: 0 }, taux);
  assert.equal(sansReleve.fraisVente, 0);
  assert.equal(sansReleve.net, 49_000);

  // La poche actions ne depasse jamais la part elle-meme.
  const borne = decompteSortie({ valeur: 10_000, avance: 0, part: 0.5 }, { actions: 1_000_000, fraisGardeCourus: 0 }, taux);
  assert.equal(borne.pocheActions, 10_000);

  // Les frais de garde courus : sa quote-part, avant le transfert.
  const garde = decompteSortie({ valeur: 100_000, avance: 0, part: 0.1 }, { actions: 709_300, fraisGardeCourus: 13_450 }, taux);
  assert.equal(garde.fraisGarde, 1_345);
  assert.equal(garde.fraisTransfert, Math.round((100_000 - 993 - 1_345) * 0.02));

  // Une part negative (penalites superieures aux droits) ne rapporte rien.
  const endette = decompteSortie({ valeur: -2_000, avance: 0, part: 0.1 }, club, taux);
  assert.equal(endette.net, 0);
  assert.equal(endette.fraisVente + endette.fraisGarde + endette.fraisTransfert, 0);

  // Frais de garde de l'annee, au prorata : 0,4 % HT des titres et 5 000 HT, plus 10 %.
  assert.equal(
    fraisGardeCourus(2_693_920, "2026-10-10", { conservation: 0.004, tenueCompte: 5_000, taxe: 0.1 }),
    Math.round(((2_693_920 * 0.004 + 5_000) * 1.1 * 282) / 365),
  );
  assert.equal(fraisGardeCourus(1_000_000, "2026-01-01", { conservation: 0.004, tenueCompte: 5_000, taxe: 0.1 }), 0);
}

/*
 * L'equivalence que les deux audits ont demandee : un membre qui paie sa penalite
 * et un membre qui la doit sortent avec le meme net, a sa valeur pres.
 */
{
  const taux = { venteActions: 0.014, transfert: 0.02 };
  const club = { actions: 0, fraisGardeCourus: 0 };
  const du = repartirParts([m("s", "S", 200_000, 0, 7_500), m("r", "R", 1_800_000)], 3_800_000);
  const paye = repartirParts([m("s", "S", 200_000), m("r", "R", 1_800_000)], 3_807_500);
  const sDu = du.find((p) => p.membreId === "s");
  const sPaye = paye.find((p) => p.membreId === "s");
  assert.equal(Math.round(sPaye.valeur - 7_500), Math.round(sDu.valeur), "payee ou due, la penalite coute son montant");
  assert.equal(
    decompteSortie(sDu, club, taux).net,
    decompteSortie({ ...sPaye, valeur: sPaye.valeur - 7_500 }, club, taux).net,
  );
}

/* ------------------------------------------- la caisse, avant et apres une sortie */

{
  const base = {
    penalitesEncaissees: 10_000, recettes: 0, apportsNets: 300_000,
  };
  // Avant : Bourama est actif, il a verse 250 000 sur 1 000 000.
  const avant = etatCaisse({
    ...base, versementsActifs: 1_000_000, versementsSortis: 0, depenses: 20_000,
    netDuAuxSortis: 0, remboursementsSortants: 0,
  });
  // Sortie enregistree : ses versements passent chez les sortis, 335 911 lui sont dus.
  const enregistree = etatCaisse({
    ...base, versementsActifs: 750_000, versementsSortis: 250_000, depenses: 20_000,
    netDuAuxSortis: 335_911, remboursementsSortants: 0,
  });
  assert.equal(enregistree.totalEnCaisse, avant.totalEnCaisse, "rien n'est sorti de la caisse");
  assert.equal(enregistree.duAuxSortants, 335_911);
  assert.equal(enregistree.aPartager, avant.aPartager - 335_911, "son du ne se partage plus");
  // Paye : la depense de remboursement solde la dette, une seule fois.
  const paye = etatCaisse({
    ...base, versementsActifs: 750_000, versementsSortis: 250_000, depenses: 20_000 + 335_911,
    netDuAuxSortis: 335_911, remboursementsSortants: 335_911,
  });
  assert.equal(paye.totalEnCaisse, avant.totalEnCaisse - 335_911, "la caisse baisse au paiement");
  assert.equal(paye.duAuxSortants, 0);
  assert.equal(paye.aPartager, enregistree.aPartager, "le paiement ne touche plus aux parts");
}

{
  /*
   * LE COURRIER DE SORTIE SE REFAIT A LA CALCULATRICE.
   *
   * Le sortant n'est pas matheux : il lit une addition, une proportion, des
   * retenues et un reste. Ce bloc rejoue une sortie de bout en bout -- parts,
   * decompte, enregistrement -- puis relit le courrier comme lui : chaque total
   * doit tomber sur la somme de ses lignes, au franc pres.
   */
  const taux = { venteActions: 0.014, transfert: 0.02 };
  const apports = [
    { membreId: "a", nom: "Sortant", acquis: 300_000, avance: 20_000, dues: 24_000 },
    { membreId: "b", nom: "Restant", acquis: 600_000, avance: 0, dues: 0 },
    { membreId: "c", nom: "Autre", acquis: 300_000, avance: 40_000, dues: 6_000 },
  ];
  const releve = { total: 1_500_000, actions: 1_400_000 };
  const enTransit = 40_000;
  const caisse = 210_000;
  const avoir = releve.total + enTransit + caisse;
  const fc = fraisGardeCourus(releve.actions, "2026-10-10", { conservation: 0.004, tenueCompte: 5_000, taxe: 0.1 });

  const pot = potAPartager(apports, avoir);
  assert.equal(pot.aPartager, 1_750_000 + 30_000 - 60_000, "avoir, plus les creances, moins les avances");
  assert.equal(pot.cotisations, 1_200_000);

  const p = repartirParts(apports, avoir).find((x) => x.membreId === "a");
  const d = decompteSortie(p, { actions: releve.actions, fraisGardeCourus: fc }, taux);

  // Ce que fait `enregistrerSortie`, a l'identique.
  const frais = d.fraisVente + d.fraisGarde + d.fraisTransfert;
  const droits = Math.max(0, Math.round(p.valeur + p.dues));
  const compensees = Math.max(0, Math.min(p.dues, droits - frais));
  const net = Math.max(0, droits - compensees - frais);
  assert.equal(net, d.net, "le net enregistre est celui du tableau");

  const donnees = {
    nom: "SORTANT Test", dateSortie: "2026-10-13", motif: "exclusion de plein droit (R5).",
    releve: "2026-10-10",
    club: {
      compteTitres: releve.total, actions: releve.actions, enTransit, caisse, creances: pot.creances,
      avances: pot.avances, aPartager: pot.aPartager, cotisations: pot.cotisations, fraisGardeCourus: fc,
    },
    cotisations: 300_000, avance: 20_000, quotePart: droits - 20_000, rachats: [],
    droits, penalites: 24_000, penalitesEnCours: 6_000,
    compensees, pocheActions: d.pocheActions, fraisVente: d.fraisVente, fraisGarde: d.fraisGarde,
    fraisTransfert: d.fraisTransfert, net,
  };
  const { sujet, texte } = courrielSortie(donnees);
  const lignes = texte.split("\n");
  const montant = (l) => Number(l.slice(l.lastIndexOf(" : ") + 3).replace(/[^\d]/g, ""));
  const apres = (l, marque) => Number(l.slice(l.lastIndexOf(marque) + marque.length).replace(/[^\d]/g, ""));
  const ligne = (debut) => {
    const l = lignes.find((x) => x.trimStart().startsWith(debut));
    assert.ok(l, `ligne attendue : ${debut}`);
    return l;
  };

  // 1. L'addition de ce que possedait le club tombe sur le total a partager.
  const debut1 = lignes.findIndex((l) => l.startsWith("1. "));
  const fin1 = lignes.findIndex((l) => l.startsWith("Total à partager"));
  const somme = lignes
    .slice(debut1, fin1)
    .filter((l) => l.startsWith("  - "))
    .reduce((t, l) => t + (l.includes("Moins") ? -1 : 1) * montant(l), 0);
  assert.equal(somme, montant(lignes[fin1]), "l'addition du club est juste");
  assert.equal(montant(lignes[fin1]), pot.aPartager);

  // 2. La proportion, puis la part : le calcul ecrit donne le chiffre ecrit.
  assert.ok(texte.includes(`${nombre(300_000)} ÷ ${nombre(1_200_000)}, soit 25 %`), "la proportion en clair");
  const quotePart = apres(ligne("- Votre part du total"), " = ");
  assert.equal(quotePart, Math.round((pot.aPartager * 300_000) / 1_200_000), "la part se refait a la calculatrice");
  assert.equal(quotePart + 20_000, montant(ligne("Vos droits")), "part et avance font les droits");

  // 3. Les retenues : chacune juste, et leur total.
  assert.equal(montant(ligne("- Vos pénalités").replace(/,.*$/, "")), 24_000);
  assert.ok(texte.includes(`dont ${fcfa(6_000)} qui courent sans être encore inscrites`), "les penalites non inscrites sont dites");
  const vente = ligne("- Frais de vente");
  assert.ok(vente.includes(`1,4 % de ${fcfa(d.pocheActions)}`), "l'assiette de la cession");
  assert.equal(apres(vente, " = "), Math.round(d.pocheActions * 0.014));
  const transfert = ligne("- Frais de transfert");
  const assiette = Number(transfert.slice(transfert.lastIndexOf(" de ", transfert.indexOf(" = ")) + 4, transfert.indexOf(" = ")).replace(/[^\d]/g, ""));
  assert.equal(Math.round(assiette * 0.02), apres(transfert, " = "), "les 2 % se refont sur l'assiette ecrite");
  assert.equal(montant(ligne("Total retiré")), 24_000 + frais, "le total des retenues");

  // 4. Le reste, et la date limite de R5.
  assert.equal(montant(ligne("Montant à vous verser")), droits - compensees - frais);
  assert.ok(texte.includes(`En bref : ${fcfa(net)} vous reviennent, à vous verser au plus tard le 13/02/2027.`));
  assert.ok(texte.includes("pour le motif suivant : exclusion de plein droit (R5)."), "le motif, sans double point");
  assert.ok(texte.includes("Votre avance n'en supporte aucun."), "l'avance est hors transfert");
  assert.equal(sujet, "IP12 : décompte de votre sortie du club");

  // L'ecriture du club : accents, ni tiret cadratin ni double tiret, rien d'indefini.
  assert.ok(!/—|--|undefined|NaN/.test(texte), "ni tiret cadratin ni valeur manquante");
  assert.ok(texte.includes("CE QUI EN EST RETIRÉ") && texte.includes("Total à partager"), "les accents");

  // Penalites superieures aux droits : rien ne revient, et le reste du est dit.
  const endette = courrielSortie({
    ...donnees, avance: 0, droits: 30_000, penalites: 50_000, penalitesEnCours: 0, compensees: 30_000,
    pocheActions: 0, fraisVente: 0, fraisGarde: 0, fraisTransfert: 0, net: 0,
  }).texte;
  assert.ok(endette.includes(`En bref : rien ne vous revient, et il reste ${fcfa(20_000)} de pénalités que vous devez au club.`));
  assert.ok(!endette.includes("Votre avance"), "pas de ligne d'avance sans avance");
  assert.ok(!endette.includes("au plus tard"), "pas de date limite quand rien n'est du");

  // Sans penalite, la ligne le dit plutot que de se taire.
  assert.ok(courrielSortie({ ...donnees, penalites: 0, penalitesEnCours: 0, compensees: 0 }).texte.includes("Pénalités : aucune."));

  // R5 : quatre mois, ramenes au dernier jour d'un mois plus court.
  assert.equal(echeanceRemboursement("2026-10-13", 4), "2027-02-13");
  assert.equal(echeanceRemboursement("2026-10-31", 4), "2027-02-28");

  // La correction des frais : le nouveau montant, l'ancien, la raison.
  const correction = courrielCorrectionSortie({
    nom: "SORTANT Test", dateSortie: "2026-10-13", fraisAvant: 12_000, fraisApres: 9_500,
    netAvant: 400_000, netApres: 402_500, raison: "avis d'opéré du 20/10",
  }).texte;
  assert.ok(correction.includes(`Montant à vous verser : ${fcfa(402_500)}, au lieu de ${fcfa(400_000)}.`));
  assert.ok(correction.includes(`Frais réels : ${fcfa(9_500)} (avis d'opéré du 20/10)`));
  assert.ok(!/—|--/.test(correction));
  assert.ok(correction.includes("Tous les membres du club sont en copie."), "la correction va a tous");
  assert.ok(correction.includes("CONTESTER CE DÉCOMPTE"), "la correction se conteste aussi");

  /*
   * TOUS EN COPIE, ET LE DROIT DE CONTESTER. Le decompte du sortant deplace les
   * parts des autres : chacun le recoit, et chacun peut le contester sur pieces.
   */
  assert.ok(texte.includes("Tous les membres du club sont en copie."));
  assert.ok(texte.includes("CONTESTER CE DÉCOMPTE : preuve à l'appui"), "le droit de contester, en titre");
  assert.ok(texte.includes("Chaque membre en copie peut en faire autant."));
  assert.ok(texte.includes("N'hésitez pas à la demander"), "demander l'information manquante");
  // Arrete au jour de la sortie ; le releve plus ancien est dit verifie par le bureau.
  assert.ok(texte.includes("1. CE QUE LE CLUB POSSÉDAIT : au 13/10/2026, jour de votre sortie"));
  assert.ok(texte.includes("relevé de Phoenix Capital Management du 10/10/2026"));
  assert.ok(texte.includes("Le bureau a confirmé qu'elle était toujours valable à la date de votre sortie."));
  assert.ok(
    !courrielSortie({ ...donnees, releve: "2026-10-13" }).texte.includes("Le bureau a confirmé"),
    "un releve du jour meme n'a rien a verifier",
  );

  /*
   * AVANT D'ENREGISTRER : ce que le calcul va utiliser, et quoi faire si ce n'est
   * pas a jour.
   */
  const faits = {
    jour: "2026-10-13", releve: { date: "2026-10-10", total: 3_857_845 }, enTransit: 40_000,
    versementsEnAttente: { nb: 2, total: 40_000, siens: 1 }, caisseEnAttente: 1,
    reglementsEnAttente: 1, penalites: 24_000, penalitesEnCours: 6_000,
  };
  const points = pointsAVerifier(faits);
  assert.ok(points[0].includes("relevé du 10/10/2026") && points[0].includes("3 jours avant la sortie"));
  assert.ok(points[0].includes("saisissez d'abord un relevé daté du 13/10/2026"));
  assert.ok(points.some((x) => x.includes("2 déclarés attendent validation") && x.includes("dont 1 du sortant")));
  assert.ok(points.some((x) => x.startsWith("Caisse : 1 mouvement attend validation : validez-le d'abord, sinon il ne compte pas.")));
  // Un seul versement en attente, d'un autre membre : le singulier, et a qui il est.
  const unSeul = pointsAVerifier({ ...faits, versementsEnAttente: { nb: 1, total: 5_000, siens: 0 } });
  assert.ok(unSeul.some((x) => x.includes(`1 déclaré attend validation (${fcfa(5_000)}), d'un autre membre : validez-le ou refusez-le d'abord, sinon il ne compte pas.`)));
  assert.ok(points.some((x) => x.includes("1 règlement que le trésorier n'a pas vérifié.")), "accord au singulier");
  assert.ok(points.some((x) => x.includes("compteraient deux fois")), "le risque de double compte est dit");
  const aJour = pointsAVerifier({
    ...faits, releve: { date: "2026-10-13", total: 3_857_845 }, enTransit: 0,
    versementsEnAttente: { nb: 0, total: 0, siens: 0 }, caisseEnAttente: 0, reglementsEnAttente: 0,
    penalites: 0, penalitesEnCours: 0,
  });
  assert.ok(aJour[0].includes("le jour même de la sortie"));
  assert.ok(aJour.includes("Pénalités du sortant : aucune."));
  assert.ok(!points.concat(aJour).some((x) => /—|--|undefined|NaN/.test(x)));
  // L'empreinte suit les donnees : un versement valide entre-temps fait redemander.
  assert.notEqual(
    empreinteSortie("a", faits),
    empreinteSortie("a", { ...faits, versementsEnAttente: { nb: 1, total: 20_000, siens: 1 } }),
  );
  assert.equal(empreinteSortie("a", faits), empreinteSortie("a", { ...faits }));

  // Au franc pres : une valeur a centimes ne laisse pas de centimes au net.
  const centimes = decompteSortie({ valeur: 100_000.4, avance: 0, part: 0.1 }, { actions: 0, fraisGardeCourus: 0 }, taux);
  assert.ok(Number.isInteger(centimes.net), "le net est au franc");
}

{
  /*
   * LE RACHAT PAR DES MEMBRES. Le sortant vend tout ou partie de ses parts a
   * d'autres membres, a un prix convenu entre eux ; le club rachete le reste.
   */
  const taux = { venteActions: 0.014, transfert: 0.02 };
  const club = { actions: 1_400_000, fraisGardeCourus: 12_000 };
  const base = { avance: 20_000, quotePart: 430_000, part: 0.25, acquis: 300_000, penalites: 24_000 };

  // Sans acheteur : exactement le calcul de toujours.
  const seul = partagerSortie(base, club, taux, []);
  const ref = decompteSortie({ valeur: 20_000 + 430_000 - 24_000, avance: 20_000, part: 0.25 }, club, taux);
  assert.equal(seul.fractionClub, 1);
  assert.equal(seul.droitsClub, 450_000);
  assert.equal(seul.fraisVente + seul.fraisGarde + seul.fraisTransfert, ref.fraisVente + ref.fraisGarde + ref.fraisTransfert);
  assert.equal(seul.netClub, ref.net, "sans acheteur, le net de toujours");
  assert.equal(seul.compensees, 24_000);
  assert.equal(seul.acheteurs.length, 0);

  /*
   * Un membre rachete tout. Le prix convenu va entier au sortant ; l'acheteur
   * paie en plus toutes ses penalites au club, et le club rend l'avance intacte.
   */
  const tout = partagerSortie(base, club, taux, [{ membreId: "b", fraction: 1, prix: 400_000 }]);
  assert.equal(tout.fractionClub, 0);
  assert.equal(tout.fraisVente + tout.fraisGarde + tout.fraisTransfert, 0, "aucun frais sur ce qu'un membre rachete");
  assert.equal(tout.droitsClub, 20_000, "le club ne doit plus que l'avance");
  assert.equal(tout.compensees, 0, "l'acheteur paie les penalites : l'avance est rendue intacte");
  assert.equal(tout.netClub, 20_000);
  assert.equal(tout.acheteurs[0].auClub, 24_000, "toutes les penalites, en plus du prix");
  assert.equal(tout.acheteurs[0].auSortant, 400_000, "le prix convenu va entier au sortant");
  assert.equal(tout.acheteurs[0].poids, 300_000, "tout le poids passe a l'acheteur");
  assert.equal(tout.acheteurs[0].valeur, 430_000);
  assert.equal(tout.resteDu, 0);

  // Deux acheteurs a 30 % et 20 %, le club rachete la moitie restante.
  const moitie = partagerSortie(base, club, taux, [
    { membreId: "b", fraction: 0.3, prix: 120_000 },
    { membreId: "c", fraction: 0.2, prix: 80_000 },
  ]);
  assert.equal(moitie.fractionClub, 0.5);
  assert.equal(moitie.droitsClub, 20_000 + 215_000);
  assert.equal(moitie.pocheActions, Math.round(0.125 * 1_400_000) > 215_000 - 24_000 ? 215_000 - 24_000 : Math.round(0.125 * 1_400_000));
  assert.equal(moitie.compensees, 12_000, "le club retient les penalites de sa moitie");
  assert.deepEqual(moitie.acheteurs.map((a) => a.auClub), [7_200, 4_800], "chacun celles de ce qu'il rachete");
  assert.ok(moitie.acheteurs.every((a) => a.auSortant === a.prix));
  assert.deepEqual(moitie.acheteurs.map((a) => a.poids), [90_000, 60_000]);
  assert.deepEqual(moitie.acheteurs.map((a) => a.valeur), [129_000, 86_000]);
  assert.equal(
    moitie.netClub,
    moitie.droitsClub - 12_000 - moitie.fraisVente - moitie.fraisGarde - moitie.fraisTransfert,
  );

  // Deux acheteurs se partagent tout : les penalites suivent les fractions, pas les prix.
  const prorata = partagerSortie({ ...base, penalites: 50_001 }, club, taux, [
    { membreId: "b", fraction: 0.6, prix: 300_000 },
    { membreId: "c", fraction: 0.4, prix: 100_000 },
  ]);
  assert.equal(prorata.compensees, 0);
  assert.deepEqual(prorata.acheteurs.map((a) => a.auClub), [30_001, 20_000]);
  assert.equal(prorata.acheteurs.reduce((t, a) => t + a.auClub, 0), 50_001, "au franc pres");
  assert.equal(prorata.acheteurs[1].poids, 300_000 - 180_000, "le dernier prend l'arrondi du poids");

  // Un prix symbolique ne change rien aux penalites : l'acheteur les paie en plus.
  const court = partagerSortie({ ...base, avance: 0, penalites: 50_000 }, club, taux, [
    { membreId: "b", fraction: 1, prix: 30_000 },
  ]);
  assert.equal(court.acheteurs[0].auClub, 50_000);
  assert.equal(court.acheteurs[0].auSortant, 30_000);
  assert.equal(court.resteDu, 0);

  /*
   * L'INVARIANT : le poids passe a l'acheteur sans toucher aux parts des autres.
   * Avant, A (sortant) 300 000, B 600 000, C 300 000. Apres un rachat total par
   * B, B porte 900 000 et C garde son quart ; le pot ne bouge pas.
   */
  const avant = repartirParts(
    [
      { membreId: "a", nom: "A", acquis: 300_000, avance: 0, dues: 0 },
      { membreId: "b", nom: "B", acquis: 600_000, avance: 0, dues: 0 },
      { membreId: "c", nom: "C", acquis: 300_000, avance: 0, dues: 0 },
    ],
    1_200_000,
  );
  const apres = repartirParts(
    [
      { membreId: "b", nom: "B", acquis: 600_000 + 300_000, avance: 0, dues: 0 },
      { membreId: "c", nom: "C", acquis: 300_000, avance: 0, dues: 0 },
    ],
    1_200_000,
  );
  const valeurDe = (l, id) => l.find((x) => x.membreId === id).valeur;
  assert.equal(valeurDe(apres, "c"), valeurDe(avant, "c"), "C ne gagne ni ne perd");
  assert.equal(valeurDe(apres, "b"), valeurDe(avant, "b") + valeurDe(avant, "a"), "B porte la part de A");

  /*
   * L'INVARIANT, DE BOUT EN BOUT : un membre qui ne prend pas part a la sortie
   * n'y perd rien et n'y gagne que sa quote-part de la provision de frais que
   * le club garde. A sort ; B rachete la moitie de ses parts ; le club l'autre.
   */
  {
    const avant = [
      { membreId: "a", nom: "A", acquis: 300_000, avance: 20_000, dues: 24_000 },
      { membreId: "b", nom: "B", acquis: 600_000, avance: 0, dues: 0 },
      { membreId: "c", nom: "C", acquis: 300_000, avance: 40_000, dues: 6_000 },
    ];
    const avoirAvant = 1_750_000;
    const partsAvant = repartirParts(avant, avoirAvant);
    const a0 = partsAvant.find((x) => x.membreId === "a");
    const quotePartA = Math.round(a0.avance + a0.part * potAPartager(avant, avoirAvant).aPartager) - a0.avance;
    const sortie = partagerSortie(
      { avance: 20_000, quotePart: quotePartA, part: a0.part, acquis: 300_000, penalites: 24_000 },
      club, taux, [{ membreId: "b", fraction: 0.5, prix: 200_000 }],
    );
    const fraisSortie = sortie.fraisVente + sortie.fraisGarde + sortie.fraisTransfert;
    // Le club verse son net ; B verse au club les penalites de sa moitie ; le prix va de B a A, hors du club.
    const avoirApres = avoirAvant - sortie.netClub + sortie.acheteurs[0].auClub;
    const apres = [
      { membreId: "b", nom: "B", acquis: 600_000, avance: 0, dues: 0 },
      { membreId: "c", nom: "C", acquis: 300_000, avance: 40_000, dues: 6_000 },
      { membreId: "pb", nom: "part de B", acquis: sortie.acheteurs[0].poids, avance: 0, dues: 0 },
    ];
    const partsApres = repartirParts(apres, avoirApres);
    const valeurDe = (l, id) => l.find((x) => x.membreId === id).valeur;
    const gainC = valeurDe(partsApres, "c") - valeurDe(partsAvant, "c");
    const attendu = (300_000 / (600_000 + 300_000 + sortie.acheteurs[0].poids)) * fraisSortie;
    assert.ok(Math.abs(gainC - attendu) < 2, `C ne gagne que sa quote-part des frais : ${gainC} contre ${attendu}`);
    // La part rachetee vaut ce que valait la moitie des parts de A, plus sa quote-part des frais.
    const gainPart = valeurDe(partsApres, "pb") - sortie.acheteurs[0].valeur;
    const attenduPart = (sortie.acheteurs[0].poids / (600_000 + 300_000 + sortie.acheteurs[0].poids)) * fraisSortie;
    assert.ok(Math.abs(gainPart - attenduPart) < 2, "la part rachetee vaut ce que B a achete");
  }

  // Le courrier avec acheteurs : qui rachete, qui paie quoi, et le total.
  const donnees = {
    nom: "SORTANT Test", dateSortie: "2026-10-13", motif: "démission", releve: "2026-10-13",
    club: {
      compteTitres: 1_500_000, actions: 1_400_000, enTransit: 0, caisse: 220_000, creances: 24_000,
      avances: 20_000, aPartager: 1_724_000, cotisations: 1_200_000, fraisGardeCourus: 12_000,
    },
    cotisations: 300_000, avance: 20_000, quotePart: 431_000, penalites: 24_000, penalitesEnCours: 0,
  };
  const p2 = partagerSortie({ ...base, quotePart: 431_000 }, club, taux, [
    { membreId: "b", fraction: 0.5, prix: 200_000 },
  ]);
  const t2 = courrielSortie({
    ...donnees,
    droits: p2.droitsClub,
    rachats: [{ nom: "ACHETEUR Un", ...p2.acheteurs[0], arrieres: 10_000 }],
    compensees: p2.compensees, pocheActions: p2.pocheActions, fraisVente: p2.fraisVente,
    fraisGarde: p2.fraisGarde, fraisTransfert: p2.fraisTransfert, net: p2.netClub,
  }).texte;
  const total2 = p2.netClub + p2.acheteurs[0].auSortant;
  assert.ok(t2.includes("3. QUI RACHÈTE VOS PARTS"), "la section du rachat");
  assert.ok(t2.includes(`ACHETEUR Un : 50 % de vos parts, d'une valeur de ${fcfa(215_500)}`));
  // Part impaire coupee en deux : l'acheteur et le club font exactement la part.
  const impaire = partagerSortie({ ...base, quotePart: 407_785 }, club, taux, [{ membreId: "b", fraction: 0.5, prix: 1 }]);
  assert.equal(impaire.acheteurs[0].valeur + (impaire.droitsClub - base.avance), 407_785, "au franc pres");
  const tiers = partagerSortie({ ...base, quotePart: 100_001 }, club, taux, [
    { membreId: "b", fraction: 0.6, prix: 1 },
    { membreId: "c", fraction: 0.4, prix: 1 },
  ]);
  assert.equal(tiers.acheteurs.reduce((t, a) => t + a.valeur, 0), 100_001, "rachat total, au franc pres");
  assert.equal(tiers.droitsClub, base.avance);
  const trois = partagerSortie(base, club, taux, [
    { membreId: "b", fraction: 0.7, prix: 1 },
    { membreId: "c", fraction: 0.2, prix: 1 },
    { membreId: "d", fraction: 0.1, prix: 1 },
  ]);
  assert.equal(trois.fractionClub, 0, "70 + 20 + 10 font bien 100 %");
  assert.equal(trois.acheteurs.reduce((t, a) => t + a.poids, 0), base.acquis, "aucun poids perdu");
  assert.ok(t2.includes(`au prix convenu entre vous de ${fcfa(200_000)}.`));
  assert.ok(t2.includes("Le club : les 50 % restants"));
  assert.ok(t2.includes("aucun frais n'y est retenu"));
  assert.ok(t2.includes(`- De ACHETEUR Un : ${fcfa(200_000)}, le prix convenu, à régler directement entre vous`));
  assert.ok(t2.includes("Le prix convenu vous revient en entier."));
  assert.ok(t2.includes(`vos pénalités (${fcfa(12_000)} en tout) et vos cotisations impayées (${fcfa(10_000)} en tout)`));
  assert.ok(t2.includes(`Montant total qui vous revient : ${fcfa(total2)}`));
  assert.ok(t2.includes(`En bref : ${fcfa(total2)} vous reviennent au total`));
  assert.ok(t2.includes("5. CE QUI VOUS REVIENT"), "les sections se renumerotent");
  assert.ok(!/—|--|undefined|NaN/.test(t2));

  // Rachat total, penalites au-dela de l'avance : l'acheteur en verse une partie au club.
  const t3 = courrielSortie({
    ...donnees,
    droits: tout.droitsClub,
    rachats: [{ nom: "ACHETEUR Un", ...tout.acheteurs[0], arrieres: 0 }],
    compensees: tout.compensees, pocheActions: 0, fraisVente: 0, fraisGarde: 0, fraisTransfert: 0,
    net: tout.netClub,
  }).texte;
  assert.ok(t3.includes(`Le club vous doit votre avance : ${fcfa(20_000)}.`));
  assert.ok(t3.includes("Les acheteurs de vos parts les paient au club, en plus de leur prix. Vous ne les devez plus."));
  assert.ok(!t3.includes("en retient"), "pas de « 0 FCFA retenu »");
  assert.ok(t3.includes(`- De ACHETEUR Un : ${fcfa(400_000)}, le prix convenu`));
  assert.ok(t3.includes(`En bref : ${fcfa(420_000)} vous reviennent au total : ${fcfa(20_000)} du club`));
  assert.ok(!t3.includes("Le club : les"), "le club ne rachete rien");

  // La valorisation, avant toute decision : la valeur et les deux reperes de prix.
  const val = lignesValorisation({
    quotePart: 430_000, part: 0.25, avance: 20_000, penalites: 24_000,
    netClub: seul.netClub, fraisClub: seul.fraisVente + seul.fraisGarde + seul.fraisTransfert, arrieres: 0,
  });
  /*
   * Le prix convenu est ce que recoit le sortant ; l'acheteur paie en plus les
   * penalites. En bas, l'offre du club avance mise a part ; en haut, la valeur
   * de la part moins les penalites que l'acheteur paie en plus.
   */
  const plancher = seul.netClub - 20_000;
  // Le cas de Bourama : 364 350 de part, 9 500 de penalites, sans avance, 342 940 offerts par le club.
  const bourama = lignesValorisation({
    quotePart: 364_350, part: 0.0961, avance: 0, penalites: 9_500, netClub: 342_940, fraisClub: 11_910,
    arrieres: 0,
  });
  assert.ok(
    bourama.some((l) => l.includes(`un prix entre ${fcfa(342_940)} (ce que le club lui verserait) et ${fcfa(354_850)}`)),
    "la fourchette de Bourama : ce qu'il recoit, de l'offre du club a la valeur moins les penalites",
  );
  assert.ok(bourama.some((l) => l.includes(`L'acheteur verse en plus au club ses pénalités (${fcfa(9_500)})`)));
  assert.equal(354_850 + 9_500, 364_350, "au plafond, l'acheteur paie exactement la valeur de la part");
  const avecArrieres = lignesValorisation({
    quotePart: 364_350, part: 0.0961, avance: 0, penalites: 9_500, netClub: 342_940, fraisClub: 11_910,
    arrieres: 15_000,
  });
  assert.ok(avecArrieres.some((l) => l.includes(`ses cotisations impayées (${fcfa(15_000)}), qui comptent dans sa part`)));
  assert.ok(val[0].startsWith(`Valeur de sa part : ${fcfa(430_000)} (25 % du total à partager).`));
  assert.ok(val.some((l) => l.includes(`un prix entre ${fcfa(plancher)}`) && l.includes(`et ${fcfa(406_000)} (la valeur de sa part`)));
  assert.ok(val.some((l) => l.includes("et le club lui rend son avance")), "l'avance reste au sortant");
  assert.ok(val.some((l) => l.startsWith(`Si le club rachète tout : il lui verse ${fcfa(seul.netClub)}`)));
  const qui = lignesPartage({
    avance: 20_000,
    acheteurs: [{ nom: "ACHETEUR Un", ...tout.acheteurs[0], arrieres: 15_000 }],
    fractionClub: 0, droitsClub: 20_000, frais: 0, compensees: 0, netClub: 20_000, resteDu: 0,
  });
  assert.ok(qui[0].includes(
    `il verse ${fcfa(400_000)} au sortant, et en plus au club ${fcfa(24_000)} de pénalités et ` +
      `${fcfa(15_000)} de cotisations impayées, soit ${fcfa(439_000)} en tout.`,
  ));
  assert.ok(qui.includes(`Le club lui rend son avance : ${fcfa(20_000)}.`));
  assert.ok(qui.some((l) => l.includes("les cotisations impayées dans Versements")));
  assert.ok(!val.concat(qui).some((l) => /—|--|undefined|NaN/.test(l)));

  // L'empreinte change avec les acheteurs : un prix modifie fait redemander.
  const f = {
    jour: "2026-10-13", releve: { date: "2026-10-13", total: 1 }, enTransit: 0,
    versementsEnAttente: { nb: 0, total: 0, siens: 0 }, caisseEnAttente: 0, reglementsEnAttente: 0,
    penalites: 0, penalitesEnCours: 0,
  };
  assert.notEqual(
    empreinteSortie("a", f, [{ membreId: "b", fraction: 1, prix: 400_000 }]),
    empreinteSortie("a", f, [{ membreId: "b", fraction: 1, prix: 390_000 }]),
  );
}

{
  /*
   * UNE PART RACHETEE VIT A PART. Sa cotisation suit sa taille, ses penalites
   * suivent sa cotisation, et elle commence a la premiere echeance qui suit le
   * rachat.
   */
  assert.equal(premierMoisDeLaPart("2026-10-05", 10), "2026-10-01", "rachetee avant l'echeance : le mois en cours");
  assert.equal(premierMoisDeLaPart("2026-10-10", 10), "2026-11-01", "le jour de l'echeance : le mois suivant");
  assert.equal(premierMoisDeLaPart("2026-12-20", 10), "2027-01-01", "en fin d'annee : janvier");
  assert.equal(nomDeLaPart("SORO Tiélina", "KONÉ Bourama", 1), "SORO Tiélina · part de KONÉ Bourama");
  assert.equal(nomDeLaPart("SORO Tiélina", "KONÉ Bourama", 0.5), "SORO Tiélina · 50 % de la part de KONÉ Bourama");

  // Une demi-part : demi-cotisation, demi-penalites, et R4 double de la meme facon.
  const entiere = calculerPenalites(["2026-07-01", "2026-08-01", "2026-09-01"], [], { cotisationMensuelle: 5_000, tauxPenalite: 0.1 });
  const demie = calculerPenalites(["2026-07-01", "2026-08-01", "2026-09-01"], [], { cotisationMensuelle: 2_500, tauxPenalite: 0.1 });
  assert.deepEqual(
    demie.map((x) => x.montant),
    entiere.map((x) => x.montant / 2),
    "les penalites d'une demi-part sont la moitie de celles d'une part",
  );
  assert.ok(demie.every((x) => x.doublee), "R4 frappe la part rachetee comme les autres");

  // Ses mois commencent a la premiere echeance qui suit le rachat, pas avant.
  const sit = situationMembre(
    "part", ["2026-09-01", "2026-10-01", "2026-11-01"], [], [], new Date("2026-11-20T12:00:00Z"),
    "2026-11-01", { cotisationMensuelle: 2_500, tauxPenalite: 0.1 }, 0,
  );
  assert.deepEqual(sit.moisEnRetard, ["2026-11-01"], "seul novembre est du");
  assert.equal(sit.cellules.find((c) => c.mois === "2026-11-01").requis, 2_500, "a hauteur de sa taille");

  // Le courrier de sortie d'une part va a son detenteur, et le dit.
  const club = {
    compteTitres: 1_000_000, actions: 900_000, enTransit: 0, caisse: 100_000, creances: 0, avances: 0,
    aPartager: 1_100_000, cotisations: 1_100_000, fraisGardeCourus: 0,
  };
  const t = courrielSortie({
    nom: "SORO Tiélina", part: "SORO Tiélina · 50 % de la part de KONÉ Bourama",
    dateSortie: "2027-03-15", motif: "exclusion de plein droit (R5)", releve: "2027-03-15", club,
    cotisations: 100_000, avance: 0, quotePart: 100_000, droits: 100_000, rachats: [],
    penalites: 0, penalitesEnCours: 0, compensees: 0, pocheActions: 81_818, fraisVente: 1_145,
    fraisGarde: 0, fraisTransfert: 1_977, net: 96_878,
  }).texte;
  assert.ok(t.startsWith("Bonjour SORO Tiélina,"), "au detenteur");
  assert.ok(t.includes("La sortie de la part rachetée que vous détenez (SORO Tiélina · 50 % de la part de KONÉ Bourama) prend effet"));
  assert.ok(t.includes("Votre propre part n'est pas concernée."));
  const c = courrielCorrectionSortie({
    nom: "SORO Tiélina", part: "SORO Tiélina · part de KONÉ Bourama", dateSortie: "2027-03-15",
    fraisAvant: 3_000, fraisApres: 2_500, netAvant: 96_878, netApres: 97_378, raison: "avis d'opéré",
  }).texte;
  assert.ok(c.includes("Les frais réels de la sortie de la part rachetée que vous détenez (SORO Tiélina · part de KONÉ Bourama) sont connus"));
  assert.ok(!/—|--|undefined|NaN/.test(t + c));

  // Avant de confirmer, chaque acheteur lit ce que sa part lui coutera.
  const np = lignesNouvellesParts([{ nom: "SORO Tiélina", taille: 0.5 }], 5_000, "2026-11-01");
  assert.equal(
    np[0],
    `SORO Tiélina : ce qu'il rachète (50 % d'une part) s'ajoute à sa part. Sa cotisation augmente de ` +
      `${fcfa(2_500)} par mois à partir de novembre 2026.`,
  );
}

{
  /*
   * LA VALORISATION AVANT LA SORTIE. Le sortant peut contester la valeur de sa
   * part : il la recoit avec tout le calcul, tant que rien n'est enregistre, et
   * les membres qui pourraient racheter lisent la meme chose.
   */
  const club = {
    compteTitres: 3_797_977, actions: 3_500_000, enTransit: 0, caisse: 0, creances: 9_500,
    avances: 0, aPartager: 3_807_477, cotisations: 3_400_000, fraisGardeCourus: 12_500,
  };
  const base = {
    nom: "KONÉ Bourama", dateSortie: "2026-10-10", releve: "2026-10-10", club,
    cotisations: 325_350, avance: 0, quotePart: 364_350,
    penalites: 9_500, penalitesEnCours: 0, arrieres: 15_000,
    netClub: 342_940, compensees: 9_500, fraisVente: 5_000, fraisGarde: 1_200, fraisTransfert: 5_710,
  };
  const { sujet, texte } = courrielValorisation(base);
  const lignes = texte.split("\n");
  assert.equal(sujet, "IP12 : valeur de votre part, avant la sortie");
  assert.ok(texte.startsWith("Bonjour KONÉ Bourama,"));
  assert.ok(texte.includes("Rien n'est encore enregistré : vous pouvez la contester."));
  assert.ok(texte.includes(`En bref : votre part vaut ${fcfa(364_350)}.`));
  assert.ok(texte.includes("1. CE QUE LE CLUB POSSÉDAIT") && texte.includes("2. VOTRE PART"), "le meme detail que le decompte");
  assert.ok(texte.includes("3. CE QUI VOUS REVIENDRAIT"));
  assert.ok(texte.includes("CONTESTER CE DÉCOMPTE : preuve à l'appui"), "le droit de contester");
  // L'offre du club se refait a la calculatrice : la part, moins chaque retenue.
  const debut = lignes.findIndex((l) => l.startsWith("Si le club rachète tout"));
  const fin = lignes.findIndex((l) => l.startsWith("Soit "));
  const montant = (l) => Number(l.slice(l.lastIndexOf(" : ") + 3).replace(/[^\d]/g, ""));
  const calcul = lignes
    .slice(debut + 1, fin)
    .reduce((t, l) => t + (l.includes("Moins") ? -1 : 1) * montant(l.replace(/, dont.*$/, "")), 0);
  assert.equal(calcul, 342_940, "part moins penalites moins frais = offre du club");
  assert.ok(lignes[fin].startsWith(`Soit ${fcfa(342_940)}, versés sous 4 mois (R5).`));
  assert.ok(texte.includes(`Repère : entre ${fcfa(342_940)} et ${fcfa(354_850)} pour la totalité.`));
  assert.ok(texte.split("\n").length < 45, "concis");
  assert.ok(texte.includes(`vos pénalités (${fcfa(9_500)}) et vos cotisations impayées (${fcfa(15_000)})`));
  assert.ok(!/—|--|undefined|NaN/.test(texte));

  // Avant l'enregistrement, un releve anterieur n'est pas encore confirme : le courrier le dit autrement.
  const ancien = courrielValorisation({ ...base, releve: "2026-10-05" }).texte;
  assert.ok(ancien.includes("le bureau saisira un relevé plus récent avant d'enregistrer la sortie"));
  assert.ok(!ancien.includes("Le bureau a confirmé"));

  // Le meme detail sert l'ecran : memes lignes, memes chiffres.
  let n = 0;
  const detail = lignesValeurDeLaPart(base, (t) => `${++n}. ${t}`, false);
  assert.ok(detail.every((l) => texte.includes(l)), "l'ecran et le courrier disent la meme chose");

  // Une part rachetee : le courrier va au detenteur, et dit laquelle.
  const part = courrielValorisation({ ...base, nom: "SORO Tiélina", part: "SORO Tiélina · part de KONÉ Bourama" });
  assert.equal(part.sujet, "IP12 : valeur de la part rachetée que vous détenez, avant la sortie");
  assert.ok(part.texte.includes("Voici la valeur de la part rachetée que vous détenez (SORO Tiélina · part de KONÉ Bourama)"));
}

{
  /*
   * LES COTISATIONS IMPAYEES DU SORTANT. Sortie le 10/10, jour de l'echeance
   * d'octobre : octobre est du ce jour-la, et la part rachetee ne commence qu'en
   * novembre. Il compte donc dans les impayes, sans quoi personne ne le paierait.
   */
  const cellules = [
    { mois: "2026-06-01", manque: 0 },
    { mois: "2026-07-01", manque: 0 },
    { mois: "2026-08-01", manque: 5_000 },
    { mois: "2026-09-01", manque: 5_000 },
    { mois: "2026-10-01", manque: 5_000 },
  ];
  const debutPart = premierMoisDeLaPart("2026-10-10", 10);
  assert.equal(debutPart, "2026-11-01");
  const dus = arrieresAvant(cellules, debutPart);
  assert.deepEqual(dus.map((x) => x.mois), ["2026-08-01", "2026-09-01", "2026-10-01"], "octobre compris");
  assert.equal(dus.reduce((t, x) => t + x.manque, 0), 15_000, "trois mois, et non deux");
  // Sortie le 5 : octobre n'est pas encore echu, la part rachetee le doit.
  const avant = arrieresAvant(cellules, premierMoisDeLaPart("2026-10-05", 10));
  assert.deepEqual(avant.map((x) => x.mois), ["2026-08-01", "2026-09-01"], "le mois de la part n'est pas compte deux fois");
  // Un acompte : seul ce qui manque est du.
  assert.equal(arrieresAvant([{ mois: "2026-09-01", manque: 3_000 }], "2026-11-01")[0].manque, 3_000);

  assert.equal(listeDesMois(["2026-10-01", "2026-08-01", "2026-09-01"]), "août, septembre et octobre 2026");
  assert.equal(listeDesMois(["2026-12-01", "2027-01-01"]), "décembre 2026 et janvier 2027");
  assert.equal(listeDesMois(["2026-09-01"]), "septembre 2026");

  // L'ecran et le courrier nomment les mois : le bureau et le sortant les verifient.
  const val = lignesValorisation({
    quotePart: 364_350, part: 0.0961, avance: 0, penalites: 9_500, netClub: 342_940, fraisClub: 11_910,
    arrieres: 15_000, moisArrieres: dus.map((x) => x.mois),
  });
  assert.ok(val.some((l) => l.includes(`ses cotisations impayées (${fcfa(15_000)} : août, septembre et octobre 2026)`)));
}

{
  /*
   * L'ECART DE CAISSE ENTRE LA SORTIE ET AUJOURD'HUI. Le bureau compte 100 000
   * en caisse, le decompte au 10/10 en lit 95 000 : l'ecran dit d'ou vient
   * l'ecart, et quoi faire si l'argent etait deja la.
   */
  const faits = {
    jour: "2026-10-10", releve: { date: "2026-10-10", total: 1 }, enTransit: 0,
    versementsEnAttente: { nb: 0, total: 0, siens: 0 }, caisseEnAttente: 0, reglementsEnAttente: 0,
    penalites: 0, penalitesEnCours: 0,
    caisse: { auJour: 95_000, aujourdhui: 100_000, versements: 0, penalites: 5_000, recettes: 0, depenses: 0, virements: 0 },
  };
  const ligne = pointsAVerifier(faits).find((l) => l.startsWith("Écart de caisse :"));
  assert.ok(ligne, "l'ecart de caisse est dit");
  assert.ok(ligne.includes(`${fcfa(95_000)} au 10/10/2026, contre ${fcfa(100_000)} aujourd'hui`));
  assert.ok(ligne.includes(`pénalités encaissées ${fcfa(5_000)}`));
  assert.ok(ligne.includes("corrigez la date de l'opération"));
  assert.ok(!ligne.includes("signalez-le"), "l'ecart est entierement explique");
  // Un ecart que les dates n'expliquent pas se signale.
  const inexplique = pointsAVerifier({ ...faits, caisse: { ...faits.caisse, penalites: 0 } }).find((l) => l.startsWith("Écart de caisse :"));
  assert.ok(inexplique.includes(`${fcfa(5_000)} d'écart ne viennent pas des dates : signalez-le.`));
  // Caisse identique : rien a dire.
  assert.ok(!pointsAVerifier({ ...faits, caisse: { ...faits.caisse, aujourdhui: 95_000, penalites: 0 } }).some((l) => l.startsWith("Écart de caisse :")));
}

/* Le nom court d'une liste sur telephone : le NOM, puis le premier prenom. */
assert.equal(nomCourt("DJAUMAND Komena Elisée Japhet"), "DJAUMAND Komena");
assert.equal(nomCourt("BLA Aimé Ange David"), "BLA Aimé");
assert.equal(nomCourt("KONÉ Bourama"), "KONÉ Bourama", "deux mots : rien a couper");
assert.equal(nomCourt("YOUSSOUF Mohamed Nakeen D."), "YOUSSOUF Mohamed");
assert.equal(nomCourt("Dépense : autre dépense"), "Dépense : autre dépense", "pas un nom : intact");

/* ------------------------------------------------- releve joint a une relance */
{
  const { relevePdf, nomFichierReleve } = await import("../.verif/releve-pdf.mjs");
  const { largeur } = await import("../.verif/pdf.mjs");
  const cellule = (mois, statut, montant, requis = 5000) => ({
    mois, statut, montant, requis, manque: Math.max(0, requis - montant), dateVersement: null,
  });
  const octets = relevePdf({
    nom: "KOUADIO Konan Marc",
    date: "2026-10-27",
    cellules: [
      cellule("2025-09-01", "hors_periode", 0),
      ...["2025-10-01", "2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01",
        "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"].map((m) => cellule(m, "paye", 5000)),
      cellule("2026-09-01", "retard", 0),
      cellule("2026-10-01", "partiel", 2000),
    ],
    penalites: [
      { date: "2026-09-11", nature: "Retard de versement", motif: "Retard de versement, septembre 2026 (réglé après l'échéance, pénalité acquise, art. 9)", montant: 500 },
      { date: "2026-10-11", nature: "Retard de versement", motif: null, montant: 1000 },
    ],
    cotisationsARegler: 8000,
    penalitesDues: 1500,
    verse: 57000,
  });
  const texte = octets.toString("latin1");
  assert.ok(texte.startsWith("%PDF-1.4"), "le releve est un PDF");
  assert.ok(texte.trimEnd().endsWith("%%EOF"), "le releve se termine proprement");
  // Chaque renvoi de la table pointe exactement sur le debut de son objet : sans cela, un lecteur strict refuse le fichier.
  const table = texte.slice(texte.lastIndexOf("xref\n0 "));
  const renvois = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.ok(renvois.length >= 7, "catalogue, pages, polices, informations, une page et son contenu");
  renvois.forEach((pos, i) => assert.ok(texte.startsWith(`${i + 1} 0 obj`, pos), `l'objet ${i + 1} est la ou la table le dit`));
  assert.equal(Number(texte.slice(texte.lastIndexOf("startxref") + 10).trim().split("\n")[0]), texte.lastIndexOf("xref\n0 "));
  // Les accents passent en WinAnsi, octet par octet : « Relevé » et « Pénalités » ne deviennent pas « ? ».
  assert.ok(octets.includes(Buffer.from([0x52, 0x65, 0x6c, 0x65, 0x76, 0xe9])), "« Relevé » encodé en WinAnsi");
  assert.ok(!texte.includes("P?nalit"), "aucun accent perdu");
  // Les parentheses du texte sont echappees : sinon la chaine se fermerait au milieu du motif.
  assert.ok(texte.includes("\\(réglé".replace("é", "\xe9")), "parenthèse ouvrante échappée");
  assert.equal(nomFichierReleve("DRAMÉ Khalil Yvan Zana", "2026-10-27"), "releve-drame-khalil-yvan-zana-2026-10-27.pdf");
  // Les chiffres d'Helvetica ont tous la meme chasse : c'est ce qui permet d'aligner les montants a droite.
  assert.equal(largeur("5 000", 10), largeur("9 999", 10));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(".verif/releve-essai.pdf", octets);
}

{
  /* L'objectif du club : le cas des maquettes, refait a la main. */
  const { avancement, lireObjectif, lireMontant, ecartMois, CLES_OBJECTIF } = await import("../.verif/objectif.mjs");
  const o = { montant: 5_000_000, echeance: "2027-12-01", intitule: null, fixeLe: "2026-01-15", depart: 2_200_000 };
  const a = avancement(o, 3_010_000, "2026-10-17", 97_500, "2026-10-28");
  assert.equal(a.reste, 1_990_000);
  assert.equal(a.moisRestants, 14, "de novembre 2026 a decembre 2027 compris");
  assert.ok(Math.abs(a.atteint - 0.602) < 1e-9);
  assert.equal(a.arrivee, "2028-07-01", "21 mois de cotisations depuis octobre 2026");
  assert.equal(a.aTemps, false);
  assert.equal(a.parMois, 142_143);
  assert.equal(a.cotisationsSeules, 4_375_000);
  assert.equal(a.partBourse, 625_000);
  assert.ok(Math.abs(a.tauxRequis - 625_000 / (4_005_000 * 14 / 12)) < 1e-12);
  // Sur la ligne droite du 15/01/2026 (2,2 M) au 31/12/2027 (5 M), le 17/10/2026 tombe vers 3,28 M.
  assert.ok(Math.abs(a.attendu - (2_200_000 + (275 / 715) * 2_800_000) / 5_000_000) < 1e-9);
  assert.equal(a.echu, false);

  const fait = avancement(o, 5_100_000, "2027-06-30", 97_500, "2027-07-02");
  assert.equal(fait.reste, 0);
  assert.equal(fait.arrivee, null);
  assert.equal(fait.aTemps, true);
  assert.equal(fait.partBourse, 0);
  assert.equal(fait.tauxRequis, 0);

  const echu = avancement(o, 4_000_000, "2028-01-03", 97_500, "2028-01-05");
  assert.equal(echu.echu, true);
  assert.equal(echu.moisRestants, 0);
  assert.equal(echu.tauxRequis, null);
  assert.equal(echu.parMois, 1_000_000);
  assert.equal(echu.attendu, 1, "a l'echeance, il faudrait y etre");

  const sansRythme = avancement({ ...o, depart: null }, 3_010_000, "2026-10-17", 0, "2026-10-28");
  assert.equal(sansRythme.arrivee, null);
  assert.equal(sansRythme.aTemps, false);
  assert.equal(sansRythme.attendu, null, "sans valeur de depart, pas de repere");
  const toutJuste = avancement({ ...o, fixeLe: "2026-10-29", depart: 3_010_000 }, 3_010_000, "2026-10-17", 97_500, "2026-10-29");
  assert.equal(toutJuste.attendu, null, "aucun releve depuis la fixation : pas de repere");

  assert.equal(ecartMois("2026-10-01", "2027-12-01"), 14);
  assert.equal(ecartMois("2026-10-01", "2026-10-01"), 0);

  assert.equal(lireObjectif(new Map()), null);
  const table = new Map([
    [CLES_OBJECTIF.montant, "5000000"], [CLES_OBJECTIF.echeance, "2027-12-01"],
    [CLES_OBJECTIF.fixeLe, "2026-01-15"], [CLES_OBJECTIF.intitule, "  "],
  ]);
  assert.deepEqual(lireObjectif(table), { montant: 5_000_000, echeance: "2027-12-01", intitule: null, fixeLe: "2026-01-15", depart: null });
  table.set(CLES_OBJECTIF.depart, "2200000");
  table.set(CLES_OBJECTIF.intitule, "5 millions fin 2027");
  assert.equal(lireObjectif(table).depart, 2_200_000);
  assert.equal(lireObjectif(table).intitule, "5 millions fin 2027");
  table.set(CLES_OBJECTIF.echeance, "2027-13");
  assert.equal(lireObjectif(table), null, "une echeance illisible n'affiche rien");

  assert.equal(lireMontant("5 000 000"), 5_000_000);
  assert.equal(lireMontant("5\u202f000\u202f000"), 5_000_000);
  assert.equal(lireMontant("5.000.000"), 5_000_000);
  assert.equal(lireMontant("0"), null);
  assert.equal(lireMontant("5 000 FCFA"), null);
  assert.equal(lireMontant("-5000"), null);
}

{
  /* Le fil d'un membre : chaque geste une fois, avec ce qu'il est devenu. */
  const { filDuMembre, parMois, periode } = await import("../.verif/fil.mjs");
  const moi = "m1";
  const v = (o) => ({ lot: "L1", membre_id: moi, mois: "2026-11-01", montant: "7500", mode: "mobile_money", reference: null, note: null,
    statut: "valide", motif: null, cree_le: "2026-10-21T09:00:00", vise_le: "2026-10-22T10:00:00", declare_par: moi,
    declare_par_nom: "SORO Tiélina Aboudramane", vise_par_nom: "TRAORÉ Awa Mariam", ...o });
  const fil = filDuMembre(moi, {
    versements: [
      v({}),
      v({ lot: "L2", mois: "2026-12-01", statut: "en_attente", vise_le: null, cree_le: "2026-10-26T08:00:00" }),
      v({ lot: "L2", mois: "2027-01-01", statut: "en_attente", vise_le: null, cree_le: "2026-10-26T08:00:00" }),
      v({ lot: "L3", mois: "2026-09-01", statut: "rejete", motif: "reçu illisible", vise_le: "2026-09-12T08:00:00", cree_le: "2026-09-11T08:00:00" }),
      v({ lot: "L4", mois: "2026-08-01", declare_par: "t1", declare_par_nom: "TRAORÉ Awa Mariam", cree_le: "2026-08-09T08:00:00", vise_le: "2026-08-09T08:00:00" }),
      v({ lot: "R", mois: "2023-06-01", note: "Reprise de l'historique", cree_le: "2026-09-01T08:00:00", vise_le: "2026-09-01T08:00:00" }),
      v({ lot: "R", mois: "2023-07-01", note: "Reprise de l'historique", cree_le: "2026-09-01T08:00:00", vise_le: "2026-09-01T08:00:00" }),
    ],
    penalites: [
      { id: "p1", membre_id: moi, nature: "retard", montant: "500", motif: null, constatee_le: "2026-10-11", statut: "payee", reglee_le: "2026-10-20", note_reglement: null, resolue_le: null, resolu_par_nom: null },
      { id: "p2", membre_id: moi, nature: "absence", montant: "1000", motif: null, constatee_le: "2026-09-05", statut: "payee", reglee_le: "2026-09-20", note_reglement: "Espèces en réunion", resolue_le: "2026-09-20T18:00:00", resolu_par_nom: "TRAORÉ Awa Mariam" },
      { id: "p3", membre_id: moi, nature: "autre", montant: "2000", motif: "Erreur de saisie", constatee_le: "2026-09-02", statut: "annulee", reglee_le: null, note_reglement: null, resolue_le: "2026-09-03T08:00:00", resolu_par_nom: "SORO Tiélina Aboudramane" },
    ],
    reglements: [
      { lot: "S1", penalite_id: "p1", membre_id: moi, montant: "500", mode: "mobile_money", statut: "validee", motif_rejet: null, cree_le: "2026-10-19T08:00:00", vise_le: "2026-10-20T08:00:00", vise_par_nom: "TRAORÉ Awa Mariam", nature: "retard", motif_penalite: null },
    ],
    rappels: [{ membre_id: moi, canal: "email", mois: "2026-10-01", envoye_le: "2026-10-09T08:00:00" }],
    rachats: [],
  });
  const titres = fil.map((e) => e.titre);
  assert.equal(titres.filter((t) => t === "Versement déclaré").length, 1, "deux mois d'un meme lot font une seule declaration");
  const attente = fil.find((e) => e.titre === "Versement déclaré");
  assert.equal(attente.montant, 15000);
  assert.ok(attente.detail.startsWith("Décembre 2026 à janvier 2027 (2 mois), payé d'avance · Wave."), attente.detail);
  assert.equal(fil[0], attente, "le plus recent d'abord");
  const valide = fil.find((e) => e.cle === "v:m1:L1");
  assert.equal(valide.titre, "Versement validé");
  assert.ok(valide.detail.includes("Visé par TRAORÉ Awa."));
  assert.equal(valide.quand, "déclaré le 21/10 · validé le 22/10");
  assert.equal(fil.find((e) => e.cle === "v:m1:L3").motif, "Motif : reçu illisible");
  const saisi = fil.find((e) => e.cle === "v:m1:L4");
  assert.equal(saisi.titre, "Versement enregistré", "saisi par le bureau, pas declare par le membre");
  assert.equal(saisi.quand, "saisi par TRAORÉ Awa le 09/08");
  const reprise = fil.find((e) => e.titre === "Historique repris");
  assert.equal(reprise.montant, 15000);
  assert.ok(reprise.detail.startsWith("2 mois marqués payés : Juin 2023 à juillet 2023"));
  // La penalite reglee par declaration ne se dit qu'une fois : par son reglement.
  assert.equal(fil.filter((e) => e.titre === "Pénalité réglée").length, 2, "p1 par son reglement, p2 par le bureau");
  assert.equal(fil.find((e) => e.cle === "p:p2:reglee").quand, "réglée le 20/09 · enregistré par TRAORÉ Awa");
  assert.equal(fil.find((e) => e.titre === "Pénalité annulée").quand, "annulée le 03/09 par SORO Tiélina");
  assert.ok(fil.find((e) => e.cle === "p:p1").detail.includes("art. 9"));
  assert.equal(fil.find((e) => e.famille === "rappels").titre, "Rappel automatique");
  assert.equal(fil.find((e) => e.famille === "rappels").detail, "Par courriel, au sujet de la cotisation d'octobre 2026.");
  const groupes = parMois(fil);
  assert.deepEqual(groupes.map((g) => g.mois), ["2026-10-01", "2026-09-01", "2026-08-01"]);
  assert.equal(groupes.reduce((t, g) => t + g.evenements.length, 0), fil.length);
  assert.equal(periode(["2026-08-01", "2026-10-01"]), "Août 2026 et octobre 2026");
  assert.equal(periode(["2026-11-01"]), "Novembre 2026");
  // Deux mois declares a part le meme soir, valides ensemble : une seule ligne.
  const deux = filDuMembre(moi, { versements: [v({ lot: "A" }), v({ lot: "B", mois: "2026-12-01" }), v({ lot: "C", mois: "2027-01-01", vise_le: "2026-10-23T08:00:00" })], penalites: [], reglements: [], rappels: [], rachats: [] });
  assert.equal(deux.length, 2, "A et B fusionnes, C valide un autre jour");
  assert.equal(deux.find((e) => e.montant === 15000).detail.split(".")[0], "Novembre 2026 à décembre 2026 (2 mois), payé d'avance · Wave");
}

{
  /* R4 a partir du 10/01/2027 : une penalite impayee compte comme un mois impaye. */
  const oct = "2026-10-01", nov = "2026-11-01", dec = "2026-12-01", jan = "2027-01-01";
  // Trois mois regles en retard, penalites encore dues : doublees.
  const toutes = calculerPenalites([], [oct, nov, dec], {}, { mois: [oct, nov, dec], sansMois: 0 });
  assert.deepEqual(toutes.map((p) => p.montant), [1000, 1000, 1000], "3 penalites impayees declenchent R4");
  assert.ok(toutes.every((p) => p.doublee && p.figee && p.impaye));
  // Sans le registre (avant la date d'effet), rien ne change.
  const avant = calculerPenalites([], [oct, nov, dec]);
  assert.deepEqual(avant.map((p) => p.montant), [500, 500, 500]);
  assert.ok(avant.every((p) => !p.doublee && !p.impaye));
  // Une penalite deja payee ne compte plus : deux impayes, pas de doublement.
  const deux = calculerPenalites([], [oct, nov, dec], {}, { mois: [nov, dec], sansMois: 0 });
  assert.deepEqual(deux.map((p) => [p.montant, p.impaye]), [[500, false], [500, true], [500, true]]);
  // Cotisation et penalites melangees : janvier impaye, novembre et decembre penalites dues.
  const melange = calculerPenalites([jan], [oct, nov, dec], {}, { mois: [nov, dec], sansMois: 0 });
  assert.deepEqual(melange.map((p) => p.montant), [500, 1000, 1000, 1000], "octobre, penalite payee, reste a 10 %");
  // Quatre impayes : seuls les trois derniers doublent, l'ancien reste a 10 % mais compte.
  const quatre = calculerPenalites([jan], [oct, nov, dec], {}, { mois: [oct, nov, dec], sansMois: 0 });
  assert.deepEqual(quatre.map((p) => p.montant), [500, 1000, 1000, 1000]);
  assert.ok(quatre[0].impaye && !quatre[0].doublee, "octobre impaye, sorti de la fenetre");
  // La reprise en bloc compte pour le seuil, sans jamais etre doublee (ses mois sont inconnus).
  const bloc = calculerPenalites([], [dec], {}, { mois: [dec], sansMois: 11 });
  assert.equal(bloc[0].montant, 1000, "11 reprises + decembre : decembre est parmi les trois derniers");
  const seule = calculerPenalites([], [], {}, { mois: [], sansMois: 11 });
  assert.equal(seule.length, 0, "rien d'identifiable a doubler");

  // La date d'effet decide : la veille rien, le lendemain le doublement.
  const versesEnRetard = [oct, nov, dec].map((m) => ({ mois_couvert: m, montant: 5000, statut: "valide", date_versement: `${m.slice(0, 7)}-25` }));
  const dues = { mois: [oct, nov, dec], sansMois: 0 };
  const veille = situationMembre("m", [oct, nov, dec], versesEnRetard, [], new Date("2027-01-09T12:00:00Z"), undefined, {}, 3, dues);
  assert.equal(veille.totalPenalites, 1500, "le 9 janvier, les penalites ne comptent pas encore");
  const lendemain = situationMembre("m", [oct, nov, dec], versesEnRetard, [], new Date("2027-01-11T12:00:00Z"), undefined, {}, 3, dues);
  assert.equal(lendemain.totalPenalites, 3000, "le 11 janvier, trois penalites impayees doublent");
  assert.equal(lendemain.nbMoisRetard, 0, "les cotisations, elles, sont a jour");
}

{
  /* Le sondage de date : novembre 2026 puis tous les deux mois, du 10 au 17. */
  const C = await import("../.verif/calendrier-reunions.mjs");
  const r = C.RYTHME_PAR_DEFAUT;
  assert.equal(C.estMoisDeReunion("2026-11-01", r), true);
  assert.equal(C.estMoisDeReunion("2026-12-01", r), false);
  assert.equal(C.estMoisDeReunion("2027-01-01", r), true);
  assert.equal(C.estMoisDeReunion("2026-09-01", r), false, "avant le depart du rythme, aucune reunion");
  assert.equal(C.prochainMoisDeReunion("2026-10-01", r), "2026-11-01");
  assert.equal(C.prochainMoisDeReunion("2026-12-01", r), "2027-01-01");
  assert.equal(C.prochainMoisDeReunion("2027-01-01", r), "2027-01-01");
  assert.equal(C.prochainMoisDeReunion("2027-12-01", r), "2028-01-01", "le rythme passe le changement d'annee");
  assert.deepEqual(C.lireRythme("3:2027-01-01"), { intervalle: 3, depart: "2027-01-01" });
  assert.deepEqual(C.lireRythme("n'importe quoi"), r);
  assert.deepEqual(C.lireRythme(C.ecrireRythme({ intervalle: 1, depart: "2027-02-01" })), { intervalle: 1, depart: "2027-02-01" });

  // Ouverture : du 3 au 8 du mois de reunion, au passage du soir.
  assert.equal(C.moisAOuvrir(new Date("2026-11-03T21:00:00Z"), r), "2026-11-01");
  assert.equal(C.moisAOuvrir(new Date("2026-11-02T21:00:00Z"), r), null);
  assert.equal(C.moisAOuvrir(new Date("2026-11-04T21:00:00Z"), r), "2026-11-01", "un passage manque se rattrape");
  assert.equal(C.moisAOuvrir(new Date("2026-11-08T21:00:00Z"), r), "2026-11-01");
  assert.equal(C.moisAOuvrir(new Date("2026-11-09T21:00:00Z"), r), null, "le jour de la cloture, trop tard pour demander");
  assert.equal(C.moisAOuvrir(new Date("2026-12-03T21:00:00Z"), r), null, "decembre n'a pas de reunion");

  // Cloture le lundi 9 a 20 h, la veille du premier jour propose.
  const cloture = C.clotureDuSondage("2026-11-01");
  assert.equal(cloture.toISOString(), "2026-11-09T20:00:00.000Z");
  assert.equal(C.momentEnClair(cloture), "lundi 9/11 à 20 h GMT");
  assert.equal(C.clotureRelative(cloture, new Date("2026-11-03T21:00:00Z")), "lundi soir");
  assert.equal(C.clotureRelative(cloture, new Date("2026-11-08T21:00:00Z")), "demain soir");
  assert.equal(C.clotureRelative(cloture, new Date("2026-11-09T09:00:00Z")), "ce soir");
  // La relance part au passage de midi du dimanche 8, pas avant.
  assert.ok(cloture - new Date("2026-11-08T12:00:00Z") <= C.RELANCE_AVANT_CLOTURE_MS);
  assert.ok(cloture - new Date("2026-11-07T21:00:00Z") > C.RELANCE_AVANT_CLOTURE_MS);
  // Le passage du 9 au soir trouve le sondage clos ; le rappel au president tombe le 10 au soir.
  assert.ok(new Date("2026-11-09T21:00:00Z") >= cloture);
  assert.ok(new Date("2026-11-10T21:00:00Z") - new Date("2026-11-09T21:59:00Z") >= C.RAPPEL_PRESIDENT_APRES_MS);
  assert.ok(new Date("2026-11-10T12:59:00Z") - new Date("2026-11-09T21:00:00Z") < C.RAPPEL_PRESIDENT_APRES_MS,
    "pas de rappel au president le lendemain midi : il a eu la nuit");

  // Le decompte des maquettes, et l'egalite tranchee au plus tot.
  const jours = C.joursDuSondage("2026-11-01");
  assert.equal(jours.length, 8);
  assert.equal(jours[0], "2026-11-10");
  assert.equal(jours[7], "2026-11-17");
  const reponses = [
    { membreId: "a", jours: [14, 15] },
    { membreId: "b", jours: [15] },
    { membreId: "c", jours: [14, 15, 16] },
    { membreId: "d", jours: [] },
  ];
  const comptes = C.decompte(jours, reponses);
  assert.equal(comptes.find((c) => c.jour === "2026-11-15").n, 3);
  assert.deepEqual(C.jourRetenu(comptes).membres, ["a", "b", "c"]);
  assert.equal(C.jourRetenu(comptes).jour, "2026-11-15");
  const egalite = C.decompte(jours, [{ membreId: "a", jours: [12, 16] }, { membreId: "b", jours: [16, 12] }]);
  assert.equal(C.jourRetenu(egalite).jour, "2026-11-12", "a egalite, le plus tot");
  assert.equal(C.jourRetenu(C.decompte(jours, [{ membreId: "d", jours: [] }])), null, "personne de disponible");
  assert.deepEqual(C.joursSaisis(["15", "10", "10", "9", "18", "x", "12.5"]), [10, 15]);

  // Les libelles.
  assert.equal(C.jourEnClair("2026-11-15"), "dimanche 15/11");
  assert.equal(C.jourCourt("2026-11-10"), "mar. 10/11");
  assert.equal(C.duMois("2026-11-01"), "de novembre");
  assert.equal(C.duMois("2027-08-01"), "d'août");
  assert.equal(C.duMois("2027-04-01"), "d'avril");
  assert.equal(C.alertePresident(C.jourRetenu(comptes), 9).corps, "3 membres sur 9 sont dispo le dimanche 15/11. On cale ça ? Un toucher pour valider.");
  assert.equal(C.alertePresident({ jour: "2026-11-15", n: 1, membres: ["a"] }, 9).corps.startsWith("1 membre sur 9 est dispo"), true);
  assert.equal(C.alerteCalee("2026-11-15", "19 h", true).titre, "C'est calé : dimanche 15/11 à 19 h GMT");
  // Aucun tiret cadratin dans ce que lit un membre.
  for (const t of [C.alerteOuverture(cloture, new Date("2026-11-03T21:00:00Z")), C.alerteRelance(cloture, new Date("2026-11-08T21:00:00Z")),
    C.alertePresident(null, 9), C.alerteRappelPresident("2026-11-01", null), C.alerteCalee("2026-11-15", "19 h", false), C.alerteVeille("19 h", "Cocody")]) {
    assert.ok(!/[—]|--/.test(t.titre + t.corps), t.titre);
  }
}

{
  /* La reunion dans l'agenda : une invitation iCalendar que Gmail et l'iPhone acceptent. */
  const A = await import("../.verif/agenda.mjs");
  assert.deepEqual(A.lireHeure("19 h"), { h: 19, m: 0 });
  assert.deepEqual(A.lireHeure("19h30"), { h: 19, m: 30 });
  assert.deepEqual(A.lireHeure("19:30"), { h: 19, m: 30 });
  assert.deepEqual(A.lireHeure("19 h 30"), { h: 19, m: 30 });
  assert.deepEqual(A.lireHeure("8"), { h: 8, m: 0 });
  assert.equal(A.lireHeure("après la prière"), null);
  assert.equal(A.lireHeure("25 h"), null);
  assert.equal(A.heureEnClair("19h"), "19 h");
  assert.equal(A.heureEnClair("19:05"), "19 h 05");
  assert.equal(A.heureEnClair(" après la prière "), "après la prière");

  const inv = {
    uid: "reunion-abc@ip12", sequence: 1793377866, jour: "2026-11-15", heure: "19 h", dureeMinutes: 120,
    titre: "Réunion IP12", lieu: "chez Khalil, Cocody Angré; portail bleu",
    description: "Réunion de novembre du club Investment Pioneers. Détails : https://ip12-alpha.vercel.app/reunions",
    methode: "REQUEST", organisateur: { nom: "Investment Pioneers", email: "club@ip12.ci" },
    invite: { nom: "SORO Tiélina Aboudramane", email: "tielina@ip12.ci" }, emisLe: new Date("2026-11-09T21:30:00Z"),
  };
  const ics = A.fichierIcs(inv);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "toutes les lignes finissent par CRLF");
  assert.ok(ics.includes("METHOD:REQUEST\r\n"));
  assert.ok(ics.includes("DTSTART:20261115T190000Z\r\n"), "19 h a Abidjan, c'est 19 h UTC");
  assert.ok(ics.includes("DTEND:20261115T210000Z\r\n"));
  assert.ok(ics.includes("SEQUENCE:1793377866\r\n"));
  assert.ok(ics.includes("LOCATION:chez Khalil\\, Cocody Angré\\; portail bleu"), "virgule et point-virgule echappes");
  assert.ok(ics.includes("ORGANIZER;CN=\"Investment Pioneers\":mailto:club@ip12.ci"));
  assert.ok(ics.includes("TRIGGER:-PT1H"));
  const enc = new TextEncoder();
  for (const ligne of ics.split("\r\n")) assert.ok(enc.encode(ligne).length <= 75, `ligne trop longue : ${ligne}`);
  // Deplier rend le texte d'origine, accents compris.
  const deplie = ics.replace(/\r\n /g, "");
  assert.ok(deplie.includes("DESCRIPTION:Réunion de novembre du club Investment Pioneers. Détails : https://ip12-alpha.vercel.app/reunions"));
  assert.ok(deplie.includes("ATTENDEE;CN=\"SORO Tiélina Aboudramane\";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:tielina@ip12.ci"));

  // Sans heure lisible : la journee entiere, et pas d'alarme a une heure inventee.
  const journee = A.fichierIcs({ ...inv, heure: "après la prière", methode: "PUBLISH", organisateur: null, invite: null });
  assert.ok(journee.includes("DTSTART;VALUE=DATE:20261115\r\nDTEND;VALUE=DATE:20261116"));
  assert.ok(!journee.includes("VALARM") && !journee.includes("ATTENDEE") && journee.includes("METHOD:PUBLISH"));

  const g = new URL(A.lienGoogleAgenda(inv));
  assert.equal(g.hostname, "calendar.google.com");
  assert.equal(g.searchParams.get("dates"), "20261115T190000Z/20261115T210000Z");
  assert.equal(g.searchParams.get("location"), inv.lieu);
  assert.equal(new URL(A.lienGoogleAgenda({ ...inv, heure: null })).searchParams.get("dates"), "20261115/20261116");
}

{
  /* Quatre fuseaux : Abidjan, la France, le Canada, la Chine. La reunion est a 21 h GMT. */
  const F = await import("../.verif/fuseaux.mjs");
  const C = await import("../.verif/calendrier-reunions.mjs");
  const hiver = new Date("2026-11-15T21:00:00Z");
  assert.equal(F.heureChezSoi(hiver, "Africa/Abidjan"), null, "a Abidjan, l'heure GMT suffit");
  assert.equal(F.heureChezSoi(hiver, "Europe/Paris"), "22 h");
  assert.equal(F.heureChezSoi(hiver, "America/Toronto"), "16 h");
  assert.equal(F.heureChezSoi(hiver, "Asia/Shanghai"), "5 h le lendemain");
  assert.equal(F.heureChezSoi(new Date("2027-07-15T21:00:00Z"), "Europe/Paris"), "23 h", "heure d'ete");
  assert.equal(F.heureChezSoi(new Date("2026-11-15T21:30:00Z"), "Asia/Kolkata"), "3 h le lendemain");
  assert.equal(F.heureChezSoi(new Date("2026-11-15T02:00:00Z"), "America/Vancouver"), "18 h la veille");
  assert.equal(F.heureChezSoi(hiver, null), null);
  // L'heure GMT d'Abidjan fait foi et se lit toujours ; celle du membre la suit, nommee.
  assert.equal(F.heurePour("21 h", hiver, "Europe/Paris"), "21 h GMT, heure d'Abidjan (France : 22 h)");
  assert.equal(F.heurePour("21 h", hiver, "Asia/Shanghai"), "21 h GMT, heure d'Abidjan (Chine : 5 h le lendemain)");
  assert.equal(F.heurePour("21 h", hiver, "America/Toronto"), "21 h GMT, heure d'Abidjan (Toronto : 16 h)");
  assert.equal(F.heurePour("21 h", hiver, "Africa/Abidjan"), "21 h GMT, heure d'Abidjan");
  assert.equal(F.heurePour("21 h", hiver, null), "21 h GMT, heure d'Abidjan");
  assert.equal(F.lieuDuFuseau("Africa/Abidjan"), "Côte d’Ivoire");
  assert.equal(F.lieuDuFuseau("America/Argentina/Buenos_Aires").length > 0, true);
  assert.deepEqual(F.chezSoi(hiver, "Europe/Paris"), { heure: "22 h", lieu: "France" });
  assert.equal(F.chezSoi(hiver, "Africa/Abidjan"), null);
  assert.equal(F.heurePour("après la prière", null, "Europe/Paris"), "après la prière");
  assert.equal(F.fuseauValide("Europe/Paris"), true);
  assert.equal(F.fuseauValide("America/Argentina/Buenos_Aires"), true);
  assert.equal(F.fuseauValide("Mars/Olympus"), false);
  assert.equal(F.fuseauValide("Europe/Paris'; drop table members"), false);
  const calee = C.alerteCalee("2026-11-15", "21 h", true, true, { heure: "22 h", lieu: "France" });
  assert.equal(calee.titre, "C'est calé : dimanche 15/11 à 21 h GMT");
  assert.ok(calee.corps.startsWith("Heure d'Abidjan, soit 22 h chez toi (France). La majorité a parlé."));
  assert.ok(C.alerteCalee("2026-11-15", "21 h", false).corps.startsWith("Heure d'Abidjan. Le président a tranché."));
  assert.equal(C.alerteCalee("2026-11-15", "après la prière", true, false).titre, "C'est calé : dimanche 15/11 à après la prière");
  assert.equal(C.alerteVeille("21 h", null).corps, "Heure d'Abidjan. Viens avec tes idées, pas avec tes excuses.");
  const ouverture = C.alerteOuverture(new Date("2026-11-09T20:00:00Z"), new Date("2026-11-03T12:00:00Z"), { heure: "4 h le lendemain", lieu: "Chine" });
  assert.equal(ouverture.corps, "Coche tes jours entre le 10 et le 17 avant lundi soir, 20 h GMT (Chine : 4 h le lendemain). Sinon on choisit sans toi, faut pas venir pleurer après.");
  assert.equal(C.HEURE_HABITUELLE, "21 h");
}

{
  /* Payer par Wave : le numero du club, celui du membre, la reference du versement. */
  const W = await import("../.verif/wave.mjs");
  assert.equal(W.WAVE_CLUB, "+2250758101989");
  assert.equal(W.numeroEnClair(W.WAVE_CLUB), "+225 07 58 10 19 89");
  assert.equal(W.numeroACopier(W.WAVE_CLUB), "0758101989", "dans Wave, le numero ivoirien se tape a dix chiffres");
  for (const saisie of ["07 08 12 34 56", "0708123456", "+225 07 08 12 34 56", "00225 0708123456", "225-07-08-12-34-56", "07.08.12.34.56"]) {
    assert.equal(W.lireNumero(saisie), "+2250708123456", saisie);
  }
  assert.equal(W.lireNumero("+33 6 12 34 56 78"), "+33612345678");
  assert.equal(W.numeroEnClair("+33612345678"), "+33 6 12 34 56 78");
  assert.equal(W.numeroEnClair("+14165550123"), "+1 416 555 0123");
  assert.equal(W.lireNumero("0708"), null);
  assert.equal(W.lireNumero("7 08 12 34 56"), null, "neuf chiffres : il en manque un");
  assert.equal(W.lireNumero(""), null);
  assert.equal(W.lireNumero("bonjour"), null);
  assert.equal(W.referenceWave("+2250708123456"), "Wave +225 07 08 12 34 56");
  assert.equal(W.numeroDeReference("Wave +225 07 08 12 34 56"), "+2250708123456", "la reference se relit");
  assert.equal(W.numeroDeReference("TX-88213"), null);
  assert.equal(W.numeroDeReference(null), null);
  assert.equal(W.appareilDe("Mozilla/5.0 (Linux; Android 14; SM-A546B)"), "android");
  assert.equal(W.appareilDe("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "ios");
  assert.equal(W.appareilDe("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "autre");
  assert.ok(W.lienOuvrirWave("android").includes("package=com.wave.personal"));
  assert.ok(W.lienOuvrirWave("android").includes("S.browser_fallback_url=https%3A%2F%2Fplay.google.com"));
  assert.equal(W.lienOuvrirWave("ios"), "https://apps.apple.com/app/id1523884528");
  assert.equal(W.lienOuvrirWave("autre"), null);
}

{
  /* Le vote pondere par les parts : majorites, abstentions et silence, R2, membre vise. */
  const V = await import("../.verif/scrutin.mjs");
  const neuf = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, nom: `Membre ${i}` }));
  const egaux = new Map(neuf.map((p) => [p.id, 1 / 9]));
  const liste = V.electeurs(neuf, egaux, new Set(), null);
  const b = (choix) => choix.map((c, i) => ({ membreId: `m${i}`, choix: c })).filter((x) => x.choix);
  // Le cas des maquettes : 7 pour, 1 contre, 1 abstention.
  const r = V.depouiller(liste, b(["pour", "pour", "pour", "pour", "pour", "pour", "pour", "contre", "abstention"]), "trois_quarts");
  assert.equal(V.pourcent(r.tauxPour), "77,8 %");
  assert.equal(r.adopte, true);
  assert.equal(V.phraseResultat(r, "trois_quarts"), "77,8 % des voix pour, au-dessus des 75 % exigés.");
  // Le silence compte contre : 6 pour, 3 sans vote, c'est 66,7 %.
  const silence = V.depouiller(liste, b(["pour", "pour", "pour", "pour", "pour", "pour"]), "trois_quarts");
  assert.equal(silence.adopte, false);
  assert.equal(V.pourcent(silence.silence), "33,3 %");
  assert.equal(silence.votants, 6);
  // Majorite simple : strictement plus de la moitie.
  const deux = V.electeurs([{ id: "a", nom: "A" }, { id: "b", nom: "B" }], new Map([["a", 0.5], ["b", 0.5]]), new Set(), null);
  assert.equal(V.depouiller(deux, [{ membreId: "a", choix: "pour" }, { membreId: "b", choix: "contre" }], "simple").adopte, false, "50 % ne suffit pas");
  assert.equal(V.depouiller(liste, b(["pour", "pour", "pour", "pour", "pour", "contre"]), "simple").adopte, true, "5 sur 9");
  // Trois quarts exactement : adopte.
  const quatre = V.electeurs(["a", "b", "c", "d"].map((id) => ({ id, nom: id })), new Map(["a", "b", "c", "d"].map((id) => [id, 0.25])), new Set(), null);
  assert.equal(V.depouiller(quatre, ["a", "b", "c"].map((id) => ({ membreId: id, choix: "pour" })), "trois_quarts").adopte, true);
  // Unanimite : une seule abstention la rompt.
  assert.equal(V.depouiller(quatre, ["a", "b", "c", "d"].map((id) => ({ membreId: id, choix: "pour" })), "unanimite").adopte, true);
  assert.equal(
    V.depouiller(quatre, [...["a", "b", "c"].map((id) => ({ membreId: id, choix: "pour" })), { membreId: "d", choix: "abstention" }], "unanimite").adopte,
    false,
  );
  // Les voix suivent les parts : 15,1 % contre 9,6 %.
  const poids = V.poidsDesPersonnes(
    [{ membreId: "soro", part: 0.151 }, { membreId: "kouadio", part: 0.096 }, { membreId: "partX", part: 0.05 }, { membreId: "bla", part: 0.1 }],
    new Map([["partX", "soro"], ["soro", null], ["kouadio", null], ["bla", null]]),
  );
  assert.ok(Math.abs(poids.get("soro") - 0.201) < 1e-9, "la part rachetee non fusionnee vote avec son detenteur");
  // R2 et membre vise : ils ne votent pas, et sortent de la base.
  const gens = [{ id: "soro", nom: "SORO" }, { id: "kouadio", nom: "KOUADIO" }, { id: "bla", nom: "BLA" }];
  const l2 = V.electeurs(gens, poids, new Set(["kouadio"]), "bla");
  assert.deepEqual(l2.map((e) => e.exclu), [null, "suspendu", "vise"]);
  const r2 = V.depouiller(l2, [{ membreId: "soro", choix: "pour" }, { membreId: "kouadio", choix: "contre" }, { membreId: "bla", choix: "contre" }], "trois_quarts");
  assert.equal(r2.adopte, true, "les bulletins du suspendu et du membre vise ne comptent pas");
  assert.equal(r2.admis, 1);
  assert.equal(V.depouiller(V.electeurs([], new Map(), new Set(), null), [], "simple").adopte, false, "sans electeur, rien n'est adopte");
  assert.equal(V.estMajorite("trois_quarts"), true);
  assert.equal(V.estMajorite("deux_tiers"), false);
  assert.equal(V.estChoix("pour"), true);
  assert.equal(V.estChoix("peut-etre"), false);
  for (const t of [V.alerteInvitation("Q ?", "dimanche 15/11 à 20 h GMT", { heure: "21 h", lieu: "France" }), V.alerteRelanceVote("Q ?", "x"),
    V.alerteResultat("Q ?", r, "trois_quarts"), V.alerteAnnulation("Q ?", "doublon")]) {
    assert.ok(!/[—]|--/.test(t.titre + t.corps), t.titre);
  }
  assert.equal(V.alerteResultat("Q ?", r, "trois_quarts").titre, "Adopté !");
}

{
  /* Le rapport de reunion : ordre du jour d'office, texte pour WhatsApp, PDF. */
  const R = await import("../.verif/rapport-reunion.mjs");
  const d = {
    date: "2026-11-15", heure: "21 h", lieu: "chez Khalil", depuis: "2026-09-13", arrete: "2026-11-14",
    portefeuille: { valeur: 3008750, dateValeur: "2026-11-13", variation: 0.02 },
    objectif: { taux: 0.6, intitule: "5 millions fin 2027" },
    cotisations: [
      { mois: "2026-10-01", attendu: 50000, encaisse: 45000, aLHeure: 8, dus: 9, impayes: 1 },
      { mois: "2026-11-01", attendu: 50000, encaisse: 50000, aLHeure: 9, dus: 9, impayes: 0 },
    ],
    encaisse: 95000, aJour: { n: 8, total: 9 },
    retards: [{ nom: "KOUADIO Konan", mois: ["2026-10-01"], jours: 47, suspendu: true, declarationExigee: true, declare: false }],
    penalites: { inscrites: 3500, reglees: 1000, absences: 2 },
    caisse: { mouvements: [{ date: "2026-10-20", libelle: "frais de tenue de compte SGI", montant: 2500, depense: true }], solde: 50000 },
    votes: [{ question: "Cotisation 2027", etat: "en cours, clôture le 15/11/2026 à 20 h GMT, 6 votants sur 8" }],
    points: ["Achats de titres : SNTS ou ORGT ?", "  "],
    presences: null,
  };
  assert.equal(R.variationEnClair(0.02), "+2,0 %");
  assert.equal(R.variationEnClair(-0.013), "−1,3 %");
  assert.equal(R.phraseRetard(d.retards[0]), "octobre impayé, 47 jours de retard. Droit de vote suspendu (R2). Retard non déclaré au groupe (R3).");
  assert.deepEqual(R.ordreDuJour(d), [
    "Point sur le portefeuille et les cotisations",
    "Retard de KOUADIO Konan",
    "Vote en cours : Cotisation 2027",
    "Achats de titres : SNTS ou ORGT ?",
  ]);
  /* Les montants s'ecrivent avec des espaces insecables : on les ramene a des espaces pour comparer. */
  const texte = R.rapportTexte(d).replace(/[\u202f\u00a0]/g, " ");
  assert.ok(texte.startsWith("*IP12 · Réunion du 15/11/2026* à 21 h GMT, chez Khalil"));
  assert.ok(texte.includes("Versements reçus : 95 000 FCFA · À jour : 8 sur 9"), texte);
  assert.ok(texte.includes("dont 2 absences"));
  assert.ok(!/[—]|--/.test(texte), "pas de tiret cadratin dans le texte des membres");
  const pdf = R.rapportPdf(d);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 1500);
  assert.equal(R.rapportPdf({ ...d, retards: [], votes: [], cotisations: [], portefeuille: null, objectif: null, presences: { presents: ["A"], excuses: [], absents: ["B"] } }).subarray(0, 5).toString(), "%PDF-");
  assert.equal(R.nomFichierRapport("2026-11-15"), "rapport-ip12-2026-11-15.pdf");
}

{
  /* Le proces-verbal d'un vote clos. */
  const P = await import("../.verif/pv-vote.mjs");
  const V = await import("../.verif/scrutin.mjs");
  const liste = V.electeurs([{ id: "a", nom: "SORO" }, { id: "b", nom: "KOUADIO" }], new Map([["a", 0.6], ["b", 0.4]]), new Set(["b"]), null);
  const bulletins = [{ membreId: "a", choix: "pour" }];
  const pdf = P.pvVotePdf({
    question: "Passer la cotisation à 7 500 FCFA", details: null, majorite: "trois_quarts", auteur: "DRAMÉ Khalil",
    ouvertLe: "2026-10-30", closLe: "2026-11-06", vise: null, electeurs: liste, bulletins, resultat: V.depouiller(liste, bulletins, "trois_quarts"),
  });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 1200);
}

{
  /* La serie de ponctualite : mois payes a l'heure d'affilee, record, frise, alertes. */
  const S = await import("../.verif/serie.mjs");
  const c = (mois, statut) => ({ mois, statut });
  // Le cas de la maquette : fevrier en retard, puis huit mois a l'heure, novembre pas encore echu.
  const cellules = [
    c("2025-11-01", "paye"), c("2025-12-01", "paye"), c("2026-01-01", "paye"), c("2026-02-01", "paye_en_retard"),
    c("2026-03-01", "paye"), c("2026-04-01", "paye"), c("2026-05-01", "paye"), c("2026-06-01", "paye"),
    c("2026-07-01", "paye"), c("2026-08-01", "paye"), c("2026-09-01", "paye"), c("2026-10-01", "paye"),
    c("2026-11-01", "a_venir"), c("2026-12-01", "paye"),
  ];
  assert.equal(S.serieEnCours(cellules, "2026-11-01"), 8, "novembre pas encore echu ne casse rien");
  assert.equal(S.record(cellules, "2026-11-01"), 8);
  assert.equal(S.serieEnCours(cellules.map((x) => (x.mois === "2026-11-01" ? c(x.mois, "paye") : x)), "2026-11-01"), 9);
  assert.equal(S.serieEnCours(cellules.map((x) => (x.mois === "2026-11-01" ? c(x.mois, "en_attente") : x)), "2026-11-01"), 8, "declare, en attente de visa");
  assert.equal(S.serieEnCours(cellules.map((x) => (x.mois === "2026-11-01" ? c(x.mois, "retard") : x)), "2026-11-01"), 0, "le 11, la serie tombe");
  assert.equal(S.serieEnCours(cellules.map((x) => (x.mois === "2026-10-01" ? c(x.mois, "paye_en_retard") : x)), "2026-11-01"), 0);
  assert.equal(S.serieEnCours([c("2026-10-01", "hors_periode"), c("2026-11-01", "paye")], "2026-11-01"), 1, "un nouveau membre commence a 1");
  assert.equal(S.serieEnCours([], "2026-11-01"), 0);
  const frise = S.frise(cellules, "2026-11-01");
  assert.equal(frise.length, 12);
  assert.equal(frise[0].mois, "2025-12-01");
  assert.equal(frise[1].etat, "ok");
  assert.equal(frise.find((x) => x.mois === "2026-02-01").etat, "retard");
  assert.equal(frise.at(-1).etat, "attente");
  // Les alertes.
  assert.equal(S.alerteSerieValidee(9, 8, "2026-11-01", 10).titre, "Nouveau record : 9 mois !");
  const monte = S.alerteSerieValidee(9, 11, "2026-11-01", 10);
  assert.equal(monte.titre, "Tu as gâté, môgô ! 9 mois d'affilée");
  assert.equal(monte.corps, "Novembre payé avant le 10, c'est doux. Encore 3 mois et ton record est dans le sac. Atalaku pour toi !");
  assert.equal(S.alerteSerieValidee(1, 0, "2026-11-01", 10).titre, "C'est parti : 1 mois à l'heure");
  assert.equal(S.alerteSerieValidee(2, 2, "2026-11-01", 10).titre, "Tu as gâté, môgô ! 2 mois d'affilée", "egaler son record n'est pas le battre");
  assert.equal(S.alerteSerieTombee(8, "2026-12-01", 10).corps, "Tes 8 mois d'affilée sont partis. Ça va aller ! On repart propre en décembre. Le 10, on t'attend dêh.");
  assert.equal(S.phraseSerie(8, "2026-11-01", "a_venir", 10), "Le 10 approche : règle novembre d'ici là et passe à 9 mois, môgô.");
  // L'avance : decembre, janvier et fevrier deja payes, mars non.
  const avances = [c("2026-11-01", "paye"), c("2026-12-01", "paye"), c("2027-01-01", "paye"), c("2027-02-01", "paye"), c("2027-03-01", "a_venir")];
  assert.deepEqual(S.avanceDe(avances, "2026-11-01"), { n: 3, jusqua: "2027-02-01" });
  assert.deepEqual(S.avanceDe([c("2026-12-01", "en_attente"), c("2027-01-01", "paye")], "2026-11-01"), { n: 0, jusqua: null }, "l'avance s'arrete au premier trou");
  assert.equal(
    S.phraseSerie(42, "2026-10-01", "paye", 10, { n: 3, jusqua: "2027-01-01" }),
    "Tu es en avance, môgô : tout est payé jusqu'à janvier 2027. Ta série montera toute seule jusqu'à 45 mois.",
  );
  for (const t of [S.alerteSerieJ3(8, 10), S.alerteSerieJourJ(8), S.alerteClubAJour(9, 10), monte]) {
    assert.ok(!/[—]|--/.test(t.titre + t.corps), t.titre);
  }
}

/* ------------------------------------------------------------------ bourse */
{
  const B = await import("../.verif/bourse.mjs");
  assert.equal(B.lireNombre("11 213.616"), 11213.616);
  assert.equal(B.lireNombre("-56 232.999"), -56232.999);
  assert.equal(B.lireNombre("2,13"), 2.13);
  assert.equal(B.lireNombre("NSIA"), null);
  assert.equal(B.lireDateEnLettres("Veuillez trouver ci-jointe la situation au 30 octobre 2026"), "2026-10-30");
  assert.equal(B.lireDateEnLettres("Vendredi, 3 février, 2027"), "2027-02-03");

  const page = `<p>Dernière mise à jour : Vendredi, 30 octobre, 2026 - 18:15</p><table>
    <tr><th>Symbole</th><th>Nom</th></tr>
    <tr><td>SNTS</td><td>SONATEL SENEGAL</td><td>1 234</td><td>4 150</td><td>4 200</td><td>4 350</td><td>4,82</td></tr>
    <tr><td>ABJC</td><td>SERVAIR ABIDJAN COTE D&#039;IVOIRE</td><td>10</td><td>3 280</td><td>3 280</td><td>3 350</td><td>2,13</td></tr>
    <tr><td>NTLC</td><td>NESTLE</td><td>3</td><td>13 400</td><td>13 400</td><td>13 400</td><td>-1,5</td></tr>
  </table>`;
  const cours = B.lireCoursBrvm(page);
  assert.equal(cours.length, 3);
  assert.deepEqual(cours[1], { symbole: "ABJC", nom: "SERVAIR ABIDJAN COTE D'IVOIRE", cloture: 3350, variation: 0.0213 });
  assert.equal(cours[2].variation, -0.015);
  assert.equal(B.dateDeSeance(page), "2026-10-30");
  const indice = B.lireIndiceComposite("<tr><td>BRVM - COMPOSITE</td><td>528,25</td><td>534,71</td><td>1,22</td><td>1,70</td></tr>");
  assert.equal(indice.cloture, 534.71);
  assert.ok(Math.abs(indice.variationAnnee - 0.017) < 1e-12);

  const releve = B.lireReleve(
    [
      ["Veuillez trouver ci-jointe la situation au 30 octobre 2026"],
      ["Libellé", "Quantité", "CMP", "Cours", "+/- value", "Pondération", "Valorisation"],
      ["SONATEL SN", "80", "2 513.800", "4 350.000", "146 896.000", "9.13", "348 000.000"],
      ["NESTLE CI", "24", "10 951.252", "13 400.000", "58 769.952", "8.44", "321 600.000"],
      ["TITRE NOUVEAU", "10", "3 000.000", "3 350.000", "3 500.000", "0.88", "33 500.000"],
      ["Liquidité Disponible", "1 249 216.016"],
      ["Liquidité Réservée", "13 195.114"],
      ["TOTAL", "1 965 511.130"],
    ],
    cours,
  );
  assert.equal(releve.date, "2026-10-30");
  assert.equal(releve.liquidites, 1262411.13);
  assert.equal(releve.total, 1965511.13);
  assert.deepEqual(releve.lignes.map((l) => l.symbole), ["SNTS", "NTLC", "ABJC"], "un nom inconnu se retrouve par son cours");
  assert.equal(B.symboleDe("INCONNU", 4350.2, [...cours, { symbole: "XXXX", nom: "", cloture: 4350, variation: 0 }]), null, "deux cours egaux : pas de devinette");

  const mvt = (date, nature, symbole, quantite, prix, frais = 0, montant = 0) => ({ date, nature, symbole, quantite, prix, frais, montant });
  const mouvements = [
    mvt("2026-11-03", "achat", "SNTS", 20, 4400, 1000),
    mvt("2026-11-05", "vente", "NTLC", 24, 13500, 500),
    mvt("2026-11-06", "dividende", "SNTS", 0, 0, 0, 30000),
    mvt("2026-11-07", "achat", "ORAC", 10, 15000, 0),
  ];
  const pos = B.positionsApres(releve, mouvements);
  const snts = pos.find((p) => p.symbole === "SNTS");
  assert.equal(snts.quantite, 100);
  assert.ok(Math.abs(snts.cmp - (80 * 2513.8 + 20 * 4400 + 1000) / 100) < 1e-9, "le prix moyen s'ajuste, frais compris");
  assert.ok(!pos.some((p) => p.symbole === "NTLC"), "une ligne vendue en entier disparait");
  assert.equal(pos.find((p) => p.symbole === "ORAC").quantite, 10);

  const liq = B.liquiditesApres(
    { date: releve.date, liquidites: releve.liquidites },
    [{ date: "2026-10-15", net: 50000, frais: 0 }, { date: "2026-11-02", net: 100000, frais: 1500 }],
    mouvements,
  );
  assert.ok(Math.abs(liq - (1262411.13 + 98500 - 89000 + 323500 + 30000 - 150000)) < 1e-6, "virement apres le releve, frais de la SGI deduits");

  const v = B.valoriser(pos, new Map([["SNTS", { cloture: 4500, variation: 0.01 }]]), new Map([["ABJC", 3350]]), 1000);
  assert.equal(v.lignes[0].symbole, "SNTS");
  assert.equal(v.lignes[0].valeur, 450000);
  assert.equal(v.lignes.find((l) => l.symbole === "ABJC").variation, null, "sans cours du soir, celui du releve");
  assert.equal(v.lignes.find((l) => l.symbole === "ORAC").cours, 15000, "a defaut, le prix moyen");
  assert.equal(v.total, 450000 + 33500 + 150000 + 1000);

  assert.ok(Math.abs(B.performance(1000, 1210, 100) - 110 / 1050) < 1e-12, "apports retires");
  assert.equal(B.performance(0, 0, 0), null);
  assert.deepEqual(
    B.departDeLAnnee([{ date: "2025-12-15", total: 1 }, { date: "2026-02-10", total: 2 }], 2026),
    { date: "2025-12-15", total: 1 },
  );
  assert.deepEqual(B.departDeLAnnee([{ date: "2026-02-10", total: 2 }], 2026), { date: "2026-02-10", total: 2 });
  const base = B.indiceBase100([
    { date: "2026-01-02", valeur: 100, apports: 0 },
    { date: "2026-01-03", valeur: 160, apports: 50 },
  ]);
  assert.ok(Math.abs(base[1].indice - 110) < 1e-9, "un apport ne se lit pas comme un gain");
  /* Les dividendes, d'apres les avis de brvm.org. */
  const avisHtml = `<table><tr><th>Emetteur</th><th>Date ex-dividende</th></tr>
    <tr><td>SMB</td><td></td><td></td><td>2025</td><td>18 septembre 2026</td><td>17 septembre 2026</td><td>800 FCFA</td><td><a href="https://www.brvm.org/x_-_smb_ci.pdf">Télécharger</a></td></tr>
    <tr><td>ECOBANK TG</td><td></td><td></td><td>2025</td><td>30 juin 2026</td><td>26 juin 2026</td><td>0,16 cents de dollars</td><td></td></tr>
    <tr><td>SITAB</td><td></td><td></td><td>2025</td><td>13 août 2026</td><td>12 août 2026</td><td>1 707,2 FCFA</td><td></td></tr>
    <tr><td>CFAO MOTORS CI</td><td></td><td></td><td>2024</td><td>19 août 2025</td><td>18 août 2025</td><td>XOF 8</td><td></td></tr>
  </table>`;
  const lus = B.lireDividendesBrvm(avisHtml.replace("<table>", "<p>Date ex-dividende</p><table>"));
  assert.equal(lus.length, 4);
  assert.deepEqual(lus[0], { emetteur: "SMB", exercice: "2025", paiement: "2026-09-18", ex: "2026-09-17", montant: 800, avis: "https://www.brvm.org/x_-_smb_ci.pdf" });
  assert.equal(lus[1].montant, null, "un montant en dollars ne s'inscrit pas");
  assert.equal(lus[2].montant, 1707.2);
  assert.equal(lus[3].montant, 8);
  const pdf = (slug) => `https://www.brvm.org/sites/default/files/avis_-_paiement_de_dividendes_-_${slug}.pdf`;
  for (const [emetteur, slug, attendu] of [
    ["BOLLORE TRANSPORT & LOGISTICS", "agl_ci", "SDSC"],
    ["TOTAL", "totalenergies_marketing_ci", "TTLC"],
    ["TOTAL SENEGAL S.A.", "totalenergies_marketing_sn", "TTLS"],
    ["SGCI", "societe_generale_ci", "SGBC"],
    ["SIB", "sib_ci", "SIBC"],
    ["BICI CI", "bicici", "BICC"],
    ["CIE CI", "cie_ci", "CIEC"],
    ["BANK OF AFRICA BN", "boab", "BOAB"],
    ["BANK OF AFRICA CI", "boa_ci", "BOAC"],
    ["BANK OF AFRICA BF", "boa_bf", "BOABF"],
    ["ECOBANK CI", "ecobank_ci", "ECOC"],
    ["ECOBANK TG", "eti_tg", "ETIT"],
    ["SONATEL", "sonatel_sn", "SNTS"],
    ["NSBC", "nsia_banque_ci", "NSBC"],
    ["LNB", "loterie_nationale_du_benin", "LNBB"],
    ["SERVAIR ABIDJAN CI", "servair_abidjan_ci", "ABJC"],
    ["ONATEL BF", "onatel_bf", "ONTBF"],
    ["SMB", "smb_ci", "SMBC"],
  ]) {
    assert.equal(B.symboleDuDividende({ emetteur, avis: pdf(slug) }), attendu, emetteur);
  }
  assert.equal(B.symboleDuDividende({ emetteur: "TOTAL", avis: null }), null, "« TOTAL » seul : Côte d'Ivoire ou Sénégal, le site ne devine pas");
  assert.equal(B.symboleDuDividende({ emetteur: "SOCIETE INCONNUE", avis: null }), null);

  const rel = { date: "2026-10-30", lignes: [{ nom: "SMB CI", symbole: "SMBC", quantite: 16, cmp: 1, cours: 1, valeur: 1 }] };
  const mv = [mvt("2026-11-10", "achat", "SMBC", 4, 14000), mvt("2026-11-20", "vente", "SMBC", 10, 15000), mvt("2026-10-20", "achat", "SMBC", 6, 14000)];
  assert.equal(B.quantiteALaVeille("SMBC", "2026-11-15", rel, mv), 20, "l'achat d'avant la date ex compte");
  assert.equal(B.quantiteALaVeille("SMBC", "2026-11-10", rel, mv), 16, "l'achat du jour ex ne touche pas le dividende");
  assert.equal(B.quantiteALaVeille("SMBC", "2026-10-15", rel, mv), 10, "avant le releve : on recule");
  assert.equal(B.quantiteALaVeille("NTLC", "2026-11-15", rel, mv), 0);
}

console.log(
  `OK - ${verifications} verifications : performance, parts et avances, ` +
    "penalites art. 9, R4 et indissociabilite, versements partiels, regles " +
    "individuelles, retards, absences, R3, R5, relance, etats du registre, horizons, "
    + "net place et gain de gestion, reperes de l'abscisse, "
    + "cumul, gain de periode et marches, etat de l'echeance, seuil R5, "
    + "ordre de reglement des mois, imputation d'un versement et des penalites, "
    + "total des cotisations a regler, avance obligatoire, sortie en side pocket, caisse et sorties, "
    + "courrier de sortie, rachat des parts par des membres, parts rachetees distinctes, valorisation avant la sortie, releve PDF joint a une relance, objectif du club, fil d'un membre, R4 et penalites indissociables, sondage de date de reunion, invitation d'agenda, fuseaux des membres, paiement par Wave, vote pondere par les parts, rapport de reunion, serie de ponctualite, bourse, releve SGI et dividendes",
);
