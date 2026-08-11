import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMcworld } from "@taku128/mcworld-browser";
import { unzipSync } from "fflate";
import { writeArrayBuffer } from "geotiff";
import { entryContentTypeToFormatMap, generateChunkKeyFromIndices } from "mcbe-leveldb";
import { lineCells, parseBbox, polygonScanlineSpans } from "../src/lib/geo.mjs";
import { osmGeometry } from "../src/lib/osm.mjs";
import { buildOverpassQuery } from "../src/lib/sources.mjs";
import { buildPark } from "../src/lib/pipeline.mjs";
import { compileMap, formatSignText } from "../src/lib/raster.mjs";
import { blockForSurfaceStyle, derivePathWidth, deriveSurfaceStyle } from "../src/lib/fidelity.mjs";
import { acquireOrthophotos } from "../src/lib/orthophoto.mjs";
import { parseArgs } from "../src/lib/args.mjs";

const fixture = path.resolve("test/fixtures/mini-park.overpass.json");

test("parses and validates bounding boxes", () => {
  assert.deepEqual(parseBbox("51,-0.2,52,0.2"), { south: 51, west: -0.2, north: 52, east: 0.2 });
  assert.throws(() => parseBbox("52,0,51,1"));
});

test("validates path-recovery confidence, grade, and cut/fill controls", () => {
  const parsed = parseArgs([
    "build", "--path-discovery-mode", "qa", "--path-discovery-min-confidence", "0.8",
    "--path-discovery-ramp-grade-percent", "8.3", "--path-discovery-steep-grade-percent", "16",
    "--path-terrain-mode", "conform", "--path-terrain-max-cut-fill-m", "2"
  ]);
  assert.equal(parsed.options.pathDiscoveryMinConfidence, 0.8);
  assert.equal(parsed.options.pathTerrainMaxCutFillM, 2);
  assert.throws(() => parseArgs([
    "build", "--path-discovery-ramp-grade-percent", "20", "--path-discovery-steep-grade-percent", "10"
  ]), /cannot be below/);
  assert.throws(() => parseArgs(["build", "--path-terrain-max-cut-fill-m", "9"]), /between 0 and 8/);
});

test("parses repeatable non-OSM source inputs and fusion tolerance", () => {
  const parsed = parseArgs([
    "build", "--overture", "transport.geojson", "--overture", "base.geojson",
    "--public-data", "park-survey.geojson", "--source-fusion-tolerance-m", "2.5",
    "--terrain-detail-mode", "plausible", "--max-terrain-rocks", "250"
  ]);
  assert.deepEqual(parsed.options.overture, ["transport.geojson", "base.geojson"]);
  assert.deepEqual(parsed.options.publicData, ["park-survey.geojson"]);
  assert.equal(parsed.options.sourceFusionToleranceM, 2.5);
  assert.equal(parsed.options.maxTerrainRocks, 250);
  assert.throws(() => parseArgs([
    "build", "--source-fusion-tolerance-m", "30"
  ]), /between 0.25 and 25/);
});

test("builds a bounded Overpass query with required feature classes", () => {
  const query = buildOverpassQuery({ south: 51, west: -0.1, north: 51.1, east: 0.1 });
  assert.match(query, /\[bbox:51\.0000000,-0\.1000000,51\.1000000,0\.1000000\]/);
  assert.match(query, /roller_coaster/);
  assert.match(query, /out meta geom/);
});

test("wraps public building names into safe four-line sign text", () => {
  const text = formatSignText("A Very Long Public Building Name With Extra Words");
  const lines = text.split("\n");
  assert.ok(lines.length <= 4);
  assert.ok(lines.every((line) => Array.from(line).length <= 20));
  assert.equal(formatSignText("Unsafe §cLabel\nName"), "Unsafe Label Name");
});

test("maps observed path colour and laying pattern to a deterministic Bedrock palette", () => {
  const feature = {
    id: "test:path",
    kind: "path",
    tags: {
      surface: "paving_stones",
      "surface:colour": "#a95c42",
      "surface:pattern": "herringbone"
    },
    source: { provider: "portable test observation", license: "CC0" }
  };
  const style = deriveSurfaceStyle(feature, { accuracyMode: "verified" });
  assert.equal(style.material, "paving_stones");
  assert.equal(style.colour, "#a95c42");
  assert.equal(style.pattern, "herringbone");
  assert.equal(style.appearanceStatus, "observed-or-tagged");
  assert.ok(style.nearestBlockColourDeltaE76 < 20);
  assert.equal(blockForSurfaceStyle(style, 3, 7, 42), blockForSurfaceStyle(style, 3, 7, 42));
});

test("rasterizes measured even widths instead of collapsing them to one block", () => {
  const interiorRows = (width) => lineCells([[0, 0], [5, 0]], width)
    .filter(([x]) => x === 2)
    .map(([, z]) => z)
    .sort((a, b) => a - b);
  assert.deepEqual(interiorRows(1), [0]);
  assert.deepEqual(interiorRows(2), [-1, 0]);
  assert.deepEqual(interiorRows(3), [-1, 0, 1]);
  assert.deepEqual(interiorRows(4), [-2, -1, 0, 1]);
});

