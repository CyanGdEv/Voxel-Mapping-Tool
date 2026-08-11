import { geometryMapCoordinates, pointInPolygon } from "./geo.mjs";
import { classifyPathRole } from "./fidelity.mjs";

const DEFAULT_SNAP_TOLERANCE_M = 2.5;
const DEFAULT_MIN_CONFIDENCE = 0.72;
const EXISTING_NODE_TOLERANCE_M = 0.75;

/**
 * Conservatively repairs small source-relative route gaps before imagery
 * analysis. It never invents a free-standing route: every connector starts at
 * a dangling mapped endpoint and terminates on another mapped route segment.
 * Verified builds default to QA-only; plausible builds may compile accepted
 * repairs when --path-geometry-mode repair is active.
 */
export function enhancePathGeometry(map, options = {}) {
  const mode = options.pathGeometryMode || ((options.accuracyMode || "verified") === "plausible" ? "repair" : "qa");
  const toleranceM = Math.max(0.25, Math.min(10, Number(options.pathSnapToleranceM ?? DEFAULT_SNAP_TOLERANCE_M)));
  const minimumConfidence = Math.max(0, Math.min(1, Number(options.pathSnapMinConfidence ?? DEFAULT_MIN_CONFIDENCE)));
  const routeFeatures = map.features.filter(isLinearRouteFeature);
  const beforeAnalysis = connectivityAnalysis(routeFeatures);
  const before = beforeAnalysis.summary;

  if (mode === "off" || !routeFeatures.length) {
    const summary = emptySummary(mode, before, toleranceM, minimumConfidence);
    map.pathGeometry = summary;
    return { summary, qaGeojson: emptyQa(map, summary) };
  }

  const blockers = collectBlockingPolygons(map.features);
  const boundary = polygonParts(map.boundary?.localGeometry);
  const endpoints = collectEndpoints(routeFeatures);
  const segments = collectSegments(routeFeatures);
  const vertices = collectVertices(routeFeatures);
  const candidates = [];
  const rejectionReasons = {};
  const claimedTargets = new Set();
  const claimedGeometry = new Set();

  for (const endpoint of endpoints) {
    if (hasNearbyForeignVertex(endpoint, vertices, EXISTING_NODE_TOLERANCE_M)) {
      count(rejectionReasons, "already-connected-or-coincident");
      continue;
    }
    const ranked = [];
    for (const segment of segments) {
      if (segment.feature.id === endpoint.feature.id) continue;
      const compatibility = routeCompatibility(endpoint.feature, segment.feature);
      if (!compatibility.accepted) continue;
      const nearest = nearestPointOnSegment(endpoint.point, segment.a, segment.b);
      if (nearest.distanceM < 0.2 || nearest.distanceM > toleranceM) continue;
      const continuation = continuationScore(endpoint.outward, [
        nearest.point[0] - endpoint.point[0], nearest.point[1] - endpoint.point[1]
      ]);
      if (continuation < -0.15) continue;
      const connectsComponents = beforeAnalysis.componentByFeature.get(endpoint.feature.id) !==
        beforeAnalysis.componentByFeature.get(segment.feature.id);
      ranked.push({ segment, nearest, compatibility, continuation, connectsComponents });
    }
    ranked.sort((a, b) => Number(b.connectsComponents) - Number(a.connectsComponents) ||
      a.nearest.distanceM - b.nearest.distanceM || b.continuation - a.continuation);
    const best = ranked[0];
    if (!best) {
      count(rejectionReasons, "no-compatible-route-within-tolerance");
      continue;
    }

    const targetKey = pointKey(best.nearest.point, 0.5);
    const pairKey = [endpoint.feature.id, best.segment.feature.id, targetKey].sort().join("|");
    if (claimedTargets.has(pairKey)) {
      count(rejectionReasons, "duplicate-connector");
      continue;
    }
    claimedTargets.add(pairKey);

    const line = [endpoint.point, best.nearest.point];
    const geometryKey = [pointKey(line[0], 0.25), pointKey(line[1], 0.25)].sort().join("|");
    if (claimedGeometry.has(geometryKey)) {
      count(rejectionReasons, "duplicate-connector");
      continue;
    }
    claimedGeometry.add(geometryKey);
    if (!lineInsideBoundary(line, boundary)) {
      count(rejectionReasons, "outside-park-boundary");
      continue;
    }
    const blocked = lineBlocker(line, blockers);
    if (blocked) {
      count(rejectionReasons, `crosses-${blocked.kind}`);
      continue;
    }

    const sameSurface = normalizedSurface(endpoint.feature.tags) &&
      normalizedSurface(endpoint.feature.tags) === normalizedSurface(best.segment.feature.tags);
    const distanceScore = Math.max(0, 1 - best.nearest.distanceM / toleranceM);
    const confidence = round3(Math.min(0.96,
      0.62 + 0.2 * distanceScore + 0.06 * Math.max(0, best.continuation) +
      0.04 * best.compatibility.score + (sameSurface ? 0.02 : 0) +
      (best.connectsComponents ? 0.06 : 0)));
    const candidate = {
      id: `path-gap:${shortHash(`${endpoint.feature.id}|${best.segment.feature.id}|${targetKey}`)}`,
      fromFeatureId: endpoint.feature.id,
      toFeatureId: best.segment.feature.id,
      role: best.compatibility.role,
      kind: best.compatibility.kind,
      localGeometry: { type: "LineString", coordinates: line },
      distanceM: round2(best.nearest.distanceM),
      confidence,
      continuationScore: round3(best.continuation),
      blockedBy: null,
      status: confidence >= minimumConfidence ? "accepted" : "review",
      compilationEligible: mode === "repair" && confidence >= minimumConfidence,
      sourceSurface: sameSurface ? normalizedSurface(endpoint.feature.tags) : null,
      connectsComponents: best.connectsComponents,
      sourceFeatures: [endpoint.feature.id, best.segment.feature.id]
    };
    candidates.push(candidate);
  }

  const accepted = candidates.filter((candidate) => candidate.status === "accepted");
  const compiled = accepted.filter((candidate) => candidate.compilationEligible);
  for (const candidate of compiled) insertTargetVertex(map, candidate);
  const repairedFeatures = compiled.map((candidate) => connectorFeature(candidate, map));
  if (repairedFeatures.length) map.features.push(...repairedFeatures);
  const after = connectivityAnalysis([...routeFeatures, ...repairedFeatures]).summary;

  const summary = {
    schemaVersion: 1,
    status: candidates.length ? "available" : "no-small-gap-candidates",
    mode,
    method: "dangling mapped endpoint to nearest compatible mapped route segment; boundary and building/water exclusion gated",
    toleranceM,
    minimumConfidence,
    sourceRelativeOnly: true,
    before,
    after,
    candidateConnectors: candidates.length,
    acceptedConnectors: accepted.length,
    compiledConnectors: compiled.length,
    repairedLengthM: round1(compiled.reduce((sum, item) => sum + item.distanceM, 0)),
    componentReduction: Math.max(0, before.components - after.components),
    danglingEndpointReduction: Math.max(0, before.danglingEndpoints - after.danglingEndpoints),
    rejectionReasons,
    candidates: candidates.map(({ localGeometry, ...candidate }) => candidate),
    limitations: [
      "Repairs are limited to short source-relative endpoint gaps and cannot discover isolated paths.",
      "QA mode reports candidates without altering the compiled world.",
      "Connectors crossing mapped buildings or water are rejected; unrecorded barriers still require imagery or manual review."
    ]
  };
  map.pathGeometry = summary;
  return { summary, qaGeojson: buildQa(map, candidates) };
}

