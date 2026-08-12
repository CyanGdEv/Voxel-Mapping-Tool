import assert from "node:assert/strict";
import test from "node:test";
import { detectTreeSeedsFromCanopySamples } from "../src/lib/tree-seed-detection.mjs";

function twinCanopySamples() {
  const samples = [];
  for (let z = -5; z <= 5; z += 1) {
    for (let x = -4; x <= 10; x += 1) {
      const left = 14 - Math.hypot(x, z) * 1.25;
      const right = 12.5 - Math.hypot(x - 6, z) * 1.15;
      const canopyHeightM = Math.max(left, right, 0);
      if (canopyHeightM >= 2) samples.push({ x, z, canopyHeightM });
    }
  }
  return samples;
}

test("detects separated local maxima inside a touching canopy", () => {
  const seeds = detectTreeSeedsFromCanopySamples({
    samples: twinCanopySamples(),
    cellSizeM: 1,
    minCanopyHeightM: 3,
    minPeakProminenceM: 1,
    minSeedSeparationM: 3.5
  });
  assert.equal(seeds.length, 2);
  assert.ok(Math.hypot(seeds[0].x, seeds[0].z) <= 1);
  assert.ok(Math.hypot(seeds[1].x - 6, seeds[1].z) <= 1.5);
  assert.ok(seeds.every((seed) => seed.source === "dsm-dtm-canopy-local-maximum"));
  assert.ok(seeds.every((seed) => seed.confidence >= 0.55 && seed.confidence <= 0.94));
});

test("suppresses inferred peaks near an existing mapped trunk", () => {
  const seeds = detectTreeSeedsFromCanopySamples({
    samples: twinCanopySamples(),
    mappedSeeds: [{ x: 0, z: 0 }],
    mappedSuppressionRadiusM: 2.5,
    minPeakProminenceM: 1,
    minSeedSeparationM: 3.5
  });
  assert.equal(seeds.length, 1);
  assert.ok(Math.hypot(seeds[0].x - 6, seeds[0].z) <= 1.5);
});

test("does not turn a flat vegetation surface into many individual trees", () => {
  const samples = [];
  for (let z = 0; z < 10; z += 1) for (let x = 0; x < 10; x += 1) {
    samples.push({ x, z, surfaceM: 108, groundM: 100 });
  }
  const seeds = detectTreeSeedsFromCanopySamples({
    samples,
    minPeakProminenceM: 1.25,
    minSeedSeparationM: 3.5
  });
  assert.deepEqual(seeds, []);
});

test("non-maximum DSM clutter is rejected and seed count is bounded", () => {
  const samples = [];
  for (let x = 0; x < 50; x += 1) {
    samples.push({ x, z: 0, canopyHeightM: 5 + (x % 5 === 0 ? 4 : 0) });
  }
  const seeds = detectTreeSeedsFromCanopySamples({
    samples,
    minCanopyHeightM: 4,
    minPeakProminenceM: 2,
    minSeedSeparationM: 4,
    maxSeeds: 3
  });
  assert.equal(seeds.length, 3);
});
