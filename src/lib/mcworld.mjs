import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { LevelDB } from "@8crafter/leveldb-zlib";
import { unzipSync, zipSync } from "fflate";
import {
  entryContentTypeToFormatMap,
  generateChunkKeyFromIndices,
  offsetToChunkBlockIndex,
  writeData3DValue
} from "mcbe-leveldb";
import { UserError, invariant } from "./errors.mjs";
import { ensureDir, writeJson, writeText } from "./io.mjs";

const AIR = "minecraft:air";
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 319;
const DEFAULT_BLOCK_DATA_VERSION = 18_168_865; // Bedrock 1.21.60.33; upgraded safely by newer clients.
const DEFAULT_CHUNK_VERSION = 42; // Bedrock 1.21.120 chunk storage.
const BEDROCK_BLOCKS = new Set([
  "minecraft:air", "minecraft:andesite", "minecraft:bedrock", "minecraft:black_concrete",
  "minecraft:blue_concrete", "minecraft:brick_block", "minecraft:brown_concrete",
  "minecraft:coarse_dirt", "minecraft:cobblestone",
  "minecraft:cyan_concrete",
  "minecraft:cracked_deepslate_tiles", "minecraft:cracked_stone_bricks", "minecraft:dark_oak_planks",
  "minecraft:deepslate_tiles", "minecraft:dirt", "minecraft:dirt_with_roots", "minecraft:emerald_block",
  "minecraft:glass", "minecraft:gold_block", "minecraft:granite", "minecraft:grass_block",
  "minecraft:gray_concrete",
  "minecraft:gravel", "minecraft:green_concrete", "minecraft:iron_bars", "minecraft:iron_block",
  "minecraft:light_gray_concrete", "minecraft:lime_concrete", "minecraft:moss_block",
  "minecraft:mossy_stone_bricks", "minecraft:oak_fence", "minecraft:oak_leaves", "minecraft:oak_log",
  "minecraft:orange_concrete", "minecraft:purple_concrete", "minecraft:red_concrete",
  "minecraft:sand", "minecraft:sandstone", "minecraft:smooth_stone", "minecraft:spruce_leaves",
  "minecraft:spruce_log", "minecraft:spruce_planks",
  "minecraft:standing_sign", "minecraft:stone", "minecraft:stone_bricks", "minecraft:tuff", "minecraft:water",
  "minecraft:white_concrete", "minecraft:yellow_concrete",
  "minecraft:azalea_leaves", "minecraft:birch_leaves", "minecraft:brown_terracotta", "minecraft:calcite", "minecraft:cyan_terracotta", "minecraft:dark_oak_leaves", "minecraft:deepslate", "minecraft:gray_concrete_powder", "minecraft:light_gray_concrete_powder", "minecraft:mud_bricks", "minecraft:oak_planks", "minecraft:orange_terracotta", "minecraft:packed_mud", "minecraft:podzol", "minecraft:polished_andesite", "minecraft:red_terracotta", "minecraft:smooth_sandstone", "minecraft:yellow_terracotta",
  "minecraft:black_wool", "minecraft:gray_wool", "minecraft:light_gray_wool", "minecraft:green_wool", "minecraft:brown_wool",
  "minecraft:smooth_basalt", "minecraft:birch_planks", "minecraft:cut_sandstone", "minecraft:mossy_cobblestone",
  "minecraft:cobbled_deepslate", "minecraft:blackstone", "minecraft:terracotta", "minecraft:dripstone_block",
  "minecraft:stripped_spruce_wood", "minecraft:mangrove_planks",
  "minecraft:lime_terracotta", "minecraft:polished_granite",
  "minecraft:stone_brick_slab", "minecraft:stone_brick_stairs", "minecraft:stone_brick_wall",
  "minecraft:sandstone_slab", "minecraft:sandstone_stairs", "minecraft:sandstone_wall",
  "minecraft:brick_slab", "minecraft:brick_stairs", "minecraft:brick_wall",
  "minecraft:cobblestone_wall",
  "minecraft:oak_slab", "minecraft:oak_stairs", "minecraft:oak_trapdoor",
  "minecraft:birch_slab", "minecraft:birch_stairs", "minecraft:birch_fence", "minecraft:birch_trapdoor",
  "minecraft:spruce_slab", "minecraft:spruce_stairs", "minecraft:spruce_fence", "minecraft:spruce_trapdoor",
  "minecraft:dark_oak_slab", "minecraft:dark_oak_stairs", "minecraft:dark_oak_fence", "minecraft:dark_oak_trapdoor"
]);

export const WORLD_PALETTES = Object.freeze({
  realistic: {
    "minecraft:grass_block": [["minecraft:grass_block", 88], ["minecraft:moss_block", 7], ["minecraft:coarse_dirt", 5]],
    "minecraft:dirt": [["minecraft:dirt", 88], ["minecraft:coarse_dirt", 8], ["minecraft:dirt_with_roots", 4]],
    "minecraft:stone": [["minecraft:stone", 82], ["minecraft:andesite", 10], ["minecraft:tuff", 8]],
    "minecraft:gravel": [["minecraft:gravel", 66], ["minecraft:andesite", 17], ["minecraft:cobblestone", 12], ["minecraft:tuff", 5]],
    "minecraft:light_gray_concrete": [["minecraft:light_gray_concrete", 64], ["minecraft:smooth_stone", 24], ["minecraft:stone", 12]],
    "minecraft:moss_block": [["minecraft:moss_block", 82], ["minecraft:grass_block", 14], ["minecraft:coarse_dirt", 4]],
    "minecraft:sand": [["minecraft:sand", 90], ["minecraft:sandstone", 10]],
    "minecraft:stone_bricks": [["minecraft:stone_bricks", 84], ["minecraft:cracked_stone_bricks", 10], ["minecraft:mossy_stone_bricks", 6]],
    "minecraft:brick_block": [["minecraft:brick_block", 90], ["minecraft:granite", 10]],
    "minecraft:spruce_planks": [["minecraft:spruce_planks", 92], ["minecraft:dark_oak_planks", 8]],
    "minecraft:deepslate_tiles": [["minecraft:deepslate_tiles", 90], ["minecraft:cracked_deepslate_tiles", 10]]
  },
  clean: {}
});

