#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openMcworld } from "@taku128/mcworld-browser";
import { parseSubChunk } from "@taku128/core";
import { unzipSync } from "fflate";
import { entryContentTypeToFormatMap, generateChunkKeyFromIndices } from "mcbe-leveldb";

const options = parseArgs(process.argv.slice(2));
for (const required of ["world", "manifest", "labels", "geojson", "out"]) {
  assert.ok(options[required], `--${required} is required`);
}

const [worldBytes, manifest, labelIndex, geojson] = await Promise.all([
  readFile(path.resolve(options.world)),
  readJson(options.manifest),
  readJson(options.labels),
  readJson(options.geojson)
]);
const archive = unzipSync(new Uint8Array(worldBytes));
for (const required of ["level.dat", "levelname.txt", "db/CURRENT"]) {
  assert.ok(archive[required], `finished .mcworld is missing ${required}`);
}
const levelDat = await entryContentTypeToFormatMap.LevelDat.parse(Buffer.from(archive["level.dat"]));
assert.equal(levelDat.value.LevelName.value, manifest.parkName);

const world = openMcworld(new Uint8Array(worldBytes));
const overworld = world.scan.dimensions.get(0);
assert.ok(overworld, "independent reader found no overworld");
assert.equal(overworld.chunks.size, manifest.chunks);

const paletteNames = new Set();
const signEntities = [];
let subchunksScanned = 0;
let blockEntityRecords = 0;
for (const entry of world.reader.iterate({ values: true })) {
  const key = entry.key;
  if (key.length === 10 && key[8] === 0x2f) {
    const parsed = parseSubChunk(entry.value);
    assert.ok(parsed, "independent reader could not parse a current-format subchunk");
    subchunksScanned += 1;
    for (const block of parsed.palette) paletteNames.add(block.name);
  } else if (key.length === 9 && key[8] === 0x31) {
    blockEntityRecords += 1;
    const parsed = await entryContentTypeToFormatMap.BlockEntity.parse(Buffer.from(entry.value));
    for (const entity of parsed.value.blockEntities.value.value) {
      if (entity.id?.value === "Sign") signEntities.push(entity);
    }
  }
}

assert.ok(["markers", "shells"].includes(labelIndex.mode), "unknown building output mode");
assert.equal(labelIndex.mode, manifest.buildingOutput.mode);
assert.equal(labelIndex.count, manifest.buildingOutput.namedSigns);
assert.equal(signEntities.length, manifest.validation.signLabels.expected);
const sourceNames = new Map(geojson.features.map((feature) => [
  feature.properties?.id,
  feature.properties?.name || null
]));
const entitiesByCoordinate = new Map(signEntities.map((entity) => [
  coordinateKey(entity.x.value, entity.y.value, entity.z.value),
  entity
]));
const blockCache = new Map();
const labelCoordinates = new Set();
let blocksVerified = 0;
let sourceNamesVerified = 0;
for (const label of labelIndex.labels) {
  const { x, y, z } = label.coordinates;
  const coordinate = coordinateKey(x, y, z);
  assert.ok(!labelCoordinates.has(coordinate), `duplicate sign coordinate ${coordinate}`);
  labelCoordinates.add(coordinate);
  assert.equal(sourceNames.get(label.featureId), label.name, `label does not match public source ${label.featureId}`);
  sourceNamesVerified += 1;

  const lines = label.displayedText.split("\n");
  assert.ok(lines.length <= 4, `${label.name} uses more than four sign lines`);
  assert.ok(lines.every((line) => Array.from(line).length <= 20), `${label.name} has an overlong sign line`);
  const entity = entitiesByCoordinate.get(coordinate);
  assert.ok(entity, `no native Sign entity at ${coordinate}`);
  assert.equal(entity.FrontText.value.Text.value, label.displayedText);
  assert.equal(entity.BackText.value.Text.value, label.displayedText);
  assert.equal(entity.IsWaxed.value, 1);

  const chunkX = floorDiv(x, 16), chunkZ = floorDiv(z, 16), subChunkIndex = floorDiv(y, 16);
  const subchunkKey = `${chunkX},${subChunkIndex},${chunkZ}`;
  let parsed = blockCache.get(subchunkKey);
  if (!parsed) {
    const raw = world.reader.get(generateChunkKeyFromIndices(
      { x: chunkX, z: chunkZ, dimension: "overworld", subChunkIndex },
      "SubChunkPrefix"
    ));
    assert.ok(raw, `missing sign subchunk ${subchunkKey}`);
    parsed = parseSubChunk(raw);
    assert.ok(parsed, `could not decode sign subchunk ${subchunkKey}`);
    blockCache.set(subchunkKey, parsed);
  }
  const localX = floorMod(x, 16), localY = floorMod(y, 16), localZ = floorMod(z, 16);
  const offset = localY + localZ * 16 + localX * 256;
  const block = parsed.palette[parsed.blocks[offset]];
  assert.equal(block.name, "minecraft:standing_sign", `sign entity at ${coordinate} has no sign block`);
  assert.equal(block.properties.ground_sign_direction, 8);
  blocksVerified += 1;
}

