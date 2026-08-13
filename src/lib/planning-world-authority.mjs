// TPMAP_PHASE30D_PLANNING_ONLY_WORLD_AUTHORITY

import { coverageLocalBounds } from "./park-profile.mjs";

const PLANNING_ONLY = "planning-only";
const INDEPENDENT_WORLD_KINDS = new Set(["vegetation", "water", "terrain_detail"]);
const POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const DRAWING_METADATA = /\b(?:drawing\s*(?:no|number)|revision|drawn\s+by|checked\s+by|approved\s+by|client|architect|consultant|project\s+title|sheet\s+(?:no|number|size)|telephone|phone|email|www\.)\b/i;

export function applyPlanningWorldAuthority(features, options = {}) {
  const mode = String(options.planningWorldAuthority || "fixture").toLowerCase();
  const evidence = {
    schemaVersion: 1,
    mode,
    osmReferenceOnly: mode === PLANNING_ONLY,
    status: mode === PLANNING_ONLY ? "planning-source-of-truth" : "legacy-map-fusion",
    featuresBefore: features.length,
    featuresAfter: features.length,
    planningFeaturesRetained: 0,
    independentFeaturesRetained: 0,
    osmFeaturesRemoved: 0,
    overtureFeaturesRemoved: 0,
    otherOsmDerivedFeaturesRemoved: 0,
    nonPlanningGeometryRemoved: 0,
    explicitlyExcludedFeaturesRemoved: 0,
    planningSpatialOutliersRemoved: 0,
    planningSpatialOutlierReasons: {},
    zeroOsmWorldFeatures: false
  };
  if (mode !== PLANNING_ONLY) return evidence;

  const retained = [];
  for (const feature of features) {
    if (excludedFromWorld(feature)) {
      evidence.explicitlyExcludedFeaturesRemoved += 1;
      continue;
    }
    const osmKind = osmDerivation(feature);
    if (osmKind) {
      if (osmKind === "openstreetmap") evidence.osmFeaturesRemoved += 1;
      else if (osmKind === "overture") evidence.overtureFeaturesRemoved += 1;
      else evidence.otherOsmDerivedFeaturesRemoved += 1;
      continue;
    }
    discardInheritedOsmVerticalEvidence(feature);
    if (isPlanningWorldFeature(feature)) {
      const spatialOutlier = automaticPlanningSpatialOutlier(feature, options);
      if (spatialOutlier) {
        evidence.planningSpatialOutliersRemoved += 1;
        evidence.planningSpatialOutlierReasons[spatialOutlier] =
          (evidence.planningSpatialOutlierReasons[spatialOutlier] || 0) + 1;
        continue;
      }
      evidence.planningFeaturesRetained += 1;
    } else if (INDEPENDENT_WORLD_KINDS.has(feature.kind)) {
      evidence.independentFeaturesRetained += 1;
    } else {
      evidence.nonPlanningGeometryRemoved += 1;
      continue;
    }
    retained.push(feature);
  }
  features.splice(0, features.length, ...retained);
  evidence.featuresAfter = features.length;
  evidence.zeroOsmWorldFeatures = !features.some(osmDerivation);
  if (!evidence.zeroOsmWorldFeatures) throw new Error("Planning-only world authority invariant failed: OSM-derived world features remain");
  return evidence;
}

function excludedFromWorld(feature) {
  const tags = feature?.tags || {};
  if (tags.planning_exclude_from_world === true || tags.render_in_world === false) return true;
  const semantic = String(tags.semantic_class || tags.planning_feature_class || feature?.subtype || "").toLowerCase();
  const state = String(tags.planning_feature_state || tags.lifecycle || "").toLowerCase();
  const colour = String(tags.stroke || tags.colour || tags.color || "").toLowerCase();
  return semantic.includes("construction-fence") || (
    (tags.temporary === true || state.includes("temporary")) &&
    (semantic.includes("fence") || tags.barrier === "fence") &&
    (colour.includes("red") || colour === "#ff0000" || colour === "#f00")
  );
}

function automaticPlanningSpatialOutlier(feature, options) {
  const tags = feature?.tags || {};
  if (tags.planning_auto_extracted !== true) return null;
  if (tags.planning_spatial_registration_verified !== true) return "unverified-drawing-registration";
  const label = String(tags.planning_semantic_label || feature?.name || "").replace(/\s+/g, " ").trim();
  if (POSTCODE.test(label)) return "title-block-postcode-label";
  if (DRAWING_METADATA.test(label)) return "drawing-metadata-label";
  if (/\b(?:road|street|lane|avenue|drive|close|court|house)\b/i.test(label) && /[,\d]/.test(label) && label.length > 18) {
    return "title-block-address-label";
  }

  const bounds = boundsOf([feature.localGeometry]);
  if (!bounds) return "invalid-local-geometry";
  const coverage = options.parkProfile?.worldCoverage;
  if (coverage && !boundsInside(bounds, coverageLocalBounds(coverage))) return "outside-configured-park-coverage";
  const spanM = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  if (["building", "structure"].includes(feature.kind) && spanM > 250) return "implausible-building-span";
  if (feature.kind === "ride_track" && /\b(?:max(?:imum)?\s+dimensions?|envelope|limit of deviation|clearance)\b/i.test(label)) {
    return "ride-envelope-not-track-centreline";
  }
  return null;
}

