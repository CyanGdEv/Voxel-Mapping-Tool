const DEG = Math.PI / 180;

/**
 * Resolve evidence-bounded woody branch architecture from DBH/species/form.
 * DBH remains authoritative; this module only distributes that woody mass into
 * primary/secondary/tertiary limbs and junctions.
 */
export function resolveTreeBranchArchitecture({ dbhM, species, genus, structuralForm = null, preset = null, tags = {} } = {}) {
  const dbh = clamp(finite(dbhM, 0.3), 0.08, 4.5);
  const taxon = `${species || ""} ${genus || ""}`.toLowerCase();
  const form = structuralForm?.form || "mature";
  const explicitPrimary = finiteOrNull(first(tags, ["tree:primary_branch_diameter", "primary_branch_diameter", "tpmap:primary_limb_diameter_m"]));
  const explicitFork = parseBoolean(first(tags, ["tree:forked", "forked", "tpmap:forked_trunk"]));

  const speciesScale = /oak|quercus|chestnut|castanea|beech|fagus/.test(taxon) ? 1.08
    : /willow|salix|poplar|populus/.test(taxon) ? 0.96
    : /birch|betula/.test(taxon) ? 0.78
    : /pine|pinus|spruce|picea|cedar|cedrus/.test(taxon) ? 0.72 : 0.90;
  const formScale = form === "veteran" ? 1.20 : form === "pollarded" ? 1.12 : form === "young" ? 0.72 : form === "damaged" ? 0.88 : 1;

  const primaryDiameterM = clamp(explicitPrimary ?? dbh * 0.38 * speciesScale * formScale, 0.06, Math.max(0.08, dbh * 0.62));
  const secondaryRatio = preset?.family === "conifer" ? 0.50 : 0.56;
  const tertiaryRatio = preset?.family === "conifer" ? 0.42 : 0.48;
  const forked = explicitFork ?? ["multi-stem", "pollarded", "veteran"].includes(form);
  const crotchRadiusBlocks = clamp(Math.round((dbh * (forked ? 0.48 : 0.34)) / 2), 0, 2);
  const primaryRadiusBlocks = radiusBlocks(primaryDiameterM);
  const secondaryRadiusBlocks = Math.min(primaryRadiusBlocks, radiusBlocks(primaryDiameterM * secondaryRatio));
  const tertiaryRadiusBlocks = Math.min(secondaryRadiusBlocks, radiusBlocks(primaryDiameterM * secondaryRatio * tertiaryRatio));

  return {
    source: explicitPrimary != null || explicitFork != null ? "explicit-branch-evidence" : "dbh-species-form",
    observed: explicitPrimary != null || explicitFork != null,
    primaryDiameterM: round3(primaryDiameterM),
    primaryRadiusBlocks,
    secondaryRadiusBlocks,
    tertiaryRadiusBlocks,
    primaryTaperExponent: form === "veteran" ? 0.72 : preset?.family === "conifer" ? 1.04 : 0.88,
    forked,
    crotchRadiusBlocks,
    junctionCollarScale: form === "veteran" || form === "pollarded" ? 1.30 : 1.08,
    maxForkAngleRad: (preset?.family === "conifer" ? 48 : 72) * DEG,
    confidence: explicitPrimary != null || explicitFork != null ? 0.97 : 0.66
  };
}

/** Radius along a limb, preserving a thick collar and tapering continuously. */
export function branchRadiusAt(architecture, fraction, generation = 0) {
  const f = clamp(Number(fraction) || 0, 0, 1);
  const base = generation <= 0 ? architecture?.primaryRadiusBlocks || 0
    : generation === 1 ? architecture?.secondaryRadiusBlocks || 0
    : architecture?.tertiaryRadiusBlocks || 0;
  if (base <= 0) return 0;
  const exponent = architecture?.primaryTaperExponent || 0.9;
  const collar = f < 0.14 ? 1 + (architecture?.junctionCollarScale - 1) * (1 - f / 0.14) : 1;
  return Math.max(0, Math.round(base * Math.pow(1 - f * 0.92, exponent) * collar));
}

export function junctionRadius(architecture, parentRadius, childRadius) {
  const collar = Math.max(parentRadius, childRadius) * (architecture?.junctionCollarScale || 1.08);
  return clamp(Math.round(collar), 0, 3);
}

function radiusBlocks(diameterM) {
  // One Minecraft block is 1 m; sub-block limb diameters remain a one-block skeleton.
  if (diameterM < 0.72) return 0;
  if (diameterM < 1.65) return 1;
  if (diameterM < 2.75) return 2;
  return 3;
}
function first(o, keys) { for (const k of keys) if (o?.[k] != null && o[k] !== "") return o[k]; return null; }
function finiteOrNull(v) { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function finite(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function parseBoolean(v) {
  if (v == null || v === "") return null;
  if ([true, 1, "1", "yes", "true"].includes(v)) return true;
  if ([false, 0, "0", "no", "false"].includes(v)) return false;
  return null;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round3(v) { return Math.round(v * 1000) / 1000; }