test("uses disclosed universal path-width priors when source width is absent", () => {
  const feature = {
    id: "test:guest-footway",
    kind: "path",
    tags: { highway: "footway" },
    localGeometry: { type: "LineString", coordinates: [[0, 0], [20, 0]] },
    source: { provider: "OpenStreetMap", license: "ODbL-1.0" }
  };
  const inferred = derivePathWidth(feature, "guest", { pathWidthMode: "inferred" });
  assert.equal(inferred.widthM, 3);
  assert.equal(inferred.rasterWidthM, 3);
  assert.equal(inferred.widthStatus, "class-prior");
  assert.deepEqual(inferred.widthRangeM, [2, 5]);
  const sourceOnly = derivePathWidth(feature, "guest", { pathWidthMode: "source-only" });
  assert.equal(sourceOnly.widthM, null);
  assert.equal(sourceOnly.rasterWidthM, 1);
  assert.equal(sourceOnly.widthStatus, "unknown-marker");
});

test("keeps explicit path width ahead of an orthophoto edge estimate", () => {
  const feature = {
    id: "test:surveyed-path",
    kind: "path",
    tags: { highway: "footway", width: "4.2" },
    localGeometry: { type: "LineString", coordinates: [[0, 0], [20, 0]] },
    source: { provider: "Public survey", license: "OGL-3.0" },
    orthophoto: {
      path: {
        status: "accepted",
        compilationEligible: true,
        widthM: 7,
        confidence: 0.9
      }
    }
  };
  const width = derivePathWidth(feature, "guest", { pathWidthMode: "inferred" });
  assert.equal(width.widthM, 4.2);
  assert.equal(width.widthStatus, "observed-width");
  assert.equal(width.widthSource.provider, "Public survey");
});

test("requires explicit orthophoto provider and reuse licence in evidence mode", async () => {
  const context = {
    center: { lat: 51, lon: 0 },
    projector: { inverse: ([x, z]) => [x, z] }
  };
  await assert.rejects(
    acquireOrthophotos({ orthophoto: ["unused.tif"], orthophotoMode: "evidence", orthophotoLicense: "CC0" }, context),
    /requires --orthophoto-source and --orthophoto-license/
  );
  await assert.rejects(
    acquireOrthophotos({ orthophoto: ["unused.tif"], orthophotoMode: "evidence", orthophotoSource: "Provider" }, context),
    /requires --orthophoto-source and --orthophoto-license/
  );
});

test("keeps assist-mode orthophoto observations out of compiled path evidence", () => {
  const feature = {
    id: "test:assist-only-path",
    kind: "path",
    tags: { highway: "footway" },
    localGeometry: { type: "LineString", coordinates: [[0, 0], [20, 0]] },
    source: { provider: "OpenStreetMap", license: "ODbL-1.0" },
    orthophoto: {
      path: {
        status: "accepted",
        compilationEligible: false,
        widthM: 8,
        colour: "#123456",
        material: "asphalt",
        confidence: 0.9
      }
    }
  };
  const width = derivePathWidth(feature, "guest", { pathWidthMode: "source-only" });
  const style = deriveSurfaceStyle(feature, { accuracyMode: "verified" });
  assert.equal(width.widthStatus, "unknown-marker");
  assert.equal(width.rasterWidthM, 1);
  assert.equal(style.appearanceStatus, "unknown-visible-fallback");
  assert.equal(style.colour, null);
  assert.equal(style.material, null);
});

