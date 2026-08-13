import path from "node:path";
import {
  bboxPolygon,
  createProjector,
  geometryMapCoordinates,
  pointInRing,
  polygonArea,
  polygonScanlineSpans
} from "./geo.mjs";
import { readJson, sha256 } from "./io.mjs";
import { fuseAdditionalMapSources } from "./source-fusion.mjs";
import { applyPlanningWorldAuthority, planningWorldBoundary } from "./planning-world-authority.mjs";

export async function normalizeMap(sources, options = {}) {
  // The public build/CLI entry points always inject their fail-closed authority
  // mode. Keep this low-level normalizer compatible with isolated fixtures.
  const planningWorldAuthority = options.planningWorldAuthority || "fixture";
  const projector = createProjector(sources.center);
  const features = [];
  for (const element of sources.osm.data.elements || []) {
    const feature = elementToFeature(element, projector);
    if (feature) features.push(feature);
  }

  const sourceFusion = await fuseAdditionalMapSources(features, projector, {
    ...options,
    planningWorldAuthority,
    acquiredPublicData: [
      ...(sources.planning?.collections || []),
      ...(sources.supplemental?.collections || [])
    ]
  });
  sources.mapFusion = sourceFusion;

  for (const filename of options.override || []) {
    const collection = await readJson(path.resolve(filename));
    for (const [featureIndex, raw] of (collection.features || []).entries()) {
      const feature = overrideToFeature(raw, projector, filename, featureIndex);
      const replaces = raw.properties?.replaces;
      if (replaces) {
        const index = features.findIndex((candidate) => candidate.id === replaces);
        if (index >= 0) features.splice(index, 1);
      }
      features.push(feature);
    }
  }

  if (String(planningWorldAuthority).toLowerCase() === "planning-only") {
    const postOverride = applyPlanningWorldAuthority(features, { ...options, planningWorldAuthority });
    sourceFusion.planningAuthority.world.postOverride = postOverride;
    sourceFusion.planningAuthority.world.zeroOsmWorldFeatures = postOverride.zeroOsmWorldFeatures;
  }

  const structureHeightStats = applyLidarBuildingHeights(features, sources.elevation);
  if (structureHeightStats) sources.elevation.structureHeightStats = structureHeightStats;

  const boundary = String(planningWorldAuthority).toLowerCase() === "planning-only"
    ? planningWorldBoundary(features, sources.parkName)
    : selectBoundary(features, sources, projector);
  const geojson = {
    type: "FeatureCollection",
    name: sources.parkName,
    features: features.map(toGeoJson)
  };
  return {
    projector,
    features,
    boundary,
    geojson,
    sourceFusion,
    topology: summarizeTopology(features),
    semantics: summarizeExplicitSemantics(features)
  };
}

export function applyLidarBuildingHeights(features, elevation) {
  if (typeof elevation?.samplePairLocal !== "function") return null;
  const surveyDate = elevation.survey?.newestSurveyDate || null;
  const stats = {
    method: "DSM minus DTM, 65th percentile of valid interior 1 m cells",
    surveyDate,
    candidates: 0,
    measured: 0,
    preservedTagged: 0,
    comparedTagged: 0,
    conflicts: 0,
    insufficientCoverage: 0
  };

  for (const feature of features) {
    if (feature.kind !== "building" || !["Polygon", "MultiPolygon"].includes(feature.localGeometry?.type)) continue;
    stats.candidates += 1;
    const measurement = measureBuildingHeight(feature.localGeometry, elevation.samplePairLocal);
    if (!measurement) {
      stats.insufficientCoverage += 1;
      continue;
    }

    const existingHeight = feature.vertical.heightM;
    if (Number.isFinite(existingHeight)) {
      stats.preservedTagged += 1;
      stats.comparedTagged += 1;
      const differenceM = round1(measurement.heightM - existingHeight);
      const conflict = Math.abs(differenceM) > Math.max(2, existingHeight * 0.35);
      if (conflict) stats.conflicts += 1;
      feature.vertical.lidarComparison = {
        measuredHeightM: measurement.heightM,
        differenceM,
        conflict,
        samples: measurement.samples,
        coverage: measurement.coverage,
        surveyDate
      };
      continue;
    }

    feature.vertical.heightM = measurement.heightM;
    feature.vertical.heightSource = elevation.sourceKind === "ea-lidar"
      ? "ea-lidar-dsm-minus-dtm"
      : "geotiff-dsm-minus-dtm";
    feature.vertical.heightConfidence = measurement.confidence;
    feature.vertical.heightSamples = measurement.samples;
    feature.vertical.heightCoverage = measurement.coverage;
    feature.vertical.heightSpreadM = measurement.spreadM;
    feature.vertical.heightSurveyedAt = surveyDate;
    feature.vertical.explicit = true;
    feature.verification.vertical = "measured-lidar";
    stats.measured += 1;
  }
  return stats;
}

