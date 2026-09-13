// Verification des calculs financiers sur les chiffres reels du club.
// Lancement : npm run verif
import { strict as assert } from "node:assert";

const { tri, dietzModifie, repartirParts } = await import("../.verif/perf.mjs");

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
assert.ok(d.rendement !== null && d.rendement > 0.2 && d.rendement < 0.32, `Dietz hors plage: ${d.rendement}`);

const parts = repartirParts(
  [
    { membreId: 1, nom: "A", verse: 200_000 },
    { membreId: 2, nom: "B", verse: 100_000 },
  ],
  600_000,
);
assert.ok(Math.abs(parts[0].part - 2 / 3) < 1e-9);
assert.equal(Math.round(parts[0].valeur), 400_000);
assert.equal(Math.round(parts[1].plusValue), 100_000);

console.log("OK - calculs de performance verifies (TRI, Dietz modifie, parts)");