test("measures path width and colour from a provenance-complete sub-metre orthophoto", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "themepark-map-orthophoto-"));
  const source = JSON.parse(await readFile(fixture, "utf8"));
  const avenue = source.elements.find((element) => element.id === 101);
  delete avenue.tags.width;
  delete avenue.tags.surface;
  delete avenue.tags["surface:colour"];
  const osmPath = path.join(directory, "orthophoto.overpass.json");
  await writeFile(osmPath, JSON.stringify(source));

  const west = -0.002, east = 0.002, south = 51, north = 51.002;
  const centerLat = (south + north) / 2;
  const metresPerLonDegree = Math.PI / 180 * 6_378_137 * Math.cos(centerLat * Math.PI / 180);
  const metresPerLatDegree = Math.PI / 180 * 6_378_137;
  const width = Math.ceil((east - west) * metresPerLonDegree / 0.5);
  const height = Math.ceil((north - south) * metresPerLatDegree / 0.5);
  const pixels = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    const lat = north - (row + 0.5) * (north - south) / height;
    for (let column = 0; column < width; column += 1) {
      const lon = west + (column + 0.5) * (east - west) / width;
      const distanceM = Math.abs(lon * metresPerLonDegree);
      const mainPath = distanceM <= 3 && lat >= 51.00025 && lat <= 51.00175;
      const branchEastM = lon * metresPerLonDegree;
      const branchNorthM = (lat - centerLat) * metresPerLatDegree;
      const unmappedBranch = branchEastM >= 0 && branchEastM <= 60 && Math.abs(branchNorthM) <= 2;
      const pathPixel = mainPath || unmappedBranch;
      const rgb = pathPixel ? [58, 60, 62] : [65, 132, 54];
      const index = (row * width + column) * 3;
      pixels[index] = rgb[0]; pixels[index + 1] = rgb[1]; pixels[index + 2] = rgb[2];
    }
  }
  const orthophotoPath = path.join(directory, "fixture-0.5m-rgb.tif");
  await writeFile(orthophotoPath, new Uint8Array(writeArrayBuffer(pixels, {
    width,
    height,
    GeographicTypeGeoKey: 4326,
    ModelPixelScale: [(east - west) / width, (north - south) / height, 0],
    ModelTiepoint: [0, 0, 0, west, north, 0],
    BitsPerSample: [8, 8, 8],
    SampleFormat: [1, 1, 1],
    SamplesPerPixel: [3],
    PhotometricInterpretation: [2],
    PlanarConfiguration: [1]
  })));

  const result = await buildPark({
    parkName: "Orthophoto Fixture Park",
    planningWorldAuthority: "fixture",
    osm: osmPath,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    orthophoto: [orthophotoPath],
    orthophotoMode: "evidence",
    orthophotoSource: "Synthetic public orthophoto fixture",
    orthophotoSourceUrl: "https://example.test/orthophoto",
    orthophotoLicense: "CC0-1.0",
    orthophotoDate: "2026-07-01",
    orthophotoMaxGsdM: 0.75,
    orthophotoMinConfidence: 0.6,
    pathDiscoveryMode: "evidence",
    pathDiscoveryMinConfidence: 0.68,
    out: directory,
    maxCells: 200_000,
    accuracyMode: "verified",
    noWorld: false,
    noAddon: true
  });

  const fidelity = JSON.parse(await readFile(result.paths.fidelity, "utf8"));
  const evidence = JSON.parse(await readFile(result.paths.orthophotoEvidence, "utf8"));
  const qa = JSON.parse(await readFile(result.paths.orthophotoQa, "utf8"));
  const topology = JSON.parse(await readFile(result.paths.pathTopologyEvidence, "utf8"));
  const topologyQa = JSON.parse(await readFile(result.paths.pathTopologyQa, "utf8"));
  const geojson = JSON.parse(await readFile(result.paths.geojson, "utf8"));
  const worldManifest = JSON.parse(await readFile(result.paths.worldManifest, "utf8"));
  const observation = evidence.observations.find((entry) => entry.featureId === "osm:way:101");
  const avenueOutput = geojson.features.find((entry) => entry.id === "osm:way:101");

  assert.equal(evidence.status, "available");
  assert.equal(observation.status, "accepted");
  assert.ok(observation.widthM >= 5 && observation.widthM <= 7, `measured width ${observation.widthM}`);
  assert.ok(observation.confidence >= 0.6);
  assert.equal(observation.colour, "#3a3c3e");
  assert.equal(observation.source.license, "CC0-1.0");
  assert.equal(avenueOutput.properties._fidelity.path.widthStatus, "orthophoto-edge-observed");
  assert.equal(avenueOutput.properties._fidelity.path.surfaceStyle.appearanceStatus, "orthophoto-observed");
  assert.ok(fidelity.surfaces.orthophotoWidthCoverage > 0);
  assert.ok(fidelity.surfaces.orthophotoColourCoverage > 0);
  assert.ok(qa.features.some((entry) => entry.properties?.feature_id === "osm:way:101"));
  assert.equal(worldManifest.fidelityOutput.orthophoto.acceptedFeatures, evidence.acceptedFeatures);
  assert.equal(topology.status, "available");
  assert.ok(topology.acceptedGraphEdges >= 1, `accepted recovered edges ${topology.acceptedGraphEdges}`);
  assert.ok(topology.compiledComponents >= 1, `compiled recovered components ${topology.compiledComponents}`);
  assert.ok(topology.recoveredLengthM >= 35, `recovered length ${topology.recoveredLengthM}`);
  assert.ok(topologyQa.features.some((entry) => entry.properties?.kind === "recovered_path_graph_edge"));
  assert.ok(geojson.features.some((entry) => entry.properties?.["orthophoto:discovered"] === "yes"));
  assert.equal(worldManifest.fidelityOutput.pathTopology.acceptedGraphEdges, topology.acceptedGraphEdges);
  assert.equal(worldManifest.fidelityOutput.pathTerrain.status, "source-terrain-unchanged");
  assert.equal(worldManifest.validation.status, "passed");

  const qaDirectory = path.join(directory, "qa-only");
  const qaResult = await buildPark({
    parkName: "Orthophoto Fixture Park",
    planningWorldAuthority: "fixture",
    osm: osmPath,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    orthophoto: [orthophotoPath],
    orthophotoMode: "evidence",
    orthophotoSource: "Synthetic public orthophoto fixture",
    orthophotoSourceUrl: "https://example.test/orthophoto",
    orthophotoLicense: "CC0-1.0",
    orthophotoDate: "2026-07-01",
    orthophotoMaxGsdM: 0.75,
    orthophotoMinConfidence: 0.6,
    pathDiscoveryMode: "qa",
    pathDiscoveryMinConfidence: 0.68,
    out: qaDirectory,
    maxCells: 200_000,
    accuracyMode: "verified",
    noWorld: true,
    noAddon: true
  });
  const qaTopology = JSON.parse(await readFile(qaResult.paths.pathTopologyEvidence, "utf8"));
  const qaGeojson = JSON.parse(await readFile(qaResult.paths.geojson, "utf8"));
  assert.equal(qaTopology.compilationPermitted, false);
  assert.ok(qaTopology.candidateGraphEdges >= 1);
  assert.equal(qaTopology.compiledComponents, 0);
  assert.ok(!qaGeojson.features.some((entry) => entry.properties?.["orthophoto:discovered"] === "yes"));
});

