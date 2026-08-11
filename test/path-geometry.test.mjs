import test from "node:test";
import assert from "node:assert/strict";
import { enhancePathGeometry } from "../src/lib/path-geometry.mjs";
import { derivePathWidth, derivePathEdgeStyle, enrichUniversalFidelity } from "../src/lib/fidelity.mjs";
import { normalizeMap } from "../src/lib/osm.mjs";
import { compileMap } from "../src/lib/raster.mjs";

function baseMap(features) {
  return {
    features,
    projector: { inverse: ([x, z]) => [x, z] },
    boundary: {
      localGeometry: { type: "Polygon", coordinates: [[[-5, -5], [30, -5], [30, 10], [-5, 10], [-5, -5]]] }
    },
    geojson: { name: "Path Test Park" }
  };
}

function pathFeature(id, coordinates, tags = {}) {
  return {
    id,
    name: null,
    kind: "path",
    subtype: tags.highway || "footway",
    tags: { highway: "footway", ...tags },
    geometry: { type: "LineString", coordinates },
    localGeometry: { type: "LineString", coordinates },
    vertical: { heightM: null, minHeightM: 0, elevationM: null, explicit: false },
    source: { provider: "OpenStreetMap", license: "ODbL-1.0" },
    verification: { plan: "public-map", vertical: "unknown" }
  };
}

test("plausible path geometry repairs a short mapped endpoint gap once", () => {
  const map = baseMap([
    pathFeature("path:a", [[0, 0], [10, 0]], { surface: "asphalt" }),
    pathFeature("path:b", [[12, 0], [22, 0]], { surface: "asphalt" })
  ]);
  const result = enhancePathGeometry(map, {
    accuracyMode: "plausible",
    pathGeometryMode: "repair",
    pathSnapToleranceM: 2.5,
    pathSnapMinConfidence: 0.7
  });
  assert.equal(result.summary.compiledConnectors, 1);
  assert.equal(result.summary.componentReduction, 1);
  assert.ok(result.summary.danglingEndpointReduction >= 2);
  const repair = map.features.find((feature) => feature.pathGeometry?.status === "compiled-repair");
  assert.ok(repair);
  assert.equal(repair.tags.surface, "asphalt");
});

test("verified path geometry reports candidates without mutating map", () => {
  const map = baseMap([
    pathFeature("path:a", [[0, 0], [10, 0]]),
    pathFeature("path:b", [[12, 0], [22, 0]])
  ]);
  const result = enhancePathGeometry(map, {
    accuracyMode: "verified",
    pathGeometryMode: "qa",
    pathSnapToleranceM: 2.5
  });
  assert.equal(result.summary.acceptedConnectors, 1);
  assert.equal(result.summary.compiledConnectors, 0);
  assert.equal(map.features.length, 2);
});

test("mapped buildings block endpoint-gap repair", () => {
  const building = {
    id: "building:blocker",
    kind: "building",
    tags: { building: "yes" },
    localGeometry: { type: "Polygon", coordinates: [[[10.4, -1], [11.6, -1], [11.6, 1], [10.4, 1], [10.4, -1]]] }
  };
  const map = baseMap([
    pathFeature("path:a", [[0, 0], [10, 0]]),
    pathFeature("path:b", [[12, 0], [22, 0]]),
    building
  ]);
  const result = enhancePathGeometry(map, {
    accuracyMode: "plausible", pathGeometryMode: "repair", pathSnapToleranceM: 2.5
  });
  assert.equal(result.summary.compiledConnectors, 0);
  assert.ok(result.summary.rejectionReasons["crosses-building"] >= 1);
});

test("area:highway pedestrian geometry is normalized as a path polygon", async () => {
  const elements = [
    way(1, square(-0.001, 51, 0.001, 51.002), { tourism: "theme_park", name: "Area Park" }),
    way(2, square(-0.0005, 51.0005, 0.0005, 51.0013), {
      "area:highway": "pedestrian", surface: "paving_stones"
    })
  ];
  const map = await normalizeMap({
    parkName: "Area Park",
    center: { lon: 0, lat: 51.001 },
    bbox: { south: 51, west: -0.001, north: 51.002, east: 0.001 },
    suppliedBoundary: null,
    osm: { data: { elements }, source: "fixture" },
    elevation: { provider: "none", points: [], minM: 0 }
  }, {});
  const plaza = map.features.find((feature) => feature.id === "osm:way:2");
  assert.equal(plaza.kind, "path");
  assert.equal(plaza.localGeometry.type, "Polygon");
});

test("tagged variable width and explicit kerb evidence compile", async () => {
  const elements = [
    way(11, square(-0.0005, 51, 0.0005, 51.0008), { tourism: "theme_park", name: "Kerb Park" }),
    way(12, [[-0.0004, 51.0004], [0.0004, 51.0004]], {
      highway: "footway", surface: "asphalt", "width:start": "2", "width:end": "6",
      kerb: "raised", "kerb:material": "concrete"
    })
  ];
  const sources = {
    parkName: "Kerb Park",
    center: { lon: 0, lat: 51.0004 },
    bbox: { south: 51, west: -0.0005, north: 51.0008, east: 0.0005 },
    suppliedBoundary: null,
    osm: { data: { elements }, source: "fixture" },
    elevation: { provider: "none", points: [], minM: 0 }
  };
  const map = await normalizeMap(sources, {});
  const route = map.features.find((feature) => feature.id === "osm:way:12");
  const width = derivePathWidth(route, "guest", { pathWidthMode: "inferred" });
  assert.equal(width.widthStatus, "variable-width-tagged");
  assert.deepEqual(width.widthRangeM, [2, 6]);
  assert.ok(derivePathEdgeStyle(route));
  enhancePathGeometry(map, { pathGeometryMode: "off" });
  enrichUniversalFidelity(map, sources, { accuracyMode: "plausible", pathEdgeMode: "evidence" });
  const compilation = compileMap({
    parkName: "Kerb Park",
    map,
    sources,
    accuracy: { score: 0.5, grade: "D", exact3d: false },
    options: {
      scale: 1, maxCells: 100_000, accuracyMode: "plausible", buildings: "markers",
      aerialTerrainMode: "off", noRideInfoSigns: true, pathEdgeMode: "evidence"
    }
  });
  assert.ok(compilation.stats.pathEdgeCells > 0);
  assert.equal(compilation.meta.pathEdgeOutput.status, "applied");
});

function way(id, coordinates, tags) {
  return { type: "way", id, tags, geometry: coordinates.map(([lon, lat]) => ({ lon, lat })) };
}
function square(west, south, east, north) {
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}
