import { readFile, writeFile } from "node:fs/promises";
const path = new URL("../src/lib/tree-generator.mjs", import.meta.url);
let source = await readFile(path, "utf8");

if (!source.includes('import { resolveTreeBranchArchitecture, branchRadiusAt, junctionRadius } from "./tree-branch-architecture.mjs";')) {
  source = source.replace(
    'import { resolveTreeStemArchitecture, insideStemCrossSection, barkDetailBlock } from "./tree-stem-architecture.mjs";',
    'import { resolveTreeStemArchitecture, insideStemCrossSection, barkDetailBlock } from "./tree-stem-architecture.mjs";\nimport { resolveTreeBranchArchitecture, branchRadiusAt, junctionRadius } from "./tree-branch-architecture.mjs";'
  );
}

const archMarker = '  const stemArchitecture = resolveTreeStemArchitecture({ dbhM: dbh.dbhM, species, genus, tags, structuralForm, seed });';
if (source.includes(archMarker) && !source.includes('const branchArchitecture = resolveTreeBranchArchitecture')) {
  source = source.replace(archMarker, `${archMarker}\n  const branchArchitecture = resolveTreeBranchArchitecture({ dbhM: dbh.dbhM, species, genus, structuralForm, preset, tags });`);
}
source = source.replace(
  '    preset, seed: treeSeed, detailLevel, structuralForm, trunkLean, trunkProfile\n  });',
  '    preset, seed: treeSeed, detailLevel, structuralForm, trunkLean, trunkProfile, branchArchitecture\n  });'
);
source = source.replace(
  '    barkCharacter: stemArchitecture.barkCharacter\n  };',
  '    barkCharacter: stemArchitecture.barkCharacter,\n    branchArchitectureSource: branchArchitecture.source,\n    branchArchitectureObserved: branchArchitecture.observed,\n    primaryBranchDiameterM: branchArchitecture.primaryDiameterM,\n    primaryBranchRadiusBlocks: branchArchitecture.primaryRadiusBlocks,\n    secondaryBranchRadiusBlocks: branchArchitecture.secondaryRadiusBlocks,\n    tertiaryBranchRadiusBlocks: branchArchitecture.tertiaryRadiusBlocks,\n    branchForked: branchArchitecture.forked\n  };'
);
source = source.replace(
  '    preset, seed, detailLevel, structuralForm, trunkLean, trunkProfile\n  } = context;',
  '    preset, seed, detailLevel, structuralForm, trunkLean, trunkProfile, branchArchitecture\n  } = context;'
);

const oldMajor = `      emitLine(put, [branchOriginX, groundY + y, branchOriginZ], [tipX, tipY, tipZ], preset.branches, "branch", seed ^ (tier * 131 + branch));
      if ((trunkProfile?.majorLimbRadiusBlocks || 0) > 0) {
        const thickEnd = [branchOriginX + (tipX - branchOriginX) * 0.38, groundY + y + (tipY - (groundY + y)) * 0.38, branchOriginZ + (tipZ - branchOriginZ) * 0.38];
        for (let ox = -trunkProfile.majorLimbRadiusBlocks; ox <= trunkProfile.majorLimbRadiusBlocks; ox += 1) for (let oz = -trunkProfile.majorLimbRadiusBlocks; oz <= trunkProfile.majorLimbRadiusBlocks; oz += 1) {
          if (ox * ox + oz * oz > trunkProfile.majorLimbRadiusBlocks ** 2) continue;
          emitLine(put, [branchOriginX + ox, groundY + y, branchOriginZ + oz], [thickEnd[0] + ox, thickEnd[1], thickEnd[2] + oz], preset.branches, "branch", seed ^ (tier * 313 + branch * 7 + ox * 3 + oz));
        }
      }`;
