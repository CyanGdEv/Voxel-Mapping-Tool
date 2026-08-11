// TPMAP_PHASE34_RIDE_VERTICAL_PROFILE_V1
// Build evidence-bounded continuous vertical profiles along planning-authoritative ride tracks.

const DEFAULT_MAX_LATERAL_M = 14;
const DEFAULT_MAX_ANCHOR_GAP_M = 220;

export function solveRideVerticalProfiles(graph, options = {}) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.evidenceNodes)) {
    throw new Error("Phase 34 ride profile solver requires a reconstruction graph");
  }
  const observations = graph.evidenceNodes.filter((node) => node.observationType === "ride-elevation");
  if (graph.authorityMode === "planning-only" && observations.some((node) => node.authority?.osmDerived)) {
    throw new Error("Phase 34 ride profile rejected OSM-derived ride elevation evidence");
  }

  const diagnostics = {
    marker: "TPMAP_PHASE34_RIDE_VERTICAL_PROFILE_V1",
    rideTracksVisited: 0,
    profilesResolved: 0,
    profilesPartial: 0,
    profilesUnresolved: 0,
    anchorsAccepted: 0,
    anchorsRejectedDistance: 0,
    anchorsRejectedIdentity: 0,
    interpolationSegments: 0,
    unsupportedGaps: 0
  };

  const profiles = [];
  for (const node of graph.nodes) {
    if (node.type !== "ride-track") continue;
    diagnostics.rideTracksVisited += 1;
    const profile = solveTrack(node, observations, options, diagnostics);
    Object.defineProperty(node, "rideVerticalProfile", { enumerable: false, configurable: true, value: profile });
    profiles.push(compactProfile(profile));
    if (profile.status === "resolved") diagnostics.profilesResolved += 1;
    else if (profile.status === "partial") diagnostics.profilesPartial += 1;
    else diagnostics.profilesUnresolved += 1;
  }

  graph.rideVerticalProfiles = profiles;
  graph.summary = { ...(graph.summary || {}), rideVerticalProfiles: diagnostics };
  return diagnostics;
}

export function validateRideVerticalProfiles(graph) {
  if (!graph?.summary?.rideVerticalProfiles || graph.summary.rideVerticalProfiles.marker !== "TPMAP_PHASE34_RIDE_VERTICAL_PROFILE_V1") {
    throw new Error("Phase 34 ride vertical profile diagnostics are missing");
  }
  for (const node of graph.nodes || []) {
    if (node.type !== "ride-track") continue;
    const profile = node.rideVerticalProfile;
    if (!profile) throw new Error(`Phase 34 ride ${node.id} lacks vertical profile state`);
    let previous = -Infinity;
    for (const anchor of profile.anchors) {
      if (!Number.isFinite(anchor.measureM) || !Number.isFinite(anchor.elevationM)) throw new Error(`Phase 34 ride ${node.id} has invalid anchor`);
      if (anchor.measureM < previous) throw new Error(`Phase 34 ride ${node.id} anchors are not ordered`);
      previous = anchor.measureM;
      if (anchor.osmDerived) throw new Error(`Phase 34 ride ${node.id} contains OSM-derived vertical anchor`);
    }
    for (const segment of profile.segments) {
      if (!(segment.endMeasureM > segment.startMeasureM)) throw new Error(`Phase 34 ride ${node.id} has invalid profile segment`);
      if (!["linear-planning-interpolation", "unsupported-gap"].includes(segment.mode)) throw new Error(`Phase 34 ride ${node.id} has invalid segment mode`);
    }
  }
  return graph;
}

