// TPMAP_PHASE34_VERTICAL_EVIDENCE_ENGINE_V1
// Resolve ground -> base -> top vertical state on the Phase 33 reconstruction graph
// without guessing missing values or weakening planning authority.

const SCHEMA_VERSION = 1;
const CELL_SIZE_M = 32;
const OBSERVATION_RADIUS_M = Object.freeze({
  "building-level": 35,
  "ride-elevation": 45,
  "water-level": 30,
  "terrain-level": 28
});
const TARGET_TYPES = Object.freeze({
  "building-level": new Set(["building", "structure", "amenity", "attraction"]),
  "ride-elevation": new Set(["ride-track", "ride-support"]),
  "water-level": new Set(["water"]),
  "terrain-level": new Set(["path", "road", "surface", "terrain-detail", "bridge", "building", "ride-track", "ride-support", "water"])
});
const PRIORITY = Object.freeze({
  "planning-explicit": 100,
  "planning-ffl": 98,
  "planning-ride-elevation": 98,
  "planning-water-level": 98,
  "planning-terrain-level": 96,
  "feature-explicit": 90,
  "lidar-ground": 70,
  "terrain-sampler": 65,
  "derived-height": 55
});

export function solveParkVerticalEvidence(graph, options = {}) {
  validateInput(graph);
  const evidenceIndex = makePointIndex(graph.evidenceNodes || [], CELL_SIZE_M);
  const diagnostics = {
    schemaVersion: SCHEMA_VERSION,
    marker: "TPMAP_PHASE34_VERTICAL_EVIDENCE_ENGINE_V1",
    nodesVisited: graph.nodes.length,
    nodesResolved: 0,
    baseResolved: 0,
    topResolved: 0,
    groundResolved: 0,
    observationMatches: 0,
    conflicts: 0,
    unresolved: 0,
    byObservationType: {},
    byResolutionSource: {}
  };

  for (const node of graph.nodes) {
    const result = solveNode(node, evidenceIndex, options);
    node.vertical = result.vertical;
    Object.defineProperty(node, "verticalResolution", { enumerable: false, configurable: true, value: result.resolution });
    if (result.resolution.matchedObservation) {
      diagnostics.observationMatches += 1;
      const type = result.resolution.matchedObservation.observationType;
      diagnostics.byObservationType[type] = (diagnostics.byObservationType[type] || 0) + 1;
    }
    if (result.vertical.groundElevationM !== null) diagnostics.groundResolved += 1;
    if (result.vertical.baseElevationM !== null) diagnostics.baseResolved += 1;
    if (result.vertical.topElevationM !== null) diagnostics.topResolved += 1;
    if (result.resolution.status === "resolved") diagnostics.nodesResolved += 1;
    else diagnostics.unresolved += 1;
    diagnostics.conflicts += result.resolution.conflicts.length;
    for (const selected of result.resolution.selectedEvidence) {
      diagnostics.byResolutionSource[selected.source] = (diagnostics.byResolutionSource[selected.source] || 0) + 1;
    }
  }

  graph.verticalResolution = diagnostics;
  graph.summary = { ...(graph.summary || {}), verticalResolution: diagnostics };
  return diagnostics;
}

export function validateVerticalResolution(graph) {
  validateInput(graph);
  const diagnostics = graph.verticalResolution;
  if (!diagnostics || diagnostics.marker !== "TPMAP_PHASE34_VERTICAL_EVIDENCE_ENGINE_V1") {
    throw new Error("Phase 34 vertical resolution diagnostics are missing");
  }
  for (const node of graph.nodes) {
    const v = node.vertical || {};
    for (const key of ["groundElevationM", "baseElevationM", "topElevationM", "heightM"]) {
      if (v[key] !== null && !Number.isFinite(Number(v[key]))) throw new Error(`Phase 34 node ${node.id} has invalid ${key}`);
    }
    if (v.baseElevationM !== null && v.topElevationM !== null && v.topElevationM + 1e-6 < v.baseElevationM) {
      throw new Error(`Phase 34 node ${node.id} top elevation is below base elevation`);
    }
    if (node.verticalResolution?.selectedEvidence?.some((item) => item.osmDerived)) {
      throw new Error(`Phase 34 node ${node.id} selected OSM-derived vertical evidence`);
    }
  }
  return graph;
}

