import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../src/lib/fidelity.mjs", import.meta.url);
let s = await readFile(path, "utf8");

const importAnchor = 'import { polygonArea } from "./geo.mjs";';
const importLine = 'import { reconstructTreeCrownFromSamples } from "./tree-reconstruction.mjs";';
if (!s.includes(importLine)) {
  if (!s.includes(importAnchor)) throw new Error("fidelity import anchor missing");
  s = s.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const heightBlock = `  if (heightM === null && point && typeof sources.elevation?.samplePairLocal === "function") {\n    const pair = sources.elevation.samplePairLocal(point[0], point[1]);\n    const measured = Number.isFinite(pair?.surface) && Number.isFinite(pair?.terrain) ? pair.surface - pair.terrain : null;\n    if (Number.isFinite(measured) && measured >= 2 && measured <= 60) {\n      heightM = round1(measured);\n      heightSource = "dsm-minus-dtm-at-mapped-tree";\n      confidence = 0.72;\n    }\n  }`;
const reconstructionBlock = `${heightBlock}\n\n  const reconstruction = point && modelClass === "tree"\n    ? deriveTreeCrownReconstruction({ point, crownDiameter, heightM, elevation: sources.elevation, options })\n    : null;\n  if (crownDiameter === null && reconstruction) {\n    crownDiameter = round1(Math.max(\n      reconstruction.westM + reconstruction.eastM,\n      reconstruction.northM + reconstruction.southM\n    ));\n    crownSource = "dsm-dtm-connected-canopy";\n  }`;
if (s.includes(heightBlock)) s = s.replace(heightBlock, reconstructionBlock);
else if (!s.includes("const reconstruction = point && modelClass === \"tree\"")) throw new Error("tree height block anchor missing");

const returnAnchor = `    crownDiameterM: crownDiameter,\n    crownSource,`;
const returnReplacement = `    crownDiameterM: crownDiameter,\n    crownSource,\n    reconstruction,\n    crownShapeSource: reconstruction?.source || null,\n    crownShapeSampleCount: reconstruction?.sampleCount || 0,\n    crownBaseHeightM: reconstruction?.crownBaseHeightM ?? null,`;
if (s.includes(returnAnchor)) s = s.replace(returnAnchor, returnReplacement);
else if (!s.includes("crownShapeSampleCount")) throw new Error("tree evidence return anchor missing");

const helperAnchor = `function vegetationModelClass(feature) {`;
const helper = `function deriveTreeCrownReconstruction({ point, crownDiameter, heightM, elevation, options }) {\n  if (typeof elevation?.samplePairLocal !== "function") return null;\n  const resolutionM = Math.max(0.25, Math.min(2, Number(elevation.resolutionM) || 1));\n  const sampleStepM = Math.max(0.5, Number(options.treeCrownSampleStepM ?? Math.min(1, resolutionM)));\n  const observedRadius = Number.isFinite(crownDiameter) ? crownDiameter / 2 : null;\n  const heightRadius = Number.isFinite(heightM) ? Math.max(4, Math.min(14, heightM * 0.55)) : 7;\n  const searchRadiusM = Math.max(3, Math.min(20, Number(\n    options.treeCrownSearchRadiusM ?? (observedRadius ? observedRadius + Math.max(2, sampleStepM * 2) : heightRadius)\n  )));\n  const samples = [];\n  for (let dz = -searchRadiusM; dz <= searchRadiusM + 1e-9; dz += sampleStepM) {\n    for (let dx = -searchRadiusM; dx <= searchRadiusM + 1e-9; dx += sampleStepM) {\n      if (dx * dx + dz * dz > searchRadiusM * searchRadiusM) continue;\n      const x = point[0] + dx, z = point[1] + dz;\n      const pair = elevation.samplePairLocal(x, z);\n      if (!Number.isFinite(pair?.surface) || !Number.isFinite(pair?.terrain)) continue;\n      samples.push({ x, z, surfaceM: pair.surface, groundM: pair.terrain });\n    }\n  }\n  const reconstruction = reconstructTreeCrownFromSamples({\n    x: point[0], z: point[1], samples, cellSizeM: sampleStepM,\n    minCanopyHeightM: Math.max(1.5, Number(options.treeMinCanopyHeightM ?? 2)),\n    maxSeedDistanceM: Math.max(2, Number(options.treeCrownSeedDistanceM ?? 3))\n  });\n  if (!reconstruction) return null;\n\n  // A tagged/mapped crown diameter is higher-authority horizontal evidence than\n  // a DSM segmentation edge. Preserve its outer diameter while retaining the\n  // LiDAR-derived asymmetry and centre offset as a normalized directional shape.\n  if (Number.isFinite(crownDiameter) && crownDiameter > 0) {\n    const measuredDiameter = Math.max(\n      reconstruction.westM + reconstruction.eastM,\n      reconstruction.northM + reconstruction.southM\n    );\n    if (measuredDiameter > crownDiameter && measuredDiameter > 0) {\n      const scale = crownDiameter / measuredDiameter;\n      for (const key of ["westM", "eastM", "northM", "southM", "radiusXM", "radiusZM", "offsetXM", "offsetZM"]) {\n        if (Number.isFinite(reconstruction[key])) reconstruction[key] = round3(reconstruction[key] * scale);\n      }\n      reconstruction.horizontalEnvelopeClampedToMappedCrown = true;\n    }\n  }\n  return reconstruction;\n}\n\n${helperAnchor}`;
if (!s.includes("function deriveTreeCrownReconstruction")) {
  if (!s.includes(helperAnchor)) throw new Error("vegetation helper anchor missing");
  s = s.replace(helperAnchor, helper);
}

if (!s.includes("reconstructTreeCrownFromSamples") || !s.includes("crownShapeSampleCount")) {
  throw new Error("LiDAR tree reconstruction evidence integration incomplete");
}
await writeFile(path, s);
console.log("Applied automatic DSM-DTM crown reconstruction to tree evidence fusion");
