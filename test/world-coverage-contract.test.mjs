import test from "node:test";
import assert from "node:assert/strict";
import {
  coverageChunkCount,
  coverageLocalBounds,
  loadParkProfile
} from "../src/lib/park-profile.mjs";
import { resolveWorldChunkBounds } from "../src/lib/mcworld.mjs";
import { assessPlanningSpatialContract } from "../src/lib/planning-spatial-contract.mjs";
import { compileMap } from "../src/lib/raster.mjs";

test("Alton profile independently requires the validated 9,504-chunk roster", async () => {
  const profile = await loadParkProfile("alton-towers-resort");
  const coverage = profile.worldCoverage;
  const local = coverageLocalBounds(coverage);
  const compilation = {
    meta: { bounds: { ...local } },
    chunks: [
      { x: coverage.chunkBounds.minChunkX, z: coverage.chunkBounds.minChunkZ },
      { x: coverage.chunkBounds.maxChunkX, z: coverage.chunkBounds.maxChunkZ }
    ]
  };

  assert.equal(coverageChunkCount(coverage), 9_504);
  assert.deepEqual(resolveWorldChunkBounds(compilation, 32, coverage), coverage.chunkBounds);
  assert.throws(() => resolveWorldChunkBounds({
    meta: { bounds: { minX: -318, minZ: -388, maxX: -56, maxZ: -148 } },
    chunks: [{ x: -20, z: -25 }]
  }, 32, coverage), /does not match the 9,504-chunk park contract/);
});

test("Alton spatial contract rejects a planning corpus collapsed into one corner", async () => {
  const profile = await loadParkProfile("alton-towers-resort");
  const features = requiredPlanningFeatures({ minX: -318, minZ: -388, maxX: -56, maxZ: -148 });
  const assessment = assessPlanningSpatialContract(features, { parkProfile: profile });

  assert.equal(assessment.status, "failed");
  assert.ok(assessment.failures.some((failure) => failure.startsWith("planning X span")));
  assert.ok(assessment.failures.some((failure) => failure.startsWith("planning Z span")));
});

test("Alton spatial contract accepts a registered corpus spanning the configured park", async () => {
  const profile = await loadParkProfile("alton-towers-resort");
  const local = coverageLocalBounds(profile.worldCoverage);
  const features = requiredPlanningFeatures({
    minX: local.minX + 4,
    minZ: local.minZ + 4,
    maxX: local.maxX - 4,
    maxZ: local.maxZ - 4
  });
  const assessment = assessPlanningSpatialContract(features, { parkProfile: profile });

  assert.equal(assessment.status, "passed");
  assert.deepEqual(assessment.failures, []);
});

test("terrain/base elevation alone keeps a 2D ride line on the visible ground-plan path", () => {
  const compilation = compileMap({
    parkName: "Ride elevation fixture",
    map: {
      boundary: {
        localGeometry: { type: "Polygon", coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] }
      },
      features: [{
        id: "planning:ride",
        kind: "ride_track",
        name: "Verified centreline",
        localGeometry: { type: "LineString", coordinates: [[2, 10], [18, 10]] },
        tags: { planning_authoritative: true, roller_coaster: "track" },
        vertical: { baseElevationM: 145, groundElevationM: 145, elevationM: null, explicit: false },
        verification: { plan: "planning-source-of-truth", vertical: "terrain-only" }
      }],
      topology: {}, semantics: {}, rideProfiles: null
    },
    sources: { center: { lat: 52.99, lon: -1.89 }, elevation: { provider: "none", points: [] } },
    accuracy: { score: 0.5, grade: "fixture", exact3d: false },
    options: { accuracyMode: "verified", buildings: "markers", noRideInfoSigns: true }
  });

  assert.ok(compilation.meta.verticalStats.groundPlanRideTracks > 0);
  assert.equal(compilation.meta.verticalStats.verticallyTaggedRideTracks, 0);
});

function requiredPlanningFeatures(bounds) {
  const features = [];
  const add = (kind, index, x, z) => features.push({
    id: `planning:${kind}:${index}`,
    kind,
    name: `${kind} ${index}`,
    localGeometry: kind === "ride_track" || kind === "path"
      ? { type: "LineString", coordinates: [[x, z], [x + 2, z + 2]] }
      : { type: "Polygon", coordinates: [[[x, z], [x + 2, z], [x + 2, z + 2], [x, z + 2], [x, z]]] },
    geometry: { type: "Point", coordinates: [-1.89, 52.99] },
    tags: { planning_authoritative: true },
    source: { provider: "Planning authority" },
    vertical: {}, verification: {}
  });
  for (let index = 0; index < 25; index += 1) {
    const t = index / 24;
    add("building", index, bounds.minX + (bounds.maxX - bounds.minX) * t, bounds.minZ + (bounds.maxZ - bounds.minZ) * t);
    add("path", index, bounds.minX + (bounds.maxX - bounds.minX) * t, bounds.maxZ - (bounds.maxZ - bounds.minZ) * t);
  }
  for (let index = 0; index < 5; index += 1) {
    const t = index / 4;
    add("ride_track", index, bounds.minX + (bounds.maxX - bounds.minX) * t, bounds.minZ + (bounds.maxZ - bounds.minZ) * t);
  }
  return features;
}
