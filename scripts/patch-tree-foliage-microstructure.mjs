import { readFile, writeFile } from "node:fs/promises";
const path = new URL("../src/lib/tree-generator.mjs", import.meta.url);
let source = await readFile(path, "utf8");

if (!source.includes('import { resolveTreeFoliageMicrostructure, foliagePadRadii, shouldKeepFoliageCell, foliageCurtainLength } from "./tree-foliage-microstructure.mjs";')) {
  source = source.replace(
    'import { resolveTreeBranchArchitecture, branchRadiusAt, junctionRadius } from "./tree-branch-architecture.mjs";',
    'import { resolveTreeBranchArchitecture, branchRadiusAt, junctionRadius } from "./tree-branch-architecture.mjs";\nimport { resolveTreeFoliageMicrostructure, foliagePadRadii, shouldKeepFoliageCell, foliageCurtainLength } from "./tree-foliage-microstructure.mjs";'
  );
}

const branchMarker = '  const branchArchitecture = resolveTreeBranchArchitecture({ dbhM: dbh.dbhM, species, genus, structuralForm, preset, tags });';
if (source.includes(branchMarker) && !source.includes('const foliageMicrostructure = resolveTreeFoliageMicrostructure')) {
  source = source.replace(branchMarker, `${branchMarker}\n  const foliageMicrostructure = resolveTreeFoliageMicrostructure({ preset, species, genus, leafType, structuralForm, reconstruction, tags });`);
}

source = source.replace(
'    preset, palette, branchTips, seed: treeSeed, detailLevel, structuralForm\n  });',
'    preset, palette, branchTips, seed: treeSeed, detailLevel, structuralForm, foliageMicrostructure\n  });'
);

source = source.replace(
'  if (preset.crownShape === "weeping") {\n    emitWeepingCurtains({ put, groundY, treeHeight, crownBase, branchTips, palette, seed: treeSeed });\n  }',
'  if ((foliageMicrostructure?.hangingFraction || 0) > 0) {\n    emitWeepingCurtains({ put, groundY, treeHeight, crownBase, branchTips, palette, seed: treeSeed, foliageMicrostructure });\n  }'
);

source = source.replace(
'    branchForked: branchArchitecture.forked\n  };',
'    branchForked: branchArchitecture.forked,\n    foliageMicrostructureSource: foliageMicrostructure.source,\n    foliageMicrostructureObserved: foliageMicrostructure.observed,\n    foliagePadStyle: foliageMicrostructure.padStyle,\n    foliageDensity: foliageMicrostructure.density,\n    foliageGapFraction: foliageMicrostructure.gapFraction,\n    foliageHangingFraction: foliageMicrostructure.hangingFraction\n  };'
);

const oldHeader = 'function emitCanopyClusters(context) {\n  const { put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry, preset, palette, branchTips, seed, detailLevel, structuralForm } = context;\n  const clusterScale = detailLevel === "medium" ? 0.85 : 1;\n  const crownHeight = Math.max(2, treeHeight - crownBase + 1);\n  const centres = [...branchTips];\n  const axialClusters = clamp(Math.round(crownHeight * 0.72), 3, 14);';
const newHeader = 'function emitCanopyClusters(context) {\n  const { put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry, preset, palette, branchTips, seed, detailLevel, structuralForm, foliageMicrostructure } = context;\n  const clusterScale = detailLevel === "medium" ? 0.82 : 1;\n  const crownHeight = Math.max(2, treeHeight - crownBase + 1);\n  const liveTipFraction = clamp(Number(foliageMicrostructure?.liveTipFraction) || 1, 0.45, 1);\n  const centres = branchTips.filter((tip, index) => random01(seed ^ 0x6ac690c5, index + 700) <= liveTipFraction);\n  const scaffoldFraction = clamp(Number(foliageMicrostructure?.scaffoldFraction) || 0.1, 0.05, 0.28);\n  const axialClusters = clamp(Math.round(crownHeight * scaffoldFraction), 1, 5);';
if (!source.includes(oldHeader)) throw new Error('Canopy header marker not found');
source = source.replace(oldHeader, newHeader);

const oldRadii = `    const radiusX = clamp(Math.round((1.25 + random01(seed, index * 3) * 1.4) * clusterScale), 1, Math.max(1, Math.ceil(silhouetteRadius * 0.5)));
    const radiusZ = clamp(Math.round((1.25 + random01(seed, index * 3 + 1) * 1.4) * clusterScale), 1, Math.max(1, Math.ceil(silhouetteRadius * 0.5)));
    const radiusY = clamp(Math.round((1 + random01(seed, index * 3 + 2) * 1.4) * clusterScale), 1, 3);
    emitOrganicLeafCluster({ put, centre, radiusX, radiusY, radiusZ, palette, density: Math.min(0.98, preset.canopyDensity * (structuralForm?.canopyDensityScale || 1)), seed: seed ^ index * 2654435761 });`;
