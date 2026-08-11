#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { writeArrayBuffer } from "geotiff";
import { buildPark } from "../src/lib/pipeline.mjs";

const outputDir = path.resolve(process.argv[2] || "out/orthophoto-path-demo-v0100");
await mkdir(outputDir, { recursive: true });

const source = JSON.parse(await readFile(path.resolve("test/fixtures/mini-park.overpass.json"), "utf8"));
const avenue = source.elements.find((element) => element.id === 101);
if (!avenue) throw new Error("Synthetic fixture route 101 is missing");
delete avenue.tags.width;
delete avenue.tags.surface;
delete avenue.tags["surface:colour"];
delete avenue.tags["surface:pattern"];

const osmPath = path.join(outputDir, "synthetic-park.overpass.json");
await writeFile(osmPath, `${JSON.stringify(source, null, 2)}\n`);

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
    const visiblePath = mainPath || unmappedBranch;
    const rgb = visiblePath ? [58, 60, 62] : [65, 132, 54];
    const index = (row * width + column) * 3;
    pixels[index] = rgb[0];
    pixels[index + 1] = rgb[1];
    pixels[index + 2] = rgb[2];
  }
}

const orthophotoPath = path.join(outputDir, "synthetic-park-rgb-050m.tif");
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
  parkName: "Orthophoto Path Evidence Demo",
  osm: osmPath,
  bbox: "51.0000,-0.0020,51.0020,0.0020",
  elevation: "none",
  orthophoto: [orthophotoPath],
  orthophotoMode: "evidence",
  orthophotoSource: "Voxel Mapping Tool synthetic regression imagery",
  orthophotoLicense: "CC0-1.0",
  orthophotoDate: "2026-07-01",
  orthophotoMaxGsdM: 0.75,
  orthophotoMinConfidence: 0.6,
  pathDiscoveryMode: "evidence",
  pathDiscoveryMinConfidence: 0.68,
  out: outputDir,
  maxCells: 200_000,
  accuracyMode: "verified",
  noAddon: true
}, (message) => process.stderr.write(`• ${message}\n`));

await writeFile(path.join(outputDir, "demo-result.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
