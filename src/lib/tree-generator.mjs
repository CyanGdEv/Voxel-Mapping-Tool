import { crownRadiusAt, resolveTreeDimensions, selectTreePreset } from "./tree-presets.mjs";
import { crownReachFromTrunk, insideCrownEnvelope, normalizeTreeReconstruction } from "./tree-reconstruction.mjs";
import { inferTreeStructuralForm } from "./tree-structural-form.mjs";
import { inferTreeTrunkLean, trunkAxisOffsetAt } from "./tree-trunk-lean.mjs";
import { resolveTreeDbh, dbhToVoxelProfile } from "./tree-dbh.mjs";
import { resolveTreeStemArchitecture, insideStemCrossSection, barkDetailBlock } from "./tree-stem-architecture.mjs";
import { resolveTreeBranchArchitecture, branchRadiusAt, junctionRadius } from "./tree-branch-architecture.mjs";
import { resolveTreeFoliageMicrostructure, foliagePadRadii, shouldKeepFoliageCell, foliageCurtainLength } from "./tree-foliage-microstructure.mjs";

const TAU = Math.PI * 2;

/**
 * Emits a deterministic high-fidelity Minecraft tree from measured tree evidence.
 * Geometry is evidence-bounded: measured height and crown diameter define the
 * outer envelope; morphology only determines how trunk, limbs and foliage occupy it.
 */
