import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPlanningGeometryView,
  isPlanningGeometryAnchor,
  isPlanningPointAnchor,
  planningShapeGeometryAllowed,
  planningTextBoxes,
  rasterShapeLooksLikeText
} from "../src/lib/planning-geometry-integrity.mjs";
import { autoGeoreferencePlanningPage } from "../src/lib/planning-auto-georeference.mjs";
import { classifyComprehensivePlanningLabel } from "../src/lib/planning-comprehensive-semantics.mjs";
import { applyPlanningWorldAuthority } from "../src/lib/planning-world-authority.mjs";

const parsed = { width: 1000, height: 700 };

function anchor(text, cx, cy, semantic = classifyComprehensivePlanningLabel(text)) {
  return { text, cx, cy, ocrConfidence: 0.99, semantic };
}

test("non-plan planning documents remain evidence-only", () => {
  assert.equal(classifyPlanningGeometryView({
    document: { title: "Drainage Maintenance Schedule P02", role: "water-and-drainage" }
  }).eligible, false);
  assert.equal(classifyPlanningGeometryView({
    document: { title: "Building Sections As Proposed", role: "elevations-and-sections" }
  }).eligible, false);
  assert.equal(classifyPlanningGeometryView({
    document: { title: "North and West Elevations", role: "elevations-and-sections" }
  }).eligible, false);
});

test("real plan views remain geometry eligible", () => {
  assert.equal(classifyPlanningGeometryView({
    document: { title: "373-104-3 Site Plan As Existing", role: "site-layout" }
  }).eligible, true);
  assert.equal(classifyPlanningGeometryView({
    document: { title: "Updated Drainage Strategy Plan P03", role: "water-and-drainage" }
  }).eligible, true);
  assert.equal(classifyPlanningGeometryView({
    document: { title: "Drawing 104", role: "planning-document" },
    rawLines: [{ text: "PROPOSED SITE PLAN" }]
  }).eligible, true);
});

test("native text boxes suppress raster letter contours without suppressing nearby plan geometry", () => {
  const boxes = planningTextBoxes([{
    text: "TOILET", xMin: 100, yMin: 100, xMax: 180, yMax: 120, ocrConfidence: 0.99
  }]);
  const glyph = { closed: true, points: [
    { x: 108, y: 102 }, { x: 118, y: 102 }, { x: 118, y: 117 }, { x: 108, y: 117 }
  ] };
  const building = { closed: true, points: [
    { x: 60, y: 60 }, { x: 240, y: 60 }, { x: 240, y: 200 }, { x: 60, y: 200 }
  ] };
  assert.equal(rasterShapeLooksLikeText(glyph, boxes), true);
  assert.equal(rasterShapeLooksLikeText(building, boxes), false);
});

test("title-block addresses and metadata cannot become semantic geometry", () => {
  assert.equal(isPlanningGeometryAnchor(
    anchor("POND HOUSE, NORTHEND, HENLEY-ON-THAMES, OXON RG9 6LG", 900, 650), parsed
  ), false);
  assert.equal(isPlanningPointAnchor(
    anchor("Drawing No 373-104-3", 900, 650), parsed
  ), false);
  assert.equal(isPlanningGeometryAnchor(
    anchor("Proposed pond", 400, 300), parsed
  ), true);
});

test("implausibly huge building contours are rejected while normal footprints survive", () => {
  const buildingSemantic = classifyComprehensivePlanningLabel("Proposed building");
  const huge = { closed: true, points: [
    { x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }
  ] };
  const normal = { closed: true, points: [
    { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 180 }, { x: 0, y: 180 }
  ] };
  assert.equal(planningShapeGeometryAllowed(huge, buildingSemantic, 0.1), false);
  assert.equal(planningShapeGeometryAllowed(normal, buildingSemantic, 0.1), true);
});

test("auto georeference emits no world geometry from a section sheet", () => {
  const semantic = classifyComprehensivePlanningLabel("Proposed building");
  const result = autoGeoreferencePlanningPage({
    svg: '<svg viewBox="0 0 1000 700"><polygon points="100,100 300,100 300,300 100,300"/></svg>',
    semantic: {
      rawLines: [{ text: "Scale 1:200", xMin: 800, yMin: 650, xMax: 900, yMax: 670, ocrConfidence: 0.99 }],
      anchors: [{ text: "Proposed building", cx: 200, cy: 200, ocrConfidence: 0.99, semantic }]
    },
    application: { reference: "TEST/1", lat: 52.99, lon: -1.89, status: "approved" },
    document: { id: "sections", title: "Building Sections As Proposed", role: "elevations-and-sections" },
    profile: { name: "Fixture Park" }
  });
  assert.equal(result.status, "drawing-view-evidence-only");
  assert.equal(result.collection.features.length, 0);
});

