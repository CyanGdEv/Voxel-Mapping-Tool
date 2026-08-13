import proj4 from "proj4";
import { bboxCenter, createProjector } from "./geo.mjs";
import { classifyComprehensivePlanningLabel } from "./planning-comprehensive-semantics.mjs";

const BNG = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs";
const PRODUCT_TYPES = new Set([
  "IFCBUILDING", "IFCBUILDINGELEMENTPROXY", "IFCWALL", "IFCWALLSTANDARDCASE", "IFCSLAB", "IFCROOF",
  "IFCCOVERING", "IFCCOLUMN", "IFCBEAM", "IFCMEMBER", "IFCPLATE", "IFCFOOTING", "IFCPILE",
  "IFCSTAIR", "IFCSTAIRFLIGHT", "IFCRAMP", "IFCRAMPFLIGHT", "IFCRAILING", "IFCCURTAINWALL",
  "IFCTRANSPORTELEMENT", "IFCCIVILELEMENT", "IFCELEMENTASSEMBLY"
]);
const MAX_ENTITIES = 120_000;
const MAX_FEATURES = 20_000;

export function looksLikeIfc(value) {
  const text = Buffer.isBuffer(value) ? value.subarray(0, 4096).toString("utf8") : String(value || "").slice(0, 4096);
  return /ISO-10303-21\s*;/i.test(text) && /(?:FILE_SCHEMA|\bDATA\s*;)/i.test(text);
}

/** Conservative IFC STEP decoder: promotes only traceable extruded/swept planning solids. */
export function extractNativeIfcPlanning({ bytes, application = {}, document = {}, profile, minimumConfidence = 0.72 }) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes || "");
  if (!looksLikeIfc(text)) return empty("native-ifc-invalid", null, 0);
  const model = parseIfc(text);
  const location = applicationLocation(application);
  const registration = resolveRegistration(model, referencePoint(location, profile), Boolean(location));
  const diagnostics = { entities: model.entities.size, productsVisited: 0, representedProducts: 0, extrudedSolids: 0, unsupportedRepresentations: 0 };
  if (!registration) return empty("native-ifc-registration-unavailable", location, model.entities.size, diagnostics);

  const features = [];
  for (const entity of model.entities.values()) {
    if (!PRODUCT_TYPES.has(entity.type) || features.length >= MAX_FEATURES) continue;
    diagnostics.productsVisited += 1;
    const product = productInfo(entity, model);
    if (!product.representation) continue;
    diagnostics.representedProducts += 1;
    const solids = collectExtrusions(product.representation, model);
    if (!solids.length) { diagnostics.unsupportedRepresentations += 1; continue; }
    for (const solidRef of solids) {
      if (features.length >= MAX_FEATURES) break;
      const solid = extractExtrusion(solidRef, product.placement, model);
      if (!solid) continue;
      diagnostics.extrudedSolids += 1;
      const classification = classifyProduct(entity.type, product.name);
      if (!classification) continue;
      const confidence = registration.confidence * (solid.profileKind === "arbitrary" ? 0.97 : 0.95);
      if (confidence < minimumConfidence) continue;
      const ring = solid.ring.map((point) => mapPoint(point, registration));
      closeRing(ring);
      const vertical = mapVertical(solid, registration);
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {
          id: `native-ifc:${safe(application.reference)}:${safe(document.id || document.title)}:${entity.id}:${features.length}`,
          kind: classification.kind,
          subtype: classification.subtype,
          name: product.name || null,
          ...classification.tags,
          height_m: vertical.heightM,
          elevation_m: vertical.baseElevationM,
          top_elevation_m: vertical.topElevationM,
          planning_authoritative: true,
          planning_auto_extracted: true,
          planning_auto_georeferenced: true,
          planning_georeference_method: `native-ifc-${registration.mode}`,
          planning_georeference_confidence: round(confidence),
          planning_application_reference: application.reference || "unknown",
          planning_document_id: document.id || document.title || "unknown",
          planning_document_role: document.role || "planning-document",
          planning_feature_class: classification.kind,
          planning_semantic_class: classification.kind,
          native_ifc_entity: entity.type,
          native_ifc_entity_id: entity.id,
          native_ifc_profile: solid.profileKind,
          native_ifc_registration: registration.mode,
          accuracy_m: registration.mode === "bng-map-conversion" ? 0.05 : registration.mode === "bng" ? 0.15 : 2.5,
          verified: confidence >= 0.9,
          source: "official-planning-native-ifc"
        }
      });
    }
  }

  return {
    status: features.length ? "native-ifc-geometry-ready" : "native-ifc-no-supported-geometry",
    page: 1,
    confidence: registration.confidence,
    scale: { denominator: 1, source: `IFC model units (${registration.unitName})`, confidence: 1 },
    location,
    origin: registration.origin || null,
    shapes: diagnostics.extrudedSolids,
    associatedShapes: features.length,
    nativeFormat: "ifc",
    registration: registration.mode,
    diagnostics,
    collection: { type: "FeatureCollection", features }
  };
}

