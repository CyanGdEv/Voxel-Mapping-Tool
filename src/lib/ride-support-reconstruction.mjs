// TPMAP_PHASE34_RIDE_SUPPORT_RECONSTRUCTION_V1
// Reconstruct planning ride supports between resolved 3D track geometry and resolved terrain/ground.

const DEFAULT_MAX_TRACK_DISTANCE_M = 18;

export function reconstructRideSupports(graph, options = {}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error("Phase 34 support reconstruction requires reconstruction graph");
  const diagnostics = {
    marker: "TPMAP_PHASE34_RIDE_SUPPORT_RECONSTRUCTION_V1",
    supportsVisited: 0,
    supportsResolved: 0,
    supportsUnresolved: 0,
    unresolvedTrack: 0,
    unresolvedGround: 0,
    rejectedIdentity: 0,
    rejectedDistance: 0
  };
  const rideTracks = graph.nodes.filter((node) => node.type === "ride-track" && node.geometry3d);
  const compact = [];

  for (const support of graph.nodes) {
    if (support.type !== "ride-support") continue;
    diagnostics.supportsVisited += 1;
    const reconstruction = solveSupport(support, rideTracks, options, diagnostics);
    Object.defineProperty(support, "supportReconstruction", { enumerable: false, configurable: true, value: reconstruction });
    compact.push(compactSupport(reconstruction));
    if (reconstruction.status === "resolved") diagnostics.supportsResolved += 1;
    else diagnostics.supportsUnresolved += 1;
  }

  graph.rideSupportReconstructions = compact;
  graph.summary = { ...(graph.summary || {}), rideSupportReconstruction: diagnostics };
  return diagnostics;
}

export function validateRideSupportReconstructions(graph) {
  const diagnostics = graph?.summary?.rideSupportReconstruction;
  if (!diagnostics || diagnostics.marker !== "TPMAP_PHASE34_RIDE_SUPPORT_RECONSTRUCTION_V1") {
    throw new Error("Phase 34 support reconstruction diagnostics missing");
  }
  for (const node of graph.nodes || []) {
    if (node.type !== "ride-support") continue;
    const support = node.supportReconstruction;
    if (!support) throw new Error(`Phase 34 support ${node.id} lacks reconstruction state`);
    if (support.status === "resolved") {
      for (const value of [support.footing?.x, support.footing?.y, support.footing?.z, support.connection?.x, support.connection?.y, support.connection?.z, support.length3dM]) {
        if (!Number.isFinite(value)) throw new Error(`Phase 34 support ${node.id} has invalid resolved geometry`);
      }
      if (support.connection.y <= support.footing.y) throw new Error(`Phase 34 support ${node.id} connection is not above footing`);
      if (support.osmDerived) throw new Error(`Phase 34 support ${node.id} used OSM-derived evidence`);
    }
  }
  return graph;
}

function solveSupport(support, rideTracks, options, diagnostics) {
  if (support.authority?.osmDerived) throw new Error(`Phase 34 support reconstruction rejected OSM-derived support ${support.id}`);
  const centroid = support.geometry?.centroid;
  if (!Array.isArray(centroid)) return unresolved(support, "missing-support-position");
  const maxTrackDistanceM = finite(options.rideSupportMaxTrackDistanceM) ?? DEFAULT_MAX_TRACK_DISTANCE_M;
  const compatibleTracks = chooseCompatibleTracks(support, rideTracks);
  diagnostics.rejectedIdentity += Math.max(0, rideTracks.length - compatibleTracks.length);

  let best = null;
  for (const ride of compatibleTracks) {
    for (const sample of ride.geometry3d?.samples || []) {
      if (!sample.resolved || !Number.isFinite(sample.y)) continue;
      const lateralDistanceM = Math.hypot(sample.x - centroid[0], sample.z - centroid[1]);
      if (lateralDistanceM > maxTrackDistanceM) continue;
      const candidate = { ride, sample, lateralDistanceM };
      if (!best || candidate.lateralDistanceM < best.lateralDistanceM || (candidate.lateralDistanceM === best.lateralDistanceM && candidate.sample.measureM < best.sample.measureM)) best = candidate;
    }
  }
  if (!best) {
    diagnostics.unresolvedTrack += 1;
    diagnostics.rejectedDistance += 1;
    return unresolved(support, "no-resolved-track-connection");
  }

  const groundY = resolvedGround(support);
  if (groundY === null) {
    diagnostics.unresolvedGround += 1;
    return unresolved(support, "missing-ground-elevation", best);
  }
  if (!(best.sample.y > groundY)) return unresolved(support, "track-not-above-ground", best, groundY);

  const footing = { x: round3(centroid[0]), y: round3(groundY), z: round3(centroid[1]) };
  const connection = { x: round3(best.sample.x), y: round3(best.sample.y), z: round3(best.sample.z), measureM: round3(best.sample.measureM) };
  const vector = {
    x: round3(connection.x - footing.x),
    y: round3(connection.y - footing.y),
    z: round3(connection.z - footing.z)
  };
  const horizontalOffsetM = Math.hypot(vector.x, vector.z);
  const length3dM = Math.hypot(horizontalOffsetM, vector.y);
  const leanDeg = Math.atan2(horizontalOffsetM, Math.max(vector.y, 1e-9)) * 180 / Math.PI;

  return {
    marker: "TPMAP_PHASE34_RIDE_SUPPORT_RECONSTRUCTION_V1",
    supportId: support.id,
    status: "resolved",
    reason: null,
    rideId: best.ride.id,
    footing,
    connection,
    vector,
    verticalHeightM: round3(vector.y),
    horizontalOffsetM: round3(horizontalOffsetM),
    length3dM: round3(length3dM),
    leanDeg: round3(leanDeg),
    lateralTrackDistanceM: round3(best.lateralDistanceM),
    confidence: supportConfidence(support, best, maxTrackDistanceM),
    osmDerived: false,
    policy: "planning-support-to-resolved-track-plus-resolved-ground-no-fabrication"
  };
}

