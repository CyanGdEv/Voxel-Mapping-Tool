const EARTH_MATERIALS = new Set([
  "earth", "dirt", "ground", "mud", "compacted", "fine_gravel", "gravel", "unpaved"
]);
const ROCK_SURFACES = new Set([
  "bare_rock", "scree", "shingle", "quarry", "rock", "stone", "outcrop"
]);

/**
 * Inventories terrain detail without inventing geometry. Exact mapped rocks,
 * cliffs, and rock surfaces are compiled later. Polygon-internal rock clusters
 * are permitted only in the explicitly disclosed plausible mode.
 */
export function enrichTerrainDetails(map, sources, options = {}) {
  const mode = options.terrainDetailMode || "evidence";
  const dirtPaths = [];
  const rockPoints = [];
  const cliffLines = [];
  const rockSurfaces = [];

  for (const feature of map.features) {
    if (["path", "road"].includes(feature.kind)) {
      const rawMaterial = firstValue(
        feature.tags?.surface,
        feature.tags?.material,
        feature.orthophoto?.path?.material
      );
      const material = normalize(rawMaterial);
      if (EARTH_MATERIALS.has(material)) {
        const evidence = {
          role: "natural-path-surface",
          material,
          observedAs: rawMaterial,
          lengthM: round1(geometryLength(feature.localGeometry)),
          areaGeometry: ["Polygon", "MultiPolygon"].includes(feature.localGeometry?.type),
          source: evidenceSource(feature),
          orthophotoObserved: Boolean(feature.orthophoto?.path?.material &&
            !firstValue(feature.tags?.surface, feature.tags?.material)),
          imageRecovered: feature.tags?.["orthophoto:discovered"] === "yes"
        };
        feature.terrainDetail = evidence;
        dirtPaths.push({ feature, evidence });
      }
    }

    if (feature.kind === "terrain_detail") {
      const type = normalize(feature.subtype);
      const evidence = {
        role: "mapped-rock-or-landform",
        type,
        geometryType: feature.localGeometry?.type || null,
        heightM: numberOrNull(feature.vertical?.heightM),
        diameterM: dimension(feature.tags),
        dimensionStatus: Number.isFinite(feature.vertical?.heightM) || dimension(feature.tags) !== null
          ? "dimensioned" : "position-or-line-only",
        source: evidenceSource(feature)
      };
      feature.terrainDetail = evidence;
      if (feature.localGeometry?.type === "Point") rockPoints.push({ feature, evidence });
      else cliffLines.push({ feature, evidence });
    }

    if (feature.kind === "surface" && ROCK_SURFACES.has(normalize(feature.subtype))) {
      const evidence = {
        role: "mapped-rock-surface",
        type: normalize(feature.subtype),
        areaM2: round1(geometryArea(feature.localGeometry)),
        source: evidenceSource(feature),
        verticalClusterPolicy: mode === "plausible"
          ? "deterministic inferred clusters inside mapped polygon"
          : "surface texture only; no invented individual boulders"
      };
      feature.terrainDetail = evidence;
      rockSurfaces.push({ feature, evidence });
    }
  }

  const summary = {
    schemaVersion: 1,
    status: dirtPaths.length || rockPoints.length || cliffLines.length || rockSurfaces.length
      ? "available" : "no-mapped-terrain-details",
    mode,
    dirtPaths: {
      features: dirtPaths.length,
      lengthM: round1(dirtPaths.reduce((sum, item) => sum + item.evidence.lengthM, 0)),
      materials: countBy(dirtPaths, (item) => item.evidence.material),
      orthophotoObserved: dirtPaths.filter((item) => item.evidence.orthophotoObserved).length,
      imageRecovered: dirtPaths.filter((item) => item.evidence.imageRecovered).length,
      providers: countBy(dirtPaths, (item) => item.evidence.source.provider)
    },
    rocks: {
      pointFeatures: rockPoints.length,
      dimensionedPoints: rockPoints.filter((item) => item.evidence.dimensionStatus === "dimensioned").length,
      positionOnlyPoints: rockPoints.filter((item) => item.evidence.dimensionStatus !== "dimensioned").length,
      cliffOrOutcropLines: cliffLines.length,
      surfaceFeatures: rockSurfaces.length,
      surfaceAreaM2: round1(rockSurfaces.reduce((sum, item) => sum + item.evidence.areaM2, 0)),
      types: countBy([...rockPoints, ...cliffLines, ...rockSurfaces], (item) => item.evidence.type),
      providers: countBy([...rockPoints, ...cliffLines, ...rockSurfaces],
        (item) => item.evidence.source.provider)
    },
    compilationPolicy: {
      evidence: "Compile tagged dirt materials, exact mapped rock positions/dimensions, cliff plan lines, and mapped rock-surface texture.",
      plausible: "Additionally place deterministic, explicitly inferred small rock clusters inside mapped bare-rock/scree/quarry polygons.",
      off: "Retain normalized source features but emit no vertical terrain-detail models."
    },
    sourceCapabilities: {
      map: {
        osm: sources.osm?.source || "OpenStreetMap",
        fusion: sources.mapFusion || null
      },
      imagery: sources.orthophoto?.status === "available" ? sources.orthophoto.source?.provider || "supplied orthophoto" : null,
      terrain: sources.elevation?.provider || "none"
    },
    limitations: [
      "Dirt, ground, compacted, gravel, and mud paths require a mapped/tagged value or accepted imagery evidence; the compiler does not turn every brown pixel into a path.",
      "A mapped rock point without dimensions remains a one-block position marker in evidence mode.",
      "Exact boulder positions inside a broad bare-rock or scree polygon are unknown; plausible-mode clusters are deterministic visual inference and are counted separately.",
      "Aerial colour alone can confuse soil, mulch, weathered paving, roofs, and shadow, so material promotion remains confidence-gated and route-seeded."
    ]
  };
  map.terrainDetails = summary;
  return summary;
}

function evidenceSource(feature) {
  return {
    featureId: feature.id,
    provider: feature.source?.provider || null,
    timestamp: feature.source?.timestamp || null,
    license: feature.source?.license || null,
    sourceUrl: feature.source?.sourceUrl || null,
    file: feature.source?.file || null
  };
}

function dimension(tags = {}) {
  const direct = [tags.diameter, tags.width, tags["diameter:mean"], tags.diameter_m]
    .map(parseLength).find(Number.isFinite);
  if (Number.isFinite(direct)) return round1(Math.max(0.25, direct));
  const circumference = parseLength(tags.circumference);
  return Number.isFinite(circumference) ? round1(Math.max(0.25, circumference / Math.PI)) : null;
}

function geometryLength(geometry) {
  const lines = geometry?.type === "LineString" ? [geometry.coordinates]
    : geometry?.type === "MultiLineString" ? geometry.coordinates : [];
  return lines.reduce((total, line) => total + line.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point[0] - line[index][0], point[1] - line[index][1]), 0), 0);
}

function geometryArea(geometry) {
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.reduce((sum, polygon) => sum + Math.max(0,
    Math.abs(ringArea(polygon[0] || [])) - polygon.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0)
  ), 0);
}

function ringArea(ring) {
  return ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length] || point;
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalize(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[ -]+/g, "_");
  if (text === "ground" || text === "mud" || text === "unpaved") return "earth";
  return text;
}

function parseLength(value) {
  const match = String(value ?? "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
}

const round1 = (value) => Math.round(value * 10) / 10;
