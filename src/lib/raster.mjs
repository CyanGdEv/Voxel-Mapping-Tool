import { geometryBounds, lineCells, polygonScanlineSpans } from "./geo.mjs";
import { UserError, invariant } from "./errors.mjs";
import { RIDE_EVIDENCE_LEGEND } from "./ride-profile.mjs";
import { blockForSurfaceStyle, isBridgeFeature } from "./fidelity.mjs";
import { terrainStyleForAerialClass, vegetationPaletteForRgb } from "./aerial-appearance.mjs";
import { compileHighFidelityTreeModel } from "./tree-generator.mjs";

const SURFACES = [
  "minecraft:grass_block",
  "minecraft:gravel",
  "minecraft:light_gray_concrete",
  "minecraft:water",
  "minecraft:moss_block",
  "minecraft:sand",
  "minecraft:stone",
  "minecraft:green_concrete",
  "minecraft:coarse_dirt"
];

const BASE_SURFACE_STYLES = SURFACES.map((block, code) => ({
  schemaVersion: 1,
  role: "base-surface",
  code,
  primaryBlock: block,
  secondaryBlock: block,
  pattern: "solid",
  appearanceStatus: "base-map-class"
}));

export function compileMap({ parkName, map, sources, accuracy, options = {} }) {
  const scale = options.scale ?? 1;
  invariant(scale === 1, "The verified compiler only supports --scale 1 (one block per metre)");
  const accuracyMode = options.accuracyMode || "verified";
  if (!new Set(["verified", "plausible"]).has(accuracyMode)) {
    throw new UserError("--accuracy-mode must be verified or plausible");
  }
  const buildingMode = options.buildings || "markers";
  if (!new Set(["markers", "shells"]).has(buildingMode)) {
    throw new UserError("--buildings must be markers or shells");
  }
  const boundaryPolygons = polygonParts(map.boundary.localGeometry);
  invariant(boundaryPolygons.length, "The park boundary cannot be rasterized");
  const bounds = geometryBounds(map.boundary.localGeometry);
  const minX = Math.floor(bounds.minX);
  const minZ = Math.floor(bounds.minZ);
  const maxX = Math.ceil(bounds.maxX);
  const maxZ = Math.ceil(bounds.maxZ);
  const width = maxX - minX + 1;
  const height = maxZ - minZ + 1;
  const rasterCells = width * height;
  const maxCells = options.maxCells ?? 2_500_000;
  if (rasterCells > maxCells) {
    throw new UserError(
      `The 1 m raster needs ${rasterCells.toLocaleString()} cells; the safety limit is ${maxCells.toLocaleString()}`,
      "Tighten the park boundary or deliberately increase --max-cells after checking memory and Bedrock build time."
    );
  }

  const mask = new Uint8Array(rasterCells);
  const elevationY = new Int16Array(rasterCells);
  const surface = new Uint16Array(rasterCells);
  const accessSurface = new Uint8Array(rasterCells);
  const discoveredAccess = new Uint8Array(rasterCells);
  const pathEdgeStyles = new Uint16Array(rasterCells);
  const surfaceStyles = BASE_SURFACE_STYLES.map((style) => ({ ...style }));
  const surfaceStyleIndex = new Map(surfaceStyles.map((style, index) => [surfaceStyleKey(style), index]));
  const registerSurfaceStyle = (style) => {
    const normalized = style || BASE_SURFACE_STYLES[0];
    const key = surfaceStyleKey(normalized);
    let index = surfaceStyleIndex.get(key);
    if (index !== undefined) return index;
    index = surfaceStyles.length;
    invariant(index < 65_535, "Too many distinct surface styles for the 1 m raster");
    surfaceStyles.push({ ...normalized, code: index });
    surfaceStyleIndex.set(key, index);
    return index;
  };
  for (const polygon of boundaryPolygons) {
    paintSpans(mask, polygonScanlineSpans(polygon), minX, minZ, width, height, 1);
  }

  const elevationSampler = buildElevationSampler(sources.elevation);
  let minDatum = Number.isFinite(sources.elevation?.minM) ? sources.elevation.minM : Infinity;
  for (const point of sources.elevation.points || []) minDatum = Math.min(minDatum, point.elevation);
  if (!Number.isFinite(minDatum)) minDatum = 0;
  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const index = cellIndex(x, z, minX, minZ, width, height);
      if (index < 0 || !mask[index]) continue;
      const sampledElevation = elevationSampler(x, z);
      elevationY[index] = Math.round((Number.isFinite(sampledElevation) ? sampledElevation : minDatum) - minDatum);
    }
  }

  const aerialTerrainOutput = applyAerialTerrainTextures({
    map, mask, surface, registerSurfaceStyle,
    minX, minZ, maxX, maxZ, width, height, options
  });

  const overlays = [...map.features].sort((a, b) => overlayPriority(a.kind) - overlayPriority(b.kind));
  for (const feature of overlays) paintFeatureSurface(
    feature, surface, accessSurface, discoveredAccess, pathEdgeStyles, mask,
    { minX, minZ, width, height }, accuracyMode, registerSurfaceStyle
  );
  const pathEdgeOutput = applyPathEdgeStyles({
    surface, accessSurface, pathEdgeStyles, mask, width, height
  });
  const terrainDetailExclusion = buildTerrainDetailExclusion(map, mask, {
    minX, minZ, width, height
  });
  const pathTerrainOutput = conformRecoveredPathTerrain({
    elevationY, discoveredAccess, accessSurface, mask, width, height,
    elevation: sources.elevation, options
  });
  const accessDistance = buildAccessDistance(accessSurface, width, height);

  const chunkMap = new Map();
  const palette = [];
  const paletteIndex = new Map();
  const signs = [];
  let estimatedBlocks = 0;
  let rawOperations = 0;
  const buildDepth = Math.max(1, Math.min(48, options.buildDepth ?? 8));
  const add = (phase, x1, y1, z1, x2, y2, z2, block) => {
    const from = [Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2)];
    const to = [Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)];
    rawOperations += 1;
    for (const split of splitByChunk(from, to)) {
      const volume = (split.to[0] - split.from[0] + 1) * (split.to[1] - split.from[1] + 1) * (split.to[2] - split.from[2] + 1);
      estimatedBlocks += volume;
      let blockIndex = paletteIndex.get(block);
      if (blockIndex === undefined) {
        blockIndex = palette.length;
        palette.push(block);
        paletteIndex.set(block, blockIndex);
      }
      const key = `${split.chunkX},${split.chunkZ}`;
      if (!chunkMap.has(key)) chunkMap.set(key, { x: split.chunkX, z: split.chunkZ, o: [] });
      chunkMap.get(key).o.push([
        phase, split.from[0], split.from[1], split.from[2],
        split.to[0], split.to[1], split.to[2], blockIndex
      ]);
    }
  };

  compileTerrain({
    add, mask, elevationY, surface, surfaceStyles, minX, minZ, maxX, maxZ, width, height,
    buildDepth, seed: options.seed ?? 0
  });
  const verticalStats = compileVerticalFeatures({
    add, map, mask, elevationY, surface: accessSurface, accessDistance, minX, minZ, width, height,
    minDatum, accuracyMode, elevation: sources.elevation, buildingMode, signs, seed: options.seed ?? 0,
    terrainDetailExclusion, options
  });
  const spawnLocal = selectSpawn(map, mask, elevationY, accessSurface, { minX, minZ, maxX, maxZ, width, height });
  const playerEvidenceStats = options.noRideInfoSigns ? {
    playerInformationSigns: 0,
    rideInformationSigns: 0
  } : compilePlayerEvidenceSigns({
    add, map, accuracy, signs, spawnLocal, mask, elevationY, surface: accessSurface, accessDistance,
    minX, minZ, width, height, options
  });
  Object.assign(verticalStats, playerEvidenceStats);

  const chunks = [...chunkMap.values()]
    .map((chunk) => ({ ...chunk, o: chunk.o.sort((a, b) => a[0] - b[0]) }))
    .sort((a, b) => a.z - b.z || a.x - b.x);
  const operations = chunks.reduce((sum, chunk) => sum + chunk.o.length, 0);
  const phaseCounts = {};
  for (const chunk of chunks) for (const operation of chunk.o) phaseCounts[operation[0]] = (phaseCounts[operation[0]] || 0) + 1;

  return {
    meta: {
      format: 1,
      parkName,
      generatedAt: new Date().toISOString(),
      scale: { metresPerBlock: 1, horizontal: "verified", vertical: sources.elevation.provider === "none" ? "flat-datum" : "source-limited" },
      accuracyMode,
      confidence: accuracy.score,
      evidenceGrade: accuracy.grade,
      exact3d: accuracy.exact3d,
      projectionCenter: sources.center,
      elevationDatumM: minDatum,
      bounds: { minX, minZ, maxX, maxZ, width, height },
      spawnLocal,
      buildingMode,
      opsPerYield: Math.max(1, Math.min(64, options.opsPerYield ?? 12)),
      baseY: options.baseY ?? 64,
      topology: map.topology,
      explicitSemantics: map.semantics,
      rideEvidence: map.rideProfiles?.totals || null,
      rideEvidenceLegend: RIDE_EVIDENCE_LEGEND,
      surfaceStyles,
      universalFidelity: map.fidelity || null,
      orthophotoEvidence: map.orthophoto || null,
      pathGeometryEvidence: map.pathGeometry || null,
      pathTopologyEvidence: map.pathTopology || null,
      sourceFusion: map.sourceFusion || null,
      pathTerrainOutput,
      pathEdgeOutput,
      terrainDetailEvidence: map.terrainDetails || null,
      aerialTerrainOutput,
      verticalStats
    },
    palette,
    chunks,
    signs,
    stats: {
      rasterCells,
      parkCells: mask.reduce((sum, value) => sum + value, 0),
      rawOperations,
      operations,
      chunks: chunks.length,
      estimatedBlocks,
      phaseCounts,
      buildingSigns: signs.filter((sign) => !sign.role || sign.role === "building").length,
      rideInformationSigns: signs.filter((sign) => sign.role === "ride-evidence").length,
      playerInformationSigns: signs.filter((sign) => sign.role === "map-evidence").length,
      pathTerrainAdjustedCells: pathTerrainOutput.adjustedCells,
      pathTerrainCutVolumeM3: pathTerrainOutput.cutVolumeM3,
      pathTerrainFillVolumeM3: pathTerrainOutput.fillVolumeM3,
      pathEdgeCells: pathEdgeOutput.edgeCells,
      pathEdgeCandidateCells: pathEdgeOutput.candidateCells,
      pathRepairConnectors: map.pathGeometry?.compiledConnectors || 0,
      pathRepairComponentReduction: map.pathGeometry?.componentReduction || 0,
      terrainRockBlocks: verticalStats.terrainRockBlocks,
      terrainRockModels: verticalStats.terrainRockDimensionedModels +
        verticalStats.terrainRockPositionMarkers + verticalStats.terrainInferredRockClusters,
      terrainCliffMarkerBlocks: verticalStats.terrainCliffMarkerBlocks,
      aerialTerrainTexturedCells: aerialTerrainOutput.texturedCells,
      aerialTerrainClasses: aerialTerrainOutput.classes
    }
  };
}

/**
 * Accepted image-derived paths already follow the source DTM. Conform mode
 * removes isolated one-block crossfall/noise with a bounded, path-only median
 * filter. Every target height remains within --path-terrain-max-cut-fill-m of
 * the source raster; mapped paths and surrounding terrain are anchor cells and
 * are never rewritten by this pass.
 */
function conformRecoveredPathTerrain({
  elevationY, discoveredAccess, accessSurface, mask, width, height, elevation, options
}) {
  const mode = options.pathTerrainMode || "evidence";
  const candidateCells = discoveredAccess.reduce((sum, value) => sum + value, 0);
  const maxCutFillM = Math.max(0, Math.min(8, Number(options.pathTerrainMaxCutFillM ?? 2)));
  const base = {
    schemaVersion: 1,
    mode,
    candidateCells,
    adjustedCells: 0,
    cutCells: 0,
    fillCells: 0,
    cutVolumeM3: 0,
    fillVolumeM3: 0,
    maxAdjustmentM: 0,
    maxCutFillM,
    boundedToSource: true,
    method: "bounded path-only 3x3 median; mapped access cells are fixed anchors"
  };
  if (!candidateCells) return { ...base, status: "no-compiled-recovered-paths" };
  if (mode === "off") return { ...base, status: "off" };
  if (mode === "evidence") return { ...base, status: "source-terrain-unchanged" };
  if (!elevation?.provider || elevation.provider === "none") {
    return { ...base, status: "terrain-unavailable" };
  }
  if (maxCutFillM < 1) return { ...base, status: "bounded-zero-adjustment" };

  const source = new Int16Array(elevationY);
  let current = new Int16Array(elevationY);
  const maxBlocks = Math.floor(maxCutFillM);
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Int16Array(current);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const index = row * width + column;
        if (!discoveredAccess[index] || !mask[index]) continue;
        const neighbours = [];
        for (let dz = -1; dz <= 1; dz += 1) {
          const z = row + dz;
          if (z < 0 || z >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const x = column + dx;
            if (x < 0 || x >= width) continue;
            const neighbour = z * width + x;
            if (!mask[neighbour] || !isAccessSurface(accessSurface[neighbour])) continue;
            neighbours.push(current[neighbour]);
          }
        }
        if (neighbours.length < 3) continue;
        neighbours.sort((a, b) => a - b);
        const target = Math.round(medianNumber(neighbours));
        next[index] = Math.max(source[index] - maxBlocks, Math.min(source[index] + maxBlocks, target));
      }
    }
    current = next;
  }

  let adjustedCells = 0, cutCells = 0, fillCells = 0;
  let cutVolumeM3 = 0, fillVolumeM3 = 0, maxAdjustmentM = 0;
  for (let index = 0; index < elevationY.length; index += 1) {
    if (!discoveredAccess[index]) continue;
    const adjustment = current[index] - source[index];
    if (!adjustment) continue;
    elevationY[index] = current[index];
    adjustedCells += 1;
    maxAdjustmentM = Math.max(maxAdjustmentM, Math.abs(adjustment));
    if (adjustment < 0) {
      cutCells += 1;
      cutVolumeM3 += -adjustment;
    } else {
      fillCells += 1;
      fillVolumeM3 += adjustment;
    }
  }
  return {
    ...base,
    status: adjustedCells ? "conformed" : "source-terrain-already-conforming",
    adjustedCells,
    cutCells,
    fillCells,
    cutVolumeM3,
    fillVolumeM3,
    maxAdjustmentM
  };
}

function applyAerialTerrainTextures({
  map, mask, surface, registerSurfaceStyle,
  minX, minZ, maxX, maxZ, width, height, options
}) {
  const mode = options.aerialTerrainMode || "evidence";
  const sampler = map.orthophoto?.sampleTerrainLocal;
  const compilationEligible = Boolean(map.orthophoto?.landCover?.compilationEligible);
  const result = {
    schemaVersion: 1,
    mode,
    status: "not-applied",
    compilationEligible,
    gridM: Math.max(1, Math.round(options.aerialTerrainGridM || 2)),
    minimumConfidence: options.aerialTerrainMinConfidence ?? 0.7,
    sampledCells: 0,
    texturedCells: 0,
    rejectedCells: 0,
    classes: {}
  };
  if (mode === "off") {
    result.status = "disabled";
    return result;
  }
  if (typeof sampler !== "function") {
    result.status = "no-aerial-classifier";
    return result;
  }
  if (mode === "evidence" && !compilationEligible) {
    result.status = "qa-only-provenance-incomplete";
    return result;
  }
  if (mode === "qa") {
    result.status = "qa-only";
    return result;
  }

  const grid = result.gridM;
  const minConfidence = result.minimumConfidence;
  for (let z = minZ; z <= maxZ; z += grid) {
    for (let x = minX; x <= maxX; x += grid) {
      const centerIndex = cellIndex(x, z, minX, minZ, width, height);
      if (centerIndex < 0 || !mask[centerIndex]) continue;
      result.sampledCells += 1;
      const classification = sampler(x + grid / 2, z + grid / 2);
      if (!classification || classification.confidence < minConfidence) {
        result.rejectedCells += 1;
        continue;
      }
      const style = terrainStyleForAerialClass(classification);
      if (!style) {
        result.rejectedCells += 1;
        continue;
      }
      const styleCode = registerSurfaceStyle(style);
      let written = 0;
      for (let dz = 0; dz < grid; dz += 1) {
        for (let dx = 0; dx < grid; dx += 1) {
          const cellX = x + dx, cellZ = z + dz;
          const index = cellIndex(cellX, cellZ, minX, minZ, width, height);
          if (index < 0 || !mask[index]) continue;
          surface[index] = styleCode;
          written += 1;
        }
      }
      if (written) {
        result.texturedCells += written;
        result.classes[classification.class] = (result.classes[classification.class] || 0) + written;
      }
    }
  }
  result.status = result.texturedCells ? "applied" : "no-natural-ground-classes";
  return result;
}