test("bounds recovered-path terrain conformance to the source DTM", () => {
  const polygon = [[
    [0, 0], [12, 0], [12, 12], [0, 12], [0, 0]
  ]];
  const pathPolygon = [[
    [2, 4], [10, 4], [10, 8], [2, 8], [2, 4]
  ]];
  const map = {
    boundary: { localGeometry: { type: "Polygon", coordinates: polygon } },
    features: [{
      id: "orthophoto:path-area:1",
      kind: "path",
      subtype: "orthophoto_walkable_area",
      tags: { highway: "pedestrian", area: "yes", "orthophoto:discovered": "yes" },
      localGeometry: { type: "Polygon", coordinates: pathPolygon },
      surfaceStyle: {
        primaryBlock: "minecraft:light_gray_concrete",
        secondaryBlock: "minecraft:gray_concrete",
        pattern: "solid",
        appearanceStatus: "orthophoto-observed"
      }
    }],
    topology: {},
    semantics: {},
    fidelity: null,
    orthophoto: null,
    pathTopology: { status: "available", compiledComponents: 1 }
  };
  const sources = {
    center: { lat: 0, lon: 0 },
    elevation: {
      provider: "synthetic-dtm",
      minM: 100,
      points: [],
      sampleLocal(x, z) {
        return 100 + (Math.round(x) === 6 && Math.round(z) === 6 ? 4 : 0);
      }
    }
  };
  const compilation = compileMap({
    parkName: "Terrain Conformance Fixture",
    map,
    sources,
    accuracy: { score: 0.9, grade: "A", exact3d: false },
    options: {
      pathTerrainMode: "conform",
      pathTerrainMaxCutFillM: 2,
      noRideInfoSigns: true,
      maxCells: 10_000
    }
  });
  assert.equal(compilation.meta.pathTerrainOutput.status, "conformed");
  assert.ok(compilation.meta.pathTerrainOutput.adjustedCells >= 1);
  assert.equal(compilation.meta.pathTerrainOutput.maxAdjustmentM, 2);
  assert.equal(compilation.meta.pathTerrainOutput.cutVolumeM3, 2);
  assert.equal(compilation.meta.pathTerrainOutput.fillVolumeM3, 0);
});

test("compiles universal tree, patterned path, and measured bridge evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "themepark-map-fidelity-"));
  const source = JSON.parse(await readFile(fixture, "utf8"));
  const avenue = source.elements.find((element) => element.id === 101);
  Object.assign(avenue.tags, {
    surface: "paving_stones",
    "surface:colour": "#a95c42",
    "surface:pattern": "herringbone"
  });
  source.elements.push({
    type: "way",
    id: 111,
    timestamp: "2026-07-02T12:00:00Z",
    version: 1,
    tags: {
      highway: "footway", width: "2", bridge: "yes", "bridge:deck:ele": "4",
      surface: "wood", "surface:colour": "brown"
    },
    geometry: [
      { lat: 51.00148, lon: -0.0011 },
      { lat: 51.00148, lon: -0.00075 }
    ]
  }, {
    type: "node",
    id: 112,
    lat: 51.00095,
    lon: 0.0012,
    timestamp: "2026-07-02T12:00:00Z",
    version: 1,
    tags: { natural: "tree", height: "9", diameter_crown: "5", leaf_type: "broadleaved" }
  });
  const osmPath = path.join(directory, "universal.overpass.json");
  await writeFile(osmPath, JSON.stringify(source));
  const result = await buildPark({
    parkName: "Universal Fixture Park",
    planningWorldAuthority: "fixture",
    osm: osmPath,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    out: directory,
    maxCells: 200_000,
    accuracyMode: "verified",
    noWorld: true,
    noAddon: true
  });
  const fidelity = JSON.parse(await readFile(result.paths.fidelity, "utf8"));
  assert.equal(fidelity.model, "universal-capability-fusion");
  assert.equal(fidelity.bridges.mappedFeatures, 1);
  assert.equal(fidelity.bridges.verticalEvidenced, 1);
  assert.equal(fidelity.trees.pointTrees, 1);
  assert.equal(fidelity.trees.heightEvidenced, 1);
  assert.ok(fidelity.surfaces.colourCoverage > 0);
  assert.ok(fidelity.surfaces.explicitPatternCoverage > 0);
  const evidence = JSON.parse(await readFile(result.paths.evidence, "utf8"));
  assert.equal(evidence.compilation.meta.verticalStats.bridgeMeasuredOrExplicit, 1);
  assert.ok(evidence.compilation.meta.verticalStats.bridgeDeckBlocks > 0);
  assert.equal(evidence.compilation.meta.verticalStats.treeModels, 1);
  assert.ok(evidence.compilation.meta.verticalStats.treeLeafBlocks > 0);
});