/**
 * Builds a complete, importable Bedrock .mcworld whose LevelDB already contains
 * the generated park chunks. No behavior pack or in-game command pass is needed.
 */
export async function buildBedrockWorld({
  parkName,
  slug,
  compilation,
  outputDir,
  options = {},
  progress = () => {}
}) {
  const paletteProfile = options.palette || "realistic";
  if (!Object.hasOwn(WORLD_PALETTES, paletteProfile)) {
    throw new UserError(`--palette must be one of: ${Object.keys(WORLD_PALETTES).join(", ")}`);
  }

  const baseY = integerOption(options.baseY, 64, "--base-y");
  const worldMargin = integerOption(options.worldMargin, 32, "--world-margin", 0);
  const maxWorldChunks = integerOption(options.maxWorldChunks, 12_000, "--max-world-chunks", 1);
  const chunkVersion = integerOption(options.chunkVersion, DEFAULT_CHUNK_VERSION, "--chunk-version", 1, 255);
  const blockDataVersion = integerOption(options.blockDataVersion, DEFAULT_BLOCK_DATA_VERSION, "--block-data-version", 1);
  const seed = normalizeSeed(options.seed ?? hash32(parkName));
  const relativeY = compilationYBounds(compilation);
  if (baseY + relativeY.min < WORLD_MIN_Y || baseY + relativeY.max > WORLD_MAX_Y) {
    throw new UserError(
      `Generated blocks would exceed Bedrock's ${WORLD_MIN_Y}..${WORLD_MAX_Y} build range`,
      `Choose --base-y between ${WORLD_MIN_Y - relativeY.min} and ${WORLD_MAX_Y - relativeY.max}.`
    );
  }

  const bounds = worldChunkBounds(compilation, worldMargin);
  const chunkCount = (bounds.maxChunkX - bounds.minChunkX + 1) * (bounds.maxChunkZ - bounds.minChunkZ + 1);
  if (chunkCount > maxWorldChunks) {
    throw new UserError(
      `The direct world needs ${chunkCount.toLocaleString()} prebuilt chunks; the safety limit is ${maxWorldChunks.toLocaleString()}`,
      "Reduce --world-margin or deliberately raise --max-world-chunks after checking disk and memory capacity."
    );
  }

  await ensureDir(outputDir);
  const stage = await mkdtemp(path.join(outputDir, ".mcworld-stage-"));
  const databasePath = path.join(stage, "db");
  const workerCount = resolveWorldWorkerCount(options, chunkCount);
  const emittedBlocks = new Set();
  const operationChunks = new Map(compilation.chunks.map((chunk) => [`${chunk.x},${chunk.z}`, chunk]));
  const signChunks = groupSignsByChunk(compilation.signs || []);
  const spawnTarget = compilation.meta.spawnLocal || { x: 0, y: 0, z: 0 };
  let spawnTopY = baseY;
  let firstSample = null;
  let database = null;

  try {
    await ensureDir(databasePath);
    database = new LevelDB(databasePath, { createIfMissing: true, errorIfExists: false });
    await database.open();

    const jobs = [];
    for (let chunkZ = bounds.minChunkZ; chunkZ <= bounds.maxChunkZ; chunkZ += 1) {
      for (let chunkX = bounds.minChunkX; chunkX <= bounds.maxChunkX; chunkX += 1) {
        jobs.push({
          chunkX,
          chunkZ,
          operations: operationChunks.get(`${chunkX},${chunkZ}`)?.o || [],
          signs: signChunks.get(`${chunkX},${chunkZ}`) || []
        });
      }
    }
    progress(`Serializing Bedrock chunks with ${workerCount} CPU worker${workerCount === 1 ? "" : "s"}`);
    let completed = 0;
    await serializeChunksWithWorkers({
      jobs,
      workerCount,
      config: {
        baseY,
        paletteProfile,
        seed,
        blockDataVersion,
        chunkVersion,
        sourcePalette: compilation.palette,
        spawnTarget
      },
      onResult: async (job, result) => {
        await database.batch(normalizeWorkerBatch(result.dbOps));
        if (!firstSample && result.firstSubChunkIndex !== null) {
          firstSample = { chunkX: job.chunkX, chunkZ: job.chunkZ, subChunkIndex: result.firstSubChunkIndex };
        }
        if (result.spawnTopY !== null) spawnTopY = result.spawnTopY;
        for (const name of result.emittedBlocks) emittedBlocks.add(name);
        completed += 1;
        if (completed % 100 === 0 || completed === chunkCount) {
          progress(`Writing Bedrock chunks ${completed.toLocaleString()}/${chunkCount.toLocaleString()}`);
        }
      }
    });

    await database.close();
    database = null;
    invariant(firstSample, "The world compiler did not produce a serializable subchunk");

    const spawn = {
      x: Math.round(spawnTarget.x),
      y: Math.min(WORLD_MAX_Y, spawnTopY + 2),
      z: Math.round(spawnTarget.z)
    };
    const levelDat = serializeLevelDat({ parkName, spawn, seed });
    await writeFile(path.join(stage, "level.dat"), levelDat);
    await writeFile(path.join(stage, "level.dat_old"), levelDat);
    await writeText(path.join(stage, "levelname.txt"), `${parkName}\n`);
    await writeText(path.join(stage, "world_behavior_packs.json"), "[]\n");
    await writeText(path.join(stage, "world_resource_packs.json"), "[]\n");

    const validation = await validateWorldDirectory(
      stage,
      firstSample,
      chunkVersion,
      compilation.signs || [],
      baseY
    );
    const mcworldPath = path.join(outputDir, `${slug}_1to1.mcworld`);
    const archiveBytes = await zipWorld(stage);
    const archiveEntries = Object.keys(unzipSync(archiveBytes));
    for (const required of ["level.dat", "levelname.txt", "db/CURRENT"]) {
      invariant(archiveEntries.includes(required), `Generated .mcworld is missing ${required}`);
    }
    const archiveTemp = `${mcworldPath}.tmp-${process.pid}`;
    await writeFile(archiveTemp, archiveBytes);
    await rm(mcworldPath, { force: true });
    await rename(archiveTemp, mcworldPath);

    const palettePath = await writeJson(path.join(outputDir, "block-palette.json"), {
      schemaVersion: 1,
      profile: paletteProfile,
      deterministicSeed: seed,
      blockDataVersion,
      rules: WORLD_PALETTES[paletteProfile],
      emittedBlocks: [...emittedBlocks].sort()
    });
    const worldManifestPath = await writeJson(path.join(outputDir, "world-manifest.json"), {
      schemaVersion: 1,
      format: "Minecraft Bedrock .mcworld",
      parkName,
      generatedAt: new Date().toISOString(),
      scale: { horizontal: "1 block = 1 metre", vertical: "1 block = 1 metre" },
      generatorOutsidePrebuiltArea: "void",
      chunks: chunkCount,
      chunkBounds: bounds,
      baseY,
      marginBlocks: worldMargin,
      spawn,
      paletteProfile,
      chunkVersion,
      blockDataVersion,
      sourceTopology: compilation.meta.topology || null,
      explicitSemantics: compilation.meta.explicitSemantics || null,
      sourceFusion: compilation.meta.sourceFusion || null,
      signPlacement: {
        mappedEntrances: compilation.meta.verticalStats?.signsAtMappedEntrances || 0,
        nearestMappedPaths: compilation.meta.verticalStats?.signsNearMappedPaths || 0,
        mappedPoints: compilation.meta.verticalStats?.signsAtMappedPoints || 0,
        interiorFallbacks: compilation.meta.verticalStats?.signsAtInteriorFallback || 0,
        mapEvidenceBoards: compilation.meta.verticalStats?.playerInformationSigns || 0,
        rideEvidenceBoards: compilation.meta.verticalStats?.rideInformationSigns || 0
      },
      buildingOutput: {
        mode: compilation.meta.buildingMode || "shells",
        markedFootprints: compilation.meta.verticalStats?.buildingMarkerFootprints || 0,
        pointMarkers: compilation.meta.verticalStats?.pointBuildingMarkers || 0,
        unrepresentedFeatures: compilation.meta.verticalStats?.unrepresentedBuildingFeatures || 0,
        markerCells: compilation.meta.verticalStats?.buildingMarkerCells || 0,
        namedSigns: (compilation.signs || []).filter((sign) => !sign.role || sign.role === "building").length,
        unnamedMarkedFootprints: compilation.meta.verticalStats?.unnamedBuildingMarkers || 0
      },
      rideOutput: {
        profileSummary: compilation.meta.rideEvidence || null,
        evidenceLegend: compilation.meta.rideEvidenceLegend || null,
        profiledTrackFeatures: compilation.meta.verticalStats?.profiledRideTracks || 0,
        partialProfileFeatures: compilation.meta.verticalStats?.partialRideProfileTracks || 0,
        profileBlocks: compilation.meta.verticalStats?.rideProfileBlocks || 0,
        evidenceBlocks: compilation.meta.verticalStats?.rideProfileEvidenceBlocks || {},
        flatPlanBlocks: compilation.meta.verticalStats?.groundPlanRideTracks || 0,
        terrainMode: compilation.meta.verticalStats?.rideTerrainMode || "off",
        explicitTunnelFeatures: compilation.meta.verticalStats?.rideExplicitTunnelFeatures || 0,
        terrainDetectedTunnelFeatures: compilation.meta.verticalStats?.rideTerrainDetectedTunnelFeatures || 0,
        tunnelTrackBlocks: compilation.meta.verticalStats?.rideTunnelTrackBlocks || 0,
        inferredTunnelTrackBlocks: compilation.meta.verticalStats?.rideTunnelInferredTrackBlocks || 0,
        tunnelExcavatedBlocks: compilation.meta.verticalStats?.rideTunnelExcavatedBlocks || 0,
        tunnelLiningBlocks: compilation.meta.verticalStats?.rideTunnelLiningBlocks || 0,
        tunnelPortalFrames: compilation.meta.verticalStats?.rideTunnelPortalFrames || 0,
        tunnelPortalBlocks: compilation.meta.verticalStats?.rideTunnelPortalBlocks || 0,
        supportFrames: compilation.meta.verticalStats?.rideSupportFrames || 0,
        supportBlocks: compilation.meta.verticalStats?.rideSupportBlocks || 0,
        supportFootings: compilation.meta.verticalStats?.rideSupportFootings || 0,
        structureEvidence: compilation.meta.verticalStats?.rideStructureEvidence || [],
        playerRideSigns: compilation.meta.verticalStats?.rideInformationSigns || 0
      },
      fidelityOutput: {
        sourceCapabilities: compilation.meta.universalFidelity?.sourceCapabilities || null,
        pathNetwork: compilation.meta.universalFidelity?.pathNetwork || null,
        surfaces: compilation.meta.universalFidelity?.surfaces || null,
        orthophoto: compilation.meta.orthophotoEvidence || null,
        pathGeometry: compilation.meta.pathGeometryEvidence || null,
        pathTopology: compilation.meta.pathTopologyEvidence || null,
        pathTerrain: compilation.meta.pathTerrainOutput || null,
        pathEdges: compilation.meta.pathEdgeOutput || null,
        terrainDetails: {
          evidence: compilation.meta.terrainDetailEvidence || null,
          mode: compilation.meta.verticalStats?.terrainDetailMode || "off",
          rockPointFeatures: compilation.meta.verticalStats?.terrainRockPointFeatures || 0,
          dimensionedModels: compilation.meta.verticalStats?.terrainRockDimensionedModels || 0,
          positionMarkers: compilation.meta.verticalStats?.terrainRockPositionMarkers || 0,
          cliffMarkerBlocks: compilation.meta.verticalStats?.terrainCliffMarkerBlocks || 0,
          rockSurfaceFeatures: compilation.meta.verticalStats?.terrainRockSurfaceFeatures || 0,
          inferredClusters: compilation.meta.verticalStats?.terrainInferredRockClusters || 0,
          rockBlocks: compilation.meta.verticalStats?.terrainRockBlocks || 0
        },
        trees: {
          evidence: compilation.meta.universalFidelity?.trees || null,
          models: compilation.meta.verticalStats?.treeModels || 0,
          positionMarkers: compilation.meta.verticalStats?.treePositionMarkers || 0,
          trunkBlocks: compilation.meta.verticalStats?.treeTrunkBlocks || 0,
          leafBlocks: compilation.meta.verticalStats?.treeLeafBlocks || 0
        },
        bridges: {
          evidence: compilation.meta.universalFidelity?.bridges || null,
          decks: compilation.meta.verticalStats?.bridgeDeckFeatures || 0,
          planOnly: compilation.meta.verticalStats?.bridgePlanOnly || 0,
          deckBlocks: compilation.meta.verticalStats?.bridgeDeckBlocks || 0,
          railBlocks: compilation.meta.verticalStats?.bridgeRailBlocks || 0,
          supportBlocks: compilation.meta.verticalStats?.bridgeSupportBlocks || 0
        }
      },
      archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
      validation
    });

    return {
      mcworldPath,
      palettePath,
      worldManifestPath,
      chunkCount,
      spawn,
      validation,
      paletteProfile
    };
  } finally {
    if (database?.isOpen()) await database.close().catch(() => {});
    await rm(stage, { recursive: true, force: true });
  }
}


