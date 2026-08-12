import { detectTreeSeedsFromCanopySamples } from "./tree-seed-detection.mjs";

const DEFAULTS = Object.freeze({
  sampleStepM: 1,
  minCanopyHeightM: 4,
  minPeakProminenceM: 1.25,
  minSeedSeparationM: 3.5,
  mappedSuppressionRadiusM: 2.5,
  maxSeedsPerFeature: 256,
  maxSeedsTotal: 2048
});

/**
 * Add evidence-backed individual tree features inside already-mapped vegetation
 * polygons. Geometry authority comes from the vegetation extent; LiDAR only
 * supplies individual canopy peaks/height. No seed is emitted outside the source
 * vegetation geometry, and mapped tree points always suppress nearby inferred ones.
 */
export function inferIndividualTreesInVegetation(map, sources = {}, options = {}) {
  if (!map?.features?.length || typeof sources?.elevation?.samplePairLocal !== "function") {
    return { added: 0, sampled: 0, candidates: 0, sourceFeatures: 0 };
  }

  const mappedSeeds = map.features
    .filter(isMappedIndividualTree)
    .map((feature) => geometryPoint(feature.localGeometry))
    .filter(Boolean)
    .map(([x, z]) => ({ x, z }));
  const vegetationAreas = map.features.filter(isTreeCoverArea);
  const inferred = [];
  let sampled = 0;
  let candidates = 0;
  const totalLimit = boundedInt(options.treeInferenceMaxSeedsTotal, DEFAULTS.maxSeedsTotal, 1, 10000);

  for (const feature of vegetationAreas) {
    if (inferred.length >= totalLimit) break;
    const step = Math.max(0.5, Number(options.treeInferenceSampleStepM) || Number(sources.elevation.resolutionM) || DEFAULTS.sampleStepM);
    const bounds = geometryBounds(feature.localGeometry);
    if (!bounds) continue;
    const perFeatureLimit = Math.min(
      totalLimit - inferred.length,
      boundedInt(options.treeInferenceMaxSeedsPerFeature, DEFAULTS.maxSeedsPerFeature, 1, 2048)
    );
    const samples = [];
    for (let z = snap(bounds.minZ, step); z <= bounds.maxZ + 1e-9; z += step) {
      for (let x = snap(bounds.minX, step); x <= bounds.maxX + 1e-9; x += step) {
        if (!pointInGeometry(x, z, feature.localGeometry)) continue;
        const pair = sources.elevation.samplePairLocal(x, z);
        const groundM = finite(pair?.terrain);
        const surfaceM = finite(pair?.surface);
        if (groundM === null || surfaceM === null) continue;
        samples.push({ x, z, groundM, surfaceM });
      }
    }
    sampled += samples.length;
    if (!samples.length) continue;

    const localMapped = mappedSeeds.filter((seed) =>
      seed.x >= bounds.minX - 6 && seed.x <= bounds.maxX + 6 &&
      seed.z >= bounds.minZ - 6 && seed.z <= bounds.maxZ + 6
    );
    const seeds = detectTreeSeedsFromCanopySamples({
      samples,
      cellSizeM: step,
      mappedSeeds: [...mappedSeeds, ...inferred.map((tree) => ({ x: tree.localGeometry.coordinates[0], z: tree.localGeometry.coordinates[1] }))],
      minCanopyHeightM: options.treeInferenceMinCanopyHeightM ?? DEFAULTS.minCanopyHeightM,
      minPeakProminenceM: options.treeInferenceMinPeakProminenceM ?? DEFAULTS.minPeakProminenceM,
      minSeedSeparationM: options.treeInferenceMinSeedSeparationM ?? DEFAULTS.minSeedSeparationM,
      mappedSuppressionRadiusM: options.treeInferenceMappedSuppressionRadiusM ?? DEFAULTS.mappedSuppressionRadiusM,
      maxSeeds: perFeatureLimit
    });
    candidates += seeds.length;

    for (let index = 0; index < seeds.length && inferred.length < totalLimit; index += 1) {
      const seed = seeds[index];
      if (!pointInGeometry(seed.x, seed.z, feature.localGeometry)) continue;
      inferred.push({
        id: `lidar-tree:${safeId(feature.id || "vegetation")}:${index}:${Math.round(seed.x * 10)}:${Math.round(seed.z * 10)}`,
        kind: "vegetation",
        subtype: "tree",
        name: null,
        tags: {
          natural: "tree",
          "tpmap:tree_inference": "dsm-dtm-canopy-local-maximum",
          "tpmap:tree_parent": String(feature.id || "vegetation")
        },
        localGeometry: { type: "Point", coordinates: [seed.x, seed.z] },
        source: {
          provider: sources.elevation.provider || "ea-lidar",
          authority: "vegetation-evidence",
          method: seed.source,
          confidence: seed.confidence,
          parentFeatureId: feature.id || null
        },
        inferredTree: {
          source: seed.source,
          canopyHeightM: seed.canopyHeightM,
          prominenceM: seed.prominenceM,
          confidence: seed.confidence,
          parentFeatureId: feature.id || null
        }
      });
    }
  }

  if (inferred.length) map.features.push(...inferred);
  return { added: inferred.length, sampled, candidates, sourceFeatures: vegetationAreas.length };
}

