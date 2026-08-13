// TPMAP_PHASE30D_COMPREHENSIVE_PLAN_DATA
// Pure planning-drawing semantics shared by vector PDFs and raster/OCR plans.

const CONSTRUCTION_FENCE = /\b(?:tempor\w*|temp(?:orary)?|construction|contractor(?:s)?|site|building[ -]?site|works?)\s+(?:security\s+)?(?:fenc\w*|hoarding)|\b(?:fenc\w*|hoarding)\s+(?:to\s+)?(?:secur\w*|enclose|protect)\s+(?:the\s+)?(?:construction|building|work|site)|\bred\s+(?:construction\s+)?(?:fenc\w*)\b/i;
const PHYSICAL_FENCE = /\b(?:permanent\s+)?(?:fence|fencing|railings?|balustrade|guard\s*rail|pedestrian barrier)\b/i;
const SITE_BOUNDARY = /\b(?:application|planning|red line|site|ownership|land ownership|development)\s+boundary\b|\b(?:red|blue)\s+line\s+boundary\b/i;

export const COMPREHENSIVE_PLAN_CLASSES = Object.freeze([
  "ride-track", "ride-elevation", "ride-support", "ride-catwalk",
  "ride-evacuation-stair", "ride-maintenance-platform", "ride-handrail",
  "ride-fence", "ride-station-platform", "ride-access-path", "path", "plaza", "queue",
  "bridge", "boardwalk", "tunnel", "building", "building-level", "wall",
  "retaining-wall", "sound-screen", "fence", "railing", "water-body",
  "watercourse", "drainage", "water-level", "tree", "tree-canopy",
  "tree-protection", "woodland", "hedge", "shrub", "groundcover", "meadow",
  "rock", "rock-edge", "gabion", "terrain-contour", "terrain-level",
  "earthworks", "site-boundary", "excluded-construction-fence"
]);

