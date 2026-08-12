import { readFile, writeFile } from "node:fs/promises";
const path = new URL("../src/lib/tree-generator.mjs", import.meta.url);
let source = await readFile(path, "utf8");

if (!source.includes('import { inferTreeTrunkLean, trunkAxisOffsetAt } from "./tree-trunk-lean.mjs";')) {
  source = source.replace(
    'import { inferTreeStructuralForm } from "./tree-structural-form.mjs";',
    'import { inferTreeStructuralForm } from "./tree-structural-form.mjs";\nimport { inferTreeTrunkLean, trunkAxisOffsetAt } from "./tree-trunk-lean.mjs";'
  );
}

const structuralMarker = '  const structuralForm = inferTreeStructuralForm({ heightM, crownDiameterM, species, genus, leafType, tags, reconstruction });';
if (source.includes(structuralMarker) && !source.includes('const trunkLeanRaw = inferTreeTrunkLean')) {
  source = source.replace(structuralMarker, `${structuralMarker}\n  const trunkLeanRaw = inferTreeTrunkLean({ heightM, crownDiameterM, tags, reconstruction });\n  const trunkLean = trunkLeanRaw.normalizedAt10m\n    ? { ...trunkLeanRaw, dxM: trunkLeanRaw.dxM * treeHeight / 10, dzM: trunkLeanRaw.dzM * treeHeight / 10, topShiftM: trunkLeanRaw.topShiftM * treeHeight / 10, normalizedAt10m: false }\n    : trunkLeanRaw;`);
}

source = source.replace(
  'emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius: trunkRadius, preset, seed: treeSeed, structuralForm });',
  'emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius: trunkRadius, preset, seed: treeSeed, structuralForm, trunkLean });'
);
source = source.replace(
  'preset, seed: treeSeed, detailLevel, structuralForm\n  });',
  'preset, seed: treeSeed, detailLevel, structuralForm, trunkLean\n  });'
);

source = source.replace(
  '    structuralDeadwoodFraction: structuralForm.deadwoodFraction\n  };',
  '    structuralDeadwoodFraction: structuralForm.deadwoodFraction,\n    trunkLeanSource: trunkLean.source,\n    trunkLeanConfidence: trunkLean.confidence,\n    trunkLeanTopShiftBlocks: trunkLean.topShiftM,\n    trunkLeanVectorBlocks: { x: trunkLean.dxM, z: trunkLean.dzM }\n  };'
);

source = source.replace(
  'function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm }) {',
  'function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm, trunkLean }) {'
);

const loopMarker = '  for (const stemOffset of stemOffsets) for (let dy = 1; dy <= trunkHeight; dy += 1) {\n    const t = dy / trunkHeight;';
if (source.includes(loopMarker)) {
  source = source.replace(loopMarker,
`  for (const stemOffset of stemOffsets) for (let dy = 1; dy <= trunkHeight; dy += 1) {
    const t = dy / trunkHeight;
    const axis = trunkAxisOffsetAt(trunkLean, t);
    const axisX = x + Math.round(axis.x);
    const axisZ = z + Math.round(axis.z);`);
  source = source.replaceAll(
    'put(x + stemOffset.x + dx, groundY + dy, z + stemOffset.z + dz, bark, "trunk");',
    'put(axisX + stemOffset.x + dx, groundY + dy, axisZ + stemOffset.z + dz, bark, "trunk");'
  );
}

source = source.replace(
  '    preset, seed, detailLevel, structuralForm\n  } = context;',
  '    preset, seed, detailLevel, structuralForm, trunkLean\n  } = context;'
);

const yMarker = '    const y = clamp(Math.round(crownBase + t * Math.max(1, trunkHeight - crownBase)), crownBase, treeHeight - 2);';
if (source.includes(yMarker) && !source.includes('const branchAxis = trunkAxisOffsetAt')) {
  source = source.replace(yMarker, `${yMarker}\n    const branchAxis = trunkAxisOffsetAt(trunkLean, y / Math.max(1, trunkHeight));\n    const branchOriginX = x + branchAxis.x;\n    const branchOriginZ = z + branchAxis.z;`);
}
source = source.replace(
  '      const tipX = x + Math.cos(angle) * length;\n      const tipZ = z + Math.sin(angle) * length;',
  '      const tipX = branchOriginX + Math.cos(angle) * length;\n      const tipZ = branchOriginZ + Math.sin(angle) * length;'
);
source = source.replace(
  '      emitLine(put, [x, groundY + y, z], [tipX, tipY, tipZ], preset.branches, "branch", seed ^ (tier * 131 + branch));',
  '      emitLine(put, [branchOriginX, groundY + y, branchOriginZ], [tipX, tipY, tipZ], preset.branches, "branch", seed ^ (tier * 131 + branch));'
);

for (const required of [
  'inferTreeTrunkLean',
  'trunkAxisOffsetAt',
  'trunkLeanSource:',
  'const branchAxis = trunkAxisOffsetAt',
  'axisX + stemOffset.x'
]) {
  if (!source.includes(required)) throw new Error(`Missing tree lean integration marker: ${required}`);
}
await writeFile(path, source);
console.log('Applied evidence-bounded tree trunk lean integration');
