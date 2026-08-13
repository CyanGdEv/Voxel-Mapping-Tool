import { createProjector, geometryMapCoordinates } from "./geo.mjs";

const GRID_CELL_M = 20;
const SEARCH_RADIUS_M = 750;
const ICP_NEAREST_M = 100;
const INLIER_M = 8;
const MAX_PLANNING_SAMPLES = 96;
const MAX_OSM_SAMPLES = 6_000;
const MIN_SAMPLES = 8;
const MIN_INLIER_RATIO = 0.6;
const MIN_AMBIGUITY_MARGIN = 0.02;

/**
 * Resolves a raster drawing's scale, rotation and translation against OSM.
 * OSM is used only as a registration reference: returned coordinates are the
 * transformed planning vectors and no OSM feature is copied into the result.
 */
export function registerPlanningCollectionToOsm(collection, {
  application = {}, runtime = {}, profile = {}
} = {}) {
  const features = collection?.features || [];
  const pending = features.filter((feature) => feature.properties?.planning_registration_pending === true);
  if (!pending.length) {
    return {
      collection,
      registration: { status: "not-required", verified: features.length > 0 }
    };
  }

  const center = runtime.center;
  const osm = runtime?.osm?.data || runtime?.osm;
  if (!center || !Array.isArray(osm?.elements)) {
    return failed(collection, "osm-registration-reference-unavailable");
  }
  const projector = createProjector(center);
  const applicationLonLat = applicationLocation(application);
  if (!applicationLonLat) return failed(collection, "application-search-anchor-unavailable");
  const applicationLocal = projector.forward(applicationLonLat);
  const planning = planningSamples(pending);
  if (planning.samples.length < MIN_SAMPLES) {
    return failed(collection, "insufficient-planning-registration-samples", {
      planningSamples: planning.samples.length,
      planningFeatures: planning.featureCount
    });
  }

  const references = osmRegistrationSamples(osm, projector, applicationLocal, SEARCH_RADIUS_M);
  if (references.length < MIN_SAMPLES) {
    return failed(collection, "insufficient-osm-registration-samples", {
      planningSamples: planning.samples.length,
      osmSamples: references.length
    });
  }
  const grid = buildGrid(references);
  const nominalScale = planning.nominalScale;
  const scales = scaleCandidates(nominalScale);
  const coarse = [];
  for (const scale of scales) {
    for (let rotation = -180; rotation < 180; rotation += 30) {
      const fit = fitTransform(planning.samples, grid, {
        scale, rotation,
        tx: applicationLocal[0], tz: applicationLocal[1],
        anchorX: applicationLocal[0], anchorZ: applicationLocal[1]
      });
      if (fit) coarse.push(fit);
    }
  }
  coarse.sort(compareFits);
  const refined = [];
  for (const seed of coarse.slice(0, 4)) {
    for (const scaleMultiplier of [0.85, 0.925, 1, 1.075, 1.15]) {
      for (const rotationOffset of [-15, -10, -5, 0, 5, 10, 15]) {
        const fit = fitTransform(planning.samples, grid, {
          scale: seed.scale * scaleMultiplier,
          rotation: normalizeDegrees(seed.rotation + rotationOffset),
          tx: seed.tx,
          tz: seed.tz,
          anchorX: seed.anchorX,
          anchorZ: seed.anchorZ
        });
        if (fit) refined.push(fit);
      }
    }
  }
  const ranked = [...coarse, ...refined].sort(compareFits);
  const best = ranked[0];
  if (!best) return failed(collection, "osm-similarity-fit-unavailable");
  const alternative = ranked.find((candidate) => distinctTransform(best, candidate)) || null;
  const ambiguityMargin = alternative ? best.score - alternative.score : 1;
  const confidence = registrationConfidence(best, ambiguityMargin);
  const singleFeatureAllowed = planning.featureCount > 1 || (
    planning.featureCount === 1 &&
    (planning.kinds.has("ride_track") || nominalScale !== null) &&
    best.inlierRatio >= 0.8 && best.medianM <= 2.5
  );
  const verified = best.inliers >= MIN_SAMPLES &&
    best.inlierRatio >= MIN_INLIER_RATIO &&
    best.medianM <= 4.5 && best.p90M <= 9 &&
    best.spreadM >= 20 && best.inlierFeatures >= Math.min(2, planning.featureCount) &&
    best.anchorShiftM <= SEARCH_RADIUS_M && ambiguityMargin >= MIN_AMBIGUITY_MARGIN &&
    confidence >= 0.72 && singleFeatureAllowed;
  if (!verified) {
    return failed(collection, "osm-similarity-fit-below-confidence-gate", diagnostics({
      best, alternative, ambiguityMargin, confidence, planning, references
    }));
  }

  const transform = drawingTransform(best);
  const registered = {
    ...collection,
    features: features.map((feature) => {
      if (feature.properties?.planning_registration_pending !== true) return feature;
      return {
        ...feature,
        geometry: geometryMapCoordinates(feature.geometry, (point) => projector.inverse(transform(point))),
        properties: {
          ...feature.properties,
          planning_registration_pending: false,
          planning_auto_georeferenced: true,
          planning_spatial_registration_verified: true,
          planning_georeference_method: "osm-similarity-scale-rotation-translation",
          planning_georeference_confidence: round(confidence),
          planning_osm_reference_only: true,
          planning_osm_snapshot_sha256: runtime?.osm?.dataHash || null,
          planning_registration_scale_m_per_pixel: round(best.scale, 8),
          planning_registration_rotation_degrees: round(best.rotation, 4),
          planning_registration_inliers: best.inliers,
          planning_registration_inlier_ratio: round(best.inlierRatio),
          planning_registration_residual_median_m: round(best.medianM, 3),
          planning_registration_residual_p90_m: round(best.p90M, 3),
          accuracy_m: round(best.p90M, 2),
          verified: confidence >= 0.82
        }
      };
    })
  };
  return {
    collection: registered,
    registration: {
      status: "verified-osm-similarity",
      verified: true,
      reference: "OpenStreetMap",
      policy: "scale, rotation and translation reference only; OSM geometry is not emitted",
      ...diagnostics({ best, alternative, ambiguityMargin, confidence, planning, references })
    }
  };
}

