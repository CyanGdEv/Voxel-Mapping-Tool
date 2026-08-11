import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
import { ensureDir, writeJson, writeText } from "./io.mjs";

export async function buildBedrockAddon({ parkName, slug, compilation, outputDir, options = {} }) {
  const packRoot = path.join(outputDir, `${slug}_builder_bp`);
  const scriptsRoot = path.join(packRoot, "scripts");
  const dataRoot = path.join(scriptsRoot, "data");
  await ensureDir(dataRoot);
  const moduleVersion = options.minecraftServerVersion || "2.3.0";
  const minEngineVersion = options.minEngineVersion || [1, 21, 130];
  const headerUuid = randomUUID(), moduleUuid = randomUUID();
  await writeJson(path.join(packRoot, "manifest.json"), {
    format_version: 2,
    header: {
      name: `${parkName} · 1:1 Evidence Builder`,
      description: "Generated public-data park builder. Read the evidence report before use.",
      uuid: headerUuid,
      version: [0, 1, 0],
      min_engine_version: minEngineVersion
    },
    modules: [{
      type: "script",
      language: "javascript",
      uuid: moduleUuid,
      version: [0, 1, 0],
      entry: "scripts/main.js"
    }],
    dependencies: [{ module_name: "@minecraft/server", version: moduleVersion }],
    metadata: {
      authors: ["Voxel Mapping Tool evidence compiler"],
      generated_with: { voxel_mapping_tool: [0, 1, 0] },
      license: "MIT"
    }
  });

  const parts = [];
  for (let index = 0; index < compilation.chunks.length; index += 64) {
    const partName = `part_${String(parts.length).padStart(3, "0")}`;
    parts.push(partName);
    await writeText(path.join(dataRoot, `${partName}.js`), `export const PART = ${JSON.stringify(compilation.chunks.slice(index, index + 64))};\n`);
  }
  const imports = parts.map((name, index) => `import { PART as P${index} } from "./data/${name}.js";`).join("\n");
  await writeText(path.join(scriptsRoot, "park_data.js"), `${imports}
export const PARK = ${JSON.stringify({
    meta: compilation.meta,
    palette: compilation.palette,
    stats: compilation.stats,
    signs: compilation.signs || []
  })};
PARK.parts = [${parts.map((_, index) => `P${index}`).join(",")}];
`);
  await writeText(path.join(scriptsRoot, "main.js"), runtimeSource());
  await writeText(path.join(packRoot, "README.txt"), packReadme(parkName, compilation));

  const addonPath = path.join(outputDir, `${slug}_1to1_builder.mcaddon`);
  const archive = {};
  await collectFiles(packRoot, path.basename(packRoot), archive);
  const zipped = zipSync(archive, { level: 9 });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(addonPath, zipped));
  return { packRoot, addonPath, headerUuid, moduleUuid, parts: parts.length };
}

async function collectFiles(directory, archivePrefix, target) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const archiveName = `${archivePrefix}/${entry.name}`.replaceAll(path.sep, "/");
    if (entry.isDirectory()) await collectFiles(full, archiveName, target);
    else target[archiveName] = new Uint8Array(await readFile(full));
  }
}

function packReadme(parkName, compilation) {
  return `${parkName} — 1:1 evidence builder

This pack changes blocks. Use a new or backed-up world.

1. Activate this behaviour pack in a Minecraft Bedrock world.
2. Stand where the geographic centre of the park should be. The block beneath you becomes vertical datum 0.
3. Run: /scriptevent tpmap:arm
4. Within 60 seconds run: /scriptevent tpmap:build
5. Check progress privately with: /scriptevent tpmap:status
6. Cancel with: /scriptevent tpmap:cancel

Explicit anchor: /scriptevent tpmap:build X Y Z

Track evidence colours: cyan survey/CAD, blue planning drawing, lime LiDAR-derived, gold interpolated, yellow inferred.
Orange track is a 2D ground-plan marker where public data did not include a usable 3D coaster profile.
Yellow outlines are mapped building/structure footprints. Named footprints have two-sided signs.
Player-readable signs at spawn and beside named rides explain vertical coverage, confidence, and whether banking is known.

Scale: 1 block = 1 metre
Confidence: ${(compilation.meta.confidence * 100).toFixed(1)}% (${compilation.meta.evidenceGrade})
Operations: ${compilation.stats.operations}
Estimated block writes: ${compilation.stats.estimatedBlocks}

Registration/alignment reference: © OpenStreetMap contributors, ODbL 1.0.
Planning-authoritative world geometry and other inputs retain the licences recorded in evidence.json.
https://www.openstreetmap.org/copyright
`;
}