const newRadii = `    const pad = foliagePadRadii(foliageMicrostructure, Math.max(1, silhouetteRadius), seed, index);
    const radiusX = clamp(Math.round(pad.radiusX * clusterScale), 1, Math.max(1, Math.ceil(silhouetteRadius * 0.5)));
    const radiusZ = clamp(Math.round(pad.radiusZ * clusterScale), 1, Math.max(1, Math.ceil(silhouetteRadius * 0.5)));
    const radiusY = clamp(Math.round(pad.radiusY * clusterScale), 1, 4);
    emitOrganicLeafCluster({ put, centre, radiusX, radiusY, radiusZ, palette, micro: foliageMicrostructure, seed: seed ^ index * 2654435761 });`;
if (!source.includes(oldRadii)) throw new Error('Leaf pad radius marker not found');
source = source.replace(oldRadii, newRadii);

source = source.replace(
'  const shellSamples = clamp(Math.round(crownRadius * 8), 12, 80);',
'  const shellSamples = clamp(Math.round(crownRadius * (detailLevel === "medium" ? 2.2 : 3.2)), 6, 34);'
);
source = source.replace(
'    put(px, y, pz, pick(palette, hash3d(px, y, pz, seed)), "leaf");',
'    const shellRough = (hash3d(px, y, pz, seed ^ 0x27d4eb2d) % 1000) / 1000;\n    if (shellRough > (foliageMicrostructure?.density || 0.75)) continue;\n    put(px, y, pz, pick(palette, hash3d(px, y, pz, seed)), "leaf");'
);

const oldCluster = `function emitOrganicLeafCluster({ put, centre, radiusX, radiusY, radiusZ, palette, density, seed }) {
  for (let dy = -radiusY; dy <= radiusY; dy += 1) {
    for (let dz = -radiusZ; dz <= radiusZ; dz += 1) {
      for (let dx = -radiusX; dx <= radiusX; dx += 1) {
        const normalized = (dx / (radiusX + 0.25)) ** 2 + (dy / (radiusY + 0.25)) ** 2 + (dz / (radiusZ + 0.25)) ** 2;
        const rough = (hash3d(centre.x + dx, centre.y + dy, centre.z + dz, seed) % 1000) / 1000;
        const threshold = 1.06 + (rough - 0.5) * 0.34;
        if (normalized > threshold) continue;
        if (normalized < 0.34 && rough > density + 0.10) continue;
        if (normalized >= 0.34 && rough > density) continue;
        const px = centre.x + dx, py = centre.y + dy, pz = centre.z + dz;
        put(px, py, pz, pick(palette, hash3d(px, py, pz, seed)), "leaf");
      }
    }
  }
}`;
const newCluster = `function emitOrganicLeafCluster({ put, centre, radiusX, radiusY, radiusZ, palette, micro, seed }) {
  for (let dy = -radiusY; dy <= radiusY; dy += 1) {
    for (let dz = -radiusZ; dz <= radiusZ; dz += 1) {
      for (let dx = -radiusX; dx <= radiusX; dx += 1) {
        const normalized = (dx / (radiusX + 0.25)) ** 2 + (dy / (radiusY + 0.25)) ** 2 + (dz / (radiusZ + 0.25)) ** 2;
        const rough = (hash3d(centre.x + dx, centre.y + dy, centre.z + dz, seed) % 1000) / 1000;
        if (!shouldKeepFoliageCell({ normalized, rough, micro, edgeBias: (rough - 0.5) * 0.12 })) continue;
        const px = centre.x + dx, py = centre.y + dy, pz = centre.z + dz;
        put(px, py, pz, pick(palette, hash3d(px, py, pz, seed)), "leaf");
      }
    }
  }
}`;
if (!source.includes(oldCluster)) throw new Error('Organic cluster marker not found');
source = source.replace(oldCluster, newCluster);

source = source.replace(
'function emitWeepingCurtains({ put, groundY, treeHeight, crownBase, branchTips, palette, seed }) {',
'function emitWeepingCurtains({ put, groundY, treeHeight, crownBase, branchTips, palette, seed, foliageMicrostructure }) {'
);
source = source.replace(
'    const length = clamp(2 + hash3d(tip.x, tip.y, tip.z, seed) % 5, 2, Math.max(2, Math.round(treeHeight * 0.34)));',
'    const length = foliageCurtainLength(foliageMicrostructure, treeHeight, seed, i);\n    if (length <= 0) continue;'
);

for (const required of [
  'resolveTreeFoliageMicrostructure', 'foliagePadRadii', 'shouldKeepFoliageCell', 'foliageCurtainLength',
  'foliagePadStyle:', 'const scaffoldFraction =', 'const liveTipFraction ='
]) if (!source.includes(required)) throw new Error(`Missing foliage integration marker: ${required}`);

await writeFile(path, source);
console.log('Applied branch-anchored foliage microstructure V2');
