import test from "node:test";
import assert from "node:assert/strict";
import { classifyAerialPatch, terrainStyleForAerialClass } from "../src/lib/aerial-appearance.mjs";
import { deriveSurfaceStyle, blockForSurfaceStyle, enrichUniversalFidelity } from "../src/lib/fidelity.mjs";
import { normalizeMap } from "../src/lib/osm.mjs";
import { compileMap } from "../src/lib/raster.mjs";
import { parseArgs } from "../src/lib/args.mjs";


test("numeric density flags normalize into runtime option keys", () => {
  const { options } = parseArgs([
    "build",
    "--tree-density-per-100m2", "2.8",
    "--shrub-density-per-100m2", "16",
    "--terrain-rock-density-per-100m2", "1.5"
  ]);
  assert.equal(options.treeDensityPer100m2, 2.8);
  assert.equal(options.shrubDensityPer100m2, 16);
  assert.equal(options.terrainRockDensityPer100m2, 1.5);
});

test("path palette uses colour-matched material blocks and repeatable patterning", () => {
  const feature = {
    id: "path:test",
    kind: "path",
    tags: {
      surface: "paving_stones",
      "surface:colour": "#a76f50",
      "surface:pattern": "herringbone"
    },
    source: { provider: "test" }
  };
  const style = deriveSurfaceStyle(feature, { accuracyMode: "verified" });
  assert.equal(style.material, "paving_stones");
  assert.equal(style.pattern, "herringbone");
  assert.equal(style.paletteBlocks.length, 3);
  assert.notEqual(style.primaryBlock, "minecraft:orange_concrete");
  const produced = new Set();
  for (let z = 0; z < 24; z += 1) {
    for (let x = 0; x < 24; x += 1) produced.add(blockForSurfaceStyle(style, x, z, 42));
  }
  assert.ok(produced.size >= 2);
  assert.ok([...produced].every((block) => style.paletteBlocks.includes(block)));
});

test("aerial appearance separates canopy, soil, and textured neutral ground", () => {
  const canopy = classifyAerialPatch(Array.from({ length: 9 }, (_, i) => [40 + i * 2, 105 + (i % 3) * 12, 35 + i]));
  assert.ok(["dense-tree-canopy", "vegetation"].includes(canopy.class));
  assert.ok(terrainStyleForAerialClass(canopy));

  const soil = classifyAerialPatch(Array.from({ length: 9 }, (_, i) => [130 + i, 88 + (i % 2) * 4, 54 + (i % 3) * 3]));
  assert.equal(soil.class, "soil-mulch");
  assert.ok(terrainStyleForAerialClass(soil));

  const gravel = classifyAerialPatch([
    [90, 91, 91], [140, 136, 132], [105, 108, 109], [155, 151, 148], [112, 109, 111],
    [145, 141, 142], [98, 101, 99], [160, 157, 153], [118, 116, 119]
  ]);
  assert.equal(gravel.class, "rock-gravel");
});