function compileTerrain(context) {
  const {
    add, mask, elevationY, surface, surfaceStyles, minX, minZ, maxX, maxZ, width, height, buildDepth, seed
  } = context;
  for (let z = minZ; z <= maxZ; z += 1) {
    let x = minX;
    while (x <= maxX) {
      const index = cellIndex(x, z, minX, minZ, width, height);
      if (index < 0 || !mask[index]) { x += 1; continue; }
      const y = elevationY[index];
      const surfaceCode = surface[index];
      const surfaceBlock = blockForSurfaceStyle(surfaceStyles[surfaceCode], x, z, seed);
      let end = x;
      while (end + 1 <= maxX) {
        const next = cellIndex(end + 1, z, minX, minZ, width, height);
        if (next < 0 || !mask[next] || elevationY[next] !== y ||
          blockForSurfaceStyle(surfaceStyles[surface[next]], end + 1, z, seed) !== surfaceBlock) break;
        end += 1;
      }
      add(0, x, -buildDepth, z, end, y - 1, z, y - 1 < -buildDepth / 2 ? "minecraft:stone" : "minecraft:dirt");
      add(1, x, y, z, end, y, z, surfaceBlock);
      x = end + 1;
    }
  }
}

function compileVerticalFeatures(context) {
  const {
    add, map, mask, elevationY, surface, accessDistance, minX, minZ, width, height, minDatum,
    accuracyMode, elevation, buildingMode, signs, seed, terrainDetailExclusion, options
  } = context;
  const usedSignCells = new Set();
  const representedStructures = map.features.filter((feature) =>
    feature.kind === "building" || feature.kind === "structure"
  );
  const mappedEntrances = map.features.filter((feature) => feature.tags?.entrance || feature.tags?.door);
  const entranceAssignments = associateEntrances(representedStructures, mappedEntrances);
  const mappedVegetationMask = buildMappedVegetationMask(map, { minX, minZ, width, height });
  const stats = {
    buildingMode,
    buildingMarkerFootprints: 0,
    pointBuildingMarkers: 0,
    unrepresentedBuildingFeatures: 0,
    buildingMarkerCells: 0,
    buildingSigns: 0,
    unnamedBuildingMarkers: 0,
    measuredBuildingHeights: 0,
    lidarRoofBuildings: 0,
    lidarRoofCells: 0,
    inferredBuildingHeights: 0,
    footprintOnlyBuildings: 0,
    groundPlanRideTracks: 0,
    verticallyTaggedRideTracks: 0,
    profiledRideTracks: 0,
    rideTrackRepresentation: "one-block-centreline",
    rideTrackWidthBlocks: 1,
    rideBankingRendered: false,
    rideCrossTiesRendered: false,
    rideProfileBlocks: 0,
    rideProfileEvidenceBlocks: {},
    partialRideProfileTracks: 0,
    rideTerrainMode: options.rideTerrainMode || "inferred",
    rideExplicitTunnelFeatures: 0,
    rideTerrainDetectedTunnelFeatures: 0,
    rideTunnelTrackBlocks: 0,
    rideTunnelInferredTrackBlocks: 0,
    rideTunnelExcavatedBlocks: 0,
    rideTunnelLiningBlocks: 0,
    rideTunnelPortalFrames: 0,
    rideTunnelPortalBlocks: 0,
    rideSupportFrames: 0,
    rideSupportBlocks: 0,
    rideSupportFootings: 0,
    rideAttachmentFeatures: 0,
    rideAttachmentRendered: 0,
    rideAttachmentWithheld: 0,
    rideAttachmentBlocks: 0,
    rideAttachmentTypes: {},
    rideAttachmentEvidence: [],
    rideStructureEvidence: [],
    signsAtMappedEntrances: 0,
    signsNearMappedPaths: 0,
    signsAtMappedPoints: 0,
    signsAtInteriorFallback: 0,
    bridgeFeatures: map.semantics?.bridges || 0,
    bridgeDeckFeatures: 0,
    bridgeMeasuredOrExplicit: 0,
    bridgeInferred: 0,
    bridgePlanOnly: 0,
    bridgeDeckBlocks: 0,
    bridgeRailBlocks: 0,
    bridgeSupportBlocks: 0,
    tunnelFeatures: map.semantics?.tunnels || 0,
    layeredFeatures: map.semantics?.layered || 0,
    treeFeatures: 0,
    treeModels: 0,
    treePositionMarkers: 0,
    treeRows: 0,
    treeTrunkBlocks: 0,
    treeLeafBlocks: 0,
    treeHeightMeasuredOrTagged: 0,
    treeHeightInferred: 0,
    treeCrownInferred: 0,
    vegetationPolygonFeatures: 0,
    vegetationDensityDerivedModels: 0,
    vegetationCanopyMatchedModels: 0,
    aerialCanopySamples: 0,
    aerialCanopyModels: 0,
    aerialCanopyRejected: 0,
    shrubModels: 0,
    hedgeFeatures: 0,
    hedgeBlocks: 0,
    vegetationSkippedBySafetyLimit: 0,
    terrainDetailMode: options.terrainDetailMode || "evidence",
    terrainRockPointFeatures: 0,
    terrainRockDimensionedModels: 0,
    terrainRockPositionMarkers: 0,
    terrainCliffFeatures: 0,
    terrainCliffMarkerBlocks: 0,
    terrainRockSurfaceFeatures: 0,
    terrainRockSurfaceCells: 0,
    terrainInferredRockClusters: 0,
    terrainRockBlocks: 0,
    terrainRockSkippedBySafetyLimit: 0
  };
  for (const feature of map.features) {
    if (["path", "road"].includes(feature.kind) && isBridgeFeature(feature)) {
      const bridge = compileBridgeFeature({
        add, feature, mask, elevationY, minX, minZ, width, height, minDatum,
        accuracyMode, elevation, seed
      });
      stats.bridgeDeckFeatures += bridge.features;
      stats.bridgeMeasuredOrExplicit += bridge.measuredOrExplicit;
      stats.bridgeInferred += bridge.inferred;
      stats.bridgePlanOnly += bridge.planOnly;
      stats.bridgeDeckBlocks += bridge.deckBlocks;
      stats.bridgeRailBlocks += bridge.railBlocks;
      stats.bridgeSupportBlocks += bridge.supportBlocks;
      continue;
    }
    if (feature.kind === "building" || feature.kind === "structure") {
      const polygons = polygonParts(feature.localGeometry);
      const rings = polygons.flat();
      const assignedEntrance = entranceAssignments.get(feature.id) || null;
      if (buildingMode === "markers") {
        const marker = polygons.length ? compileBuildingMarker({
          add, feature, polygons, rings, mask, elevationY, surface, accessDistance,
          minX, minZ, width, height, signs, usedSignCells, assignedEntrance
        }) : feature.localGeometry.type === "Point" ? compilePointBuildingMarker({
          add, feature, mask, elevationY, surface, accessDistance, minX, minZ, width, height,
          signs, usedSignCells, assignedEntrance
        }) : { cells: 0, sign: null };
        stats.buildingMarkerFootprints += polygons.length && marker.cells ? 1 : 0;
        stats.pointBuildingMarkers += feature.localGeometry.type === "Point" && marker.cells ? 1 : 0;
        stats.unrepresentedBuildingFeatures += marker.cells ? 0 : 1;
        stats.buildingMarkerCells += marker.cells;
        stats.buildingSigns += marker.sign ? 1 : 0;
        stats.unnamedBuildingMarkers += marker.cells && !marker.sign ? 1 : 0;
        if (marker.sign?.placementSource === "mapped-building-entrance") stats.signsAtMappedEntrances += 1;
        else if (marker.sign?.placementSource === "nearest-mapped-path") stats.signsNearMappedPaths += 1;
        else if (marker.sign?.placementSource === "mapped-point") stats.signsAtMappedPoints += 1;
        else if (marker.sign) stats.signsAtInteriorFallback += 1;
        continue;
      }
      if (!polygons.length) continue;
      let heightM = feature.vertical.heightM;
      const measuredByLidar = feature.kind === "building" &&
        String(feature.vertical.heightSource || "").endsWith("dsm-minus-dtm");
      if (measuredByLidar) stats.measuredBuildingHeights += 1;
      if (heightM === null) {
        if (accuracyMode === "plausible") {
          heightM = inferredHeight(feature);
          stats.inferredBuildingHeights += 1;
        } else {
          heightM = 1;
          stats.footprintOnlyBuildings += 1;
        }
      }
      const wallBlock = buildingBlock(feature);
      if (measuredByLidar && typeof elevation?.samplePairLocal === "function") {
        stats.lidarRoofCells += compileLidarBuilding({
          add, feature, polygons, rings, mask, elevationY, minX, minZ, width, height,
          minDatum, elevation, heightM, wallBlock
        });
        stats.lidarRoofBuildings += 1;
        const sign = compileShellBuildingSign({
          add, feature, polygons, mask, elevationY, surface, accessDistance,
          minX, minZ, width, height, signs, usedSignCells, assignedEntrance
        });
        recordBuildingSignStats(stats, sign);
        continue;
      }
      for (const polygon of polygons) {
        const roofSpans = polygonScanlineSpans(polygon);
        for (const [rawX1, rawX2, z] of roofSpans) {
          for (const [x1, x2] of maskedSubspans(rawX1, rawX2, z, mask, minX, minZ, width, height)) {
            const y = terrainAt(Math.round((x1 + x2) / 2), z, mask, elevationY, minX, minZ, width, height);
            add(2, x1, y + 1, z, x2, y + 1, z, buildingFloorBlock(feature));
          }
        }
        for (const [rawX1, rawX2, z] of roofSpans) {
          for (const [x1, x2] of maskedSubspans(rawX1, rawX2, z, mask, minX, minZ, width, height)) {
            const y = terrainAt(Math.round((x1 + x2) / 2), z, mask, elevationY, minX, minZ, width, height);
            add(2, x1, y + Math.max(1, Math.round(heightM)), z, x2, y + Math.max(1, Math.round(heightM)), z, roofBlock(feature));
          }
        }
        for (const ring of polygon) {
          for (const [rawX1, rawX2, z] of groupCells(lineCells(ring, 1))) {
            for (const [x1, x2] of maskedSubspans(rawX1, rawX2, z, mask, minX, minZ, width, height)) {
              const y = terrainAt(Math.round((x1 + x2) / 2), z, mask, elevationY, minX, minZ, width, height);
              add(2, x1, y + 1, z, x2, y + Math.max(1, Math.round(heightM)), z, wallBlock);
            }
          }
        }
      }
      const sign = compileShellBuildingSign({
        add, feature, polygons, mask, elevationY, surface, accessDistance,
        minX, minZ, width, height, signs, usedSignCells, assignedEntrance
      });
      recordBuildingSignStats(stats, sign);
      continue;
    }

    if (feature.kind === "ride_attachment") {
      const result = compileRideAttachment({
        add, feature, mask, elevationY, minX, minZ, width, height, minDatum
      });
      stats.rideAttachmentFeatures += 1;
      stats.rideAttachmentRendered += result.rendered ? 1 : 0;
      stats.rideAttachmentWithheld += result.rendered ? 0 : 1;
      stats.rideAttachmentBlocks += result.blocks;
      stats.rideAttachmentTypes[result.type] = (stats.rideAttachmentTypes[result.type] || 0) + 1;
      stats.rideAttachmentEvidence.push(result.evidence);
      continue;
    }

    if (["barrier", "rail", "ride_support", "ride_track"].includes(feature.kind)) {
      if (feature.kind === "ride_track" && feature.rideProfile) {
        const result = compileRideProfileTrack({
          add, feature, mask, elevationY, accessSurface: surface,
          minX, minZ, width, height, minDatum, options
        });
        stats.profiledRideTracks += 1;
        stats.rideProfileBlocks += result.blocks;
        stats.groundPlanRideTracks += result.flatBlocks;
        if (feature.rideProfile.coverage?.vertical < 0.999) stats.partialRideProfileTracks += 1;
        for (const [evidence, count] of Object.entries(result.evidenceBlocks)) {
          stats.rideProfileEvidenceBlocks[evidence] = (stats.rideProfileEvidenceBlocks[evidence] || 0) + count;
        }
        stats.rideExplicitTunnelFeatures += result.explicitTunnel ? 1 : 0;
        stats.rideTerrainDetectedTunnelFeatures += result.terrainDetectedTunnel ? 1 : 0;
        stats.rideTunnelTrackBlocks += result.tunnelTrackBlocks;
        stats.rideTunnelInferredTrackBlocks += result.inferredTunnelTrackBlocks;
        stats.rideTunnelExcavatedBlocks += result.excavatedBlocks;
        stats.rideTunnelLiningBlocks += result.liningBlocks;
        stats.rideTunnelPortalFrames += result.portalFrames;
        stats.rideTunnelPortalBlocks += result.portalBlocks;
        stats.rideSupportFrames += result.supportFrames;
        stats.rideSupportBlocks += result.supportBlocks;
        stats.rideSupportFootings += result.supportFootings;
        stats.rideStructureEvidence.push(result.evidence);
        continue;
      }
      if (feature.kind === "ride_support" && feature.localGeometry?.type === "Point") {
        const result = compilePlanningRideSupport({
          add, feature, mask, elevationY, minX, minZ, width, height
        });
        stats.rideSupportFrames += result.frames;
        stats.rideSupportBlocks += result.blocks;
        stats.rideSupportFootings += result.footings;
        if (result.frames) stats.rideStructureEvidence.push(result.evidence);
        continue;
      }
      const lines = lineStrings(feature.localGeometry);
      for (const line of lines) {
        const widthM = feature.kind === "ride_track" ? 1 : numericWidth(feature.tags?.width, 1);
        const cells = lineCells(line, widthM);
        for (const [rawX1, rawX2, z] of groupCells(cells)) {
          for (const [x1, x2] of maskedSubspans(rawX1, rawX2, z, mask, minX, minZ, width, height)) {
            const terrainY = terrainAt(Math.round((x1 + x2) / 2), z, mask, elevationY, minX, minZ, width, height);
            if (feature.kind === "barrier") {
              const block = barrierBlock(feature);
              const fallbackHeight = block.includes("_fence") || block === "minecraft:iron_bars" ? 1 : 2;
              const barrierHeight = Math.max(1, Math.round(feature.vertical.heightM ?? fallbackHeight));
              add(4, x1, terrainY + 1, z, x2, terrainY + barrierHeight, z, block);
            }
            else if (feature.kind === "rail") add(3, x1, terrainY + 1, z, x2, terrainY + 1, z, "minecraft:iron_block");
            else if (feature.kind === "ride_support") add(3, x1, terrainY + 1, z, x2, terrainY + 3, z, "minecraft:iron_bars");
            else {
              const verifiedY = feature.vertical.elevationM !== null
                ? Math.round(feature.vertical.elevationM - minDatum)
                : null;
              if (verifiedY === null) {
                add(3, x1, terrainY + 2, z, x2, terrainY + 2, z, "minecraft:orange_concrete");
                stats.groundPlanRideTracks += 1;
              } else {
                add(3, x1, verifiedY, z, x2, verifiedY, z, "minecraft:red_concrete");
                stats.verticallyTaggedRideTracks += 1;
              }
            }
          }
        }
      }
      continue;
    }

    if (feature.kind === "vegetation") {
      const maximumModels = options.maxVegetationModels ?? 15_000;
      const usedModels = stats.treeModels + stats.shrubModels;
      const tree = compileVegetationFeature({
        add, feature, mask, elevationY, accessSurface: surface, terrainDetailExclusion,
        minX, minZ, width, height, accuracyMode, elevation, options, seed,
        aerialSampler: map.orthophoto?.sampleTerrainLocal,
        remainingModels: Math.max(0, maximumModels - usedModels)
      });
      stats.treeFeatures += 1;
      stats.treeModels += tree.models;
      stats.treePositionMarkers += tree.markers;
      stats.treeRows += tree.rows;
      stats.treeTrunkBlocks += tree.trunkBlocks;
      stats.treeLeafBlocks += tree.leafBlocks;
      stats.treeHeightMeasuredOrTagged += tree.heightMeasuredOrTagged;
      stats.treeHeightInferred += tree.heightInferred;
      stats.treeCrownInferred += tree.crownInferred;
      stats.vegetationPolygonFeatures += tree.polygonFeatures;
      stats.vegetationDensityDerivedModels += tree.densityDerivedModels;
      stats.vegetationCanopyMatchedModels += tree.canopyMatchedModels;
      stats.shrubModels += tree.shrubModels;
      stats.hedgeFeatures += tree.hedgeFeatures;
      stats.hedgeBlocks += tree.hedgeBlocks;
      stats.vegetationSkippedBySafetyLimit += tree.skippedByLimit;
      continue;
    }

    if (feature.kind === "terrain_detail") {
      if (stats.terrainDetailMode === "off") continue;
      const maxModels = options.maxTerrainRocks ?? 2_000;
      const result = compileMappedTerrainDetail({
        add, feature, mask, elevationY, accessSurface: surface, terrainDetailExclusion,
        minX, minZ, width, height, seed, options,
        permitModel: stats.terrainRockDimensionedModels + stats.terrainRockPositionMarkers +
          stats.terrainInferredRockClusters < maxModels
      });
      stats.terrainRockPointFeatures += result.pointFeatures;
      stats.terrainRockDimensionedModels += result.dimensionedModels;
      stats.terrainRockPositionMarkers += result.positionMarkers;
      stats.terrainCliffFeatures += result.cliffFeatures;
      stats.terrainCliffMarkerBlocks += result.cliffMarkerBlocks;
      stats.terrainRockBlocks += result.blocks;
      stats.terrainRockSkippedBySafetyLimit += result.skippedByLimit;
      continue;
    }

    if (feature.kind === "surface" && isRockSurface(feature)) {
      const maxModels = options.maxTerrainRocks ?? 2_000;
      const result = compileMappedRockSurface({
        add, feature, mask, elevationY, accessSurface: surface, terrainDetailExclusion,
        minX, minZ, width, height, seed, options,
        remainingModels: Math.max(0, maxModels - stats.terrainRockDimensionedModels -
          stats.terrainRockPositionMarkers - stats.terrainInferredRockClusters)
      });
      stats.terrainRockSurfaceFeatures += result.features;
      stats.terrainRockSurfaceCells += result.surfaceCells;
      stats.terrainInferredRockClusters += result.inferredClusters;
      stats.terrainRockBlocks += result.blocks;
      stats.terrainRockSkippedBySafetyLimit += result.skippedByLimit;
      continue;
    }

    if (["attraction", "amenity", "detail"].includes(feature.kind)) {
      const [x, z] = featureCentroid(feature.localGeometry).map(Math.round);
      const index = cellIndex(x, z, minX, minZ, width, height);
      if (index < 0 || !mask[index]) continue;
      const y = terrainAt(x, z, mask, elevationY, minX, minZ, width, height);
      add(4, x, y + 1, z, x, y + (feature.kind === "attraction" ? 3 : 1), z, detailMarkerBlock(feature));
    }
  }

  const remainingAerialModels = Math.max(0, (options.maxVegetationModels ?? 15_000) -
    stats.treeModels - stats.shrubModels);
  if (remainingAerialModels > 0) {
    const aerialCanopy = compileAerialCanopyVegetation({
      add, map, mask, elevationY, accessSurface: surface, terrainDetailExclusion,
      mappedVegetationMask, minX, minZ, width, height, accuracyMode, elevation,
      options, seed, remainingModels: remainingAerialModels
    });
    stats.aerialCanopySamples += aerialCanopy.samples;
    stats.aerialCanopyModels += aerialCanopy.models;
    stats.aerialCanopyRejected += aerialCanopy.rejected;
    stats.treeModels += aerialCanopy.models;
    stats.treeTrunkBlocks += aerialCanopy.trunkBlocks;
    stats.treeLeafBlocks += aerialCanopy.leafBlocks;
    stats.treeHeightMeasuredOrTagged += aerialCanopy.heightMeasured;
    stats.treeHeightInferred += aerialCanopy.heightInferred;
    stats.treeCrownInferred += aerialCanopy.models;
    stats.vegetationCanopyMatchedModels += aerialCanopy.models;
  }
  return stats;
}

