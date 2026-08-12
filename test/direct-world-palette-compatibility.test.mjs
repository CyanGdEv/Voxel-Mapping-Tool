import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
const P = /["'](minecraft:[a-z0-9_]+)["']/g;
const blocks = (text) => new Set([...text.matchAll(P)].map((m) => m[1]));
test("direct-world module is valid JavaScript", () => {
  const file = fileURLToPath(new URL("../src/lib/mcworld.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
test("appearance and high-fidelity tree palettes are accepted by the direct-world compiler", async () => {
  const [world, fidelity, aerial, raster, treePresets, treeGenerator] = await Promise.all([
    readFile(new URL("../src/lib/mcworld.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/fidelity.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/aerial-appearance.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/raster.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/tree-presets.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/tree-generator.mjs", import.meta.url), "utf8")
  ]);
  const section = world.slice(world.indexOf("const BEDROCK_BLOCKS"), world.indexOf("export const WORLD_PALETTES"));
  const allowed = blocks(section);
  const emitted = new Set([
    ...blocks(fidelity), ...blocks(aerial), ...blocks(raster),
    ...blocks(treePresets), ...blocks(treeGenerator)
  ]);
  emitted.delete("minecraft:overworld");
  emitted.delete("minecraft:shape");
  emitted.delete("minecraft:direction");
  const unsupported = [...emitted].filter((b) => !allowed.has(b)).sort();
  assert.deepEqual(unsupported, []);
});
test("Java rooted_dirt alias is not emitted", async () => {
  const text = (await Promise.all([
    readFile(new URL("../src/lib/fidelity.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/aerial-appearance.mjs", import.meta.url), "utf8")
  ])).join("\n");
  assert.equal(text.includes("minecraft:rooted_dirt"), false);
});
test("live vegetation paths are wired to high-fidelity trees", async () => {
  const raster = await readFile(new URL("../src/lib/raster.mjs", import.meta.url), "utf8");
  assert.ok(raster.includes('import { compileHighFidelityTreeModel } from "./tree-generator.mjs";'));
  assert.ok((raster.match(/compileHighFidelityTreeModel\(\{/g) || []).length >= 2);
});
test("Tree Reconstruction V3 is wired from LiDAR evidence through mapped-tree watershed into the live compiler", async () => {
  const [fidelity, raster, generator, reconstruction] = await Promise.all([
    readFile(new URL("../src/lib/fidelity.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/raster.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/tree-generator.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/tree-reconstruction.mjs", import.meta.url), "utf8")
  ]);
  assert.ok(fidelity.includes('import { reconstructTreeCrownFromSamples } from "./tree-reconstruction.mjs";'));
  assert.ok(fidelity.includes("const mappedTreeSeeds = treeFeatures"));
  assert.ok(fidelity.includes("mappedTreeSeeds, featureId: feature.id"));
  assert.ok(fidelity.includes("competitorSeeds"));
  assert.ok(reconstruction.includes("dsm-dtm-seeded-watershed"));
  assert.ok(reconstruction.includes("splitTouchingCrown"));
  assert.ok(raster.includes("reconstruction: evidence.reconstruction || evidence.canopyGeometry || null"));
  assert.ok(generator.includes("normalizeTreeReconstruction(reconstruction"));
  assert.ok(generator.includes("crownReachFromTrunk(crownGeometry, angle)"));
  assert.ok(generator.includes("insideCrownEnvelope(crownGeometry"));
});