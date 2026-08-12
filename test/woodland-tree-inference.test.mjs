import assert from "node:assert/strict";
import test from "node:test";
import { inferIndividualTreesInVegetation } from "../src/lib/woodland-tree-inference.mjs";

function woodland() {
  return {
    id: "wood:1", kind: "vegetation", subtype: "woodland", tags: { natural: "wood" },
    localGeometry: { type: "Polygon", coordinates: [[[0,0],[14,0],[14,10],[0,10],[0,0]]] },
    source: { provider: "planning" }
  };
}
function elevation(peaks) {
  return {
    provider: "ea-lidar", resolutionM: 1,
    samplePairLocal(x, z) {
      const canopy = Math.max(0, ...peaks.map(([px,pz,h]) => h - Math.hypot(x-px, z-pz) * 2.1));
      return { terrain: 100, surface: 100 + canopy };
    }
  };
}

test("woodland inference creates individual LiDAR tree features only inside vegetation geometry", () => {
  const map = { features: [woodland()] };
  const result = inferIndividualTreesInVegetation(map, { elevation: elevation([[3,5,13],[10,5,12]]) }, {
    treeInferenceMinPeakProminenceM: 0.8,
    treeInferenceMinSeedSeparationM: 3
  });
  assert.equal(result.added, 2);
  const trees = map.features.filter((feature) => feature.subtype === "tree");
  assert.equal(trees.length, 2);
  assert.ok(trees.every((tree) => tree.source.provider === "ea-lidar"));
  assert.ok(trees.every((tree) => tree.source.authority === "vegetation-evidence"));
  assert.ok(trees.every((tree) => tree.localGeometry.coordinates[0] >= 0 && tree.localGeometry.coordinates[0] <= 14));
});

test("mapped trees suppress nearby inferred duplicates", () => {
  const mapped = {
    id: "tree:mapped", kind: "vegetation", subtype: "tree", tags: { natural: "tree" },
    localGeometry: { type: "Point", coordinates: [3,5] }, source: { provider: "planning" }
  };
  const map = { features: [woodland(), mapped] };
  const result = inferIndividualTreesInVegetation(map, { elevation: elevation([[3,5,13],[10,5,12]]) }, {
    treeInferenceMinPeakProminenceM: 0.8,
    treeInferenceMinSeedSeparationM: 3,
    treeInferenceMappedSuppressionRadiusM: 2.5
  });
  assert.equal(result.added, 1);
  const inferred = map.features.find((feature) => feature.inferredTree);
  assert.ok(Math.hypot(inferred.localGeometry.coordinates[0] - 3, inferred.localGeometry.coordinates[1] - 5) > 2.5);
});

test("inference is bounded per source feature and globally", () => {
  const map = { features: [woodland()] };
  const peaks = [];
  for (let x = 2; x <= 12; x += 2) for (let z = 2; z <= 8; z += 2) peaks.push([x,z,10 + ((x+z)%3)]);
  const result = inferIndividualTreesInVegetation(map, { elevation: elevation(peaks) }, {
    treeInferenceMinPeakProminenceM: 0,
    treeInferenceMinSeedSeparationM: 1,
    treeInferenceMaxSeedsPerFeature: 3,
    treeInferenceMaxSeedsTotal: 3
  });
  assert.ok(result.added <= 3);
});

test("non-polygon vegetation and missing elevation never create inferred trees", () => {
  const map = { features: [{ id:"hedge:1", kind:"vegetation", subtype:"hedge", localGeometry:{ type:"LineString", coordinates:[[0,0],[10,0]] }, tags:{} }] };
  assert.equal(inferIndividualTreesInVegetation(map, { elevation: elevation([[5,0,10]]) }).added, 0);
  assert.equal(inferIndividualTreesInVegetation({ features:[woodland()] }, {}, {}).added, 0);
});