function buildMappedVegetationMask(map, raster) {
  const { minX, minZ, width, height } = raster;
  const result = new Uint8Array(width * height);
  for (const feature of map.features || []) {
    if (feature.kind !== "vegetation") continue;
    for (const polygon of polygonParts(feature.localGeometry)) {
      paintSpans(result, polygonScanlineSpans(polygon), minX, minZ, width, height, 1);
    }
    for (const line of lineStrings(feature.localGeometry)) {
      const modelClass = feature.fidelity?.tree?.modelClass || "tree-row";
      const lineWidth = modelClass === "hedge" ? 2 : 4;
      for (const [x, z] of lineCells(line, lineWidth)) {
        const index = cellIndex(x, z, minX, minZ, width, height);
        if (index >= 0) result[index] = 1;
      }
    }
    if (feature.localGeometry?.type === "Point") {
      const [cx, cz] = feature.localGeometry.coordinates.map(Math.round);
      for (let dz = -3; dz <= 3; dz += 1) for (let dx = -3; dx <= 3; dx += 1) {
        if (dx * dx + dz * dz > 9) continue;
        const index = cellIndex(cx + dx, cz + dz, minX, minZ, width, height);
        if (index >= 0) result[index] = 1;
      }
    }
  }
  return result;
}

function compileAerialCanopyVegetation(context) {
  const {
    add, map, mask, elevationY, accessSurface, terrainDetailExclusion, mappedVegetationMask,
    minX, minZ, width, height, accuracyMode, elevation, options, seed, remainingModels
  } = context;
  const sample = map.orthophoto?.sampleTerrainLocal;
  const evidenceEligible = Boolean(map.orthophoto?.landCover?.compilationEligible);
  const mode = options.aerialTerrainMode || "evidence";
  const stats = { samples: 0, models: 0, rejected: 0, trunkBlocks: 0, leafBlocks: 0, heightMeasured: 0, heightInferred: 0 };
  if (typeof sample !== "function" || !evidenceEligible || mode !== "evidence" || remainingModels <= 0) return stats;

  const spacing = Math.max(3, Math.round(options.vegetationMinSpacingM || 4));
  const density = Math.max(0, Number(options.treeDensityPer100m2 ?? 2.2));
  const probability = Math.min(1, density * spacing * spacing / 100);
  const minimumConfidence = Math.max(0.72, Number(options.aerialTerrainMinConfidence ?? 0.7));
  const offsetX = hashText("aerial-canopy-x") % spacing;
  const offsetZ = hashText("aerial-canopy-z") % spacing;

  for (let z = minZ + offsetZ; z < minZ + height && stats.models < remainingModels; z += spacing) {
    for (let x = minX + offsetX; x < minX + width && stats.models < remainingModels; x += spacing) {
      const index = cellIndex(x, z, minX, minZ, width, height);
      if (index < 0 || !mask[index] || mappedVegetationMask?.[index] ||
        terrainDetailExclusion?.[index] || isAccessSurface(accessSurface?.[index])) continue;
      const classification = sample(x, z);
      stats.samples += 1;
      if (classification?.class !== "dense-tree-canopy" || classification.confidence < minimumConfidence) {
        stats.rejected += 1;
        continue;
      }
      const roll = (hash2d(x, z, seed ^ 0x4a17c9) % 10_000) / 10_000;
      if (roll >= probability) continue;
      const resolvedHeight = resolveVegetationHeight({
        x, z,
        evidence: { heightM: null },
        elevation, modelClass: "woodland", accuracyMode,
        seed: seed ^ hashText(`aerial:${x}:${z}`)
      });
      if (!Number.isFinite(resolvedHeight.heightM)) {
        stats.rejected += 1;
        continue;
      }
      const model = compileHighFidelityTreeModel({
        add, x, z, groundY: elevationY[index], heightM: resolvedHeight.heightM,
        crownDiameterM: null, leafType: null,
        leafPalette: vegetationPaletteForRgb(classification.rgb),
        seed: seed ^ hashText(`aerial-tree:${x}:${z}`),
        detailLevel: options.treeDetailLevel || "medium"
      });
      stats.models += 1;
      stats.trunkBlocks += model.trunkBlocks;
      stats.leafBlocks += model.leafBlocks;
      if (resolvedHeight.observed) stats.heightMeasured += 1;
      else stats.heightInferred += 1;
    }
  }
  return stats;
}

function compileMappedTerrainDetail(context) {
  const {
    add, feature, mask, elevationY, accessSurface, terrainDetailExclusion,
    minX, minZ, width, height, seed, options, permitModel
  } = context;
  const empty = {
    pointFeatures: 0, dimensionedModels: 0, positionMarkers: 0,
    cliffFeatures: 0, cliffMarkerBlocks: 0, blocks: 0, skippedByLimit: 0
  };
  if (feature.localGeometry?.type === "Point") {
    const result = { ...empty, pointFeatures: 1 };
    if (!permitModel) return { ...result, skippedByLimit: 1 };
    const [rawX, rawZ] = feature.localGeometry.coordinates;
    const x = Math.round(rawX), z = Math.round(rawZ);
    const index = cellIndex(x, z, minX, minZ, width, height);
    if (index < 0 || !mask[index] || terrainDetailExclusion[index] || isAccessSurface(accessSurface[index])) return result;
    const explicitHeight = optionalNumber(feature.terrainDetail?.heightM);
    const explicitDiameter = optionalNumber(feature.terrainDetail?.diameterM);
    const dimensioned = Number.isFinite(explicitHeight) || Number.isFinite(explicitDiameter);
    const plausible = (options.terrainDetailMode || "evidence") === "plausible";
    const heightM = Number.isFinite(explicitHeight) ? clamp(Math.round(explicitHeight), 1, 12)
      : plausible ? 2 : 1;
    const diameterM = Number.isFinite(explicitDiameter) ? clamp(Math.round(explicitDiameter), 1, 12)
      : plausible ? 2 : 1;
    result.blocks = placeRockModel({
      add, x, z, heightM, diameterM, mask, elevationY, accessSurface, terrainDetailExclusion,
      minX, minZ, width, height, seed: seed ^ hashText(feature.id)
    });
    if (result.blocks) {
      if (dimensioned) result.dimensionedModels = 1;
      else result.positionMarkers = 1;
    }
    return result;
  }

  const result = { ...empty, cliffFeatures: 1 };
  const spacing = Math.max(1, Math.round(options.terrainCliffMarkerSpacingM || 2));
  const plausible = (options.terrainDetailMode || "evidence") === "plausible";
  const seen = new Set(), cells = [];
  for (const line of lineStrings(feature.localGeometry)) {
    for (const [x, z] of lineCells(line, 1)) {
      const key = `${x},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push([x, z]);
    }
  }
  for (let position = 0; position < cells.length; position += spacing) {
    const [x, z] = cells[position];
    const index = cellIndex(x, z, minX, minZ, width, height);
    if (index < 0 || !mask[index] || terrainDetailExclusion[index] || isAccessSurface(accessSurface[index])) continue;
    const y = elevationY[index];
    const block = rockBlock(x, y, z, seed ^ hashText(feature.id));
    add(4, x, y, z, x, y, z, block);
    result.blocks += 1;
    result.cliffMarkerBlocks += 1;
    if (plausible && hash2d(x, z, seed) % 3 === 0) {
      add(4, x, y + 1, z, x, y + 1, z, rockBlock(x, y + 1, z, seed));
      result.blocks += 1;
    }
  }
  return result;
}

function compileMappedRockSurface(context) {
  const {
    add, feature, mask, elevationY, accessSurface, terrainDetailExclusion,
    minX, minZ, width, height, seed, options, remainingModels
  } = context;
  const mode = options.terrainDetailMode || "evidence";
  if (mode === "off") return { features: 0, surfaceCells: 0, inferredClusters: 0, blocks: 0, skippedByLimit: 0 };
  let surfaceCells = 0;
  const candidates = [];
  const density = Math.max(0, Number(options.terrainRockDensityPer100m2 ?? 0.75));
  const probabilityThreshold = Math.round(Math.min(1, density / 100) * 1_000_000);
  const featureSeed = seed ^ hashText(feature.id);
  for (const polygon of polygonParts(feature.localGeometry)) {
    for (const [rawX1, rawX2, z] of polygonScanlineSpans(polygon)) {
      for (const [x1, x2] of maskedSubspans(rawX1, rawX2, z, mask, minX, minZ, width, height)) {
        for (let x = x1; x <= x2; x += 1) {
          const index = cellIndex(x, z, minX, minZ, width, height);
          if (index < 0 || terrainDetailExclusion[index] || isAccessSurface(accessSurface[index])) continue;
          surfaceCells += 1;
          if (mode === "plausible" && probabilityThreshold &&
            hash2d(x, z, featureSeed) % 1_000_000 < probabilityThreshold) {
            candidates.push({ x, z, hash: hash2d(x, z, featureSeed ^ 0x51f15e) });
          }
        }
      }
    }
  }
  if (mode !== "plausible" || !candidates.length) {
    return { features: 1, surfaceCells, inferredClusters: 0, blocks: 0, skippedByLimit: 0 };
  }

  candidates.sort((a, b) => a.hash - b.hash || a.z - b.z || a.x - b.x);
  const minSpacing = Math.max(1, Number(options.terrainRockMinSpacingM || 4));
  const bucketSize = minSpacing;
  const buckets = new Map(), selected = [];
  for (const candidate of candidates) {
    if (selected.length >= remainingModels) break;
    const bx = Math.floor(candidate.x / bucketSize), bz = Math.floor(candidate.z / bucketSize);
    let clear = true;
    for (let dz = -1; dz <= 1 && clear; dz += 1) {
      for (let dx = -1; dx <= 1 && clear; dx += 1) {
        for (const other of buckets.get(`${bx + dx},${bz + dz}`) || []) {
          if (Math.hypot(candidate.x - other.x, candidate.z - other.z) < minSpacing) {
            clear = false;
            break;
          }
        }
      }
    }
    if (!clear) continue;
    selected.push(candidate);
    const key = `${bx},${bz}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(candidate);
  }

  let blocks = 0;
  for (const candidate of selected) {
    const heightM = 1 + (candidate.hash % 2);
    const diameterM = 1 + ((candidate.hash >>> 8) % 3);
    blocks += placeRockModel({
      add, x: candidate.x, z: candidate.z, heightM, diameterM,
      mask, elevationY, accessSurface, terrainDetailExclusion,
      minX, minZ, width, height, seed: featureSeed ^ candidate.hash
    });
  }
  return {
    features: 1,
    surfaceCells,
    inferredClusters: selected.length,
    blocks,
    skippedByLimit: selected.length >= remainingModels
      ? Math.max(0, candidates.length - selected.length)
      : 0
  };
}

function placeRockModel(context) {
  const {
    add, x, z, heightM, diameterM, mask, elevationY, accessSurface, terrainDetailExclusion,
    minX, minZ, width, height, seed
  } = context;
  const radius = Math.max(0.5, diameterM / 2);
  const extent = Math.max(0, Math.ceil(radius - 0.25));
  let blocks = 0;
  for (let dz = -extent; dz <= extent; dz += 1) {
    for (let dx = -extent; dx <= extent; dx += 1) {
      const cellX = x + dx, cellZ = z + dz;
      const index = cellIndex(cellX, cellZ, minX, minZ, width, height);
      if (index < 0 || !mask[index] || terrainDetailExclusion[index] || isAccessSurface(accessSurface[index])) continue;
      const horizontal = (dx / (radius + 0.25)) ** 2 + (dz / (radius + 0.25)) ** 2;
      for (let dy = 0; dy < heightM; dy += 1) {
        const vertical = ((dy + 0.35) / Math.max(1, heightM)) ** 2;
        const roughness = (hash2d(cellX + dy * 17, cellZ - dy * 13, seed) % 100) / 500;
        if (horizontal + vertical > 1.08 + roughness) continue;
        const y = elevationY[index] + 1 + dy;
        add(4, cellX, y, cellZ, cellX, y, cellZ, rockBlock(cellX, y, cellZ, seed));
        blocks += 1;
      }
    }
  }
  if (!blocks) {
    const index = cellIndex(x, z, minX, minZ, width, height);
    if (index >= 0 && mask[index] && !terrainDetailExclusion[index] && !isAccessSurface(accessSurface[index])) {
      add(4, x, elevationY[index] + 1, z, x, elevationY[index] + 1, z, "minecraft:cobblestone");
      blocks = 1;
    }
  }
  return blocks;
}

function rockBlock(x, y, z, seed) {
  const roll = hash2d(x + y * 7, z - y * 11, seed) % 100;
  if (roll < 48) return "minecraft:stone";
  if (roll < 70) return "minecraft:andesite";
  if (roll < 86) return "minecraft:tuff";
  if (roll < 96) return "minecraft:cobblestone";
  return "minecraft:moss_block";
}

function isRockSurface(feature) {
  return ["bare_rock", "scree", "quarry", "shingle", "rock", "stone", "outcrop"]
    .includes(String(feature.subtype || "").toLowerCase());
}

function buildTerrainDetailExclusion(map, mask, raster) {
  const excluded = new Uint8Array(mask.length);
  const kinds = new Set([
    "building", "structure", "water", "attraction", "ride_track", "ride_support", "ride_attachment", "rail"
  ]);
  for (const feature of map.features) {
    if (!kinds.has(feature.kind)) continue;
    for (const polygon of polygonParts(feature.localGeometry)) {
      paintSpans(excluded, polygonScanlineSpans(polygon),
        raster.minX, raster.minZ, raster.width, raster.height, 1);
    }
    if (feature.localGeometry?.type === "Point") {
      const [x, z] = feature.localGeometry.coordinates.map(Math.round);
      const index = cellIndex(x, z, raster.minX, raster.minZ, raster.width, raster.height);
      if (index >= 0) excluded[index] = 1;
    }
    for (const line of lineStrings(feature.localGeometry)) {
      const clearanceM = feature.kind === "ride_track" ? 3 : 1;
      for (const [x, z] of lineCells(line, clearanceM)) {
        const index = cellIndex(x, z, raster.minX, raster.minZ, raster.width, raster.height);
        if (index >= 0) excluded[index] = 1;
      }
    }
  }
  return excluded;
}

function compileBridgeFeature(context) {
  const {
    add, feature, mask, elevationY, minX, minZ, width, height, minDatum,
    accuracyMode, seed
  } = context;
  const evidence = feature.fidelity?.bridge || {};
  const hasVerticalEvidence = Number.isFinite(evidence.deckElevationM);
  const inferred = !hasVerticalEvidence && accuracyMode === "plausible";
  const planOnly = !hasVerticalEvidence && !inferred;
  const widthM = feature.fidelity?.path?.rasterWidthM ?? (accuracyMode === "plausible"
    ? feature.kind === "road" ? 4 : 2
    : 1);
  const deck = new Map();
  const centre = new Map();
  for (const line of lineStrings(feature.localGeometry)) {
    for (const [x, z] of lineCells(line, widthM)) {
      const index = cellIndex(x, z, minX, minZ, width, height);
      if (index >= 0 && mask[index]) deck.set(`${x},${z}`, { x, z, index });
    }
    for (const [x, z] of lineCells(line, 1)) {
      const index = cellIndex(x, z, minX, minZ, width, height);
      if (index >= 0 && mask[index]) centre.set(`${x},${z}`, { x, z, index });
    }
  }
  if (!deck.size) return {
    features: 0, measuredOrExplicit: 0, inferred: 0, planOnly: 0,
    deckBlocks: 0, railBlocks: 0, supportBlocks: 0
  };

  const deckEvidenceY = hasVerticalEvidence ? Math.round(evidence.deckElevationM - minDatum) : null;
  const terrainValues = [...deck.values()].map((cell) => elevationY[cell.index]);
  const inferredY = inferred ? percentileNumber(terrainValues.sort((a, b) => a - b), 0.8) +
    Math.max(1, Math.round(evidence.explicitClearanceM || 2)) : null;
  const deckYAt = (cell) => planOnly
    ? elevationY[cell.index] + 1
    : hasVerticalEvidence
      ? Math.max(elevationY[cell.index], deckEvidenceY)
      : Math.max(elevationY[cell.index] + 1, inferredY);

  for (const cell of deck.values()) {
    const block = planOnly
      ? "minecraft:orange_concrete"
      : blockForSurfaceStyle(feature.surfaceStyle, cell.x, cell.z, seed);
    add(3, cell.x, deckYAt(cell), cell.z, cell.x, deckYAt(cell), cell.z, block);
  }

  let railBlocks = 0, supportBlocks = 0;
  if (!planOnly) {
    const railBlock = ["boardwalk", "covered"].includes(evidence.structure)
      ? "minecraft:oak_fence"
      : "minecraft:iron_bars";
    const railCells = new Map();
    for (const cell of deck.values()) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = cell.x + dx, z = cell.z + dz;
        if (deck.has(`${x},${z}`)) continue;
        const index = cellIndex(x, z, minX, minZ, width, height);
        if (index < 0 || !mask[index]) continue;
        // Avoid closing the approach at bridge endpoints: an outside cell that
        // is also adjacent to the centreline is longitudinal, not a side rail.
        const centreNeighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          .filter(([cx, cz]) => centre.has(`${x + cx},${z + cz}`)).length;
        if (centreNeighbours > 1) continue;
        const key = `${x},${z}`;
        if (!railCells.has(key)) railCells.set(key, { x, z, y: deckYAt(cell) + 1 });
      }
    }
    for (const rail of railCells.values()) {
      add(4, rail.x, rail.y, rail.z, rail.x, rail.y, rail.z, railBlock);
      railBlocks += 1;
    }

    let sample = 0;
    for (const cell of centre.values()) {
      if (sample++ % 6) continue;
      const deckY = deckYAt(cell), terrainY = elevationY[cell.index];
      if (deckY - terrainY <= 1) continue;
      add(3, cell.x, terrainY + 1, cell.z, cell.x, deckY - 1, cell.z, "minecraft:iron_bars");
      supportBlocks += Math.max(0, deckY - terrainY - 1);
    }

    if (evidence.covered) {
      for (const cell of deck.values()) {
        const roofY = deckYAt(cell) + 4;
        add(4, cell.x, roofY, cell.z, cell.x, roofY, cell.z, "minecraft:spruce_planks");
      }
    }
  }
  return {
    features: 1,
    measuredOrExplicit: hasVerticalEvidence ? 1 : 0,
    inferred: inferred ? 1 : 0,
    planOnly: planOnly ? 1 : 0,
    deckBlocks: deck.size,
    railBlocks,
    supportBlocks
  };
}