test("fuses Overture gaps and licensed public terrain detail without duplicating OSM paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "themepark-map-source-fusion-"));
  const source = JSON.parse(await readFile(fixture, "utf8"));
  const avenue = source.elements.find((element) => element.id === 101);
  const overturePath = path.join(directory, "overture-segments.geojson");
  await writeFile(overturePath, JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        id: "duplicate-main-avenue", theme: "transportation", type: "segment",
        subtype: "road", class: "footway", names: { primary: "Main Avenue" }, version: 1
      },
      geometry: {
        type: "LineString",
        coordinates: avenue.geometry.map((point) => [point.lon, point.lat])
      }
    }, {
      type: "Feature",
      properties: {
        id: "gap-footway", theme: "transportation", type: "segment",
        subtype: "road", class: "footway", names: { primary: "Overture Gap Path" },
        road_surface: [{ value: "compacted", between: null }],
        width_rules: [{ value: 2.5, between: null }], version: 1
      },
      geometry: {
        type: "LineString",
        coordinates: [[-0.00138, 51.0009], [-0.00138, 51.00118]]
      }
    }]
  }));

  const result = await buildPark({
    parkName: "Source Fusion Fixture Park",
    planningWorldAuthority: "fixture",
    osm: fixture,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    overture: [overturePath],
    publicData: [path.resolve("examples/public-terrain-observations.geojson")],
    sourceFusionToleranceM: 3,
    elevation: "none",
    terrainDetailMode: "plausible",
    terrainRockDensityPer100m2: 1.5,
    terrainRockMinSpacingM: 3,
    out: directory,
    maxCells: 200_000,
    accuracyMode: "verified",
    noWorld: true,
    noAddon: true
  });

  const fusion = JSON.parse(await readFile(result.paths.sourceFusion, "utf8"));
  assert.equal(fusion.overture.considered, 2);
  assert.equal(fusion.overture.accepted, 1);
  assert.equal(fusion.overture.duplicatesWithheld, 1);
  assert.equal(fusion.publicData.accepted, 4);
  assert.equal(fusion.providers["Overture Maps Foundation"], 1);

  const terrain = JSON.parse(await readFile(result.paths.terrainDetails, "utf8"));
  assert.ok(terrain.dirtPaths.features >= 2);
  assert.equal(terrain.rocks.pointFeatures, 1);
  assert.equal(terrain.rocks.cliffOrOutcropLines, 1);
  assert.equal(terrain.rocks.surfaceFeatures, 1);

  const evidence = JSON.parse(await readFile(result.paths.evidence, "utf8"));
  const stats = evidence.compilation.meta.verticalStats;
  assert.equal(stats.terrainRockDimensionedModels, 1);
  assert.ok(stats.terrainCliffMarkerBlocks > 0);
  assert.ok(stats.terrainInferredRockClusters > 0);
  assert.ok(stats.terrainRockBlocks > 0);
  assert.ok(evidence.compilation.meta.surfaceStyles.some((style) => style.material === "earth"));

  const geojson = JSON.parse(await readFile(result.paths.geojson, "utf8"));
  assert.equal(geojson.features.filter((feature) => feature.properties._source?.provider ===
    "Overture Maps Foundation").length, 1);
  assert.ok(geojson.features.some((feature) => feature.properties.id === "public:rock:dimensioned-example" &&
    feature.properties._source?.license));
});