export function resolveWorldWorkerCount(options = {}, chunkCount = 1) {
  const fromEnv = Number(process.env.TPMAP_CPU_WORKERS);
  const raw = options.cpuWorkers ?? (Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : availableParallelism());
  const requested = Number.isFinite(Number(raw)) ? Math.max(1, Math.floor(Number(raw))) : 1;
  return Math.max(1, Math.min(Math.max(1, chunkCount), requested, 128));
}

export function serializeChunkJob(config, job) {
  const registry = new BlockRegistry(config.blockDataVersion);
  const volume = new ChunkVolume({
    chunkX: job.chunkX,
    chunkZ: job.chunkZ,
    baseY: config.baseY,
    registry,
    paletteProfile: config.paletteProfile,
    seed: config.seed
  });
  volume.buildFoundation();
  if (job.operations?.length) volume.applyOperations(job.operations, config.sourcePalette);
  const records = volume.serialize({ chunkVersion: config.chunkVersion, signs: job.signs || [] });
  const dbOps = chunkRecords(job.chunkX, job.chunkZ, records, config.chunkVersion).map((operation) => ({
    ...operation,
    key: new Uint8Array(operation.key),
    value: new Uint8Array(operation.value)
  }));
  return {
    dbOps,
    firstSubChunkIndex: records.subchunks.length ? records.subchunks[0].subChunkIndex : null,
    spawnTopY: containsColumn(job.chunkX, job.chunkZ, config.spawnTarget.x, config.spawnTarget.z)
      ? volume.highestBlockAt(floorMod(config.spawnTarget.x, 16), floorMod(config.spawnTarget.z, 16))
      : null,
    emittedBlocks: registry.names()
  };
}