function planningSamples(features) {
  const samples = [];
  const kinds = new Set();
  const nominal = [];
  for (const [featureIndex, feature] of features.entries()) {
    if (feature.properties?.planning_exclude_from_world === true) continue;
    const kind = registrationKind(feature.properties?.kind);
    if (!kind) continue;
    kinds.add(kind);
    const scale = Number(feature.properties?.planning_nominal_metres_per_pixel);
    if (Number.isFinite(scale) && scale > 0) nominal.push(scale);
    const points = geometryPoints(feature.geometry, 18);
    for (const point of points) samples.push({
      x: Number(point[0]), y: Number(point[1]), kind, featureIndex
    });
  }
  return {
    samples: evenlyLimit(samples.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), MAX_PLANNING_SAMPLES),
    featureCount: new Set(samples.map((sample) => sample.featureIndex)).size,
    kinds,
    nominalScale: nominal.length ? median(nominal) : null
  };
}

function osmRegistrationSamples(data, projector, anchor, radiusM) {
  const samples = [];
  let referenceId = 0;
  for (const element of data.elements || []) {
    const kind = osmRegistrationKind(element.tags || {});
    if (!kind) continue;
    for (const sequence of osmCoordinateSequences(element)) {
      const local = sequence.map((point) => projector.forward(point))
        .filter(([x, z]) => Number.isFinite(x) && Number.isFinite(z));
      for (const point of sampleLine(local, 6, 64)) {
        if (Math.hypot(point[0] - anchor[0], point[1] - anchor[1]) > radiusM) continue;
        samples.push({ x: point[0], z: point[1], kind, id: referenceId++ });
        if (samples.length >= MAX_OSM_SAMPLES) return samples;
      }
    }
  }
  return samples;
}

function osmCoordinateSequences(element) {
  const sequences = [];
  const add = (geometry) => {
    const points = (geometry || []).map((point) => [Number(point.lon), Number(point.lat)])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    if (points.length) sequences.push(points);
  };
  add(element.geometry);
  for (const member of element.members || []) add(member.geometry);
  if (!sequences.length && Number.isFinite(Number(element.lon)) && Number.isFinite(Number(element.lat))) {
    sequences.push([[Number(element.lon), Number(element.lat)]]);
  }
  return sequences;
}

