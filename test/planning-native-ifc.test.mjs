import test from "node:test";
import assert from "node:assert/strict";
import { extractNativeIfcPlanning, looksLikeIfc } from "../src/lib/planning-native-ifc.mjs";
import { extractNativeDxfPlanning, looksLikeAsciiDxf } from "../src/lib/planning-native-vector.mjs";

const profile = {
  bbox: { west: -1.91, south: 52.97, east: -1.88, north: 53.00 }
};

function fixtureIfc() {
  return Buffer.from(`ISO-10303-21;
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
END-ISO-10303-21;`);
}

test("native IFC extruded planning solids become georeferenced authoritative geometry", () => {
  const bytes = fixtureIfc();
  assert.equal(looksLikeIfc(bytes), true);
  const result = extractNativeIfcPlanning({
    bytes,
    application: { reference: "SMD/2026/0001", geometry: { type: "Point", coordinates: [-2.0014, 52.5978] } },
    document: { id: "station-ifc", title: "Approved station BIM", role: "site-layout" },
    profile,
    minimumConfidence: 0.72
  });
  assert.equal(result.status, "native-ifc-geometry-ready");
  assert.equal(result.registration, "bng-map-conversion");
  assert.equal(result.collection.features.length, 1);
  const feature = result.collection.features[0];
  assert.equal(feature.properties.kind, "building");
  assert.equal(feature.properties.height_m, 6);
  assert.equal(feature.properties.elevation_m, 100);
  assert.equal(feature.properties.top_elevation_m, 106);
  assert.equal(feature.properties.planning_authoritative, true);
  assert.equal(feature.properties.native_ifc_entity, "IFCBUILDINGELEMENTPROXY");
  assert.equal(feature.geometry.type, "Polygon");
  assert.equal(feature.geometry.coordinates[0].length, 5);
});

test("historical native-vector entrypoint routes text IFC without rasterising it", () => {
  const bytes = fixtureIfc();
  assert.equal(looksLikeAsciiDxf(bytes), true,
    "compatibility detector keeps native IFC bytes on the direct native-document path");
  const result = extractNativeDxfPlanning({
    bytes,
    application: { reference: "SMD/2026/0001", geometry: { type: "Point", coordinates: [-2.0014, 52.5978] } },
    document: { id: "station-ifc", title: "Approved station BIM", role: "site-layout" },
    profile,
    minimumConfidence: 0.72
  });
  assert.equal(result.nativeFormat, "ifc");
  assert.equal(result.collection.features.length, 1);
});

test("IFC without a trusted map conversion or application location stays evidence-only", () => {
  const withoutMap = fixtureIfc().toString("utf8").replace(/^#20=.*\n#21=.*\n/m, "");
  const result = extractNativeIfcPlanning({
    bytes: Buffer.from(withoutMap),
    application: { reference: "SMD/2026/0002" },
    document: { id: "unlocated-ifc" },
    profile: {},
    minimumConfidence: 0.72
  });
  assert.equal(result.status, "native-ifc-registration-unavailable");
  assert.equal(result.collection.features.length, 0);
});