const forbiddenShellMaterials = ["minecraft:deepslate_tiles", "minecraft:cracked_deepslate_tiles"];
if (labelIndex.mode === "markers") {
  for (const forbidden of forbiddenShellMaterials) {
    assert.ok(!paletteNames.has(forbidden), `3D shell material leaked into marker world: ${forbidden}`);
  }
}
for (const required of ["minecraft:standing_sign", "minecraft:yellow_concrete"]) {
  assert.ok(paletteNames.has(required), `world is missing ${required}`);
}
const rideOutput = manifest.rideOutput || {};
assert.equal(rideOutput.representation, "one-block-centreline",
  "ride output must use the one-block centreline contract");
assert.equal(rideOutput.trackWidthBlocks, 1, "ride track output must be one block wide");
assert.equal(rideOutput.bankingRendered, false, "ride output must not render banking");
assert.equal(rideOutput.crossTiesRendered, false, "ride output must not render cross ties");
assert.equal((rideOutput.attachmentsRendered || 0) + (rideOutput.attachmentsWithheld || 0),
  rideOutput.attachmentFeatures || 0, "ride attachment accounting is inconsistent");
if (rideOutput.attachmentsRendered) {
  assert.ok(rideOutput.attachmentBlocks > 0, "rendered ride attachments have no emitted blocks");
}
assert.ok((rideOutput.tunnelTrackBlocks || 0) >= (rideOutput.inferredTunnelTrackBlocks || 0),
  "inferred tunnel blocks exceed total tunnel blocks");
if (rideOutput.tunnelExcavatedBlocks) {
  for (const required of ["minecraft:air", "minecraft:tuff", "minecraft:stone_bricks"]) {
    assert.ok(paletteNames.has(required), `terrain-aware tunnel output is missing ${required}`);
  }
  assert.ok(rideOutput.tunnelLiningBlocks > 0, "excavated tunnel has no lining blocks");
  assert.ok(rideOutput.tunnelPortalFrames > 0, "excavated tunnel has no portal frames");
}
if (rideOutput.supportFrames) {
  assert.ok(paletteNames.has("minecraft:iron_bars"), "ride support output is missing iron bars");
  assert.ok(rideOutput.supportBlocks > 0, "ride support frames have no emitted blocks");
  assert.ok(rideOutput.supportFootings > 0, "ride support frames have no emitted footings");
}

const informationSigns = signEntities.filter((entity) => !labelCoordinates.has(coordinateKey(
  entity.x.value, entity.y.value, entity.z.value
)));
const informationTexts = informationSigns.map((entity) => entity.FrontText.value.Text.value);
assert.equal(informationSigns.length,
  manifest.signPlacement.mapEvidenceBoards + manifest.signPlacement.rideEvidenceBoards);