function runtimeSource() {
  return `import { BlockComponentTypes, BlockPermutation, SignSide, system, world } from "@minecraft/server";
import { PARK } from "./park_data.js";

const state = { armedUntil: 0, ownerId: null, owner: null, jobId: null, cancel: false, done: 0, errors: 0, total: PARK.stats.operations };

function tell(target, message) {
  try { target?.sendMessage?.(\`§b[Voxel Map]§r \${message}\`); }
  catch { console.warn(\`[Voxel Map] \${message}\`); }
}

function ownerMatches(event) {
  return !state.ownerId || event.sourceEntity?.id === state.ownerId;
}

function parseAnchor(event) {
  const values = String(event.message || "").trim().split(/\\s+/).filter(Boolean).map(Number);
  if (values.length === 3 && values.every(Number.isFinite)) return { x: Math.floor(values[0]), y: Math.floor(values[1]), z: Math.floor(values[2]) };
  const location = event.sourceEntity?.location;
  if (location) return { x: Math.floor(location.x), y: Math.floor(location.y) - 1, z: Math.floor(location.z) };
  return { x: 0, y: PARK.meta.baseY, z: 0 };
}

function commandFor(op, anchor) {
  const block = commandBlock(PARK.palette[op[7]]);
  return \`fill \${anchor.x + op[1]} \${anchor.y + op[2]} \${anchor.z + op[3]} \${anchor.x + op[4]} \${anchor.y + op[5]} \${anchor.z + op[6]} \${block}\`;
}

function commandBlock(specification) {
  const match = String(specification).match(/^(minecraft:[a-z0-9_]+)(?:\\[([^\\]]*)\\])?$/);
  if (!match || !match[2]) return specification;
  const states = match[2].split(",").filter(Boolean).map((item) => {
    const equals = item.indexOf("=");
    const key = item.slice(0, equals).trim();
    const raw = item.slice(equals + 1).trim();
    const value = /^(?:true|false|-?\\d+)$/i.test(raw) ? raw.toLowerCase() : '"' + raw + '"';
    return '"' + key + '"=' + value;
  });
  return match[1] + " [" + states.join(",") + "]";
}

function* buildJob(dimension, anchor) {
  try {
    let chunkNumber = 0;
    const totalChunks = PARK.stats.chunks;
    for (const part of PARK.parts) {
      for (const chunk of part) {
        if (state.cancel) { tell(state.owner, "Build cancelled. Completed operations remain in the world."); return; }
        try { dimension.runCommand("tickingarea remove tpmap_runtime"); } catch {}
        const x1 = anchor.x + chunk.x * 16, z1 = anchor.z + chunk.z * 16;
        try { dimension.runCommand(\`tickingarea add \${x1} \${anchor.y} \${z1} \${x1 + 15} \${anchor.y} \${z1 + 15} tpmap_runtime true\`); }
        catch (error) { state.errors += 1; console.warn(\`[Voxel Map] ticking area: \${error}\`); }
        for (let warmup = 0; warmup < 8; warmup += 1) yield;
        let slice = 0;
        for (const operation of chunk.o) {
          if (state.cancel) { tell(state.owner, "Build cancelled. Completed operations remain in the world."); return; }
          try { dimension.runCommand(commandFor(operation, anchor)); }
          catch (error) { state.errors += 1; console.warn(\`[Voxel Map] operation failed: \${error}\`); }
          state.done += 1;
          slice += 1;
          if (slice >= PARK.meta.opsPerYield) { slice = 0; yield; }
        }
        chunkNumber += 1;
        if (chunkNumber % 10 === 0 || chunkNumber === totalChunks) {
          tell(state.owner, \`Progress \${chunkNumber}/\${totalChunks} chunks · \${state.done}/\${state.total} operations · \${state.errors} errors\`);
        }
        yield;
      }
    }
    let signsDone = 0;
    for (const sign of PARK.signs || []) {
      if (state.cancel) { tell(state.owner, "Build cancelled. Completed operations remain in the world."); return; }
      try {
        const location = { x: anchor.x + sign.x, y: anchor.y + sign.y, z: anchor.z + sign.z };
        const block = dimension.getBlock(location);
        block?.setPermutation(BlockPermutation.resolve("minecraft:standing_sign", { ground_sign_direction: 8 }));
        const component = block?.getComponent(BlockComponentTypes.Sign);
        component?.setText(sign.text);
        component?.setText(sign.text, SignSide.Back);
        component?.setWaxed(true);
      } catch (error) {
        state.errors += 1;
        console.warn(\`[Voxel Map] sign failed: \${error}\`);
      }
      signsDone += 1;
      if (signsDone % 12 === 0) yield;
    }
    tell(state.owner, \`Build complete: \${state.done} operations, \${state.errors} errors. Check the evidence report before calling this a 1:1 replica.\`);
  } finally {
    try { dimension.runCommand("tickingarea remove tpmap_runtime"); } catch {}
    state.jobId = null;
  }
}

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (!event.id.startsWith("tpmap:")) return;
  if (event.id === "tpmap:arm") {
    if (state.jobId !== null) { tell(event.sourceEntity, "A build is already running."); return; }
    state.armedUntil = system.currentTick + 1200;
    state.ownerId = event.sourceEntity?.id || null;
    state.owner = event.sourceEntity || null;
    tell(event.sourceEntity, "Armed for 60 seconds. This will change blocks; use a new or backed-up world. Run /scriptevent tpmap:build to confirm.");
    return;
  }
  if (event.id === "tpmap:status") {
    tell(event.sourceEntity, state.jobId === null
      ? \`Idle · \${PARK.meta.parkName} · confidence \${Math.round(PARK.meta.confidence * 1000) / 10}%\`
      : \`Running · \${state.done}/\${state.total} operations · \${state.errors} errors\`);
    return;
  }
  if (event.id === "tpmap:cancel") {
    if (!ownerMatches(event)) { tell(event.sourceEntity, "Only the player who started the build can cancel it."); return; }
    state.cancel = true;
    tell(event.sourceEntity, "Cancellation requested.");
    return;
  }
  if (event.id === "tpmap:build") {
    if (state.jobId !== null) { tell(event.sourceEntity, "A build is already running."); return; }
    if (system.currentTick > state.armedUntil || !ownerMatches(event)) {
      tell(event.sourceEntity, "Not armed. Run /scriptevent tpmap:arm first.");
      return;
    }
    const anchor = parseAnchor(event);
    const dimension = event.sourceEntity?.dimension || world.getDimension("minecraft:overworld");
    state.cancel = false; state.done = 0; state.errors = 0; state.owner = event.sourceEntity || state.owner;
    state.jobId = system.runJob(buildJob(dimension, anchor));
    state.armedUntil = 0;
    tell(state.owner, \`Build started at \${anchor.x} \${anchor.y} \${anchor.z}. \${PARK.stats.chunks} chunks, \${PARK.stats.operations} operations. Map data © OpenStreetMap contributors.\`);
  }
}, { namespaces: ["tpmap"] });
`;
}
