#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { unzipSync } from "fflate";
import proj4 from "proj4";

const options = parseArgs(process.argv.slice(2));
if (!options.index) fail("--index FILE is required");
if (!options.bbox && !options.bngBbox) fail("--bbox S,W,N,E or --bng-bbox MIN_E,MIN_N,MAX_E,MAX_N is required");

const filename = path.resolve(options.index);
const bytes = await readFile(filename);
const archive = unzipSync(new Uint8Array(bytes));
const queryBounds = options.bngBbox ? parseBounds(options.bngBbox, "--bng-bbox") : projectWgs84Bounds(options.bbox);
const matches = [];
let indexFilesScanned = 0;
let featuresScanned = 0;

for (const [entryName, content] of Object.entries(archive)) {
  if (!/\.geojson$/i.test(entryName)) continue;
  indexFilesScanned += 1;
  const collection = JSON.parse(Buffer.from(content).toString("utf8"));
  for (const feature of collection.features || []) {
    featuresScanned += 1;
    const bounds = geometryBounds(feature.geometry);
    if (!bounds || !intersects(bounds, queryBounds)) continue;
    const properties = feature.properties || {};
    matches.push({
      index: entryName,
      filename: properties.filename || null,
      captureStart: properties.sd_flown || null,
      captureEnd: properties.ed_flown || null,
      year: properties.year || null,
      resolutionM: numeric(properties.resolution),
      bands: properties.bands || null,
      type: properties.type || null,
      osReference: properties.os_ref || null,
      processedRelativePath: properties.processed_relative_path || null,
      bounds
    });
  }
}

matches.sort((a, b) => (a.resolutionM ?? Infinity) - (b.resolutionM ?? Infinity) ||
  String(b.captureEnd || b.year || "").localeCompare(String(a.captureEnd || a.year || "")));

const result = {
  schemaVersion: 1,
  dataset: "Environment Agency Vertical Aerial Photography metadata index",
  datasetUrl: "https://www.data.gov.uk/dataset/4921f8a1-d47e-458b-873b-2a489b1c8165/vertical-aerial-photography",
  checkedAt: new Date().toISOString(),
  index: {
    file: path.basename(filename),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    geojsonFilesScanned: indexFilesScanned,
    featuresScanned
  },
  query: {
    wgs84Bbox: options.bbox ? options.bbox.split(",").map(Number) : null,
    bngBounds: queryBounds,
    intersectionRule: "feature bounding box intersects requested BNG bounds"
  },
  coverageFound: matches.length > 0,
  matchingTiles: matches.length,
  matches,
  limitation: "This checks the supplied catalogue snapshot only. Confirm capture date, licence, source availability, alignment, and visible obstruction before compiling imagery evidence."
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function projectWgs84Bounds(value) {
  const [south, west, north, east] = parseBounds(value, "--bbox");
  if (!(south < north && west < east)) fail("--bbox must be SOUTH,WEST,NORTH,EAST with increasing bounds");
  proj4.defs("EPSG:27700", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs +type=crs");
  const transform = proj4("EPSG:4326", "EPSG:27700");
  const points = [[west, south], [west, north], [east, south], [east, north]].map((point) => transform.forward(point));
  return [
    Math.floor(Math.min(...points.map((point) => point[0]))),
    Math.floor(Math.min(...points.map((point) => point[1]))),
    Math.ceil(Math.max(...points.map((point) => point[0]))),
    Math.ceil(Math.max(...points.map((point) => point[1])))
  ];
}

function geometryBounds(geometry) {
  if (!geometry?.coordinates) return null;
  const points = [];
  visit(geometry.coordinates);
  if (!points.length) return null;
  return [
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1]))
  ];

  function visit(value) {
    if (Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      points.push(value);
      return;
    }
    if (Array.isArray(value)) for (const child of value) visit(child);
  }
}

function intersects(first, second) {
  return first[0] <= second[2] && first[2] >= second[0] && first[1] <= second[3] && first[3] >= second[1];
}

function parseBounds(value, flag) {
  const parts = String(value).split(",").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) fail(`${flag} requires four comma-separated numbers`);
  return parts;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "").replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    const value = values[index + 1];
    if (!key || value === undefined) fail("arguments must be --key value pairs");
    result[key] = value;
  }
  return result;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