function measureBuildingHeight(geometry, samplePair) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const samples = [];
  let attempted = 0;
  for (const polygon of polygons) {
    for (const [start, end, z] of polygonScanlineSpans(polygon)) {
      // One-cell inset avoids mixing roof and adjacent ground at footprint edges.
      const x1 = end - start >= 2 ? start + 1 : start;
      const x2 = end - start >= 2 ? end - 1 : end;
      for (let x = x1; x <= x2; x += 1) {
        attempted += 1;
        const pair = samplePair(x, z);
        const terrain = pair?.terrain, surface = pair?.surface;
        if (!Number.isFinite(terrain) || !Number.isFinite(surface)) continue;
        const height = surface - terrain;
        if (height >= 1.5 && height <= 80) samples.push(height);
      }
    }
  }
  const coverage = attempted ? samples.length / attempted : 0;
  if (samples.length < 4 || coverage < 0.35) return null;
  samples.sort((a, b) => a - b);
  const heightM = round1(percentile(samples, 0.65));
  const spreadM = round1(percentile(samples, 0.9) - percentile(samples, 0.1));
  const countScore = Math.min(1, Math.log2(samples.length + 1) / 7);
  const spreadScore = Math.max(0, 1 - spreadM / Math.max(6, heightM));
  const confidence = Math.round((0.45 + 0.25 * coverage + 0.2 * countScore + 0.1 * spreadScore) * 1000) / 1000;
  return {
    heightM,
    spreadM,
    samples: samples.length,
    attempted,
    coverage: Math.round(coverage * 1000) / 1000,
    confidence: Math.min(0.99, confidence)
  };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

const round1 = (value) => Math.round(value * 10) / 10;

function elementToFeature(element, projector) {
  const tags = element.tags || {};
  if (!Object.keys(tags).length) return null;
  const classification = classify(tags);
  if (!classification) return null;
  const geometry = osmGeometry(element, tags);
  if (!geometry) return null;
  const localGeometry = geometryMapCoordinates(geometry, projector.forward);
  const height = parseLength(tags.height);
  const levels = parseFloat(tags["building:levels"]);
  const minHeight = parseLength(tags.min_height) ?? 0;
  const ele = parseLength(tags.ele);
  return {
    id: `osm:${element.type}:${element.id}`,
    name: tags.name || tags.ref || null,
    kind: classification.kind,
    subtype: classification.subtype,
    tags,
    geometry,
    localGeometry,
    vertical: {
      heightM: height ?? (Number.isFinite(levels) ? levels * 3 : null),
      heightSource: height !== null ? "height" : Number.isFinite(levels) ? "building:levels" : null,
      minHeightM: minHeight,
      elevationM: ele,
      explicit: height !== null || Number.isFinite(levels) || ele !== null
    },
    source: {
      provider: "OpenStreetMap",
      elementType: element.type,
      elementId: element.id,
      version: element.version ?? null,
      timestamp: element.timestamp ?? null,
      changeset: element.changeset ?? null,
      license: "ODbL-1.0"
    },
    verification: {
      plan: "public-map",
      vertical: ele !== null || height !== null || Number.isFinite(levels) ? "tagged" : "unknown"
    }
  };
}

function overrideToFeature(raw, projector, filename, featureIndex) {
  const properties = raw.properties || {};
  const geometry = raw.geometry;
  const localGeometry = geometryMapCoordinates(geometry, projector.forward);
  const heightM = numberOrNull(properties.height_m ?? properties.height);
  const elevationM = numberOrNull(properties.elevation_m ?? properties.ele);
  return {
    id: properties.id || `override:${path.basename(filename)}:${featureIndex}:${sha256(raw).slice(0, 12)}`,
    name: properties.name || null,
    kind: properties.kind || classify(properties)?.kind || "detail",
    subtype: properties.subtype || "override",
    tags: properties,
    geometry,
    localGeometry,
    vertical: {
      heightM,
      heightSource: heightM !== null ? "survey-override" : null,
      minHeightM: numberOrNull(properties.min_height_m) ?? 0,
      elevationM,
      explicit: heightM !== null || elevationM !== null
    },
    source: {
      provider: properties.source_name || "User verified override",
      sourceUrl: properties.source_url || null,
      timestamp: properties.checked_at || null,
      license: properties.license || null,
      file: path.basename(filename)
    },
    verification: {
      plan: properties.verified === true ? "surveyed" : "override-unverified",
      vertical: heightM !== null ? "surveyed" : "unknown"
    }
  };
}