test("assembles split OSM multipolygon members and preserves inner holes", () => {
  const relation = {
    type: "relation",
    tags: { type: "multipolygon", natural: "water" },
    members: [
      {
        role: "outer",
        geometry: [
          { lon: 0, lat: 0 }, { lon: 10, lat: 0 }, { lon: 10, lat: 10 }
        ]
      },
      {
        role: "inner",
        geometry: [
          { lon: 3, lat: 3 }, { lon: 7, lat: 3 }, { lon: 7, lat: 7 },
          { lon: 3, lat: 7 }, { lon: 3, lat: 3 }
        ]
      },
      {
        role: "outer",
        geometry: [
          { lon: 0, lat: 0 }, { lon: 0, lat: 10 }, { lon: 10, lat: 10 }
        ]
      }
    ]
  };
  const geometry = osmGeometry(relation);
  assert.equal(geometry.type, "Polygon");
  assert.equal(geometry.coordinates.length, 2);
  assert.deepEqual(geometry.coordinates[0][0], geometry.coordinates[0].at(-1));
  const cells = new Set(polygonScanlineSpans(geometry.coordinates)
    .flatMap(([x1, x2, z]) => Array.from({ length: x2 - x1 + 1 }, (_, offset) => `${x1 + offset},${z}`)));
  assert.equal(cells.size, 84);
  assert.ok(cells.has("1,1"));
  assert.ok(!cells.has("4,4"), "the inner member must remain an unpainted hole");
});

test("runs the offline 1:1 pipeline and packages a prebuilt Bedrock world", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "themepark-map-test-"));
  const result = await buildPark({
    parkName: "Fixture Park",
    planningWorldAuthority: "fixture",
    osm: fixture,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    out: directory,
    maxCells: 200_000,
    accuracyMode: "verified"
  });
  assert.equal(result.parkName, "Fixture Park");
  assert.equal(result.exact3d, false);
  assert.ok(result.stats.operations > 0);
  assert.equal(result.stats.buildingSigns, 2);
  assert.ok(result.stats.chunks > 0);
  assert.ok(result.stats.chunks < 400, "boundary-crossing OSM geometries must be clipped to the park mask");
  assert.ok(result.stats.worldChunks >= result.stats.chunks);
  assert.equal(result.stats.worldValidation, "passed");
  assert.ok(result.paths.world.endsWith(".mcworld"));
  assert.ok(result.paths.addon.endsWith(".mcaddon"));
  const labelIndex = JSON.parse(await readFile(result.paths.buildingLabels, "utf8"));
  assert.equal(labelIndex.count, 2);
  assert.deepEqual(labelIndex.labels.map((label) => label.name).sort(), ["Unknown Height Kiosk", "Verified Hall"]);
  assert.equal(labelIndex.labels.find((label) => label.name === "Verified Hall").placement.method, "mapped-building-entrance");
  assert.equal(result.stats.worldValidation, "passed");

  const archiveBytes = new Uint8Array(await readFile(result.paths.world));
  const archive = unzipSync(archiveBytes);
  assert.ok(archive["level.dat"]);
  assert.ok(archive["db/CURRENT"]);
  const levelDat = await entryContentTypeToFormatMap.LevelDat.parse(Buffer.from(archive["level.dat"]));
  assert.equal(levelDat.value.LevelName.value, "Fixture Park");
  assert.equal(levelDat.value.Generator.value, 5);

  // Independent pure-JS reader: scan the LevelDB from the finished .mcworld,
  // then decode real blocks from its current-format subchunks.
  const world = openMcworld(archiveBytes);
  const overworld = world.scan.dimensions.get(0);
  assert.equal(overworld.chunks.size, result.stats.worldChunks);
  const decoded = world.readBlocks({ minX: -8, maxX: 8, minY: 60, maxY: 75, minZ: -8, maxZ: 8 });
  assert.ok(decoded.blocks.length > 0);
  assert.ok(decoded.palette.some((block) => block.Name === "minecraft:grass_block"));

  const worldManifest = JSON.parse(await readFile(result.paths.worldManifest, "utf8"));
  assert.deepEqual(worldManifest.buildingOutput, {
    mode: "markers",
    markedFootprints: 2,
    pointMarkers: 0,
    unrepresentedFeatures: 0,
    markerCells: 222,
    namedSigns: 2,
    unnamedMarkedFootprints: 0
  });
  assert.equal(worldManifest.validation.signLabels.stored,
    result.stats.buildingSigns + result.stats.rideInformationSigns + result.stats.playerInformationSigns);
  assert.equal(worldManifest.validation.signLabels.status, "passed");
  const sign = worldManifest.validation.signLabels.sample;
  const decodedSign = world.readBlocks({
    minX: sign.x, maxX: sign.x,
    minY: sign.y, maxY: sign.y,
    minZ: sign.z, maxZ: sign.z
  });
  assert.equal(decodedSign.blocks.length, 1);
  assert.equal(decodedSign.palette[decodedSign.blocks[0].state].Name, "minecraft:oak_sign");
  assert.equal(decodedSign.palette[decodedSign.blocks[0].state].Properties.ground_sign_direction, "8");

  const signChunk = { x: Math.floor(sign.x / 16), z: Math.floor(sign.z / 16), dimension: "overworld" };
  const rawBlockEntities = world.reader.get(generateChunkKeyFromIndices(signChunk, "BlockEntity"));
  assert.ok(rawBlockEntities, "the independent LevelDB reader must find native block-entity data");
  const parsedBlockEntities = await entryContentTypeToFormatMap.BlockEntity.parse(Buffer.from(rawBlockEntities));
  const storedSign = parsedBlockEntities.value.blockEntities.value.value.find((entity) =>
    entity.x.value === sign.x && entity.y.value === sign.y && entity.z.value === sign.z
  );
  assert.equal(storedSign.id.value, "Sign");
  assert.equal(storedSign.FrontText.value.Text.value, sign.text);
  assert.equal(storedSign.BackText.value.Text.value, sign.text);
  assert.equal(storedSign.IsWaxed.value, 1);

  const paletteManifest = JSON.parse(await readFile(result.paths.blockPalette, "utf8"));
  assert.ok(paletteManifest.emittedBlocks.includes("minecraft:yellow_concrete"));
  assert.ok(paletteManifest.emittedBlocks.includes("minecraft:standing_sign"));
  assert.ok(!paletteManifest.emittedBlocks.includes("minecraft:deepslate_tiles"), "marker mode must not emit building roofs");
});