export function classifyComprehensivePlanningLabel(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  const text = raw.toLowerCase();
  if (!text) return null;

  const state = plannedState(text);
  const dimensions = plannedDimensions(text);
  const material = plannedSurfaceMaterial(text);
  const common = { state, material, ...dimensions, rawLabel: raw };

  if (CONSTRUCTION_FENCE.test(text)) {
    return semantic("exclusion", "excluded-construction-fence", 1_000, common, {
      excludeFromWorld: true,
      exclusionReason: "temporary-construction-fence"
    });
  }
  if (SITE_BOUNDARY.test(text)) {
    return semantic("boundary", "site-boundary", 990, common, {
      evidenceOnly: true,
      evidenceUse: "registration-crop-and-planning-provenance"
    });
  }

  const rideContext = /\b(?:roller\s*coaster|coaster|ride|track|rail|alignment|attraction)\b/.test(text);
  const rideAttachment = classifyRideAttachment(text);
  if (rideAttachment) {
    return semantic("ride_attachment", rideAttachment.featureClass, 987, common, {
      attachmentType: rideAttachment.attachmentType,
      attachmentVerticalMode: rideAttachment.verticalMode,
      attachmentSide: rideAttachment.side
    });
  }
  const highLow = /(?:^|\b)(hp|lp|high point|low point)\b/.exec(text);
  if ((rideContext && hasLevel(text)) || (highLow && Number.isFinite(dimensions.levelM))) {
    return semantic("ride", "ride-elevation", 985, common, {
      pointRole: "ride-elevation-point-candidate",
      pointType: highLow?.[1]?.startsWith("l") ? "low-point" : highLow ? "high-point" : "track-level"
    });
  }
  if (/\b(?:ride|coaster|track)?\s*(?:support|column|stanchion|pier|pile|footing|base plate)\b/.test(text) &&
      (rideContext || /\b(?:support|stanchion|footing)\s+(?:no\.?\s*)?[a-z]?\d+\b/.test(text))) {
    return semantic("ride_support", "ride-support", 980, common, {
      pointRole: "ride-support-point-candidate"
    });
  }
  if (/\b(?:roller\s*coaster|coaster|ride layout|ride track|track alignment|track centreline|track centerline|running rail|ride footprint|attraction layout)\b/.test(text)) {
    return semantic("ride", "ride-track", 970, common);
  }

  if (/\b(?:finished floor level|finished slab level|ffl)\b/.test(text) && !/\b(?:bridge|footbri(?:dge|dde)|boardwalk|path|walkway)\b/.test(text)) {
    return semantic("building", "building-level", 965, common, {
      fflM: dimensions.levelM,
      pointRole: "building-level-point-candidate"
    });
  }
  if (/\b(?:station building|ride station|maintenance building|workshop|kiosk|restaurant|cafe|toilets?|shop|plant room|control room|operator cabin|service building|office|store|warehouse|building footprint|proposed building|existing building)\b/.test(text)) {
    return semantic("building", "building", 950, common);
  }

  if (/\b(?:acoustic|noise|sound)\s+(?:screen|barrier|fence|wall)\b/.test(text)) {
    return semantic("wall", "sound-screen", 945, common, { barrierType: "noise_barrier" });
  }
  if (/\bretaining\s+wall\b/.test(text)) return semantic("wall", "retaining-wall", 940, common, { vertical: "retaining" });
  if (/\b(?:boundary wall|screen wall|parapet|wall)\b/.test(text)) return semantic("wall", "wall", 935, common);
  if (PHYSICAL_FENCE.test(text)) {
    const railing = /\brailings?|balustrade|guard\s*rail\b/.test(text);
    return semantic("fence", railing ? "railing" : "fence", 930, common);
  }

  if (/\b(?:footbri(?:dge|dde)|bridge)\b/.test(text)) return semantic("bridge", "bridge", 925, common, { vertical: "bridge" });
  if (/\b(?:boardwalk|timber deck|raised walkway|raised path|elevated walkway|elevated path)\b/.test(text)) {
    return semantic("bridge", "boardwalk", 920, { ...common, material: material || "wood" }, { vertical: "raised" });
  }
  if (/\b(?:tunnel|underpass|subway|culvert)\b/.test(text)) return semantic("tunnel", "tunnel", 915, common, { vertical: "tunnel" });
  if (/\b(?:queue line|queue path|queueing|queuing)\b/.test(text)) return semantic("path", "queue", 910, common);
  if (/\b(?:plaza|courtyard|terrace|hardstanding|pedestrian square)\b/.test(text)) return semantic("path", "plaza", 905, common);
  if (/\b(?:path|footpath|walkway|paving|pedestrian|circulation|access route|access path|footway|steps|ramp)\b/.test(text)) {
    return semantic("path", "path", 900, common);
  }

  if (/\b(?:water level|top water level|normal water level|twl)\b/.test(text)) {
    return semantic("water", "water-level", 895, common, { pointRole: "water-level-point-candidate" });
  }
  if (/\b(?:pond|lake|pool|lagoon|water body|waterbody|basin|reservoir)\b/.test(text)) return semantic("water", "water-body", 890, common);
  if (/\b(?:stream|brook|river|watercourse|channel)\b/.test(text)) return semantic("water", "watercourse", 885, common);
  if (/\b(?:drain|drainage|ditch|swale|culvert|attenuation|outfall)\b/.test(text)) return semantic("water", "drainage", 880, common);

  if (/\b(?:tree protection area|tree protection zone|root protection area|rpa)\b/.test(text)) return semantic("vegetation", "tree-protection", 875, common, { evidenceOnly: true });
  if (/\b(?:tree canopy|canopy spread|crown spread|tree cover)\b/.test(text)) return semantic("vegetation", "tree-canopy", 870, common);
  if (/\b(?:woodland|wooded area|copse|tree belt)\b/.test(text)) return semantic("vegetation", "woodland", 865, common);
  if (/\b(?:hedge|hedgerow)\b/.test(text)) return semantic("vegetation", "hedge", 860, common);
  if (/\b(?:shrub|shrubs|shrubbery|ornamental planting)\b/.test(text)) return semantic("vegetation", "shrub", 855, common);
  if (/\b(?:groundcover|ground cover|planting bed|planted area|flower bed)\b/.test(text)) return semantic("vegetation", "groundcover", 850, common);
  if (/\b(?:wildflower meadow|meadow|amenity grass|grassland|lawn)\b/.test(text)) return semantic("vegetation", "meadow", 845, common);
  if (/\b(?:tree no\.?\s*[a-z]?\d+|individual tree|existing tree|retained tree|proposed tree|new tree)\b/.test(text)) {
    const individual = /\b(?:tree no\.?\s*[a-z]?\d+|individual tree|t\d+[a-z]?)\b/.test(text);
    return individual
      ? semantic("vegetation", "tree", 840, common, { pointRole: "tree-point-candidate" })
      : semantic("vegetation", "tree-canopy", 835, common);
  }
  if (/\btrees?\b/.test(text)) return semantic("vegetation", "tree-canopy", 835, common);

  if (/\bgabion(?:s| basket| wall)?\b/.test(text)) return semantic("rock", "gabion", 830, common);
  if (/\b(?:rock edge|rock face|cliff|crag|outcrop)\b/.test(text)) return semantic("rock", "rock-edge", 825, common);
  if (/\b(?:rockwork|boulder|boulders|rocks?)\b/.test(text)) return semantic("rock", "rock", 820, common);

  if (/\b(?:spot level|proposed level|existing level|ground level|formation level|invert level|cover level|rl)\b/.test(text) && hasLevel(text)) {
    return semantic("terrain", "terrain-level", 815, common, { pointRole: "terrain-level-point-candidate" });
  }
  if (/\b(?:contour|contours)\b/.test(text)) return semantic("terrain", "terrain-contour", 810, common);
  if (/\b(?:earthworks|embankment|cutting|slope|mound|bund|grading|graded|cut and fill)\b/.test(text)) return semantic("terrain", "earthworks", 805, common);

  return null;
}

