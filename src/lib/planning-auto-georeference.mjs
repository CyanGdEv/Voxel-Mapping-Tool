import { createProjector } from "./geo.mjs";
import proj4 from "proj4";
import {
  associateComprehensivePlanningLabel,
  comprehensivePointRole,
  comprehensiveSemanticGeometryRole,
  comprehensiveSemanticTags
} from "./planning-comprehensive-semantics.mjs";
import {
  classifyPlanningGeometryView,
  isPlanningGeometryAnchor,
  isPlanningPointAnchor,
  planningShapeGeometryAllowed,
  planningTextBoxes,
  rasterShapeLooksLikeText
} from "./planning-geometry-integrity.mjs";

const DEFAULT_DPI = 300;
const MAX_POLYGON_SHAPES = 12_000;
const MAX_LINE_SHAPES = 12_000;
const BNG = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs";
const CORROBORATION_MARKER = "TPMAP_PLANNING_CORROBORATION_INPUT_V1";
const OSM_RIDE_CORROBORATION_DISTANCE_M = 12;
const OSM_RIDE_CORROBORATION_MIN_SAMPLES = 6;
const OSM_RIDE_CORROBORATION_MIN_RATIO = 0.5;

export function autoGeoreferencePlanningPage({
  svg,
  semantic = {},
  application = {},
  document = {},
  profile,
  page = 1,
  minimumConfidence = 0.72
}) {
  const parsed = parsePlanningSvg(svg);
  const rawLines = semantic.rawLines || [];
  const geometryView = classifyPlanningGeometryView({ document, rawLines });
  const location = applicationLocation(application, profile);
  if (!geometryView.eligible) {
    return emptyResult("drawing-view-evidence-only", parsed, null, location, { page, geometryView });
  }

  const scale = bestScaleCandidate([
    ...(semantic.scaleCandidates || []),
    ...detectPlanningScales(rawLines.map((line) => line.text || line).join("\n")),
    ...detectPlanningScales(`${document.title || ""} ${document.description || ""}`)
  ]);
  if (!scale || !location) {
    return emptyResult(!scale ? "drawing-scale-unavailable" : "application-location-unavailable", parsed, scale, location, { page, geometryView });
  }

  const metresPerPixel = scale.denominator * 0.0254 / Number(document.dpi || DEFAULT_DPI);
  if (!(metresPerPixel > 0.002 && metresPerPixel < 10)) {
    return emptyResult("drawing-scale-out-of-range", parsed, scale, location, { page, geometryView });
  }

  const textBoxes = planningTextBoxes(rawLines);
  const candidateShapes = parsed.shapes.filter((shape) => !rasterShapeLooksLikeText(shape, textBoxes));
  const textShapesRejected = parsed.shapes.length - candidateShapes.length;
  const associationRadius = Math.max(24, Math.min(parsed.width, parsed.height) * 0.05);
  const geometryAnchors = (semantic.anchors || []).filter((anchor) => isPlanningGeometryAnchor(anchor, parsed));
  const associated = candidateShapes.map((shape) => ({
    shape,
    association: associateComprehensivePlanningLabel(shape, geometryAnchors, associationRadius)
  })).filter((entry) => entry.association?.anchor?.semantic);
  const labelledBoundary = associated.find((entry) => entry.association.anchor.semantic.featureClass === "site-boundary");
  const redBoundaryShape = candidateShapes.filter((shape) => shape.closed && redStroke(shape.stroke))
    .sort((a, b) => approximateShapeArea(b) - approximateShapeArea(a))[0] || null;
  const siteBoundary = labelledBoundary?.shape || redBoundaryShape;
  const origin = siteBoundary ? shapeCentroid(siteBoundary) : { x: parsed.width / 2, y: parsed.height / 2 };
  const northDegrees = Number.isFinite(Number(semantic.northDegrees)) ? Number(semantic.northDegrees) : 0;
  const projector = createProjector({ lat: location.lat, lon: location.lon });
  const toLonLat = ({ x, y }) => {
    const east = (x - origin.x) * metresPerPixel;
    const south = (y - origin.y) * metresPerPixel;
    const radians = northDegrees * Math.PI / 180;
    const localX = east * Math.cos(radians) - south * Math.sin(radians);
    const localZ = east * Math.sin(radians) + south * Math.cos(radians);
    return projector.inverse([localX, localZ]);
  };

  const locationConfidence = application.locationConfidence ?? location.confidence ?? (application.geometry ? 0.94 : 0.82);
  const originConfidence = siteBoundary ? 0.9 : 0.62;
  const orientationConfidence = Number.isFinite(Number(semantic.northDegrees)) ? 0.92 : 0.72;
  const baseConfidence = clamp(
    scale.confidence * 0.3 + locationConfidence * 0.25 + originConfidence * 0.25 + orientationConfidence * 0.2,
    0, 1
  );

  const features = [];
  let geometryShapesRejected = 0;
  for (const { shape, association } of associated) {
    if (shape === redBoundaryShape && association.anchor.semantic.featureClass !== "site-boundary") continue;
    const semanticValue = association.anchor.semantic;
    // The supported ride representation is a one-block centreline. Elevation labels
    // are emitted separately as points, while closed envelopes/legend glyphs are
    // evidence rather than track geometry.
    if (semanticValue.className === "ride" && (semanticValue.featureClass !== "ride-track" || shape.closed)) continue;
    const role = comprehensiveSemanticGeometryRole(semanticValue, shape.closed, shape);
    if (!role || role.excluded || role.evidenceOnly) continue;
    if (!planningShapeGeometryAllowed(shape, semanticValue, metresPerPixel)) {
      geometryShapesRejected += 1;
      continue;
    }
    const confidence = clamp(baseConfidence * (0.72 + 0.28 * Number(association.anchor.ocrConfidence || 0.65)), 0, 1);
    if (confidence < minimumConfidence) continue;
    const geometry = shapeGeometry(shape, toLonLat);
    if (!geometry) continue;
    features.push({
      type: "Feature",
      geometry,
      properties: {
        id: autoId(application, document, page, features.length),
        kind: semanticKind(semanticValue),
        subtype: semanticValue.featureClass,
        name: semanticName(association.anchor.text),
        ...role.tags,
        planning_authoritative: true,
        planning_auto_extracted: true,
        planning_auto_georeferenced: true,
        planning_geometry_view: geometryView.status,
        planning_geometry_view_reason: geometryView.reason,
        planning_georeference_method: siteBoundary
          ? "drawing-scale-and-planning-site-boundary-to-application-location"
          : "drawing-scale-and-page-centre-to-application-location",
        planning_georeference_confidence: round(confidence),
        planning_page: page,
        planning_scale_denominator: scale.denominator,
        planning_metres_per_pixel: round(metresPerPixel, 6),
        planning_north_rotation_degrees: northDegrees,
        planning_semantic_label: association.anchor.text,
        accuracy_m: round(Math.max(0.5, (1 - confidence) * 25), 2),
        verified: confidence >= 0.82
      }
    });
  }

  for (const anchor of semantic.anchors || []) {
    if (!isPlanningPointAnchor(anchor, parsed)) continue;
    const pointRole = comprehensivePointRole(anchor.semantic);
    if (!pointRole) continue;
    const confidence = clamp(baseConfidence * Number(anchor.ocrConfidence || 0.65), 0, 1);
    if (confidence < minimumConfidence) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: toLonLat({ x: anchor.cx, y: anchor.cy }) },
      properties: {
        id: autoId(application, document, page, features.length),
        kind: semanticKind(anchor.semantic),
        subtype: anchor.semantic.featureClass,
        name: semanticName(anchor.text),
        ...pointRole.tags,
        planning_authoritative: true,
        planning_auto_extracted: true,
        planning_auto_georeferenced: true,
        planning_geometry_view: geometryView.status,
        planning_geometry_view_reason: geometryView.reason,
        planning_georeference_confidence: round(confidence),
        planning_page: page,
        planning_scale_denominator: scale.denominator,
        planning_semantic_label: anchor.text,
        accuracy_m: round(Math.max(0.5, (1 - confidence) * 25), 2),
        verified: confidence >= 0.82
      }
    });
  }

  return {
    status: features.length ? "geometry-ready" : "no-confidence-gated-semantic-geometry",
    page,
    scale,
    location,
    metresPerPixel,
    geometryView,
    origin: { ...origin, method: siteBoundary ? labelledBoundary ? "labelled-planning-site-boundary" : "red-line-boundary" : "page-centre" },
    northDegrees,
    confidence: round(baseConfidence),
    shapes: parsed.shapes.length,
    candidateShapes: candidateShapes.length,
    textShapesRejected,
    geometryShapesRejected,
    associatedShapes: associated.length,
    collection: { type: "FeatureCollection", features }
  };
}