export function compileHighFidelityTreeModel({
  add,
  x,
  z,
  groundY,
  heightM,
  crownDiameterM,
  leafType,
  species,
  genus,
  tags = {},
  leafPalette = [],
  seed = 0,
  detailLevel = "high",
  reconstruction = null
}) {
  const preset = selectTreePreset({ species, genus, leafType, crownDiameterM, heightM, tags });
  const dimensions = resolveTreeDimensions(preset, { heightM, crownDiameterM });
  const treeHeight = dimensions.height;
  const crownRadius = dimensions.crownRadius;
  const trunkHeight = clamp(Math.round(treeHeight * preset.trunkRatio), 2, treeHeight - 1);
  const presetCrownBase = clamp(Math.round(treeHeight * preset.branchStart), 2, treeHeight - 2);
  const crownGeometry = normalizeTreeReconstruction(reconstruction, { crownRadius, crownBase: presetCrownBase, treeHeight });
  const crownBase = crownGeometry.crownBase;
  const structuralForm = inferTreeStructuralForm({ heightM, crownDiameterM, species, genus, leafType, tags, reconstruction });
  const dbh = resolveTreeDbh({ heightM, crownDiameterM, species, genus, leafType, tags, structuralForm });
  const trunkProfile = dbhToVoxelProfile(dbh.dbhM, { structuralForm });
  const stemArchitecture = resolveTreeStemArchitecture({ dbhM: dbh.dbhM, species, genus, tags, structuralForm, seed });
  const branchArchitecture = resolveTreeBranchArchitecture({ dbhM: dbh.dbhM, species, genus, structuralForm, preset, tags });
  const foliageMicrostructure = resolveTreeFoliageMicrostructure({ preset, species, genus, leafType, structuralForm, reconstruction, tags });
  const trunkLeanRaw = inferTreeTrunkLean({ heightM, crownDiameterM, tags, reconstruction });
  const trunkLean = trunkLeanRaw.normalizedAt10m
    ? { ...trunkLeanRaw, dxM: trunkLeanRaw.dxM * treeHeight / 10, dzM: trunkLeanRaw.dzM * treeHeight / 10, topShiftM: trunkLeanRaw.topShiftM * treeHeight / 10, normalizedAt10m: false }
    : trunkLeanRaw;
  const treeSeed = seed ^ hashText(`${x}:${z}:${preset.id}`);
  const blocks = new Map();

  const put = (px, py, pz, block, role) => {
    const rx = Math.round(px), ry = Math.round(py), rz = Math.round(pz);
    if (ry < groundY + 1 || ry > groundY + treeHeight) return;
    if (role !== "trunk" && !insideCrownEnvelope(crownGeometry, rx - x, rz - z, 0.18)) return;
    const key = `${rx},${ry},${rz}`;
    const next = { x: rx, y: ry, z: rz, block, role };
    const current = blocks.get(key);
    if (!current || priority(role) >= priority(current.role)) blocks.set(key, next);
  };

  const trunkRadius = clamp(Math.max(trunkProfile.breastRadiusBlocks, Math.round(trunkProfile.breastRadiusBlocks * structuralForm.trunkScale)), 0, 3);
  emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius: trunkRadius, preset, seed: treeSeed, structuralForm, trunkLean, trunkProfile, stemArchitecture });

  const branchTips = emitMajorBranches({
    put, x, z, groundY, treeHeight, trunkHeight, crownBase, crownRadius, crownGeometry,
    preset, seed: treeSeed, detailLevel, structuralForm, trunkLean, trunkProfile, branchArchitecture
  });

  const palette = leafPalette.length ? leafPalette : preset.leaves;
  emitCanopyClusters({
    put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry,
    preset, palette, branchTips, seed: treeSeed, detailLevel, structuralForm, foliageMicrostructure
  });

  if ((foliageMicrostructure?.hangingFraction || 0) > 0) {
    emitWeepingCurtains({ put, groundY, treeHeight, crownBase, branchTips, palette, seed: treeSeed, foliageMicrostructure });
  }
  emitStructuralDeadwood({ put, branchTips, preset, structuralForm, seed: treeSeed });

  put(x, groundY + treeHeight, z, pick(palette, hash3d(x, groundY + treeHeight, z, treeSeed)), "leaf");

  const ordered = [...blocks.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const counts = { trunkBlocks: 0, branchBlocks: 0, twigBlocks: 0, leafBlocks: 0, totalBlocks: ordered.length };
  for (const voxel of ordered) {
    add(4, voxel.x, voxel.y, voxel.z, voxel.x, voxel.y, voxel.z, voxel.block);
    if (voxel.role === "trunk") counts.trunkBlocks += 1;
    else if (voxel.role === "branch") counts.branchBlocks += 1;
    else if (voxel.role === "twig") counts.twigBlocks += 1;
    else counts.leafBlocks += 1;
  }
  return {
    ...counts,
    preset: preset.id,
    heightBlocks: treeHeight,
    crownDiameterBlocks: dimensions.crownDiameter,
    branchTips: branchTips.length,
    reconstructionSource: crownGeometry.source,
    reconstructionObserved: crownGeometry.observed,
    crownBaseObserved: crownGeometry.crownBaseObserved,
    crownOffsetBlocks: { x: crownGeometry.offsetX, z: crownGeometry.offsetZ },
    crownRadiiBlocks: { x: crownGeometry.radiusX, z: crownGeometry.radiusZ },
    structuralForm: structuralForm.form,
    structuralFormConfidence: structuralForm.confidence,
    structuralStemCount: structuralForm.stemCount,
    structuralDeadwoodFraction: structuralForm.deadwoodFraction,
    trunkLeanSource: trunkLean.source,
    trunkLeanConfidence: trunkLean.confidence,
    trunkLeanTopShiftBlocks: trunkLean.topShiftM,
    trunkLeanVectorBlocks: { x: trunkLean.dxM, z: trunkLean.dzM },
    dbhSource: dbh.source,
    dbhObserved: dbh.observed,
    dbhM: dbh.dbhM,
    dbhConfidence: dbh.confidence,
    trunkBaseRadiusBlocks: trunkProfile.baseRadiusBlocks,
    rootReachBlocks: trunkProfile.rootReachBlocks,
    stemArchitectureSource: stemArchitecture.source,
    stemArchitectureObserved: stemArchitecture.observed,
    stemCrossSection: stemArchitecture.form,
    stemEllipticity: stemArchitecture.ellipticity,
    stemFluting: stemArchitecture.fluting,
    stemHollow: stemArchitecture.hollow,
    stemHollowObserved: stemArchitecture.hollowObserved,
    barkCharacter: stemArchitecture.barkCharacter,
    branchArchitectureSource: branchArchitecture.source,
    branchArchitectureObserved: branchArchitecture.observed,
    primaryBranchDiameterM: branchArchitecture.primaryDiameterM,
    primaryBranchRadiusBlocks: branchArchitecture.primaryRadiusBlocks,
    secondaryBranchRadiusBlocks: branchArchitecture.secondaryRadiusBlocks,
    tertiaryBranchRadiusBlocks: branchArchitecture.tertiaryRadiusBlocks,
    branchForked: branchArchitecture.forked,
    foliageMicrostructureSource: foliageMicrostructure.source,
    foliageMicrostructureObserved: foliageMicrostructure.observed,
    foliagePadStyle: foliageMicrostructure.padStyle,
    foliageDensity: foliageMicrostructure.density,
    foliageGapFraction: foliageMicrostructure.gapFraction,
    foliageHangingFraction: foliageMicrostructure.hangingFraction
  };
}