for (const title of ["VOXEL MAPPING TOOL", "TRACK COLOURS", "MORE TRACK COLOURS", "PATH SURFACES", "TERRAIN DETAIL", "RIDE GEOMETRY", "NOT LIVE PARK INFO"]) {
  assert.ok(informationTexts.some((text) => text.startsWith(title)), `missing player evidence board: ${title}`);
}
const rideInformationTexts = informationTexts.filter((text) => ![
  "VOXEL MAPPING TOOL", "TRACK COLOURS", "MORE TRACK COLOURS", "PATH SURFACES", "TERRAIN DETAIL", "RIDE GEOMETRY", "NOT LIVE PARK INFO"
].some((title) => text.startsWith(title)));
const datedRideSigns = rideInformationTexts.filter((text) => /\bSrc:\d{4}\b/.test(text));
const malformedSourceDates = rideInformationTexts.filter((text) => text.includes("Src:") &&
  !/\bSrc:\d{4}\b/.test(text));
assert.equal(malformedSourceDates.length, 0,
  "ride signs with a source date must expose it as a four-digit year");

const sha256 = createHash("sha256").update(worldBytes).digest("hex");
assert.equal(sha256, manifest.archiveSha256);
const report = {
  schemaVersion: 1,
  validatedAt: new Date().toISOString(),
  validator: "independent pure-JavaScript LevelDB/subchunk scan",
  status: "passed",
  world: {
    filename: path.basename(options.world),
    bytes: worldBytes.length,
    sha256,
    levelName: levelDat.value.LevelName.value,
    chunksExpected: manifest.chunks,
    chunksDecoded: overworld.chunks.size,
    subchunksScanned,
    paletteNames: [...paletteNames].sort()
  },
  buildingOutput: manifest.buildingOutput,
  signs: {
    expected: manifest.validation.signLabels.expected,
    buildingLabelsExpected: labelIndex.count,
    nativeBlockEntitiesDecoded: signEntities.length,
    nativeBlocksVerified: blocksVerified,
    publicSourceNamesMatched: sourceNamesVerified,
    uniqueCoordinates: labelCoordinates.size,
    blockEntityRecords,
    twoSided: true,
    waxed: true,
    lineLimit: { maxLines: 4, maxCharactersPerLine: 20 }
  },
  playerInformation: {
    mapEvidenceBoards: manifest.signPlacement.mapEvidenceBoards,
    rideEvidenceBoards: manifest.signPlacement.rideEvidenceBoards,
    sourceDatedRideSigns: datedRideSigns.length,
    undatedRideSigns: rideInformationTexts.length - datedRideSigns.length,
    requiredBoardTitles: ["VOXEL MAPPING TOOL", "TRACK COLOURS", "MORE TRACK COLOURS", "PATH SURFACES", "TERRAIN DETAIL", "RIDE GEOMETRY", "NOT LIVE PARK INFO"],
    status: "passed"
  },
  rideStructures: {
    representation: rideOutput.representation,
    trackWidthBlocks: rideOutput.trackWidthBlocks,
    bankingRendered: rideOutput.bankingRendered,
    crossTiesRendered: rideOutput.crossTiesRendered,
    attachmentFeatures: rideOutput.attachmentFeatures || 0,
    attachmentsRendered: rideOutput.attachmentsRendered || 0,
    attachmentsWithheld: rideOutput.attachmentsWithheld || 0,
    attachmentBlocks: rideOutput.attachmentBlocks || 0,
    terrainMode: rideOutput.terrainMode || "off",
    explicitTunnelFeatures: rideOutput.explicitTunnelFeatures || 0,
    terrainDetectedTunnelFeatures: rideOutput.terrainDetectedTunnelFeatures || 0,
    tunnelTrackBlocks: rideOutput.tunnelTrackBlocks || 0,
    inferredTunnelTrackBlocks: rideOutput.inferredTunnelTrackBlocks || 0,
    tunnelExcavatedBlocks: rideOutput.tunnelExcavatedBlocks || 0,
    tunnelLiningBlocks: rideOutput.tunnelLiningBlocks || 0,
    tunnelPortalFrames: rideOutput.tunnelPortalFrames || 0,
    supportFrames: rideOutput.supportFrames || 0,
    supportBlocks: rideOutput.supportBlocks || 0,
    supportFootings: rideOutput.supportFootings || 0,
    paletteEvidenceVerified: true,
    status: "passed"
  },
  shellMaterialCheck: {
    mode: labelIndex.mode,
    forbiddenFound: labelIndex.mode === "markers"
      ? forbiddenShellMaterials.filter((block) => paletteNames.has(block))
      : [],
    status: labelIndex.mode === "markers" ? "passed" : "not-applicable-shell-mode"
  },
  archiveEntries: Object.keys(archive).length
};
await writeFile(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`);
if (options.markdown) await writeFile(path.resolve(options.markdown), markdownReport(report));
console.log(JSON.stringify(report, null, 2));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    assert.ok(key && value, "arguments must be --key value pairs");
    result[key] = value;
  }
  return result;
}

async function readJson(filename) {
  return JSON.parse(await readFile(path.resolve(filename), "utf8"));
}

function markdownReport(report) {
  return `# ${report.world.levelName} world validation

Status: **PASSED**

- SHA-256: \`${report.world.sha256}\`
- Finished chunks decoded: ${report.world.chunksDecoded.toLocaleString()} / ${report.world.chunksExpected.toLocaleString()}
- Subchunks independently scanned: ${report.world.subchunksScanned.toLocaleString()}
- Marked polygonal footprints: ${report.buildingOutput.markedFootprints.toLocaleString()}
- Point-mapped building/structure markers: ${report.buildingOutput.pointMarkers.toLocaleString()}
- All named/information signs: ${report.signs.nativeBlockEntitiesDecoded} / ${report.signs.expected}
- Building labels matched to public source IDs: ${report.signs.publicSourceNamesMatched} / ${report.signs.buildingLabelsExpected}
- Sign blocks verified at the same coordinates: ${report.signs.nativeBlocksVerified}
- Names matched to normalized public-source features: ${report.signs.publicSourceNamesMatched}
- Sign text: two-sided, waxed, at most four lines of 20 characters
- Player evidence boards: ${report.playerInformation.mapEvidenceBoards}; ride evidence signs: ${report.playerInformation.rideEvidenceBoards}
- Ride signs exposing the 2022 LiDAR source year: ${report.playerInformation.sourceDatedRideSigns}
- Ride tunnel track/excavation/lining blocks: ${report.rideStructures.tunnelTrackBlocks.toLocaleString()} / ${report.rideStructures.tunnelExcavatedBlocks.toLocaleString()} / ${report.rideStructures.tunnelLiningBlocks.toLocaleString()}
- Ride tunnel portal frames: ${report.rideStructures.tunnelPortalFrames.toLocaleString()}
- DTM-grounded ride support frames/blocks: ${report.rideStructures.supportFrames.toLocaleString()} / ${report.rideStructures.supportBlocks.toLocaleString()}
- Tunnel/support palette evidence: verified
- Building output mode: ${report.buildingOutput.mode}
- Marker-only shell palette check: ${report.shellMaterialCheck.status}

This validation opened the finished \`.mcworld\` with a pure-JavaScript LevelDB reader, scanned current-format subchunks, decoded every native Sign block entity, checked each indexed building label's standing-sign block, and compared every full building label with its source GeoJSON feature ID. Map and ride evidence signs are counted and round-trip checked by the world compiler manifest. Terrain-aware tunnel and support outputs are checked against the independently decoded block palette and their manifest invariants.
`;
}

function coordinateKey(x, y, z) { return `${x},${y},${z}`; }
function floorDiv(value, divisor) { return Math.floor(value / divisor); }
function floorMod(value, divisor) { return ((value % divisor) + divisor) % divisor; }
