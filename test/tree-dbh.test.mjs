import test from "node:test";
import assert from "node:assert/strict";
import { resolveTreeDbh, dbhToVoxelProfile } from "../src/lib/tree-dbh.mjs";

test("explicit DBH remains authoritative", () => {
  const result = resolveTreeDbh({ heightM: 20, crownDiameterM: 12, tags: { dbh_cm: 86 } });
  assert.equal(result.observed, true);
  assert.equal(result.source, "explicit-diameter-cm");
  assert.equal(result.dbhM, 0.86);
  assert.ok(result.confidence > 0.95);
});

test("circumference converts to diameter", () => {
  const result = resolveTreeDbh({ tags: { circumference: Math.PI } });
  assert.equal(result.observed, true);
  assert.equal(result.dbhM, 1);
});

test("veteran broadleaf estimate is thicker than young tree", () => {
  const young = resolveTreeDbh({ heightM: 8, crownDiameterM: 5, species: "oak", structuralForm: { form: "young" } });
  const veteran = resolveTreeDbh({ heightM: 18, crownDiameterM: 18, species: "oak", structuralForm: { form: "veteran" } });
  assert.equal(young.observed, false);
  assert.ok(veteran.dbhM > young.dbhM * 2);
});

test("voxel profile scales buttress and roots from DBH", () => {
  const small = dbhToVoxelProfile(0.25, { structuralForm: { form: "young" } });
  const large = dbhToVoxelProfile(1.6, { structuralForm: { form: "veteran" } });
  assert.ok(large.baseRadiusBlocks > small.baseRadiusBlocks);
  assert.ok(large.rootReachBlocks > small.rootReachBlocks);
  assert.ok(large.majorLimbRadiusBlocks >= small.majorLimbRadiusBlocks);
});