export function parsePlanningSvg(svg) {
  const source = String(svg || "");
  const viewBox = source.match(/viewBox=["']\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*["']/i);
  const width = Number(viewBox?.[3] || source.match(/<svg\b[^>]*\bwidth=["']([\d.]+)/i)?.[1]);
  const height = Number(viewBox?.[4] || source.match(/<svg\b[^>]*\bheight=["']([\d.]+)/i)?.[1]);
  const shapes = [];
  let polygonCount = 0, lineCount = 0, match;
  const polygons = /<polygon\b([^>]*)>/gi;
  while ((match = polygons.exec(source)) && polygonCount < MAX_POLYGON_SHAPES) {
    const attributes = parseAttributes(match[1]);
    const points = parsePoints(attributes.points);
    if (points.length >= 3) {
      shapes.push({ type: "polygon", closed: true, points, stroke: attributes.stroke || null });
      polygonCount += 1;
    }
  }
  const lines = /<line\b([^>]*)>/gi;
  while ((match = lines.exec(source)) && lineCount < MAX_LINE_SHAPES) {
    const attributes = parseAttributes(match[1]);
    const points = [
      { x: Number(attributes.x1), y: Number(attributes.y1) },
      { x: Number(attributes.x2), y: Number(attributes.y2) }
    ];
    if (points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
      shapes.push({ type: "line", closed: false, points, stroke: attributes.stroke || null });
      lineCount += 1;
    }
  }
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1,
    height: Number.isFinite(height) && height > 0 ? height : 1,
    shapes
  };
}

export function detectPlanningScales(value) {
  const results = [];
  const text = String(value || "");
  // UK planning title blocks commonly use 1/200 @ A1 as well as 1:200.
  const pattern = /(?:scale\s*(?:at\s*)?|\b)(?:1\s*[:@/]\s*)(\d{2,5})(?:\b|\s*at\s*a[0-4])/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const denominator = Number(match[1]);
    if (denominator < 20 || denominator > 25_000) continue;
    results.push({ denominator, confidence: /scale/i.test(match[0]) ? 0.96 : 0.82, source: match[0].trim() });
  }
  return results;
}

export function prepareAutomaticPlanningCorroboration(application = {}) {
  const text = `${application.status || ""} ${application.decision || ""} ${application.proposal || ""}`;
  const acceptedDecision = /approved|grant(?:ed)?|permitted|consent|implemented|completed|lawful/i.test(text) &&
    !/refused|withdrawn|invalid|declined/i.test(text);
  const explicitExisting = /as[ -]?built|record drawing|existing|retrospective|completed|implemented|discharge of condition/i.test(text);
  return {
    schemaVersion: 1,
    marker: CORROBORATION_MARKER,
    acceptedDecision,
    explicitExisting
  };
}

export function corroborateAutomaticPlanningCollection(collection, application, runtime = {}, preparedInput = null) {
  const prepared = preparedInput || prepareAutomaticPlanningCorroboration(application);
  if (prepared?.schemaVersion !== 1 || prepared?.marker !== CORROBORATION_MARKER) {
    throw new Error("Prepared planning corroboration input is invalid");
  }
  const { acceptedDecision, explicitExisting } = prepared;
  let samples = 0, structureMatches = 0;
  const samplePairLocal = runtime.elevation?.samplePairLocal;
  const projector = runtime.center ? createProjector(runtime.center) : null;
  if (samplePairLocal && projector) {
    for (const feature of collection?.features || []) {
      if (!/(?:building|ride|structure|support)/i.test(`${feature.properties?.kind || ""}_${feature.properties?.subtype || ""}`)) continue;
      for (const [lon, lat] of sampleGeometry(feature.geometry, 20)) {
        const [x, z] = projector.forward([lon, lat]);
        const pair = samplePairLocal(x, z);
        if (!Number.isFinite(pair?.terrain) || !Number.isFinite(pair?.surface)) continue;
        samples += 1;
        if (pair.surface - pair.terrain >= 1.8) structureMatches += 1;
      }
    }
  }
  const dsmRatio = samples ? structureMatches / samples : 0;
  const dsmCorroborated = samples >= 3 && dsmRatio >= 0.45;
  const osmRide = corroborateRideAgainstOsm(collection, runtime);
  const worldEligible = acceptedDecision && (explicitExisting || dsmCorroborated || osmRide.corroborated);
  return {
    worldEligible,
    basis: worldEligible
      ? explicitExisting
        ? "The official record describes existing/as-built/implemented work and the drawing passed automatic scale, location and semantic confidence gates."
        : dsmCorroborated
          ? `The approved official drawing passed automatic georeferencing and ${structureMatches}/${samples} sampled structural locations are independently present in the public DSM.`
          : `The approved official planning-derived ride geometry is independently corroborated by ${osmRide.matches}/${osmRide.samples} registration-only OSM ride samples; OSM geometry is not promoted into the world.`
      : acceptedDecision
        ? "Approved/proposed geometry was discovered but no automatic current-state/as-built, DSM, or registration-only OSM ride corroboration reached the promotion threshold."
        : "The official record is not an accepted/implemented decision.",
    acceptedDecision,
    explicitExisting,
    dsm: { available: Boolean(samplePairLocal), samples, structureMatches, ratio: round(dsmRatio) },
    osmRide
  };
}

function applicationLocation(application, profile) {
  const coordinates = application.geometry?.type === "Point" ? application.geometry.coordinates : null;
  const lon = Number(coordinates?.[0] ?? application.lon ?? application.lng ?? application.longitude);
  const lat = Number(coordinates?.[1] ?? application.lat ?? application.latitude);
  if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat, source: application.geometry ? "application-record" : "application-fields", confidence: application.geometry ? 0.94 : 0.86 };
  const easting = Number(application.easting), northing = Number(application.northing);
  if (Number.isFinite(easting) && Number.isFinite(northing)) {
    const [projectedLon, projectedLat] = proj4(BNG, "EPSG:4326", [easting, northing]);
    if (Number.isFinite(projectedLon) && Number.isFinite(projectedLat)) {
      return { lon: projectedLon, lat: projectedLat, source: "official-application-bng", confidence: 0.84 };
    }
  }
  return null;
}

function bestScaleCandidate(candidates) {
  const normalized = candidates.filter((candidate) => Number.isFinite(Number(candidate?.denominator)))
    .map((candidate) => ({ ...candidate, denominator: Number(candidate.denominator), confidence: Number(candidate.confidence || 0.7) }));
  return normalized.sort((a, b) => b.confidence - a.confidence || a.denominator - b.denominator)[0] || null;
}

function shapeGeometry(shape, mapper) {
  if (shape.closed) {
    const ring = shape.points.map(mapper);
    if (ring.length < 3) return null;
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push([...ring[0]]);
    return { type: "Polygon", coordinates: [ring] };
  }
  const coordinates = shape.points.map(mapper);
  return coordinates.length >= 2 ? { type: "LineString", coordinates } : null;
}

function semanticKind(semantic) {
  const mapping = {
    ride: "ride_track", ride_support: "ride_support", ride_attachment: "ride_attachment", building: "building", path: "path",
    bridge: "path", tunnel: "path", wall: "barrier", fence: "barrier", water: "water",
    vegetation: "vegetation", rock: "terrain_detail", terrain: "terrain_detail"
  };
  return mapping[semantic.className] || "detail";
}

function semanticName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= 100 ? text : `${text.slice(0, 97)}...`;
}

function shapeCentroid(shape) {
  const points = shape.points || [];
  if (!points.length) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function approximateShapeArea(shape) {
  const points = shape.points || [];
  let area = 0;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    area += points[previous].x * points[index].y - points[index].x * points[previous].y;
  }
  return Math.abs(area / 2);
}

function redStroke(value) {
  const text = String(value || "").toLowerCase();
  const rgb = text.match(/rgb\s*\(\s*(\d+)\D+(\d+)\D+(\d+)/);
  if (rgb) return Number(rgb[1]) > 150 && Number(rgb[2]) < 130 && Number(rgb[3]) < 130;
  const hex = text.match(/#([0-9a-f]{6})/)?.[1];
  return hex ? parseInt(hex.slice(0, 2), 16) > 150 && parseInt(hex.slice(2, 4), 16) < 130 && parseInt(hex.slice(4, 6), 16) < 130 : /\bred\b/.test(text);
}

function parseAttributes(value) {
  const attributes = {};
  let match;
  const pattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;
  while ((match = pattern.exec(value))) attributes[match[1]] = match[3];
  return attributes;
}

function parsePoints(value) {
  const numbers = String(value || "").trim().split(/[\s,]+/).map(Number);
  const points = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    if (Number.isFinite(numbers[index]) && Number.isFinite(numbers[index + 1])) points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

function sampleGeometry(geometry, maxSamples) {
  const vertices = [];
  const walk = (value) => {
    if (Array.isArray(value) && value.length >= 2 && value.slice(0, 2).every(Number.isFinite)) vertices.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
  };
  walk(geometry?.coordinates);
  if (vertices.length < 2) return vertices;
  const samples = [];
  for (let index = 1; index < vertices.length && samples.length < maxSamples; index += 1) {
    const start = vertices[index - 1], end = vertices[index];
    const approximateMetres = Math.hypot((end[0] - start[0]) * 70_000, (end[1] - start[1]) * 111_000);
    const steps = Math.max(1, Math.min(8, Math.ceil(approximateMetres / 10)));
    for (let step = 0; step < steps && samples.length < maxSamples; step += 1) {
      const t = step / steps;
      samples.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
    }
  }
  if (samples.length < maxSamples) samples.push(vertices.at(-1));
  return samples.slice(0, maxSamples);
}

function corroborateRideAgainstOsm(collection, runtime) {
  const lines = osmRideLines(runtime?.osm?.data || runtime?.osm);
  if (!lines.length) {
    return { available: false, samples: 0, matches: 0, ratio: 0, thresholdM: OSM_RIDE_CORROBORATION_DISTANCE_M, corroborated: false };
  }
  const rideFeatures = (collection?.features || []).filter((feature) =>
    feature?.properties?.kind === "ride_track" && feature.geometry?.type === "LineString");
  const samples = rideFeatures.flatMap((feature) => sampleGeometry(feature.geometry, 24)).slice(0, 240);
  let matches = 0;
  for (const sample of samples) {
    if (nearestLineDistanceM(sample, lines) <= OSM_RIDE_CORROBORATION_DISTANCE_M) matches += 1;
  }
  const ratio = samples.length ? matches / samples.length : 0;
  return {
    available: true,
    samples: samples.length,
    matches,
    ratio: round(ratio),
    thresholdM: OSM_RIDE_CORROBORATION_DISTANCE_M,
    corroborated: samples.length >= OSM_RIDE_CORROBORATION_MIN_SAMPLES && ratio >= OSM_RIDE_CORROBORATION_MIN_RATIO,
    policy: "registration/current-state corroboration only; OSM coordinates are never emitted as planning world geometry"
  };
}

function osmRideLines(data) {
  const lines = [];
  const pushGeometry = (geometry) => {
    const coordinates = (geometry || [])
      .map((point) => [Number(point.lon), Number(point.lat)])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    if (coordinates.length >= 2) lines.push(coordinates);
  };
  for (const element of data?.elements || []) {
    if (String(element?.tags?.roller_coaster || "").toLowerCase() !== "track") continue;
    pushGeometry(element.geometry);
    for (const member of element.members || []) pushGeometry(member.geometry);
  }
  return lines;
}

function nearestLineDistanceM(point, lines) {
  let best = Infinity;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      best = Math.min(best, pointSegmentDistanceM(point, line[index - 1], line[index]));
      if (best <= 0.5) return best;
    }
  }
  return best;
}

function pointSegmentDistanceM(point, start, end) {
  const latitude = (Number(point[1]) + Number(start[1]) + Number(end[1])) / 3;
  const lonScale = 111_320 * Math.cos(latitude * Math.PI / 180);
  const latScale = 111_320;
  const px = Number(point[0]) * lonScale, py = Number(point[1]) * latScale;
  const ax = Number(start[0]) * lonScale, ay = Number(start[1]) * latScale;
  const bx = Number(end[0]) * lonScale, by = Number(end[1]) * latScale;
  const dx = bx - ax, dy = by - ay;
  const length2 = dx * dx + dy * dy;
  if (!length2) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / length2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function autoId(application, document, page, index) {
  const safe = (value) => String(value || "unknown").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  return `auto-plan:${safe(application.reference)}:${safe(document.id || document.title)}:p${page}:${index}`;
}

function emptyResult(status, parsed, scale, location, extra = {}) {
  return {
    status, scale: scale || null, location: location || null, confidence: 0,
    shapes: parsed.shapes.length, associatedShapes: 0,
    collection: { type: "FeatureCollection", features: [] },
    ...extra
  };
}

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const round = (value, places = 3) => Number(Number(value || 0).toFixed(places));