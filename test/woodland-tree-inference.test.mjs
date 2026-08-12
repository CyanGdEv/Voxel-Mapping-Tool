import assert from "node:assert/strict";
import test from "node:test";
import { inferIndividualTreesInVegetation, resolveSpeciesEvidence } from "../src/lib/woodland-tree-inference.mjs";

function woodland(tags = { natural: "wood" }) {
  return {
    id: "wood:1", kind: "vegetation", subtype: "woodland", tags,
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

test("direct species-map evidence has highest authority", () => {
  const evidence = resolveSpeciesEvidence({
    x: 5, z: 5, parent: woodland({ natural: "wood", genus: "Fagus" }), mappedTrees: [],
    speciesSources: [{
      properties: { species: "Quercus robur", genus: "Quercus" },
      localGeometry: { type: "Polygon", coordinates: [[[4,4],[6,4],[6,6],[4,6],[4,4]]] }
    }]
  });
  assert.equal(evidence.species, "Quercus robur");
  assert.equal(evidence.genus, "Quercus");
  assert.equal(evidence.source, "tree-species-map");
  assert.ok(evidence.confidence >= 0.9);
});

test("parent woodland composition transfers before nearby-tree evidence", () => {
  const parent = woodland({ natural: "wood", species: "Fagus sylvatica", genus: "Fagus", leaf_type: "broadleaved" });
  const mappedTrees = [{
    kind: "vegetation", subtype: "tree", tags: { species: "Betula pendula", genus: "Betula" },
    localGeometry: { type: "Point", coordinates: [5.5,5] }
  }];
  const evidence = resolveSpeciesEvidence({ x: 5, z: 5, parent, speciesSources: [], mappedTrees });
  assert.equal(evidence.species, "Fagus sylvatica");
  assert.equal(evidence.source, "parent-vegetation-composition");
});

test("nearby classified mapped tree transfers species when parent is unclassified", () => {
  const mappedTrees = [{
    kind: "vegetation", subtype: "tree", tags: { species: "Betula pendula", genus: "Betula" },
    localGeometry: { type: "Point", coordinates: [6,5] }
  }];
  const evidence = resolveSpeciesEvidence({ x: 5, z: 5, parent: woodland(), speciesSources: [], mappedTrees, nearbyRadiusM: 10 });
  assert.equal(evidence.species, "Betula pendula");
  assert.equal(evidence.genus, "Betula");
  assert.equal(evidence.source, "nearby-classified-tree");
});

test("woodland-class fallback preserves uncertainty instead of inventing a species", () => {
  const evidence = resolveSpeciesEvidence({
    x: 5, z: 5, parent: woodland({ natural: "wood", woodland_type: "conifer woodland" }), speciesSources: [], mappedTrees: []
  });
  assert.equal(evidence.species, null);
  assert.equal(evidence.genus, null);
  assert.equal(evidence.leafType, "needleleaved");
  assert.equal(evidence.source, "parent-vegetation-composition");
  assert.ok(evidence.confidence < 0.9);
});

test("inferred trees receive species tags and provenance from species evidence", () => {
  const map = { features: [woodland()] };
  const treeSpeciesMap = [{
    properties: { species: "Quercus robur", genus: "Quercus" },
    localGeometry: { type: "Polygon", coordinates: [[[0,0],[14,0],[14,10],[0,10],[0,0]]] }
  }];
  const result = inferIndividualTreesInVegetation(map, { elevation: elevation([[5,5,13]]), treeSpeciesMap }, {
    treeInferenceMinPeakProminenceM: 0.8
  });
  assert.equal(result.added, 1);
  assert.equal(result.speciesAssigned, 1);
  const tree = map.features.find((feature) => feature.inferredTree);
  assert.equal(tree.tags.species, "Quercus robur");
  assert.equal(tree.tags.genus, "Quercus");
  assert.equal(tree.tags["tpmap:species_source"], "tree-species-map");
  assert.equal(tree.inferredTree.speciesEvidence.source, "tree-species-map");
});
