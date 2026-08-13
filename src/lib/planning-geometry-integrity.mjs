// Fail-closed filters for automatic raster planning geometry. Planning documents
// remain evidence even when their drawing view is not safe to georeference as a
// plan. These checks prevent title blocks, schedules, elevations, sections and
// text glyph contours from becoming world geometry.

const PLAN_VIEW = /\b(?:site\s+(?:plan|layout)|master\s*plan|general\s+arrangement|(?:existing|proposed|as[- ]?built|record)\s+(?:site\s+)?(?:plan|layout)|plan\s+as\s+(?:existing|proposed)|landscape\s+plan|planting\s+plan|drainage(?:\s+strategy)?\s+plan|earthworks?\s+plan|track\s+(?:plan|layout|alignment)|ride\s+(?:plan|layout)|support\s+(?:plan|layout)|foundation\s+(?:plan|layout)|floor\s+plan|roof\s+plan)\b/i;
const NON_PLAN_VIEW = /\b(?:elevations?|sections?|maintenance\s+schedule|schedules?|reports?|statements?|specifications?|legends?|drawing\s+key|key\s+plan|notes?\s+sheet|typical\s+details?|detail\s+sheet)\b/i;
const PLAN_ROLES = new Set([
  "site-layout", "ride-layout-and-structure", "landscape-and-vegetation",
  "materials-and-surfaces", "water-and-drainage", "structures-and-earthworks",
  "as-built-drawing"
]);
const POSTCODE = /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const METADATA = /\b(?:drawing\s*(?:no|number)|revision|rev\.?\s*[a-z0-9]+|drawn\s+by|checked\s+by|approved\s+by|client|architect|consultant|copyright|project\s+title|sheet\s+(?:no|number|size)|scale\s*(?:1|@)|telephone|phone|email|www\.|document\s+status)\b/i;
const LOCATIVE = /\b(?:existing|proposed|retained|new|track|alignment|building|station|path|walkway|plaza|queue|bridge|boardwalk|tunnel|wall|fence|railing|tree|woodland|hedge|pond|lake|watercourse|channel|drainage|rock|contour|level|support|catwalk|platform|footing|foundation)\b/i;

export function classifyPlanningGeometryView({ document = {}, rawLines = [] } = {}) {
  const title = `${document.title || ""} ${document.description || ""}`.replace(/\s+/g, " ").trim();
  const role = String(document.role || "planning-document").toLowerCase();
  const pageText = rawLines.map((line) => line?.text || line || "").join(" ").replace(/\s+/g, " ");
  const titlePlan = PLAN_VIEW.test(title);
  const titleNonPlan = NON_PLAN_VIEW.test(title);
  const pagePlan = PLAN_VIEW.test(pageText);

  if (role === "elevations-and-sections" && !titlePlan) {
    return { eligible: false, status: "evidence-only", reason: "document-role-elevations-and-sections" };
  }
  if (titleNonPlan && !titlePlan) {
    return { eligible: false, status: "evidence-only", reason: "document-title-non-plan-view" };
  }
  if (titlePlan) return { eligible: true, status: "plan-view", reason: "document-title-plan-view" };
  if (PLAN_ROLES.has(role)) {
    if (role === "water-and-drainage" && /\bschedule\b/i.test(title)) {
      return { eligible: false, status: "evidence-only", reason: "drainage-schedule-not-plan-view" };
    }
    return { eligible: true, status: "plan-view", reason: `document-role-${role}` };
  }
  if (pagePlan) return { eligible: true, status: "plan-view", reason: "page-title-plan-view" };
  return { eligible: false, status: "evidence-only", reason: "plan-view-not-established" };
}

export function planningTextBoxes(rawLines = []) {
  return rawLines.flatMap((line) => {
    const xMin = Number(line?.xMin), yMin = Number(line?.yMin), xMax = Number(line?.xMax), yMax = Number(line?.yMax);
    const confidence = Number(line?.ocrConfidence ?? 1);
    if (![xMin, yMin, xMax, yMax].every(Number.isFinite) || xMax <= xMin || yMax <= yMin || confidence < 0.7) return [];
    return [{ xMin, yMin, xMax, yMax, width: xMax - xMin, height: yMax - yMin, text: String(line?.text || "") }];
  });
}