function solveNode(node, evidenceIndex, options) {
  const original = node.vertical || {};
  const candidates = collectExistingCandidates(node);
  const observation = nearestCompatibleObservation(node, evidenceIndex, options);
  if (observation) candidates.push(observationCandidate(observation));

  const ground = chooseProperty(candidates, "groundElevationM");
  const base = chooseBase(node, candidates, observation, ground);
  const height = chooseProperty(candidates, "heightM");
  let top = chooseProperty(candidates, "topElevationM");
  if (!top.selected && base.value !== null && height.value !== null) {
    top = {
      value: round3(base.value + (finite(original.minHeightM) ?? 0) + height.value),
      selected: evidenceRecord("topElevationM", "derived-height", PRIORITY["derived-height"], node, { derivedFrom: [base.selected, height.selected].filter(Boolean) }),
      conflicts: []
    };
  }

  const selectedEvidence = [ground.selected, base.selected, height.selected, top.selected].filter(Boolean);
  const conflicts = [...ground.conflicts, ...base.conflicts, ...height.conflicts, ...top.conflicts];
  const vertical = {
    ...original,
    groundElevationM: ground.value,
    baseElevationM: base.value,
    heightM: height.value,
    topElevationM: top.value,
    verification: selectedEvidence.some((item) => item.authority === "planning-data") ? "planning-resolved" : original.verification || "unknown",
    evidence: mergeEvidence(original.evidence || [], selectedEvidence)
  };

  return {
    vertical,
    resolution: {
      status: vertical.baseElevationM !== null || vertical.groundElevationM !== null || vertical.topElevationM !== null ? "resolved" : "unresolved",
      matchedObservation: observation ? compactObservation(observation) : null,
      selectedEvidence,
      conflicts
    }
  };
}

function collectExistingCandidates(node) {
  const v = node.vertical || {};
  const candidates = [];
  if (finite(v.groundElevationM) !== null) {
    const source = String(v.evidence?.find((e) => e.property === "groundElevationM")?.source || "terrain-sampler");
    candidates.push(candidate("groundElevationM", v.groundElevationM, source, source.includes("lidar") ? PRIORITY["lidar-ground"] : PRIORITY["terrain-sampler"], node));
  }
  if (finite(v.explicitElevationM) !== null) candidates.push(candidate("baseElevationM", v.explicitElevationM, "feature-explicit", PRIORITY["feature-explicit"], node));
  if (finite(v.baseElevationM) !== null && finite(v.explicitElevationM) === null) candidates.push(candidate("baseElevationM", v.baseElevationM, "terrain-sampler", PRIORITY["terrain-sampler"], node));
  if (finite(v.heightM) !== null) candidates.push(candidate("heightM", v.heightM, "feature-height", PRIORITY["feature-explicit"], node));
  if (finite(v.topElevationM) !== null) candidates.push(candidate("topElevationM", v.topElevationM, "feature-derived-top", PRIORITY["feature-explicit"], node));

  for (const item of v.evidence || []) {
    const property = String(item.property || "");
    const value = finite(item.value);
    if (value === null) continue;
    if (property === "finishedFloorLevelM") candidates.push(candidate("baseElevationM", value, "planning-ffl", PRIORITY["planning-ffl"], node, { authority: "planning-data" }));
    if (property === "planningElevationM") candidates.push(candidate("baseElevationM", value, "planning-explicit", PRIORITY["planning-explicit"], node, { authority: "planning-data" }));
  }
  return candidates;
}

function observationCandidate(observation) {
  const type = observation.observationType;
  const value = finite(observation.vertical?.explicitElevationM) ?? finite(observation.vertical?.baseElevationM) ?? finite(observation.vertical?.groundElevationM);
  if (value === null) return candidate("baseElevationM", null, "planning-observation", 0, observation);
  const source = type === "building-level" ? "planning-ffl"
    : type === "ride-elevation" ? "planning-ride-elevation"
      : type === "water-level" ? "planning-water-level"
        : "planning-terrain-level";
  const property = type === "terrain-level" ? "groundElevationM" : "baseElevationM";
  return candidate(property, value, source, PRIORITY[source], observation, {
    authority: "planning-data",
    observationId: observation.id,
    observationType: type,
    confidence: observation.confidence?.overall ?? null,
    distanceM: observation._distanceM
  });
}

function chooseBase(node, candidates, observation, ground) {
  const chosen = chooseProperty(candidates, "baseElevationM");
  if (chosen.selected) return chosen;
  if (["path", "road", "surface", "terrain-detail", "barrier", "vegetation"].includes(node.type) && ground.value !== null) {
    return { value: ground.value, selected: evidenceRecord("baseElevationM", "ground-associated", PRIORITY["terrain-sampler"] - 1, node, { derivedFrom: ground.selected }), conflicts: [] };
  }
  if (node.type === "water" && observation?.observationType === "water-level") return chosen;
  return chosen;
}

function chooseProperty(candidates, property) {
  const values = candidates.filter((c) => c.property === property && c.value !== null).sort(compareCandidate);
  if (!values.length) return { value: null, selected: null, conflicts: [] };
  const selected = values[0];
  const conflicts = [];
  for (const other of values.slice(1)) {
    const delta = Math.abs(other.value - selected.value);
    if (delta > conflictTolerance(property)) conflicts.push({ property, selected: selected.value, rejected: other.value, deltaM: round3(delta), selectedSource: selected.source, rejectedSource: other.source });
  }
  return { value: round3(selected.value), selected: evidenceRecord(property, selected.source, selected.priority, selected.node, selected), conflicts };
}

function compareCandidate(a, b) {
  return b.priority - a.priority
    || (b.confidence ?? -1) - (a.confidence ?? -1)
    || (a.distanceM ?? Number.POSITIVE_INFINITY) - (b.distanceM ?? Number.POSITIVE_INFINITY)
    || String(a.source).localeCompare(String(b.source));
}