export async function serializeChunksWithWorkers({ jobs, workerCount, config, onResult }) {
  if (!jobs.length) return;
  if (workerCount <= 1 || jobs.length === 1) {
    for (const job of jobs) await onResult(job, serializeChunkJob(config, job));
    return;
  }

  const count = Math.min(workerCount, jobs.length);
  const workers = [];
  const pending = new Map();
  let nextJob = 0;
  let nextWrite = 0;
  let flushing = false;
  let settled = false;

  await new Promise((resolve, reject) => {
    const fail = async (error) => {
      if (settled) return;
      settled = true;
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const assign = (worker) => {
      if (settled) return;
      if (nextJob >= jobs.length) return;
      const index = nextJob++;
      worker.postMessage({ type: "job", index, job: jobs[index] });
    };

    const flush = async () => {
      if (flushing || settled) return;
      flushing = true;
      try {
        while (pending.has(nextWrite)) {
          const { worker, result } = pending.get(nextWrite);
          pending.delete(nextWrite);
          await onResult(jobs[nextWrite], result);
          nextWrite += 1;
          if (nextWrite === jobs.length) {
            settled = true;
            await Promise.allSettled(workers.map((candidate) => candidate.terminate()));
            resolve();
            return;
          }
          assign(worker);
        }
      } catch (error) {
        await fail(error);
      } finally {
        flushing = false;
        if (!settled && pending.has(nextWrite)) queueMicrotask(flush);
      }
    };

    for (let index = 0; index < count; index += 1) {
      const worker = new Worker(new URL("./mcworld-chunk-worker.mjs", import.meta.url), { workerData: config });
      workers.push(worker);
      worker.on("message", (message) => {
        if (settled) return;
        if (message?.type === "error") {
          void fail(new Error(`Bedrock chunk worker failed at job ${message.index}: ${message.error}`));
          return;
        }
        if (message?.type !== "result") return;
        pending.set(message.index, { worker, result: message.result });
        void flush();
      });
      worker.on("error", (error) => void fail(error));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) void fail(new Error(`Bedrock chunk worker exited with code ${code}`));
      });
      assign(worker);
    }
  });
}