test("woodland, scrub, and hedge source features compile as dense vegetation evidence", async () => {
  const elements = [
    way(1, square(-0.001, 51, 0.001, 51.002), { tourism: "theme_park", name: "Test Park" }),
    way(2, square(-0.0008, 51.0002, -0.0001, 51.0012), { landuse: "forest", name: "Woodland" }),
    way(3, square(0.0001, 51.0003, 0.00065, 51.00085), { natural: "scrub", name: "Scrub" }),
    way(4, [[-0.0007, 51.00135], [0.0007, 51.00135]], { barrier: "hedge", height: "2" }),
    way(5, [[-0.00075, 51.00095], [0.00075, 51.00095]], { highway: "footway", width: "3", surface: "asphalt", "surface:colour": "#4a4b4d" })
  ];
  const sources = {
    parkName: "Test Park",
    center: { lon: 0, lat: 51.001 },
    bbox: { south: 51, west: -0.001, north: 51.002, east: 0.001 },
    suppliedBoundary: null,
    osm: { data: { elements }, source: "fixture" },
    elevation: { provider: "none", points: [], minM: 0 }
  };
  const map = await normalizeMap(sources, {});
  const vegetation = map.features.filter((feature) => feature.kind === "vegetation");
  assert.deepEqual(new Set(vegetation.map((feature) => feature.subtype)), new Set(["forest", "scrub", "hedge"]));

  enrichUniversalFidelity(map, sources, {
    accuracyMode: "plausible",
    treeDensityPer100m2: 2.4,
    shrubDensityPer100m2: 14,
    vegetationMinSpacingM: 4,
    maxVegetationModels: 500
  });
  const compilation = compileMap({
    parkName: "Test Park",
    map,
    sources,
    accuracy: { score: 0.5, grade: "D", exact3d: false },
    options: {
      scale: 1,
      maxCells: 100_000,
      accuracyMode: "plausible",
      buildings: "markers",
      treeDensityPer100m2: 2.4,
      shrubDensityPer100m2: 14,
      vegetationMinSpacingM: 4,
      maxVegetationModels: 500,
      aerialTerrainMode: "off",
      noRideInfoSigns: true
    }
  });
  assert.ok(compilation.meta.verticalStats.treeModels > 0);
  assert.ok(compilation.meta.verticalStats.shrubModels > 0);
  assert.ok(compilation.meta.verticalStats.hedgeBlocks > 0);
  assert.ok(compilation.meta.verticalStats.vegetationDensityDerivedModels > 0);
});

test("mapped polygon tree canopies derive crown diameter from net area", () => {
  const feature = {
    id: "canopy:with-hole",
    kind: "vegetation",
    subtype: "tree_canopy",
    tags: {},
    localGeometry: {
      type: "Polygon",
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
      ]
    },
    source: { provider: "fixture-canopy" }
  };
  const map = { features: [feature] };
  enrichUniversalFidelity(map, {}, { accuracyMode: "verified" });
  assert.equal(feature.fidelity.tree.modelClass, "tree");
  assert.equal(feature.fidelity.tree.crownSource, "mapped-canopy-equivalent-diameter");
  assert.equal(feature.fidelity.tree.crownDiameterM, 11.1);
});

function way(id, coordinates, tags) {
  return {
    type: "way",
    id,
    tags,
    geometry: coordinates.map(([lon, lat]) => ({ lon, lat }))
  };
}

function square(west, south, east, north) {
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}

test("rights-cleared aerial canopy fills unmapped tree-cover gaps", async () => {
  const elements = [
    way(21, square(-0.0004, 51, 0.0004, 51.0007), { tourism: "theme_park", name: "Canopy Park" })
  ];
  const sources = {
    parkName: "Canopy Park",
    center: { lon: 0, lat: 51.00035 },
    bbox: { south: 51, west: -0.0004, north: 51.0007, east: 0.0004 },
    suppliedBoundary: null,
    osm: { data: { elements }, source: "fixture" },
    elevation: { provider: "none", points: [], minM: 0 }
  };
  const map = await normalizeMap(sources, {});
  map.orthophoto = {
    landCover: { compilationEligible: true }
  };
  Object.defineProperty(map.orthophoto, "sampleTerrainLocal", {
    enumerable: false,
    value() {
      return {
        class: "dense-tree-canopy", confidence: 0.96, rgb: [52, 112, 43],
        hex: "#34702b", compilationEligible: true
      };
    }
  });
  const compilation = compileMap({
    parkName: "Canopy Park",
    map,
    sources,
    accuracy: { score: 0.5, grade: "D", exact3d: false },
    options: {
      scale: 1,
      maxCells: 100_000,
      accuracyMode: "plausible",
      buildings: "markers",
      treeDensityPer100m2: 4,
      vegetationMinSpacingM: 4,
      maxVegetationModels: 100,
      aerialTerrainMode: "evidence",
      aerialTerrainMinConfidence: 0.7,
      noRideInfoSigns: true
    }
  });
  assert.equal(compilation.meta.aerialTerrainOutput.status, "applied");
  assert.ok(compilation.meta.verticalStats.aerialCanopyModels > 0);
  assert.equal(compilation.meta.verticalStats.treeModels, compilation.meta.verticalStats.aerialCanopyModels);
});