function solveTrack(node, observations, options, diagnostics) {
  const line = asLine(node.geometry?.local);
  if (!line || line.length < 2) return unresolvedProfile(node, "missing-line-geometry");
  const measured = measureLine(line);
  const maxLateralM = finite(options.rideVerticalMaxLateralM) ?? DEFAULT_MAX_LATERAL_M;
  const maxGapM = finite(options.rideVerticalMaxAnchorGapM) ?? DEFAULT_MAX_ANCHOR_GAP_M;
  const anchors = [];

  for (const observation of observations) {
    if (!identityCompatible(node, observation)) {
      diagnostics.anchorsRejectedIdentity += 1;
      continue;
    }
    const elevationM = observationElevation(observation);
    if (elevationM === null) continue;
    const projected = projectPointToMeasuredLine(observation.geometry?.centroid, measured);
    if (!projected || projected.distanceM > maxLateralM) {
      diagnostics.anchorsRejectedDistance += 1;
      continue;
    }
    anchors.push({
      observationId: observation.id,
      measureM: round3(projected.measureM),
      lateralDistanceM: round3(projected.distanceM),
      elevationM: round3(elevationM),
      planningReference: observation.evidence?.planningReference || null,
      sourceHash: observation.evidence?.sourceHash || null,
      confidence: observation.confidence?.overall ?? null,
      point: projected.point,
      label: observation.semantics?.planningRole || observation.semantics?.planningClass || null,
      osmDerived: Boolean(observation.authority?.osmDerived)
    });
  }

  anchors.sort(compareAnchor);
  const deduped = dedupeAnchors(anchors);
  diagnostics.anchorsAccepted += deduped.length;
  if (deduped.length < 2) return { ...unresolvedProfile(node, deduped.length ? "single-anchor" : "no-compatible-anchors"), anchors: deduped };

  const segments = [];
  let supportedLengthM = 0;
  for (let i = 0; i < deduped.length - 1; i += 1) {
    const a = deduped[i], b = deduped[i + 1];
    const gapM = b.measureM - a.measureM;
    if (gapM <= 0) continue;
    if (gapM > maxGapM) {
      segments.push({ startMeasureM: a.measureM, endMeasureM: b.measureM, mode: "unsupported-gap", gapM: round3(gapM) });
      diagnostics.unsupportedGaps += 1;
      continue;
    }
    segments.push({
      startMeasureM: a.measureM,
      endMeasureM: b.measureM,
      startElevationM: a.elevationM,
      endElevationM: b.elevationM,
      mode: "linear-planning-interpolation",
      gradient: round6((b.elevationM - a.elevationM) / gapM),
      sourceAnchors: [a.observationId, b.observationId]
    });
    supportedLengthM += gapM;
    diagnostics.interpolationSegments += 1;
  }

  const first = deduped[0], last = deduped[deduped.length - 1];
  const coverageSpanM = Math.max(0, last.measureM - first.measureM);
  const coverageRatio = measured.totalLengthM > 0 ? supportedLengthM / measured.totalLengthM : 0;
  const status = segments.some((segment) => segment.mode === "linear-planning-interpolation")
    ? (first.measureM <= 1 && measured.totalLengthM - last.measureM <= 1 && !segments.some((segment) => segment.mode === "unsupported-gap") ? "resolved" : "partial")
    : "unresolved";

  return {
    marker: "TPMAP_PHASE34_RIDE_VERTICAL_PROFILE_V1",
    rideId: node.id,
    status,
    reason: null,
    totalLengthM: round3(measured.totalLengthM),
    coverageSpanM: round3(coverageSpanM),
    supportedLengthM: round3(supportedLengthM),
    coverageRatio: round6(Math.max(0, Math.min(1, coverageRatio))),
    anchors: deduped,
    segments,
    policy: "interpolate-only-between-compatible-planning-anchors-no-extrapolation"
  };
}

export function elevationAtRideMeasure(profile, measureM) {
  const m = finite(measureM);
  if (!profile || m === null) return null;
  for (const segment of profile.segments || []) {
    if (segment.mode !== "linear-planning-interpolation") continue;
    if (m < segment.startMeasureM || m > segment.endMeasureM) continue;
    const span = segment.endMeasureM - segment.startMeasureM;
    if (!(span > 0)) return null;
    const t = (m - segment.startMeasureM) / span;
    return round3(segment.startElevationM + (segment.endElevationM - segment.startElevationM) * t);
  }
  return null;
}

