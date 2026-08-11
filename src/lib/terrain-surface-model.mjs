// TPMAP_PHASE34_TERRAIN_SURFACE_MODEL_V1
// Separate bare-earth DTM, object/top DSM and derived above-ground height.
// Missing channels remain unresolved; a generic terrain sampler is never reused as both DTM and DSM.

const OBJECT_TOP_TYPES = new Set(["building", "structure", "vegetation", "ride-track", "ride-support", "bridge", "attraction", "amenity"]);

export function buildTerrainSurfaceModel(graph, sources = null, options = {}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error("Phase 34 terrain surface model requires reconstruction graph");
  const elevation = sources?.elevation || sources?.lidar || null;
  const samplers = resolveSamplers(elevation);
  const diagnostics = {
    marker: "TPMAP_PHASE34_TERRAIN_SURFACE_MODEL_V1",
    nodesVisited: graph.nodes.length,
    dtmResolved: 0,
    dsmResolved: 0,
    heightDerived: 0,
    unresolvedDtm: 0,
    unresolvedDsm: 0,
    invalidSurfacePairs: 0,
    sourceCapabilities: {
      dtmSampler: Boolean(samplers.dtm),
      dsmSampler: Boolean(samplers.dsm),
      genericSampler: Boolean(samplers.generic)
    }
  };

  for (const node of graph.nodes) {
    const surface = solveNodeSurface(node, samplers, diagnostics, options);
    Object.defineProperty(node, "terrainSurface", { enumerable: false, configurable: true, value: surface });
    if (surface.dtmElevationM !== null) {
      diagnostics.dtmResolved += 1;
      node.vertical = { ...(node.vertical || {}), groundElevationM: surface.dtmElevationM };
    } else diagnostics.unresolvedDtm += 1;
    if (surface.dsmElevationM !== null) diagnostics.dsmResolved += 1;
    else diagnostics.unresolvedDsm += 1;
    if (surface.aboveGroundHeightM !== null) diagnostics.heightDerived += 1;
  }

  graph.terrainSurfaceModel = diagnostics;
  graph.summary = { ...(graph.summary || {}), terrainSurfaceModel: diagnostics };
  return diagnostics;
}

export function validateTerrainSurfaceModel(graph) {
  const diag = graph?.summary?.terrainSurfaceModel;
  if (!diag || diag.marker !== "TPMAP_PHASE34_TERRAIN_SURFACE_MODEL_V1") throw new Error("Phase 34 terrain surface diagnostics missing");
  for (const node of graph.nodes || []) {
    const surface = node.terrainSurface;
    if (!surface) throw new Error(`Phase 34 node ${node.id} missing terrain surface state`);
    for (const key of ["dtmElevationM", "dsmElevationM", "aboveGroundHeightM"]) {
      if (surface[key] !== null && !Number.isFinite(surface[key])) throw new Error(`Phase 34 node ${node.id} invalid ${key}`);
    }
    if (surface.dtmElevationM !== null && surface.dsmElevationM !== null && surface.dsmElevationM + 0.05 < surface.dtmElevationM) {
      throw new Error(`Phase 34 node ${node.id} DSM below DTM`);
    }
    if (surface.dtmEvidence?.osmDerived || surface.dsmEvidence?.osmDerived) throw new Error(`Phase 34 node ${node.id} used OSM-derived surface evidence`);
  }
  return graph;
}