export function comprehensiveSemanticGeometryRole(semanticValue, closed, shape = {}) {
  const semanticValueSafe = semanticValue || null;
  if (!semanticValueSafe) return null;
  const tags = comprehensiveSemanticTags(semanticValueSafe);
  const featureClass = semanticValueSafe.featureClass;
  if (semanticValueSafe.excludeFromWorld) return { excluded: true, reason: semanticValueSafe.exclusionReason, tags };
  if (featureClass === "site-boundary") return { role: "site-boundary-evidence-candidate", evidenceOnly: true, tags };
  if (semanticValueSafe.className === "path") return { role: closed ? "site-path-surface-candidate" : "site-path-centerline-candidate", tags };
  if (semanticValueSafe.className === "bridge") return { role: closed ? "site-bridge-surface-candidate" : "site-bridge-centerline-candidate", tags };
  if (semanticValueSafe.className === "tunnel") return { role: closed ? "site-tunnel-surface-candidate" : "site-tunnel-centerline-candidate", tags };
  if (semanticValueSafe.className === "ride") return { role: closed ? "ride-footprint-candidate" : "ride-centerline-candidate", tags };
  if (semanticValueSafe.className === "ride_support") return { role: closed ? "site-ride-support-footing-candidate" : "site-ride-support-candidate", tags };
  if (semanticValueSafe.className === "ride_attachment") return {
    role: closed ? "ride-attachment-surface-candidate" : "ride-attachment-centerline-candidate",
    tags
  };
  if (semanticValueSafe.className === "building") return closed ? { role: "site-building-footprint-candidate", tags } : null;
  if (semanticValueSafe.className === "wall") return { role: closed ? "site-wall-footprint-candidate" : "site-wall-candidate", tags };
  if (semanticValueSafe.className === "fence") return { role: closed ? "site-fence-footprint-candidate" : "site-fence-candidate", tags };
  if (semanticValueSafe.className === "water") return { role: closed ? "site-water-body-candidate" : "site-watercourse-candidate", tags };
  if (semanticValueSafe.className === "vegetation") {
    if (featureClass === "tree" && closed && likelySymbol(shape)) return { role: "site-tree-canopy-candidate", tags };
    return { role: closed ? "site-vegetation-area-candidate" : "site-vegetation-boundary-candidate", evidenceOnly: semanticValueSafe.evidenceOnly, tags };
  }
  if (semanticValueSafe.className === "rock") return { role: closed ? "site-rock-area-candidate" : "site-rock-line-candidate", tags };
  if (semanticValueSafe.className === "terrain") return { role: closed ? "site-terrain-change-area-candidate" : "site-terrain-change-line-candidate", tags };
  return null;
}