function normalizeWorkerBatch(operations) {
  return operations.map((operation) => ({
    ...operation,
    key: Buffer.from(operation.key),
    value: Buffer.from(operation.value)
  }));
}

class BlockRegistry {
  constructor(blockDataVersion) {
    this.blockDataVersion = blockDataVersion;
    this.blocks = [];
    this.indices = new Map();
    this.id(AIR);
  }

  id(specification) {
    const parsed = parseBlockSpecification(specification);
    const name = parsed.name;
    if (!BEDROCK_BLOCKS.has(name)) {
      throw new UserError(`The direct-world palette contains an unsupported Bedrock block identifier: ${specification}`);
    }
    const states = { ...defaultStates(name), ...parsed.states };
    const key = `${name}\u0000${JSON.stringify(states)}`;
    let id = this.indices.get(key);
    if (id !== undefined) return id;
    id = this.blocks.length;
    this.indices.set(key, id);
    this.blocks.push({ name, states });
    return id;
  }

  get(id) {
    return this.blocks[id];
  }

  names() {
    return [...new Set(this.blocks.map((block) => block.name))].sort();
  }

  nbt(id) {
    const block = this.get(id);
    const states = {};
    for (const [name, state] of Object.entries(block.states)) states[name] = state;
    return {
      type: "compound",
      value: {
        name: { type: "string", value: block.name },
        states: { type: "compound", value: states },
        version: { type: "int", value: this.blockDataVersion }
      }
    };
  }
}

class ChunkVolume {
  constructor({ chunkX, chunkZ, baseY, registry, paletteProfile, seed }) {
    this.chunkX = chunkX;
    this.chunkZ = chunkZ;
    this.baseY = baseY;
    this.registry = registry;
    this.paletteProfile = paletteProfile;
    this.seed = seed;
    this.subchunks = new Map();
  }

  buildFoundation() {
    const bedrock = this.registry.id("minecraft:bedrock");
    const stone = this.registry.id("minecraft:stone");
    const dirt = this.registry.id("minecraft:dirt");
    for (let localZ = 0; localZ < 16; localZ += 1) {
      for (let localX = 0; localX < 16; localX += 1) {
        const worldX = this.chunkX * 16 + localX;
        const worldZ = this.chunkZ * 16 + localZ;
        for (let y = 0; y <= this.baseY; y += 1) {
          let id;
          if (y === 0) id = bedrock;
          else if (y < this.baseY - 3) id = stone;
          else if (y < this.baseY) id = dirt;
          else id = this.registry.id(resolveMaterial("minecraft:grass_block", this.paletteProfile, this.seed, worldX, y, worldZ));
          this.set(localX, y, localZ, id);
        }
      }
    }
  }

  applyOperations(operations, sourcePalette) {
    for (const operation of operations) {
      const [phase, x1, y1, z1, x2, y2, z2, paletteIndex] = operation;
      const sourceBlock = sourcePalette[paletteIndex];
      for (let worldZ = z1; worldZ <= z2; worldZ += 1) {
        for (let worldX = x1; worldX <= x2; worldX += 1) {
          const localX = worldX - this.chunkX * 16;
          const localZ = worldZ - this.chunkZ * 16;
          for (let relativeY = y1; relativeY <= y2; relativeY += 1) {
            const worldY = this.baseY + relativeY;
            const block = resolveMaterial(sourceBlock, this.paletteProfile, this.seed ^ phase, worldX, worldY, worldZ);
            this.set(localX, worldY, localZ, this.registry.id(block));
          }
        }
      }
    }
  }

  set(x, y, z, blockId) {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return;
    const subChunkIndex = floorDiv(y, 16);
    let blocks = this.subchunks.get(subChunkIndex);
    if (!blocks) {
      blocks = new Uint16Array(4096);
      this.subchunks.set(subChunkIndex, blocks);
    }
    blocks[offsetToChunkBlockIndex({ x, y: floorMod(y, 16), z })] = blockId;
  }

