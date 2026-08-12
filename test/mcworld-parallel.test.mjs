import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorldWorkerCount,
  serializeChunkJob,
  serializeChunksWithWorkers
} from "../src/lib/mcworld.mjs";

const config = {
  baseY: 64,
  paletteProfile: "clean",
  seed: 1234,
  blockDataVersion: 18_168_865,
  chunkVersion: 42,
  sourcePalette: ["minecraft:grass_block", "minecraft:stone"],
  spawnTarget: { x: 1, z: 1 }
};

const jobs = [
  { chunkX: 0, chunkZ: 0, operations: [[1, 0, 1, 0, 3, 1, 0, 0]], signs: [] },
  { chunkX: 1, chunkZ: 0, operations: [[1, 16, 2, 0, 18, 2, 0, 1]], signs: [] },
  { chunkX: 0, chunkZ: 1, operations: [], signs: [] }
];

test("worker budget follows TPMAP_CPU_WORKERS but stays bounded by work", () => {
  const previous = process.env.TPMAP_CPU_WORKERS;
  process.env.TPMAP_CPU_WORKERS = "16";
  try {
    assert.equal(resolveWorldWorkerCount({}, 100), 16);
    assert.equal(resolveWorldWorkerCount({}, 3), 3);
    assert.equal(resolveWorldWorkerCount({ cpuWorkers: 2 }, 100), 2);
  } finally {
    if (previous === undefined) delete process.env.TPMAP_CPU_WORKERS;
    else process.env.TPMAP_CPU_WORKERS = previous;
  }
});

test("chunk serialization is deterministic", () => {
  const first = serializeChunkJob(config, jobs[0]);
  const second = serializeChunkJob(config, jobs[0]);
  assert.equal(first.firstSubChunkIndex, second.firstSubChunkIndex);
  assert.equal(first.spawnTopY, second.spawnTopY);
  assert.deepEqual(first.emittedBlocks, second.emittedBlocks);
  assert.equal(first.dbOps.length, second.dbOps.length);
  for (let index = 0; index < first.dbOps.length; index += 1) {
    assert.deepEqual(first.dbOps[index].key, second.dbOps[index].key);
    assert.deepEqual(first.dbOps[index].value, second.dbOps[index].value);
  }
});

test("parallel workers deliver chunks to the database callback in deterministic input order", async () => {
  const seen = [];
  await serializeChunksWithWorkers({
    jobs,
    workerCount: 3,
    config,
    onResult: async (job, result) => {
      seen.push(`${job.chunkX},${job.chunkZ}`);
      assert.ok(result.dbOps.length >= 4);
      assert.ok(result.emittedBlocks.includes("minecraft:bedrock"));
    }
  });
  assert.deepEqual(seen, ["0,0", "1,0", "0,1"]);
});
