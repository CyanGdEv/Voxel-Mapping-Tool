import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../src/lib/woodland-tree-inference.mjs", import.meta.url);
let source = await readFile(path, "utf8");
if (!source.includes('import { resolveLocalSpeciesDiversity } from "./woodland-species-diversity.mjs";')) {
  source = source.replace(
    'import { detectTreeSeedsFromCanopySamples } from "./tree-seed-detection.mjs";',
    'import { detectTreeSeedsFromCanopySamples } from "./tree-seed-detection.mjs";\nimport { resolveLocalSpeciesDiversity } from "./woodland-species-diversity.mjs";'
  );
}
const oldCall = `      const speciesEvidence = resolveSpeciesEvidence({\n        x: seed.x,\n        z: seed.z,\n        parent: feature,\n        speciesSources,\n        mappedTrees: mappedTreeFeatures,\n        nearbyRadiusM: Number(options.treeInferenceNearbySpeciesRadiusM) || DEFAULTS.nearbySpeciesRadiusM\n      });`;
const newCall = `      const speciesEvidence = resolveLocalSpeciesDiversity({\n        x: seed.x,\n        z: seed.z,\n        parent: feature,\n        speciesSources,\n        mappedTrees: mappedTreeFeatures,\n        radiusM: Number(options.treeInferenceNearbySpeciesRadiusM) || DEFAULTS.nearbySpeciesRadiusM * 1.7,\n        seedKey: String(feature.id || "vegetation")\n      }) || resolveSpeciesEvidence({\n        x: seed.x,\n        z: seed.z,\n        parent: feature,\n        speciesSources,\n        mappedTrees: mappedTreeFeatures,\n        nearbyRadiusM: Number(options.treeInferenceNearbySpeciesRadiusM) || DEFAULTS.nearbySpeciesRadiusM\n      });`;
if (source.includes(oldCall)) source = source.replace(oldCall, newCall);
if (!source.includes('tags["tpmap:species_distribution"]')) {
  source = source.replace(
    '      if (Number.isFinite(speciesEvidence?.confidence)) tags["tpmap:species_confidence"] = String(round3(speciesEvidence.confidence));',
    '      if (Number.isFinite(speciesEvidence?.confidence)) tags["tpmap:species_confidence"] = String(round3(speciesEvidence.confidence));\n      if (Array.isArray(speciesEvidence?.distribution) && speciesEvidence.distribution.length > 1) tags["tpmap:species_distribution"] = speciesEvidence.distribution.map((entry) => `${entry.species || entry.genus || entry.leafType}:${round3(entry.weight)}`).join(",");'
  );
}
for (const required of [
  'resolveLocalSpeciesDiversity',
  'tpmap:species_distribution'
]) if (!source.includes(required)) throw new Error(`Missing diversity integration marker: ${required}`);
await writeFile(path, source);
console.log("Applied mixed woodland species diversity integration");
