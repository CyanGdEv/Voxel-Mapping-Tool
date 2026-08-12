import { readFile, writeFile } from "node:fs/promises";

async function patchTreeGenerator() {
  const path = new URL("../src/lib/tree-generator.mjs", import.meta.url);
  let s = await readFile(path, "utf8");
  const importOld = 'import { crownRadiusAt, resolveTreeDimensions, selectTreePreset } from "./tree-presets.mjs";';
  const importNew = `${importOld}\nimport { crownReachFromTrunk, insideCrownEnvelope, normalizeTreeReconstruction } from "./tree-reconstruction.mjs";`;
  if (!s.includes('from "./tree-reconstruction.mjs"')) s = s.replace(importOld, importNew);

  s = s.replace('  detailLevel = "high"\n}) {', '  detailLevel = "high",\n  reconstruction = null\n}) {');

  const dimsOld = `  const treeHeight = dimensions.height;\n  const crownRadius = dimensions.crownRadius;\n  const trunkHeight = clamp(Math.round(treeHeight * preset.trunkRatio), 2, treeHeight - 1);\n  const crownBase = clamp(Math.round(treeHeight * preset.branchStart), 2, treeHeight - 2);`;
  const dimsNew = `  const treeHeight = dimensions.height;\n  const crownRadius = dimensions.crownRadius;\n  const trunkHeight = clamp(Math.round(treeHeight * preset.trunkRatio), 2, treeHeight - 1);\n  const presetCrownBase = clamp(Math.round(treeHeight * preset.branchStart), 2, treeHeight - 2);\n  const crownGeometry = normalizeTreeReconstruction(reconstruction, { crownRadius, crownBase: presetCrownBase, treeHeight });\n  const crownBase = crownGeometry.crownBase;`;
  if (s.includes(dimsOld)) s = s.replace(dimsOld, dimsNew);
  else if (!s.includes("const crownGeometry = normalizeTreeReconstruction")) throw new Error("generator dimensions anchor missing");

  const envelopeOld = '    if (role !== "trunk" && Math.hypot(rx - x, rz - z) > crownRadius + 0.5) return;';
  const envelopeNew = '    if (role !== "trunk" && !insideCrownEnvelope(crownGeometry, rx - x, rz - z, 0.18)) return;';
  if (s.includes(envelopeOld)) s = s.replace(envelopeOld, envelopeNew);

  s = s.replace(
    '    put, x, z, groundY, treeHeight, trunkHeight, crownBase, crownRadius,\n    preset, seed: treeSeed, detailLevel',
    '    put, x, z, groundY, treeHeight, trunkHeight, crownBase, crownRadius, crownGeometry,\n    preset, seed: treeSeed, detailLevel'
  );
  s = s.replace(
    '    put, x, z, groundY, treeHeight, crownBase, crownRadius,\n    preset, palette, branchTips, seed: treeSeed, detailLevel',
    '    put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry,\n    preset, palette, branchTips, seed: treeSeed, detailLevel'
  );

  const returnOld = `    crownDiameterBlocks: dimensions.crownDiameter,\n    branchTips: branchTips.length`;
  const returnNew = `    crownDiameterBlocks: dimensions.crownDiameter,\n    branchTips: branchTips.length,\n    reconstructionSource: crownGeometry.source,\n    reconstructionObserved: crownGeometry.observed,\n    crownBaseObserved: crownGeometry.crownBaseObserved,\n    crownOffsetBlocks: { x: crownGeometry.offsetX, z: crownGeometry.offsetZ },\n    crownRadiiBlocks: { x: crownGeometry.radiusX, z: crownGeometry.radiusZ }`;
  if (s.includes(returnOld)) s = s.replace(returnOld, returnNew);

  s = s.replace(
    '    put, x, z, groundY, treeHeight, trunkHeight, crownBase, crownRadius,\n    preset, seed, detailLevel',
    '    put, x, z, groundY, treeHeight, trunkHeight, crownBase, crownRadius, crownGeometry,\n    preset, seed, detailLevel'
  );
  const lengthOld = '      const length = tierRadius * (0.68 + random01(seed ^ 0x9e3779b9, tier * 53 + branch) * 0.34);';
  const lengthNew = `      const measuredReach = crownReachFromTrunk(crownGeometry, angle);\n      const directionalScale = measuredReach / Math.max(0.5, crownRadius);\n      const length = tierRadius * directionalScale * (0.68 + random01(seed ^ 0x9e3779b9, tier * 53 + branch) * 0.34);`;
  if (s.includes(lengthOld)) s = s.replace(lengthOld, lengthNew);
  else if (!s.includes("const measuredReach = crownReachFromTrunk")) throw new Error("branch length anchor missing");

  s = s.replace(
    '  const { put, x, z, groundY, treeHeight, crownBase, crownRadius, preset, palette, branchTips, seed, detailLevel } = context;',
    '  const { put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry, preset, palette, branchTips, seed, detailLevel } = context;'
  );
  const axialOld = `    centres.push({ x: Math.round(x + Math.cos(angle) * distance), y, z: Math.round(z + Math.sin(angle) * distance), tier: t });`;
  const axialNew = `    const centreShift = 0.35 + 0.65 * t;\n    const localReach = crownReachFromTrunk(crownGeometry, angle);\n    const distanceScale = localReach / Math.max(0.5, crownRadius);\n    centres.push({\n      x: Math.round(x + crownGeometry.offsetX * centreShift + Math.cos(angle) * distance * distanceScale),\n      y,\n      z: Math.round(z + crownGeometry.offsetZ * centreShift + Math.sin(angle) * distance * distanceScale),\n      tier: t\n    });`;
  if (s.includes(axialOld)) s = s.replace(axialOld, axialNew);
  else if (!s.includes("const centreShift = 0.35 + 0.65 * t")) throw new Error("axial canopy anchor missing");

  const shellOld = `    const radius = crownRadiusAt(preset, t, crownRadius) * (0.72 + random01(seed, i * 5 + 1) * 0.25);\n    const angle = random01(seed, i * 5 + 2) * TAU;\n    const px = Math.round(x + Math.cos(angle) * radius);\n    const pz = Math.round(z + Math.sin(angle) * radius);`;
  const shellNew = `    const baseRadius = crownRadiusAt(preset, t, crownRadius) * (0.72 + random01(seed, i * 5 + 1) * 0.25);\n    const angle = random01(seed, i * 5 + 2) * TAU;\n    const reachScale = crownReachFromTrunk(crownGeometry, angle) / Math.max(0.5, crownRadius);\n    const radius = baseRadius * reachScale;\n    const shift = 0.35 + 0.65 * t;\n    const px = Math.round(x + crownGeometry.offsetX * shift + Math.cos(angle) * radius);\n    const pz = Math.round(z + crownGeometry.offsetZ * shift + Math.sin(angle) * radius);`;
  if (s.includes(shellOld)) s = s.replace(shellOld, shellNew);
  else if (!s.includes("const reachScale = crownReachFromTrunk")) throw new Error("canopy shell anchor missing");

  if (!s.includes("reconstructionObserved: crownGeometry.observed")) throw new Error("Tree Reconstruction V2 generator integration incomplete");
  await writeFile(path, s);
}

