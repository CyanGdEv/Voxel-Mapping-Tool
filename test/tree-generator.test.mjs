import assert from "node:assert/strict";
import test from "node:test";
import { compileHighFidelityTreeModel } from "../src/lib/tree-generator.mjs";

function generate(overrides = {}) {
  const voxels = [];
  const result = compileHighFidelityTreeModel({
    add: (_phase, x1, y1, z1, x2, y2, z2, block) => {
      assert.equal(x1, x2); assert.equal(y1, y2); assert.equal(z1, z2);
      voxels.push({ x: x1, y: y1, z: z1, block });
    },
    x: 0, z: 0, groundY: 64,
    heightM: 17, crownDiameterM: 13,
    species: "Quercus robur", leafType: "broadleaved",
    leafPalette: ["minecraft:oak_leaves", "minecraft:azalea_leaves"],
    seed: 12345,
    ...overrides
  });
  return { result, voxels };
}

test("high-fidelity tree generator preserves measured height and crown target", () => {
  const { result, voxels } = generate();
  assert.equal(result.heightBlocks, 17);
  assert.equal(result.crownDiameterBlocks, 13);
  assert.match(result.preset, /oak/);
  assert.ok(result.branchBlocks > 8, "expected visible structural limbs");
  assert.ok(result.twigBlocks > 3, "expected secondary twig/detail structure");
  assert.ok(result.leafBlocks > 20, "expected clustered canopy");
  assert.ok(result.totalBlocks > result.leafBlocks, "tree must not be only a leaf blob");
  assert.equal(Math.max(...voxels.map((v) => v.y)), 81);
});

test("tree generation is deterministic for the same evidence and seed", () => {
  const a = generate();
  const b = generate();
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(a.voxels, b.voxels);
});

test("different deterministic seeds vary branch/canopy structure without changing 1:1 dimensions", () => {
  const a = generate({ seed: 1 });
  const b = generate({ seed: 2 });
  assert.equal(a.result.heightBlocks, b.result.heightBlocks);
  assert.equal(a.result.crownDiameterBlocks, b.result.crownDiameterBlocks);
  assert.notDeepEqual(a.voxels, b.voxels);
});

test("willow preset creates descending canopy below branch tips", () => {
  const { result, voxels } = generate({ species: "Salix alba", heightM: 14, crownDiameterM: 11 });
  assert.equal(result.preset, "willow");
  const foliage = voxels.filter((v) => v.block.includes("leaves"));
  assert.ok(foliage.some((v) => v.y < 64 + 7), "expected weeping foliage below mid-crown");
});

test("spruce keeps a narrower conifer silhouette than an equivalently tall ancient oak", () => {
  const spruce = generate({ species: "Picea abies", heightM: 22, crownDiameterM: undefined });
  const oak = generate({ species: "Quercus robur veteran", heightM: 22, crownDiameterM: undefined });
  assert.equal(spruce.result.preset, "spruce");
  assert.equal(oak.result.preset, "ancient-oak");
  assert.ok(spruce.result.crownDiameterBlocks < oak.result.crownDiameterBlocks);
});

test("large veteran oak grows a tapered multi-block trunk/root structure", () => {
  const { result, voxels } = generate({ species: "Quercus robur veteran", heightM: 27, crownDiameterM: 18 });
  assert.equal(result.preset, "ancient-oak");
  const baseWood = voxels.filter((v) => v.y <= 67 && /log|fence|stairs|slab/.test(v.block));
  assert.ok(new Set(baseWood.map((v) => `${v.x},${v.z}`)).size >= 5, "expected a widened trunk/root footprint");
});