function insertTargetVertex(map, candidate) {
  const feature = map.features.find((entry) => entry.id === candidate.toFeatureId);
  if (!feature) return false;
  const target = candidate.localGeometry.coordinates.at(-1);
  const lines = lineParts(feature.localGeometry);
  let best = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (let segmentIndex = 1; segmentIndex < line.length; segmentIndex += 1) {
      const nearest = nearestPointOnSegment(target, line[segmentIndex - 1], line[segmentIndex]);
      if (!best || nearest.distanceM < best.distanceM) best = { line, segmentIndex, ...nearest };
    }
  }
  if (!best || best.distanceM > 0.2) return false;
  if (best.line.some((point) => distance(point, target) < 0.15)) return false;
  best.line.splice(best.segmentIndex, 0, [...target]);
  feature.geometry = geometryMapCoordinates(feature.localGeometry, map.projector.inverse);
  feature.pathGeometry ||= {};
  feature.pathGeometry.insertedJunctions = (feature.pathGeometry.insertedJunctions || 0) + 1;
  return true;
}

function connectorFeature(candidate, map) {
  const tags = {
    highway: candidate.kind === "road" ? "service" : "footway",
    "path:repair": "endpoint_snap",
    "repair:distance_m": String(candidate.distanceM),
    "repair:confidence": String(candidate.confidence),
    "repair:from": candidate.fromFeatureId,
    "repair:to": candidate.toFeatureId
  };
  if (candidate.role === "queue") tags.queue = "yes";
  if (candidate.role === "service") tags.access = "private";
  if (candidate.sourceSurface) tags.surface = candidate.sourceSurface;
  return {
    id: `derived:${candidate.id}`,
    name: null,
    kind: candidate.kind,
    subtype: candidate.kind === "road" ? "service" : "footway",
    tags,
    geometry: geometryMapCoordinates(candidate.localGeometry, map.projector.inverse),
    localGeometry: candidate.localGeometry,
    vertical: { heightM: null, heightSource: null, minHeightM: 0, elevationM: null, explicit: false },
    source: {
      provider: "Voxel Mapping Tool source-relative path repair",
      sourceUrl: null,
      timestamp: null,
      license: "ODbL-1.0",
      derivedFrom: candidate.sourceFeatures,
      method: "endpoint-snap"
    },
    verification: { plan: "source-relative-inference", vertical: "unknown" },
    pathGeometry: {
      schemaVersion: 1,
      status: "compiled-repair",
      confidence: candidate.confidence,
      distanceM: candidate.distanceM,
      sourceFeatures: candidate.sourceFeatures
    }
  };
}