function fitTransform(samples, grid, seed) {
  let tx = seed.tx, tz = seed.tz;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const transform = drawingTransform({ ...seed, tx, tz });
    const dx = [], dz = [];
    for (const sample of samples) {
      const [x, z] = transform([sample.x, sample.y]);
      const nearest = nearestReference(grid, sample.kind, x, z, ICP_NEAREST_M);
      if (!nearest) continue;
      dx.push(nearest.x - x); dz.push(nearest.z - z);
    }
    if (dx.length < MIN_SAMPLES) return null;
    tx += median(dx); tz += median(dz);
  }
  const transform = drawingTransform({ ...seed, tx, tz });
  const distances = [], inlierPoints = [], inlierFeatures = new Set(), matchedReferences = new Set();
  for (const sample of samples) {
    const [x, z] = transform([sample.x, sample.y]);
    const nearest = nearestReference(grid, sample.kind, x, z, INLIER_M * 2);
    const distance = nearest ? Math.hypot(nearest.x - x, nearest.z - z) : Infinity;
    distances.push(distance);
    if (nearest && distance <= INLIER_M) {
      inlierPoints.push([x, z]);
      inlierFeatures.add(sample.featureIndex);
      matchedReferences.add(nearest.id);
    }
  }
  const finite = distances.filter(Number.isFinite).sort((a, b) => a - b);
  const inliers = inlierPoints.length;
  const inlierRatio = inliers / samples.length;
  const medianM = percentile(finite, 0.5);
  const p90M = percentile(finite, 0.9);
  const featureCount = new Set(samples.map((sample) => sample.featureIndex)).size;
  const featureRatio = featureCount ? inlierFeatures.size / featureCount : 0;
  const uniqueRatio = inliers ? Math.min(1, matchedReferences.size / inliers) : 0;
  const residualQuality = Number.isFinite(medianM) ? Math.max(0, 1 - medianM / INLIER_M) : 0;
  const score = 0.55 * inlierRatio + 0.2 * featureRatio + 0.15 * residualQuality + 0.1 * uniqueRatio;
  return {
    ...seed, tx, tz, inliers, inlierRatio, inlierFeatures: inlierFeatures.size,
    uniqueMatches: matchedReferences.size, medianM, p90M, score,
    spreadM: pointSpread(inlierPoints),
    anchorShiftM: Math.hypot(tx - seed.anchorX, tz - seed.anchorZ)
  };
}

function drawingTransform({ scale, rotation, tx, tz }) {
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  return ([x, y]) => [
    tx + scale * (Number(x) * cosine - Number(y) * sine),
    tz + scale * (Number(x) * sine + Number(y) * cosine)
  ];
}

function buildGrid(references) {
  const cells = new Map();
  for (const reference of references) {
    const key = gridKey(reference.kind, reference.x, reference.z);
    const bucket = cells.get(key) || [];
    bucket.push(reference); cells.set(key, bucket);
  }
  return cells;
}

function nearestReference(grid, kind, x, z, maximumDistance) {
  const cx = Math.floor(x / GRID_CELL_M), cz = Math.floor(z / GRID_CELL_M);
  const radius = Math.ceil(maximumDistance / GRID_CELL_M);
  let best = null, bestDistance = maximumDistance;
  for (let dz = -radius; dz <= radius; dz += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (const reference of grid.get(`${kind}:${cx + dx}:${cz + dz}`) || []) {
        const distance = Math.hypot(reference.x - x, reference.z - z);
        if (distance < bestDistance) { best = reference; bestDistance = distance; }
      }
    }
  }
  return best;
}

function scaleCandidates(nominal) {
  if (Number.isFinite(nominal) && nominal > 0) {
    return [0.65, 0.8, 0.9, 1, 1.1, 1.25, 1.5].map((multiplier) => nominal * multiplier);
  }
  return [0.004, 0.0075, 0.014, 0.026, 0.05, 0.095, 0.18, 0.34, 0.65, 1.2, 2.2];
}

function registrationKind(kind) {
  const value = String(kind || "").toLowerCase();
  if (["building", "ride_track", "path", "barrier", "water"].includes(value)) return value;
  return null;
}

function osmRegistrationKind(tags) {
  if (tags.roller_coaster === "track") return "ride_track";
  if (tags.building || tags.roller_coaster === "station") return "building";
  if (tags.highway || tags["area:highway"]) return "path";
  if (tags.barrier) return "barrier";
  if (tags.water || tags.waterway || tags.natural === "water") return "water";
  return null;
}

