// TPMAP_PHASE34_RIDE_ATTACHMENT_RECONSTRUCTION_V1
// Retain detected planning geometry for ride attachments without inventing offsets,
// mirrored sides, structural members, banking, or cross ties.

const DEFAULT_MAX_TRACK_DISTANCE_M = 12;
const TRACK_RELATIVE_TYPES = new Set(["catwalk", "maintenance_platform", "station_platform", "handrail"]);
const TERRAIN_FOLLOWING_TYPES = new Set(["evacuation_stair", "fence", "access_path"]);
const SUPPORTED_GEOMETRIES = new Set(["LineString", "MultiLineString", "Polygon", "MultiPolygon"]);

export function reconstructRideAttachments(graph, options = {}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error("Phase 34 ride attachment reconstruction requires reconstruction graph");
  const diagnostics = {
    marker: "TPMAP_PHASE34_RIDE_ATTACHMENT_RECONSTRUCTION_V1",
    attachmentsVisited: 0,
    attachmentsResolved: 0,
    attachmentsWithheld: 0,
    trackRelativeResolved: 0,
    terrainFollowingResolved: 0,
    explicitElevationResolved: 0,
    rejectedType: 0,
    rejectedGeometry: 0,
    rejectedTrack: 0,
    rejectedDistance: 0,
    types: {}
  };
  const rides = graph.nodes.filter((node) => node.type === "ride-track");
  const compact = [];

  for (const attachment of graph.nodes) {
    if (attachment.type !== "ride-attachment") continue;
    diagnostics.attachmentsVisited += 1;
    const reconstruction = solveAttachment(attachment, rides, options, diagnostics);
    Object.defineProperty(attachment, "rideAttachmentReconstruction", {
      enumerable: false,
      configurable: true,
      value: reconstruction
    });
    compact.push(compactAttachment(reconstruction));
    diagnostics.types[reconstruction.attachmentType] = (diagnostics.types[reconstruction.attachmentType] || 0) + 1;
    if (reconstruction.status === "resolved") diagnostics.attachmentsResolved += 1;
    else diagnostics.attachmentsWithheld += 1;
  }

  graph.rideAttachmentReconstructions = compact;
  graph.summary = { ...(graph.summary || {}), rideAttachmentReconstruction: diagnostics };
  return diagnostics;
}

export function validateRideAttachmentReconstructions(graph) {
  const diagnostics = graph?.summary?.rideAttachmentReconstruction;
  if (!diagnostics || diagnostics.marker !== "TPMAP_PHASE34_RIDE_ATTACHMENT_RECONSTRUCTION_V1") {
    throw new Error("Phase 34 ride attachment reconstruction diagnostics missing");
  }
  for (const node of graph.nodes || []) {
    if (node.type !== "ride-attachment") continue;
    const reconstruction = node.rideAttachmentReconstruction;
    if (!reconstruction) throw new Error(`Phase 34 ride attachment ${node.id} lacks reconstruction state`);
    if (reconstruction.osmDerived) throw new Error(`Phase 34 ride attachment ${node.id} used OSM-derived evidence`);
    if (reconstruction.status === "resolved") {
      if (!SUPPORTED_GEOMETRIES.has(node.geometry?.local?.type)) {
        throw new Error(`Phase 34 ride attachment ${node.id} resolved unsupported geometry`);
      }
      if (reconstruction.verticalMode === "track-relative" && !reconstruction.rideSamples?.length) {
        throw new Error(`Phase 34 ride attachment ${node.id} lacks resolved ride samples`);
      }
      if (reconstruction.verticalMode === "explicit-elevation" && !Number.isFinite(reconstruction.explicitElevationM)) {
        throw new Error(`Phase 34 ride attachment ${node.id} lacks explicit elevation`);
      }
    }
  }
  return graph;
}

