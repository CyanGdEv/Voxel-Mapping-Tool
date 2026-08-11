import path from "node:path";
import { buildPark } from "../src/lib/pipeline.mjs";

const output = path.resolve(process.argv[2] || "out/terrain-detail-source-fusion-demo-v0110");
const result = await buildPark({
  parkName: "Terrain Detail Source Fusion Demo",
  osm: path.resolve("test/fixtures/mini-park.overpass.json"),
  bbox: "51.0000,-0.0020,51.0020,0.0020",
  overture: [path.resolve("test/fixtures/overture-gap.geojson")],
  publicData: [path.resolve("examples/public-terrain-observations.geojson")],
  sourceFusionToleranceM: 3,
  elevation: "none",
  terrainDetailMode: "plausible",
  terrainRockDensityPer100m2: 1.5,
  terrainRockMinSpacingM: 3,
  terrainCliffMarkerSpacingM: 2,
  maxTerrainRocks: 250,
  accuracyMode: "verified",
  buildings: "markers",
  maxCells: 200_000,
  noAddon: true,
  out: output
}, (message) => console.error(`• ${message}`));

console.log(JSON.stringify(result, null, 2));