function parseIfc(text) {
  const entities = new Map();
  const upper = text.toUpperCase();
  const start = Math.max(0, upper.indexOf("DATA;") + 5);
  const endIndex = upper.indexOf("ENDSEC;", start);
  const body = text.slice(start, endIndex >= 0 ? endIndex : text.length);
  let cursor = 0;
  while (cursor < body.length && entities.size < MAX_ENTITIES) {
    const hash = body.indexOf("#", cursor); if (hash < 0) break;
    let p = hash + 1; while (/\d/.test(body[p] || "")) p += 1;
    const id = Number(body.slice(hash + 1, p));
    while (/\s/.test(body[p] || "")) p += 1;
    if (!Number.isInteger(id) || body[p++] !== "=") { cursor = p; continue; }
    while (/\s/.test(body[p] || "")) p += 1;
    const t0 = p; while (/[A-Za-z0-9_]/.test(body[p] || "")) p += 1;
    const type = body.slice(t0, p).toUpperCase();
    while (/\s/.test(body[p] || "")) p += 1;
    if (!type || body[p] !== "(") { cursor = p + 1; continue; }
    const close = matchingParen(body, p); if (close < 0) break;
    entities.set(id, { id, type, raw: body.slice(p + 1, close), args: null });
    cursor = close + 1;
  }
  return { entities, unitFactor: lengthUnitFactor(text) };
}

function matchingParen(text, start) {
  let depth = 0, quoted = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'") { if (quoted && text[i + 1] === "'") { i += 1; continue; } quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function args(entity) { return entity.args ||= splitTopLevel(entity.raw); }
function splitTopLevel(value) {
  const out = []; let depth = 0, quoted = false, start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c === "'") { if (quoted && value[i + 1] === "'") { i += 1; continue; } quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === "(") depth += 1; else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; }
  }
  out.push(value.slice(start).trim()); return out;
}

function productInfo(entity, model) {
  const values = args(entity), refs = values.map(refNumber);
  return {
    placement: refs.find((ref) => model.entities.get(ref)?.type === "IFCLOCALPLACEMENT") || null,
    representation: refs.find((ref) => model.entities.get(ref)?.type === "IFCPRODUCTDEFINITIONSHAPE") || null,
    name: stringValue(values[2]) || stringValue(values[3]) || entity.type.replace(/^IFC/, "")
  };
}

function collectExtrusions(root, model) {
  const out = [], seen = new Set();
  const visit = (ref, depth = 0) => {
    if (!ref || depth > 10 || seen.has(ref)) return;
    seen.add(ref); const entity = model.entities.get(ref); if (!entity) return;
    if (entity.type === "IFCEXTRUDEDAREASOLID") { out.push(ref); return; }
    for (const child of allRefs(entity.raw)) visit(child, depth + 1);
  };
  visit(root); return out;
}

