const TAU = Math.PI * 2;

/**
 * Resolve trunk cross-section / bark architecture without changing authoritative
 * DBH. Explicit tree survey/arboricultural evidence wins; inference only varies
 * shape inside a bounded equivalent-area envelope.
 */
export function resolveTreeStemArchitecture({ dbhM, species, genus, tags = {}, structuralForm = null, seed = 0 } = {}) {
  const dbh = clamp(Number(dbhM) || 0.3, 0.08, 4.5);
  const explicitForm = normalizeForm(first(tags, ["tree:trunk_form", "trunk_form", "tpmap:trunk_form"]));
  const hollow = explicitBoolean(first(tags, ["tree:hollow", "hollow", "tpmap:hollow_trunk"]));
  const hollowDiameter = finite(first(tags, ["tree:hollow_diameter", "tpmap:hollow_diameter_m"]));
  const explicitStemCount = clampInt(first(tags, ["tree:stem_count", "stem_count", "tpmap:stem_count"]), 1, 8);
  const veteranLike = ["veteran", "damaged", "multi-stem", "pollarded"].includes(structuralForm?.form);
  const taxon = `${species || ""} ${genus || ""}`.toLowerCase();

  let form = explicitForm || "round";
  let ellipticity = 1;
  let fluting = 0;
  if (!explicitForm) {
    if (structuralForm?.form === "multi-stem") form = "split";
    else if (veteranLike && dbh >= 0.75) form = "irregular";
    else if (/hornbeam|carpinus|yew|taxus|sweet chestnut|castanea/.test(taxon) && dbh >= 0.55) form = "fluted";
    else if (dbh >= 1.15) form = "elliptical";
  }

  if (form === "elliptical") ellipticity = boundedNoise(seed, 1.12, veteranLike ? 1.38 : 1.26);
  if (form === "irregular") {
    ellipticity = boundedNoise(seed ^ 0x51f15e, 1.12, 1.42);
    fluting = clamp(2 + Math.floor(noise(seed, 3) * 4), 2, 5);
  }
  if (form === "fluted") fluting = clamp(3 + Math.floor(noise(seed, 7) * 4), 3, 6);

  const inferredHollow = hollow == null && veteranLike && dbh >= 1.0 && noise(seed, 17) > 0.72;
  const hollowObserved = hollow === true || Number.isFinite(hollowDiameter);
  const hasHollow = hollow === false ? false : hollowObserved || inferredHollow;
  const hollowRadiusM = hasHollow
    ? clamp(Number.isFinite(hollowDiameter) ? hollowDiameter / 2 : dbh * (0.12 + noise(seed, 19) * 0.10), 0.08, dbh * 0.32)
    : 0;

  const stemCount = explicitStemCount || (form === "split" ? Math.max(2, structuralForm?.stemCount || 2) : Math.max(1, structuralForm?.stemCount || 1));
  const barkCharacter = barkCharacterForTaxon(taxon, structuralForm?.form);

  return {
    source: explicitForm || hollowObserved || explicitStemCount ? "explicit-stem-evidence" : "morphology-inference",
    observed: Boolean(explicitForm || hollowObserved || explicitStemCount),
    form,
    equivalentDbhM: round3(dbh),
    ellipticity: round3(ellipticity),
    fluting,
    hollow: hasHollow,
    hollowObserved,
    hollowRadiusM: round3(hollowRadiusM),
    stemCount,
    barkCharacter,
    confidence: explicitForm || hollowObserved || explicitStemCount ? 0.97 : veteranLike ? 0.66 : 0.52
  };
}

/** Equivalent-area elliptical / fluted cross-section test. */
export function insideStemCrossSection(dx, dz, radiusBlocks, architecture, layer = 0) {
  const radius = Math.max(0.45, Number(radiusBlocks) || 0.45);
  const e = clamp(Number(architecture?.ellipticity) || 1, 1, 1.5);
  // Preserve approximate cross-sectional area while changing aspect ratio.
  const rx = radius * Math.sqrt(e);
  const rz = radius / Math.sqrt(e);
  const angle = (hash(`${architecture?.form}:${architecture?.stemCount}`) % 6283) / 1000;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const ux = dx * ca + dz * sa;
  const uz = -dx * sa + dz * ca;
  const theta = Math.atan2(uz / Math.max(0.1, rz), ux / Math.max(0.1, rx));
  const flute = architecture?.fluting ? 1 + 0.10 * Math.sin(theta * architecture.fluting + layer * 0.22) : 1;
  const norm = Math.sqrt((ux / (rx * flute + 0.20)) ** 2 + (uz / (rz * flute + 0.20)) ** 2);
  if (norm > 1) return false;

  if (architecture?.hollow && radius >= 1.4 && layer > 1) {
    const hollowRatio = clamp((architecture.hollowRadiusM || 0) / Math.max(0.08, architecture.equivalentDbhM / 2), 0.12, 0.55);
    const inner = norm / Math.max(0.01, hollowRatio);
    if (inner < 1 && dz <= 0) return false; // open/weathered cavity on one face
  }
  return true;
}

export function barkDetailBlock({ preset, architecture, x, y, z, seed = 0 }) {
  const base = preset?.trunk || ["oak_log"];
  const branches = preset?.branches || base;
  const n = hash(`${seed}:${x}:${y}:${z}:${architecture?.barkCharacter}`);
  if (architecture?.barkCharacter === "pale-peeling" && n % 11 === 0) return branches[n % branches.length];
  if (architecture?.barkCharacter === "deep-fissured" && n % 7 === 0) return branches[n % branches.length];
  if (architecture?.barkCharacter === "smooth" && n % 17 === 0) return branches[n % branches.length];
  return base[n % base.length];
}

function barkCharacterForTaxon(taxon, form) {
  if (/birch|betula/.test(taxon)) return "pale-peeling";
  if (/beech|fagus/.test(taxon)) return "smooth";
  if (/pine|pinus|spruce|picea|oak|quercus|chestnut|castanea/.test(taxon)) return "deep-fissured";
  if (form === "veteran" || form === "damaged") return "weathered";
  return "mixed-bark";
}
function normalizeForm(v) {
  const s = String(v || "").toLowerCase().replace(/[_ ]+/g, "-");
  if (/multi|split|fork/.test(s)) return "split";
  if (/flut|rib/.test(s)) return "fluted";
  if (/oval|ellip/.test(s)) return "elliptical";
  if (/irregular|veteran|gnarl/.test(s)) return "irregular";
  if (/round|single/.test(s)) return "round";
  return null;
}
function explicitBoolean(v) {
  if (v == null || v === "") return null;
  if ([true, 1, "1", "yes", "true", "hollow"].includes(v)) return true;
  if ([false, 0, "0", "no", "false", "solid"].includes(v)) return false;
  return null;
}
function first(o, keys) { for (const k of keys) if (o?.[k] != null && o[k] !== "") return o[k]; return null; }
function finite(v) {
  if (v == null || v === "" || (typeof v === "string" && !v.trim())) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function clampInt(v, min, max) {
  if (v == null || v === "" || (typeof v === "string" && !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(Math.round(n), min, max) : null;
}
function noise(seed, salt) { return (hash(`${seed}:${salt}`) % 10000) / 9999; }
function boundedNoise(seed, min, max) { return min + noise(seed, 41) * (max - min); }
function hash(text) { let h = 2166136261 >>> 0; for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round3(v) { return Math.round(v * 1000) / 1000; }
