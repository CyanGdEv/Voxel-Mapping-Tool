import { detectTreeSeedsFromCanopySamples } from "./tree-seed-detection.mjs";
import { resolveLocalSpeciesDiversity } from "./woodland-species-diversity.mjs";

const DEFAULTS = Object.freeze({
  sampleStepM: 1,
  minCanopyHeightM: 4,
  minPeakProminenceM: 1.25,
  minSeedSeparationM: 3.5,
  mappedSuppressionRadiusM: 2.5,
  maxSeedsPerFeature: 256,
  maxSeedsTotal: 2048,
  nearbySpeciesRadiusM: 14
});

/**
 * Add evidence-backed individual tree features inside already-mapped vegetation
 * polygons. Geometry authority comes from the vegetation extent; LiDAR only
 * supplies individual canopy peaks/height. Species/morphology is transferred
 * independently from the strongest available vegetation evidence and never used
 * to move the inferred tree position.
 */
export function inferIndividualTreesInVegetation(map, sources = {}, options = {}) {
  if (!map?.features?.length || typeof sources?.elevation?.samplePairLocal !== "function") {
    return { added: 0, sampled: 0, candidates: 0, sourceFeatures: 0, speciesAssigned: 0 };
  }

  const mappedTreeFeatures = map.features.filter(isMappedIndividualTree);
  const mappedSeeds = mappedTreeFeatures
    .map((feature) => geometryPoint(feature.localGeometry))
    .filter(Boolean)
    .map(([x, z]) => ({ x, z }));
  const vegetationAreas = map.features.filter(isTreeCoverArea);
  const speciesSources = collectSpeciesFeatures(sources);
  const inferred = [];
  let sampled = 0;
  let candidates = 0;
  let speciesAssigned = 0;
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
      const speciesEvidence = resolveLocalSpeciesDiversity({
        x: seed.x,
        z: seed.z,
        parent: feature,
        speciesSources,
        mappedTrees: mappedTreeFeatures,
        radiusM: Number(options.treeInferenceNearbySpeciesRadiusM) || DEFAULTS.nearbySpeciesRadiusM * 1.7,
        seedKey: String(feature.id || "vegetation")
      }) || resolveSpeciesEvidence({
        x: seed.x,
        z: seed.z,
        parent: feature,
        speciesSources,
        mappedTrees: mappedTreeFeatures,
        nearbyRadiusM: Number(options.treeInferenceNearbySpeciesRadiusM) || DEFAULTS.nearbySpeciesRadiusM
      });
      if (speciesEvidence?.species || speciesEvidence?.genus || speciesEvidence?.leafType) speciesAssigned += 1;
      const tags = {
        natural: "tree",
        "tpmap:tree_inference": "dsm-dtm-canopy-local-maximum",
        "tpmap:tree_parent": String(feature.id || "vegetation")
      };
      if (speciesEvidence?.species) tags.species = speciesEvidence.species;
      if (speciesEvidence?.genus) tags.genus = speciesEvidence.genus;
      if (speciesEvidence?.leafType) tags.leaf_type = speciesEvidence.leafType;
      if (speciesEvidence?.source) tags["tpmap:species_source"] = speciesEvidence.source;
      if (Number.isFinite(speciesEvidence?.confidence)) tags["tpmap:species_confidence"] = String(round3(speciesEvidence.confidence));
      if (Array.isArray(speciesEvidence?.distribution) && speciesEvidence.distribution.length > 1) tags["tpmap:species_distribution"] = speciesEvidence.distribution.map((entry) => `${entry.species || entry.genus || entry.leafType}:${round3(entry.weight)}`).join(",");

      inferred.push({
        id: `lidar-tree:${safeId(feature.id || "vegetation")}:${index}:${Math.round(seed.x * 10)}:${Math.round(seed.z * 10)}`,
        kind: "vegetation",
        subtype: "tree",
        name: null,
        tags,
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
          parentFeatureId: feature.id || null,
          speciesEvidence: speciesEvidence || null
        }
      });
    }
  }

  if (inferred.length) map.features.push(...inferred);
  return { added: inferred.length, sampled, candidates, sourceFeatures: vegetationAreas.length, speciesAssigned };
}

