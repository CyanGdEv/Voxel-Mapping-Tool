import { readFile, writeFile } from "node:fs/promises";

const fidelityPath = new URL("../src/lib/fidelity.mjs", import.meta.url);
let fidelity = await readFile(fidelityPath, "utf8");
if (!fidelity.includes('import { inferIndividualTreesInVegetation } from "./woodland-tree-inference.mjs";')) {
  fidelity = fidelity.replace(
    'import { reconstructTreeCrownFromSamples } from "./tree-reconstruction.mjs";',
    'import { reconstructTreeCrownFromSamples } from "./tree-reconstruction.mjs";\nimport { inferIndividualTreesInVegetation } from "./woodland-tree-inference.mjs";'
  );
}
if (!fidelity.includes("const treeInference = inferIndividualTreesInVegetation(map, sources, options);")) {
  fidelity = fidelity.replace(
    '  const pathFeatures = map.features.filter((feature) => PATH_KINDS.has(feature.kind));\n  const treeFeatures = map.features.filter((feature) => feature.kind === "vegetation");',
    '  const pathFeatures = map.features.filter((feature) => PATH_KINDS.has(feature.kind));\n  const treeInference = inferIndividualTreesInVegetation(map, sources, options);\n  const treeFeatures = map.features.filter((feature) => feature.kind === "vegetation");'
  );
}
if (!fidelity.includes("    treeInference,")) {
  fidelity = fidelity.replace(
    '    terrainDetails: map.terrainDetails,\n    trees,',
    '    terrainDetails: map.terrainDetails,\n    treeInference,\n    trees,'
  );
}
for (const required of [
  'import { inferIndividualTreesInVegetation } from "./woodland-tree-inference.mjs";',
  "const treeInference = inferIndividualTreesInVegetation(map, sources, options);",
  "    treeInference,"
]) if (!fidelity.includes(required)) throw new Error(`V4 fidelity integration missing: ${required}`);
await writeFile(fidelityPath, fidelity);

const testPath = new URL("../test/direct-world-palette-compatibility.test.mjs", import.meta.url);
let test = await readFile(testPath, "utf8");
if (!test.includes('test("Tree Reconstruction V4 infers unmapped woodland trees before fidelity compilation"')) {
  test += `\n\ntest("Tree Reconstruction V4 infers unmapped woodland trees before fidelity compilation", async () => {\n  const fidelity = await readFile(new URL("../src/lib/fidelity.mjs", import.meta.url), "utf8");\n  assert.ok(fidelity.includes('import { inferIndividualTreesInVegetation } from "./woodland-tree-inference.mjs";'));\n  const inferIndex = fidelity.indexOf("const treeInference = inferIndividualTreesInVegetation(map, sources, options);");\n  const treeIndex = fidelity.indexOf('const treeFeatures = map.features.filter((feature) => feature.kind === "vegetation");');\n  assert.ok(inferIndex >= 0 && treeIndex > inferIndex);\n  assert.ok(fidelity.includes("treeInference,"));\n});\n`;
}
await writeFile(testPath, test);
console.log("Applied Tree Reconstruction V4 live integration");