function identityCompatible(node, observation) {
  const nodeRef = node.evidence?.planningReference;
  const obsRef = observation.evidence?.planningReference;
  const nodeHash = node.evidence?.sourceHash;
  const obsHash = observation.evidence?.sourceHash;
  if (nodeHash && obsHash) return nodeHash === obsHash;
  if (nodeRef && obsRef) return nodeRef === obsRef;
  return Boolean(node.authority?.planningAuthoritative && observation.authority?.planningAuthoritative);
}

function observationElevation(observation) {
  return finite(observation.vertical?.explicitElevationM)
    ?? finite(observation.vertical?.baseElevationM)
    ?? finite(observation.vertical?.groundElevationM);
}

function asLine(geometry) {
  if (!geometry) return null;
  if (geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type === "MultiLineString") return geometry.coordinates.flat();
  return null;
}

function measureLine(coords) {
  const points = [];
  let totalLengthM = 0;
  for (let i = 0; i < coords.length; i += 1) {
    const point = [Number(coords[i][0]), Number(coords[i][1])];
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    if (points.length) totalLengthM += distance(points[points.length - 1].point, point);
    points.push({ point, measureM: totalLengthM });
  }
  return { points, totalLengthM };
}

function projectPointToMeasuredLine(point, measured) {
  if (!Array.isArray(point) || measured.points.length < 2) return null;
  let best = null;
  for (let i = 0; i < measured.points.length - 1; i += 1) {
    const a = measured.points[i], b = measured.points[i + 1];
    const projected = projectPointSegment(point, a.point, b.point);
    const measureM = a.measureM + projected.t * distance(a.point, b.point);
    const candidate = { ...projected, measureM };
    if (!best || candidate.distanceM < best.distanceM || (candidate.distanceM === best.distanceM && candidate.measureM < best.measureM)) best = candidate;
  }
  return best;
}

function projectPointSegment(p, a, b) {
  const vx = b[0] - a[0], vz = b[1] - a[1];
  const wx = p[0] - a[0], wz = p[1] - a[1];
  const vv = vx * vx + vz * vz;
  const t = vv > 0 ? Math.max(0, Math.min(1, (wx * vx + wz * vz) / vv)) : 0;
  const point = [a[0] + vx * t, a[1] + vz * t];
  return { t, point: point.map(round3), distanceM: distance(p, point) };
}

function dedupeAnchors(anchors) {
  const result = [];
  for (const anchor of anchors) {
    const previous = result[result.length - 1];
    if (previous && Math.abs(previous.measureM - anchor.measureM) <= 0.25) {
      if (compareAnchor(anchor, previous) < 0) result[result.length - 1] = anchor;
      continue;
    }
    result.push(anchor);
  }
  return result;
}

function compareAnchor(a, b) {
  return a.measureM - b.measureM
    || (b.confidence ?? -1) - (a.confidence ?? -1)
    || a.lateralDistanceM - b.lateralDistanceM
    || String(a.observationId).localeCompare(String(b.observationId));
}

function compactProfile(profile) {
  return {
    rideId: profile.rideId,
    status: profile.status,
    reason: profile.reason,
    totalLengthM: profile.totalLengthM,
    supportedLengthM: profile.supportedLengthM || 0,
    coverageRatio: profile.coverageRatio || 0,
    anchors: profile.anchors?.map((a) => [a.measureM, a.elevationM, a.observationId]) || [],
    segments: profile.segments?.map((s) => [s.startMeasureM, s.endMeasureM, s.mode, s.startElevationM ?? null, s.endElevationM ?? null]) || []
  };
}

function unresolvedProfile(node, reason) {
  return {
    marker: "TPMAP_PHASE34_RIDE_VERTICAL_PROFILE_V1",
    rideId: node.id,
    status: "unresolved",
    reason,
    totalLengthM: null,
    coverageSpanM: 0,
    supportedLengthM: 0,
    coverageRatio: 0,
    anchors: [],
    segments: [],
    policy: "interpolate-only-between-compatible-planning-anchors-no-extrapolation"
  };
}

function distance(a, b) {
  return Math.hypot(Number(a[0]) - Number(b[0]), Number(a[1]) - Number(b[1]));
}
function finite(value) { if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function round3(value) { return Math.round(Number(value) * 1000) / 1000; }
function round6(value) { return Math.round(Number(value) * 1e6) / 1e6; }