function extractExtrusion(ref, productPlacement, model) {
  const entity = model.entities.get(ref); if (!entity) return null;
  const values = args(entity);
  const profile = profileRing(refNumber(values[0]), model);
  const depth = numberValue(values[3]);
  if (!profile || !(depth > 0)) return null;
  const profileTx = placementTransform(profile.positionRef, model);
  const solidTx = placementTransform(refNumber(values[1]), model);
  const productTx = localPlacementTransform(productPlacement, model);
  let ring = profile.ring.map((point) => transform2d(point, profileTx));
  ring = ring.map((point) => transform2d(point, solidTx));
  ring = ring.map((point) => transform2d(point, productTx));
  const direction = directionVector(refNumber(values[2]), model) || [0, 0, 1];
  return {
    ring,
    baseZ: (profileTx.z || 0) + (solidTx.z || 0) + (productTx.z || 0),
    depth: depth * model.unitFactor,
    directionZ: Math.abs(direction[2] ?? 1),
    profileKind: profile.kind
  };
}

function profileRing(ref, model) {
  const entity = model.entities.get(ref); if (!entity) return null;
  const values = args(entity);
  if (entity.type === "IFCRECTANGLEPROFILEDEF") {
    const x = numberValue(values[3]), y = numberValue(values[4]); if (!(x > 0 && y > 0)) return null;
    const hx = x * model.unitFactor / 2, hy = y * model.unitFactor / 2;
    return { kind: "rectangle", positionRef: refNumber(values[2]), ring: [[-hx,-hy],[hx,-hy],[hx,hy],[-hx,hy],[-hx,-hy]] };
  }
  if (["IFCARBITRARYCLOSEDPROFILEDEF", "IFCARBITRARYPROFILEDEFWITHVOIDS"].includes(entity.type)) {
    const ring = curvePoints(refNumber(values[2]), model); return ring?.length >= 4 ? { kind: "arbitrary", positionRef: null, ring } : null;
  }
  return null;
}

function curvePoints(ref, model) {
  const entity = model.entities.get(ref); if (!entity) return null;
  if (entity.type === "IFCPOLYLINE") return closeRing(allRefs(entity.raw).map((id) => point(id, model)).filter(Boolean).map(([x,y]) => [x * model.unitFactor, y * model.unitFactor]));
  if (entity.type === "IFCINDEXEDPOLYCURVE") {
    const list = model.entities.get(refNumber(args(entity)[0]));
    if (list?.type !== "IFCCARTESIANPOINTLIST2D") return null;
    return closeRing(numericTuples(args(list)[0]).map(([x,y]) => [x * model.unitFactor, y * model.unitFactor]));
  }
  return null;
}

function placementTransform(ref, model) {
  if (!ref) return identity(); const entity = model.entities.get(ref); if (!entity) return identity();
  const values = args(entity);
  if (!["IFCAXIS2PLACEMENT2D", "IFCAXIS2PLACEMENT3D"].includes(entity.type)) return identity();
  const p = point(refNumber(values[0]), model) || [0,0,0];
  const d = directionVector(refNumber(entity.type === "IFCAXIS2PLACEMENT3D" ? values[2] : values[1]), model) || [1,0,0];
  return { x: p[0] * model.unitFactor, y: p[1] * model.unitFactor, z: (p[2] || 0) * model.unitFactor, angle: Math.atan2(d[1] || 0, d[0] || 1) };
}

function localPlacementTransform(ref, model, seen = new Set()) {
  if (!ref || seen.has(ref)) return identity(); seen.add(ref);
  const entity = model.entities.get(ref); if (entity?.type !== "IFCLOCALPLACEMENT") return identity();
  const values = args(entity), parent = localPlacementTransform(refNumber(values[0]), model, seen), local = placementTransform(refNumber(values[1]), model);
  const c = Math.cos(parent.angle), s = Math.sin(parent.angle);
  return { x: parent.x + local.x*c - local.y*s, y: parent.y + local.x*s + local.y*c, z: parent.z + local.z, angle: parent.angle + local.angle };
}