export function rasterShapeLooksLikeText(shape, textBoxes = []) {
  const bounds = shapeBounds(shape);
  if (!bounds) return false;
  for (const box of textBoxes) {
    if (!box.text || box.text.trim().length < 2) continue;
    const pad = Math.max(1.5, Math.min(4, box.height * 0.18));
    if (bounds.minX < box.xMin - pad || bounds.maxX > box.xMax + pad ||
        bounds.minY < box.yMin - pad || bounds.maxY > box.yMax + pad) continue;
    const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
    if (shape.closed) {
      const smallGlyph = height <= Math.max(8, box.height * 1.9) && width <= Math.max(12, box.height * 2.8);
      const areaRatio = (width * height) / Math.max(1, box.width * box.height);
      if (smallGlyph || (height <= box.height * 2.2 && areaRatio <= 0.24)) return true;
    } else {
      const length = shapeLength(shape);
      if (length <= Math.max(12, box.height * 3.2)) return true;
    }
  }
  return false;
}

export function isPlanningGeometryAnchor(anchor, parsed) {
  if (!baseAnchorAllowed(anchor, parsed)) return false;
  if (anchor?.semantic?.featureClass === "ride-elevation") return false;
  return true;
}

export function isPlanningPointAnchor(anchor, parsed) {
  return baseAnchorAllowed(anchor, parsed);
}

export function planningShapeGeometryAllowed(shape, semantic, metresPerPixel) {
  const bounds = shapeBounds(shape);
  if (!bounds || !(metresPerPixel > 0)) return false;
  const widthM = (bounds.maxX - bounds.minX) * metresPerPixel;
  const heightM = (bounds.maxY - bounds.minY) * metresPerPixel;
  const spanM = Math.max(widthM, heightM);
  if (!Number.isFinite(spanM) || spanM < 0.02) return false;

  const className = String(semantic?.className || "");
  if (className === "building" && spanM > 250) return false;
  if (className === "ride_support" && spanM > 120) return false;
  if (className === "ride_attachment" && spanM > 400) return false;

  if (shape.closed && widthM > 0 && heightM > 0) {
    const fill = (shapeArea(shape) * metresPerPixel * metresPerPixel) / (widthM * heightM);
    if (className === "building" && spanM > 40 && fill < 0.012) return false;
    if (!["path", "bridge", "tunnel", "wall", "fence", "terrain"].includes(className) &&
        spanM > 300 && fill < 0.0025) return false;
  }
  return true;
}

function baseAnchorAllowed(anchor, parsed) {
  const semantic = anchor?.semantic;
  if (!semantic) return false;
  const text = String(anchor.text || "").replace(/\s+/g, " ").trim();
  if (!text || looksLikeDocumentMetadata(text)) return false;
  if (/\b(?:legend|key)\b|\bindicated\s+(?:thus|as)\b/i.test(text)) return false;
  const cx = Number(anchor.cx), cy = Number(anchor.cy);
  const inTitleMargin = Number.isFinite(cx) && Number.isFinite(cy) &&
    (cx > parsed.width * 0.78 || cy > parsed.height * 0.88);
  return !inTitleMargin || LOCATIVE.test(text);
}

function looksLikeDocumentMetadata(text) {
  if (POSTCODE.test(text) || METADATA.test(text)) return true;
  if (/\b(?:road|street|lane|avenue|drive|close|court|house)\b/i.test(text) && /[,\d]/.test(text) && text.length > 18) return true;
  return false;
}

function shapeBounds(shape) {
  const points = shape?.points || [];
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function shapeArea(shape) {
  const points = shape?.points || [];
  let area = 0;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    area += points[previous].x * points[index].y - points[index].x * points[previous].y;
  }
  return Math.abs(area / 2);
}

function shapeLength(shape) {
  const points = shape?.points || [];
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}
