import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../src/lib/raster.mjs", import.meta.url);
let source = await readFile(path, "utf8");

const importAnchor = 'import { terrainStyleForAerialClass, vegetationPaletteForRgb } from "./aerial-appearance.mjs";';
const importLine = 'import { compileHighFidelityTreeModel } from "./tree-generator.mjs";';
if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) throw new Error("tree integration import anchor missing");
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const mappedOld = `    const model = compileTreeModel({\n      add, x, z, groundY: elevationY[index], heightM: resolvedHeight.heightM,\n      crownDiameterM: evidence.crownDiameterM, leafType: evidence.leafType, species: evidence.species,\n      leafPalette, seed: seed ^ hashText(\`${'${feature.id}:${x}:${z}'}\`)\n    });`;
const mappedNew = `    const model = compileHighFidelityTreeModel({\n      add, x, z, groundY: elevationY[index], heightM: resolvedHeight.heightM,\n      crownDiameterM: evidence.crownDiameterM, leafType: evidence.leafType, species: evidence.species,\n      genus: evidence.genus, tags: feature.tags || {},\n      leafPalette, seed: seed ^ hashText(\`${'${feature.id}:${x}:${z}'}\`),\n      detailLevel: options.treeDetailLevel || \"high\"\n    });`;
if (source.includes(mappedOld)) source = source.replace(mappedOld, mappedNew);
else if (!source.includes(mappedNew)) throw new Error("mapped tree call anchor missing");

const aerialOld = `      const model = compileTreeModel({\n        add, x, z, groundY: elevationY[index], heightM: resolvedHeight.heightM,\n        crownDiameterM: null, leafType: null,\n        leafPalette: vegetationPaletteForRgb(classification.rgb),\n        seed: seed ^ hashText(\`aerial-tree:${'${x}:${z}'}\`)\n      });`;
const aerialNew = `      const model = compileHighFidelityTreeModel({\n        add, x, z, groundY: elevationY[index], heightM: resolvedHeight.heightM,\n        crownDiameterM: null, leafType: null,\n        leafPalette: vegetationPaletteForRgb(classification.rgb),\n        seed: seed ^ hashText(\`aerial-tree:${'${x}:${z}'}\`),\n        detailLevel: options.treeDetailLevel || \"medium\"\n      });`;
if (source.includes(aerialOld)) source = source.replace(aerialOld, aerialNew);
else if (!source.includes(aerialNew)) throw new Error("aerial tree call anchor missing");

if (!source.includes("compileHighFidelityTreeModel({")) throw new Error("high-fidelity tree integration was not applied");
await writeFile(path, source);
console.log("Applied live high-fidelity tree generator integration to src/lib/raster.mjs");
