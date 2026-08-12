const TAU = Math.PI * 2;

export function resolveTreeFoliageMicrostructure({ preset, species, genus, leafType, structuralForm, reconstruction, tags = {} } = {}) {
  const taxon = `${species || ""} ${genus || ""}`.toLowerCase();
  const shape = String(preset?.crownShape || "irregular-round");
  const family = String(preset?.family || "broadleaf");
  const explicitDensity = finite(first(tags, ["tree:foliage_density", "foliage_density", "tpmap:foliage_density"]));
  const observedCoverage = finite(reconstruction?.coverageRatio ?? reconstruction?.coverage_ratio);
  const baseDensity = clamp(explicitDensity ?? observedCoverage ?? Number(preset?.canopyDensity) || 0.76, 0.24, 0.98);
  const structuralScale = clamp(Number(structuralForm?.canopyDensityScale) || 1, 0.35, 1.2);
  const density = clamp(baseDensity * structuralScale, 0.18, 0.98);

  let padStyle = family === "conifer" ? "tiered-spray" : "clustered-pad";
  let horizontalScale = family === "conifer" ? 1.25 : 1.0;
  let verticalScale = family === "conifer" ? 0.62 : 0.78;
  let droop = Number(preset?.branchDroop) || 0;
  let gapFraction = clamp(0.10 + (1 - density) * 0.42, 0.08, 0.46);
  let hangingFraction = 0;
  let edgeFeather = 0.28;

  if (/willow|salix/.test(taxon) || shape === "weeping") {
    padStyle = "hanging-curtain";
    horizontalScale = 0.82;
    verticalScale = 1.35;
    droop = Math.max(droop, 0.42);
    hangingFraction = 0.58;
    gapFraction = clamp(gapFraction + 0.06, 0.12, 0.5);
  } else if (/pine|pinus/.test(taxon) || shape === "open-conifer") {
    padStyle = "open-needle-pad";
    horizontalScale = 1.48;
    verticalScale = 0.48;
    gapFraction = clamp(gapFraction + 0.12, 0.18, 0.58);
    edgeFeather = 0.40;
  } else if (/spruce|picea/.test(taxon) || shape === "conical") {
    padStyle = "tiered-spray";
    horizontalScale = 1.30;
    verticalScale = 0.55;
    gapFraction = clamp(gapFraction - 0.03, 0.07, 0.38);
  } else if (/birch|betula/.test(taxon)) {
    padStyle = "light-feathered-pad";
    horizontalScale = 0.88;
    verticalScale = 0.9;
    gapFraction = clamp(gapFraction + 0.1, 0.16, 0.54);
    hangingFraction = 0.12;
  } else if (/beech|fagus/.test(taxon)) {
    padStyle = "layered-broad-pad";
    horizontalScale = 1.15;
    verticalScale = 0.72;
    gapFraction = clamp(gapFraction - 0.04, 0.06, 0.35);
  } else if (/oak|quercus/.test(taxon) || /wide-irregular/.test(shape)) {
    padStyle = "lobed-broad-pad";
    horizontalScale = 1.2;
    verticalScale = 0.82;
    gapFraction = clamp(gapFraction + (structuralForm?.form === "veteran" ? 0.09 : 0), 0.1, 0.48);
  }

  const deadwood = clamp(Number(structuralForm?.deadwoodFraction) || 0, 0, 0.55);
  const liveTipFraction = clamp(1 - deadwood * 0.72, 0.55, 1);
  const scaffoldFraction = family === "conifer" ? 0.16 : 0.10;

  return {
    source: explicitDensity != null ? "explicit-foliage-density" : observedCoverage != null ? "lidar-canopy-coverage" : "species-morphology",
    observed: explicitDensity != null || observedCoverage != null,
    padStyle,
    density: round3(density),
    gapFraction: round3(gapFraction),
    horizontalScale: round3(horizontalScale),
    verticalScale: round3(verticalScale),
    droop: round3(droop),
    hangingFraction: round3(hangingFraction),
    edgeFeather: round3(edgeFeather),
    liveTipFraction: round3(liveTipFraction),
    scaffoldFraction: round3(scaffoldFraction)
  };
}

export function foliagePadRadii(micro, crownRadius, seed = 0, index = 0) {
  const r = Math.max(1, Number(crownRadius) || 1);
  const n1 = noise(seed, index * 7 + 1);
  const n2 = noise(seed, index * 7 + 2);
  const horizontal = clamp(Math.round(r * 0.18 * (micro?.horizontalScale || 1) * (0.75 + n1 * 0.55)), 1, Math.max(1, Math.ceil(r * 0.45)));
  const vertical = clamp(Math.round(horizontal * (micro?.verticalScale || 0.8) * (0.78 + n2 * 0.38)), 1, 4);
  const lateral = clamp(Math.round(horizontal * (0.82 + noise(seed, index * 7 + 3) * 0.38)), 1, Math.max(1, Math.ceil(r * 0.45)));
  return { radiusX: horizontal, radiusY: vertical, radiusZ: lateral };
}

export function shouldKeepFoliageCell({ normalized, rough, micro, edgeBias = 0 }) {
  const density = clamp(Number(micro?.density) || 0.75, 0.1, 1);
  const gap = clamp(Number(micro?.gapFraction) || 0.15, 0, 0.7);
  const edgeFeather = clamp(Number(micro?.edgeFeather) || 0.25, 0, 0.7);
  if (normalized > 1.08 + edgeBias) return false;
  const interiorGap = normalized < 0.56 && rough < gap * 0.52;
  if (interiorGap) return false;
  const edgePenalty = Math.max(0, normalized - 0.62) * edgeFeather;
  return rough <= clamp(density - edgePenalty, 0.08, 0.99);
}

export function foliageCurtainLength(micro, treeHeight, seed, index) {
  const fraction = clamp(Number(micro?.hangingFraction) || 0, 0, 0.8);
  if (fraction <= 0) return 0;
  const max = Math.max(2, Math.round(treeHeight * (0.12 + fraction * 0.3)));
  return clamp(1 + Math.floor(noise(seed, index * 11 + 5) * max), 1, max);
}

function first(o, keys) { for (const k of keys) if (o?.[k] != null && o[k] !== "") return o[k]; return null; }
function finite(v) { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function noise(seed, salt) { return (hash(`${seed}:${salt}`) % 10000) / 9999; }
function hash(text) { let h = 2166136261 >>> 0; for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round3(v) { return Math.round(v * 1000) / 1000; }
