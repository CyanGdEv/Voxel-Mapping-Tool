import test from "node:test";
import assert from "node:assert/strict";
import { resolveTreeFoliageMicrostructure, foliagePadRadii, shouldKeepFoliageCell, foliageCurtainLength } from "../src/lib/tree-foliage-microstructure.mjs";

test("explicit foliage density remains authoritative", () => {
  const r = resolveTreeFoliageMicrostructure({ preset: { canopyDensity: 0.9, family: "broadleaf" }, tags: { "tree:foliage_density": 0.44 }, structuralForm: { canopyDensityScale: 1 } });
  assert.equal(r.source, "explicit-foliage-density");
  assert.equal(r.observed, true);
  assert.equal(r.density, 0.44);
});

test("willow creates hanging curtain microstructure", () => {
  const r = resolveTreeFoliageMicrostructure({ preset: { canopyDensity: 0.8, family: "broadleaf", crownShape: "weeping", branchDroop: 0.3 }, species: "Salix alba", structuralForm: { canopyDensityScale: 1 } });
  assert.equal(r.padStyle, "hanging-curtain");
  assert.ok(r.hangingFraction >= 0.5);
  assert.ok(foliageCurtainLength(r, 18, 12, 3) > 0);
});

test("pine remains open and horizontally layered", () => {
  const r = resolveTreeFoliageMicrostructure({ preset: { canopyDensity: 0.7, family: "conifer", crownShape: "open-conifer" }, species: "Pinus sylvestris", structuralForm: { canopyDensityScale: 1 } });
  assert.equal(r.padStyle, "open-needle-pad");
  assert.ok(r.horizontalScale > 1.3);
  assert.ok(r.verticalScale < 0.6);
  assert.ok(r.gapFraction > 0.2);
});

test("branch-tip pads are bounded relative to crown", () => {
  const r = resolveTreeFoliageMicrostructure({ preset: { canopyDensity: 0.8, family: "broadleaf" }, structuralForm: { canopyDensityScale: 1 } });
  const pad = foliagePadRadii(r, 10, 42, 2);
  assert.ok(pad.radiusX >= 1 && pad.radiusX <= 5);
  assert.ok(pad.radiusZ >= 1 && pad.radiusZ <= 5);
  assert.ok(pad.radiusY >= 1 && pad.radiusY <= 4);
});

test("microstructure carves interior gaps and feathers edges", () => {
  const micro = { density: 0.72, gapFraction: 0.3, edgeFeather: 0.4 };
  assert.equal(shouldKeepFoliageCell({ normalized: 0.2, rough: 0.05, micro }), false);
  assert.equal(shouldKeepFoliageCell({ normalized: 0.2, rough: 0.6, micro }), true);
  assert.equal(shouldKeepFoliageCell({ normalized: 1.2, rough: 0.01, micro }), false);
});
