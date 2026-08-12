import test from "node:test";
import assert from "node:assert/strict";
import { inferTreeTrunkLean, trunkAxisOffsetAt } from "../src/lib/tree-trunk-lean.mjs";

test("explicit lean vector remains authoritative", () => {
  const lean = inferTreeTrunkLean({ heightM: 18, crownDiameterM: 10, tags: { "tpmap:trunk_lean_dx_m": "1.5", "tpmap:trunk_lean_dz_m": "-0.5" }, reconstruction: { offsetXM: -4, offsetZM: 3, asymmetry: 0.8 } });
  assert.equal(lean.source, "explicit-lean-vector");
  assert.equal(lean.observed, true);
  assert.equal(lean.dxM, 1.5);
  assert.equal(lean.dzM, -0.5);
});

test("crown offset yields conservative inferred lean", () => {
  const lean = inferTreeTrunkLean({ heightM: 20, crownDiameterM: 14, reconstruction: { offsetXM: 3.2, offsetZM: 1.1, asymmetry: 0.32 } });
  assert.equal(lean.source, "inferred-structural-evidence");
  assert.ok(lean.dxM > 0);
  assert.ok(lean.dzM > 0);
  assert.ok(lean.topShiftM <= 2.4 + 1e-6);
  assert.ok(lean.angleDeg < 8);
});

test("symmetric crown remains vertical", () => {
  const lean = inferTreeTrunkLean({ heightM: 16, crownDiameterM: 9, reconstruction: { offsetXM: 0.1, offsetZM: -0.1, asymmetry: 0.02 } });
  assert.equal(lean.source, "vertical-default");
  assert.equal(lean.topShiftM, 0);
});

test("terrain slope alone has a small bounded effect", () => {
  const lean = inferTreeTrunkLean({ heightM: 25, crownDiameterM: 11, reconstruction: { offsetXM: 0, offsetZM: 0, asymmetry: 0, terrainSlopeDx: 1, terrainSlopeDz: 0, terrainSlopeGrade: 0.35 } });
  assert.ok(lean.dxM < 0);
  assert.ok(lean.topShiftM < 1);
});

test("trunk axis curves progressively from fixed base", () => {
  const lean = { dxM: 2, dzM: -1 };
  assert.deepEqual(trunkAxisOffsetAt(lean, 0), { x: 0, z: 0 });
  const middle = trunkAxisOffsetAt(lean, 0.5);
  assert.equal(middle.x, 1);
  assert.equal(middle.z, -0.5);
  assert.deepEqual(trunkAxisOffsetAt(lean, 1), { x: 2, z: -1 });
});
