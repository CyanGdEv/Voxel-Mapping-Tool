import proj4 from "proj4";
import { bboxCenter, createProjector } from "./geo.mjs";
import {
  associateComprehensivePlanningLabel,
  classifyComprehensivePlanningLabel,
  comprehensivePointRole,
  comprehensiveSemanticGeometryRole
} from "./planning-comprehensive-semantics.mjs";

const BNG = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs";
const MAX_ENTITIES = 50_000;
const UNIT_METRES = new Map([[1, 0.0254], [2, 0.3048], [4, 0.001], [5, 0.01], [6, 1], [7, 1_000], [9, 0.0000254], [10, 0.000001], [14, 0.1]]);

/** Extracts useful geometry from an ASCII DXF without rasterising or losing model-space precision. */
export function extractNativeDxfPlanning({ bytes, application = {}, document = {}, profile, minimumConfidence = 0.72 }) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes || "");
  const parsed = parseDxf(text);
  const location = applicationLocation(application);
  const reference = referencePoint(location, profile);
  const registration = registerDrawing(parsed, reference, Boolean(location));
  if (!registration) return empty("native-dxf-registration-unavailable", parsed, location);

  const shapes = parsed.shapes.map((shape) => normalizeShape(shape, registration));
  const anchors = parsed.labels.map((label) => {
    const point = normalizePoint(label.point, registration);
    return {
      text: label.text,
      cx: point.x,
      cy: point.y,
      semantic: classifyComprehensivePlanningLabel(`${label.text} ${label.layer || ""}`),
      ocrConfidence: 1
    };
  }).filter((anchor) => anchor.semantic);
  const associationRadius = 30;
  const toLonLat = registration.mode === "bng"
    ? ({ x, y }) => proj4(BNG, "EPSG:4326", [x, y])
    : ({ x, y }) => registration.projector.inverse([x - registration.origin.x, -(y - registration.origin.y)]);
  const features = [];

  for (const shape of shapes) {
    const layerSemantic = classifyComprehensivePlanningLabel(shape.layer);
    const nearby = associateComprehensivePlanningLabel(shape, anchors, associationRadius);
    const semantic = layerSemantic || nearby?.anchor?.semantic;
    const role = comprehensiveSemanticGeometryRole(semantic, shape.closed, shape);
    if (!role || role.excluded || role.evidenceOnly) continue;
    const confidence = clamp(registration.confidence * (layerSemantic ? 0.98 : 0.94), 0, 1);
    if (confidence < minimumConfidence) continue;
    const geometry = shapeGeometry(shape, toLonLat);
    if (!geometry) continue;
    features.push(feature({
      geometry, semantic, role, confidence, application, document,
      index: features.length, name: nearby?.anchor?.text || shape.layer,
      registration
    }));
  }

  for (const anchor of anchors) {
    const role = comprehensivePointRole(anchor.semantic);
    if (!role || registration.confidence < minimumConfidence) continue;
    features.push(feature({
      geometry: { type: "Point", coordinates: toLonLat({ x: anchor.cx, y: anchor.cy }) },
      semantic: anchor.semantic, role, confidence: registration.confidence,
      application, document, index: features.length, name: anchor.text, registration
    }));
  }

  return {
    status: features.length ? "native-dxf-geometry-ready" : "native-dxf-no-semantic-geometry",
    page: 1,
    confidence: registration.confidence,
    scale: { denominator: 1, source: `DXF model units (${registration.unitName})`, confidence: 1 },
    location,
    origin: registration.origin,
    shapes: shapes.length,
    associatedShapes: features.length,
    nativeFormat: "dxf",
    registration: registration.mode,
    collection: { type: "FeatureCollection", features }
  };
}

export function looksLikeAsciiDxf(bytes) {
  const head = Buffer.isBuffer(bytes) ? bytes.subarray(0, 16_384).toString("utf8") : String(bytes || "").slice(0, 16_384);
  return /(?:^|\r?\n)\s*0\s*\r?\n\s*SECTION\s*(?:\r?\n|$)/i.test(head) && /\b(?:HEADER|ENTITIES)\b/i.test(head);
}