function compileVegetationFeature(context) {
  const {
    add, feature, mask, elevationY, accessSurface, terrainDetailExclusion,
    minX, minZ, width, height, accuracyMode, elevation, options = {}, seed = 0,
    aerialSampler, remainingModels = 0
  } = context;
  const evidence = feature.fidelity?.tree || {};
  const modelClass = evidence.modelClass || "tree";
  const stats = {
    models: 0, markers: 0, rows: 0, trunkBlocks: 0, leafBlocks: 0,
    heightMeasuredOrTagged: 0, heightInferred: 0, crownInferred: 0, crownShapeObserved: 0, crownBaseObserved: 0,
    polygonFeatures: 0, densityDerivedModels: 0, canopyMatchedModels: 0,
    shrubModels: 0, hedgeFeatures: 0, hedgeBlocks: 0, skippedByLimit: 0
  };

  if (modelClass === "hedge") {
    const hedge = compileHedgeFeature({
      add, feature, evidence, mask, elevationY, accessSurface, terrainDetailExclusion,
      minX, minZ, width, height, aerialSampler, seed
    });
    stats.hedgeFeatures = hedge.features;
    stats.hedgeBlocks = hedge.blocks;
    stats.leafBlocks = hedge.blocks;
    return stats;
  }

  if (remainingModels <= 0) {
    stats.skippedByLimit = 1;
    return stats;
  }

  let candidates = [];
  if (feature.localGeometry.type === "Point") {
    const [x, z] = feature.localGeometry.coordinates;
    candidates = [{ x, z, densityDerived: false, canopy: aerialSampler?.(x, z) || null }];
  } else if (["LineString", "MultiLineString"].includes(feature.localGeometry.type)) {
    stats.rows = 1;
    let spacing = evidence.spacingM;
    if (!spacing && evidence.treeCount && evidence.treeCount > 1) {
      spacing = geometryLineLength(feature.localGeometry) / (evidence.treeCount - 1);
    }
    spacing ||= Math.max(2, Number(options.treeLineSpacingM ?? 4));
    candidates = resampleLineGeometry(feature.localGeometry, Math.max(2, spacing)).map(([x, z]) => ({
      x, z, densityDerived: true, canopy: aerialSampler?.(x, z) || null
    }));
  } else if (["Polygon", "MultiPolygon"].includes(feature.localGeometry.type)) {
    stats.polygonFeatures = 1;
    candidates = generateVegetationCoverCandidates({
      feature, evidence, modelClass, mask, accessSurface, terrainDetailExclusion,
      minX, minZ, width, height, options, seed, aerialSampler, remainingModels
    });
  }

  const unique = new Map();
  for (const candidate of candidates) {
    const x = Math.round(candidate.x), z = Math.round(candidate.z);
    const key = `${x},${z}`;
    if (!unique.has(key)) unique.set(key, { ...candidate, x, z });
  }
  const selected = [...unique.values()].slice(0, remainingModels);
  if (unique.size > selected.length) stats.skippedByLimit += unique.size - selected.length;

  for (const candidate of selected) {
    const { x, z } = candidate;
    const index = cellIndex(x, z, minX, minZ, width, height);
    if (index < 0 || !mask[index] || terrainDetailExclusion?.[index] || isAccessSurface(accessSurface?.[index])) continue;

    if (modelClass === "shrubland") {
      const shrub = compileShrubModel({
        add, x, z, groundY: elevationY[index],
        palette: vegetationPaletteForRgb(candidate.canopy?.rgb, evidence.leafType, evidence.leafCycle, evidence.species),
        seed: seed ^ hashText(feature.id)
      });
      stats.shrubModels += 1;
      stats.leafBlocks += shrub.leafBlocks;
      if (candidate.densityDerived) stats.densityDerivedModels += 1;
      if (["dense-tree-canopy", "vegetation"].includes(candidate.canopy?.class)) stats.canopyMatchedModels += 1;
      continue;
    }

    const resolvedHeight = resolveVegetationHeight({
      x, z, evidence, elevation, modelClass, accuracyMode,
      seed: seed ^ hashText(feature.id)
    });
    if (!Number.isFinite(resolvedHeight.heightM)) {
      add(4, x, elevationY[index] + 1, z, x, elevationY[index] + 1, z, "minecraft:lime_concrete");
      stats.markers += 1;
      continue;
    }
    if (resolvedHeight.observed) stats.heightMeasuredOrTagged += 1;
    else stats.heightInferred += 1;

    const leafPalette = vegetationPaletteForRgb(
      candidate.canopy?.rgb, evidence.leafType, evidence.leafCycle, evidence.species
    );
    const model = compileHighFidelityTreeModel({
      add, x, z, groundY: elevationY[index], heightM: resolvedHeight.heightM,
      crownDiameterM: evidence.crownDiameterM, leafType: evidence.leafType, species: evidence.species,
      genus: evidence.genus, tags: feature.tags || {},
      reconstruction: evidence.reconstruction || evidence.canopyGeometry || null,
      leafPalette, seed: seed ^ hashText(`${feature.id}:${x}:${z}`),
      detailLevel: options.treeDetailLevel || "high"
    });
    stats.models += 1;
    stats.trunkBlocks += model.trunkBlocks;
    stats.leafBlocks += model.leafBlocks;
    if (!Number.isFinite(evidence.crownDiameterM)) stats.crownInferred += 1;
    if (model.reconstructionObserved) stats.crownShapeObserved += 1;
    if (model.crownBaseObserved) stats.crownBaseObserved += 1;
    if (candidate.densityDerived) stats.densityDerivedModels += 1;
    if (["dense-tree-canopy", "vegetation"].includes(candidate.canopy?.class)) stats.canopyMatchedModels += 1;
  }
  return stats;
}