function resolveRegistration(model, reference, hasApplicationLocation) {
  const conversion = mapConversion(model);
  if (conversion?.bng) return { mode: "bng-map-conversion", confidence: 0.99, unitName: "IFC → British National Grid", origin: { x: conversion.e, y: conversion.n }, conversion, orthogonalHeightM: conversion.h };
  const points = modelPoints(model); if (!points.length) return null;
  const nearby = reference?.bng ? points.filter(([x,y]) => x >= 0 && x <= 750000 && y >= 0 && y <= 1350000 && Math.hypot(x-reference.bng[0], y-reference.bng[1]) < 50000) : [];
  if (nearby.length) { const c = centroid(nearby); return { mode: "bng", confidence: 0.98, unitName: "British National Grid metres", origin: { x: c[0], y: c[1] } }; }
  if (!reference?.location || !hasApplicationLocation) return null;
  const c = centroid(points);
  return { mode: "local-model-space", confidence: 0.84, unitName: "IFC model metres", origin: { x: c[0], y: c[1] }, projector: createProjector(reference.location) };
}

function mapConversion(model) {
  for (const entity of model.entities.values()) if (entity.type === "IFCMAPCONVERSION") {
    const v = args(entity), e = numberValue(v[2]), n = numberValue(v[3]); if (![e,n].every(Number.isFinite)) continue;
    return { bng: e >= 0 && e <= 750000 && n >= 0 && n <= 1350000, e, n, h: numberValue(v[4]) || 0, a: numberValue(v[5]) ?? 1, o: numberValue(v[6]) ?? 0, s: numberValue(v[7]) || 1 };
  }
  return null;
}

function mapPoint([x,y], registration) {
  if (registration.mode === "bng-map-conversion") {
    const c = registration.conversion; return proj4(BNG, "EPSG:4326", [c.e + c.s*(x*c.a-y*c.o), c.n + c.s*(x*c.o+y*c.a)]);
  }
  if (registration.mode === "bng") return proj4(BNG, "EPSG:4326", [x,y]);
  return registration.projector.inverse([x-registration.origin.x, -(y-registration.origin.y)]);
}

function mapVertical(solid, registration) {
  const base = solid.baseZ + (registration.orthogonalHeightM || 0), height = solid.depth * Math.min(1, Math.max(0, solid.directionZ || 1));
  return { baseElevationM: round(base), heightM: round(height), topElevationM: round(base + height) };
}

function classifyProduct(type, name) {
  const semanticValue = classifyComprehensivePlanningLabel(`${name || ""} ${type}`);
  const semantic = semanticValue?.className;
  const map = { ride:["ride_track","ifc-ride-track",{roller_coaster:"track"}], ride_support:["ride_support","ifc-ride-support",{roller_coaster:"support",man_made:"support"}], ride_attachment:["ride_attachment",semanticValue?.featureClass || "ifc-ride-attachment",{man_made:"ride_attachment",ride_attachment:semanticValue?.attachmentType,ride_attachment_vertical_mode:semanticValue?.attachmentVerticalMode,ride_attachment_side:semanticValue?.attachmentSide}], building:["building","ifc-building",{building:"yes"}], path:["path","ifc-path",{highway:"path"}], bridge:["path","ifc-bridge",{highway:"path",bridge:"yes"}], tunnel:["path","ifc-tunnel",{highway:"path",tunnel:"yes"}], wall:["barrier","ifc-wall",{barrier:"wall"}], fence:["barrier","ifc-fence",{barrier:"fence"}], water:["water","ifc-water",{natural:"water"}] };
  if (map[semantic]) { const [kind, subtype, rawTags] = map[semantic]; const tags = Object.fromEntries(Object.entries(rawTags).filter(([, value]) => value !== undefined && value !== null)); return { kind, subtype, tags }; }
  if (["IFCWALL","IFCWALLSTANDARDCASE","IFCRAILING"].includes(type)) return { kind:"barrier", subtype:type.includes("RAILING")?"ifc-railing":"ifc-wall", tags:{barrier:type.includes("RAILING")?"railing":"wall"} };
  if (["IFCSLAB","IFCROOF","IFCCOVERING","IFCBUILDING"].includes(type)) return { kind:"building", subtype:`ifc-${type.slice(3).toLowerCase()}`, tags:{building:"yes"} };
  if (["IFCSTAIR","IFCSTAIRFLIGHT","IFCRAMP","IFCRAMPFLIGHT"].includes(type)) return { kind:"path", subtype:`ifc-${type.slice(3).toLowerCase()}`, tags:{highway:type.includes("STAIR")?"steps":"path"} };
  return PRODUCT_TYPES.has(type) ? { kind:"structure", subtype:`ifc-${type.slice(3).toLowerCase()}`, tags:{man_made:"structure"} } : null;
}