function parseDxf(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number(lines[index].trim());
    if (Number.isInteger(code)) pairs.push({ code, value: lines[index + 1].trim() });
  }
  let units = 0;
  for (let index = 0; index < pairs.length - 1; index += 1) {
    if (pairs[index].code === 9 && pairs[index].value === "$INSUNITS") {
      const value = pairs.slice(index + 1, index + 5).find((pair) => pair.code === 70);
      units = Number(value?.value || 0);
      break;
    }
  }
  const start = pairs.findIndex((pair, index) => pair.code === 2 && pair.value.toUpperCase() === "ENTITIES" && pairs[index - 1]?.value.toUpperCase() === "SECTION");
  const entities = [];
  if (start >= 0) {
    let current = null;
    for (let index = start + 1; index < pairs.length && entities.length < MAX_ENTITIES; index += 1) {
      const pair = pairs[index];
      if (pair.code === 0 && pair.value.toUpperCase() === "ENDSEC") { if (current) entities.push(current); break; }
      if (pair.code === 0) {
        if (current) entities.push(current);
        current = { type: pair.value.toUpperCase(), groups: [] };
      } else if (current) current.groups.push(pair);
    }
  }
  const shapes = [], labels = [];
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index], layer = first(entity, 8) || "";
    if (entity.type === "TEXT" || entity.type === "MTEXT") {
      const point = xy(entity);
      const value = all(entity, 3).concat(all(entity, 1)).join("").replace(/\\P/g, " ").replace(/[{}]/g, " ").trim();
      if (point && value) labels.push({ point, text: value, layer });
      continue;
    }
    if (entity.type === "LINE") {
      const a = xy(entity), b = xy(entity, 11, 21);
      if (a && b) shapes.push({ points: [a, b], closed: false, layer });
    } else if (entity.type === "LWPOLYLINE") {
      const points = pairedCoordinates(entity);
      if (points.length >= 2) shapes.push({ points, closed: (Number(first(entity, 70)) & 1) === 1, layer });
    } else if (entity.type === "POLYLINE") {
      const points = [];
      while (entities[index + 1]?.type === "VERTEX") { index += 1; const point = xy(entities[index]); if (point) points.push(point); }
      if (entities[index + 1]?.type === "SEQEND") index += 1;
      if (points.length >= 2) shapes.push({ points, closed: (Number(first(entity, 70)) & 1) === 1, layer });
    } else if (entity.type === "CIRCLE" || entity.type === "ARC") {
      const centre = xy(entity), radius = Number(first(entity, 40));
      if (!centre || !(radius > 0)) continue;
      const startAngle = entity.type === "ARC" ? Number(first(entity, 50) || 0) : 0;
      let endAngle = entity.type === "ARC" ? Number(first(entity, 51) || 360) : 360;
      if (endAngle <= startAngle) endAngle += 360;
      const segments = Math.min(64, Math.max(12, Math.ceil((endAngle - startAngle) / 15)));
      const points = Array.from({ length: segments + 1 }, (_, step) => {
        const radians = (startAngle + (endAngle - startAngle) * step / segments) * Math.PI / 180;
        return { x: centre.x + Math.cos(radians) * radius, y: centre.y + Math.sin(radians) * radius };
      });
      shapes.push({ points, closed: entity.type === "CIRCLE", layer });
    }
  }
  return { units, shapes, labels };
}

function registerDrawing(parsed, reference, hasApplicationLocation) {
  const points = parsed.shapes.flatMap((shape) => shape.points);
  if (!points.length) return null;
  const centre = centroid(points);
  const directBng = centre.x >= 0 && centre.x <= 750_000 && centre.y >= 0 && centre.y <= 1_350_000 &&
    reference?.bng && Math.hypot(centre.x - reference.bng[0], centre.y - reference.bng[1]) < 50_000;
  if (directBng) return { mode: "bng", factor: 1, origin: centre, confidence: 0.98, unitName: "British National Grid metres" };
  const factor = UNIT_METRES.get(parsed.units);
  if (!factor || !reference?.location || !hasApplicationLocation) return null;
  return {
    mode: "local-model-space", factor, origin: { x: centre.x * factor, y: centre.y * factor },
    projector: createProjector(reference.location), confidence: 0.86, unitName: unitName(parsed.units)
  };
}