export function resolveSpeciesEvidence({ x, z, parent, speciesSources = [], mappedTrees = [], nearbyRadiusM = DEFAULTS.nearbySpeciesRadiusM }) {
  const direct = bestDirectSpeciesEvidence(x, z, speciesSources);
  if (direct) return direct;

  const parentEvidence = speciesFromObject(parent, "parent-vegetation-composition", 0.82);
  if (parentEvidence) return parentEvidence;

  const nearby = mappedTrees
    .map((feature) => {
      const point = geometryPoint(feature.localGeometry);
      const evidence = speciesFromObject(feature, "nearby-classified-tree", 0.78);
      if (!point || !evidence) return null;
      const distanceM = Math.hypot(point[0] - x, point[1] - z);
      if (distanceM > nearbyRadiusM) return null;
      return { ...evidence, distanceM, confidence: Math.max(0.45, evidence.confidence * (1 - distanceM / (nearbyRadiusM * 1.8))) };
    })
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence || a.distanceM - b.distanceM)[0];
  if (nearby) return { ...nearby, confidence: round3(nearby.confidence) };

  const morphology = morphologyFromParent(parent);
  return morphology ? { ...morphology, source: "parent-vegetation-morphology", confidence: 0.5 } : null;
}

function bestDirectSpeciesEvidence(x, z, speciesSources) {
  const matches = [];
  for (const feature of speciesSources) {
    const evidence = speciesFromObject(feature, "tree-species-map", 0.94);
    if (!evidence) continue;
    const geometry = feature.localGeometry || feature.geometry;
    if (geometry?.type === "Point") {
      const point = geometryPoint(geometry);
      if (!point) continue;
      const distanceM = Math.hypot(point[0] - x, point[1] - z);
      if (distanceM > 8) continue;
      matches.push({ ...evidence, distanceM, confidence: Math.max(0.68, evidence.confidence * (1 - distanceM / 20)) });
    } else if ((geometry?.type === "Polygon" || geometry?.type === "MultiPolygon") && pointInGeometry(x, z, geometry)) {
      matches.push({ ...evidence, distanceM: 0 });
    }
  }
  return matches.sort((a, b) => b.confidence - a.confidence || a.distanceM - b.distanceM)[0] || null;
}

function collectSpeciesFeatures(sources) {
  const candidates = [
    sources?.treeSpecies,
    sources?.treeSpeciesMap,
    sources?.speciesMap,
    sources?.vegetationSpecies,
    sources?.trees?.species,
    sources?.trees?.features
  ];
  const out = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) out.push(...candidate);
    else if (Array.isArray(candidate?.features)) out.push(...candidate.features);
  }
  return out;
}

function speciesFromObject(value, source, confidence) {
  const tags = value?.tags || value?.properties || value?.attributes || value || {};
  const species = firstText(tags.species, tags.tree_species, tags.common_name, tags.commonName, tags.species_name, tags.speciesName);
  const scientific = firstText(tags.scientific_name, tags.scientificName, tags.binomial);
  const genus = firstText(tags.genus, scientific?.split?.(/\s+/)?.[0]);
  const leafType = normalizeLeafType(firstText(tags.leaf_type, tags.leafType, tags.foliage, tags.woodland_type, tags.woodlandType));
  if (!species && !genus && !leafType) return null;
  return { species: species || scientific || null, genus: genus || null, leafType: leafType || inferLeafType(species || genus), source, confidence };
}

function morphologyFromParent(parent) {
  const tags = parent?.tags || {};
  const text = [parent?.subtype, tags.leaf_type, tags.leafType, tags.woodland, tags.woodland_type, tags.forest_type, tags.trees]
    .filter(Boolean).join(" ").toLowerCase();
  if (/conifer|needle|spruce|pine|fir|cedar|evergreen/.test(text)) return { species: null, genus: null, leafType: "needleleaved" };
  if (/broad|deciduous|oak|beech|birch|ash|maple|sycamore|lime/.test(text)) return { species: null, genus: null, leafType: "broadleaved" };
  return null;
}

function normalizeLeafType(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return null;
  if (/needle|conifer|evergreen/.test(text)) return "needleleaved";
  if (/broad|deciduous/.test(text)) return "broadleaved";
  return null;
}
function inferLeafType(value) {
  const text = String(value || "").toLowerCase();
  if (/spruce|pine|fir|cedar|larch|yew|picea|pinus|abies|cedrus|larix|taxus/.test(text)) return "needleleaved";
  if (/oak|beech|birch|ash|maple|sycamore|willow|lime|alder|poplar|quercus|fagus|betula|fraxinus|acer|salix|tilia|alnus|populus/.test(text)) return "broadleaved";
  return null;
}
function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isMappedIndividualTree(feature) {
  if (feature?.kind !== "vegetation" || feature?.inferredTree) return false;
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
function round3(value) { return Math.round(Number(value) * 1000) / 1000; }
