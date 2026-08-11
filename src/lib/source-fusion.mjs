import path from "node:path";
import { geometryBounds, geometryMapCoordinates } from "./geo.mjs";
import { UserError } from "./errors.mjs";
import { readJson, sha256, sha256File } from "./io.mjs";
import { applyPlanningWorldAuthority } from "./planning-world-authority.mjs";

const OVERTURE_SOURCE_URL = "https://docs.overturemaps.org/getting-data/";
const PEDESTRIAN_CLASSES = new Set([
  "bridleway", "cycleway", "footway", "path", "pedestrian", "steps"
]);
const SUPPORTED_PUBLIC_KINDS = new Set([
  "path", "road", "building", "structure", "surface", "water", "vegetation",
  "terrain_detail", "ride_track", "ride_support", "rail", "barrier", "attraction",
  "amenity", "detail", "park_boundary"
]);

/**
 * Adds bounded, provenance-preserving map evidence from sources other than the
 * Overpass snapshot. Overture is deliberately gap-fill only because much of it
 * is OSM-derived; explicit public-data observations may replace a source feature
 * through `replaces`, but are never silently treated as a survey.
 */
export async function fuseAdditionalMapSources(features, projector, options = {}) {
  const toleranceM = Number(options.sourceFusionToleranceM ?? 3);
  const planningOnly = String(options.planningWorldAuthority || "fixture").toLowerCase() === "planning-only";
  const summary = {
    schemaVersion: 1,
    status: options.overture?.length || options.publicData?.length || options.acquiredPublicData?.length ? "active" : "osm-only",
    policy: {
      overture: "gap-fill only: clear duplicates and partially overlapping lines are withheld",
      publicData: "provenance-complete GeoJSON is retained; `replaces` is required to supersede a named feature",
      precedence: planningOnly ? [
        "reviewed planning-authoritative derivatives",
        "independent terrain/vertical evidence",
        "licensed corroborating observations",
        "OSM/Overture registration only (never world geometry)"
      ] : [
        "verified replacement observations",
        "licensed public-data observations",
        "OSM base map",
        "Overture non-overlapping gap fill"
      ],
      toleranceM
    },
    overture: sourceStats(),
    publicData: sourceStats(),
    acquired: sourceStats(),
    planningAuthority: {},
    providers: {},
    warnings: [
      "Overture transportation is a mixed-source product whose primary source is OpenStreetMap; it is useful for normalization and gaps but is not automatically independent corroboration.",
      "A source being public does not make it survey-grade. Geometry accuracy, capture date, licence, and feature-level verification remain separate evidence fields."
    ]
  };

  const lineIndex = buildLineIndex(features, Math.max(10, toleranceM * 4));
  const acceptedOverture = [];
  for (const filename of options.overture || []) {
    const resolved = path.resolve(filename);
    const collection = await readFeatureCollection(resolved, "--overture");
    summary.overture.files.push(await sourceFile(resolved, collection));
    for (const [index, raw] of collection.features.entries()) {
      summary.overture.considered += 1;
      const feature = overtureToFeature(raw, projector, resolved, index);
      if (!feature) {
        summary.overture.unsupported += 1;
        continue;
      }
      const decision = overtureMergeDecision(feature, features, acceptedOverture, lineIndex, toleranceM);
      if (decision === "duplicate") {
        summary.overture.duplicatesWithheld += 1;
        continue;
      }
      if (decision === "partial-overlap") {
        summary.overture.partialOverlapsWithheld += 1;
        continue;
      }
      acceptedOverture.push(feature);
      features.push(feature);
      summary.overture.accepted += 1;
      increment(summary.overture.kinds, feature.kind);
      increment(summary.providers, feature.source.provider);
    }
  }

  for (const filename of options.publicData || []) {
    const resolved = path.resolve(filename);
    const collection = await readFeatureCollection(resolved, "--public-data");
    const defaults = publicSourceDefaults(collection);
    summary.publicData.files.push(await sourceFile(resolved, collection));
    ingestPublicCollection({
      collection, label: resolved, defaults, bucket: summary.publicData, summary,
      features, projector, lineIndex, toleranceM, accepted: []
    });
  }

  const acceptedAcquired = [];
  for (const entry of options.acquiredPublicData || []) {
    const collection = entry.collection;
    if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
      summary.warnings.push(`Acquired source ${entry.id || entry.adapter || "unknown"} returned no valid FeatureCollection.`);
      continue;
    }
    const label = entry.id || entry.adapter || "acquired-public-data";
    const defaults = publicSourceDefaults(collection);
    summary.acquired.files.push({
      id: label,
      adapter: entry.adapter || null,
      endpoint: entry.endpoint || null,
      cacheHit: entry.cacheHit ?? null,
      features: collection.features.length,
      request: entry.request || null,
      sha256: sha256(collection)
    });
    ingestPublicCollection({
      collection, label, defaults, bucket: summary.acquired, summary,
      features, projector, lineIndex, toleranceM, accepted: acceptedAcquired,
      acquired: true, adapter: entry.adapter || null
    });
  }

  const worldAuthority = applyPlanningWorldAuthority(features, options);
  summary.planningAuthority.world = worldAuthority;
  summary.policy.worldAuthority = worldAuthority.osmReferenceOnly
    ? "Planning geometry and attributes are the world source of truth. OSM and OSM-derived Overture are registration-only and are removed before reconstruction."
    : "Legacy multi-source compilation is enabled explicitly for fixtures and migration tests.";
  summary.acceptedFeatures = summary.overture.accepted + summary.publicData.accepted + summary.acquired.accepted;
  summary.files = summary.overture.files.length + summary.publicData.files.length + summary.acquired.files.length;
  if (summary.status === "active" && !summary.acceptedFeatures) summary.status = "active-no-features-accepted";
  return summary;
}

