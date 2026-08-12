const FORM_PRIORITY = ["pollarded", "multi-stem", "damaged", "veteran", "mature", "young"];

export function inferTreeStructuralForm({
  heightM,
  crownDiameterM,
  species,
  genus,
  leafType,
  tags = {},
  reconstruction = null
} = {}) {
  const height = finite(heightM);
  const crown = finite(crownDiameterM);
  const explicit = explicitForm(tags);
  if (explicit) return { ...explicit, evidence: [explicit.source] };

  const evidence = [];
  const scores = new Map(FORM_PRIORITY.map((form) => [form, 0]));
  const bump = (form, amount, why) => {
    scores.set(form, (scores.get(form) || 0) + amount);
    if (why) evidence.push(`${form}:${why}`);
  };

  const multiStemCount = integer(tags.stem_count ?? tags.stems ?? tags["tree:stem_count"]);
  if (multiStemCount >= 2) bump("multi-stem", 1.0, `stem_count=${multiStemCount}`);
  if (truthy(tags.multi_stem) || truthy(tags.multistem)) bump("multi-stem", 0.9, "explicit-multistem");

  const healthText = text(tags.health, tags.condition, tags.tree_condition, tags.damage, tags.deadwood);
  if (/dead|dying|storm|broken|split|damag|declin|cavity|hollow/.test(healthText)) bump("damaged", 0.95, healthText);
  if (truthy(tags.pollarded) || /pollard/.test(text(tags.management, tags.form, tags.tree_form))) bump("pollarded", 1.0, "explicit-pollard");
  if (truthy(tags.veteran) || truthy(tags.ancient) || /veteran|ancient/.test(text(tags.age_class, tags.tree_age, tags.form))) bump("veteran", 1.0, "explicit-veteran");

  const radiusX = finite(reconstruction?.radiusXM);
  const radiusZ = finite(reconstruction?.radiusZM);
  const inferredCrown = crown ?? (radiusX !== null && radiusZ !== null ? radiusX + radiusZ : null);
  const asymmetry = finite(reconstruction?.asymmetry) ?? 0;
  const coverage = finite(reconstruction?.coverageAreaM2);
  const crownToHeight = height && inferredCrown ? inferredCrown / Math.max(1, height) : null;
  const broadleaf = normalizeLeafType(leafType) === "broadleaved" || inferBroadleaf(species, genus);

  if (height !== null) {
    if (height < 6) bump("young", 0.72, `height=${round2(height)}`);
    else if (height < 10) bump("young", 0.42, `height=${round2(height)}`);
    if (height >= 10) bump("mature", 0.35, `height=${round2(height)}`);
    if (height >= 15) bump("mature", 0.25, `height=${round2(height)}`);
  }
  if (inferredCrown !== null) {
    if (inferredCrown < 4.5) bump("young", 0.38, `crown=${round2(inferredCrown)}`);
    if (inferredCrown >= 7) bump("mature", 0.25, `crown=${round2(inferredCrown)}`);
    if (broadleaf && inferredCrown >= 12) bump("veteran", 0.34, `wide-crown=${round2(inferredCrown)}`);
  }
  if (crownToHeight !== null) {
    if (crownToHeight >= 0.85 && broadleaf) bump("veteran", 0.28, `crown-height-ratio=${round2(crownToHeight)}`);
    if (crownToHeight <= 0.38 && height !== null && height < 9) bump("young", 0.18, `slender=${round2(crownToHeight)}`);
  }
  if (asymmetry >= 0.28) bump("damaged", 0.12, `asymmetry=${round2(asymmetry)}`);
  if (asymmetry >= 0.45) bump("veteran", 0.13, `irregular-crown=${round2(asymmetry)}`);
  if (coverage !== null && broadleaf && coverage >= 115) bump("veteran", 0.18, `coverage=${round2(coverage)}`);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || FORM_PRIORITY.indexOf(a[0]) - FORM_PRIORITY.indexOf(b[0]));
  let [form, score] = ranked[0];
  if (score < 0.35) {
    form = height !== null && height < 8 ? "young" : "mature";
    score = 0.35;
    evidence.push(`${form}:conservative-fallback`);
  }

  // Veteran status is intentionally fail-closed unless multiple independent morphology cues
  // or an explicit tag support it. A single large crown must not manufacture veteran status.
  if (form === "veteran" && score < 0.62) {
    form = "mature";
    score = Math.max(0.48, scores.get("mature") || 0.48);
    evidence.push("mature:veteran-threshold-not-met");
  }

  const confidence = clamp(score, 0.35, 0.98);
  return {
    form,
    confidence: round3(confidence),
    inferred: true,
    source: "tree-structural-form-v1",
    stemCount: multiStemCount >= 2 ? multiStemCount : form === "multi-stem" ? 2 : 1,
    trunkScale: trunkScaleFor(form, confidence),
    branchScale: branchScaleFor(form),
    canopyDensityScale: canopyDensityScaleFor(form),
    deadwoodFraction: deadwoodFor(form, confidence),
    evidence: unique(evidence)
  };
}

