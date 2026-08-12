import test from "node:test";
import assert from "node:assert/strict";
import { resolveTreeStemArchitecture, insideStemCrossSection } from "../src/lib/tree-stem-architecture.mjs";

test("explicit hollow and split stem evidence remains authoritative", () => {
  const stem = resolveTreeStemArchitecture({
    dbhM: 1.1,
    tags: { "tree:trunk_form": "split", "tree:hollow": "yes", "tree:hollow_diameter": 0.32, "tree:stem_count": 3 },
    structuralForm: { form: "mature", stemCount: 1 },
    seed: 2
  });
  assert.equal(stem.form, "split");
  assert.equal(stem.hollow, true);
  assert.equal(stem.hollowObserved, true);
  assert.equal(stem.stemCount, 3);
  assert.equal(stem.observed, true);
});

test("veteran morphology may become irregular but DBH remains unchanged", () => {
  const stem = resolveTreeStemArchitecture({ dbhM: 1.35, genus: "Quercus", structuralForm: { form: "veteran", stemCount: 1 }, seed: 9 });
  assert.equal(stem.form, "irregular");
  assert.equal(stem.equivalentDbhM, 1.35);
  assert.ok(stem.ellipticity >= 1 && stem.ellipticity <= 1.5);
  assert.ok(stem.fluting >= 2);
});

test("species morphology can produce fluting conservatively", () => {
  const stem = resolveTreeStemArchitecture({ dbhM: 0.8, genus: "Carpinus", structuralForm: { form: "mature", stemCount: 1 }, seed: 3 });
  assert.equal(stem.form, "fluted");
  assert.ok(stem.fluting >= 3);
  assert.equal(stem.hollowObserved, false);
});

test("elliptical cross section preserves directional variation", () => {
  const architecture = { form: "elliptical", ellipticity: 1.35, fluting: 0, hollow: false, stemCount: 1 };
  const samples = [];
  for (let z = -3; z <= 3; z += 1) for (let x = -3; x <= 3; x += 1) {
    if (insideStemCrossSection(x, z, 2, architecture, 4)) samples.push([x, z]);
  }
  assert.ok(samples.length > 5);
  const xs = samples.map(([x]) => x), zs = samples.map(([, z]) => z);
  assert.notEqual(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
});

test("hollow trunks remove interior cells above the buttress base", () => {
  const solid = { form: "round", ellipticity: 1, fluting: 0, hollow: false, equivalentDbhM: 1.5, stemCount: 1 };
  const hollow = { ...solid, hollow: true, hollowRadiusM: 0.35 };
  let solidCount = 0, hollowCount = 0;
  for (let z = -3; z <= 3; z += 1) for (let x = -3; x <= 3; x += 1) {
    solidCount += insideStemCrossSection(x, z, 2.3, solid, 5) ? 1 : 0;
    hollowCount += insideStemCrossSection(x, z, 2.3, hollow, 5) ? 1 : 0;
  }
  assert.ok(hollowCount < solidCount);
});