test("auto georeference removes a text glyph but keeps a plan footprint", () => {
  const semantic = classifyComprehensivePlanningLabel("Proposed building");
  const result = autoGeoreferencePlanningPage({
    svg: '<svg viewBox="0 0 1000 700"><polygon points="50,50 950,50 950,650 50,650" stroke="#e00000"/><polygon points="105,102 115,102 115,117 105,117"/><polygon points="200,200 400,200 400,350 200,350"/></svg>',
    semantic: {
      rawLines: [
        { text: "PROPOSED SITE PLAN", xMin: 400, yMin: 30, xMax: 620, yMax: 55, ocrConfidence: 0.99 },
        { text: "Proposed building", xMin: 100, yMin: 100, xMax: 190, yMax: 120, ocrConfidence: 0.99 },
        { text: "Scale 1:200", xMin: 800, yMin: 650, xMax: 900, yMax: 670, ocrConfidence: 0.99 }
      ],
      anchors: [{ text: "Proposed building", cx: 300, cy: 275, ocrConfidence: 0.99, semantic }],
      northDegrees: 0
    },
    application: { reference: "TEST/2", lat: 52.99, lon: -1.89, status: "approved" },
    document: { id: "site-plan", title: "Proposed Site Plan", role: "site-layout", dpi: 300 },
    profile: { name: "Fixture Park" },
    minimumConfidence: 0.5
  });
  assert.equal(result.geometryView.eligible, true);
  assert.equal(result.textShapesRejected, 1);
  assert.equal(result.collection.features.length, 1);
  assert.equal(result.collection.features[0].properties.kind, "building");
});

test("raster plans without explicit north evidence remain pending until OSM registration", () => {
  const semantic = classifyComprehensivePlanningLabel("Proposed building");
  const result = autoGeoreferencePlanningPage({
    svg: '<svg viewBox="0 0 1000 700"><polygon points="50,50 950,50 950,650 50,650" stroke="#e00000"/><polygon points="200,200 400,200 400,350 200,350"/></svg>',
    semantic: {
      rawLines: [{ text: "Scale 1:200" }],
      anchors: [{ text: "Proposed building", cx: 300, cy: 275, ocrConfidence: 0.99, semantic }]
    },
    application: { reference: "TEST/NO-NORTH", lat: 52.99, lon: -1.89, status: "approved" },
    document: { id: "site-plan", title: "Proposed Site Plan", role: "site-layout", dpi: 300 },
    profile: { name: "Fixture Park" }
  });
  assert.equal(result.status, "drawing-registration-pending");
  assert.equal(result.collection.features.length, 1);
  assert.equal(result.collection.features[0].properties.planning_registration_pending, true);
  assert.equal(result.collection.features[0].properties.planning_spatial_registration_verified, false);
});

test("one OCR label cannot turn a page of nearby CAD strokes into physical objects", () => {
  const semantic = classifyComprehensivePlanningLabel("Existing wall");
  const strokes = Array.from({ length: 65 }, (_, index) =>
    `<line x1="${490 + index % 5}" y1="490" x2="${505 + index % 5}" y2="505"/>`
  ).join("");
  const result = autoGeoreferencePlanningPage({
    svg: `<svg viewBox="0 0 1000 700"><polygon points="50,50 950,50 950,650 50,650" stroke="#e00000"/>${strokes}</svg>`,
    semantic: {
      rawLines: [{ text: "Scale 1:200" }],
      anchors: [{ text: "Existing wall", cx: 500, cy: 500, ocrConfidence: 0.99, semantic }],
      northDegrees: 0
    },
    application: { reference: "TEST/FANOUT", lat: 52.99, lon: -1.89, status: "approved" },
    document: { id: "site-plan", title: "Existing Site Plan", role: "site-layout", dpi: 300 },
    profile: { name: "Fixture Park", worldCoverage: { maximumSemanticAnchorFanout: 64 } },
    minimumConfidence: 0.5
  });
  assert.ok(result.ambiguousAssociationsRejected >= 65);
  assert.equal(result.collection.features.length, 0);
});

test("planning-only authority quarantines title-block and impossible auto geometry before boundary derivation", () => {
  const planningFeature = (id, kind, name, localGeometry) => ({
    id, kind, name, localGeometry,
    geometry: localGeometry,
    tags: {
      planning_authoritative: true,
      planning_auto_extracted: true,
      planning_spatial_registration_verified: true,
      planning_semantic_label: name
    },
    source: { provider: "Fixture Planning Council", dataset: "planning-drawing-vector" },
    vertical: {},
    verification: {}
  });
  const features = [
    planningFeature("good", "building", "Proposed station building", {
      type: "Polygon", coordinates: [[[0, 0], [40, 0], [40, 25], [0, 25], [0, 0]]]
    }),
    planningFeature("address", "water", "POND HOUSE, NORTHEND, HENLEY-ON-THAMES, OXON RG9 6LG", {
      type: "Polygon", coordinates: [[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]]
    }),
    planningFeature("huge", "building", "toilet", {
      type: "Polygon", coordinates: [[[0, 0], [360, 0], [360, 260], [0, 260], [0, 0]]]
    }),
    {
      id: "independent-tree", kind: "vegetation", name: "Measured tree",
      geometry: { type: "Point", coordinates: [5, 5] },
      localGeometry: { type: "Point", coordinates: [5, 5] },
      tags: {}, source: { provider: "Independent tree survey" }, vertical: {}, verification: {}
    }
  ];
  const evidence = applyPlanningWorldAuthority(features, { planningWorldAuthority: "planning-only" });
  assert.deepEqual(features.map((feature) => feature.id).sort(), ["good", "independent-tree"]);
  assert.equal(evidence.planningSpatialOutliersRemoved, 2);
  assert.equal(evidence.planningSpatialOutlierReasons["title-block-postcode-label"], 1);
  assert.equal(evidence.planningSpatialOutlierReasons["implausible-building-span"], 1);
});