const newMajor = `      emitTaperedLimb({
        put,
        start: [branchOriginX, groundY + y, branchOriginZ],
        end: [tipX, tipY, tipZ],
        palette: preset.branches,
        role: "branch",
        seed: seed ^ (tier * 131 + branch),
        architecture: branchArchitecture,
        generation: 0
      });
      const junction = junctionRadius(branchArchitecture, branchArchitecture?.primaryRadiusBlocks || 0, branchArchitecture?.secondaryRadiusBlocks || 0);
      if (junction > 0 && (branchArchitecture?.forked || tier === 0)) {
        emitJunctionCollar({ put, centre: [branchOriginX, groundY + y, branchOriginZ], radius: junction, palette: preset.branches, seed: seed ^ (tier * 907 + branch) });
      }`;
if (source.includes(oldMajor)) source = source.replace(oldMajor, newMajor);

source = source.replace(
  'if (detailLevel !== "low") emitSecondaryTwigs({ put, tip, preset, crownRadius, seed: seed ^ hashText(`${tier}:${branch}`) });',
  'if (detailLevel !== "low") emitSecondaryTwigs({ put, tip, preset, crownRadius, seed: seed ^ hashText(`${tier}:${branch}`), branchArchitecture });'
);
source = source.replace(
  'function emitSecondaryTwigs({ put, tip, preset, crownRadius, seed }) {',
  'function emitSecondaryTwigs({ put, tip, preset, crownRadius, seed, branchArchitecture }) {'
);
source = source.replace(
  '    emitLine(put, [tip.x, tip.y, tip.z], end, preset.twigs, "twig", seed ^ child);',
  '    emitTaperedLimb({ put, start: [tip.x, tip.y, tip.z], end, palette: preset.twigs, role: "twig", seed: seed ^ child, architecture: branchArchitecture, generation: 1 });'
);

if (!source.includes('function emitTaperedLimb({')) {
  const insertion = `
function emitTaperedLimb({ put, start, end, palette, role, seed, architecture, generation = 0 }) {
  const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) * 1.4));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const px = start[0] + dx * t, py = start[1] + dy * t, pz = start[2] + dz * t;
    const radius = branchRadiusAt(architecture, t, generation);
    const block = pick(palette, hash3d(Math.round(px), Math.round(py), Math.round(pz), seed));
    if (radius <= 0) {
      put(px, py, pz, block, role);
      continue;
    }
    for (let ox = -radius; ox <= radius; ox += 1) for (let oy = -radius; oy <= radius; oy += 1) for (let oz = -radius; oz <= radius; oz += 1) {
      if (ox * ox + oy * oy + oz * oz > (radius + 0.2) ** 2) continue;
      put(px + ox, py + oy, pz + oz, block, role);
    }
  }
}

function emitJunctionCollar({ put, centre, radius, palette, seed }) {
  for (let ox = -radius; ox <= radius; ox += 1) for (let oy = -radius; oy <= radius; oy += 1) for (let oz = -radius; oz <= radius; oz += 1) {
    if (ox * ox + oy * oy + oz * oz > (radius + 0.35) ** 2) continue;
    const block = pick(palette, hash3d(Math.round(centre[0] + ox), Math.round(centre[1] + oy), Math.round(centre[2] + oz), seed));
    put(centre[0] + ox, centre[1] + oy, centre[2] + oz, block, "branch");
  }
}
`;
  source = source.replace('\nfunction emitCanopyClusters(context) {', `${insertion}\nfunction emitCanopyClusters(context) {`);
}

for (const required of [
  'resolveTreeBranchArchitecture',
  'branchRadiusAt',
  'junctionRadius',
  'function emitTaperedLimb({',
  'function emitJunctionCollar({',
  'primaryBranchDiameterM:',
  'branchArchitecture?.forked'
]) {
  if (!source.includes(required)) throw new Error(`Missing branch architecture integration marker: ${required}`);
}
await writeFile(path, source);
console.log('Applied DBH/species-driven branch taper and junction architecture');
