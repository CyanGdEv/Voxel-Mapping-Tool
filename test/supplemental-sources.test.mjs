import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/lib/args.mjs";
import { acquireSupplementalSources, __test } from "../src/lib/supplemental-sources.mjs";
import { fuseAdditionalMapSources } from "../src/lib/source-fusion.mjs";
import { createProjector } from "../src/lib/geo.mjs";
import { enrichUniversalFidelity } from "../src/lib/fidelity.mjs";
import { gzipSync } from "node:zlib";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("supplemental CLI flags normalize and retain repeatable files", () => {
  const { options } = parseArgs([
    "build", "--england-open-data", "--microsoft-buildings",
    "--microsoft-buildings-min-confidence", "0.72",
    "--source-config", "a.json", "--source-config", "b.json",
    "--os-openmap-local", "os.geojson", "--max-supplemental-features", "12000"
  ]);
  assert.equal(options.englandOpenData, true);
  assert.equal(options.microsoftBuildings, true);
  assert.equal(options.microsoftBuildingsMinConfidence, 0.72);
  assert.deepEqual(options.sourceConfig, ["a.json", "b.json"]);
  assert.deepEqual(options.osOpenMapLocal, ["os.geojson"]);
  assert.equal(options.maxSupplementalFeatures, 12000);
});

