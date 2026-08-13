import test from "node:test";
import assert from "node:assert/strict";
import {
  buildParkReconstructionGraph,
  reconstructionCompilerMap
} from "../src/lib/park-reconstruction-graph.mjs";
import {
  reconstructRideAttachments,
  validateRideAttachmentReconstructions
} from "../src/lib/ride-attachment-reconstruction.mjs";

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

test("relationship ids remain unique when long source ids share the same readable prefix", () => {
  const commonWaterId = `auto-plan:smd-2022-0556:${"updated-drainage-maintenance-schedule-".repeat(4)}`;
  const polygon = (minX, minZ, maxX, maxZ) => ({
    type: "Polygon",
    coordinates: [[[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ], [minX, minZ]]]
  });
  const feature = (id, kind, localGeometry) => ({
    id,
    kind,
    subtype: kind,
    tags: {},
    geometry: localGeometry,
    localGeometry,
    source: { provider: "Planning authority" }
  });
  const map = {
    features: [
      feature("bridge-fixture", "bridge", polygon(0, 0, 10, 4)),
      feature(`${commonWaterId}north`, "water", polygon(1, 1, 4, 3)),
      feature(`${commonWaterId}south`, "water", polygon(6, 1, 9, 3))
    ]
  };

  const graph = buildParkReconstructionGraph({
    parkName: "Fixture Park", map, options: { planningWorldAuthority: "fixture" }
  });
  const crossings = graph.relationships.filter((relation) => relation.type === "bridge-crosses-water");
  assert.equal(crossings.length, 2);
  assert.equal(new Set(crossings.map((relation) => relation.id)).size, 2);
  assert.ok(crossings.every((relation) => /:[a-f0-9]{20}$/.test(relation.id)));
});

test("ride attachments retain detected geometry and resolve only against nearby 3D ride evidence", () => {
  const source = { provider: "Planning authority", sourceUrl: "https://example.test/plan", sha256: "plan-hash" };
  const vertical = { heightM: null, elevationM: null, groundElevationM: 0 };
  const ride = {
    id: "planning:ride", name: "Evidence Ride", kind: "ride_track", subtype: "coaster",
    tags: { planning_authoritative: true, planning_reference: "REF-1" }, source, vertical,
    geometry: { type: "LineString", coordinates: [[0, 0], [0.0001, 0]] },
    localGeometry: { type: "LineString", coordinates: [[0, 0], [10, 0]] }
  };
  const catwalk = {
    id: "planning:catwalk", kind: "ride_attachment", subtype: "ride-catwalk",
    tags: {
      planning_authoritative: true,
      planning_reference: "REF-1",
      ride_attachment: "catwalk",
      ride_attachment_vertical_mode: "track-relative"
    },
    source, vertical,
    geometry: { type: "LineString", coordinates: [[0, 0.00001], [0.0001, 0.00001]] },
    localGeometry: { type: "LineString", coordinates: [[0, 1], [10, 1]] }
  };
  const pointOnly = {
    ...catwalk,
    id: "planning:catwalk-note",
    geometry: { type: "Point", coordinates: [0, 0] },
    localGeometry: { type: "Point", coordinates: [5, 1] }
  };
  const map = { features: [ride, catwalk, pointOnly] };
  const graph = buildParkReconstructionGraph({
    parkName: "Fixture Park", map, options: { planningWorldAuthority: "planning-only" }
  });
  const rideNode = graph.nodes.find((node) => node.id === ride.id);
  Object.defineProperty(rideNode, "geometry3d", {
    enumerable: false,
    configurable: true,
    value: {
      status: "resolved",
      samples: [
        { x: 0, y: 8, z: 0, resolved: true },
        { x: 5, y: 10, z: 0, resolved: true },
        { x: 10, y: 8, z: 0, resolved: true }
      ]
    }
  });

  const diagnostics = reconstructRideAttachments(graph);
  validateRideAttachmentReconstructions(graph);
  const reconstruction = graph.nodes.find((node) => node.id === catwalk.id).rideAttachmentReconstruction;
  assert.equal(reconstruction.status, "resolved");
  assert.equal(reconstruction.rideId, ride.id);
  assert.equal(reconstruction.verticalMode, "track-relative");
  assert.equal(reconstruction.rideSamples.length, 3);
  assert.equal(reconstruction.geometrySource, "detected-planning-geometry");
  assert.match(reconstruction.policy, /no-offset-mirroring-banking-cross-ties/);
  assert.equal(graph.nodes.find((node) => node.id === pointOnly.id).rideAttachmentReconstruction.status, "withheld");
  assert.equal(diagnostics.attachmentsResolved, 1);
  assert.equal(diagnostics.attachmentsWithheld, 1);
  assert.ok(graph.relationships.some((relation) => relation.type === "attachment-follows-ride"));
});