function geometryPoints(geometry, maximum) {
  const sequences = [];
  if (geometry?.type === "Point") sequences.push([geometry.coordinates]);
  else if (geometry?.type === "LineString") sequences.push(geometry.coordinates);
  else if (geometry?.type === "Polygon") sequences.push(...geometry.coordinates);
  else if (geometry?.type === "MultiLineString") sequences.push(...geometry.coordinates);
  else if (geometry?.type === "MultiPolygon") for (const polygon of geometry.coordinates) sequences.push(...polygon);
  return evenlyLimit(sequences.flatMap((sequence) => sampleLine(sequence, 0, maximum)), maximum);
}

function sampleLine(points, spacing, maximum) {
  const valid = (points || []).map((point) => [Number(point[0]), Number(point[1])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (valid.length < 2 || !(spacing > 0)) return evenlyLimit(valid, maximum);
  const sampled = [valid[0]];
  for (let index = 1; index < valid.length && sampled.length < maximum; index += 1) {
    const start = valid[index - 1], end = valid[index];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let step = 1; step <= steps && sampled.length < maximum; step += 1) {
      const t = step / steps;
      sampled.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
    }
  }
  return sampled;
}

function evenlyLimit(values, maximum) {
  if (values.length <= maximum) return values;
  return Array.from({ length: maximum }, (_, index) => values[Math.floor(index * values.length / maximum)]);
}

function applicationLocation(application) {
  const coordinates = application.geometry?.type === "Point" ? application.geometry.coordinates : null;
  const lon = Number(coordinates?.[0] ?? application.lon ?? application.lng ?? application.longitude);
  const lat = Number(coordinates?.[1] ?? application.lat ?? application.latitude);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function diagnostics({ best, alternative, ambiguityMargin, confidence, planning, references }) {
  return {
    confidence: round(confidence),
    scaleMPerPixel: round(best.scale, 8),
    rotationDegrees: round(best.rotation, 4),
    translationLocal: { x: round(best.tx, 3), z: round(best.tz, 3) },
    planningSamples: planning.samples.length,
    planningFeatures: planning.featureCount,
    osmSamples: references.length,
    inliers: best.inliers,
    inlierFeatures: best.inlierFeatures,
    inlierRatio: round(best.inlierRatio),
    residualMedianM: round(best.medianM, 3),
    residualP90M: round(best.p90M, 3),
    spreadM: round(best.spreadM, 2),
    applicationAnchorShiftM: round(best.anchorShiftM, 2),
    ambiguityMargin: round(ambiguityMargin, 4),
    alternativeScore: alternative ? round(alternative.score, 4) : null
  };
}

function registrationConfidence(best, ambiguityMargin) {
  const featureRatio = best.inlierFeatures ? Math.min(1, best.inlierFeatures / 2) : 0;
  const residual = Math.max(0, 1 - best.medianM / INLIER_M);
  const unique = best.inliers ? Math.min(1, best.uniqueMatches / best.inliers) : 0;
  const ambiguity = Math.max(0, Math.min(1, ambiguityMargin / 0.12));
  return 0.4 * best.inlierRatio + 0.2 * featureRatio + 0.2 * residual + 0.1 * unique + 0.1 * ambiguity;
}

function failed(collection, status, extra = {}) {
  return { collection, registration: { status, verified: false, ...extra } };
}

function compareFits(a, b) {
  return b.score - a.score || a.medianM - b.medianM || b.inliers - a.inliers;
}

function distinctTransform(a, b) {
  if (a === b) return false;
  const rotationDifference = Math.abs(normalizeDegrees(a.rotation - b.rotation));
  const scaleRatio = Math.max(a.scale, b.scale) / Math.max(Number.EPSILON, Math.min(a.scale, b.scale));
  const translation = Math.hypot(a.tx - b.tx, a.tz - b.tz);
  // Nearby parameter values can describe the same sub-metre registration.
  // Treat only materially different poses as competing solutions.
  return rotationDifference >= 30 || scaleRatio >= 1.4 || translation >= 30;
}

function pointSpread(points) {
  if (!points.length) return 0;
  const xs = points.map((point) => point[0]), zs = points.map((point) => point[1]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
}

function percentile(sorted, fraction) {
  if (!sorted.length) return Infinity;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

function median(values) {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

function normalizeDegrees(value) {
  let result = Number(value) % 360;
  if (result >= 180) result -= 360;
  if (result < -180) result += 360;
  return result;
}

function gridKey(kind, x, z) {
  return `${kind}:${Math.floor(x / GRID_CELL_M)}:${Math.floor(z / GRID_CELL_M)}`;
}

const round = (value, places = 3) => Number(Number(value || 0).toFixed(places));