function classify(tags) {
  if (tags.tourism === "theme_park") return { kind: "park_boundary", subtype: "theme_park" };
  if (tags.roller_coaster === "track") return { kind: "ride_track", subtype: tags["roller_coaster:track"] || "coaster" };
  if (tags.roller_coaster === "support") return { kind: "ride_support", subtype: "support" };
  if (tags.roller_coaster === "station") return { kind: "building", subtype: "coaster_station" };
  if (tags.building) return { kind: "building", subtype: tags.building };
  if (tags.attraction) return { kind: "attraction", subtype: tags.attraction };
  if (tags.barrier === "hedge") return { kind: "vegetation", subtype: "hedge" };
  if (["tree", "tree_row", "wood", "scrub", "shrub", "bush"].includes(tags.natural)) {
    return { kind: "vegetation", subtype: tags.natural };
  }
  if (["forest", "orchard", "vineyard", "plant_nursery"].includes(tags.landuse)) {
    return { kind: "vegetation", subtype: tags.landuse };
  }
  if (["trees", "tree_cover", "shrubs", "scrub"].includes(tags.landcover)) {
    return { kind: "vegetation", subtype: tags.landcover };
  }
  if (["rock", "stone", "boulder", "cliff"].includes(tags.natural)) {
    return { kind: "terrain_detail", subtype: tags.natural };
  }
  if (["outcrop", "boulder"].includes(tags.geological)) {
    return { kind: "terrain_detail", subtype: tags.geological };
  }
  if (tags["area:highway"]) {
    const areaHighway = String(tags["area:highway"]).toLowerCase();
    const pedestrian = ["footway", "path", "pedestrian", "steps", "corridor", "cycleway"].includes(areaHighway);
    return { kind: pedestrian ? "path" : "road", subtype: `area:${areaHighway}` };
  }
  if (tags.highway) {
    const pedestrian = ["footway", "path", "pedestrian", "steps", "corridor", "cycleway", "bridleway"].includes(tags.highway);
    return { kind: pedestrian ? "path" : "road", subtype: tags.highway };
  }
  if (tags.natural === "water" || tags.water || tags.waterway || tags.leisure === "swimming_pool") {
    return { kind: "water", subtype: tags.water || tags.waterway || tags.natural || tags.leisure };
  }
  if (tags.railway) return { kind: "rail", subtype: tags.railway };
  if (tags.barrier) return { kind: "barrier", subtype: tags.barrier };
  if (tags.landuse || tags.landcover || tags.natural || tags.leisure) {
    return { kind: "surface", subtype: tags.landuse || tags.landcover || tags.natural || tags.leisure };
  }
  if (tags.man_made) return { kind: "structure", subtype: tags.man_made };
  if (tags.amenity) return { kind: "amenity", subtype: tags.amenity };
  if (tags.shop) return { kind: "amenity", subtype: `shop:${tags.shop}` };
  if (tags.entrance || tags.door) return { kind: "detail", subtype: tags.entrance ? `entrance:${tags.entrance}` : `door:${tags.door}` };
  if (tags.historic) return { kind: "detail", subtype: `historic:${tags.historic}` };
  if (tags.information) return { kind: "detail", subtype: `information:${tags.information}` };
  if (tags.playground) return { kind: "detail", subtype: `playground:${tags.playground}` };
  if (tags.public_transport) return { kind: "detail", subtype: `public_transport:${tags.public_transport}` };
  if (tags.tourism) return { kind: "amenity", subtype: `tourism:${tags.tourism}` };
  return null;
}

export function osmGeometry(element, tags = element.tags || {}) {
  if (element.type === "node" && Number.isFinite(element.lon) && Number.isFinite(element.lat)) {
    return { type: "Point", coordinates: [element.lon, element.lat] };
  }
  if (element.type === "way" && element.geometry?.length >= 2) {
    const coordinates = element.geometry.map(({ lon, lat }) => [lon, lat]);
    const polygon = isArea(tags, coordinates);
    if (polygon && !samePosition(coordinates[0], coordinates.at(-1))) coordinates.push([...coordinates[0]]);
    return polygon ? { type: "Polygon", coordinates: [coordinates] } : { type: "LineString", coordinates };
  }
  if (element.type === "relation") {
    const members = (element.members || []).filter((member) => member.geometry?.length >= 2);
    if (!members.length) return null;
    if (element.tags?.type === "multipolygon" || element.tags?.type === "boundary") {
      return assembleRelationMultipolygon(members);
    }
    const lines = members.map(memberCoordinates);
    if (isArea(tags, lines[0])) {
      const rings = stitchMemberRings(members);
      if (rings.length) return polygonGeometry(rings, []);
    }
    return lines.length === 1
      ? { type: "LineString", coordinates: lines[0] }
      : { type: "MultiLineString", coordinates: lines };
  }
  return null;
}