export function planningWorldBoundary(features, parkName, options = {}) {
  const planning = features.filter(isPlanningWorldFeature);
  if (!planning.length) {
    throw new Error("Planning-only world authority requires at least one accepted planning feature; refusing an OSM-backed world fallback");
  }
  const planningGeographic = boundsOf(planning.map((feature) => feature.geometry));
  const planningLocal = boundsOf(planning.map((feature) => feature.localGeometry));
  if (!planningGeographic || !planningLocal) {
    throw new Error("Planning-only world authority could not derive a planning coverage boundary");
  }
  const coverage = options.parkProfile?.worldCoverage || null;
  const local = coverage ? coverageLocalBounds(coverage) : planningLocal;
  const localGeometry = boundsPolygon(local, coverage ? 0 : 8);
  const geometry = coverage && options.projector
    ? mapGeometry(localGeometry, options.projector.inverse)
    : boundsPolygon(planningGeographic, 0.0001);
  return {
    id: coverage ? "profile:validated-world-coverage" : "derived:planning-world-boundary",
    name: parkName,
    kind: "park_boundary",
    subtype: coverage ? "validated-park-coverage" : "planning-coverage-envelope",
    geometry,
    localGeometry,
    tags: {
      planning_boundary: coverage ? "profile-world-coverage-contract" : "coverage-envelope",
      expected_world_chunks: coverage?.expectedChunks || null,
      render_in_world: false
    },
    vertical: { heightM: null, elevationM: null, explicit: false },
    source: {
      provider: coverage?.authority || "Accepted planning data",
      dataset: coverage ? "park-profile-world-coverage-contract" : "planning-world-coverage"
    },
    verification: { plan: "planning-source-of-truth", vertical: "not-applicable" },
    verified: true,
    fallback: false
  };
}

function boundsInside(inner, outer) {
  return inner.minX >= outer.minX && inner.minZ >= outer.minZ &&
    inner.maxX <= outer.maxX && inner.maxZ <= outer.maxZ;
}

function mapGeometry(geometry, mapper) {
  const mapCoordinates = (value) => {
    if (Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      return mapper([value[0], value[1]]);
    }
    return Array.isArray(value) ? value.map(mapCoordinates) : value;
  };
  return { ...geometry, coordinates: mapCoordinates(geometry.coordinates) };
}

export function isPlanningWorldFeature(feature) {
  const tags = feature?.tags || {};
  const source = feature?.source || {};
  const provider = String(source.provider || "").toLowerCase();
  const dataset = String(source.dataset || tags.source_dataset || "").toLowerCase();
  const adapter = String(source.adapter || tags.source_adapter || "").toLowerCase();
  const mergePolicy = String(tags.merge_policy || "").toLowerCase();
  return provider.includes("planning") || adapter.includes("planning") || dataset.includes("planning") ||
    mergePolicy.startsWith("planning-") || tags.planning_authority === true || tags.planning_authoritative === true ||
    Boolean(tags.planning_geometry_role || tags.planning_reference || tags.planning_vector_role);
}

function osmDerivation(feature) {
  const source = feature?.source || {};
  const provider = String(source.provider || "").toLowerCase();
  const id = String(feature?.id || "").toLowerCase();
  if (provider === "openstreetmap" || provider.includes("openstreetmap") || id.startsWith("osm:")) return "openstreetmap";
  if (provider.includes("overture") || id.startsWith("overture:")) return "overture";
  const upstream = JSON.stringify(source.upstreamSources || source.sources || "").toLowerCase();
  if (upstream.includes("openstreetmap") || upstream.includes('"osm"')) return "other-osm-derived";
  return null;
}

function discardInheritedOsmVerticalEvidence(feature) {
  const vertical = feature?.vertical;
  if (!vertical) return;
  const heightSource = String(vertical.heightSource || "").toLowerCase();
  if (heightSource.includes("osm") || heightSource.includes("retained-during-planning-override")) {
    vertical.heightM = null;
    vertical.heightSource = null;
    vertical.heightConfidence = null;
  }
  const elevationSource = String(vertical.elevationSource || "").toLowerCase();
  if (elevationSource.includes("osm")) {
    vertical.elevationM = null;
    vertical.elevationSource = null;
  }
}

function boundsOf(geometries) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const geometry of geometries) visitCoordinates(geometry?.coordinates, (x, z) => {
    minX = Math.min(minX, x); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  });
  return [minX, minZ, maxX, maxZ].every(Number.isFinite) ? { minX, minZ, maxX, maxZ } : null;
}

function visitCoordinates(value, visit) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    visit(Number(value[0]), Number(value[1]));
    return;
  }
  for (const child of value) visitCoordinates(child, visit);
}

function boundsPolygon({ minX, minZ, maxX, maxZ }, padding) {
  minX -= padding; minZ -= padding; maxX += padding; maxZ += padding;
  const x2 = maxX > minX ? maxX : minX + Math.max(0.000001, padding * 2);
  const z2 = maxZ > minZ ? maxZ : minZ + Math.max(0.000001, padding * 2);
  return { type: "Polygon", coordinates: [[
    [minX, minZ], [x2, minZ], [x2, z2], [minX, z2], [minX, minZ]
  ]] };
}
