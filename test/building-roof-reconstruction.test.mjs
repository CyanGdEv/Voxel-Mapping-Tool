import test from "node:test";
import assert from "node:assert/strict";
import {
  reconstructBuildingRoofs,
  validateBuildingReconstructions
} from "../src/lib/building-roof-reconstruction.mjs";

function buildingNode({ baseElevationM = null, topElevationM = null } = {}) {
  return {
    id: "auto-plan:smd-2011-1051:fixture:p1:116",
    type: "building",
    geometry: {
      local: {
        type: "Polygon",
        coordinates: [[[0, 0], [6, 0], [6, 6], [0, 6], [0, 0]]]
      }
    },
    vertical: { baseElevationM, topElevationM },
    authority: { geometry: "planning-data", osmDerived: false }
  };
}

function graphWith(node) {
  return { nodes: [node], summary: {} };
}

test("missing planning top stays missing and falls through to DSM roof evidence", () => {
  const node = buildingNode({ baseElevationM: 145, topElevationM: null });
  const graph = graphWith(node);
  const diagnostics = reconstructBuildingRoofs(graph, {
    elevation: {
      dtmSourceKind: "test-dtm",
      dsmSourceKind: "test-dsm",
      sampleDtmLocal: () => 145,
      sampleDsmLocal: () => 151.25
    }
  });

  validateBuildingReconstructions(graph);
  assert.equal(node.buildingReconstruction.status, "resolved");
  assert.equal(node.buildingReconstruction.baseElevationM, 145);
  assert.equal(node.buildingReconstruction.topElevationM, 151.25);
  assert.equal(node.buildingReconstruction.authority.top, "test-dsm");
  assert.equal(node.buildingReconstruction.rejectedVerticalEvidence, null);
  assert.ok(diagnostics.dsmSamples > 0);
});

test("missing LiDAR samples never become synthetic zero-metre elevations", () => {
  const node = buildingNode();
  const graph = graphWith(node);
  reconstructBuildingRoofs(graph, {
    elevation: {
      sampleDtmLocal: () => null,
      sampleDsmLocal: () => null
    }
  });

  validateBuildingReconstructions(graph);
  assert.equal(node.buildingReconstruction.status, "unresolved");
  assert.equal(node.buildingReconstruction.baseElevationM, null);
  assert.equal(node.buildingReconstruction.topElevationM, null);
  assert.equal(node.buildingReconstruction.dtmSampleCount, 0);
  assert.equal(node.buildingReconstruction.dsmSampleCount, 0);
});

test("planning top below the resolved base is rejected in favour of valid DSM evidence", () => {
  const node = buildingNode({ baseElevationM: 145, topElevationM: 120 });
  const graph = graphWith(node);
  const diagnostics = reconstructBuildingRoofs(graph, {
    elevation: {
      dsmSourceKind: "test-dsm",
      sampleDsmLocal: () => 152
    }
  });

  validateBuildingReconstructions(graph);
  assert.equal(node.buildingReconstruction.status, "resolved");
  assert.equal(node.buildingReconstruction.topElevationM, 152);
  assert.equal(node.buildingReconstruction.authority.top, "test-dsm");
  assert.deepEqual(node.buildingReconstruction.rejectedVerticalEvidence, {
    property: "topElevationM",
    valueM: 120,
    reason: "planning-top-below-resolved-base"
  });
  assert.equal(diagnostics.rejectedPlanningTops, 1);
});