function chooseCompatibleTracks(support, rides) {
  const supportHash = support.evidence?.sourceHash;
  if (supportHash) {
    const sameHash = rides.filter((ride) => ride.evidence?.sourceHash === supportHash);
    if (sameHash.length) return sameHash;
  }
  const supportRef = support.evidence?.planningReference;
  if (supportRef) {
    const sameRef = rides.filter((ride) => ride.evidence?.planningReference === supportRef);
    if (sameRef.length) return sameRef;
  }
  const relation = support.semantics?.rideId || support.semantics?.parentRideId || support.sourceFeature?.tags?.ride_id || support.sourceFeature?.tags?.parent_ride_id;
  if (relation) {
    const linked = rides.filter((ride) => String(relation) === String(ride.sourceFeatureId || ride.id));
    if (linked.length) return linked;
  }
  return rides.filter((ride) => support.authority?.planningAuthoritative && ride.authority?.planningAuthoritative);
}

function resolvedGround(support) {
  const values = [support.vertical?.groundElevationM, support.vertical?.baseElevationM];
  for (const value of values) {
    const n = finite(value);
    if (n !== null) return n;
  }
  return null;
}

function supportConfidence(support, best, maxTrackDistanceM) {
  const supportConfidence = support.confidence?.overall ?? 0.8;
  const rideConfidence = best.ride.confidence?.overall ?? 0.8;
  const proximity = Math.max(0.35, 1 - best.lateralDistanceM / Math.max(1, maxTrackDistanceM));
  return round3(Math.min(supportConfidence, rideConfidence) * proximity);
}

function compactSupport(support) {
  return {
    supportId: support.supportId,
    status: support.status,
    reason: support.reason,
    rideId: support.rideId || null,
    footing: support.footing ? [support.footing.x, support.footing.y, support.footing.z] : null,
    connection: support.connection ? [support.connection.x, support.connection.y, support.connection.z, support.connection.measureM] : null,
    verticalHeightM: support.verticalHeightM ?? null,
    length3dM: support.length3dM ?? null,
    leanDeg: support.leanDeg ?? null,
    confidence: support.confidence ?? null
  };
}

function unresolved(support, reason, best = null, groundY = null) {
  return {
    marker: "TPMAP_PHASE34_RIDE_SUPPORT_RECONSTRUCTION_V1",
    supportId: support.id,
    status: "unresolved",
    reason,
    rideId: best?.ride?.id || null,
    footing: groundY === null ? null : { x: round3(support.geometry.centroid[0]), y: round3(groundY), z: round3(support.geometry.centroid[1]) },
    connection: best ? { x: round3(best.sample.x), y: round3(best.sample.y), z: round3(best.sample.z), measureM: round3(best.sample.measureM) } : null,
    verticalHeightM: null,
    horizontalOffsetM: null,
    length3dM: null,
    leanDeg: null,
    lateralTrackDistanceM: best ? round3(best.lateralDistanceM) : null,
    confidence: null,
    osmDerived: false,
    policy: "planning-support-to-resolved-track-plus-resolved-ground-no-fabrication"
  };
}

function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function round3(value) { return Math.round(Number(value) * 1000) / 1000; }
