import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('../src/lib/tree-generator.mjs', import.meta.url);
let source = await readFile(path, 'utf8');

if (!source.includes('import { resolveTreeFineDetail, pickFineTwigBlock, shouldEmitFineDetail, tertiaryTwigVector } from "./tree-fine-detail.mjs";')) {
  source = source.replace(
    'import { resolveTreeFoliageMicrostructure, foliagePadRadii, shouldKeepFoliageCell, foliageCurtainLength } from "./tree-foliage-microstructure.mjs";',
    'import { resolveTreeFoliageMicrostructure, foliagePadRadii, shouldKeepFoliageCell, foliageCurtainLength } from "./tree-foliage-microstructure.mjs";\nimport { resolveTreeFineDetail, pickFineTwigBlock, shouldEmitFineDetail, tertiaryTwigVector } from "./tree-fine-detail.mjs";'
  );
}

const foliageMarker = '  const foliageMicrostructure = resolveTreeFoliageMicrostructure({ preset, species, genus, leafType, structuralForm, reconstruction, tags });';
if (source.includes(foliageMarker) && !source.includes('const fineDetail = resolveTreeFineDetail')) {
  source = source.replace(foliageMarker, `${foliageMarker}\n  const fineDetail = resolveTreeFineDetail({ preset, detailLevel, family: preset.family, structuralForm });`);
}

source = source.replace(
  '    preset, seed: treeSeed, detailLevel, structuralForm, trunkLean, trunkProfile, branchArchitecture\n  });',
  '    preset, seed: treeSeed, detailLevel, structuralForm, trunkLean, trunkProfile, branchArchitecture, fineDetail\n  });'
);
source = source.replace(
  '    preset, palette, branchTips, seed: treeSeed, detailLevel, structuralForm, foliageMicrostructure\n  });',
  '    preset, palette, branchTips, seed: treeSeed, detailLevel, structuralForm, foliageMicrostructure, fineDetail\n  });'
);
source = source.replace(
  '    foliageHangingFraction: foliageMicrostructure.hangingFraction\n  };',
  '    foliageHangingFraction: foliageMicrostructure.hangingFraction,\n    fineDetailEnabled: fineDetail.enabled,\n    fineDetailTerminalChance: fineDetail.terminalChance,\n    fineDetailEdgeChance: fineDetail.edgeChance\n  };'
);

source = source.replace(
  '    preset, seed, detailLevel, structuralForm, trunkLean, trunkProfile, branchArchitecture\n  } = context;',
  '    preset, seed, detailLevel, structuralForm, trunkLean, trunkProfile, branchArchitecture, fineDetail\n  } = context;'
);
source = source.replace(
  'if (detailLevel !== "low") emitSecondaryTwigs({ put, tip, preset, crownRadius, seed: seed ^ hashText(`${tier}:${branch}`), branchArchitecture });',
  'if (detailLevel !== "low") emitSecondaryTwigs({ put, tip, preset, crownRadius, seed: seed ^ hashText(`${tier}:${branch}`), branchArchitecture, fineDetail });'
);
source = source.replace(
  'function emitSecondaryTwigs({ put, tip, preset, crownRadius, seed, branchArchitecture }) {',
  'function emitSecondaryTwigs({ put, tip, preset, crownRadius, seed, branchArchitecture, fineDetail }) {'
);

const oldTwigLine = '    emitTaperedLimb({ put, start: [tip.x, tip.y, tip.z], end, palette: preset.twigs, role: "twig", seed: seed ^ child, architecture: branchArchitecture, generation: 1 });';
const newTwigLine = `${oldTwigLine}\n    const endX = Math.round(end[0]), endY = Math.round(end[1]), endZ = Math.round(end[2]);\n    if (shouldEmitFineDetail(fineDetail, { kind: "terminal", seed: seed ^ child ^ 0x51f15e })) {\n      const terminal = pickFineTwigBlock(fineDetail, { phase: "terminal", seed: seed ^ child });\n      if (terminal) put(endX, endY, endZ, terminal, "twig");\n    }\n    if (shouldEmitFineDetail(fineDetail, { kind: "tertiary", seed: seed ^ child ^ 0x9e3779b9 })) {\n      const v = tertiaryTwigVector({ angle, seed: seed ^ child ^ 0x85ebca6b, family: preset.family });\n      const tertiaryEnd = [endX + Math.cos(v.angle) * v.length, endY + v.dy, endZ + Math.sin(v.angle) * v.length];\n      const tertiaryBlock = pickFineTwigBlock(fineDetail, { phase: "run", seed: seed ^ child ^ 0xc2b2ae35 });\n      if (tertiaryBlock) emitLine(put, [endX, endY, endZ], tertiaryEnd, [tertiaryBlock], "twig", seed ^ child ^ 0x27d4eb2d);\n    }`;
if (!source.includes(oldTwigLine)) throw new Error('Secondary twig marker missing');
source = source.replace(oldTwigLine, newTwigLine);

source = source.replace(
  '  const { put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry, preset, palette, branchTips, seed, detailLevel, structuralForm, foliageMicrostructure } = context;',
  '  const { put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry, preset, palette, branchTips, seed, detailLevel, structuralForm, foliageMicrostructure, fineDetail } = context;'
);

const shellPut = '    put(px, y, pz, pick(palette, hash3d(px, y, pz, seed)), "leaf");';
const shellReplacement = `    if (shouldEmitFineDetail(fineDetail, { kind: "edge", seed: hash3d(px, y, pz, seed) })) {\n      const edge = pickFineTwigBlock(fineDetail, { phase: "edge", seed: hash3d(px, y, pz, seed ^ 0x7f4a7c15) });\n      if (edge) { put(px, y, pz, edge, "twig"); continue; }\n    }\n${shellPut}`;
if (!source.includes(shellPut)) throw new Error('Shell leaf put marker missing');
source = source.replace(shellPut, shellReplacement);

for (const required of ['resolveTreeFineDetail','pickFineTwigBlock','shouldEmitFineDetail','tertiaryTwigVector','fineDetailEnabled:','const tertiaryEnd =']) {
  if (!source.includes(required)) throw new Error(`Missing fine-detail integration marker: ${required}`);
}
await writeFile(path, source);
console.log('Applied fine twig and canopy-edge detailing V3');
