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
test("appearance palettes are accepted by the direct-world compiler", async () => {
  const [world, fidelity, aerial, raster] = await Promise.all([
    readFile(new URL("../src/lib/mcworld.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/fidelity.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/aerial-appearance.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/raster.mjs", import.meta.url), "utf8")
  ]);
  const section = world.slice(world.indexOf("const BEDROCK_BLOCKS"), world.indexOf("export const WORLD_PALETTES"));
  const allowed = blocks(section);
  const emitted = new Set([...blocks(fidelity), ...blocks(aerial), ...blocks(raster)]);
  emitted.delete("minecraft:overworld");
  // Namespaced Bedrock state/source-property keys are not block identifiers.
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
