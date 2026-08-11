// TPMAP_PHASE34_RIDE_3D_GEOMETRY_V1
// Build evidence-bounded 3D ride geometry from planning-authoritative 2D alignment + solved vertical profile.

import { elevationAtRideMeasure } from "./ride-vertical-profile.mjs";

const DEFAULT_SAMPLE_STEP_M = 1;

export function buildRide3dGeometry(graph, options = {}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error("Phase 34 ride 3D geometry requires reconstruction graph");
  const diagnostics = {
    marker: "TPMAP_PHASE34_RIDE_3D_GEOMETRY_V1",
    ridesVisited: 0,
    ridesWith3dGeometry: 0,
    ridesPartial: 0,
    ridesUnresolved: 0,
    resolvedSamples: 0,
    unresolvedSamples: 0,
    resolvedSegments: 0,
    unresolvedSegments: 0
  };

  const compact = [];
  for (const node of graph.nodes) {
    if (node.type !== "ride-track") continue;
    diagnostics.ridesVisited += 1;
    const geometry3d = buildTrackGeometry(node, options, diagnostics);
    Object.defineProperty(node, "geometry3d", { enumerable: false, configurable: true, value: geometry3d });
    compact.push(compactGeometry(geometry3d));
    if (geometry3d.status === "resolved") diagnostics.ridesWith3dGeometry += 1;
    else if (geometry3d.status === "partial") diagnostics.ridesPartial += 1;
    else diagnostics.ridesUnresolved += 1;
  }

  graph.ride3dGeometry = compact;
  graph.summary = { ...(graph.summary || {}), ride3dGeometry: diagnostics };
  return diagnostics;
}

export function validateRide3dGeometry(graph) {
  const diag = graph?.summary?.ride3dGeometry;
  if (!diag || diag.marker !== "TPMAP_PHASE34_RIDE_3D_GEOMETRY_V1") throw new Error("Phase 34 ride 3D geometry diagnostics missing");
  for (const node of graph.nodes || []) {
    if (node.type !== "ride-track") continue;
    const g = node.geometry3d;
    if (!g) throw new Error(`Phase 34 ride ${node.id} missing 3D geometry`);
    let previous = -Infinity;
    for (const sample of g.samples || []) {
      if (!Number.isFinite(sample.measureM)) throw new Error(`Phase 34 ride ${node.id} invalid sample measure`);
      if (sample.measureM < previous) throw new Error(`Phase 34 ride ${node.id} sample order invalid`);
      previous = sample.measureM;
      if (sample.resolved && !Number.isFinite(sample.y)) throw new Error(`Phase 34 ride ${node.id} resolved sample lacks Y`);
      if (!sample.resolved && sample.y !== null) throw new Error(`Phase 34 ride ${node.id} unresolved sample fabricated Y`);
    }
    for (const segment of g.segments || []) {
      if (!(segment.endMeasureM > segment.startMeasureM)) throw new Error(`Phase 34 ride ${node.id} invalid 3D segment`);
      if (!['resolved-3d','unresolved-vertical-gap'].includes(segment.mode)) throw new Error(`Phase 34 ride ${node.id} invalid 3D segment mode`);
    }
  }
  return graph;
}