function generateVegetationCoverCandidates(context) {
  const {
    feature, evidence, modelClass, mask, accessSurface, terrainDetailExclusion,
    minX, minZ, width, height, options, seed, aerialSampler, remainingModels
  } = context;
  const density = Math.max(0, Number(evidence.densityPer100M2 || 0));
  const explicitCount = Number.isInteger(evidence.treeCount) && evidence.treeCount > 0 ? evidence.treeCount : null;
  if ((!density && !explicitCount) || remainingModels <= 0) return [];
  const minimumSpacing = Math.max(1.5, Number(evidence.spacingM || options.vegetationMinSpacingM || 4));
  const scanStep = Math.max(1, Math.floor(minimumSpacing / 2));
  const featureSeed = seed ^ hashText(feature.id);
  const raw = [];
  let eligibleCells = 0;

  for (const polygon of polygonParts(feature.localGeometry)) {
    for (const [rawX1, rawX2, z] of polygonScanlineSpans(polygon)) {
      for (let x = rawX1; x <= rawX2; x += scanStep) {
        const index = cellIndex(x, z, minX, minZ, width, height);
        if (index < 0 || !mask[index] || terrainDetailExclusion?.[index] || isAccessSurface(accessSurface?.[index])) continue;
        eligibleCells += scanStep;
        const canopy = aerialSampler?.(x, z) || null;
        const multiplier = vegetationAerialMultiplier(canopy, modelClass);
        if (multiplier <= 0) continue;
        const hash = hash2d(x, z, featureSeed);
        raw.push({ x, z, hash, score: hash / multiplier, canopy, densityDerived: true });
      }
    }
  }

  const target = Math.min(
    remainingModels,
    explicitCount || Math.max(1, Math.round((eligibleCells * density) / 100))
  );
  raw.sort((a, b) => a.score - b.score || a.hash - b.hash || a.z - b.z || a.x - b.x);
  const buckets = new Map();
  const selected = [];
  const bucketSize = minimumSpacing;
  for (const candidate of raw) {
    if (selected.length >= target) break;
    const bx = Math.floor(candidate.x / bucketSize), bz = Math.floor(candidate.z / bucketSize);
    let clear = true;
    for (let dz = -1; dz <= 1 && clear; dz += 1) {
      for (let dx = -1; dx <= 1 && clear; dx += 1) {
        for (const other of buckets.get(`${bx + dx},${bz + dz}`) || []) {
          if (Math.hypot(candidate.x - other.x, candidate.z - other.z) < minimumSpacing) {
            clear = false;
            break;
          }
        }
      }
    }
    if (!clear) continue;
    selected.push(candidate);
    const key = `${bx},${bz}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(candidate);
  }
  return selected;
}

function vegetationAerialMultiplier(classification, modelClass) {
  if (!classification) return 1;
  if (["water-candidate", "neutral-hardscape-candidate", "shadow"].includes(classification.class)) return 0;
  if (classification.class === "dense-tree-canopy") return modelClass === "shrubland" ? 1.05 : 1.45;
  if (classification.class === "vegetation") return 1.15;
  if (classification.class === "grass") return modelClass === "shrubland" ? 0.65 : 0.28;
  if (classification.class === "dry-grass") return modelClass === "shrubland" ? 0.55 : 0.18;
  if (classification.class === "soil-mulch") return modelClass === "shrubland" ? 0.5 : 0.2;
  if (classification.class === "rock-gravel" || classification.class === "sand") return 0.08;
  return 0.65;
}

function resolveVegetationHeight({ x, z, evidence, elevation, modelClass, accuracyMode, seed }) {
  if (Number.isFinite(evidence.heightM)) return { heightM: evidence.heightM, observed: true };
  if (typeof elevation?.samplePairLocal === "function") {
    const pair = elevation.samplePairLocal(x, z);
    const measured = Number.isFinite(pair?.surface) && Number.isFinite(pair?.terrain)
      ? pair.surface - pair.terrain : null;
    if (Number.isFinite(measured) && measured >= 2 && measured <= 60) {
      return { heightM: measured, observed: true };
    }
  }
  const hash = hash2d(x, z, seed);
  if (modelClass === "orchard") return { heightM: 5 + hash % 4, observed: false };
  if (modelClass === "tree-row") return { heightM: 7 + hash % 7, observed: false };
  if (modelClass === "woodland") return { heightM: 9 + hash % 10, observed: false };
  if ((accuracyMode || "verified") === "plausible") return { heightM: 7 + hash % 5, observed: false };
  return { heightM: null, observed: false };
}

function compileHedgeFeature(context) {
  const {
    add, feature, evidence, mask, elevationY, accessSurface, terrainDetailExclusion,
    minX, minZ, width, height, aerialSampler, seed
  } = context;
  const widthM = clamp(Math.round(numericWidth(feature.tags?.width, 1)), 1, 4);
  const hedgeHeight = clamp(Math.round(numericWidth(feature.tags?.height, 2)), 1, 5);
  const palette = vegetationPaletteForRgb(
    aerialSampler?.(...featureCentroid(feature.localGeometry))?.rgb,
    evidence.leafType, evidence.leafCycle, evidence.species
  );
  let blocks = 0;
  for (const line of lineStrings(feature.localGeometry)) {
    for (const [x, z] of lineCells(line, widthM)) {
      const index = cellIndex(x, z, minX, minZ, width, height);
      if (index < 0 || !mask[index] || terrainDetailExclusion?.[index] || isAccessSurface(accessSurface?.[index])) continue;
      const primary = palette[hash2d(x, z, seed ^ hashText(feature.id)) % palette.length];
      add(4, x, elevationY[index] + 1, z, x, elevationY[index] + hedgeHeight, z, primary);
      blocks += hedgeHeight;
    }
  }
  return { features: blocks ? 1 : 0, blocks };
}

function compileShrubModel({ add, x, z, groundY, palette, seed }) {
  const radius = 1 + hash2d(x, z, seed) % 2;
  const shrubHeight = 1 + (hash2d(x + 7, z - 11, seed) % 3);
  let leafBlocks = 0;
  for (let dy = 1; dy <= shrubHeight; dy += 1) {
    const layerRadius = Math.max(1, radius - Math.floor((dy - 1) / 2));
    for (let dz = -layerRadius; dz <= layerRadius; dz += 1) {
      const span = Math.floor(Math.sqrt(Math.max(0, layerRadius * layerRadius - dz * dz)));
      const block = palette[hash2d(x + dy, z + dz, seed) % palette.length];
      add(4, x - span, groundY + dy, z + dz, x + span, groundY + dy, z + dz, block);
      leafBlocks += span * 2 + 1;
    }
  }
  return { leafBlocks };
}

function compileTreeModel({ add, x, z, groundY, heightM, crownDiameterM, leafType, species, leafPalette, seed = 0 }) {
  const treeHeight = Math.max(2, Math.min(40, Math.round(heightM)));
  const trunkHeight = Math.max(2, Math.min(treeHeight - 1, Math.round(treeHeight * 0.68)));
  const crownRadius = Math.max(1, Math.min(6, Math.round(
    Number.isFinite(crownDiameterM) ? crownDiameterM / 2 : treeHeight * 0.22
  )));
  const taxon = String(species || "").toLowerCase();
  const needled = String(leafType || "").toLowerCase().includes("needle") ||
    /spruce|pine|fir|larch|cedar|cypress|hemlock|douglas|conifer/.test(taxon);
  const log = needled ? "minecraft:spruce_log" : "minecraft:oak_log";
  const palette = leafPalette?.length ? leafPalette : needled
    ? ["minecraft:spruce_leaves", "minecraft:dark_oak_leaves"]
    : ["minecraft:oak_leaves", "minecraft:birch_leaves"];
  const crownBase = Math.max(2, trunkHeight - Math.max(1, Math.floor(crownRadius / 2)));
  let leafBlocks = 0;
  for (let relativeY = crownBase; relativeY <= treeHeight; relativeY += 1) {
    const fraction = (relativeY - crownBase) / Math.max(1, treeHeight - crownBase);
    const profile = needled ? 1 - fraction * 0.75 : Math.sin(Math.PI * Math.max(0.08, fraction));
    const radius = Math.max(1, Math.round(crownRadius * Math.max(0.3, profile)));
    for (let dz = -radius; dz <= radius; dz += 1) {
      const span = Math.floor(Math.sqrt(Math.max(0, radius * radius - dz * dz)));
      const leaves = palette[hash2d(x + relativeY, z + dz, seed) % palette.length];
      add(4, x - span, groundY + relativeY, z + dz, x + span, groundY + relativeY, z + dz, leaves);
      leafBlocks += span * 2 + 1;
    }
  }
  add(4, x, groundY + 1, z, x, groundY + trunkHeight, z, log);
  return { trunkBlocks: trunkHeight, leafBlocks };
}

function compileRideProfileTrack(context) {
  const {
    add, feature, mask, elevationY, minX, minZ, width, height, minDatum, options = {}
  } = context;
  const terrainMode = options.rideTerrainMode || "inferred";
  const settings = rideStructureSettings(feature, options);
  const explicitTunnel = hasExplicitTunnelSemantics(feature);
  const voxels = new Map();
  const evidenceBlocks = {};
  const tunnelInterior = new Set();
  const tunnelLining = new Set();
  const portalVoxels = new Set();
  const tunnelTrackKeys = new Set();
  const inferredTunnelTrackKeys = new Set();
  let terrainDetectedTunnel = false;
  let portalFrames = 0;
  const parts = feature.rideProfile?.parts || [];
  for (const part of parts) {
    const resolved = resolveRidePart({
      part, explicitTunnel, terrainMode, settings, mask, elevationY,
      minX, minZ, width, height, minDatum
    });
    const orderedTrack = [];
    let previousTrackKey = null;
    for (let index = 1; index < resolved.length; index += 1) {
      const from = resolved[index - 1], to = resolved[index];
      if (Number.isFinite(from.effectiveElevationM) && Number.isFinite(to.effectiveElevationM)) {
        const evidence = weakestEvidence(from.effectiveEvidence, to.effectiveEvidence);
        const block = RIDE_EVIDENCE_LEGEND[evidence]?.block || RIDE_EVIDENCE_LEGEND.inferred.block;
        const points = line3dCells(
          [from.x, from.effectiveElevationM - minDatum, from.z],
          [to.x, to.effectiveElevationM - minDatum, to.z]
        );
        for (const [x, y, z] of points) {
          const rasterIndex = cellIndex(x, z, minX, minZ, width, height);
          if (rasterIndex < 0 || !mask[rasterIndex]) continue;
          const structureInferred = from.structureInferred || to.structureInferred;
          const terrainY = elevationY[rasterIndex];
          const coveredByTerrain = terrainY >= y + settings.aboveM + settings.coverM;
          const intersectsTerrain = terrainY >= y - settings.belowM;
          const topologyTunnel = terrainMode !== "off" && explicitTunnel && intersectsTerrain;
          const detectedTunnel = terrainMode !== "off" && !explicitTunnel && !structureInferred &&
            evidenceRank(evidence) >= evidenceRank("lidar-derived") && coveredByTerrain;
          const tunnel = topologyTunnel || detectedTunnel;
          if (detectedTunnel) terrainDetectedTunnel = true;
          const key = `${x},${y},${z}`;
          const existing = voxels.get(key);
          const candidate = {
            x, y, z, evidence, block, flat: false, tunnel,
            tunnelBasis: topologyTunnel ? "explicit-map-semantics" : detectedTunnel ? "profile-below-dtm" : null,
            structureInferred
          };
          if (!existing || evidenceRank(evidence) > evidenceRank(existing.evidence)) {
            voxels.set(key, candidate);
          } else if (tunnel && !existing.tunnel) {
            existing.tunnel = true;
            existing.tunnelBasis = candidate.tunnelBasis;
            existing.structureInferred ||= structureInferred;
          }
          const ordered = voxels.get(key) || candidate;
          if (key !== previousTrackKey) {
            orderedTrack.push(ordered);
            previousTrackKey = key;
          }
        }
      } else {
        for (const [x, z] of lineCells([[from.x, from.z], [to.x, to.z]], 1)) {
          const rasterIndex = cellIndex(x, z, minX, minZ, width, height);
          if (rasterIndex < 0 || !mask[rasterIndex]) continue;
          const y = elevationY[rasterIndex] + 2;
          const key = `${x},${y},${z}`;
          if (!voxels.has(key)) {
            voxels.set(key, {
              x, y, z, evidence: "none", block: RIDE_EVIDENCE_LEGEND.none.block, flat: true
            });
          }
        }
      }
    }
    if (explicitTunnel) normalizeExplicitTunnelRun(orderedTrack);
    for (const point of orderedTrack) {
      if (!point.tunnel) continue;
      const key = `${point.x},${point.y},${point.z}`;
      tunnelTrackKeys.add(key);
      if (point.structureInferred || point.evidence === "inferred") inferredTunnelTrackKeys.add(key);
      stampTunnelCorridor({
        point, settings, tunnelInterior, tunnelLining,
        mask, elevationY, minX, minZ, width, height
      });
    }
    if (terrainMode !== "off") {
      portalFrames += compileTunnelPortals({
        orderedTrack, explicitTunnel, settings, portalVoxels,
        mask, minX, minZ, width, height
      });
    }
  }

  for (const key of tunnelInterior) tunnelLining.delete(key);
  emitVoxelRuns(add, 6, tunnelLining, "minecraft:tuff");
  emitVoxelRuns(add, 7, tunnelInterior, "minecraft:air");
  emitVoxelRuns(add, 8, portalVoxels, "minecraft:stone_bricks");

  let flatBlocks = 0;
  for (const voxel of voxels.values()) {
    add(9, voxel.x, voxel.y, voxel.z, voxel.x, voxel.y, voxel.z, voxel.block);
    evidenceBlocks[voxel.evidence] = (evidenceBlocks[voxel.evidence] || 0) + 1;
    if (voxel.flat) flatBlocks += 1;
  }
  const evidence = {
    featureId: feature.id,
    name: feature.name || null,
    mode: terrainMode,
    representation: "one-block-centreline",
    widthBlocks: 1,
    bankingRendered: false,
    crossTiesRendered: false,
    explicitTunnel,
    tunnelSemantics: explicitTunnel ? {
      tunnel: feature.tags?.tunnel || null,
      location: feature.tags?.location || null,
      layer: feature.tags?.layer || null,
      inheritedFrom: feature.rideProfile?.planSemantics?.replacementFeatureIds || []
    } : null,
    tunnelDimensionsM: {
      width: settings.widthM,
      aboveTrack: settings.aboveM,
      belowTrack: settings.belowM,
      minimumCover: settings.coverM
    },
    tunnelTrackBlocks: tunnelTrackKeys.size,
    inferredTunnelTrackBlocks: inferredTunnelTrackKeys.size,
    excavatedBlocks: tunnelInterior.size,
    liningBlocks: tunnelLining.size,
    portalFrames,
    portalBlocks: portalVoxels.size,
    terrainDetectedTunnel,
    supportFrames: 0,
    supportBlocks: 0,
    supportFootings: 0,
    supportMethod: "detected-planning-support-features-only"
  };
  return {
    blocks: voxels.size - flatBlocks,
    flatBlocks,
    evidenceBlocks,
    explicitTunnel,
    terrainDetectedTunnel,
    tunnelTrackBlocks: tunnelTrackKeys.size,
    inferredTunnelTrackBlocks: inferredTunnelTrackKeys.size,
    excavatedBlocks: tunnelInterior.size,
    liningBlocks: tunnelLining.size,
    portalFrames,
    portalBlocks: portalVoxels.size,
    supportFrames: 0,
    supportBlocks: 0,
    supportFootings: 0,
    evidence
  };
}

function normalizeExplicitTunnelRun(orderedTrack) {
  const covered = [];
  for (let index = 0; index < orderedTrack.length; index += 1) {
    if (orderedTrack[index].tunnelBasis === "explicit-map-semantics") covered.push(index);
  }
  if (!covered.length) return;
  const first = covered[0], last = covered.at(-1);
  for (let index = first; index <= last; index += 1) {
    orderedTrack[index].tunnel = true;
    orderedTrack[index].tunnelBasis = "explicit-map-semantics";
  }
}

function rideStructureSettings(feature, options) {
  const tags = feature.tags || {};
  const positive = (values, fallback, min, max) => {
    const parsed = values.map(Number).find((value) => Number.isFinite(value) && value > 0);
    return Math.max(min, Math.min(max, parsed ?? fallback));
  };
  const widthM = positive([
    tags.tunnel_clearance_width_m, tags["tunnel:clearance:width"], options.rideTunnelWidthM
  ], 7, 3, 17);
  return {
    widthM,
    horizontalRadius: Math.max(1, Math.round((widthM - 1) / 2)),
    aboveM: Math.round(positive([
      tags.tunnel_clearance_above_m, tags["tunnel:clearance:above"], options.rideTunnelAboveM
    ], 4, 2, 12)),
    belowM: Math.round(positive([
      tags.tunnel_clearance_below_m, tags["tunnel:clearance:below"], options.rideTunnelBelowM
    ], 2, 1, 8)),
    coverM: Math.round(positive([
      tags.tunnel_cover_m, tags["tunnel:cover"], options.rideTunnelCoverM
    ], 1, 1, 12))
  };
}

function hasExplicitTunnelSemantics(feature) {
  const tunnel = String(feature.tags?.tunnel || "").toLowerCase();
  const location = String(feature.tags?.location || "").toLowerCase();
  return Boolean((tunnel && !["no", "false", "0"].includes(tunnel)) || location === "underground");
}

function resolveRidePart(context) {
  const {
    part, explicitTunnel, terrainMode, settings, mask, elevationY,
    minX, minZ, width, height, minDatum
  } = context;
  let chainageM = 0;
  const resolved = part.map((sample, index) => {
    if (index) chainageM += Math.hypot(sample.x - part[index - 1].x, sample.z - part[index - 1].z);
    return {
      ...sample,
      chainageM,
      effectiveElevationM: sample.elevationM,
      effectiveEvidence: sample.evidence || (Number.isFinite(sample.elevationM) ? "inferred" : "none"),
      structureInferred: false
    };
  });
  if (terrainMode !== "inferred" || !explicitTunnel) return resolved;

  let cursor = 0;
  while (cursor < resolved.length) {
    if (Number.isFinite(resolved[cursor].effectiveElevationM)) { cursor += 1; continue; }
    const start = cursor;
    while (cursor < resolved.length && !Number.isFinite(resolved[cursor].effectiveElevationM)) cursor += 1;
    const left = resolved[start - 1] || null;
    const right = resolved[cursor] || null;
    for (let index = start; index < cursor; index += 1) {
      const sample = resolved[index];
      const x = Math.round(sample.x), z = Math.round(sample.z);
      const rasterIndex = cellIndex(x, z, minX, minZ, width, height);
      if (rasterIndex < 0 || !mask[rasterIndex]) continue;
      const terrainAbsoluteM = elevationY[rasterIndex] + minDatum;
      const belowCoverM = terrainAbsoluteM - settings.aboveM - settings.coverM - 1;
      let inferredElevationM = belowCoverM;
      if (left && right && Number.isFinite(left.effectiveElevationM) && Number.isFinite(right.effectiveElevationM)) {
        const span = Math.max(0.001, right.chainageM - left.chainageM);
        const fraction = (sample.chainageM - left.chainageM) / span;
        const interpolated = left.effectiveElevationM +
          (right.effectiveElevationM - left.effectiveElevationM) * fraction;
        inferredElevationM = Math.min(interpolated, belowCoverM);
      } else if (left && Number.isFinite(left.effectiveElevationM)) {
        inferredElevationM = Math.min(left.effectiveElevationM, belowCoverM);
      } else if (right && Number.isFinite(right.effectiveElevationM)) {
        inferredElevationM = Math.min(right.effectiveElevationM, belowCoverM);
      }
      sample.effectiveElevationM = inferredElevationM;
      sample.effectiveEvidence = "inferred";
      sample.structureInferred = true;
    }
  }
  return resolved;
}

function stampTunnelCorridor(context) {
  const {
    point, settings, tunnelInterior, tunnelLining,
    mask, elevationY, accessSurface, minX, minZ, width, height
  } = context;
  const outerRadius = settings.horizontalRadius + 1;
  for (let dy = -settings.belowM - 1; dy <= settings.aboveM + 1; dy += 1) {
    for (let dz = -outerRadius; dz <= outerRadius; dz += 1) {
      for (let dx = -outerRadius; dx <= outerRadius; dx += 1) {
        const inner = insideRideEnvelope(dx, dy, dz,
          settings.horizontalRadius, settings.aboveM, settings.belowM);
        const outer = insideRideEnvelope(dx, dy, dz,
          outerRadius, settings.aboveM + 1, settings.belowM + 1);
        if (!outer) continue;
        const x = point.x + dx, y = point.y + dy, z = point.z + dz;
        const rasterIndex = cellIndex(x, z, minX, minZ, width, height);
        if (rasterIndex < 0 || !mask[rasterIndex] || y > elevationY[rasterIndex]) continue;
        const key = `${x},${y},${z}`;
        if (inner) tunnelInterior.add(key);
        else tunnelLining.add(key);
      }
    }
  }
}

function insideRideEnvelope(dx, dy, dz, horizontalRadius, aboveM, belowM) {
  const horizontalScale = horizontalRadius + 0.5;
  const verticalScale = (dy >= 0 ? aboveM : belowM) + 0.5;
  return (dx * dx + dz * dz) / (horizontalScale * horizontalScale) +
    (dy * dy) / (verticalScale * verticalScale) <= 1;
}

function compileTunnelPortals({
  orderedTrack, explicitTunnel, settings, portalVoxels, mask, minX, minZ, width, height
}) {
  if (!orderedTrack.length || !orderedTrack.some((point) => point.tunnel)) return 0;
  const candidates = [];
  for (let index = 1; index < orderedTrack.length; index += 1) {
    if (orderedTrack[index - 1].tunnel !== orderedTrack[index].tunnel) {
      candidates.push(orderedTrack[index].tunnel ? index : index - 1);
    }
  }
  if (explicitTunnel && orderedTrack[0].tunnel) candidates.push(0);
  if (explicitTunnel && orderedTrack.at(-1).tunnel) candidates.push(orderedTrack.length - 1);
  const unique = new Set();
  for (const index of candidates) {
    const point = orderedTrack[index];
    const prior = orderedTrack[Math.max(0, index - 1)] || point;
    const next = orderedTrack[Math.min(orderedTrack.length - 1, index + 1)] || point;
    const key = `${point.x},${point.y},${point.z}`;
    if (unique.has(key)) continue;
    unique.add(key);
    stampPortalFrame(point, { dx: next.x - prior.x, dz: next.z - prior.z }, settings, portalVoxels, {
      mask, minX, minZ, width, height
    });
  }
  return unique.size;
}

function stampPortalFrame(point, tangent, settings, target, raster) {
  const radius = settings.horizontalRadius + 1;
  const alongX = Math.abs(tangent.dx) >= Math.abs(tangent.dz);
  for (let lateral = -radius; lateral <= radius; lateral += 1) {
    for (let dy = -settings.belowM - 1; dy <= settings.aboveM + 1; dy += 1) {
      const border = Math.abs(lateral) === radius || dy === -settings.belowM - 1 || dy === settings.aboveM + 1;
      if (!border) continue;
      const x = point.x + (alongX ? 0 : lateral);
      const z = point.z + (alongX ? lateral : 0);
      const rasterIndex = cellIndex(x, z, raster.minX, raster.minZ, raster.width, raster.height);
      if (rasterIndex < 0 || !raster.mask[rasterIndex]) continue;
      target.add(`${x},${point.y + dy},${z}`);
    }
  }
}

function emitVoxelRuns(add, phase, voxels, block) {
  const rows = new Map();
  for (const key of voxels) {
    const [x, y, z] = key.split(",").map(Number);
    const rowKey = `${y},${z}`;
    if (!rows.has(rowKey)) rows.set(rowKey, []);
    rows.get(rowKey).push(x);
  }
  for (const [rowKey, values] of rows) {
    const [y, z] = rowKey.split(",").map(Number);
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    let start = sorted[0], end = sorted[0];
    for (let index = 1; index <= sorted.length; index += 1) {
      if (sorted[index] === end + 1) { end = sorted[index]; continue; }
      if (start !== undefined) add(phase, start, y, z, end, y, z, block);
      start = sorted[index];
      end = sorted[index];
    }
  }
}

function line3dCells(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))));
  const result = [];
  let previous = null;
  for (let index = 0; index <= steps; index += 1) {
    const fraction = index / steps;
    const point = [
      Math.round(from[0] + dx * fraction),
      Math.round(from[1] + dy * fraction),
      Math.round(from[2] + dz * fraction)
    ];
    const key = point.join(",");
    if (key !== previous) result.push(point);
    previous = key;
  }
  return result;
}

function weakestEvidence(first, second) {
  const a = first || "inferred", b = second || "inferred";
  return evidenceRank(a) <= evidenceRank(b) ? a : b;
}

function evidenceRank(value) {
  return ({
    none: 0,
    inferred: 1,
    "interpolated-lidar": 2,
    interpolated: 2,
    "lidar-derived": 3,
    "measured-lidar": 4,
    "planning-verified": 5,
    surveyed: 6,
    "manufacturer-cad": 7
  })[value] ?? 1;
}

function compilePlayerEvidenceSigns(context) {
  const {
    add, map, accuracy, signs, spawnLocal, mask, elevationY, surface, accessDistance,
    minX, minZ, width, height, options = {}
  } = context;
  const used = new Set(signs.map((sign) => `${sign.x},${sign.z}`));
  let playerInformationSigns = 0, rideInformationSigns = 0;
  const boardTexts = [
    [
      "VOXEL MAPPING TOOL",
      `Grade ${accuracy.grade} · ${(accuracy.score * 100).toFixed(1)}%`,
      "1 block = 1 metre",
      "Ride signs: evidence"
    ],
    [
      "TRACK COLOURS",
      "Cyan: survey/CAD",
      "Blue: planning",
      "Lime: LiDAR"
    ],
    [
      "MORE TRACK COLOURS",
      "Gold: interpolated",
      "Yellow: inferred",
      "Orange: no height"
    ],
    [
      "PATH SURFACES",
      "Orange: unknown",
      "Widths may be prior",
      "See evidence files"
    ],
    [
      "TERRAIN DETAIL",
      "Dirt: source material",
      (options.terrainDetailMode || "evidence") === "plausible"
        ? "Rock clusters: prior"
        : (options.terrainDetailMode || "evidence") === "off" ? "Rock models: off" : "Rocks: mapped only",
      "Not random scenery"
    ],
    [
      "RIDE GEOMETRY",
      "Track: 1-block line",
      "Supports: detected",
      "Catwalks: detected"
    ],
    [
      "NOT LIVE PARK INFO",
      "No queue/open status",
      "Not safety guidance",
      "Geometry evidence only"
    ]
  ];
  for (let index = 0; index < boardTexts.length; index += 1) {
    const target = { x: spawnLocal.x + index * 2 - 2, z: spawnLocal.z + 3 };
    const sign = placeEvidenceSign({
      add, target, text: boardTexts[index].join("\n"), role: "map-evidence",
      name: `Map evidence board ${index + 1}`, featureId: null,
      block: "minecraft:blue_concrete", used, mask, elevationY, surface, accessDistance,
      minX, minZ, width, height
    });
    if (sign) {
      signs.push(sign);
      playerInformationSigns += 1;
    }
  }

  for (const ride of map.rideProfiles?.rides || []) {
    if (!ride.name) continue;
    const feature = ride.featureIds.map((id) => map.features.find((candidate) => candidate.id === id)).find(Boolean);
    if (!feature) continue;
    const target = trackAccessTarget(feature, mask, accessDistance, minX, minZ, width, height);
    const primaryEvidence = dominantRideEvidence(ride.evidenceCounts);
    const sign = placeEvidenceSign({
      add,
      target,
      text: rideEvidenceSignText(ride),
      role: "ride-evidence",
      name: ride.name,
      featureId: feature.id,
      block: RIDE_EVIDENCE_LEGEND[primaryEvidence]?.block || RIDE_EVIDENCE_LEGEND.none.block,
      used, mask, elevationY, surface, accessDistance, minX, minZ, width, height,
      evidence: {
        status: ride.status,
        verticalCoverage: ride.verticalCoverage,
        representation: "one-block-centreline",
        widthBlocks: 1,
        bankingRendered: false,
        crossTiesRendered: false,
        confidence: ride.confidence,
        primaryEvidence,
        latestEvidenceDate: ride.latestEvidenceDate || null
      }
    });
    if (sign) {
      signs.push(sign);
      rideInformationSigns += 1;
    }
  }
  return { playerInformationSigns, rideInformationSigns };
}

function placeEvidenceSign(context) {
  const {
    add, target, text, role, name, featureId, block, used, mask, elevationY, surface,
    accessDistance, minX, minZ, width, height, evidence = null
  } = context;
  const cell = nearestEvidenceSignCell({
    target, used, mask, surface, accessDistance, minX, minZ, width, height
  });
  if (!cell) return null;
  used.add(`${cell.x},${cell.z}`);
  const terrainY = terrainAt(cell.x, cell.z, mask, elevationY, minX, minZ, width, height);
  add(5, cell.x, terrainY, cell.z, cell.x, terrainY, cell.z, block);
  add(5, cell.x, terrainY + 1, cell.z, cell.x, terrainY + 1, cell.z, "minecraft:standing_sign");
  return {
    x: cell.x,
    y: terrainY + 1,
    z: cell.z,
    text: safeEvidenceText(text),
    name,
    featureId,
    featureKind: role === "ride-evidence" ? "ride_track" : "map_evidence",
    role,
    placementSource: "nearest-mapped-path-evidence-board",
    entranceFeatureId: null,
    distanceToMappedPathM: accessDistanceValue(accessDistance[cell.index]),
    overlapsMappedPath: isAccessSurface(surface[cell.index]),
    evidence
  };
}

function nearestEvidenceSignCell({ target, used, mask, surface, accessDistance, minX, minZ, width, height }) {
  let best = null;
  const originX = Math.round(target.x), originZ = Math.round(target.z);
  for (let radius = 0; radius <= 14; radius += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (radius && Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const x = originX + dx, z = originZ + dz;
        const index = cellIndex(x, z, minX, minZ, width, height);
        if (index < 0 || !mask[index] || used.has(`${x},${z}`) || surface[index] === 3) continue;
        const onPath = isAccessSurface(surface[index]);
        const access = accessDistance[index] >= 65_535 ? 200 : accessDistance[index] / 10;
        const score = Math.hypot(dx, dz) + access * 1.8 + (onPath ? 6 : 0);
        if (!best || score < best.score) best = { x, z, index, score };
      }
    }
    if (best && radius >= 4) break;
  }
  return best;
}

function trackAccessTarget(feature, mask, accessDistance, minX, minZ, width, height) {
  let best = null;
  for (const line of lineStrings(feature.localGeometry)) {
    for (const [x, z] of lineCells(line, 1)) {
      const index = cellIndex(x, z, minX, minZ, width, height);
      if (index < 0 || !mask[index]) continue;
      const distance = accessDistance[index];
      if (!best || distance < best.distance) best = { x, z, distance };
    }
  }
  if (best) return best;
  const [x, z] = featureCentroid(feature.localGeometry);
  return { x, z };
}

function dominantRideEvidence(counts = {}) {
  const entries = Object.entries(counts).filter(([evidence]) => evidence !== "none");
  if (!entries.length) return "none";
  return entries.sort((a, b) => b[1] - a[1] || evidenceRank(b[0]) - evidenceRank(a[0]))[0][0];
}

function rideEvidenceSignText(ride) {
  const nameLines = wrapSignLines(ride.name, 20).slice(0, 2);
  const vertical = Math.round(ride.verticalCoverage * 100);
  const confidence = Math.round(ride.confidence * 100);
  const sourceYear = String(ride.latestEvidenceDate || "").slice(0, 4);
  const profileLine = vertical
    ? `3D:${vertical}% Conf:${confidence}%`
    : "Track: 2D only";
  const representationLine = `Line:1 block${sourceYear ? ` ${sourceYear}` : ""}`;
  return [...nameLines, profileLine, representationLine].slice(0, 4).join("\n");
}

function safeEvidenceText(value) {
  return String(value)
    .replace(/\u00a7[0-9a-fk-or]?/gi, "")
    .split(/\r?\n/)
    .slice(0, 4)
    .map((line) => Array.from(line.replace(/[\u0000-\u001f\u007f]+/g, " ")).slice(0, 20).join(""))
    .join("\n");
}

function wrapSignLines(value, width) {
  const words = String(value || "Unnamed ride").trim().split(/\s+/);
  const lines = [];
  for (const word of words) {
    const candidate = lines.length ? `${lines.at(-1)} ${word}` : word;
    if (Array.from(candidate).length <= width) {
      if (lines.length) lines[lines.length - 1] = candidate;
      else lines.push(candidate);
    } else {
      lines.push(Array.from(word).slice(0, width).join(""));
    }
  }
  return lines;
}

function compileBuildingMarker(context) {
  const {
    add, feature, polygons, rings, mask, elevationY, surface, accessDistance,
    minX, minZ, width, height, signs, usedSignCells, assignedEntrance
  } = context;
  let cells = 0;
  for (const ring of rings) {
    for (const [rawX1, rawX2, z] of groupCells(lineCells(ring, 1))) {
      for (const [x1, x2] of maskedSubspans(rawX1, rawX2, z, mask, minX, minZ, width, height)) {
        for (const run of valueRuns(x1, x2, (x) => terrainAt(x, z, mask, elevationY, minX, minZ, width, height))) {
          add(2, run.x1, run.value, z, run.x2, run.value, z, "minecraft:yellow_concrete");
          cells += run.x2 - run.x1 + 1;
        }
      }
    }
  }

  const signCell = selectSignCell({
    polygons,
    geometry: feature.localGeometry,
    mask,
    surface,
    accessDistance,
    minX,
    minZ,
    width,
    height,
    usedSignCells,
    assignedEntrance
  });
  const sign = placeBuildingSign({ ...context, signCell });
  return { cells, sign };
}

function compileShellBuildingSign(context) {
  const {
    feature, polygons, mask, surface, accessDistance,
    minX, minZ, width, height, usedSignCells, assignedEntrance
  } = context;
  const signCell = selectSignCell({
    polygons,
    geometry: feature.localGeometry,
    mask,
    surface,
    accessDistance,
    minX,
    minZ,
    width,
    height,
    usedSignCells,
    assignedEntrance
  });
  return placeBuildingSign({ ...context, signCell });
}

function recordBuildingSignStats(stats, sign) {
  if (!sign) return;
  stats.buildingSigns += 1;
  if (sign.placementSource === "mapped-building-entrance") stats.signsAtMappedEntrances += 1;
  else if (sign.placementSource === "nearest-mapped-path") stats.signsNearMappedPaths += 1;
  else if (sign.placementSource === "mapped-point") stats.signsAtMappedPoints += 1;
  else stats.signsAtInteriorFallback += 1;
}

function compilePointBuildingMarker(context) {
  const {
    add, feature, mask, elevationY, surface, accessDistance,
    minX, minZ, width, height, usedSignCells, assignedEntrance
  } = context;
  const [rawX, rawZ] = feature.localGeometry.coordinates;
  const x = Math.round(rawX), z = Math.round(rawZ);
  const index = cellIndex(x, z, minX, minZ, width, height);
  if (index < 0 || !mask[index]) return { cells: 0, sign: null };
  const terrainY = elevationY[index];
  add(2, x, terrainY, z, x, terrainY, z, "minecraft:yellow_concrete");
  const signCell = usedSignCells.has(`${x},${z}`) ? null : {
    x,
    z,
    placementSource: assignedEntrance ? "mapped-building-entrance" : "mapped-point",
    entranceFeatureId: assignedEntrance?.id || null,
    distanceToMappedPathM: accessDistanceValue(accessDistance[index]),
    overlapsMappedPath: isAccessSurface(surface[index])
  };
  const sign = placeBuildingSign({ ...context, signCell });
  return { cells: 1, sign };
}

function placeBuildingSign(context) {
  const {
    add, feature, signCell, mask, elevationY, minX, minZ, width, height,
    signs, usedSignCells
  } = context;
  const name = normalizedFeatureName(feature.name);
  if (!name || !signCell) return null;
  usedSignCells.add(`${signCell.x},${signCell.z}`);
  const terrainY = terrainAt(signCell.x, signCell.z, mask, elevationY, minX, minZ, width, height);
  const sign = {
    x: signCell.x,
    y: terrainY + 1,
    z: signCell.z,
    text: formatSignText(name),
    name,
    featureId: feature.id,
    featureKind: feature.kind,
    placementSource: signCell.placementSource,
    entranceFeatureId: signCell.entranceFeatureId || null,
    distanceToMappedPathM: signCell.distanceToMappedPathM,
    overlapsMappedPath: Boolean(signCell.overlapsMappedPath),
    role: "building"
  };
  // A solid one-block plinth keeps labels valid even for footprints over water.
  add(5, sign.x, terrainY, sign.z, sign.x, terrainY, sign.z, "minecraft:yellow_concrete");
  add(5, sign.x, sign.y, sign.z, sign.x, sign.y, sign.z, "minecraft:standing_sign");
  signs.push(sign);
  return sign;
}

function selectSignCell(context) {
  const {
    polygons, geometry, mask, surface, accessDistance,
    minX, minZ, width, height, usedSignCells, assignedEntrance
  } = context;
  const centroid = featureCentroid(geometry);
  const target = assignedEntrance ? featureCentroid(assignedEntrance.localGeometry) : centroid;
  let best = null;
  for (const polygon of polygons) {
    for (const [rawX1, rawX2, z] of polygonScanlineSpans(polygon)) {
      for (const [x1, x2] of maskedSubspans(rawX1, rawX2, z, mask, minX, minZ, width, height)) {
        for (let x = x1; x <= x2; x += 1) {
          if (usedSignCells.has(`${x},${z}`)) continue;
          const index = cellIndex(x, z, minX, minZ, width, height);
          const pathDistanceM = accessDistanceValue(accessDistance[index]);
          const overlapsMappedPath = isAccessSurface(surface[index]);
          const targetDistance = Math.hypot(x - target[0], z - target[1]);
          const centroidDistance = Math.hypot(x - centroid[0], z - centroid[1]);
          const score = assignedEntrance
            ? targetDistance * 10 + (overlapsMappedPath ? 100 : 0) + Math.min(25, pathDistanceM ?? 25)
            : (overlapsMappedPath ? 4 : (pathDistanceM ?? 1000)) * 1000 + centroidDistance;
          if (!best || score < best.score) {
            best = { x, z, score, pathDistanceM, overlapsMappedPath };
          }
        }
      }
    }
  }
  if (!best) return null;
  return {
    x: best.x,
    z: best.z,
    placementSource: assignedEntrance
      ? "mapped-building-entrance"
      : best.pathDistanceM !== null ? "nearest-mapped-path" : "interior-centroid",
    entranceFeatureId: assignedEntrance?.id || null,
    distanceToMappedPathM: best.pathDistanceM,
    overlapsMappedPath: best.overlapsMappedPath
  };
}

function normalizedFeatureName(value) {
  return String(value || "")
    .replace(/\u00a7[0-9a-fk-or]?/gi, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatSignText(value, { maxLines = 4, maxChars = 20 } = {}) {
  const source = normalizedFeatureName(value);
  if (!source) return "";
  const pending = [];
  for (const word of source.split(" ")) {
    const characters = Array.from(word);
    if (characters.length <= maxChars) pending.push(word);
    else {
      for (let index = 0; index < characters.length; index += maxChars) {
        pending.push(characters.slice(index, index + maxChars).join(""));
      }
    }
  }
  const lines = [];
  while (pending.length && lines.length < maxLines) {
    let line = pending.shift();
    while (pending.length && Array.from(`${line} ${pending[0]}`).length <= maxChars) {
      line += ` ${pending.shift()}`;
    }
    lines.push(line);
  }
  if (pending.length) {
    const last = Array.from(lines.at(-1) || "").slice(0, Math.max(1, maxChars - 1));
    lines[lines.length - 1] = `${last.join("")}…`;
  }
  return lines.join("\n");
}

function compileLidarBuilding(context) {
  const {
    add, feature, polygons, rings, mask, elevationY, minX, minZ, width, height,
    minDatum, elevation, heightM, wallBlock
  } = context;
  let roofCells = 0;
  const heightsAt = (x, z) => {
    const terrainY = terrainAt(x, z, mask, elevationY, minX, minZ, width, height);
    const pair = elevation.samplePairLocal(x, z);
    const measuredHeight = Number.isFinite(pair?.surface) && Number.isFinite(pair?.terrain)
      ? pair.surface - pair.terrain
      : null;
    const validMeasuredHeight = Number.isFinite(measuredHeight) && measuredHeight >= 1.5 && measuredHeight <= 80;
    const sampledRoofY = validMeasuredHeight ? Math.round(pair.surface - minDatum) : null;
    const fallbackRoofY = terrainY + Math.max(2, Math.round(heightM));
    return {
      terrainY,
      roofY: Number.isFinite(sampledRoofY) && sampledRoofY >= terrainY + 2 && sampledRoofY <= terrainY + 80
        ? sampledRoofY
        : fallbackRoofY
    };
  };

  for (const polygon of polygons) {
    const roofSpans = polygonScanlineSpans(polygon);
    for (const [rawX1, rawX2, z] of roofSpans) {
      for (const [x1, x2] of maskedSubspans(rawX1, rawX2, z, mask, minX, minZ, width, height)) {
        for (const group of heightRuns(x1, x2, (x) => heightsAt(x, z))) {
          add(2, group.x1, group.terrainY + 1, z, group.x2, group.terrainY + 1, z, buildingFloorBlock(feature));
          add(2, group.x1, group.roofY, z, group.x2, group.roofY, z, roofBlock(feature));
          roofCells += group.x2 - group.x1 + 1;
        }
      }
    }
  }
  for (const ring of rings) {
    for (const [rawX1, rawX2, z] of groupCells(lineCells(ring, 1))) {
      for (const [x1, x2] of maskedSubspans(rawX1, rawX2, z, mask, minX, minZ, width, height)) {
        for (const group of heightRuns(x1, x2, (x) => heightsAt(x, z))) {
          add(2, group.x1, group.terrainY + 1, z, group.x2, group.roofY, z, wallBlock);
        }
      }
    }
  }
  return roofCells;
}

function heightRuns(x1, x2, sampler) {
  const runs = [];
  let start = x1;
  let current = sampler(x1);
  for (let x = x1 + 1; x <= x2 + 1; x += 1) {
    const next = x <= x2 ? sampler(x) : null;
    if (next && next.terrainY === current.terrainY && next.roofY === current.roofY) continue;
    runs.push({ x1: start, x2: x - 1, ...current });
    start = x;
    current = next;
  }
  return runs;
}

function valueRuns(x1, x2, sampler) {
  const runs = [];
  let start = x1;
  let current = sampler(x1);
  for (let x = x1 + 1; x <= x2 + 1; x += 1) {
    const next = x <= x2 ? sampler(x) : null;
    if (x <= x2 && next === current) continue;
    runs.push({ x1: start, x2: x - 1, value: current });
    start = x;
    current = next;
  }
  return runs;
}

function paintFeatureSurface(
  feature, surface, accessSurface, discoveredAccess, pathEdgeStyles, mask, raster, accuracyMode, registerSurfaceStyle
) {
  const baseCode = surfaceCode(feature);
  const accessCode = feature.kind === "path" ? 1 : feature.kind === "road" ? 2 : 0;
  const bridge = accessCode && isBridgeFeature(feature);
  const discovered = feature.tags?.["orthophoto:discovered"] === "yes";
  const code = accessCode ? registerSurfaceStyle(feature.surfaceStyle) : baseCode;
  const pathWidthM = feature.fidelity?.path?.rasterWidthM;
  const edgeStyle = accessCode && feature.fidelity?.path?.edgeStyle?.enabled &&
    (["Polygon", "MultiPolygon"].includes(feature.localGeometry?.type) || Number(pathWidthM) >= 3)
    ? feature.fidelity.path.edgeStyle : null;
  const edgeCode = edgeStyle ? registerSurfaceStyle(edgeStyle) + 1 : 0;
  if (code === null) return;
  for (const polygon of polygonParts(feature.localGeometry)) {
    for (const [x1, x2, z] of polygonScanlineSpans(polygon)) {
      for (let x = x1; x <= x2; x += 1) {
        const index = cellIndex(x, z, raster.minX, raster.minZ, raster.width, raster.height);
        if (index >= 0 && mask[index]) {
          if (discovered && accessSurface[index]) continue;
          if (!bridge) surface[index] = code;
          if (accessCode) {
            accessSurface[index] = accessCode;
            if (edgeCode) pathEdgeStyles[index] = edgeCode;
            if (discovered) discoveredAccess[index] = 1;
          }
        }
      }
    }
  }
  if (["path", "road"].includes(feature.kind) &&
    ["LineString", "MultiLineString"].includes(feature.localGeometry?.type)) {
    const observedCorridor = feature.orthophoto?.path?.status === "accepted" &&
      feature.orthophoto.path.compilationEligible !== false
      ? feature.orthophoto.path.corridorLocal
      : null;
    if (observedCorridor) {
      for (const polygon of polygonParts(observedCorridor)) {
        for (const [x1, x2, z] of polygonScanlineSpans(polygon)) {
          for (let x = x1; x <= x2; x += 1) {
            const index = cellIndex(x, z, raster.minX, raster.minZ, raster.width, raster.height);
            if (index >= 0 && mask[index]) {
              if (!bridge) surface[index] = code;
              accessSurface[index] = accessCode;
              if (edgeCode) pathEdgeStyles[index] = edgeCode;
            }
          }
        }
      }
      // Preserve mapped topology through image gaps or canopy occlusion without
      // silently applying a class-prior width to those unsupported spans.
      for (const line of lineStrings(feature.localGeometry)) {
        for (const [x, z] of lineCells(line, 1)) {
          const index = cellIndex(x, z, raster.minX, raster.minZ, raster.width, raster.height);
          if (index >= 0 && mask[index]) {
            if (!bridge) surface[index] = code;
            accessSurface[index] = accessCode;
            if (edgeCode) pathEdgeStyles[index] = edgeCode;
          }
        }
      }
      return;
    }
    const widthM = feature.fidelity?.path?.rasterWidthM ?? numericWidth(feature.tags?.width,
      accuracyMode === "verified" ? 1 : feature.kind === "path" ? 2 : 4);
    for (const line of lineStrings(feature.localGeometry)) {
      for (const [x, z] of pathCellsForLine(line, feature.fidelity?.path, widthM)) {
        const index = cellIndex(x, z, raster.minX, raster.minZ, raster.width, raster.height);
        if (index >= 0 && mask[index]) {
          if (!bridge) surface[index] = code;
          accessSurface[index] = accessCode;
          if (edgeCode) pathEdgeStyles[index] = edgeCode;
        }
      }
    }
  }
}

function applyPathEdgeStyles({ surface, accessSurface, pathEdgeStyles, mask, width, height }) {
  let candidateCells = 0, edgeCells = 0;
  const neighbours = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column;
      const encoded = pathEdgeStyles[index];
      if (!encoded || !accessSurface[index] || !mask[index]) continue;
      candidateCells += 1;
      let boundary = false;
      for (const [dx, dz] of neighbours) {
        const x = column + dx, z = row + dz;
        if (x < 0 || x >= width || z < 0 || z >= height) { boundary = true; break; }
        const neighbour = z * width + x;
        if (!mask[neighbour] || !accessSurface[neighbour]) { boundary = true; break; }
      }
      if (!boundary) continue;
      surface[index] = encoded - 1;
      edgeCells += 1;
    }
  }
  return {
    schemaVersion: 1,
    status: edgeCells ? "applied" : "no-explicit-edge-evidence",
    candidateCells,
    edgeCells,
    method: "one-block interior boundary from explicit kerb/edge tags"
  };
}

function pathCellsForLine(line, pathEvidence, fallbackWidthM) {
  const profile = pathEvidence?.widthProfile;
  if (!profile || !Number.isFinite(profile.startM) || !Number.isFinite(profile.endM) || line.length < 2) {
    return lineCells(line, fallbackWidthM);
  }
  const segmentLengths = [];
  let totalLength = 0;
  for (let index = 1; index < line.length; index += 1) {
    const length = Math.hypot(line[index][0] - line[index - 1][0], line[index][1] - line[index - 1][1]);
    segmentLengths.push(length);
    totalLength += length;
  }
  if (!totalLength) return lineCells(line, fallbackWidthM);
  const cells = new Map();
  let travelled = 0;
  for (let index = 1; index < line.length; index += 1) {
    const from = line[index - 1], to = line[index], length = segmentLengths[index - 1];
    const steps = Math.max(1, Math.ceil(length / 2));
    for (let step = 0; step < steps; step += 1) {
      const t0 = step / steps, t1 = (step + 1) / steps;
      const a = [from[0] + (to[0] - from[0]) * t0, from[1] + (to[1] - from[1]) * t0];
      const b = [from[0] + (to[0] - from[0]) * t1, from[1] + (to[1] - from[1]) * t1];
      const midpointDistance = travelled + length * ((t0 + t1) / 2);
      const fraction = midpointDistance / totalLength;
      const widthM = profile.startM + (profile.endM - profile.startM) * fraction;
      for (const cell of lineCells([a, b], Math.max(1, Math.round(widthM)))) cells.set(`${cell[0]},${cell[1]}`, cell);
    }
    travelled += length;
  }
  return [...cells.values()];
}

function buildAccessDistance(surface, width, height) {
  const unreachable = 65_535;
  const distance = new Uint16Array(surface.length);
  distance.fill(unreachable);
  for (let index = 0; index < surface.length; index += 1) {
    if (surface[index] === 1) distance[index] = 0;
  }
  const relax = (index, candidate) => {
    if (candidate < distance[index]) distance[index] = Math.min(unreachable, candidate);
  };
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column;
      if (column) relax(index, distance[index - 1] + 10);
      if (row) relax(index, distance[index - width] + 10);
      if (row && column) relax(index, distance[index - width - 1] + 14);
      if (row && column + 1 < width) relax(index, distance[index - width + 1] + 14);
    }
  }
  for (let row = height - 1; row >= 0; row -= 1) {
    for (let column = width - 1; column >= 0; column -= 1) {
      const index = row * width + column;
      if (column + 1 < width) relax(index, distance[index + 1] + 10);
      if (row + 1 < height) relax(index, distance[index + width] + 10);
      if (row + 1 < height && column + 1 < width) relax(index, distance[index + width + 1] + 14);
      if (row + 1 < height && column) relax(index, distance[index + width - 1] + 14);
    }
  }
  return distance;
}

function surfaceCode(feature) {
  if (feature.kind === "path") return 1;
  if (feature.kind === "road") return 2;
  if (feature.kind === "water") return 3;
  if (feature.kind === "attraction" && ["Polygon", "MultiPolygon"].includes(feature.localGeometry.type)) return 7;
  if (feature.kind !== "surface") return null;
  const subtype = feature.subtype;
  if (["wood", "forest", "scrub", "garden", "park", "grass", "meadow", "recreation_ground"].includes(subtype)) return 4;
  if (["sand", "beach"].includes(subtype)) return 5;
  if (["bare_rock", "scree", "quarry", "shingle", "rock", "stone", "outcrop"].includes(subtype)) return 6;
  if (["mud", "dirt", "earth", "bare_ground", "brownfield", "construction"].includes(subtype)) return 8;
  return 0;
}

function buildElevationSampler(elevation) {
  if (typeof elevation?.sampleLocal === "function") return elevation.sampleLocal;
  if (!elevation?.points?.length || !elevation.bounds || !elevation.rows || !elevation.columns) return () => 0;
  const { minX, minZ, maxX, maxZ } = elevation.bounds;
  const rows = elevation.rows, columns = elevation.columns;
  return (x, z) => {
    const fx = Math.max(0, Math.min(columns - 1, ((x - minX) / ((maxX - minX) || 1)) * (columns - 1)));
    const fz = Math.max(0, Math.min(rows - 1, ((z - minZ) / ((maxZ - minZ) || 1)) * (rows - 1)));
    const x0 = Math.floor(fx), x1 = Math.min(columns - 1, x0 + 1);
    const z0 = Math.floor(fz), z1 = Math.min(rows - 1, z0 + 1);
    const tx = fx - x0, tz = fz - z0;
    const p00 = elevation.points[z0 * columns + x0]?.elevation ?? 0;
    const p10 = elevation.points[z0 * columns + x1]?.elevation ?? p00;
    const p01 = elevation.points[z1 * columns + x0]?.elevation ?? p00;
    const p11 = elevation.points[z1 * columns + x1]?.elevation ?? p00;
    return (p00 * (1 - tx) + p10 * tx) * (1 - tz) + (p01 * (1 - tx) + p11 * tx) * tz;
  };
}

function paintSpans(target, spans, minX, minZ, width, height, value) {
  for (const [x1, x2, z] of spans) {
    for (let x = x1; x <= x2; x += 1) {
      const index = cellIndex(x, z, minX, minZ, width, height);
      if (index >= 0) target[index] = value;
    }
  }
}

function cellIndex(x, z, minX, minZ, width, height) {
  const column = x - minX, row = z - minZ;
  return column >= 0 && row >= 0 && column < width && row < height ? row * width + column : -1;
}

function terrainAt(x, z, mask, elevationY, minX, minZ, width, height) {
  const index = cellIndex(x, z, minX, minZ, width, height);
  return index >= 0 && mask[index] ? elevationY[index] : 0;
}

function maskedSubspans(x1, x2, z, mask, minX, minZ, width, height) {
  const spans = [];
  let start = null;
  let end = null;
  for (let x = x1; x <= x2; x += 1) {
    const index = cellIndex(x, z, minX, minZ, width, height);
    if (index >= 0 && mask[index]) {
      if (start === null) start = x;
      end = x;
    } else if (start !== null) {
      spans.push([start, end]);
      start = null;
      end = null;
    }
  }
  if (start !== null) spans.push([start, end]);
  return spans;
}

function splitByChunk(from, to) {
  const pieces = [];
  const minChunkX = floorDiv(from[0], 16), maxChunkX = floorDiv(to[0], 16);
  const minChunkZ = floorDiv(from[2], 16), maxChunkZ = floorDiv(to[2], 16);
  for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
    for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
      pieces.push({
        chunkX,
        chunkZ,
        from: [Math.max(from[0], chunkX * 16), from[1], Math.max(from[2], chunkZ * 16)],
        to: [Math.min(to[0], chunkX * 16 + 15), to[1], Math.min(to[2], chunkZ * 16 + 15)]
      });
    }
  }
  return pieces;
}

function polygonParts(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates.length ? [geometry.coordinates] : [];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.filter((polygon) => polygon.length);
  return [];
}

function lineStrings(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

function geometryLineLength(geometry) {
  let total = 0;
  for (const line of lineStrings(geometry)) {
    for (let index = 1; index < line.length; index += 1) {
      total += Math.hypot(line[index][0] - line[index - 1][0], line[index][1] - line[index - 1][1]);
    }
  }
  return total;
}

function resampleLineGeometry(geometry, spacingM) {
  const result = [];
  for (const line of lineStrings(geometry)) {
    if (!line.length) continue;
    result.push(line[0]);
    let remaining = spacingM;
    for (let index = 1; index < line.length; index += 1) {
      let from = line[index - 1];
      const to = line[index];
      let length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      while (length >= remaining && length > 0) {
        const fraction = remaining / length;
        const point = [
          from[0] + (to[0] - from[0]) * fraction,
          from[1] + (to[1] - from[1]) * fraction
        ];
        result.push(point);
        from = point;
        length = Math.hypot(to[0] - from[0], to[1] - from[1]);
        remaining = spacingM;
      }
      remaining -= length;
      if (remaining <= 1e-6) remaining = spacingM;
    }
  }
  return result;
}

function groupCells(cells) {
  const rows = new Map();
  for (const [x, z] of cells) {
    if (!rows.has(z)) rows.set(z, []);
    rows.get(z).push(x);
  }
  const result = [];
  for (const [z, values] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const unique = [...new Set(values)].sort((a, b) => a - b);
    let start = unique[0], end = unique[0];
    for (let i = 1; i <= unique.length; i += 1) {
      if (unique[i] === end + 1) { end = unique[i]; continue; }
      if (start !== undefined) result.push([start, end, z]);
      start = unique[i]; end = unique[i];
    }
  }
  return result;
}

function featureCentroid(geometry) {
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    const polygons = polygonParts(geometry);
    let weightedX = 0, weightedZ = 0, totalWeight = 0;
    for (const polygon of polygons) {
      for (let index = 0; index < polygon.length; index += 1) {
        const centroid = ringCentroid(polygon[index]);
        const weight = centroid.area * (index ? -1 : 1);
        weightedX += centroid.x * weight;
        weightedZ += centroid.z * weight;
        totalWeight += weight;
      }
    }
    if (Math.abs(totalWeight) > 1e-9) return [weightedX / totalWeight, weightedZ / totalWeight];
  }
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    let weightedX = 0, weightedZ = 0, totalLength = 0;
    for (const line of lines) {
      for (let index = 1; index < line.length; index += 1) {
        const [x1, z1] = line[index - 1], [x2, z2] = line[index];
        const length = Math.hypot(x2 - x1, z2 - z1);
        weightedX += ((x1 + x2) / 2) * length;
        weightedZ += ((z1 + z2) / 2) * length;
        totalLength += length;
      }
    }
    if (totalLength) return [weightedX / totalLength, weightedZ / totalLength];
  }
  const values = [];
  const collect = (item) => {
    if (Array.isArray(item) && item.length >= 2 && item.every((value) => typeof value === "number")) values.push(item);
    else if (Array.isArray(item)) item.forEach(collect);
  };
  collect(geometry.coordinates);
  return values.length
    ? [values.reduce((sum, point) => sum + point[0], 0) / values.length, values.reduce((sum, point) => sum + point[1], 0) / values.length]
    : [0, 0];
}

function ringCentroid(ring) {
  let twiceArea = 0, weightedX = 0, weightedZ = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, z1] = ring[index], [x2, z2] = ring[index + 1];
    const cross = x1 * z2 - x2 * z1;
    twiceArea += cross;
    weightedX += (x1 + x2) * cross;
    weightedZ += (z1 + z2) * cross;
  }
  const area = Math.abs(twiceArea / 2);
  if (Math.abs(twiceArea) < 1e-9) {
    const points = ring.slice(0, -1);
    return {
      x: points.reduce((sum, [x]) => sum + x, 0) / Math.max(1, points.length),
      z: points.reduce((sum, [, z]) => sum + z, 0) / Math.max(1, points.length),
      area: 0
    };
  }
  return {
    x: weightedX / (3 * twiceArea),
    z: weightedZ / (3 * twiceArea),
    area
  };
}

function associateEntrances(features, entrances, maxDistanceM = 8) {
  const assignments = new Map();
  for (const entrance of entrances) {
    const point = featureCentroid(entrance.localGeometry);
    let best = null;
    for (const feature of features) {
      const distanceM = distanceToGeometryBoundary(point, feature.localGeometry);
      if (distanceM > maxDistanceM || (best && distanceM >= best.distanceM)) continue;
      best = { feature, distanceM };
    }
    if (!best) continue;
    const previous = assignments.get(best.feature.id);
    if (!previous || entranceRank(entrance) > entranceRank(previous)) {
      assignments.set(best.feature.id, entrance);
    }
  }
  return assignments;
}

function distanceToGeometryBoundary(point, geometry) {
  if (geometry.type === "Point") return Math.hypot(point[0] - geometry.coordinates[0], point[1] - geometry.coordinates[1]);
  let best = Infinity;
  for (const polygon of polygonParts(geometry)) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) {
        best = Math.min(best, distanceToSegment(point, ring[index - 1], ring[index]));
      }
    }
  }
  return best;
}

function distanceToSegment([x, z], [x1, z1], [x2, z2]) {
  const dx = x2 - x1, dz = z2 - z1;
  const denominator = dx * dx + dz * dz;
  const t = denominator ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / denominator)) : 0;
  return Math.hypot(x - (x1 + t * dx), z - (z1 + t * dz));
}

function entranceRank(feature) {
  if (feature.tags?.entrance === "main") return 100;
  const description = `${feature.name || ""} ${feature.tags?.description || ""}`.toLowerCase();
  if (description.includes("main entrance") || description.includes("primary entrance")) return 75;
  if (feature.tags?.entrance) return 50;
  return 25;
}

function selectSpawn(map, mask, elevationY, surface, raster) {
  const entrance = map.features
    .filter((feature) => feature.tags?.entrance || feature.tags?.door)
    .sort((a, b) => entranceRank(b) - entranceRank(a))[0] || null;
  const preferred = entrance ? featureCentroid(entrance.localGeometry) : [0, 0];
  let best = null;
  for (let z = raster.minZ; z <= raster.maxZ; z += 1) {
    for (let x = raster.minX; x <= raster.maxX; x += 1) {
      const index = cellIndex(x, z, raster.minX, raster.minZ, raster.width, raster.height);
      if (index < 0 || !mask[index]) continue;
      const distance = (x - preferred[0]) ** 2 + (z - preferred[1]) ** 2;
      const surfacePriority = surface[index] === 1 ? 0 : surface[index] === 2 ? 1 : 2;
      if (!best || surfacePriority < best.surfacePriority ||
        (surfacePriority === best.surfacePriority && distance < best.distance)) {
        best = {
          x,
          y: elevationY[index],
          z,
          source: entrance
            ? featureHasMainEntrance(entrance)
              ? surfacePriority === 0 ? "mapped-main-entrance-nearest-path" : "mapped-main-entrance"
              : surfacePriority === 0 ? "mapped-entrance-nearest-path" : "mapped-entrance"
            : "nearest-park-cell-to-origin",
          entranceFeatureId: entrance?.id || null,
          surfaceClass: surface[index] === 1 ? "mapped-path" : surface[index] === 2 ? "mapped-road" : "terrain",
          distanceToEntranceM: entrance ? Math.round(Math.sqrt(distance) * 10) / 10 : null,
          surfacePriority,
          distance
        };
      }
    }
  }
  if (!best) return { x: 0, y: 0, z: 0, source: "fallback-origin" };
  const { surfacePriority, distance, ...result } = best;
  return result;
}

function featureHasMainEntrance(feature) {
  return feature.tags?.entrance === "main" || entranceRank(feature) >= 75;
}

function accessDistanceValue(value) {
  return Number.isFinite(value) && value < 65_535 ? Math.round(value) / 10 : null;
}

function isAccessSurface(value) {
  return value === 1 || value === 2;
}

function inferredHeight(feature) {
  if (feature.subtype === "coaster_station") return 8;
  if (["industrial", "warehouse"].includes(feature.subtype)) return 7;
  if (["kiosk", "shed", "roof"].includes(feature.subtype)) return 3;
  return 5;
}

function buildingBlock(feature) {
  if (feature.tags?.material === "wood" || feature.tags?.["building:material"] === "wood") return "minecraft:spruce_planks";
  if (feature.tags?.["building:material"] === "brick") return "minecraft:brick_block";
  return feature.vertical.heightM === null ? "minecraft:yellow_concrete" : "minecraft:stone_bricks";
}

function roofBlock(feature) {
  if (feature.tags?.["roof:material"] === "glass") return "minecraft:glass";
  return feature.vertical.heightM === null ? "minecraft:yellow_concrete" : "minecraft:deepslate_tiles";
}

function buildingFloorBlock(feature) {
  if (feature.tags?.material === "wood" || feature.tags?.["building:material"] === "wood") return "minecraft:spruce_planks";
  return "minecraft:smooth_stone";
}

function compileRideAttachment({ add, feature, mask, elevationY, minX, minZ, width, height, minDatum }) {
  const reconstruction = feature.rideAttachmentReconstruction;
  const type = String(reconstruction?.attachmentType || feature.tags?.ride_attachment || "attachment")
    .toLowerCase().replaceAll("-", "_");
  const evidence = {
    featureId: feature.id,
    name: feature.name || null,
    type,
    geometryType: feature.localGeometry?.type || null,
    geometrySource: "detected-planning-geometry",
    geometryUnchanged: true,
    generatedOffset: false,
    mirroredSide: false,
    status: reconstruction?.status || "withheld",
    reason: reconstruction?.reason || "missing-evidence-bounded-reconstruction",
    verticalMode: reconstruction?.verticalMode || null,
    rideId: reconstruction?.rideId || null,
    widthM: Number.isFinite(Number(feature.tags?.width)) ? Number(feature.tags.width) : null,
    policy: "detected-geometry-only"
  };
  if (reconstruction?.status !== "resolved") return { rendered: false, blocks: 0, type, evidence };

  const cells = new Set();
  const lineWidthM = ["handrail", "fence"].includes(type) ? 1 : numericWidth(feature.tags?.width, 1);
  for (const line of lineStrings(feature.localGeometry)) {
    for (const [x, z] of lineCells(line, lineWidthM)) cells.add(`${x},${z}`);
  }
  for (const polygon of polygonParts(feature.localGeometry)) {
    for (const [x1, x2, z] of polygonScanlineSpans(polygon)) {
      for (let x = x1; x <= x2; x += 1) cells.add(`${x},${z}`);
    }
  }

  const block = rideAttachmentBlock(type, feature);
  const verticalBlocks = ["handrail", "fence"].includes(type)
    ? Math.max(1, Math.round(feature.vertical?.heightM ?? 1))
    : 1;
  let blocks = 0;
  let eligibleCells = 0;
  for (const key of cells) {
    const [x, z] = key.split(",").map(Number);
    const index = cellIndex(x, z, minX, minZ, width, height);
    if (index < 0 || !mask[index]) continue;
    let y = null;
    if (reconstruction.verticalMode === "terrain-following") y = elevationY[index] + 1;
    else if (reconstruction.verticalMode === "explicit-elevation") {
      y = Math.round(reconstruction.explicitElevationM - minDatum);
    } else if (reconstruction.verticalMode === "track-relative") {
      const elevationM = nearestResolvedRideElevation(
        reconstruction.rideSamples, x, z, reconstruction.maxTrackDistanceM
      );
      if (elevationM !== null) y = Math.round(elevationM - minDatum);
    }
    if (!Number.isFinite(y)) continue;
    add(8, x, y, z, x, y + verticalBlocks - 1, z, block);
    eligibleCells += 1;
    blocks += verticalBlocks;
  }
  evidence.status = eligibleCells ? "rendered" : "withheld";
  evidence.reason = eligibleCells ? null : "no-elevation-resolved-cells-inside-boundary";
  evidence.block = block;
  evidence.cells = eligibleCells;
  evidence.blocks = blocks;
  return { rendered: eligibleCells > 0, blocks, type, evidence };
}

function nearestResolvedRideElevation(samples, x, z, maximumDistanceM = 12) {
  let best = null;
  for (const sample of samples || []) {
    if (![sample?.x, sample?.y, sample?.z].every(Number.isFinite)) continue;
    const distanceM = Math.hypot(sample.x - x, sample.z - z);
    if (distanceM > maximumDistanceM) continue;
    if (!best || distanceM < best.distanceM) best = { distanceM, elevationM: sample.y };
  }
  return best?.elevationM ?? null;
}

function rideAttachmentBlock(type, feature) {
  const material = String(feature.tags?.surface || feature.tags?.material || "").toLowerCase();
  if (["handrail", "fence"].includes(type)) {
    return /wood|timber/.test(material) ? "minecraft:oak_fence" : "minecraft:iron_bars";
  }
  if (/wood|timber/.test(material)) return "minecraft:oak_planks";
  if (/concrete|stone|paving/.test(material)) return "minecraft:smooth_stone";
  if (type === "access_path" || type === "evacuation_stair") return "minecraft:light_gray_concrete";
  return "minecraft:iron_block";
}

function compilePlanningRideSupport({ add, feature, mask, elevationY, minX, minZ, width, height }) {
  const [rawX, rawZ] = feature.localGeometry.coordinates;
  const x = Math.round(rawX), z = Math.round(rawZ);
  const index = cellIndex(x, z, minX, minZ, width, height);
  if (index < 0 || !mask[index]) return { frames: 0, blocks: 0, footings: 0, evidence: null };
  const groundY = elevationY[index];
  const supportHeight = Math.max(1, Math.round(feature.vertical.heightM ?? 3));
  const topY = groundY + supportHeight;
  const style = String(feature.tags?.support_style || feature.tags?.ride_support_style || "column")
    .trim().toLowerCase().replace(/[ _]+/g, "-");
  const material = String(feature.tags?.material || feature.tags?.support_material || "steel").toLowerCase();
  const block = material.includes("wood") || material.includes("timber")
    ? "minecraft:oak_log"
    : "minecraft:iron_bars";
  let blocks = 0;
  const emitLine = (from, to) => {
    const unique = new Set(line3dCells(from, to).map((point) => point.join(",")));
    for (const key of unique) {
      const [px, py, pz] = key.split(",").map(Number);
      add(8, px, py, pz, px, py, pz, block);
      blocks += 1;
    }
  };
  add(8, x, groundY, z, x, groundY, z, "minecraft:iron_block");
  if (["a-frame", "aframe", "inverted-a"].includes(style)) {
    emitLine([x - 1, groundY + 1, z], [x, topY, z]);
    emitLine([x + 1, groundY + 1, z], [x, topY, z]);
  } else if (["portal", "portal-frame"].includes(style)) {
    const axis = String(feature.tags?.support_axis || "x").toLowerCase();
    const offsets = axis === "z" ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
    for (const [dx, dz] of offsets) emitLine([x + dx, groundY + 1, z + dz], [x + dx, topY, z + dz]);
    emitLine([x + offsets[0][0], topY, z + offsets[0][1]], [x + offsets[1][0], topY, z + offsets[1][1]]);
  } else if (["lattice", "tower", "four-leg"].includes(style)) {
    for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      emitLine([x + dx, groundY + 1, z + dz], [x, topY, z]);
    }
  } else {
    emitLine([x, groundY + 1, z], [x, topY, z]);
  }
  return {
    frames: 1,
    blocks,
    footings: 1,
    evidence: {
      featureId: feature.id,
      method: "planning-explicit-support",
      style,
      material,
      heightM: supportHeight
    }
  };
}

function barrierBlock(feature) {
  const barrier = String(feature.tags?.barrier || feature.subtype || "").toLowerCase();
  const material = String(feature.tags?.material || feature.tags?.["barrier:material"] || "").toLowerCase();
  if (barrier.includes("railing") || barrier.includes("balustrade") || material.includes("metal")) {
    return "minecraft:iron_bars";
  }
  if (barrier.includes("wall")) {
    if (material.includes("sandstone")) return "minecraft:sandstone_wall";
    if (material.includes("brick")) return "minecraft:brick_wall";
    return "minecraft:stone_brick_wall";
  }
  if (material.includes("spruce")) return "minecraft:spruce_fence";
  if (material.includes("birch")) return "minecraft:birch_fence";
  if (material.includes("dark oak")) return "minecraft:dark_oak_fence";
  return "minecraft:oak_fence";
}

function detailMarkerBlock(feature) {
  const shape = String(feature.tags?.minecraft_shape || feature.tags?.["minecraft:shape"] || "").toLowerCase();
  const direction = Math.max(0, Math.min(3, Math.round(Number(feature.tags?.minecraft_direction) || 0)));
  if (shape === "trapdoor") return `minecraft:oak_trapdoor[direction=${direction},open_bit=false,upside_down_bit=false]`;
  if (shape === "slab") return "minecraft:stone_brick_slab[minecraft:vertical_half=bottom]";
  if (shape === "stairs") return `minecraft:stone_brick_stairs[upside_down_bit=false,weirdo_direction=${direction}]`;
  if (shape === "wall") return "minecraft:stone_brick_wall";
  if (shape === "fence") return "minecraft:oak_fence";
  if (feature.kind === "attraction") return "minecraft:gold_block";
  if (feature.kind === "vegetation") return "minecraft:lime_concrete";
  if (feature.kind === "detail" && feature.subtype.startsWith("entrance:")) return "minecraft:blue_concrete";
  if (feature.kind === "detail") return "minecraft:purple_concrete";
  return "minecraft:emerald_block";
}

function numericWidth(value, fallback) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function percentileNumber(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

function medianNumber(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function surfaceStyleKey(style) {
  return JSON.stringify({
    primaryBlock: style?.primaryBlock,
    secondaryBlock: style?.secondaryBlock,
    tertiaryBlock: style?.tertiaryBlock,
    paletteWeights: style?.paletteWeights,
    pattern: style?.pattern,
    patternScale: style?.patternScale,
    patternRotation: style?.patternRotation,
    minecraftShape: style?.minecraftShape,
    minecraftDirection: style?.minecraftDirection,
    material: style?.material,
    materialPreset: style?.materialPreset,
    materialLabel: style?.materialLabel,
    palette: style?.palette,
    colour: style?.colour,
    aerialClass: style?.aerialClass,
    appearanceStatus: style?.appearanceStatus
  });
}

const floorDiv = (value, divisor) => Math.floor(value / divisor);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hash2d(x, z, seed) {
  let value = (Math.imul(Math.round(x), 374761393) ^ Math.imul(Math.round(z), 668265263) ^
    Math.imul(seed | 0, 1442695041)) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const overlayPriority = (kind) => ({ surface: 0, water: 1, road: 2, path: 3, attraction: 4 })[kind] ?? 10;