async function patchRaster() {
  const path = new URL("../src/lib/raster.mjs", import.meta.url);
  let s = await readFile(path, "utf8");
  s = s.replace(
    '    heightMeasuredOrTagged: 0, heightInferred: 0, crownInferred: 0,',
    '    heightMeasuredOrTagged: 0, heightInferred: 0, crownInferred: 0, crownShapeObserved: 0, crownBaseObserved: 0,'
  );
  const callOld = `      genus: evidence.genus, tags: feature.tags || {},\n      leafPalette, seed: seed ^ hashText(\`${'${feature.id}:${x}:${z}'}\`),\n      detailLevel: options.treeDetailLevel || \"high\"`;
  const callNew = `      genus: evidence.genus, tags: feature.tags || {},\n      reconstruction: evidence.reconstruction || evidence.canopyGeometry || null,\n      leafPalette, seed: seed ^ hashText(\`${'${feature.id}:${x}:${z}'}\`),\n      detailLevel: options.treeDetailLevel || \"high\"`;
  if (s.includes(callOld)) s = s.replace(callOld, callNew);
  else if (!s.includes("reconstruction: evidence.reconstruction || evidence.canopyGeometry || null")) throw new Error("raster tree reconstruction call anchor missing");
  const statsOld = `    if (!Number.isFinite(evidence.crownDiameterM)) stats.crownInferred += 1;`;
  const statsNew = `    if (!Number.isFinite(evidence.crownDiameterM)) stats.crownInferred += 1;\n    if (model.reconstructionObserved) stats.crownShapeObserved += 1;\n    if (model.crownBaseObserved) stats.crownBaseObserved += 1;`;
  if (s.includes(statsOld)) s = s.replace(statsOld, statsNew);
  if (!s.includes("stats.crownShapeObserved += 1")) throw new Error("raster reconstruction stats integration incomplete");
  await writeFile(path, s);
}

await patchTreeGenerator();
await patchRaster();
console.log("Applied Tree Reconstruction V2 live integration");