function emitTaperedTrunk({ put, x, z, groundY, trunkHeight, radius, preset, seed, structuralForm, trunkLean, trunkProfile, stemArchitecture }) {
  const stems = Math.max(1, Math.min(8, stemArchitecture?.stemCount || structuralForm?.stemCount || 1));
  const stemOffsets = [{ x: 0, z: 0 }];
  for (let stem = 1; stem < stems; stem += 1) {
    const angle = (stem / stems) * TAU + random01(seed, 900 + stem) * 0.45;
    stemOffsets.push({ x: Math.round(Math.cos(angle)), z: Math.round(Math.sin(angle)) });
  }
  for (const stemOffset of stemOffsets) for (let dy = 1; dy <= trunkHeight; dy += 1) {
    const t = dy / trunkHeight;
    const axis = trunkAxisOffsetAt(trunkLean, t);
    const axisX = x + Math.round(axis.x);
    const axisZ = z + Math.round(axis.z);
    const localRadius = t < 0.18 ? Math.max(radius, trunkProfile?.baseRadiusBlocks || radius) : t > 0.72 ? Math.min(radius, trunkProfile?.upperRadiusBlocks ?? Math.max(0, radius - 1)) : radius;
    for (let dz = -localRadius; dz <= localRadius; dz += 1) {
      for (let dx = -localRadius; dx <= localRadius; dx += 1) {
        if (!insideStemCrossSection(dx, dz, localRadius + 0.25, stemArchitecture, dy)) continue;
        const bark = barkDetailBlock({ preset, architecture: stemArchitecture, x: axisX + stemOffset.x + dx, y: groundY + dy, z: axisZ + stemOffset.z + dz, seed });
        put(axisX + stemOffset.x + dx, groundY + dy, axisZ + stemOffset.z + dz, bark, "trunk");
      }
    }
  }
  if ((trunkProfile?.baseRadiusBlocks || radius) > 0) {
    const buttressBias = stemArchitecture?.form === "irregular" || stemArchitecture?.form === "fluted" ? 2 : 0;
    const roots = 4 + buttressBias + (hash3d(x, groundY, z, seed) % 3);
    for (let i = 0; i < roots; i += 1) {
      const angle = (i / roots) * TAU + random01(seed, i) * 0.7;
      const directionalNoise = 0.75 + random01(seed ^ 0x7f4a7c15, i + 71) * 0.65;
      const maxRootReach = Math.max(1, Math.round((trunkProfile?.rootReachBlocks || radius + 1) * directionalNoise));
      const length = 1 + (hash3d(x + i, groundY, z - i, seed) % maxRootReach);
      const end = [x + Math.round(Math.cos(angle) * length), groundY + 1, z + Math.round(Math.sin(angle) * length)];
      emitLine(put, [x, groundY + 1, z], end, preset.branches, "branch", seed ^ i);
    }
  }
}