function referencePoint(location, profile) {
  const fallback = profile?.bbox ? bboxCenter(profile.bbox) : null;
  const selected = location || (fallback ? { ...fallback, source: "park-profile", confidence: 0.7 } : null);
  if (!selected) return null;
  return { location: { lon: selected.lon, lat: selected.lat }, bng: proj4("EPSG:4326", BNG, [selected.lon, selected.lat]) };
}

function applicationLocation(application) {
  const point = application.geometry?.type === "Point" ? application.geometry.coordinates : null;
  const lon = Number(point?.[0] ?? application.lon ?? application.lng ?? application.longitude);
  const lat = Number(point?.[1] ?? application.lat ?? application.latitude);
  if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat, source: point ? "application-record" : "application-fields", confidence: point ? 0.94 : 0.86 };
  const easting = Number(application.easting), northing = Number(application.northing);
  if (Number.isFinite(easting) && Number.isFinite(northing)) {
    const [projectedLon, projectedLat] = proj4(BNG, "EPSG:4326", [easting, northing]);
    return { lon: projectedLon, lat: projectedLat, source: "official-application-bng", confidence: 0.84 };
  }
  return null;
}

function normalizeShape(shape, registration) {
  return { ...shape, points: shape.points.map((point) => normalizePoint(point, registration)) };
}
function normalizePoint(point, registration) { return { x: point.x * registration.factor, y: point.y * registration.factor }; }
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
function feature({ geometry, semantic, role, confidence, application, document, index, name, registration }) {
  return { type: "Feature", geometry, properties: {
    id: `native-plan:${safe(application.reference)}:${safe(document.id || document.title)}:${index}`,
    kind: semanticKind(semantic), subtype: semantic.featureClass, name: semanticName(name), ...role.tags,
    planning_authoritative: true, planning_auto_extracted: true, planning_auto_georeferenced: true,
    planning_spatial_registration_verified: registration.mode === "bng",
    planning_georeference_method: `native-dxf-${registration.mode}`,
    planning_georeference_confidence: round(confidence), planning_application_reference: application.reference || "unknown",
    planning_document_id: document.id || document.title || "unknown", planning_document_role: document.role || "planning-document",
    source: "official-planning-native-dxf"
  } };
}
function semanticKind(semantic) { return ({ ride: "ride_track", ride_support: "ride_support", ride_attachment: "ride_attachment", building: "building", path: "path", bridge: "path", tunnel: "path", wall: "barrier", fence: "barrier", water: "water", vegetation: "vegetation", rock: "terrain_detail", terrain: "terrain_detail" })[semantic.className] || "detail"; }
function semanticName(value) { const text = String(value || "").replace(/\s+/g, " ").trim(); return text.length <= 100 ? text : `${text.slice(0, 97)}...`; }
function empty(status, parsed, location) { return { status, page: 1, confidence: 0, scale: null, location, origin: null, shapes: parsed.shapes.length, associatedShapes: 0, nativeFormat: "dxf", collection: { type: "FeatureCollection", features: [] } }; }
function pairedCoordinates(entity) { const xs = all(entity, 10).map(Number), ys = all(entity, 20).map(Number); return xs.map((x, index) => ({ x, y: ys[index] })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)); }
function xy(entity, xCode = 10, yCode = 20) { const x = Number(first(entity, xCode)), y = Number(first(entity, yCode)); return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null; }
function first(entity, code) { return entity.groups.find((group) => group.code === code)?.value; }
function all(entity, code) { return entity.groups.filter((group) => group.code === code).map((group) => group.value); }
function centroid(points) { return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length }; }
function unitName(code) { return ({ 1: "inches", 2: "feet", 4: "millimetres", 5: "centimetres", 6: "metres", 7: "kilometres", 9: "mils", 10: "micrometres", 14: "decimetres" })[code] || `INSUNITS ${code}`; }
function safe(value) { return String(value || "unknown").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase(); }
function round(value) { return Math.round(value * 1_000) / 1_000; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
