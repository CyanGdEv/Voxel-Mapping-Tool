import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../src/lib/mcworld.mjs", import.meta.url);
let source = await readFile(path, "utf8");

if (!source.includes('import { availableParallelism } from "node:os";')) {
  source = source.replace(
    'import { createHash } from "node:crypto";',
    'import { createHash } from "node:crypto";\nimport { availableParallelism } from "node:os";\nimport { Worker } from "node:worker_threads";'
  );
}

source = source.replace(
  '  const registry = new BlockRegistry(blockDataVersion);',
  '  const workerCount = resolveWorldWorkerCount(options, chunkCount);\n  const emittedBlocks = new Set();'
);

const oldLoop = `    let completed = 0;
    for (let chunkZ = bounds.minChunkZ; chunkZ <= bounds.maxChunkZ; chunkZ += 1) {
      for (let chunkX = bounds.minChunkX; chunkX <= bounds.maxChunkX; chunkX += 1) {
        const volume = new ChunkVolume({ chunkX, chunkZ, baseY, registry, paletteProfile, seed });
        volume.buildFoundation();
        const sourceChunk = operationChunks.get(\`${'${chunkX}'},${'${chunkZ}'}\`);
        if (sourceChunk) volume.applyOperations(sourceChunk.o, compilation.palette);
        const sourceSigns = signChunks.get(\`${'${chunkX}'},${'${chunkZ}'}\`) || [];

        const records = volume.serialize({ chunkVersion, signs: sourceSigns });
        await database.batch(chunkRecords(chunkX, chunkZ, records, chunkVersion));
        if (!firstSample && records.subchunks.length) {
          firstSample = { chunkX, chunkZ, subChunkIndex: records.subchunks[0].subChunkIndex };
        }
        if (containsColumn(chunkX, chunkZ, spawnTarget.x, spawnTarget.z)) {
          spawnTopY = volume.highestBlockAt(floorMod(spawnTarget.x, 16), floorMod(spawnTarget.z, 16));
        }

        completed += 1;
        if (completed % 100 === 0 || completed === chunkCount) {
          progress(\`Writing Bedrock chunks ${'${completed.toLocaleString()}'}/${'${chunkCount.toLocaleString()}'}\`);
        }
      }
    }`;

const newLoop = `    const jobs = [];
    for (let chunkZ = bounds.minChunkZ; chunkZ <= bounds.maxChunkZ; chunkZ += 1) {
      for (let chunkX = bounds.minChunkX; chunkX <= bounds.maxChunkX; chunkX += 1) {
        jobs.push({
          chunkX,
          chunkZ,
          operations: operationChunks.get(\`${'${chunkX}'},${'${chunkZ}'}\`)?.o || [],
          signs: signChunks.get(\`${'${chunkX}'},${'${chunkZ}'}\`) || []
        });
      }
    }
    progress(\`Serializing Bedrock chunks with ${'${workerCount}'} CPU worker${'${workerCount === 1 ? "" : "s"}'}\`);
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
          progress(\`Writing Bedrock chunks ${'${completed.toLocaleString()}'}/${'${chunkCount.toLocaleString()}'}\`);
        }
      }
    });`;

if (!source.includes(newLoop)) {
  if (!source.includes(oldLoop)) throw new Error("Serial chunk loop marker not found");
  source = source.replace(oldLoop, newLoop);
}

source = source.replace('      emittedBlocks: registry.names()', '      emittedBlocks: [...emittedBlocks].sort()');

const classMarker = '\nclass BlockRegistry {';
const helpers = `
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
          void fail(new Error(\`Bedrock chunk worker failed at job ${'${message.index}'}: ${'${message.error}'}\`));
          return;
        }
        if (message?.type !== "result") return;
        pending.set(message.index, { worker, result: message.result });
        void flush();
      });
      worker.on("error", (error) => void fail(error));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) void fail(new Error(\`Bedrock chunk worker exited with code ${'${code}'}\`));
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
`;
if (!source.includes('export function resolveWorldWorkerCount')) {
  if (!source.includes(classMarker)) throw new Error("BlockRegistry class marker not found");
  source = source.replace(classMarker, `\n${helpers}${classMarker}`);
}

for (const marker of [
  'resolveWorldWorkerCount(options, chunkCount)',
  'serializeChunksWithWorkers({',
  'new Worker(new URL("./mcworld-chunk-worker.mjs"',
  'emittedBlocks: [...emittedBlocks].sort()',
  'export function serializeChunkJob'
]) {
  if (!source.includes(marker)) throw new Error(`Missing worker integration marker: ${marker}`);
}

await writeFile(path, source);
console.log("Applied deterministic parallel Bedrock chunk serialization");
