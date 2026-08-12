import { readFile, writeFile } from "node:fs/promises";
const path = new URL("../src/lib/tree-generator.mjs", import.meta.url);
let source = await readFile(path, "utf8");

if (!source.includes('import { resolveTreeStemArchitecture, insideStemCrossSection, barkDetailBlock } from "./tree-stem-architecture.mjs";')) {
  source = source.replace(
    'import { resolveTreeDbh, dbhToVoxelProfile } from "./tree-dbh.mjs";',
    'import { resolveTreeDbh, dbhToVoxelProfile } from "./tree-dbh.mjs";\nimport { resolveTreeStemArchitecture, insideStemCrossSection, barkDetailBlock } from "./tree-stem-architecture.mjs";'
  );
}

const dbhMarker = '  const trunkProfile = dbhToVoxelProfile(dbh.dbhM, { structuralForm });';
if (source.includes(dbhMarker) && !source.includes('const stemArchitecture = resolveTreeStemArchitecture')) {
  source = source.replace(dbhMarker, `${dbhMarker}\n  const stemArchitecture = resolveTreeStemArchitecture({ dbhM: dbh.dbhM, species, genus, tags, structuralForm, seed });`);
}

source = source.replace(
  'emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius: trunkRadius, preset, seed: treeSeed, structuralForm, trunkLean, trunkProfile });',
  'emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius: trunkRadius, preset, seed: treeSeed, structuralForm, trunkLean, trunkProfile, stemArchitecture });'
);

source = source.replace(
  '    rootReachBlocks: trunkProfile.rootReachBlocks\n  };',
  '    rootReachBlocks: trunkProfile.rootReachBlocks,\n    stemArchitectureSource: stemArchitecture.source,\n    stemArchitectureObserved: stemArchitecture.observed,\n    stemCrossSection: stemArchitecture.form,\n    stemEllipticity: stemArchitecture.ellipticity,\n    stemFluting: stemArchitecture.fluting,\n    stemHollow: stemArchitecture.hollow,\n    stemHollowObserved: stemArchitecture.hollowObserved,\n    barkCharacter: stemArchitecture.barkCharacter\n  };'
);

source = source.replace(
  'function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm, trunkLean, trunkProfile }) {',
  'function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm, trunkLean, trunkProfile, stemArchitecture }) {'
);

source = source.replace(
  '  const stems = Math.max(1, Math.min(5, structuralForm?.stemCount || 1));',
  '  const stems = Math.max(1, Math.min(8, stemArchitecture?.stemCount || structuralForm?.stemCount || 1));'
);

source = source.replace(
  '        if (dx * dx + dz * dz > (localRadius + 0.25) ** 2) continue;\n        const bark = pick(preset.trunk, hash3d(x + dx, groundY + dy, z + dz, seed));',
  '        if (!insideStemCrossSection(dx, dz, localRadius + 0.25, stemArchitecture, dy)) continue;\n        const bark = barkDetailBlock({ preset, architecture: stemArchitecture, x: axisX + stemOffset.x + dx, y: groundY + dy, z: axisZ + stemOffset.z + dz, seed });'
);

const rootMarker = '  if ((trunkProfile?.baseRadiusBlocks || radius) > 0) {';
if (source.includes(rootMarker) && !source.includes('const buttressBias =')) {
  source = source.replace(rootMarker, `${rootMarker}\n    const buttressBias = stemArchitecture?.form === "irregular" || stemArchitecture?.form === "fluted" ? 2 : 0;`);
  source = source.replace(
    '    const roots = 4 + (hash3d(x, groundY, z, seed) % 3);',
    '    const roots = 4 + buttressBias + (hash3d(x, groundY, z, seed) % 3);'
  );
  source = source.replace(
    '      const maxRootReach = Math.max(1, trunkProfile?.rootReachBlocks || radius + 1);',
    '      const directionalNoise = 0.75 + random01(seed ^ 0x7f4a7c15, i + 71) * 0.65;\n      const maxRootReach = Math.max(1, Math.round((trunkProfile?.rootReachBlocks || radius + 1) * directionalNoise));'
  );
}

for (const required of [
  'resolveTreeStemArchitecture',
  'insideStemCrossSection',
  'barkDetailBlock',
  'stemCrossSection:',
  'stemHollowObserved:',
  'const buttressBias ='
]) {
  if (!source.includes(required)) throw new Error(`Missing stem architecture integration marker: ${required}`);
}
await writeFile(path, source);
console.log('Applied evidence-bounded tree stem architecture');