function collectEndpoints(features) {
  const result = [];
  for (const feature of features) {
    for (const [lineIndex, line] of lineParts(feature.localGeometry).entries()) {
      if (line.length < 2) continue;
      const start = line[0], next = line[1], end = line.at(-1), previous = line.at(-2);
      result.push({ feature, lineIndex, point: start, outward: unit([start[0] - next[0], start[1] - next[1]]) });
      result.push({ feature, lineIndex, point: end, outward: unit([end[0] - previous[0], end[1] - previous[1]]) });
    }
  }
  return result;
}

function collectSegments(features) {
  const result = [];
  for (const feature of features) {
    for (const line of lineParts(feature.localGeometry)) {
      for (let index = 1; index < line.length; index += 1) {
        result.push({ feature, a: line[index - 1], b: line[index] });
      }
    }
  }
  return result;
}

function collectVertices(features) {
  const result = [];
  for (const feature of features) for (const line of lineParts(feature.localGeometry)) {
    for (const point of line) result.push({ featureId: feature.id, point });
  }
  return result;
}

function hasNearbyForeignVertex(endpoint, vertices, tolerance) {
  return vertices.some((vertex) => vertex.featureId !== endpoint.feature.id && distance(endpoint.point, vertex.point) <= tolerance);
}

function routeCompatibility(first, second) {
  const firstRole = classifyPathRole(first.tags || {}, first.kind);
  const secondRole = classifyPathRole(second.tags || {}, second.kind);
  const firstLayer = routeLayer(first), secondLayer = routeLayer(second);
  if (firstLayer !== secondLayer) return { accepted: false };
  if (routeBoolean(first.tags?.tunnel) !== routeBoolean(second.tags?.tunnel)) return { accepted: false };
  if (routeBoolean(first.tags?.bridge) !== routeBoolean(second.tags?.bridge)) return { accepted: false };
  if (firstRole === "queue" || secondRole === "queue") {
    if (firstRole !== secondRole) return { accepted: false };
  }
  if ((firstRole === "service") !== (secondRole === "service")) return { accepted: false };
  const role = firstRole === secondRole ? firstRole : "guest";
  const kind = role === "service" && first.kind === "road" && second.kind === "road" ? "road" : "path";
  return { accepted: true, role, kind, score: firstRole === secondRole ? 1 : 0.7 };
}

function lineBlocker(line, blockers) {
  const lengthM = distance(line[0], line[1]);
  const steps = Math.max(2, Math.ceil(lengthM / 0.5));
  for (let step = 1; step < steps; step += 1) {
    const t = step / steps;
    const point = [line[0][0] + (line[1][0] - line[0][0]) * t, line[0][1] + (line[1][1] - line[0][1]) * t];
    for (const blocker of blockers) if (pointInPolygon(point[0], point[1], blocker.rings)) return blocker;
  }
  return null;
}

function lineInsideBoundary(line, polygons) {
  if (!polygons.length) return true;
  const midpoint = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  return [line[0], midpoint, line[1]].every((point) => polygons.some((rings) => pointInPolygon(point[0], point[1], rings)));
}

function collectBlockingPolygons(features) {
  const result = [];
  for (const feature of features) {
    if (!new Set(["building", "water"]).has(feature.kind)) continue;
    for (const rings of polygonParts(feature.localGeometry)) result.push({ kind: feature.kind, featureId: feature.id, rings });
  }
  return result;
}

