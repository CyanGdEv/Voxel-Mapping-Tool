import test from "node:test";
import assert from "node:assert/strict";
import { resolveTreeBranchArchitecture, branchRadiusAt, junctionRadius } from "../src/lib/tree-branch-architecture.mjs";

test("explicit primary limb diameter remains authoritative", () => {
  const a = resolveTreeBranchArchitecture({ dbhM: 1.2, species: "Quercus robur", tags: { "tree:primary_branch_diameter": 0.62 } });
  assert.equal(a.source, "explicit-branch-evidence");
  assert.equal(a.observed, true);
  assert.equal(a.primaryDiameterM, 0.62);
});

test("veteran oak receives heavier primary limbs than young birch at same DBH", () => {
  const oak = resolveTreeBranchArchitecture({ dbhM: 1.0, species: "Quercus robur", structuralForm: { form: "veteran" }, preset: { family: "broadleaf" } });
  const birch = resolveTreeBranchArchitecture({ dbhM: 1.0, species: "Betula pendula", structuralForm: { form: "young" }, preset: { family: "broadleaf" } });
  assert.ok(oak.primaryDiameterM > birch.primaryDiameterM);
});

test("branch radius tapers monotonically from collar to tip", () => {
  const a = { primaryRadiusBlocks: 2, secondaryRadiusBlocks: 1, tertiaryRadiusBlocks: 0, primaryTaperExponent: 0.85, junctionCollarScale: 1.25 };
  const r0 = branchRadiusAt(a, 0, 0);
  const r1 = branchRadiusAt(a, 0.4, 0);
  const r2 = branchRadiusAt(a, 0.85, 0);
  assert.ok(r0 >= r1);
  assert.ok(r1 >= r2);
});

test("junction collars cannot be thinner than connected limbs", () => {
  const a = { junctionCollarScale: 1.3 };
  assert.ok(junctionRadius(a, 1, 1) >= 1);
  assert.ok(junctionRadius(a, 2, 1) >= 2);
});

test("explicit non-forked evidence overrides structural-form fork tendency", () => {
  const a = resolveTreeBranchArchitecture({ dbhM: 1.4, structuralForm: { form: "veteran" }, tags: { "tree:forked": "no" } });
  assert.equal(a.forked, false);
  assert.equal(a.observed, true);
});