  highestBlockAt(x, z) {
    const indices = [...this.subchunks.keys()].sort((a, b) => b - a);
    for (const subChunkIndex of indices) {
      const blocks = this.subchunks.get(subChunkIndex);
      for (let localY = 15; localY >= 0; localY -= 1) {
        const id = blocks[offsetToChunkBlockIndex({ x, y: localY, z })];
        if (this.registry.get(id)?.name !== AIR) return subChunkIndex * 16 + localY;
      }
    }
    return WORLD_MIN_Y;
  }

  serialize({ chunkVersion, signs = [] }) {
    const heightMap = Array.from({ length: 16 }, () => Array(16).fill(WORLD_MIN_Y));
    for (let x = 0; x < 16; x += 1) {
      for (let z = 0; z < 16; z += 1) heightMap[x][z] = this.highestBlockAt(x, z) + 1;
    }
    const biomes = Array.from({ length: 24 }, () => ({ values: new Array(4096).fill(0), palette: [1] }));
    const subchunks = [];
    for (const subChunkIndex of [...this.subchunks.keys()].sort((a, b) => a - b)) {
      const globalIndices = this.subchunks.get(subChunkIndex);
      if (globalIndices.every((id) => id === 0)) continue;
      const localPalette = [];
      const paletteLookup = new Map();
      const blockIndices = new Array(4096);
      for (let index = 0; index < 4096; index += 1) {
        const globalId = globalIndices[index];
        let localId = paletteLookup.get(globalId);
        if (localId === undefined) {
          localId = localPalette.length;
          localPalette.push(globalId);
          paletteLookup.set(globalId, localId);
        }
        blockIndices[index] = localId;
      }
      const palette = {};
      localPalette.forEach((globalId, index) => { palette[String(index)] = this.registry.nbt(globalId); });
      const value = entryContentTypeToFormatMap.SubChunkPrefix.serialize({
        type: "compound",
        value: {
          version: { type: "byte", value: 9 },
          layerCount: { type: "byte", value: 1 },
          subChunkIndex: { type: "byte", value: subChunkIndex },
          layers: {
            type: "list",
            value: {
              type: "compound",
              value: [{
                palette: { type: "compound", value: palette },
                block_indices: { type: "list", value: { type: "int", value: blockIndices } }
              }]
            }
          }
        }
      });
      subchunks.push({ subChunkIndex, value, paletteSize: localPalette.length });
    }
    return {
      heightMap,
      biomes,
      subchunks,
      blockEntities: signs.map((sign) => signBlockEntity(sign, this.baseY)),
      chunkVersion
    };
  }
}

function chunkRecords(chunkX, chunkZ, records, chunkVersion) {
  const indices = { x: chunkX, z: chunkZ, dimension: "overworld" };
  const finalized = Buffer.alloc(4);
  finalized.writeUInt32LE(2);
  const result = [
    { type: "put", key: generateChunkKeyFromIndices(indices, "Version"), value: Buffer.from([chunkVersion]) },
    { type: "put", key: generateChunkKeyFromIndices(indices, "FinalizedState"), value: finalized },
    { type: "put", key: generateChunkKeyFromIndices(indices, "Data3D"), value: writeData3DValue(records.heightMap, records.biomes) },
    ...records.subchunks.map((subchunk) => ({
      type: "put",
      key: generateChunkKeyFromIndices({ ...indices, subChunkIndex: subchunk.subChunkIndex }, "SubChunkPrefix"),
      value: subchunk.value
    }))
  ];
  if (records.blockEntities.length) {
    result.push({
      type: "put",
      key: generateChunkKeyFromIndices(indices, "BlockEntity"),
      value: entryContentTypeToFormatMap.BlockEntity.serialize({
        type: "compound",
        value: {
          blockEntities: {
            type: "list",
            value: { type: "compound", value: records.blockEntities }
          }
        }
      })
    });
  }
  return result;
}

function signBlockEntity(sign, baseY) {
  const text = signText(sign.text);
  return {
    id: { type: "string", value: "Sign" },
    isMovable: { type: "byte", value: 1 },
    x: { type: "int", value: sign.x },
    y: { type: "int", value: baseY + sign.y },
    z: { type: "int", value: sign.z },
    FrontText: { type: "compound", value: text },
    BackText: { type: "compound", value: signText(sign.text) },
    IsWaxed: { type: "byte", value: 1 }
  };
}

function signText(text) {
  return {
    HideGlowOutline: { type: "byte", value: 0 },
    IgnoreLighting: { type: "byte", value: 0 },
    PersistFormatting: { type: "byte", value: 1 },
    SignTextColor: { type: "int", value: -16_777_216 },
    Text: { type: "string", value: text },
    TextOwner: { type: "string", value: "" }
  };
}