test("compiles a traceable 3D planning profile and keeps missing banking explicit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "themepark-map-profile-"));
  const source = JSON.parse(await readFile(fixture, "utf8"));
  const track = source.elements.find((element) => element.tags?.roller_coaster === "track");
  const profilePath = path.join(directory, "ride-profile.geojson");
  await writeFile(profilePath, JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        id: "planning:evidence-coaster",
        replaces: "osm:way:104",
        ride_name: "Evidence Coaster",
        kind: "ride_track",
        evidence: "planning-verified",
        elevation_datum: "ODN",
        source_name: "Public planning elevation drawing",
        source_url: "https://example.gov/planning/evidence-coaster",
        license: "Open test licence",
        checked_at: "2026-08-02T00:00:00Z"
      },
      geometry: {
        type: "LineString",
        coordinates: track.geometry.map((point, index) => [point.lon, point.lat, 100 + (index % 4) * 2])
      }
    }]
  }));
  const result = await buildPark({
    parkName: "Fixture Park",
    planningWorldAuthority: "fixture",
    osm: fixture,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    rideProfile: [profilePath],
    rideProfileMode: "profile",
    out: directory,
    maxCells: 200_000,
    noWorld: true,
    noAddon: true
  });
  const profiles = JSON.parse(await readFile(result.paths.rideProfiles, "utf8"));
  assert.equal(profiles.totals.profiledTrackFeatures, 1);
  assert.equal(profiles.totals.verticalCoverage, 1);
  assert.equal(profiles.totals.bankingCoverage, 0);
  const profiledRide = profiles.rides.find((ride) => ride.name === "Evidence Coaster");
  assert.equal(profiledRide.status, "full-3d-elevation");
  assert.equal(profiledRide.latestEvidenceDate, "2026-08-02T00:00:00.000Z");
  const evidence = JSON.parse(await readFile(result.paths.evidence, "utf8"));
  assert.equal(evidence.compilation.meta.verticalStats.profiledRideTracks, 1);
  assert.ok(evidence.compilation.meta.verticalStats.rideProfileBlocks > 0);
  assert.equal(evidence.compilation.meta.verticalStats.playerInformationSigns, 7);
  assert.equal(evidence.compilation.meta.verticalStats.rideInformationSigns, 1);
  assert.ok(evidence.accuracy.gaps.some((gap) => gap.code === "RIDE_BANKING_GEOMETRY_PARTIAL"));
  assert.ok(!evidence.accuracy.gaps.some((gap) => gap.code === "RIDE_VERTICAL_GEOMETRY_ABSENT"));
});

