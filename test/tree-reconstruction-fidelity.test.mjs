import assert from "node:assert/strict";
import test from "node:test";
import { enrichUniversalFidelity } from "../src/lib/fidelity.mjs";

function asymmetricElevation() {
  return {
    resolutionM: 1,
    samplePairLocal(x, z) {
      const inPrimaryCrown = x >= -2 && x <= 5 && z >= -3 && z <= 2;
      const inNeighbour = x >= 9 && x <= 11 && z >= -1 && z <= 1;
      return { terrain: 100, surface: inPrimaryCrown ? 112 : inNeighbour ? 114 : 100 };
    }
  };
}

function treeFeature(tags = {}) {
  return {
    id: "tree:fixture",
    kind: "vegetation",
    subtype: "tree",
    tags,
    localGeometry: { type: "Point", coordinates: [0, 0] },
    source: { provider: "fixture" }
  };
}

test("universal fidelity automatically reconstructs a mapped tree crown from DSM-DTM", () => {
  const feature = treeFeature();
  const map = { features: [feature] };
  const sources = { elevation: asymmetricElevation() };
  enrichUniversalFidelity(map, sources, { accuracyMode: "verified" });

  const tree = feature.fidelity.tree;
  assert.equal(tree.heightSource, "dsm-minus-dtm-at-mapped-tree");
  assert.equal(tree.heightM, 12);
  assert.equal(tree.crownSource, "dsm-dtm-connected-canopy");
  assert.ok(tree.reconstruction);
  assert.equal(tree.reconstruction.source, "dsm-dtm-connected-canopy");
  assert.ok(tree.reconstruction.eastM > tree.reconstruction.westM);
  assert.ok(tree.reconstruction.offsetXM > 0);
  assert.ok(tree.crownShapeSampleCount > 0);
  assert.equal(tree.crownBaseHeightM, null, "DSM-DTM surface evidence must not invent crown-base height");
});

test("mapped crown diameter remains horizontal authority over a wider DSM segmentation", () => {
  const feature = treeFeature({ crown_diameter_m: "6" });
  const map = { features: [feature] };
  enrichUniversalFidelity(map, { elevation: asymmetricElevation() }, { accuracyMode: "verified" });

  const tree = feature.fidelity.tree;
  assert.equal(tree.crownSource, "tagged-crown-diameter");
  assert.equal(tree.crownDiameterM, 6);
  assert.equal(tree.reconstruction.horizontalEnvelopeClampedToMappedCrown, true);
  const reconstructedDiameter = Math.max(
    tree.reconstruction.westM + tree.reconstruction.eastM,
    tree.reconstruction.northM + tree.reconstruction.southM
  );
  assert.ok(reconstructedDiameter <= 6.001);
  assert.ok(tree.reconstruction.offsetXM > 0, "LiDAR asymmetry should survive envelope clamping");
});