function isMappedIndividualTree(feature) {
  if (feature?.kind !== "vegetation") return false;
  const geometry = feature.localGeometry;
  if (geometry?.type !== "Point") return false;
  const subtype = String(feature.subtype || feature.tags?.natural || feature.tags?.vegetation || "").toLowerCase();
  return subtype === "tree" || feature.tags?.natural === "tree";
}

function isTreeCoverArea(feature) {
  if (feature?.kind !== "vegetation") return false;
  const type = feature.localGeometry?.type;
  if (type !== "Polygon" && type !== "MultiPolygon") return false;
  const text = [feature.subtype, feature.tags?.natural, feature.tags?.landuse, feature.tags?.vegetation, feature.tags?.woodland]
    .filter(Boolean).join(" ").toLowerCase();
  return /(wood|forest|tree|scrub|copse|canopy|vegetation)/.test(text);
}

function geometryPoint(geometry) {
  if (geometry?.type !== "Point") return null;
  const x = Number(geometry.coordinates?.[0]), z = Number(geometry.coordinates?.[1]);
  return Number.isFinite(x) && Number.isFinite(z) ? [x, z] : null;
}

function geometryBounds(geometry) {
  const points = [];
  walkCoordinates(geometry?.coordinates, points);
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map((p) => p[0])), maxX: Math.max(...points.map((p) => p[0])),
    minZ: Math.min(...points.map((p) => p[1])), maxZ: Math.max(...points.map((p) => p[1]))
  };
}
function walkCoordinates(value, out) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    out.push([Number(value[0]), Number(value[1])]); return;
  }
  for (const child of value) walkCoordinates(child, out);
}
function pointInGeometry(x, z, geometry) {
  if (geometry?.type === "Polygon") return pointInPolygon(x, z, geometry.coordinates);
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.some((polygon) => pointInPolygon(x, z, polygon));
  return false;
}
function pointInPolygon(x, z, rings) {
  if (!rings?.length || !pointInRing(x, z, rings[0])) return false;
  for (let i = 1; i < rings.length; i += 1) if (pointInRing(x, z, rings[i])) return false;
  return true;
}
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i]?.[0]), zi = Number(ring[i]?.[1]);
    const xj = Number(ring[j]?.[0]), zj = Number(ring[j]?.[1]);
    if (![xi, zi, xj, zj].every(Number.isFinite)) continue;
    const intersects = ((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function boundedInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
}
function snap(value, step) { return Math.floor(value / step) * step; }
function safeId(value) { return String(value).replace(/[^a-z0-9:_-]+/gi, "-").slice(0, 80); }