test("Microsoft quadkey selection is bounded and CSV parsing is quote-safe", () => {
  const keys = __test.bboxQuadKeys({ south: 52.97, west: -1.93, north: 53.00, east: -1.89 }, 9);
  assert.ok(keys.size >= 1 && keys.size <= 4);
  const first = [...keys][0];
  const rows = __test.parseCsv(`Location,QuadKey,Url,Size,UploadDate\nUK,${first},"https://example.test/a,b.csv.gz",100,2026-07-24\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quadkey, first);
  assert.equal(rows[0].url, "https://example.test/a,b.csv.gz");
  assert.equal(__test.selectMicrosoftRows(rows, keys).length, 1);
  assert.equal(__test.parseByteSize("23.1MB"), Math.ceil(23.1 * 1024 * 1024));
  assert.equal(__test.parseByteSize("74.7KB"), Math.ceil(74.7 * 1024));
});

test("Microsoft gzip GeoJSONL is decoded line-by-line", async () => {
  const bytes = gzipSync(Buffer.from('{"type":"Feature","properties":{"height":12}}\n{"type":"Feature","properties":{"height":8}}\n'));
  const lines = [];
  for await (const line of __test.gunzipLines(bytes)) lines.push(line);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).properties.height, 12);
});

test("Planning Data entities become portable source-fusion features", () => {
  const raw = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-1.9, 52.98] },
    properties: { entity: 123, dataset: "tree", name: "Veteran oak" }
  };
  const feature = __test.standardizePlanningFeature(raw, 0, "https://www.planning.data.gov.uk/entity.geojson");
  assert.equal(feature.properties.kind, "vegetation");
  assert.equal(feature.properties.subtype, "protected-or-recorded-tree");
  assert.equal(feature.properties.license, "Open Government Licence v3.0");
});

test("planning designation zones stay evidence-only rather than spawning trees", () => {
  const raw = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[[-1.91, 52.98], [-1.90, 52.98], [-1.90, 52.99], [-1.91, 52.99], [-1.91, 52.98]]] },
    properties: { entity: 456, dataset: "tree-preservation-zone", name: "TPO zone" }
  };
  const feature = __test.standardizePlanningFeature(raw, 0, "https://www.planning.data.gov.uk/entity.geojson");
  assert.equal(feature.properties.kind, "detail");
  assert.equal(feature.properties.subtype, "tree-preservation-zone");
});

test("gap-fill acquired buildings are withheld when an OSM building already overlaps", async () => {
  const projector = createProjector({ lat: 52.98, lon: -1.9 });
  const geometry = {
    type: "Polygon",
    coordinates: [[[-1.9001, 52.9799], [-1.8999, 52.9799], [-1.8999, 52.9801], [-1.9001, 52.9801], [-1.9001, 52.9799]]]
  };
  const existing = [{
    id: "osm:way:1", name: "Station", kind: "building", subtype: "yes", tags: { building: "yes" },
    geometry, localGeometry: { type: "Polygon", coordinates: [geometry.coordinates[0].map(projector.forward)] },
    vertical: { heightM: null }, source: { provider: "OpenStreetMap" }, verification: { plan: "public-map" }
  }];
  const acquired = [{
    id: "microsoft-buildings", adapter: "geojsonl-gzip-partitions", endpoint: "https://example.test",
    collection: {
      type: "FeatureCollection",
      source: { name: "Microsoft Global ML Building Footprints", url: "https://example.test", license: "CDLA Permissive 2.0" },
      features: [{
        type: "Feature", geometry,
        properties: { kind: "building", subtype: "ml-building-footprint", source_name: "Microsoft Global ML Building Footprints", source_url: "https://example.test", license: "CDLA Permissive 2.0", merge_policy: "gap-fill" }
      }]
    }
  }];
  const summary = await fuseAdditionalMapSources(existing, projector, { acquiredPublicData: acquired });
  assert.equal(summary.acquired.accepted, 0);
  assert.equal(summary.acquired.duplicatesWithheld, 1);
  assert.equal(existing.length, 1);
});

test("official TOW field names and woodland classes are retained", () => {
  assert.equal(__test.inferTowSubtype({ woodland_type: "Lone Tree" }), "lone-tree-canopy");
  assert.equal(__test.inferTowSubtype({ Woodland_Type: "Group of Trees" }), "tree-group-canopy");
  assert.equal(__test.inferTowSubtype({ WOODLAND_TYPE: "Small Woodland" }), "small-woodland");
  assert.equal(__test.inferTowSubtype({ woodland_type: "NFI OHC" }), "nfi-overhanging-canopy");
});


test("local configured GeoJSON follows the complete bounded acquisition path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tpmap-supplemental-"));
  const geojsonPath = path.join(root, "trees.geojson");
  const configPath = path.join(root, "sources.json");
  await writeFile(geojsonPath, JSON.stringify({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [-1.9, 52.98] }, properties: { class: "tree", height_m: 18 } },
      { type: "Feature", geometry: { type: "Point", coordinates: [-3.0, 54.0] }, properties: { class: "tree", height_m: 9 } }
    ]
  }));
  await writeFile(configPath, JSON.stringify({ sources: [{
    id: "authority-trees",
    type: "geojson-file",
    file: "trees.geojson",
    provider: "Example authority",
    sourceUrl: "https://example.test/open-data/trees",
    license: "Open Government Licence v3.0",
    kind: "vegetation",
    subtype: "surveyed-tree"
  }] }));

  const result = await acquireSupplementalSources({ sourceConfig: [configPath] }, {
    bbox: { west: -1.91, south: 52.97, east: -1.89, north: 52.99 },
    cacheDir: path.join(root, "cache"),
    userAgent: "themepark-map-test/0.12.0"
  });
  assert.equal(result.status, "active");
  assert.equal(result.featureCount, 1);
  assert.equal(result.collections[0].collection.features[0].properties.source_name, "Example authority");
  assert.equal(result.collections[0].collection.features[0].properties.height_m, 18);
});


test("Planning Data individual trees compile as single-tree evidence", () => {
  const feature = {
    id: "planning:tree:1",
    name: "Veteran oak",
    kind: "vegetation",
    subtype: "protected-or-recorded-tree",
    tags: { height_m: 17 },
    geometry: { type: "Point", coordinates: [-1.9, 52.98] },
    localGeometry: { type: "Point", coordinates: [0, 0] },
    source: { provider: "Planning Data" }
  };
  const map = { features: [feature] };
  enrichUniversalFidelity(map, {}, { accuracyMode: "verified" });
  assert.equal(feature.fidelity.tree.modelClass, "tree");
  assert.equal(feature.fidelity.tree.treeCount, 1);
  assert.equal(feature.fidelity.tree.heightM, 17);
});
