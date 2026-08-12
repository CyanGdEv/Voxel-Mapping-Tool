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
test("live vegetation compiler routes mapped and aerial trees through high-fidelity generator", async () => {
  const raster = await readFile(new URL("../src/lib/raster.mjs", import.meta.url), "utf8");
  assert.ok(
    raster.includes('import { compileHighFidelityTreeModel } from "./tree-generator.mjs";'),
    "raster compiler must import the high-fidelity tree engine"
  );
  const calls = raster.match(/compileHighFidelityTreeModel\s*\(\s*\{/g) || [];
  assert.ok(calls.length >= 2, "mapped and aerial tree paths must both use the high-fidelity generator");
  assert.equal(
    raster.includes("const model = compileTreeModel({"), false,
    "live tree paths must not fall back to the legacy spherical compiler"
  );
});
test("Java rooted_dirt alias is not emitted", async () => {
  const text = (await Promise.all([
    readFile(new URL("../src/lib/fidelity.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/aerial-appearance.mjs", import.meta.url), "utf8")
  ])).join("\n");
  assert.equal(text.includes("minecraft:rooted_dirt"), false);
});