function lengthUnitFactor(text) {
  const hit = text.toUpperCase().match(/IFCSIUNIT\([^;]*\.LENGTHUNIT\.[^;]*\.(METRE|METER)\.\)/); if (!hit) return 1;
  if (/\.MILLI\./.test(hit[0])) return .001; if (/\.CENTI\./.test(hit[0])) return .01; if (/\.DECI\./.test(hit[0])) return .1; if (/\.KILO\./.test(hit[0])) return 1000; return 1;
}
function modelPoints(model) { const out=[]; for (const e of model.entities.values()) { if(e.type!=="IFCCARTESIANPOINT")continue; const p=point(e.id,model); if(p)out.push([p[0]*model.unitFactor,p[1]*model.unitFactor]); if(out.length>=4096)break; } return out; }
function point(ref, model) { const e=model.entities.get(ref); return e?.type==="IFCCARTESIANPOINT" ? numericTuples(args(e)[0])[0] || null : null; }
function directionVector(ref, model) { const e=model.entities.get(ref); return e?.type==="IFCDIRECTION" ? numericTuples(args(e)[0])[0] || null : null; }
function numericTuples(value) { return [...String(value||"").matchAll(/\(([-+\d.eE]+(?:\s*,\s*[-+\d.eE]+)+)\)/g)].map(m=>m[1].split(",").map(Number)).filter(v=>v.length>=2&&v.every(Number.isFinite)); }
function allRefs(value) { return [...String(value||"").matchAll(/#(\d+)/g)].map(m=>Number(m[1])); }
function refNumber(value) { const m=String(value||"").match(/^#(\d+)$/); return m?Number(m[1]):null; }
function numberValue(value) { const n=Number(String(value??"").replace(/[()]/g,"").trim()); return Number.isFinite(n)?n:null; }
function stringValue(value) { const v=String(value||"").trim(); return v.startsWith("'") ? v.slice(1,v.endsWith("'")?-1:undefined).replace(/''/g,"'").trim()||null : null; }
function transform2d([x,y], t) { const c=Math.cos(t.angle),s=Math.sin(t.angle); return [t.x+x*c-y*s,t.y+x*s+y*c]; }
function identity() { return {x:0,y:0,z:0,angle:0}; }
function closeRing(points) { if(points?.length&&(points[0][0]!==points.at(-1)[0]||points[0][1]!==points.at(-1)[1])) points.push([...points[0]]); return points||[]; }
function centroid(points) { return [points.reduce((s,p)=>s+p[0],0)/points.length,points.reduce((s,p)=>s+p[1],0)/points.length]; }
function applicationLocation(application) { const p=application.geometry?.type==="Point"?application.geometry.coordinates:null,lon=Number(p?.[0]??application.lon??application.lng??application.longitude),lat=Number(p?.[1]??application.lat??application.latitude); if(Number.isFinite(lon)&&Number.isFinite(lat))return{lon,lat}; const e=Number(application.easting),n=Number(application.northing); if(Number.isFinite(e)&&Number.isFinite(n)){const [lo,la]=proj4(BNG,"EPSG:4326",[e,n]);return{lon:lo,lat:la};} return null; }
function referencePoint(location, profile) { const fallback=profile?.bbox?bboxCenter(profile.bbox):null,selected=location||fallback; return selected?{location:{lon:selected.lon,lat:selected.lat},bng:proj4("EPSG:4326",BNG,[selected.lon,selected.lat])}:null; }
function empty(status,location,entities,diagnostics={}) { return {status,page:1,confidence:0,scale:null,location,origin:null,shapes:0,associatedShapes:0,nativeFormat:"ifc",registration:null,diagnostics:{entities,...diagnostics},collection:{type:"FeatureCollection",features:[]}}; }
function safe(value) { return String(value||"unknown").replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase(); }
function round(value) { return Number.isFinite(value)?Math.round(value*1000)/1000:null; }