function ingestPublicCollection({
  collection, label, defaults, bucket, summary, features, projector, lineIndex, toleranceM,
  accepted, acquired = false, adapter = null
}) {
  for (const [index, raw] of collection.features.entries()) {
    bucket.considered += 1;
    const feature = publicDataToFeature(raw, projector, label, index, defaults);
    const replaces = raw.properties?.replaces;
    if (replaces) {
      const replaced = removeById(features, replaces);
      if (!replaced) bucket.missingReplacementTargets += 1;
      else {
        bucket.replaced += 1;
        feature.source.replaces = replaces;
      }
    }

    const mergePolicy = String(raw.properties?.merge_policy || "independent-detail");
    if (!replaces && ["gap-fill", "semantic-only"].includes(mergePolicy)) {
      const decision = supplementalMergeDecision(feature, features, accepted, lineIndex, toleranceM, mergePolicy);
      if (decision === "duplicate") {
        bucket.duplicatesWithheld += 1;
        continue;
      }
      if (decision === "partial-overlap") {
        bucket.partialOverlapsWithheld += 1;
        continue;
      }
    }

    features.push(feature);
    accepted.push(feature);
    bucket.accepted += 1;
    increment(bucket.kinds, feature.kind);
    increment(summary.providers, feature.source.provider);
    if (acquired) feature.source.adapter = raw.properties?.source_adapter || adapter;
  }
}

function supplementalMergeDecision(feature, existing, accepted, lineIndex, toleranceM, mergePolicy) {
  if (mergePolicy === "semantic-only" && feature.localGeometry?.type === "Point") {
    const [x, z] = feature.localGeometry.coordinates;
    const duplicate = [...existing, ...accepted].some((candidate) => {
      if (!candidate.localGeometry || candidate.localGeometry.type !== "Point") return false;
      if (!["attraction", "amenity", "detail"].includes(candidate.kind)) return false;
      const [cx, cz] = candidate.localGeometry.coordinates;
      const sameName = feature.name && candidate.name && feature.name.toLowerCase() === candidate.name.toLowerCase();
      return sameName && Math.hypot(x - cx, z - cz) <= Math.max(10, toleranceM * 4);
    });
    return duplicate ? "duplicate" : "accept";
  }
  return overtureMergeDecision(feature, existing, accepted, lineIndex, toleranceM);
}

