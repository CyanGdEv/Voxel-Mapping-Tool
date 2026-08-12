import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { extractNativeDwgPlanning, looksLikeDwg } from "../src/lib/planning-native-dwg.mjs";
import { extractNativeDxfPlanning, looksLikeAsciiDxf } from "../src/lib/planning-native-vector.mjs";
import { extractNativePlanningArchive } from "../src/lib/planning-native-archive.mjs";

const application = {
  reference: "SMD/2026/0100",
  geometry: { type: "Point", coordinates: [-1.9, 52.99] }
};
const document = { id: "native-dwg", title: "Proposed building CAD", role: "site-layout" };
const profile = { bbox: { west: -1.92, south: 52.97, east: -1.88, north: 53.01 } };
const dwg = Buffer.from("AC1027\u0000VOXEL-MAPPING-DWG-FIXTURE");

function dxfFixture() {
  return Buffer.from(`0
SECTION
2
HEADER
9
$INSUNITS
70
6
0
ENDSEC
0
SECTION
2
ENTITIES
0
LWPOLYLINE
8
PROPOSED BUILDING
70
1
10
0
20
0
10
20
20
0
10
20
20
10
10
0
20
10
0
ENDSEC
0
EOF
`);
}

const mockConverter = () => dxfFixture();

test("native DWG conversion reuses exact DXF geometry while retaining DWG provenance", () => {
  assert.equal(looksLikeDwg(dwg), true);
  const result = extractNativeDwgPlanning({
    bytes: dwg,
    application,
    document,
    profile,
    minimumConfidence: 0.72,
    convertDwg: mockConverter,
    converterVersion: "0.14-test"
  });
  assert.equal(result.status, "native-dwg-geometry-ready");
  assert.equal(result.nativeFormat, "dwg");
  assert.equal(result.collection.features.length, 1);
  const feature = result.collection.features[0];
  assert.equal(feature.properties.kind, "building");
  assert.equal(feature.properties.source, "official-planning-native-dwg");
  assert.equal(feature.properties.planning_native_source_format, "dwg");
  assert.equal(feature.properties.planning_native_conversion, "gnu-libredwg-dwg2dxf");
  assert.equal(feature.properties.planning_native_converter_version, "0.14-test");
  assert.match(feature.properties.planning_georeference_method, /^native-dwg-converted-dxf/);
  assert.match(feature.properties.planning_native_source_sha256, /^[a-f0-9]{64}$/);
  assert.match(feature.properties.planning_native_intermediate_sha256, /^[a-f0-9]{64}$/);
});

test("native-vector compatibility route recognizes and dispatches DWG", () => {
  assert.equal(looksLikeAsciiDxf(dwg), true);
  const result = extractNativeDxfPlanning({
    bytes: dwg,
    application,
    document,
    profile,
    convertDwg: mockConverter,
    converterVersion: "0.14-test"
  });
  assert.equal(result.nativeFormat, "dwg");
  assert.equal(result.collection.features.length, 1);
});

test("missing DWG converter fails closed without fabricating geometry", () => {
  const result = extractNativeDwgPlanning({
    bytes: dwg,
    application,
    document,
    profile,
    converterPath: "/definitely/missing/tpmap-dwg2dxf"
  });
  assert.equal(result.status, "native-dwg-converter-unavailable");
  assert.equal(result.collection.features.length, 0);
  assert.match(result.conversion.sourceSha256, /^[a-f0-9]{64}$/);
});

test("invalid converter output stays evidence-only", () => {
  const result = extractNativeDwgPlanning({
    bytes: dwg,
    application,
    document,
    profile,
    convertDwg: () => Buffer.from("not a dxf")
  });
  assert.equal(result.status, "native-dwg-conversion-invalid-dxf");
  assert.equal(result.collection.features.length, 0);
});

test("planning ZIP bundles can decode embedded DWG through the same provenance boundary", () => {
  const archive = Buffer.from(zipSync({ "cad/site-layout.dwg": new Uint8Array(dwg) }));
  const result = extractNativePlanningArchive({
    bytes: archive,
    application,
    document: { id: "dwg-bundle", title: "Native CAD bundle", role: "site-layout" },
    profile,
    nativeDecoderOptions: { convertDwg: mockConverter, converterVersion: "0.14-test" }
  });
  assert.equal(result.status, "native-archive-geometry-ready");
  assert.equal(result.collection.features.length, 1);
  assert.equal(result.archive.members[0].extension, ".dwg");
  assert.equal(result.archive.members[0].status, "geometry-ready");
  const feature = result.collection.features[0];
  assert.equal(feature.properties.planning_archive_member, "cad/site-layout.dwg");
  assert.equal(feature.properties.planning_native_source_format, "dwg");
});