function solveAttachment(attachment, rides, options, diagnostics) {
  if (attachment.authority?.osmDerived) throw new Error(`Phase 34 ride attachment reconstruction rejected OSM-derived feature ${attachment.id}`);
  const attachmentType = normalizedType(attachment);
  const geometryType = attachment.geometry?.local?.type || null;
  const base = {
    marker: "TPMAP_PHASE34_RIDE_ATTACHMENT_RECONSTRUCTION_V1",
    attachmentId: attachment.id,
    attachmentType,
    geometryType,
    geometrySource: "detected-planning-geometry",
    side: attachment.semantics?.rideAttachmentSide || null,
    osmDerived: false,
    policy: "detected-geometry-only-no-offset-mirroring-banking-cross-ties-or-invented-hardware"
  };
  if (attachmentType === "attachment") {
    diagnostics.rejectedType += 1;
    return { ...base, status: "withheld", reason: "unsupported-or-missing-attachment-type", verticalMode: null, rideId: null, explicitElevationM: null, lateralTrackDistanceM: null, confidence: null };
  }
  if (!SUPPORTED_GEOMETRIES.has(geometryType)) {
    diagnostics.rejectedGeometry += 1;
    return { ...base, status: "withheld", reason: "attachment-requires-detected-line-or-polygon", verticalMode: null, rideId: null, explicitElevationM: null, lateralTrackDistanceM: null, confidence: null };
  }

  const explicitElevationM = explicitElevation(attachment);
  if (explicitElevationM !== null) {
    const explicitRide = chooseCompatibleRides(attachment, rides)[0] || null;
    diagnostics.explicitElevationResolved += 1;
    return resolved(base, {
      verticalMode: "explicit-elevation",
      rideId: explicitRide?.id || null,
      explicitElevationM,
      lateralTrackDistanceM: null,
      confidence: attachment.confidence?.overall ?? attachment.confidence?.vertical ?? 0.8
    });
  }

  const requestedMode = String(attachment.semantics?.rideAttachmentVerticalMode || "").toLowerCase();
  const verticalMode = requestedMode === "track-relative" || requestedMode === "terrain-following"
    ? requestedMode
    : TRACK_RELATIVE_TYPES.has(attachmentType) ? "track-relative" : "terrain-following";
  const compatibleRides = chooseCompatibleRides(attachment, rides);
  const maxTrackDistanceM = finite(options.rideAttachmentMaxTrackDistanceM) ?? DEFAULT_MAX_TRACK_DISTANCE_M;
  const association = closestRide(attachment, compatibleRides, maxTrackDistanceM);

  if (verticalMode === "track-relative") {
    if (!association) {
      diagnostics.rejectedTrack += 1;
      diagnostics.rejectedDistance += compatibleRides.length ? 1 : 0;
      return { ...base, status: "withheld", reason: compatibleRides.length ? "no-resolved-track-within-distance" : "no-compatible-resolved-ride", verticalMode, rideId: null, explicitElevationM: null, lateralTrackDistanceM: null, confidence: null, maxTrackDistanceM };
    }
    const reconstruction = resolved(base, {
      verticalMode,
      rideId: association.ride.id,
      explicitElevationM: null,
      lateralTrackDistanceM: round3(association.distanceM),
      maxTrackDistanceM,
      confidence: attachmentConfidence(attachment, association, maxTrackDistanceM)
    });
    Object.defineProperty(reconstruction, "rideSamples", {
      enumerable: false,
      configurable: true,
      value: association.samples
    });
    diagnostics.trackRelativeResolved += 1;
    return reconstruction;
  }

  diagnostics.terrainFollowingResolved += 1;
  return resolved(base, {
    verticalMode,
    rideId: association?.ride?.id || null,
    explicitElevationM: null,
    lateralTrackDistanceM: association ? round3(association.distanceM) : null,
    maxTrackDistanceM,
    confidence: attachment.confidence?.overall ?? 0.8
  });
}

function resolved(base, values) {
  return { ...base, status: "resolved", reason: null, ...values };
}

function normalizedType(attachment) {
  const value = String(
    attachment.semantics?.rideAttachmentType ||
    attachment.sourceFeature?.tags?.ride_attachment ||
    attachment.semantics?.planningClass ||
    attachment.sourceFeature?.subtype ||
    "attachment"
  ).toLowerCase().replaceAll("-", "_").replace(/^ride_/, "");
  return TRACK_RELATIVE_TYPES.has(value) || TERRAIN_FOLLOWING_TYPES.has(value) ? value : "attachment";
}

function explicitElevation(attachment) {
  return finite(attachment.vertical?.explicitElevationM)
    ?? finite(attachment.sourceFeature?.tags?.elevation_m);
}