function sourceStats() {
  return {
    files: [], considered: 0, accepted: 0, unsupported: 0,
    duplicatesWithheld: 0, partialOverlapsWithheld: 0,
    replaced: 0, missingReplacementTargets: 0, kinds: {}
  };
}

async function readFeatureCollection(filename, flag) {
  const collection = await readJson(filename);
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new UserError(`${flag} ${filename} must be a GeoJSON FeatureCollection`);
  }
  return collection;
}

async function sourceFile(filename, collection) {
  return {
    file: path.basename(filename),
    sha256: await sha256File(filename),
    features: collection.features.length
  };
}

function publicSourceDefaults(collection) {
  const source = collection.source || collection.properties?.source || {};
  return {
    provider: source.name || source.provider || collection.source_name || null,
    sourceUrl: source.url || source.source_url || collection.source_url || null,
    license: source.license || collection.license || null,
    timestamp: source.checked_at || source.captured_at || source.updated_at || collection.checked_at || null,
    dataset: source.dataset || collection.name || null
  };
}

function publicDataToFeature(raw, projector, filename, index, defaults) {
  const properties = raw.properties || {};
  const provider = properties.source_name || properties.source_provider || defaults.provider;
  const sourceUrl = properties.source_url || defaults.sourceUrl;
  const license = properties.license || properties.source_license || defaults.license;
  if (!provider || !sourceUrl || !license) {
    throw new UserError(
      `--public-data ${path.basename(filename)} feature ${index} requires source_name, source_url, and license (feature or collection source metadata)`
    );
  }
  if (!raw.geometry) throw new UserError(`--public-data ${path.basename(filename)} feature ${index} has no geometry`);
  const classification = classifyPortable(properties, raw.geometry);
  if (!classification || !SUPPORTED_PUBLIC_KINDS.has(classification.kind)) {
    throw new UserError(
      `--public-data ${path.basename(filename)} feature ${index} needs a supported kind or recognizable public-map properties`
    );
  }
  const heightM = numberOrNull(properties.height_m ?? properties.height);
  const elevationM = numberOrNull(properties.elevation_m ?? properties.ele);
  return {
    id: properties.id || `public:${path.basename(filename)}:${index}:${sha256(raw).slice(0, 12)}`,
    name: properties.name || properties.names?.primary || null,
    kind: classification.kind,
    subtype: properties.subtype || classification.subtype || "public-observation",
    tags: { ...properties },
    geometry: raw.geometry,
    localGeometry: geometryMapCoordinates(raw.geometry, projector.forward),
    vertical: {
      heightM,
      heightSource: heightM !== null ? "public-data-observation" : null,
      minHeightM: numberOrNull(properties.min_height_m) ?? 0,
      elevationM,
      explicit: heightM !== null || elevationM !== null
    },
    source: {
      provider,
      sourceUrl,
      timestamp: normalizeDate(properties.checked_at || properties.captured_at || defaults.timestamp),
      license,
      dataset: properties.source_dataset || defaults.dataset,
      accuracyM: numberOrNull(properties.accuracy_m),
      file: path.basename(filename),
      fileHash: sha256(raw)
    },
    verification: {
      plan: properties.verified === true ? "source-verified" : "licensed-public-observation",
      vertical: heightM !== null || elevationM !== null
        ? properties.verified === true ? "source-verified" : "source-observed"
        : "unknown"
    }
  };
}