function serializeLevelDat({ parkName, spawn, seed }) {
  const versionList = (values) => ({ type: "list", value: { type: "int", value: values } });
  const flatLayers = JSON.stringify({
    biome_id: 1,
    block_layers: [],
    encoding_version: 6,
    structure_options: null,
    world_version: "version.post_1_18"
  });
  return entryContentTypeToFormatMap.LevelDat.serialize({
    type: "compound",
    value: {
      LevelName: { type: "string", value: parkName },
      StorageVersion: { type: "int", value: 10 },
      WorldVersion: { type: "int", value: 1 },
      baseGameVersion: { type: "string", value: "*" },
      InventoryVersion: { type: "string", value: "1.21.120" },
      MinimumCompatibleClientVersion: versionList([1, 21, 120, 0, 0]),
      lastOpenedWithVersion: versionList([1, 21, 120, 0, 0]),
      RandomSeed: { type: "long", value: seed },
      LastPlayed: { type: "long", value: Math.floor(Date.now() / 1000) },
      currentTick: { type: "long", value: 0 },
      SpawnX: { type: "int", value: spawn.x },
      SpawnY: { type: "int", value: spawn.y },
      SpawnZ: { type: "int", value: spawn.z },
      Generator: { type: "int", value: 5 },
      FlatWorldLayers: { type: "string", value: flatLayers },
      GameType: { type: "int", value: 1 },
      ForceGameType: { type: "byte", value: 0 },
      Difficulty: { type: "int", value: 0 },
      commandsEnabled: { type: "byte", value: 1 },
      hasBeenLoadedInCreative: { type: "byte", value: 1 },
      immutableWorld: { type: "byte", value: 0 },
      isFromLockedTemplate: { type: "byte", value: 0 },
      LANBroadcast: { type: "byte", value: 1 },
      LANBroadcastIntent: { type: "byte", value: 1 },
      MultiplayerGame: { type: "byte", value: 1 },
      MultiplayerGameIntent: { type: "byte", value: 1 },
      Platform: { type: "int", value: 2 },
      XBLBroadcastIntent: { type: "int", value: 1 },
      showcoordinates: { type: "byte", value: 1 },
      spawnMobs: { type: "byte", value: 0 },
      doDaylightCycle: { type: "byte", value: 1 },
      doWeatherCycle: { type: "byte", value: 1 },
      mobgriefing: { type: "byte", value: 0 },
      tntexplodes: { type: "byte", value: 0 },
      randomtickspeed: { type: "int", value: 1 },
      world_policies: { type: "compound", value: {} }
    }
  });
}

async function validateWorldDirectory(stage, sample, expectedChunkVersion, signs, baseY) {
  const database = new LevelDB(path.join(stage, "db"), { createIfMissing: false });
  await database.open();
  try {
    const indices = { x: sample.chunkX, z: sample.chunkZ, dimension: "overworld" };
    const version = await database.get(generateChunkKeyFromIndices(indices, "Version"));
    invariant(version?.[0] === expectedChunkVersion, "Chunk version round-trip failed");
    const data3D = await database.get(generateChunkKeyFromIndices(indices, "Data3D"));
    const parsedData3D = entryContentTypeToFormatMap.Data3D.parse(data3D);
    invariant(parsedData3D.value.biomes.value.value.length >= 24, "Biome record round-trip failed");
    const subchunk = await database.get(generateChunkKeyFromIndices({ ...indices, subChunkIndex: sample.subChunkIndex }, "SubChunkPrefix"));
    const parsedSubchunk = await entryContentTypeToFormatMap.SubChunkPrefix.parse(subchunk);
    const palette = parsedSubchunk.value.layers.value.value[0].palette.value;
    invariant(Object.keys(palette).length > 0, "Block palette round-trip failed");
    const signValidation = signs.length
      ? await validateSigns(database, signs, baseY)
      : { stored: 0, expected: 0, status: "not-applicable" };
    invariant(signValidation.status !== "failed", "Named building signs failed validation");
    return {
      levelDat: "serialized",
      levelDb: "reopened",
      chunkVersion: version[0],
      data3DBiomeSections: parsedData3D.value.biomes.value.value.length,
      sample: { ...sample, paletteEntries: Object.keys(palette).length },
      signLabels: signValidation,
      status: "passed"
    };
  } finally {
    await database.close();
  }
}

async function validateSigns(database, signs, baseY) {
  const chunks = groupSignsByChunk(signs);
  let stored = 0;
  let sample = null;
  for (const [key, expected] of chunks) {
    const [chunkX, chunkZ] = key.split(",").map(Number);
    const indices = { x: chunkX, z: chunkZ, dimension: "overworld" };
    const rawEntities = await database.get(generateChunkKeyFromIndices(indices, "BlockEntity"));
    invariant(rawEntities?.length, "Named sign chunk has no BlockEntity record");
    const parsedEntities = await entryContentTypeToFormatMap.BlockEntity.parse(rawEntities);
    const entities = parsedEntities.value.blockEntities.value.value;
    const signEntities = entities.filter((candidate) => candidate.id?.value === "Sign");
    invariant(signEntities.length === expected.length, "Named sign count round-trip failed in a chunk");
    for (const sign of expected) {
      const worldY = baseY + sign.y;
      const entity = signEntities.find((candidate) =>
        candidate.x.value === sign.x && candidate.y.value === worldY && candidate.z.value === sign.z
      );
      invariant(entity, "Named sign block entity could not be found");
      invariant(entity.FrontText.value.Text.value === sign.text, "Named sign front text round-trip failed");
      invariant(entity.BackText.value.Text.value === sign.text, "Named sign back text round-trip failed");
      invariant(entity.IsWaxed.value === 1, "Named sign wax state round-trip failed");
      if (!sample) sample = { ...sign, y: worldY, chunkX, chunkZ };
    }
    stored += signEntities.length;
  }
  invariant(stored === signs.length, "Not every named building sign was stored");
  const blockName = await validateSignBlock(database, sample);
  return {
    stored,
    expected: signs.length,
    sample: {
      x: sample.x,
      y: sample.y,
      z: sample.z,
      name: sample.name,
      text: sample.text,
      featureId: sample.featureId,
      block: blockName,
      twoSided: true,
      waxed: true
    },
    status: "passed"
  };
}