test("excavates mapped ride tunnels and grounds inferred elevated supports", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "themepark-map-ride-structures-"));
  const source = JSON.parse(await readFile(fixture, "utf8"));
  const track = source.elements.find((element) => element.tags?.roller_coaster === "track");
  track.tags.tunnel = "yes";
  track.tags.layer = "-1";
  const osmPath = path.join(directory, "ride-structures.overpass.json");
  await writeFile(osmPath, JSON.stringify(source));
  const properties = {
    kind: "ride_track",
    evidence: "planning-verified",
    elevation_datum: "absolute-metres",
    source_name: "Public planning section",
    license: "Open test licence",
    checked_at: "2026-08-02T00:00:00Z"
  };
  const tunnelCoordinates = track.geometry.slice(0, -1)
    .map((point, index) => [point.lon, point.lat, index === 2 ? null : -8]);
  const profilePath = path.join(directory, "ride-structures.geojson");
  await writeFile(profilePath, JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        ...properties,
        id: "planning:tunnel-coaster",
        replaces: "osm:way:104",
        ride_name: "Tunnel Coaster",
        allow_gaps: true,
        evidence_by_vertex: tunnelCoordinates.map((coordinate) =>
          coordinate[2] === null ? "none" : "planning-verified")
      },
      geometry: {
        type: "LineString",
        coordinates: tunnelCoordinates
      }
    }, {
      type: "Feature",
      properties: {
        ...properties,
        id: "planning:elevated-coaster",
        ride_name: "Elevated Coaster"
      },
      geometry: {
        type: "LineString",
        coordinates: track.geometry.slice(0, -1).map((point) => [point.lon, point.lat + 0.00015, 12])
      }
    }]
  }));
  const result = await buildPark({
    parkName: "Ride Structures Fixture Park",
    planningWorldAuthority: "fixture",
    osm: osmPath,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    rideProfile: [profilePath],
    rideProfileMode: "profile",
    rideTerrainMode: "inferred",
    rideSupportSpacingM: 6,
    out: directory,
    maxCells: 200_000,
    noAddon: true
  });
  const evidence = JSON.parse(await readFile(result.paths.evidence, "utf8"));
  const stats = evidence.compilation.meta.verticalStats;
  assert.equal(stats.rideExplicitTunnelFeatures, 1);
  assert.ok(stats.rideTunnelTrackBlocks > 0);
  assert.ok(stats.rideTunnelInferredTrackBlocks > 0);
  assert.ok(stats.rideTunnelExcavatedBlocks > 0);
  assert.ok(stats.rideTunnelLiningBlocks > 0);
  assert.ok(stats.rideTunnelPortalFrames >= 2);
  assert.ok(stats.rideSupportFrames > 0);
  assert.ok(stats.rideSupportBlocks > 0);
  const tunnelEvidence = stats.rideStructureEvidence.find((entry) => entry.featureId === "planning:tunnel-coaster");
  assert.deepEqual(tunnelEvidence.tunnelSemantics.inheritedFrom, ["osm:way:104"]);
  const geojson = JSON.parse(await readFile(result.paths.geojson, "utf8"));
  const tunnelFeature = geojson.features.find((feature) => feature.properties.id === "planning:tunnel-coaster");
  assert.equal(tunnelFeature.properties._ride_profile.planSemantics.alignment.status, "aligned-within-1m");
  const manifest = JSON.parse(await readFile(result.paths.worldManifest, "utf8"));
  assert.ok(manifest.rideOutput.tunnelExcavatedBlocks > 0);
  assert.ok(manifest.rideOutput.supportFrames > 0);
  const palette = JSON.parse(await readFile(result.paths.blockPalette, "utf8"));
  for (const block of ["minecraft:air", "minecraft:tuff", "minecraft:stone_bricks", "minecraft:iron_bars"]) {
    assert.ok(palette.emittedBlocks.includes(block));
  }
});

test("preserves explicit null gaps in a portable partial ride profile", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "themepark-map-profile-gap-"));
  const source = JSON.parse(await readFile(fixture, "utf8"));
  const track = source.elements.find((element) => element.tags?.roller_coaster === "track");
  const profilePath = path.join(directory, "partial-profile.geojson");
  const coordinates = track.geometry.map((point, index) => [point.lon, point.lat, index === 2 ? null : 100 + index]);
  await writeFile(profilePath, JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        id: "portable:partial-coaster",
        replaces: "osm:way:104",
        ride_name: "Evidence Coaster",
        kind: "ride_track",
        evidence: "lidar-derived",
        evidence_by_vertex: coordinates.map((coordinate) => coordinate[2] === null ? "none" : "lidar-derived"),
        allow_gaps: true,
        elevation_datum: "ODN",
        source_name: "Open point-cloud derivative",
        license: "Open test licence",
        checked_at: "2026-08-02T00:00:00Z"
      },
      geometry: { type: "LineString", coordinates }
    }]
  }));
  const result = await buildPark({
    parkName: "Fixture Park",
    planningWorldAuthority: "fixture",
    osm: fixture,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    rideProfile: [profilePath],
    rideProfileMode: "profile",
    out: directory,
    maxCells: 200_000,
    noWorld: true,
    noAddon: true
  });
  const profiles = JSON.parse(await readFile(result.paths.rideProfiles, "utf8"));
  assert.ok(profiles.totals.verticalCoverage > 0);
  assert.ok(profiles.totals.verticalCoverage < 1);
  assert.ok(profiles.rides.find((ride) => ride.name === "Evidence Coaster").evidenceCounts.none > 0);
});

test("strict mode writes evidence but refuses misleading Minecraft outputs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "themepark-map-strict-"));
  await assert.rejects(() => buildPark({
    parkName: "Fixture Park",
    planningWorldAuthority: "fixture",
    osm: fixture,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    out: directory,
    maxCells: 200_000,
    strict: true
  }), /Strict evidence gate failed/);
  const evidence = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(directory, "evidence.json"), "utf8"));
  assert.match(evidence, /RIDE_VERTICAL_GEOMETRY_ABSENT/);
});