function overtureToFeature(raw, projector, filename, index) {
  const properties = raw.properties || {};
  if (!raw.geometry) return null;
  const classification = classifyOverture(properties, raw.geometry);
  if (!classification) return null;
  const tags = overtureTags(properties, classification);
  const heightM = numberOrNull(properties.height);
  const names = parseMaybeJson(properties.names);
  const upstreamSources = parseMaybeJson(properties.sources);
  const latest = Array.isArray(upstreamSources)
    ? upstreamSources.map((source) => source?.update_time).filter(Boolean).sort().at(-1) || null
    : null;
  return {
    id: `overture:${properties.id || raw.id || `${path.basename(filename)}:${index}`}`,
    name: names?.primary || properties.name || null,
    kind: classification.kind,
    subtype: classification.subtype,
    tags,
    geometry: raw.geometry,
    localGeometry: geometryMapCoordinates(raw.geometry, projector.forward),
    vertical: {
      heightM,
      heightSource: heightM !== null ? "overture-height" : null,
      minHeightM: numberOrNull(properties.min_height) ?? 0,
      elevationM: null,
      explicit: heightM !== null
    },
    source: {
      provider: "Overture Maps Foundation",
      sourceUrl: OVERTURE_SOURCE_URL,
      timestamp: normalizeDate(latest),
      license: "ODbL-1.0",
      dataset: `${properties.theme || "unknown"}/${properties.type || "unknown"}`,
      releaseVersion: properties.version ?? null,
      upstreamSources: summarizeUpstreamSources(upstreamSources),
      file: path.basename(filename),
      fileHash: sha256(raw)
    },
    verification: {
      plan: "mixed-source-public-map",
      vertical: heightM !== null ? "source-observed" : "unknown"
    }
  };
}

function classifyOverture(properties, geometry) {
  const theme = String(properties.theme || "").toLowerCase();
  const type = String(properties.type || "").toLowerCase();
  const subtype = String(properties.subtype || "").toLowerCase();
  const className = String(properties.class || "unknown").toLowerCase();
  if ((theme === "transportation" || type === "segment") && geometry.type === "LineString") {
    if (subtype === "road") return {
      kind: PEDESTRIAN_CLASSES.has(className) ? "path" : "road",
      subtype: className
    };
    if (subtype === "rail") return { kind: "rail", subtype: className };
    if (subtype === "water") return { kind: "water", subtype: className || "water-route" };
  }
  if (theme === "buildings" || type === "building") return { kind: "building", subtype: className || "building" };
  if (theme === "base") {
    if (type === "water") return { kind: "water", subtype: subtype || className || "water" };
    if (["land", "land_cover", "land_use"].includes(type)) {
      const cover = className || subtype || type;
      if (["forest", "wood", "trees", "tree_cover", "scrub", "shrubs", "orchard"].includes(cover)) {
        return { kind: "vegetation", subtype: cover };
      }
      return { kind: "surface", subtype: cover };
    }
    if (type === "infrastructure") return { kind: "structure", subtype: className || subtype || type };
  }
  if (theme === "places" || type === "place") return { kind: "amenity", subtype: className || "place" };
  return null;
}

function classifyPortable(properties, geometry) {
  if (properties.kind) return { kind: String(properties.kind), subtype: properties.subtype || null };
  if (properties.roller_coaster === "track") return { kind: "ride_track", subtype: "coaster" };
  if (properties.roller_coaster === "support") return { kind: "ride_support", subtype: "support" };
  if (properties.building) return { kind: "building", subtype: properties.building };
  if (["rock", "stone", "boulder", "cliff"].includes(properties.natural)) {
    return { kind: "terrain_detail", subtype: properties.natural };
  }
  if (["outcrop", "boulder"].includes(properties.geological)) {
    return { kind: "terrain_detail", subtype: properties.geological };
  }
  if (properties.barrier === "hedge") return { kind: "vegetation", subtype: "hedge" };
  if (["tree", "tree_row", "wood", "scrub", "shrub", "bush"].includes(properties.natural)) {
    return { kind: "vegetation", subtype: properties.natural };
  }
  if (["forest", "orchard", "vineyard", "plant_nursery"].includes(properties.landuse)) {
    return { kind: "vegetation", subtype: properties.landuse };
  }
  if (["trees", "tree_cover", "shrubs", "scrub"].includes(properties.landcover)) {
    return { kind: "vegetation", subtype: properties.landcover };
  }
  if (properties.highway) {
    return {
      kind: PEDESTRIAN_CLASSES.has(String(properties.highway)) ? "path" : "road",
      subtype: properties.highway
    };
  }
  if (properties.natural === "water" || properties.water || properties.waterway) {
    return { kind: "water", subtype: properties.water || properties.waterway || "water" };
  }
  if (properties.landuse || properties.landcover ||
    (geometry.type.includes("Polygon") && properties.natural)) {
    return { kind: "surface", subtype: properties.landuse || properties.landcover || properties.natural };
  }
  if (properties.barrier) return { kind: "barrier", subtype: properties.barrier };
  if (properties.man_made) return { kind: "structure", subtype: properties.man_made };
  return null;
}