async function validateSignBlock(database, sample) {
  const indices = { x: sample.chunkX, z: sample.chunkZ, dimension: "overworld" };
  const subChunkIndex = floorDiv(sample.y, 16);
  const rawSubchunk = await database.get(generateChunkKeyFromIndices({ ...indices, subChunkIndex }, "SubChunkPrefix"));
  const parsedSubchunk = await entryContentTypeToFormatMap.SubChunkPrefix.parse(rawSubchunk);
  const layer = parsedSubchunk.value.layers.value.value[0];
  const localX = floorMod(sample.x, 16);
  const localY = floorMod(sample.y, 16);
  const localZ = floorMod(sample.z, 16);
  const offset = offsetToChunkBlockIndex({ x: localX, y: localY, z: localZ });
  const paletteIndex = layer.block_indices.value.value[offset];
  const blockName = layer.palette.value[String(paletteIndex)]?.value?.name?.value;
  invariant(blockName === "minecraft:standing_sign", "Named label text exists without a standing-sign block");
  return blockName;
}

async function zipWorld(stage) {
  const archive = {};
  await collectFiles(stage, "", archive);
  return Buffer.from(zipSync(archive, { level: 6 }));
}

async function collectFiles(directory, prefix, archive) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(directory, entry.name);
    const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectFiles(fullPath, archivePath, archive);
    else archive[archivePath] = new Uint8Array(await readFile(fullPath));
  }
}

function worldChunkBounds(compilation, margin) {
  const bounds = compilation.meta.bounds;
  const operationX = compilation.chunks.map((chunk) => chunk.x);
  const operationZ = compilation.chunks.map((chunk) => chunk.z);
  return {
    minChunkX: Math.min(floorDiv(bounds.minX - margin, 16), ...operationX),
    minChunkZ: Math.min(floorDiv(bounds.minZ - margin, 16), ...operationZ),
    maxChunkX: Math.max(floorDiv(bounds.maxX + margin, 16), ...operationX),
    maxChunkZ: Math.max(floorDiv(bounds.maxZ + margin, 16), ...operationZ)
  };
}

function groupSignsByChunk(signs) {
  const chunks = new Map();
  for (const sign of signs) {
    const key = `${floorDiv(sign.x, 16)},${floorDiv(sign.z, 16)}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key).push(sign);
  }
  return chunks;
}

function compilationYBounds(compilation) {
  let min = 0, max = 0;
  for (const chunk of compilation.chunks) {
    for (const operation of chunk.o) {
      min = Math.min(min, operation[2], operation[5]);
      max = Math.max(max, operation[2], operation[5]);
    }
  }
  return { min, max };
}

function resolveMaterial(source, profile, seed, x, y, z) {
  const variants = WORLD_PALETTES[profile]?.[source];
  if (!variants?.length) return source;
  const total = variants.reduce((sum, [, weight]) => sum + weight, 0);
  let target = coordinateNoise(seed, x, y, z) * total;
  for (const [block, weight] of variants) {
    target -= weight;
    if (target < 0) return block;
  }
  return variants.at(-1)[0];
}

function parseBlockSpecification(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(minecraft:[a-z0-9_]+)(?:\[([^\]]*)\])?$/);
  if (!match) throw new UserError(`Invalid Bedrock block specification: ${text}`);
  const states = {};
  for (const item of String(match[2] || "").split(",").filter(Boolean)) {
    const equals = item.indexOf("=");
    if (equals <= 0) throw new UserError(`Invalid Bedrock block state in: ${text}`);
    const key = item.slice(0, equals).trim();
    const raw = item.slice(equals + 1).trim();
    if (!/^[a-z0-9_:]+$/.test(key) || !raw) throw new UserError(`Invalid Bedrock block state in: ${text}`);
    if (/^(?:true|false)$/i.test(raw)) states[key] = { type: "byte", value: raw.toLowerCase() === "true" ? 1 : 0 };
    else if (/^-?\d+$/.test(raw)) states[key] = { type: "int", value: Number(raw) };
    else if (/^[a-z0-9_:.-]+$/i.test(raw)) states[key] = { type: "string", value: raw };
    else throw new UserError(`Invalid Bedrock block state value in: ${text}`);
  }
  return { name: match[1], states };
}

function defaultStates(name) {
  if (name === "minecraft:water") return { liquid_depth: { type: "int", value: 0 } };
  if (name === "minecraft:standing_sign") return { ground_sign_direction: { type: "int", value: 8 } };
  if (name.endsWith("_log")) return { pillar_axis: { type: "string", value: "y" } };
  if (name.endsWith("_leaves")) {
    return {
      persistent_bit: { type: "byte", value: 1 },
      update_bit: { type: "byte", value: 0 }
    };
  }
  if (name.endsWith("_wall")) {
    return {
      wall_connection_type_east: { type: "string", value: "none" },
      wall_connection_type_north: { type: "string", value: "none" },
      wall_connection_type_south: { type: "string", value: "none" },
      wall_connection_type_west: { type: "string", value: "none" },
      wall_post_bit: { type: "byte", value: 1 }
    };
  }
  return {};
}

function coordinateNoise(seed, x, y, z) {
  let value = seed ^ Math.imul(x, 0x45d9f3b) ^ Math.imul(y, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

function integerOption(value, fallback, flag, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new UserError(`${flag} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function normalizeSeed(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UserError("--seed must be a safe integer");
  return parsed;
}

function hash32(value) {
  const hash = createHash("sha256").update(String(value)).digest();
  return hash.readInt32LE(0);
}

const floorDiv = (value, divisor) => Math.floor(value / divisor);
const floorMod = (value, divisor) => ((value % divisor) + divisor) % divisor;
const containsColumn = (chunkX, chunkZ, x, z) => floorDiv(x, 16) === chunkX && floorDiv(z, 16) === chunkZ;