export function comprehensiveSemanticTags(semanticValue) {
  const tags = {
    planning_semantic_class: semanticValue.className,
    planning_feature_class: semanticValue.featureClass,
    planning_feature_state: semanticValue.state || "unspecified"
  };
  const numeric = {
    elevation_m: semanticValue.levelM,
    ffl_m: semanticValue.fflM,
    height_m: semanticValue.heightM,
    width: semanticValue.widthM,
    diameter_m: semanticValue.diameterM,
    canopy_diameter_m: semanticValue.canopyDiameterM
  };
  for (const [key, value] of Object.entries(numeric)) if (Number.isFinite(value)) tags[key] = value;
  if (semanticValue.material) tags.surface = semanticValue.material;
  if (semanticValue.vertical) tags.planning_vertical_relationship = semanticValue.vertical;
  if (semanticValue.pointType) tags.planning_elevation_point_type = semanticValue.pointType;
  if (semanticValue.className === "path") tags.highway = semanticValue.featureClass === "queue" ? "footway" : "pedestrian";
  if (semanticValue.className === "bridge") { tags.highway = "footway"; tags.bridge = "yes"; tags.layer = 1; }
  if (semanticValue.className === "tunnel") { tags.highway = "footway"; tags.tunnel = "yes"; tags.layer = -1; tags.location = "underground"; }
  if (semanticValue.className === "ride") tags.roller_coaster = "track";
  if (semanticValue.className === "ride_support") { tags.roller_coaster = "support"; tags.man_made = "support"; }
  if (semanticValue.className === "ride_attachment") {
    tags.man_made = "ride_attachment";
    tags.ride_attachment = semanticValue.attachmentType || semanticValue.featureClass.replace(/^ride-/, "");
    tags.ride_attachment_vertical_mode = semanticValue.attachmentVerticalMode || "terrain-following";
    if (semanticValue.attachmentSide) tags.ride_attachment_side = semanticValue.attachmentSide;
  }
  if (semanticValue.className === "building") tags.building = "yes";
  if (semanticValue.className === "wall") tags.barrier = semanticValue.barrierType || "wall";
  if (semanticValue.className === "fence") tags.barrier = semanticValue.featureClass === "railing" ? "railing" : "fence";
  if (semanticValue.className === "water") { tags.natural = "water"; tags.water = semanticValue.featureClass; }
  if (semanticValue.className === "vegetation") {
    if (semanticValue.featureClass === "hedge") tags.barrier = "hedge";
    else if (["woodland", "tree-canopy"].includes(semanticValue.featureClass)) tags.landcover = "trees";
    else if (semanticValue.featureClass === "tree") tags.natural = "tree";
    else tags.landcover = semanticValue.featureClass;
  }
  if (semanticValue.className === "rock") tags.natural = semanticValue.featureClass === "rock-edge" ? "cliff" : "rock";
  if (semanticValue.className === "terrain") tags.planning_terrain_change = semanticValue.featureClass;
  if (semanticValue.evidenceOnly) tags.render_in_world = false;
  if (semanticValue.excludeFromWorld) {
    tags.planning_exclude_from_world = true;
    tags.planning_exclusion_reason = semanticValue.exclusionReason;
    tags.render_in_world = false;
  }
  return tags;
}

export function associateComprehensivePlanningLabel(shape, anchors, radius) {
  let best = null;
  for (const anchor of anchors || []) {
    const semanticValue = anchor?.semantic;
    if (!semanticValue) continue;
    const distance = distanceAnchorToShape(anchor, shape);
    if (!Number.isFinite(distance) || distance > radius) continue;
    const compatibility = geometryCompatibility(semanticValue, shape);
    if (compatibility === -Infinity) continue;
    const contained = shape.closed && pointInsidePolygon({ x: anchor.cx, y: anchor.cy }, shape.points);
    const redCorroboration = semanticValue.excludeFromWorld && isRed(shape.stroke) ? 35 : 0;
    const score = distance - semanticValue.priority * 0.08 - compatibility - (contained ? 28 : 0) - redCorroboration;
    if (!best || score < best.score) best = { anchor, distance, score, contained, compatibility };
  }
  return best;
}

export function comprehensivePointRole(semanticValue) {
  if (!semanticValue?.pointRole || semanticValue.excludeFromWorld) return null;
  const mapping = {
    "ride-elevation-point-candidate": { role: "ride-elevation-point-candidate", tags: comprehensiveSemanticTags(semanticValue) },
    "ride-support-point-candidate": { role: "site-ride-support-point-candidate", tags: comprehensiveSemanticTags(semanticValue) },
    "building-level-point-candidate": { role: "site-building-level-point-candidate", tags: comprehensiveSemanticTags(semanticValue) },
    "water-level-point-candidate": { role: "site-water-level-point-candidate", tags: comprehensiveSemanticTags(semanticValue) },
    "tree-point-candidate": { role: "site-tree-point-candidate", tags: comprehensiveSemanticTags(semanticValue) },
    "terrain-level-point-candidate": { role: "site-terrain-level-point-candidate", tags: comprehensiveSemanticTags(semanticValue) }
  };
  return mapping[semanticValue.pointRole] || null;
}