function overtureTags(properties, classification) {
  const tags = {
    overture_theme: properties.theme || null,
    overture_type: properties.type || null,
    overture_class: properties.class || null,
    overture_subclass: properties.subclass || null
  };
  if (["path", "road"].includes(classification.kind)) {
    tags.highway = classification.subtype;
    const surface = globalRuleValue(parseMaybeJson(properties.road_surface));
    const width = globalRuleValue(parseMaybeJson(properties.width_rules));
    if (surface !== null) tags.surface = surface;
    if (Number.isFinite(Number(width))) tags.width = Number(width);
    const flags = JSON.stringify(parseMaybeJson(properties.road_flags) || "").toLowerCase();
    if (flags.includes("bridge")) tags.bridge = "yes";
    if (flags.includes("tunnel")) tags.tunnel = "yes";
    const level = globalRuleValue(parseMaybeJson(properties.level_rules));
    if (Number.isFinite(Number(level))) tags.layer = Number(level);
  }
  if (classification.kind === "building") tags.building = classification.subtype || "yes";
  if (classification.kind === "surface") {
    tags.landcover = classification.subtype;
    if (properties.surface) tags.surface = properties.surface;
  }
  if (classification.kind === "vegetation") {
    if (classification.subtype === "hedge") tags.barrier = "hedge";
    else if (["forest", "orchard", "vineyard", "plant_nursery"].includes(classification.subtype)) tags.landuse = classification.subtype;
    else if (["trees", "tree_cover", "shrubs"].includes(classification.subtype)) tags.landcover = classification.subtype;
    else tags.natural = classification.subtype;
  }
  if (classification.kind === "water") tags.natural = "water";
  return Object.fromEntries(Object.entries(tags).filter(([, value]) => value !== null && value !== undefined));
}

function globalRuleValue(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return typeof value === "object" ? value.value ?? null : value;
  const global = value.find((rule) => !rule?.between || !Array.isArray(rule.between));
  return global?.value ?? null;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function summarizeUpstreamSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, 20).map((source) => ({
    dataset: source?.dataset || null,
    provider: source?.provider || null,
    recordId: source?.record_id || null,
    updateTime: source?.update_time || null
  }));
}

function overtureMergeDecision(feature, existing, accepted, lineIndex, toleranceM) {
  const geometryType = feature.localGeometry.type;
  if (["LineString", "MultiLineString"].includes(geometryType)) {
    const category = linearCategory(feature.kind);
    if (!category) return "accept";
    const overlap = lineOverlapFraction(feature.localGeometry, lineIndex.get(category), toleranceM);
    if (overlap >= 0.8) return "duplicate";
    if (overlap >= 0.2) return "partial-overlap";
    const acceptedOverlap = accepted
      .filter((candidate) => linearCategory(candidate.kind) === category)
      .some((candidate) => lineOverlapPair(feature.localGeometry, candidate.localGeometry, toleranceM) >= 0.8);
    return acceptedOverlap ? "duplicate" : "accept";
  }
  const bounds = geometryBounds(feature.localGeometry);
  const peer = [...existing, ...accepted].find((candidate) => {
    if (candidate.kind !== feature.kind || !candidate.localGeometry) return false;
    const other = geometryBounds(candidate.localGeometry);
    return boundsOverlap(bounds, other, toleranceM);
  });
  return peer ? "duplicate" : "accept";
}