function chooseCompatibleRides(attachment, rides) {
  const relation = attachment.semantics?.rideId || attachment.semantics?.parentRideId;
  if (relation) {
    const linked = rides.filter((ride) => [ride.id, ride.sourceFeatureId, ride.name, ride.sourceFeature?.tags?.ride_id]
      .filter(Boolean).some((value) => String(value) === String(relation)));
    if (linked.length) return linked;
  }
  const hash = attachment.evidence?.sourceHash;
  if (hash) {
    const sameHash = rides.filter((ride) => ride.evidence?.sourceHash === hash);
    if (sameHash.length) return sameHash;
  }
  const reference = attachment.evidence?.planningReference;
  if (reference) {
    const sameReference = rides.filter((ride) => ride.evidence?.planningReference === reference);
    if (sameReference.length) return sameReference;
  }
  return rides.filter((ride) => attachment.authority?.planningAuthoritative && ride.authority?.planningAuthoritative);
}

function closestRide(attachment, rides, maxTrackDistanceM) {
  let best = null;
  for (const ride of rides) {
    const samples = resolvedRideSamples(ride);
    for (const sample of samples) {
      const distanceM = distanceToGeometry([sample.x, sample.z], attachment.geometry.local);
      if (!Number.isFinite(distanceM) || distanceM > maxTrackDistanceM) continue;
      if (!best || distanceM < best.distanceM || (distanceM === best.distanceM && ride.id.localeCompare(best.ride.id) < 0)) {
        best = { ride, samples, distanceM };
      }
    }
  }
  return best;
}

function resolvedRideSamples(ride) {
  const graphSamples = (ride.geometry3d?.samples || [])
    .filter((sample) => sample.resolved && [sample.x, sample.y, sample.z].every(Number.isFinite))
    .map((sample) => ({ x: sample.x, y: sample.y, z: sample.z, source: sample.source || "planning-vertical-profile" }));
  const profileSamples = (ride.sourceFeature?.rideProfile?.parts || []).flat()
    .filter((sample) => [sample.x, sample.elevationM, sample.z].every(Number.isFinite))
    .map((sample) => ({ x: sample.x, y: sample.elevationM, z: sample.z, source: sample.evidence || "ride-profile" }));
  return profileSamples.length > graphSamples.length ? profileSamples : graphSamples;
}

function distanceToGeometry(point, geometry) {
  for (const polygon of geometryPolygons(geometry)) {
    if (pointInRing(point, polygon[0]) && !polygon.slice(1).some((ring) => pointInRing(point, ring))) return 0;
  }
  const lines = geometryLines(geometry);
  let best = Infinity;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      best = Math.min(best, pointSegmentDistance(point, line[index - 1], line[index]));
    }
  }
  return best;
}

function geometryPolygons(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index], b = ring[previous];
    const crosses = (Number(a[1]) > point[1]) !== (Number(b[1]) > point[1]);
    if (crosses && point[0] < (Number(b[0]) - Number(a[0])) * (point[1] - Number(a[1])) /
      ((Number(b[1]) - Number(a[1])) || 1e-12) + Number(a[0])) inside = !inside;
  }
  return inside;
}

function geometryLines(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  if (geometry?.type === "Polygon") return geometry.coordinates;
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

function pointSegmentDistance(point, start, end) {
  const dx = Number(end[0]) - Number(start[0]), dz = Number(end[1]) - Number(start[1]);
  const length2 = dx * dx + dz * dz;
  if (!length2) return Math.hypot(point[0] - Number(start[0]), point[1] - Number(start[1]));
  const t = Math.max(0, Math.min(1, ((point[0] - Number(start[0])) * dx + (point[1] - Number(start[1])) * dz) / length2));
  return Math.hypot(point[0] - (Number(start[0]) + t * dx), point[1] - (Number(start[1]) + t * dz));
}

function attachmentConfidence(attachment, association, maxTrackDistanceM) {
  const attachmentValue = attachment.confidence?.overall ?? 0.8;
  const rideValue = association.ride.confidence?.overall ?? 0.8;
  const proximity = Math.max(0.35, 1 - association.distanceM / Math.max(1, maxTrackDistanceM));
  return round3(Math.min(attachmentValue, rideValue) * proximity);
}

function compactAttachment(reconstruction) {
  return {
    attachmentId: reconstruction.attachmentId,
    attachmentType: reconstruction.attachmentType,
    status: reconstruction.status,
    reason: reconstruction.reason,
    geometryType: reconstruction.geometryType,
    verticalMode: reconstruction.verticalMode,
    rideId: reconstruction.rideId,
    explicitElevationM: reconstruction.explicitElevationM,
    lateralTrackDistanceM: reconstruction.lateralTrackDistanceM,
    confidence: reconstruction.confidence
  };
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function round3(value) { return Math.round(Number(value) * 1000) / 1000; }
