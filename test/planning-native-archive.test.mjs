import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { extractNativePlanningArchive } from "../src/lib/planning-native-archive.mjs";

const profile = {
  bbox: { west: -1.91, south: 52.97, east: -1.88, north: 53.00 }
};

function fixtureIfc() {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('station.ifc','2026-08-12T00:00:00',(),(),$,$,$);
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCAXIS2PLACEMENT3D(#2,$,$);
#4=IFCLOCALPLACEMENT($,#3);
#5=IFCRECTANGLEPROFILEDEF(.AREA.,'Station footprint',$,20.,10.);
#6=IFCDIRECTION((0.,0.,1.));
#7=IFCEXTRUDEDAREASOLID(#5,#3,#6,6.);
#8=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7));
#9=IFCPRODUCTDEFINITIONSHAPE($,$,(#8));
#10=IFCBUILDINGELEMENTPROXY('2fQ',$,'Station building',$,$,#4,#9,$,$);
#20=IFCPROJECTEDCRS('EPSG:27700',$,$,$,$,$,$);
#21=IFCMAPCONVERSION(#999,#20,400000.,300000.,100.,1.,0.,1.);
ENDSEC;
END-ISO-10303-21;`;
}

function extract(bytes, overrides = {}) {
  return extractNativePlanningArchive({
    bytes,
    application: {
      reference: "SMD/2026/0001",
      geometry: { type: "Point", coordinates: [-2.0014, 52.5978] }
    },
    document: { id: "planning-bim-bundle", title: "Approved BIM bundle", role: "site-layout" },
    profile,
    minimumConfidence: 0.72,
    ...overrides
  });
}

test("planning ZIP decodes embedded IFC and preserves archive-member provenance", () => {
  const bytes = zipSync({
    "CAD/station.ifc": strToU8(fixtureIfc()),
    "Drawings/reference.pdf": strToU8("not decoded in the native archive phase"),
    "CAD/model.dwg": strToU8("AC1027 inventory only")
  });
  const result = extract(bytes);
  assert.equal(result.status, "native-archive-geometry-ready");
  assert.equal(result.archive.entries, 3);
  assert.equal(result.archive.relevantMembers, 3);
  assert.equal(result.archive.nativeMembersDecoded, 1);
  assert.equal(result.collection.features.length, 1);
  const feature = result.collection.features[0];
  assert.equal(feature.properties.kind, "building");
  assert.equal(feature.properties.height_m, 6);
  assert.equal(feature.properties.planning_archive_member, "CAD/station.ifc");
  assert.equal(feature.properties.planning_archive_container_id, "planning-bim-bundle");
  const dwg = result.archive.members.find((item) => item.name === "CAD/model.dwg");
  assert.equal(dwg.status, "inventoried");
  assert.equal(dwg.nativeDecodable, false);
});

test("planning ZIP with no decodable native geometry remains explicit inventory", () => {
  const bytes = zipSync({
    "CAD/site.dwg": strToU8("AC1027 inventory only"),
    "Schedules/materials.pdf": strToU8("evidence")
  });
  const result = extract(bytes);
  assert.equal(result.status, "native-archive-inventoried-no-geometry");
  assert.equal(result.collection.features.length, 0);
  assert.equal(result.archive.relevantMembers, 2);
});

test("planning ZIP rejects traversal paths before promoting archive geometry", () => {
  const bytes = zipSync({ "../escape.ifc": strToU8(fixtureIfc()) });
  assert.throws(() => extract(bytes), /unsafe member path/);
});

test("planning ZIP with oversized native member withholds it instead of decompressing it", () => {
  const bytes = zipSync({ "CAD/station.ifc": strToU8(fixtureIfc()) });
  const result = extract(bytes, { maxNativeMemberBytes: 32 });
  assert.equal(result.collection.features.length, 0);
  assert.equal(result.archive.members[0].status, "withheld-size-bound");
});