function explicitForm(tags) {
  const value = text(tags.structural_form, tags.tree_form, tags.form, tags.age_class, tags.tree_age);
  const checks = [
    ["pollarded", /pollard/],
    ["multi-stem", /multi[- ]?stem|coppice/],
    ["damaged", /damag|broken|split|declin|hollow|cavity/],
    ["veteran", /veteran|ancient/],
    ["young", /young|juvenile|sapling/],
    ["mature", /mature/]
  ];
  for (const [form, pattern] of checks) {
    if (pattern.test(value)) return {
      form,
      confidence: 0.98,
      inferred: false,
      source: "explicit-tree-form-tag",
      stemCount: form === "multi-stem" ? Math.max(2, integer(tags.stem_count) || 2) : 1,
      trunkScale: trunkScaleFor(form, 0.98),
      branchScale: branchScaleFor(form),
      canopyDensityScale: canopyDensityScaleFor(form),
      deadwoodFraction: deadwoodFor(form, 0.98)
    };
  }
  return null;
}

function trunkScaleFor(form, confidence) {
  const base = { young: 0.68, mature: 1, veteran: 1.65, pollarded: 1.35, "multi-stem": 0.9, damaged: 1.1 }[form] || 1;
  return round3(1 + (base - 1) * confidence);
}
function branchScaleFor(form) {
  return { young: 0.78, mature: 1, veteran: 1.18, pollarded: 0.72, "multi-stem": 0.95, damaged: 0.88 }[form] || 1;
}
function canopyDensityScaleFor(form) {
  return { young: 0.9, mature: 1, veteran: 0.82, pollarded: 0.76, "multi-stem": 0.95, damaged: 0.68 }[form] || 1;
}
function deadwoodFor(form, confidence) {
  const base = { young: 0, mature: 0.02, veteran: 0.11, pollarded: 0.04, "multi-stem": 0.03, damaged: 0.18 }[form] || 0;
  return round3(base * confidence);
}
function inferBroadleaf(species, genus) {
  return /oak|beech|birch|ash|maple|sycamore|willow|lime|alder|poplar|quercus|fagus|betula|fraxinus|acer|salix|tilia|alnus|populus/i.test(`${species || ""} ${genus || ""}`);
}
function normalizeLeafType(value) {
  const v = String(value || "").toLowerCase();
  if (/needle|conifer/.test(v)) return "needleleaved";
  if (/broad|deciduous/.test(v)) return "broadleaved";
  return null;
}
function text(...values) { return values.filter((v) => v !== null && v !== undefined).join(" ").trim().toLowerCase(); }
function truthy(value) { return value === true || /^(yes|true|1)$/i.test(String(value || "")); }
function integer(value) { const n = Math.floor(Number(value)); return Number.isFinite(n) ? n : null; }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round2(value) { return Math.round(value * 100) / 100; }
function round3(value) { return Math.round(value * 1000) / 1000; }
function unique(values) { return [...new Set(values)]; }