function connectivityAnalysis(features) {
  if (!features.length) return {
    summary: { components: 0, isolatedFeatures: 0, danglingEndpoints: 0, nodes: 0, edges: 0 },
    componentByFeature: new Map()
  };
  const parent = features.map((_, index) => index);
  const rank = features.map(() => 0);
  const buckets = new Map();
  const degrees = new Map();
  let edges = 0;
  const find = (value) => parent[value] === value ? value : (parent[value] = find(parent[value]));
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) [a, b] = [b, a];
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a] += 1;
  };
  features.forEach((feature, featureIndex) => {
    for (const line of lineParts(feature.localGeometry)) {
      for (let index = 0; index < line.length; index += 1) {
        const key = pointKey(line[index], 0.5);
        if (!buckets.has(key)) buckets.set(key, []);
        for (const other of buckets.get(key)) union(featureIndex, other);
        buckets.get(key).push(featureIndex);
        if (index) {
          const previous = pointKey(line[index - 1], 0.5);
          degrees.set(previous, (degrees.get(previous) || 0) + 1);
          degrees.set(key, (degrees.get(key) || 0) + 1);
          edges += 1;
        }
      }
    }
  });
  const groups = new Map();
  features.forEach((_, index) => groups.set(find(index), (groups.get(find(index)) || 0) + 1));
  const componentByFeature = new Map();
  features.forEach((feature, index) => componentByFeature.set(feature.id, find(index)));
  return {
    summary: {
      components: groups.size,
      isolatedFeatures: [...groups.values()].filter((value) => value === 1).length,
      danglingEndpoints: [...degrees.values()].filter((value) => value === 1).length,
      nodes: degrees.size,
      edges
    },
    componentByFeature
  };
}

function buildQa(map, candidates) {
  return {
    type: "FeatureCollection",
    name: `${map.geojson?.name || "Theme Park"} path geometry QA`,
    features: candidates.map((candidate) => ({
      type: "Feature",
      id: candidate.id,
      geometry: geometryMapCoordinates(candidate.localGeometry, map.projector.inverse),
      properties: {
        kind: "mapped_path_gap_connector",
        status: candidate.status,
        compilation_eligible: candidate.compilationEligible,
        confidence: candidate.confidence,
        distance_m: candidate.distanceM,
        role: candidate.role,
        from_feature_id: candidate.fromFeatureId,
        to_feature_id: candidate.toFeatureId
      }
    }))
  };
}

function emptySummary(mode, before, toleranceM, minimumConfidence) {
  return {
    schemaVersion: 1,
    status: mode === "off" ? "disabled" : "no-linear-routes",
    mode,
    toleranceM,
    minimumConfidence,
    before,
    after: before,
    candidateConnectors: 0,
    acceptedConnectors: 0,
    compiledConnectors: 0,
    repairedLengthM: 0,
    componentReduction: 0,
    danglingEndpointReduction: 0,
    rejectionReasons: {},
    candidates: []
  };
}

function emptyQa(map, summary) {
  return { type: "FeatureCollection", name: `${map.geojson?.name || "Theme Park"} path geometry QA`, properties: { status: summary.status }, features: [] };
}

function isLinearRouteFeature(feature) {
  return ["path", "road"].includes(feature.kind) && ["LineString", "MultiLineString"].includes(feature.localGeometry?.type) &&
    feature.tags?.["orthophoto:discovered"] !== "yes";
}

function lineParts(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function polygonParts(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function nearestPointOnSegment(point, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const denominator = dx * dx + dz * dz;
  const t = denominator ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / denominator)) : 0;
  const nearest = [a[0] + dx * t, a[1] + dz * t];
  return { point: nearest, t, distanceM: distance(point, nearest) };
}

function continuationScore(outward, connector) {
  const direction = unit(connector);
  return outward[0] * direction[0] + outward[1] * direction[1];
}

function routeLayer(feature) {
  const layer = Number(feature.tags?.layer);
  return Number.isFinite(layer) ? layer : 0;
}

function routeBoolean(value) {
  const key = String(value || "").toLowerCase();
  return Boolean(key && !["no", "false", "0"].includes(key));
}

function normalizedSurface(tags = {}) {
  return String(tags.surface || tags.material || "").trim().toLowerCase() || null;
}

function pointKey(point, precision) {
  return `${Math.round(point[0] / precision) * precision},${Math.round(point[1] / precision) * precision}`;
}

function unit(vector) {
  const length = Math.hypot(vector[0], vector[1]) || 1;
  return [vector[0] / length, vector[1] / length];
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function shortHash(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function count(target, key) {
  target[key] = (target[key] || 0) + 1;
}

const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;
