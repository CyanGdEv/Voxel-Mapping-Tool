import { readFile, writeFile } from "node:fs/promises";
const path = new URL("../src/lib/tree-generator.mjs", import.meta.url);
let source = await readFile(path, "utf8");
if (!source.includes('import { inferTreeStructuralForm } from "./tree-structural-form.mjs";')) {
  source = source.replace(
    'import { crownReachFromTrunk, insideCrownEnvelope, normalizeTreeReconstruction } from "./tree-reconstruction.mjs";',
    'import { crownReachFromTrunk, insideCrownEnvelope, normalizeTreeReconstruction } from "./tree-reconstruction.mjs";\nimport { inferTreeStructuralForm } from "./tree-structural-form.mjs";'
  );
}
const crownMarker = '  const crownGeometry = normalizeTreeReconstruction(reconstruction, { crownRadius, crownBase: presetCrownBase, treeHeight });\n  const crownBase = crownGeometry.crownBase;';
if (source.includes(crownMarker) && !source.includes('const structuralForm = inferTreeStructuralForm')) {
  source = source.replace(crownMarker, `${crownMarker}\n  const structuralForm = inferTreeStructuralForm({ heightM, crownDiameterM, species, genus, leafType, tags, reconstruction });`);
}
source = source.replace(
`  const trunkRadius = treeHeight >= 24 || crownDiameterM >= 15 ? 2
    : treeHeight >= 14 || crownDiameterM >= 9 ? 1 : 0;
  emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius: trunkRadius, preset, seed: treeSeed });`,
`  const baseTrunkRadius = treeHeight >= 24 || crownDiameterM >= 15 ? 2
    : treeHeight >= 14 || crownDiameterM >= 9 ? 1 : 0;
  const trunkRadius = clamp(Math.round((baseTrunkRadius + 1) * structuralForm.trunkScale) - 1, 0, 3);
  emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius: trunkRadius, preset, seed: treeSeed, structuralForm });`
);
source = source.replace(
'    preset, seed: treeSeed, detailLevel\n  });',
'    preset, seed: treeSeed, detailLevel, structuralForm\n  });'
);
source = source.replace(
'    preset, palette, branchTips, seed: treeSeed, detailLevel\n  });',
'    preset, palette, branchTips, seed: treeSeed, detailLevel, structuralForm\n  });'
);
source = source.replace(
'    crownRadiiBlocks: { x: crownGeometry.radiusX, z: crownGeometry.radiusZ }\n  };',
'    crownRadiiBlocks: { x: crownGeometry.radiusX, z: crownGeometry.radiusZ },\n    structuralForm: structuralForm.form,\n    structuralFormConfidence: structuralForm.confidence,\n    structuralStemCount: structuralForm.stemCount,\n    structuralDeadwoodFraction: structuralForm.deadwoodFraction\n  };'
);
source = source.replace(
'function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed }) {',
'function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm }) {'
);
const trunkStart = 'function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm }) {\n  for (let dy = 1; dy <= trunkHeight; dy += 1) {';
if (source.includes(trunkStart)) {
  source = source.replace(trunkStart,
`function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm }) {
  const stems = Math.max(1, Math.min(5, structuralForm?.stemCount || 1));
  const stemOffsets = [{ x: 0, z: 0 }];
  for (let stem = 1; stem < stems; stem += 1) {
    const angle = (stem / stems) * TAU + random01(seed, 900 + stem) * 0.45;
    stemOffsets.push({ x: Math.round(Math.cos(angle)), z: Math.round(Math.sin(angle)) });
  }
  for (const stemOffset of stemOffsets) for (let dy = 1; dy <= trunkHeight; dy += 1) {`);
  source = source.replace(
'      }\n    }\n  }\n  if (radius > 0) {',
'      }\n    }\n  }\n  if (radius > 0) {'
  );
  source = source.replaceAll('put(x + dx, groundY + dy, z + dz, bark, "trunk");', 'put(x + stemOffset.x + dx, groundY + dy, z + stemOffset.z + dz, bark, "trunk");');
}
source = source.replace(
'    preset, seed, detailLevel\n  } = context;',
'    preset, seed, detailLevel, structuralForm\n  } = context;'
);
source = source.replace(
'      const length = tierRadius * directionalScale * (0.68 + random01(seed ^ 0x9e3779b9, tier * 53 + branch) * 0.34);',
'      const length = tierRadius * directionalScale * (0.68 + random01(seed ^ 0x9e3779b9, tier * 53 + branch) * 0.34) * (structuralForm?.branchScale || 1);'
);
source = source.replace(
'  const { put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry, preset, palette, branchTips, seed, detailLevel } = context;',
'  const { put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry, preset, palette, branchTips, seed, detailLevel, structuralForm } = context;'
);
source = source.replace(
'    emitOrganicLeafCluster({ put, centre, radiusX, radiusY, radiusZ, palette, density: preset.canopyDensity, seed: seed ^ index * 2654435761 });',
'    emitOrganicLeafCluster({ put, centre, radiusX, radiusY, radiusZ, palette, density: Math.min(0.98, preset.canopyDensity * (structuralForm?.canopyDensityScale || 1)), seed: seed ^ index * 2654435761 });'
);
if (!source.includes('emitStructuralDeadwood({')) {
  source = source.replace(
'  if (preset.crownShape === "weeping") {\n    emitWeepingCurtains({ put, groundY, treeHeight, crownBase, branchTips, palette, seed: treeSeed });\n  }',
'  if (preset.crownShape === "weeping") {\n    emitWeepingCurtains({ put, groundY, treeHeight, crownBase, branchTips, palette, seed: treeSeed });\n  }\n  emitStructuralDeadwood({ put, branchTips, preset, structuralForm, seed: treeSeed });'
  );
  const marker = 'function emitWeepingCurtains(';
  const helper = `function emitStructuralDeadwood({ put, branchTips, preset, structuralForm, seed }) {
  const fraction = Number(structuralForm?.deadwoodFraction) || 0;
  if (fraction <= 0 || !branchTips.length) return;
  const count = Math.min(branchTips.length, Math.max(1, Math.round(branchTips.length * fraction)));
  const ordered = [...branchTips].sort((a, b) => hash3d(a.x, a.y, a.z, seed ^ 0x6d2b79f5) - hash3d(b.x, b.y, b.z, seed ^ 0x6d2b79f5));
  for (let i = 0; i < count; i += 1) {
    const tip = ordered[i];
    const length = 1 + (hash3d(tip.x, tip.y, tip.z, seed) % 3);
    emitLine(put, [tip.x, tip.y, tip.z], [tip.x, tip.y - length, tip.z], preset.branches, "twig", seed ^ i ^ 0x27d4eb2d);
  }
}

`;
  if (!source.includes(marker)) throw new Error('Missing weeping curtain marker');
  source = source.replace(marker, helper + marker);
}
for (const required of ['inferTreeStructuralForm', 'structuralForm:', 'emitStructuralDeadwood', 'structuralForm?.canopyDensityScale']) {
  if (!source.includes(required)) throw new Error(`Missing tree structural integration marker: ${required}`);
}
await writeFile(path, source);
console.log('Applied tree structural-form integration');