function buildLineIndex(features, cellSize) {
  const indexes = new Map();
  for (const feature of features) {
    const category = linearCategory(feature.kind);
    if (!category) continue;
    if (!indexes.has(category)) indexes.set(category, { cellSize, cells: new Map() });
    const index = indexes.get(category);
    for (const line of geometryLines(feature.localGeometry)) {
      for (let i = 1; i < line.length; i += 1) addSegment(index, line[i - 1], line[i]);
    }
  }
  return indexes;
}

function addSegment(index, a, b) {
  const minX = Math.floor(Math.min(a[0], b[0]) / index.cellSize);
  const maxX = Math.floor(Math.max(a[0], b[0]) / index.cellSize);
  const minZ = Math.floor(Math.min(a[1], b[1]) / index.cellSize);
  const maxZ = Math.floor(Math.max(a[1], b[1]) / index.cellSize);
  for (let z = minZ; z <= maxZ; z += 1) for (let x = minX; x <= maxX; x += 1) {
    const key = `${x},${z}`;
    if (!index.cells.has(key)) index.cells.set(key, []);
    index.cells.get(key).push([a, b]);
  }
}

function lineOverlapFraction(geometry, index, toleranceM) {
  if (!index) return 0;
  const samples = sampleLines(geometry, Math.max(2, toleranceM));
  if (!samples.length) return 0;
  let covered = 0;
  for (const point of samples) {
    const bx = Math.floor(point[0] / index.cellSize), bz = Math.floor(point[1] / index.cellSize);
    let nearest = Infinity;
    for (let dz = -1; dz <= 1; dz += 1) for (let dx = -1; dx <= 1; dx += 1) {
      for (const [a, b] of index.cells.get(`${bx + dx},${bz + dz}`) || []) {
        nearest = Math.min(nearest, pointSegmentDistance(point, a, b));
      }
    }
    if (nearest <= toleranceM) covered += 1;
  }
  return covered / samples.length;
}

function lineOverlapPair(first, second, toleranceM) {
  const segments = geometryLines(second).flatMap((line) => line.slice(1).map((point, index) => [line[index], point]));
  const samples = sampleLines(first, Math.max(2, toleranceM));
  if (!samples.length || !segments.length) return 0;
  return samples.filter((point) => segments.some(([a, b]) => pointSegmentDistance(point, a, b) <= toleranceM)).length /
    samples.length;
}

function sampleLines(geometry, spacingM) {
  const samples = [];
  for (const line of geometryLines(geometry)) {
    if (!line.length) continue;
    samples.push(line[0]);
    for (let index = 1; index < line.length; index += 1) {
      const a = line[index - 1], b = line[index];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(length / spacingM));
      for (let step = 1; step <= steps; step += 1) {
        const f = step / steps;
        samples.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      }
    }
  }
  return samples;
}

function geometryLines(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function pointSegmentDistance(point, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const denominator = dx * dx + dz * dz;
  if (!denominator) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / denominator));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dz));
}

function linearCategory(kind) {
  if (["path", "road"].includes(kind)) return "access";
  if (kind === "rail") return "rail";
  if (kind === "water") return "water";
  return null;
}

function boundsOverlap(a, b, tolerance) {
  return a.minX <= b.maxX + tolerance && a.maxX >= b.minX - tolerance &&
    a.minZ <= b.maxZ + tolerance && a.maxZ >= b.minZ - tolerance;
}

function removeById(features, id) {
  const index = features.findIndex((feature) => feature.id === id);
  if (index < 0) return null;
  return features.splice(index, 1)[0];
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : String(value);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function increment(object, key) {
  object[key || "unknown"] = (object[key || "unknown"] || 0) + 1;
}
