const DEG = Math.PI / 180;

/**
 * Resolve a conservative trunk lean vector from explicit tree evidence first,
 * then reconstructed crown offset / terrain-pressure evidence. The trunk base
 * remains fixed; only the upper trunk axis is displaced.
 */
export function inferTreeTrunkLean({ heightM, crownDiameterM, tags = {}, reconstruction = null } = {}) {
  const explicit = explicitLean(tags);
  if (explicit) return explicit;

  const height = Math.max(1, Number(heightM) || 1);
  const crown = Math.max(1, Number(crownDiameterM) || 1);
  const offsetX = finite(reconstruction?.offsetXM, finite(reconstruction?.crownOffsetXM, 0));
  const offsetZ = finite(reconstruction?.offsetZM, finite(reconstruction?.crownOffsetZM, 0));
  const asymmetry = clamp(finite(reconstruction?.asymmetry, Math.hypot(offsetX, offsetZ) / Math.max(0.5, crown / 2)), 0, 1);

  const offsetMagnitude = Math.hypot(offsetX, offsetZ);
  let dx = 0, dz = 0;
  if (offsetMagnitude >= 0.75 && asymmetry >= 0.08) {
    const influence = clamp(0.16 + asymmetry * 0.28, 0.16, 0.42);
    dx += offsetX * influence;
    dz += offsetZ * influence;
  }

  const slope = slopeVector(reconstruction, tags);
  if (slope && slope.grade >= 0.08) {
    const slopeShift = Math.min(1.25, height * 0.035 * clamp(slope.grade, 0, 0.6));
    dx += slope.dx * slopeShift;
    dz += slope.dz * slopeShift;
  }

  const pressure = competitionVector(reconstruction);
  if (pressure && pressure.magnitude > 0.05) {
    const shift = Math.min(1.5, crown * 0.06 * clamp(pressure.magnitude, 0, 1));
    dx += pressure.dx * shift;
    dz += pressure.dz * shift;
  }

  const rawMagnitude = Math.hypot(dx, dz);
  if (rawMagnitude < 0.2) return neutral();

  const maxShift = Math.max(0.5, Math.min(2.5, height * 0.12));
  const scale = rawMagnitude > maxShift ? maxShift / rawMagnitude : 1;
  dx *= scale; dz *= scale;
  const shift = Math.hypot(dx, dz);
  const angleDeg = Math.atan2(shift, height) / DEG;
  const confidence = clamp(0.42 + asymmetry * 0.3 + (slope ? 0.08 : 0) + (pressure ? 0.08 : 0), 0.35, 0.78);
  return {
    source: "inferred-structural-evidence",
    observed: false,
    dxM: round3(dx),
    dzM: round3(dz),
    topShiftM: round3(shift),
    angleDeg: round3(angleDeg),
    confidence: round3(confidence)
  };
}

export function trunkAxisOffsetAt(lean, fraction) {
  const t = clamp(Number(fraction) || 0, 0, 1);
  const eased = t * t * (3 - 2 * t);
  return {
    x: cleanZero(finite(lean?.dxM, 0) * eased),
    z: cleanZero(finite(lean?.dzM, 0) * eased)
  };
}

function explicitLean(tags) {
  const direction = finiteTag(tags, ["tree:lean_direction", "lean_direction", "tpmap:lean_direction_deg"]);
  const angle = finiteTag(tags, ["tree:lean", "lean", "tree:lean_angle", "tpmap:lean_angle_deg"]);
  const dx = finiteTag(tags, ["tpmap:trunk_lean_dx_m", "tree:lean_dx"]);
  const dz = finiteTag(tags, ["tpmap:trunk_lean_dz_m", "tree:lean_dz"]);
  if (Number.isFinite(dx) || Number.isFinite(dz)) {
    const x = Number.isFinite(dx) ? dx : 0, z = Number.isFinite(dz) ? dz : 0;
    const shift = Math.hypot(x, z);
    return { source: "explicit-lean-vector", observed: true, dxM: round3(x), dzM: round3(z), topShiftM: round3(shift), angleDeg: null, confidence: 0.98 };
  }
  if (!Number.isFinite(direction) || !Number.isFinite(angle)) return null;
  const boundedAngle = clamp(Math.abs(angle), 0, 25);
  if (boundedAngle < 0.5) return neutral("explicit-lean-angle", true, 0.98);
  const radians = direction * DEG;
  const shift = Math.tan(boundedAngle * DEG) * 10;
  return {
    source: "explicit-lean-angle",
    observed: true,
    dxM: round3(Math.sin(radians) * shift),
    dzM: round3(-Math.cos(radians) * shift),
    topShiftM: round3(shift),
    angleDeg: round3(boundedAngle),
    confidence: 0.98,
    normalizedAt10m: true
  };
}

function slopeVector(reconstruction, tags) {
  const dx = finite(reconstruction?.terrainSlopeDx, finiteTag(tags, ["tpmap:terrain_slope_dx"]));
  const dz = finite(reconstruction?.terrainSlopeDz, finiteTag(tags, ["tpmap:terrain_slope_dz"]));
  const grade = finite(reconstruction?.terrainSlopeGrade, finiteTag(tags, ["tpmap:terrain_slope_grade"]));
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || !Number.isFinite(grade)) return null;
  const mag = Math.hypot(dx, dz);
  if (mag < 1e-6) return null;
  return { dx: -dx / mag, dz: -dz / mag, grade: Math.abs(grade) };
}

function competitionVector(reconstruction) {
  const dx = finite(reconstruction?.competitionOpenDx, NaN);
  const dz = finite(reconstruction?.competitionOpenDz, NaN);
  const magnitude = finite(reconstruction?.competitionPressure, NaN);
  if (![dx, dz, magnitude].every(Number.isFinite)) return null;
  const mag = Math.hypot(dx, dz);
  if (mag < 1e-6) return null;
  return { dx: dx / mag, dz: dz / mag, magnitude };
}

function finiteTag(tags, keys) {
  for (const key of keys) {
    const value = Number(tags?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return NaN;
}
function finite(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function cleanZero(value) { return Math.abs(value) < 1e-12 ? 0 : value; }
function neutral(source = "vertical-default", observed = false, confidence = 1) { return { source, observed, dxM: 0, dzM: 0, topShiftM: 0, angleDeg: 0, confidence }; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round3(value) { return Math.round(value * 1000) / 1000; }