function nearestCompatibleObservation(node, index, options) {
  const centroid = node.geometry?.centroid;
  if (!centroid) return null;
  const candidates = nearbyPoints(index, centroid, 50);
  const eligible = [];
  for (const observation of candidates) {
    if (!TARGET_TYPES[observation.observationType]?.has(node.type)) continue;
    const radius = Number(options[`${observation.observationType}RadiusM`]) || OBSERVATION_RADIUS_M[observation.observationType];
    const distanceM = distance(centroid, observation.geometry.centroid);
    if (distanceM > radius) continue;
    eligible.push({ observation, distanceM, score: observationScore(node, observation, distanceM, radius) });
  }
  eligible.sort((a, b) => b.score - a.score || a.distanceM - b.distanceM || a.observation.id.localeCompare(b.observation.id));
  if (!eligible.length) return null;
  const best = eligible[0];
  Object.defineProperty(best.observation, "_distanceM", { enumerable: false, configurable: true, value: round3(best.distanceM) });
  return best.observation;
}

function observationScore(node, observation, distanceM, radius) {
  let score = 1 - distanceM / Math.max(1, radius);
  const nodeRef = node.evidence?.planningReference;
  const observationRef = observation.evidence?.planningReference;
  if (nodeRef && observationRef && nodeRef === observationRef) score += 1.25;
  const nodeHash = node.evidence?.sourceHash;
  const observationHash = observation.evidence?.sourceHash;
  if (nodeHash && observationHash && nodeHash === observationHash) score += 1.5;
  if (node.authority?.planningAuthoritative && observation.authority?.planningAuthoritative) score += 0.25;
  return score + (observation.confidence?.overall ?? 0) * 0.1;
}

function makePointIndex(nodes, cellSize) {
  const cells = new Map();
  for (const node of nodes) {
    const [x, z] = node.geometry?.centroid || [];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const key = `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
    const bucket = cells.get(key) || [];
    bucket.push(node);
    cells.set(key, bucket);
  }
  return { cells, cellSize };
}

function nearbyPoints(index, point, radius) {
  const [x, z] = point;
  const minX = Math.floor((x - radius) / index.cellSize), maxX = Math.floor((x + radius) / index.cellSize);
  const minZ = Math.floor((z - radius) / index.cellSize), maxZ = Math.floor((z + radius) / index.cellSize);
  const out = [];
  for (let cx = minX; cx <= maxX; cx += 1) for (let cz = minZ; cz <= maxZ; cz += 1) out.push(...(index.cells.get(`${cx}:${cz}`) || []));
  return out;
}

function candidate(property, value, source, priority, node, extra = {}) {
  return { property, value: finite(value), source, priority: Number(priority) || 0, node, confidence: extra.confidence ?? node?.confidence?.vertical ?? node?.confidence?.overall ?? null, ...extra };
}

function evidenceRecord(property, source, priority, node, extra = {}) {
  return {
    property,
    value: extra.value ?? null,
    source,
    priority,
    authority: extra.authority || (String(source).startsWith("planning-") ? "planning-data" : node?.authority?.geometry || "derived"),
    observationId: extra.observationId || null,
    observationType: extra.observationType || null,
    distanceM: extra.distanceM ?? null,
    confidence: extra.confidence ?? node?.confidence?.overall ?? null,
    planningReference: node?.evidence?.planningReference || null,
    sourceHash: node?.evidence?.sourceHash || null,
    osmDerived: Boolean(node?.authority?.osmDerived),
    derivedFrom: extra.derivedFrom || null
  };
}

function compactObservation(node) {
  return { id: node.id, observationType: node.observationType, distanceM: node._distanceM ?? null, planningReference: node.evidence?.planningReference || null, sourceHash: node.evidence?.sourceHash || null };
}

function mergeEvidence(existing, selected) {
  const result = [...existing];
  const seen = new Set(result.map((item) => `${item.property}:${item.value}:${item.source}`));
  for (const item of selected) {
    const value = item.value ?? null;
    const key = `${item.property}:${value}:${item.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ property: item.property, value, source: item.source, confidence: item.confidence, authority: item.authority, observationId: item.observationId || undefined });
  }
  return result;
}

function conflictTolerance(property) {
  if (property === "heightM") return 0.75;
  return 0.35;
}

function distance(a, b) {
  return Math.hypot(Number(a[0]) - Number(b[0]), Number(a[1]) - Number(b[1]));
}

function finite(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function validateInput(graph) {
  if (graph?.marker !== "TPMAP_PHASE33_PARK_RECONSTRUCTION_GRAPH_V1" || !Array.isArray(graph.nodes) || !Array.isArray(graph.evidenceNodes)) {
    throw new Error("Phase 34 requires a valid Phase 33 reconstruction graph");
  }
  if (graph.authorityMode === "planning-only") {
    for (const node of [...graph.nodes, ...graph.evidenceNodes]) if (node.authority?.osmDerived) throw new Error(`Phase 34 rejected OSM-derived vertical input ${node.id}`);
  }
}