import assert from "node:assert/strict";
import test from "node:test";
import { inferTreeStructuralForm } from "../src/lib/tree-structural-form.mjs";

test("explicit pollard and multi-stem tags remain authoritative", () => {
  const pollard = inferTreeStructuralForm({ heightM: 11, crownDiameterM: 8, tags: { tree_form: "pollarded" } });
  assert.equal(pollard.form, "pollarded");
  assert.equal(pollard.inferred, false);
  const multi = inferTreeStructuralForm({ heightM: 13, crownDiameterM: 9, tags: { stem_count: 4 } });
  assert.equal(multi.form, "multi-stem");
  assert.equal(multi.stemCount, 4);
});

test("young trees are inferred conservatively from small measured dimensions", () => {
  const form = inferTreeStructuralForm({ heightM: 5.2, crownDiameterM: 3.1, leafType: "broadleaved" });
  assert.equal(form.form, "young");
  assert.ok(form.trunkScale < 1);
  assert.equal(form.deadwoodFraction, 0);
});

test("large irregular broadleaf trees can qualify as veteran only from multiple cues", () => {
  const form = inferTreeStructuralForm({
    heightM: 18,
    crownDiameterM: 16,
    genus: "Quercus",
    reconstruction: { asymmetry: 0.5, coverageAreaM2: 145, radiusXM: 8.5, radiusZM: 7.5 }
  });
  assert.equal(form.form, "veteran");
  assert.ok(form.confidence >= 0.62);
  assert.ok(form.trunkScale > 1.2);
  assert.ok(form.canopyDensityScale < 1);
});

test("a wide crown alone does not manufacture veteran status", () => {
  const form = inferTreeStructuralForm({ heightM: 18, crownDiameterM: 13, genus: "Quercus" });
  assert.notEqual(form.form, "veteran");
});

test("damaged evidence reduces canopy density and introduces deadwood", () => {
  const form = inferTreeStructuralForm({ heightM: 15, crownDiameterM: 10, tags: { condition: "storm damaged split limb" } });
  assert.equal(form.form, "damaged");
  assert.ok(form.deadwoodFraction > 0.1);
  assert.ok(form.canopyDensityScale < 0.8);
});
