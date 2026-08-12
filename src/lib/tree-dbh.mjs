const PI = Math.PI;

/** Resolve diameter at breast height (DBH) in metres. Explicit measurements
 * remain authoritative; otherwise return a bounded morphology estimate with
 * lower confidence. Circumference inputs are converted to diameter.
 */
export function resolveTreeDbh({ heightM, crownDiameterM, species, genus, leafType, tags = {}, structuralForm = null } = {}) {
  const explicit = explicitDbh(tags);
  if (explicit) return explicit;

  const height = Math.max(1, Number(heightM) || 1);
  const crown = Math.max(1, Number(crownDiameterM) || 1);
  const form = structuralForm?.form || "mature";
  const speciesScale = speciesFactor({ species, genus, leafType });
  const formScale = ({ young: 0.62, mature: 1, veteran: 1.38, pollarded: 1.22, "multi-stem": 0.92, damaged: 1.08 }[form] || 1);
  // Conservative allometric proxy. Crown contributes strongly because park trees
  // often have suppressed height but substantial trunk girth.
  const estimate = clamp((0.018 * height + 0.032 * crown) * speciesScale * formScale, 0.12, 2.4);
  return {
    source: "morphology-estimate",
    observed: false,
    dbhM: round3(estimate),
    circumferenceM: round3(estimate * PI),
    confidence: form === "veteran" || form === "pollarded" ? 0.5 : 0.42
  };
}

export function dbhToVoxelProfile(dbhM, { structuralForm = null } = {}) {
  const dbh = clamp(Number(dbhM) || 0.3, 0.1, 3);
  const form = structuralForm?.form || "mature";
  const breastRadiusBlocks = clamp(Math.ceil((dbh / 2) - 0.01), 0, 2);
  const buttressScale = ({ veteran: 1.65, pollarded: 1.45, "multi-stem": 1.25, damaged: 1.2 }[form] || 1.1);
  const baseRadiusBlocks = clamp(Math.max(breastRadiusBlocks, Math.ceil((dbh / 2) * buttressScale)), 0, 3);
  const upperRadiusBlocks = clamp(Math.floor(breastRadiusBlocks * 0.75), 0, 2);
  const rootReachBlocks = clamp(Math.round(dbh * buttressScale * 1.6), 1, 5);
  const majorLimbRadiusBlocks = clamp(Math.floor(dbh / 1.15), 0, 2);
  return { breastRadiusBlocks, baseRadiusBlocks, upperRadiusBlocks, rootReachBlocks, majorLimbRadiusBlocks };
}

function explicitDbh(tags) {
  const diameterM = firstFinite(tags, ["diameter", "tree:diameter", "dbh", "tree:dbh", "tpmap:dbh_m"]);
  if (Number.isFinite(diameterM) && diameterM > 0) return measured(diameterM, "explicit-diameter");
  const diameterCm = firstFinite(tags, ["diameter_cm", "dbh_cm", "tree:dbh_cm", "tpmap:dbh_cm"]);
  if (Number.isFinite(diameterCm) && diameterCm > 0) return measured(diameterCm / 100, "explicit-diameter-cm");
  const circumferenceM = firstFinite(tags, ["circumference", "tree:circumference", "girth", "tree:girth", "tpmap:circumference_m"]);
  if (Number.isFinite(circumferenceM) && circumferenceM > 0) return measured(circumferenceM / PI, "explicit-circumference");
  const circumferenceCm = firstFinite(tags, ["circumference_cm", "girth_cm", "tree:girth_cm", "tpmap:circumference_cm"]);
  if (Number.isFinite(circumferenceCm) && circumferenceCm > 0) return measured((circumferenceCm / 100) / PI, "explicit-circumference-cm");
  return null;
}
function measured(dbhM, source) {
  const value = clamp(dbhM, 0.05, 4);
  return { source, observed: true, dbhM: round3(value), circumferenceM: round3(value * PI), confidence: 0.99 };
}
function speciesFactor({ species, genus, leafType }) {
  const text = `${species || ""} ${genus || ""}`.toLowerCase();
  if (/oak|quercus|chestnut|castanea/.test(text)) return 1.18;
  if (/beech|fagus|lime|tilia|sycamore|acer/.test(text)) return 1.08;
  if (/birch|betula|poplar|populus/.test(text)) return 0.84;
  if (/willow|salix/.test(text)) return 1.12;
  if (/pine|pinus|spruce|picea|fir|abies/.test(text) || /needle|conifer/.test(String(leafType || "").toLowerCase())) return 0.9;
  return 1;
}
function firstFinite(tags, keys) { for (const key of keys) { const n = Number(tags?.[key]); if (Number.isFinite(n)) return n; } return NaN; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round3(value) { return Math.round(value * 1000) / 1000; }