function buildTrackGeometry(node, options, diagnostics) {
  const line = asLine(node.geometry?.local);
  const profile = node.rideVerticalProfile;
  if (!line || line.length < 2 || !profile) return unresolved(node, "missing-alignment-or-profile");
  const measured = measureLine(line);
  if (!(measured.totalLengthM > 0)) return unresolved(node, "zero-length-alignment");
  const stepM = clampPositive(options.ride3dSampleStepM, DEFAULT_SAMPLE_STEP_M);
  const measures = sampleMeasures(measured.totalLengthM, stepM);
  const samples = [];
  for (const measureM of measures) {
    const horizontal = pointAtMeasure(measured, measureM);
    const y = elevationAtRideMeasure(profile, measureM);
    const resolved = y !== null;
    samples.push({
      measureM: round3(measureM),
      x: round3(horizontal[0]),
      z: round3(horizontal[1]),
      y: resolved ? round3(y) : null,
      resolved,
      source: resolved ? "planning-vertical-profile" : "unresolved"
    });
    if (resolved) diagnostics.resolvedSamples += 1;
    else diagnostics.unresolvedSamples += 1;
  }

  const segments = [];
  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i], b = samples[i + 1];
    const resolved = a.resolved && b.resolved;
    const segment = {
      startMeasureM: a.measureM,
      endMeasureM: b.measureM,
      mode: resolved ? "resolved-3d" : "unresolved-vertical-gap",
      start: [a.x, a.y, a.z],
      end: [b.x, b.y, b.z]
    };
    if (resolved) {
      const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
      const horizontalM = Math.hypot(dx, dz);
      segment.length3dM = round3(Math.hypot(horizontalM, dy));
      segment.pitchDeg = round3(Math.atan2(dy, Math.max(horizontalM, 1e-9)) * 180 / Math.PI);
      diagnostics.resolvedSegments += 1;
    } else {
      segment.length3dM = null;
      segment.pitchDeg = null;
      diagnostics.unresolvedSegments += 1;
    }
    segments.push(segment);
  }

  const resolvedCount = samples.filter((s) => s.resolved).length;
  const status = resolvedCount === samples.length ? "resolved" : resolvedCount >= 2 ? "partial" : "unresolved";
  return {
    marker: "TPMAP_PHASE34_RIDE_3D_GEOMETRY_V1",
    rideId: node.id,
    status,
    sampleStepM: stepM,
    totalLength2dM: round3(measured.totalLengthM),
    samples,
    segments,
    policy: "planning-alignment-plus-evidence-bounded-vertical-profile-no-y-extrapolation"
  };
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
  for (const coord of coords) {
    const p = [Number(coord[0]), Number(coord[1])];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (points.length) totalLengthM += distance(points[points.length - 1].point, p);
    points.push({ point: p, measureM: totalLengthM });
  }
  return { points, totalLengthM };
}

function pointAtMeasure(measured, measureM) {
  const m = Math.max(0, Math.min(measured.totalLengthM, measureM));
  for (let i = 0; i < measured.points.length - 1; i += 1) {
    const a = measured.points[i], b = measured.points[i + 1];
    if (m < a.measureM || m > b.measureM) continue;
    const span = b.measureM - a.measureM;
    const t = span > 0 ? (m - a.measureM) / span : 0;
    return [a.point[0] + (b.point[0] - a.point[0]) * t, a.point[1] + (b.point[1] - a.point[1]) * t];
  }
  return measured.points.at(-1).point;
}

function sampleMeasures(total, step) {
  const out = [0];
  for (let m = step; m < total; m += step) out.push(m);
  if (total > 0) out.push(total);
  return out;
}

function compactGeometry(g) {
  return {
    rideId: g.rideId,
    status: g.status,
    sampleStepM: g.sampleStepM || null,
    totalLength2dM: g.totalLength2dM || null,
    resolvedSamples: (g.samples || []).filter((s) => s.resolved).length,
    unresolvedSamples: (g.samples || []).filter((s) => !s.resolved).length,
    resolvedSegments: (g.segments || []).filter((s) => s.mode === "resolved-3d").length,
    unresolvedSegments: (g.segments || []).filter((s) => s.mode !== "resolved-3d").length
  };
}

function unresolved(node, reason) {
  return { marker: "TPMAP_PHASE34_RIDE_3D_GEOMETRY_V1", rideId: node.id, status: "unresolved", reason, sampleStepM: null, totalLength2dM: null, samples: [], segments: [], policy: "planning-alignment-plus-evidence-bounded-vertical-profile-no-y-extrapolation" };
}
function clampPositive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.max(0.25, Math.min(10, n)) : fallback; }
function distance(a, b) { return Math.hypot(Number(a[0]) - Number(b[0]), Number(a[1]) - Number(b[1])); }
function round3(v) { return Math.round(Number(v) * 1000) / 1000; }
