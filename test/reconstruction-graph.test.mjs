import test from "node:test";
import assert from "node:assert/strict";
import {
  buildParkReconstructionGraph,
  reconstructionCompilerMap
} from "../src/lib/park-reconstruction-graph.mjs";

test("duplicate upstream feature ids are deterministically disambiguated", () => {
  const duplicateId = "tow:FR_TOW_V1_West_Midlands:128_TSK04:SK0742";
  const feature = (x) => ({
    id: duplicateId,
    kind: "vegetation",
    subtype: "lone-tree-canopy",
    tags: {},
    geometry: { type: "Point", coordinates: [-1.9, 52.98] },
    localGeometry: { type: "Point", coordinates: [x, 0] },
    source: { provider: "Forestry Commission / Forest Research" }
  });
  const map = { features: [feature(0), feature(2)] };
  const graph = buildParkReconstructionGraph({
    parkName: "Fixture Park",
    map,
    options: { planningWorldAuthority: "fixture" }
  });

  assert.deepEqual(graph.nodes.map((node) => node.id), [
    duplicateId,
    `${duplicateId}#duplicate-2`
  ]);
  assert.equal(graph.summary.duplicateSourceIdsDisambiguated, 1);
  assert.equal(reconstructionCompilerMap({ ...map, reconstructionGraph: graph }).features.length, 2);
});