function assembleRelationMultipolygon(members) {
  const outerMembers = members.filter((member) => member.role === "outer" || !member.role);
  const innerMembers = members.filter((member) => member.role === "inner");
  const outerRings = stitchMemberRings(outerMembers);
  if (!outerRings.length) return null;
  return polygonGeometry(outerRings, stitchMemberRings(innerMembers));
}

function polygonGeometry(outerRings, innerRings) {
  const polygons = outerRings.map((outer) => [outer]);
  for (const inner of innerRings) {
    const [x, z] = ringInteriorProbe(inner);
    const candidates = outerRings
      .map((outer, index) => ({ index, area: polygonArea(outer), contains: pointInRing(x, z, outer) }))
      .filter((candidate) => candidate.contains)
      .sort((a, b) => a.area - b.area);
    if (candidates.length) polygons[candidates[0].index].push(inner);
  }
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

function stitchMemberRings(members) {
  const chains = members
    .map(memberCoordinates)
    .map(removeConsecutiveDuplicates)
    .filter((chain) => chain.length >= 2);
  const rings = [];
  while (chains.length) {
    let ring = chains.shift();
    while (!samePosition(ring[0], ring.at(-1))) {
      const start = ring[0], end = ring.at(-1);
      const index = chains.findIndex((chain) =>
        samePosition(end, chain[0]) || samePosition(end, chain.at(-1)) ||
        samePosition(start, chain.at(-1)) || samePosition(start, chain[0])
      );
      if (index < 0) break;
      let next = chains.splice(index, 1)[0];
      if (samePosition(end, next[0])) ring = [...ring, ...next.slice(1)];
      else if (samePosition(end, next.at(-1))) ring = [...ring, ...next.reverse().slice(1)];
      else if (samePosition(start, next.at(-1))) ring = [...next.slice(0, -1), ...ring];
      else ring = [...next.reverse().slice(0, -1), ...ring];
    }
    ring = removeConsecutiveDuplicates(ring);
    if (ring.length >= 4 && samePosition(ring[0], ring.at(-1))) rings.push(ring);
  }
  return rings;
}

function memberCoordinates(member) {
  return member.geometry.map(({ lon, lat }) => [lon, lat]);
}

function removeConsecutiveDuplicates(coordinates) {
  return coordinates.filter((position, index) => !index || !samePosition(position, coordinates[index - 1]));
}

function ringInteriorProbe(ring) {
  // The mean is normally safely inside simple OSM holes; if it is not, the
  // midpoint between the first vertex and mean nudges the probe off the edge.
  const unique = samePosition(ring[0], ring.at(-1)) ? ring.slice(0, -1) : ring;
  const mean = unique.reduce(([sx, sz], [x, z]) => [sx + x, sz + z], [0, 0])
    .map((value) => value / Math.max(1, unique.length));
  if (pointInRing(mean[0], mean[1], ring)) return mean;
  return [(ring[0][0] + mean[0]) / 2, (ring[0][1] + mean[1]) / 2];
}

function isArea(tags, coordinates) {
  if (tags.area === "no") return false;
  if (!samePosition(coordinates[0], coordinates.at(-1))) return false;
  return Boolean(tags.area === "yes" || tags.building || tags.landuse || tags.leisure || tags.natural ||
    tags.tourism === "theme_park" || tags.attraction || tags.water || tags.amenity || tags.man_made ||
    tags["area:highway"]);
}

function selectBoundary(features, sources, projector) {
  const candidates = features.filter((feature) => feature.kind === "park_boundary" &&
    ["Polygon", "MultiPolygon"].includes(feature.localGeometry.type));
  if (candidates.length) {
    const selected = candidates.sort((a, b) => geometryArea(b.localGeometry) - geometryArea(a.localGeometry))[0];
    return { ...selected, verified: true, fallback: false };
  }
  const geometry = sources.suppliedBoundary || bboxPolygon(sources.bbox);
  return {
    id: "derived:park-boundary",
    name: sources.parkName,
    kind: "park_boundary",
    subtype: sources.suppliedBoundary ? "geocoder-polygon" : "bounding-box",
    geometry,
    localGeometry: geometryMapCoordinates(geometry, projector.forward),
    vertical: { heightM: null, elevationM: null, explicit: false },
    source: { provider: sources.suppliedBoundary ? "Nominatim result geometry" : "Bounding-box fallback" },
    verification: { plan: sources.suppliedBoundary ? "public-map" : "unverified" },
    verified: Boolean(sources.suppliedBoundary),
    fallback: true
  };
}

function geometryArea(geometry) {
  if (geometry.type === "Polygon") return polygonNetArea(geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.reduce((sum, polygon) => sum + polygonNetArea(polygon), 0);
  return 0;
}

function polygonNetArea(rings) {
  return polygonArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + polygonArea(ring), 0);
}

function summarizeTopology(features) {
  const summary = {
    relationFeatures: 0,
    polygonFeatures: 0,
    polygonParts: 0,
    interiorRings: 0,
    disjointMultipolygons: 0
  };
  for (const feature of features) {
    if (feature?.source?.elementType === "relation") summary.relationFeatures += 1;
    const geometry = feature?.geometry;
    const polygons = geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
    if (!polygons.length) continue;
    summary.polygonFeatures += 1;
    summary.polygonParts += polygons.length;
    summary.interiorRings += polygons.reduce((sum, polygon) => sum + Math.max(0, polygon.length - 1), 0);
    if (polygons.length > 1) summary.disjointMultipolygons += 1;
  }
  return summary;
}

function summarizeExplicitSemantics(features) {
  const summary = {
    bridges: 0,
    tunnels: 0,
    layered: 0,
    positiveLayers: 0,
    negativeLayers: 0,
    mappedEntrances: 0,
    mappedMainEntrances: 0
  };
  for (const feature of features) {
    const tags = feature?.tags || {};
    if (tags.bridge && tags.bridge !== "no") summary.bridges += 1;
    if (tags.tunnel && tags.tunnel !== "no") summary.tunnels += 1;
    const layer = Number(tags.layer);
    if (Number.isFinite(layer)) {
      summary.layered += 1;
      if (layer > 0) summary.positiveLayers += 1;
      if (layer < 0) summary.negativeLayers += 1;
    }
    if (tags.entrance || tags.door) summary.mappedEntrances += 1;
    if (tags.entrance === "main") summary.mappedMainEntrances += 1;
  }
  return summary;
}

export function refreshMapDerivedData(map) {
  map.geojson = {
    type: "FeatureCollection",
    name: map.geojson?.name || null,
    features: map.features.map(toGeoJson)
  };
  map.topology = summarizeTopology(map.features);
  map.semantics = summarizeExplicitSemantics(map.features);
  return map;
}

export function toGeoJson(feature) {
  return {
    type: "Feature",
    id: feature.id,
    geometry: feature?.geometry ?? null,
    properties: {
      id: feature.id,
      name: feature.name,
      kind: feature.kind,
      subtype: feature.subtype,
      ...feature.tags,
      _vertical: feature.vertical,
      _source: feature.source,
      _verification: feature.verification,
      _fidelity: feature.fidelity || undefined,
      _orthophoto: feature.orthophoto?.path ? compactOrthophoto(feature.orthophoto.path) : undefined,
      _path_topology: feature.pathTopology || undefined,
      _terrain_detail: feature.terrainDetail || undefined,
      _ride_profile: feature.rideProfile || undefined
    }
  };
}

function compactOrthophoto(observation) {
  return {
    schemaVersion: observation.schemaVersion,
    status: observation.status,
    rejectionReason: observation.rejectionReason,
    sampledCrossSections: observation.sampledCrossSections,
    acceptedCrossSections: observation.acceptedCrossSections,
    coverage: observation.coverage,
    measuredLengthM: observation.measuredLengthM,
    widthM: observation.widthM,
    widthRangeM: observation.widthRangeM,
    colour: observation.colour,
    material: observation.material,
    materialCandidate: observation.materialCandidate,
    pattern: observation.pattern,
    patternCandidate: observation.patternCandidate,
    confidence: observation.confidence,
    source: observation.source,
    method: observation.method
  };
}

function parseLength(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = String(value).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

const numberOrNull = (value) => value === undefined || value === null || value === ""
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const samePosition = (a, b) => Boolean(a && b && a[0] === b[0] && a[1] === b[1]);