function solveNodeSurface(node, samplers, diagnostics, options) {
  if (graphOsmDerived(node)) throw new Error(`Phase 34 terrain surface rejected OSM-derived node ${node.id}`);
  const [x, z] = node.geometry?.centroid || [];
  const existingGround = finite(node.vertical?.groundElevationM);
  let dtm = existingGround;
  let dtmEvidence = existingGround !== null ? evidence("existing-ground", node, existingGround) : null;

  if (Number.isFinite(x) && Number.isFinite(z) && samplers.dtm) {
    const sampled = finite(samplers.dtm(x, z));
    if (sampled !== null) {
      dtm = sampled;
      dtmEvidence = evidence(samplers.dtmSource, node, sampled);
    }
  } else if (dtm === null && Number.isFinite(x) && Number.isFinite(z) && samplers.generic) {
    // Generic sampleLocal is accepted only as ground/DTM-compatible evidence.
    const sampled = finite(samplers.generic(x, z));
    if (sampled !== null) {
      dtm = sampled;
      dtmEvidence = evidence(samplers.genericSource, node, sampled);
    }
  }

  let dsm = explicitDsm(node);
  let dsmEvidence = dsm !== null ? evidence("explicit-object-top", node, dsm) : null;
  if (OBJECT_TOP_TYPES.has(node.type) && Number.isFinite(x) && Number.isFinite(z) && samplers.dsm) {
    const sampled = finite(samplers.dsm(x, z));
    if (sampled !== null) {
      dsm = sampled;
      dsmEvidence = evidence(samplers.dsmSource, node, sampled);
    }
  }

  if (dtm !== null && dsm !== null && dsm + 0.05 < dtm) {
    diagnostics.invalidSurfacePairs += 1;
    dsm = null;
    dsmEvidence = null;
  }

  const aboveGroundHeightM = dtm !== null && dsm !== null ? round3(Math.max(0, dsm - dtm)) : null;
  return {
    marker: "TPMAP_PHASE34_TERRAIN_SURFACE_MODEL_V1",
    dtmElevationM: dtm === null ? null : round3(dtm),
    dsmElevationM: dsm === null ? null : round3(dsm),
    aboveGroundHeightM,
    dtmEvidence,
    dsmEvidence,
    attachmentSurface: attachmentSurface(node.type),
    policy: "dtm-ground-and-dsm-object-top-kept-separate-no-channel-duplication"
  };
}

function resolveSamplers(elevation) {
  const bind = (name) => typeof elevation?.[name] === "function" ? elevation[name].bind(elevation) : null;
  return {
    dtm: bind("sampleDtmLocal") || bind("sampleGroundLocal") || bind("sampleTerrainLocal"),
    dsm: bind("sampleDsmLocal") || bind("sampleSurfaceLocal") || bind("sampleObjectTopLocal"),
    generic: bind("sampleLocal"),
    dtmSource: elevation?.dtmSourceKind || elevation?.groundSourceKind || "lidar-dtm",
    dsmSource: elevation?.dsmSourceKind || elevation?.surfaceSourceKind || "lidar-dsm",
    genericSource: elevation?.sourceKind || elevation?.provider || "terrain-elevation-sampler"
  };
}

function explicitDsm(node) {
  const source = node.sourceFeature || {};
  const tags = source.tags || {};
  const candidates = [
    source.vertical?.dsmElevationM,
    source.vertical?.surfaceElevationM,
    tags.dsm_elevation_m,
    tags.roof_elevation_m,
    tags.canopy_top_elevation_m,
    node.vertical?.topElevationM
  ];
  for (const value of candidates) {
    const n = finite(value);
    if (n !== null) return n;
  }
  return null;
}

function attachmentSurface(type) {
  if (["path", "road", "surface", "terrain-detail", "barrier", "ride-support"].includes(type)) return "dtm-ground";
  if (["building", "structure", "vegetation", "attraction", "amenity"].includes(type)) return "dtm-base+dsm-top";
  if (type === "water") return "independent-water-surface-over-dtm-bed";
  if (type === "ride-track" || type === "bridge") return "independent-elevated-object-over-dtm";
  return "dtm-ground";
}

function evidence(source, node, value) {
  return {
    source,
    value: round3(value),
    authority: String(source).includes("planning") ? "planning-data" : "independent-elevation",
    planningReference: node.evidence?.planningReference || null,
    sourceHash: node.evidence?.sourceHash || null,
    osmDerived: false
  };
}
function graphOsmDerived(node) { return Boolean(node.authority?.osmDerived); }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function round3(value) { return Math.round(Number(value) * 1000) / 1000; }