function emitMajorBranches(context) {
  const {
    put, x, z, groundY, treeHeight, trunkHeight, crownBase, crownRadius, crownGeometry,
    preset, seed, detailLevel, structuralForm, trunkLean, trunkProfile, branchArchitecture
  } = context;
  const tiers = clamp(Math.round(preset.branchTiers), 2, 10);
  const tips = [];
  for (let tier = 0; tier < tiers; tier += 1) {
    const t = tiers === 1 ? 0.5 : tier / (tiers - 1);
    const y = clamp(Math.round(crownBase + t * Math.max(1, trunkHeight - crownBase)), crownBase, treeHeight - 2);
    const branchAxis = trunkAxisOffsetAt(trunkLean, y / Math.max(1, trunkHeight));
    const branchOriginX = x + branchAxis.x;
    const branchOriginZ = z + branchAxis.z;
    const min = preset.branchCount[0], max = preset.branchCount[1];
    const rawCount = min + hash3d(x + tier, y, z - tier, seed) % (max - min + 1);
    const count = detailLevel === "medium" ? Math.max(3, Math.round(rawCount * 0.7)) : rawCount;
    const tierRadius = Math.max(1.5, crownRadiusAt(preset, Math.min(1, (y - crownBase) / Math.max(1, treeHeight - crownBase)), crownRadius));
    const baseAngle = random01(seed, tier * 19 + 7) * TAU;
    for (let branch = 0; branch < count; branch += 1) {
      const jitter = (random01(seed, tier * 101 + branch * 17) - 0.5) * (TAU / count) * 0.7;
      const angle = baseAngle + (branch / count) * TAU + jitter;
      const measuredReach = crownReachFromTrunk(crownGeometry, angle);
      const directionalScale = measuredReach / Math.max(0.5, crownRadius);
      const length = tierRadius * directionalScale * (0.68 + random01(seed ^ 0x9e3779b9, tier * 53 + branch) * 0.34) * (structuralForm?.branchScale || 1);
      const rise = preset.family === "conifer"
        ? (0.12 - t * 0.2) * length
        : (0.18 + random01(seed, branch * 31 + tier) * 0.18 - preset.branchDroop) * length;
      const tipX = branchOriginX + Math.cos(angle) * length;
      const tipZ = branchOriginZ + Math.sin(angle) * length;
      const tipY = groundY + y + rise;
      emitTaperedLimb({
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
      }
      const tip = { x: Math.round(tipX), y: Math.round(tipY), z: Math.round(tipZ), angle, tier: t };
      tips.push(tip);
      if (detailLevel !== "low") emitSecondaryTwigs({ put, tip, preset, crownRadius, seed: seed ^ hashText(`${tier}:${branch}`), branchArchitecture });
    }
  }
  return tips;
}

function emitSecondaryTwigs({ put, tip, preset, crownRadius, seed, branchArchitecture }) {
  const children = preset.family === "conifer" ? 2 : 2 + (seed >>> 3) % 3;
  for (let child = 0; child < children; child += 1) {
    const side = child % 2 ? 1 : -1;
    const angle = tip.angle + side * (0.45 + random01(seed, child) * 0.55);
    const length = Math.max(1, crownRadius * (0.18 + random01(seed ^ 0x51f15e, child + 9) * 0.17));
    const droop = preset.branchDroop * length * (0.6 + random01(seed, child + 20));
    const end = [tip.x + Math.cos(angle) * length, tip.y - droop + (child === 2 ? 1 : 0), tip.z + Math.sin(angle) * length];
    emitTaperedLimb({ put, start: [tip.x, tip.y, tip.z], end, palette: preset.twigs, role: "twig", seed: seed ^ child, architecture: branchArchitecture, generation: 1 });
  }
  const detail = pick(preset.twigs, seed >>> 5);
  if (detail) put(tip.x, tip.y, tip.z, detail, "twig");
}

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

function emitCanopyClusters(context) {
  const { put, x, z, groundY, treeHeight, crownBase, crownRadius, crownGeometry, preset, palette, branchTips, seed, detailLevel, structuralForm, foliageMicrostructure } = context;
  const clusterScale = detailLevel === "medium" ? 0.82 : 1;
  const crownHeight = Math.max(2, treeHeight - crownBase + 1);
  const liveTipFraction = clamp(Number(foliageMicrostructure?.liveTipFraction) || 1, 0.45, 1);
  const centres = branchTips.filter((tip, index) => random01(seed ^ 0x6ac690c5, index + 700) <= liveTipFraction);
  const scaffoldFraction = clamp(Number(foliageMicrostructure?.scaffoldFraction) || 0.1, 0.05, 0.28);
  const axialClusters = clamp(Math.round(crownHeight * scaffoldFraction), 1, 5);
  for (let i = 0; i < axialClusters; i += 1) {
    const t = axialClusters === 1 ? 0.5 : i / (axialClusters - 1);
    const y = groundY + crownBase + Math.round(t * (treeHeight - crownBase));
    const radius = crownRadiusAt(preset, t, crownRadius);
    const angle = random01(seed ^ 0x85ebca6b, i) * TAU;
    const distance = radius * (0.12 + random01(seed, i + 400) * 0.42);
    const centreShift = 0.35 + 0.65 * t;
    const localReach = crownReachFromTrunk(crownGeometry, angle);
    const distanceScale = localReach / Math.max(0.5, crownRadius);
    centres.push({
      x: Math.round(x + crownGeometry.offsetX * centreShift + Math.cos(angle) * distance * distanceScale),
      y,
      z: Math.round(z + crownGeometry.offsetZ * centreShift + Math.sin(angle) * distance * distanceScale),
      tier: t
    });
  }
  for (let index = 0; index < centres.length; index += 1) {
    const centre = centres[index];
    const crownT = clamp((centre.y - (groundY + crownBase)) / Math.max(1, treeHeight - crownBase), 0, 1);
    const silhouetteRadius = crownRadiusAt(preset, crownT, crownRadius);
    const pad = foliagePadRadii(foliageMicrostructure, Math.max(1, silhouetteRadius), seed, index);
    const radiusX = clamp(Math.round(pad.radiusX * clusterScale), 1, Math.max(1, Math.ceil(silhouetteRadius * 0.5)));
    const radiusZ = clamp(Math.round(pad.radiusZ * clusterScale), 1, Math.max(1, Math.ceil(silhouetteRadius * 0.5)));
    const radiusY = clamp(Math.round(pad.radiusY * clusterScale), 1, 4);
    emitOrganicLeafCluster({ put, centre, radiusX, radiusY, radiusZ, palette, micro: foliageMicrostructure, seed: seed ^ index * 2654435761 });
  }
  const shellSamples = clamp(Math.round(crownRadius * (detailLevel === "medium" ? 2.2 : 3.2)), 6, 34);
  for (let i = 0; i < shellSamples; i += 1) {
    const t = random01(seed ^ 0xc2b2ae35, i * 5);
    const y = groundY + crownBase + Math.round(t * (treeHeight - crownBase));
    const baseRadius = crownRadiusAt(preset, t, crownRadius) * (0.72 + random01(seed, i * 5 + 1) * 0.25);
    const angle = random01(seed, i * 5 + 2) * TAU;
    const reachScale = crownReachFromTrunk(crownGeometry, angle) / Math.max(0.5, crownRadius);
    const radius = baseRadius * reachScale;
    const shift = 0.35 + 0.65 * t;
    const px = Math.round(x + crownGeometry.offsetX * shift + Math.cos(angle) * radius);
    const pz = Math.round(z + crownGeometry.offsetZ * shift + Math.sin(angle) * radius);
    const shellRough = (hash3d(px, y, pz, seed ^ 0x27d4eb2d) % 1000) / 1000;
    if (shellRough > (foliageMicrostructure?.density || 0.75)) continue;
    put(px, y, pz, pick(palette, hash3d(px, y, pz, seed)), "leaf");
  }
}

function emitOrganicLeafCluster({ put, centre, radiusX, radiusY, radiusZ, palette, micro, seed }) {
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
}

function emitStructuralDeadwood({ put, branchTips, preset, structuralForm, seed }) {
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

function emitWeepingCurtains({ put, groundY, treeHeight, crownBase, branchTips, palette, seed, foliageMicrostructure }) {
  for (let i = 0; i < branchTips.length; i += 1) {
    const tip = branchTips[i];
    if (i % 2) continue;
    const length = foliageCurtainLength(foliageMicrostructure, treeHeight, seed, i);
    if (length <= 0) continue;
    for (let dy = 0; dy < length; dy += 1) {
      const y = tip.y - dy;
      if (y <= groundY + Math.max(1, crownBase * 0.25)) break;
      put(tip.x, y, tip.z, pick(palette, hash3d(tip.x, y, tip.z, seed)), "leaf");
    }
  }
}

function emitLine(put, from, to, palette, role, seed) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = Math.round(from[0] + dx * t), y = Math.round(from[1] + dy * t), z = Math.round(from[2] + dz * t);
    put(x, y, z, pick(palette, hash3d(x, y, z, seed)), role);
  }
}

function priority(role) {
  if (role === "trunk") return 4;
  if (role === "branch") return 3;
  if (role === "twig") return 2;
  return 1;
}
function pick(values, hash) { return values?.length ? values[Math.abs(hash) % values.length] : "minecraft:oak_leaves"; }
function random01(seed, index) { return (hash3d(index, seed >>> 8, seed & 0xffff, seed) >>> 0) / 0xffffffff; }
function hashText(value) { let h = 2166136261; for (const ch of String(value)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h | 0; }
function hash3d(x, y, z, seed = 0) { let h = seed | 0; h ^= Math.imul(Math.round(x), 0x1f123bb5); h ^= Math.imul(Math.round(y), 0x5f356495); h ^= Math.imul(Math.round(z), 0x6c8e9cf5); h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16; return h >>> 0; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
