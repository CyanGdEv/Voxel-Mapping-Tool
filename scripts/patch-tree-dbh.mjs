import { readFile, writeFile } from "node:fs/promises";
const path = new URL("../src/lib/tree-generator.mjs", import.meta.url);
let source = await readFile(path, "utf8");
if (!source.includes('import { resolveTreeDbh, dbhToVoxelProfile } from "./tree-dbh.mjs";')) {
  source = source.replace(
    'import { inferTreeTrunkLean, trunkAxisOffsetAt } from "./tree-trunk-lean.mjs";',
    'import { inferTreeTrunkLean, trunkAxisOffsetAt } from "./tree-trunk-lean.mjs";\nimport { resolveTreeDbh, dbhToVoxelProfile } from "./tree-dbh.mjs";'
  );
}
const marker = '  const structuralForm = inferTreeStructuralForm({ heightM, crownDiameterM, species, genus, leafType, tags, reconstruction });';
if (source.includes(marker) && !source.includes('const dbh = resolveTreeDbh')) {
  source = source.replace(marker, `${marker}\n  const dbh = resolveTreeDbh({ heightM, crownDiameterM, species, genus, leafType, tags, structuralForm });\n  const trunkProfile = dbhToVoxelProfile(dbh.dbhM, { structuralForm });`);
}
source = source.replace(
`  const baseTrunkRadius = treeHeight >= 24 || crownDiameterM >= 15 ? 2
    : treeHeight >= 14 || crownDiameterM >= 9 ? 1 : 0;
  const trunkRadius = clamp(Math.round((baseTrunkRadius + 1) * structuralForm.trunkScale) - 1, 0, 3);`,
`  const trunkRadius = clamp(Math.max(trunkProfile.breastRadiusBlocks, Math.round(trunkProfile.breastRadiusBlocks * structuralForm.trunkScale)), 0, 3);`
);
source = source.replace(
'emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius: trunkRadius, preset, seed: treeSeed, structuralForm, trunkLean });',
'emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius: trunkRadius, preset, seed: treeSeed, structuralForm, trunkLean, trunkProfile });'
);
source = source.replace(
'    preset, seed: treeSeed, detailLevel, structuralForm, trunkLean\n  });',
'    preset, seed: treeSeed, detailLevel, structuralForm, trunkLean, trunkProfile\n  });'
);
source = source.replace(
'    trunkLeanVectorBlocks: { x: trunkLean.dxM, z: trunkLean.dzM }\n  };',
'    trunkLeanVectorBlocks: { x: trunkLean.dxM, z: trunkLean.dzM },\n    dbhSource: dbh.source,\n    dbhObserved: dbh.observed,\n    dbhM: dbh.dbhM,\n    dbhConfidence: dbh.confidence,\n    trunkBaseRadiusBlocks: trunkProfile.baseRadiusBlocks,\n    rootReachBlocks: trunkProfile.rootReachBlocks\n  };'
);
source = source.replace(
'function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm, trunkLean }) {',
'function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm, trunkLean, trunkProfile }) {'
);
source = source.replace(
'    const localRadius = t > 0.72 ? Math.max(0, radius - 1) : radius;',
'    const localRadius = t < 0.18 ? Math.max(radius, trunkProfile?.baseRadiusBlocks || radius) : t > 0.72 ? Math.min(radius, trunkProfile?.upperRadiusBlocks ?? Math.max(0, radius - 1)) : radius;'
);
source = source.replace(
'  if (radius > 0) {',
'  if ((trunkProfile?.baseRadiusBlocks || radius) > 0) {'
);
source = source.replace(
'      const length = 1 + (hash3d(x + i, groundY, z - i, seed) % Math.max(1, radius + 1));',
'      const maxRootReach = Math.max(1, trunkProfile?.rootReachBlocks || radius + 1);\n      const length = 1 + (hash3d(x + i, groundY, z - i, seed) % maxRootReach);'
);
source = source.replace(
'    preset, seed, detailLevel, structuralForm, trunkLean\n  } = context;',
'    preset, seed, detailLevel, structuralForm, trunkLean, trunkProfile\n  } = context;'
);
source = source.replace(
'      emitLine(put, [branchOriginX, groundY + y, branchOriginZ], [tipX, tipY, tipZ], preset.branches, "branch", seed ^ (tier * 131 + branch));',
'      emitLine(put, [branchOriginX, groundY + y, branchOriginZ], [tipX, tipY, tipZ], preset.branches, "branch", seed ^ (tier * 131 + branch));\n      if ((trunkProfile?.majorLimbRadiusBlocks || 0) > 0) {\n        const thickEnd = [branchOriginX + (tipX - branchOriginX) * 0.38, groundY + y + (tipY - (groundY + y)) * 0.38, branchOriginZ + (tipZ - branchOriginZ) * 0.38];\n        for (let ox = -trunkProfile.majorLimbRadiusBlocks; ox <= trunkProfile.majorLimbRadiusBlocks; ox += 1) for (let oz = -trunkProfile.majorLimbRadiusBlocks; oz <= trunkProfile.majorLimbRadiusBlocks; oz += 1) {\n          if (ox * ox + oz * oz > trunkProfile.majorLimbRadiusBlocks ** 2) continue;\n          emitLine(put, [branchOriginX + ox, groundY + y, branchOriginZ + oz], [thickEnd[0] + ox, thickEnd[1], thickEnd[2] + oz], preset.branches, "branch", seed ^ (tier * 313 + branch * 7 + ox * 3 + oz));\n        }\n      }'
);
for (const required of ['resolveTreeDbh', 'dbhToVoxelProfile', 'dbhSource:', 'trunkProfile?.baseRadiusBlocks', 'majorLimbRadiusBlocks']) {
  if (!source.includes(required)) throw new Error(`Missing DBH integration marker: ${required}`);
}
await writeFile(path, source);
console.log('Applied DBH-driven tree geometry');