export function mergePlanningSemanticAnchors(...collections) {
  const anchors = [];
  const seen = new Set();
  for (const collection of collections) {
    for (const anchor of collection?.anchors || []) {
      const key = `${anchor.semantic?.featureClass}:${Number(anchor.cx).toFixed(1)}:${Number(anchor.cy).toFixed(1)}:${String(anchor.text).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push(anchor);
    }
  }
  return { anchors, source: collections.map((item) => item?.source).filter(Boolean).join("+") || "unavailable" };
}

function semantic(className, featureClass, priority, common, extra = {}) {
  return { className, featureClass, priority, ...common, ...extra };
}

function classifyRideAttachment(text) {
  const side = /\bboth\s+sides?\b/.test(text) ? "both"
    : /\bleft(?:-hand)?\b/.test(text) ? "left"
      : /\bright(?:-hand)?\b/.test(text) ? "right" : null;
  if (/\b(?:catwalk|inspection walkway|maintenance walkway|service walkway|evacuation walkway|emergency walkway|track access walkway)\b/.test(text)) {
    return { featureClass: "ride-catwalk", attachmentType: "catwalk", verticalMode: "track-relative", side };
  }
  if (/\b(?:evacuation|emergency|ride|coaster|track|maintenance)\s+(?:access\s+)?(?:stairs?|steps?|stairway|staircase)\b/.test(text)) {
    return { featureClass: "ride-evacuation-stair", attachmentType: "evacuation_stair", verticalMode: "terrain-following", side };
  }
  if ((/\b(?:handrail|hand rail|guardrail|guard rail|balustrade|safety railing)\b/.test(text) &&
      /\b(?:ride|coaster|track|catwalk|platform|station)\b/.test(text))) {
    return { featureClass: "ride-handrail", attachmentType: "handrail", verticalMode: "track-relative", side };
  }
  if (/\bstation\s+(?:boarding\s+|unloading\s+|ride\s+)?platform\b/.test(text)) {
    return { featureClass: "ride-station-platform", attachmentType: "station_platform", verticalMode: "track-relative", side };
  }
  if (/\b(?:ride|coaster|track|maintenance|inspection|evacuation|rescue)\s+(?:access\s+)?platform\b/.test(text)) {
    return { featureClass: "ride-maintenance-platform", attachmentType: "maintenance_platform", verticalMode: "track-relative", side };
  }
  if ((/\b(?:fence|fencing)\b/.test(text) && /\b(?:ride|coaster|track|attraction)\b/.test(text))) {
    return { featureClass: "ride-fence", attachmentType: "fence", verticalMode: "terrain-following", side };
  }
  if (/\b(?:ride|coaster|track|maintenance|emergency|evacuation)\s+(?:service\s+)?access\s+(?:path|route|way)\b/.test(text)) {
    return { featureClass: "ride-access-path", attachmentType: "access_path", verticalMode: "terrain-following", side };
  }
  return null;
}

function plannedState(text) {
  if (/\b(?:to be removed|removed|demolished|felled|lost)\b/.test(text)) return "removed";
  if (/\b(?:retained|to remain|protected)\b/.test(text)) return "retained";
  if (/\b(?:existing|extant|current)\b/.test(text)) return "existing";
  if (/\b(?:proposed|new|replacement)\b/.test(text)) return "proposed";
  if (/\btemporary\b/.test(text)) return "temporary";
  return "unspecified";
}

function plannedDimensions(text) {
  const levelM = firstNumber(text, [
    /(?:\bffl\b|\brl\b|\bhp\b|\blp\b|high point|low point|track level|rail level|water level|spot level|proposed level|existing level|ground level|formation level|invert level)\s*[:=+]?\s*(\d{1,3}(?:\.\d{1,3})?)/i,
    /\b(\d{2,3}\.\d{1,3})\s*m?\s*(?:aod)?\b/i
  ], 10, 500);
  const heightM = firstNumber(text, [/(\d+(?:\.\d+)?)\s*m\s*(?:high|height|ht)\b/i, /(?:height|ht)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*m\b/i], 0.1, 100);
  const widthM = firstNumber(text, [/(\d+(?:\.\d+)?)\s*m\s*(?:wide|width)\b/i, /(?:width|wide)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*m\b/i], 0.1, 100);
  const diameterM = firstNumber(text, [/(?:diameter|dia\.?|ø)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*m\b/i, /(\d+(?:\.\d+)?)\s*m\s*(?:diameter|dia\.?)\b/i], 0.1, 100);
  const canopyDiameterM = firstNumber(text, [/(?:canopy|crown)\s*(?:diameter|spread)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*m\b/i], 0.1, 100);
  return { levelM, heightM, widthM, diameterM, canopyDiameterM };
}

function hasLevel(text) { return Number.isFinite(plannedDimensions(text).levelM); }
function firstNumber(text, patterns, min, max) {
  for (const pattern of patterns) {
    const value = Number(String(text).match(pattern)?.[1]);
    if (Number.isFinite(value) && value >= min && value <= max) return value;
  }
  return null;
}

function plannedSurfaceMaterial(text) {
  if (/\b(?:tarmac|asphalt|bitmac)\b/.test(text)) return "asphalt";
  if (/\bresin(?: bound| bonded)?\b/.test(text)) return "resin";
  if (/\b(?:block paving|pavers?|paving slabs?|flagstones?|flags)\b/.test(text)) return "paving_stones";
  if (/\bconcrete\b/.test(text)) return "concrete";
  if (/\b(?:gravel|hoggin|self binding gravel)\b/.test(text)) return "gravel";
  if (/\b(?:timber|wood|boardwalk)\b/.test(text)) return "wood";
  if (/\bcobble(?:stone)?s?\b/.test(text)) return "cobblestone";
  if (/\bbrick\b/.test(text)) return "brick";
  if (/\bstone\b/.test(text)) return "stone";
  return null;
}

function geometryCompatibility(semanticValue, shape) {
  if (semanticValue.className === "building" && !shape.closed) return -Infinity;
  if (["tree", "ride-support"].includes(semanticValue.featureClass) && shape.closed && likelySymbol(shape)) return 35;
  if (semanticValue.className === "ride_attachment") return shape.closed ? 20 : 24;
  if (["path", "bridge", "tunnel", "wall", "fence"].includes(semanticValue.className) && !shape.closed) return 18;
  if (["water", "vegetation", "rock", "building"].includes(semanticValue.className) && shape.closed) return 15;
  if (semanticValue.featureClass === "terrain-contour" && !shape.closed) return 20;
  return 0;
}

function likelySymbol(shape) {
  if (!shape?.closed || shape.points?.length < 5) return false;
  const xs = shape.points.map((point) => point.x), ys = shape.points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
  return width > 0 && height > 0 && Math.max(width, height) / Math.min(width, height) < 1.8;
}

function isRed(value) {
  const text = String(value || "").toLowerCase();
  if (/\bred\b/.test(text)) return true;
  const hex = text.match(/#([0-9a-f]{6})\b/)?.[1];
  if (hex) return parseInt(hex.slice(0, 2), 16) > 150 && parseInt(hex.slice(2, 4), 16) < 120 && parseInt(hex.slice(4, 6), 16) < 120;
  const rgb = text.match(/rgb\s*\(\s*(\d+)\D+(\d+)\D+(\d+)/);
  return rgb ? Number(rgb[1]) > 150 && Number(rgb[2]) < 120 && Number(rgb[3]) < 120 : false;
}

function distanceAnchorToShape(anchor, shape) {
  const point = { x: anchor.cx, y: anchor.cy };
  if (shape.closed && pointInsidePolygon(point, shape.points)) return 0;
  let best = Infinity;
  for (let index = 1; index < shape.points.length; index += 1) best = Math.min(best, pointSegmentDistance(point, shape.points[index - 1], shape.points[index]));
  if (shape.closed && shape.points.length > 2) best = Math.min(best, pointSegmentDistance(point, shape.points.at(-1), shape.points[0]));
  return best;
}

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y, length2 = dx * dx + dy * dy;
  if (!length2) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function pointInsidePolygon(point, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index], b = points[previous];
    if (((a.y > point.y) !== (b.y > point.y)) && point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}
