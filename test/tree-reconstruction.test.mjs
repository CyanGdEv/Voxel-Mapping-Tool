import assert from "node:assert/strict";
import test from "node:test";
import {
  crownReachFromTrunk,
  insideCrownEnvelope,
  normalizeTreeReconstruction,
  reconstructTreeCrownFromSamples
} from "../src/lib/tree-reconstruction.mjs";

test("reconstructs asymmetric connected crown and rejects neighbouring component", () => {
  const samples = [];
  for (let z = -2; z <= 2; z += 1) {
    for (let x = -1; x <= 4; x += 1) samples.push({ x, z, canopyHeightM: 8 + ((x + z + 20) % 3) });
  }
  for (let z = 8; z <= 10; z += 1) for (let x = 8; x <= 10; x += 1) {
    samples.push({ x, z, canopyHeightM: 12 });
  }
  const crown = reconstructTreeCrownFromSamples({ x: 0, z: 0, samples, cellSizeM: 1 });
  assert.ok(crown);
  assert.equal(crown.sampleCount, 30);
  assert.equal(crown.disconnectedSamplesRejected, 9);
  assert.ok(crown.eastM > crown.westM);
  assert.ok(crown.offsetXM > 0);
  assert.equal(crown.crownBaseHeightM, null);
  assert.equal(crown.crownBaseObserved, false);
});

test("uses explicit vegetation-base observations but never invents them from DSM-DTM", () => {
  const observed = reconstructTreeCrownFromSamples({
    x: 0, z: 0, cellSizeM: 1,
    samples: [
      { x: 0, z: 0, surfaceM: 120, groundM: 110, vegetationBaseHeightM: 3 },
      { x: 1, z: 0, surfaceM: 119, groundM: 110, vegetationBaseHeightM: 4 },
      { x: 0, z: 1, surfaceM: 118, groundM: 110, vegetationBaseHeightM: 5 },
      { x: 1, z: 1, surfaceM: 117, groundM: 110, vegetationBaseHeightM: 4 }
    ]
  });
  assert.equal(observed.crownBaseObserved, true);
  assert.ok(observed.crownBaseHeightM >= 3 && observed.crownBaseHeightM <= 4);

  const surfaceOnly = reconstructTreeCrownFromSamples({
    x: 0, z: 0,
    samples: [{ x: 0, z: 0, surfaceM: 120, groundM: 110 }]
  });
  assert.equal(surfaceOnly.crownBaseHeightM, null);
});

test("normalizes directional spreads into an offset measured ellipse", () => {
  const geometry = normalizeTreeReconstruction({
    source: "fixture", westM: 3, eastM: 7, northM: 4, southM: 6, crownBaseHeightM: 5
  }, { crownRadius: 5, crownBase: 7, treeHeight: 18 });
  assert.equal(geometry.radiusX, 5);
  assert.equal(geometry.radiusZ, 5);
  assert.equal(geometry.offsetX, 2);
  assert.equal(geometry.offsetZ, 1);
  assert.equal(geometry.crownBase, 5);
  assert.equal(insideCrownEnvelope(geometry, 7, 1), true);
  assert.equal(insideCrownEnvelope(geometry, -4, 1, 0), false);
  assert.ok(crownReachFromTrunk(geometry, 0) > crownReachFromTrunk(geometry, Math.PI));
});
