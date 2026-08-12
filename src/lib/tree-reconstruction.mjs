const DEFAULT_MIN_CANOPY_HEIGHT_M = 2;

/**
 * Reconstruct one tree crown from gridded surface/terrain evidence.
 *
 * Samples may provide either canopyHeightM directly or surfaceM + groundM.
 * Only the connected canopy component containing/nearest the mapped trunk is
 * retained, which prevents adjacent crowns from being merged into one model.
 * Crown-base height is emitted only when explicit vegetation-base observations
 * are present; DSM-DTM alone cannot reliably recover it.
 */
export function reconstructTreeCrownFromSamples({
  x,
  z,
  samples = [],
  cellSizeM = 1,
  minCanopyHeightM = DEFAULT_MIN_CANOPY_HEIGHT_M,
  maxSeedDistanceM = 3
}) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !samples.length) return null;
  const cell = Math.max(0.25, Number(cellSizeM) || 1);
  const threshold = Math.max(0.5, Number(minCanopyHeightM) || DEFAULT_MIN_CANOPY_HEIGHT_M);
  const usable = samples.map((sample, index) => normalizeSample(sample, index, threshold))
    .filter(Boolean);
  if (!usable.length) return null;

  const seed = usable.reduce((best, sample) => {
    const distance = Math.hypot(sample.x - x, sample.z - z);
    return !best || distance < best.distance ? { sample, distance } : best;
  }, null);
  if (!seed || seed.distance > Math.max(cell * 1.75, maxSeedDistanceM)) return null;

  const byCell = new Map();
  for (const sample of usable) {
    const gx = Math.round(sample.x / cell), gz = Math.round(sample.z / cell);
    const key = `${gx},${gz}`;
    const current = byCell.get(key);
    if (!current || sample.canopyHeightM > current.canopyHeightM) byCell.set(key, { ...sample, gx, gz });
  }
  const seedCell = nearestCell([...byCell.values()], seed.sample.x, seed.sample.z);
  if (!seedCell) return null;

  const component = [];
  const queue = [seedCell];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    const key = `${current.gx},${current.gz}`;
    if (visited.has(key)) continue;
    visited.add(key);
    component.push(current);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const next = byCell.get(`${current.gx + dx},${current.gz + dz}`);
      if (next && !visited.has(`${next.gx},${next.gz}`)) queue.push(next);
    }
  }
  if (!component.length) return null;

  const half = cell / 2;
  const minX = Math.min(...component.map((s) => s.x - half));
  const maxX = Math.max(...component.map((s) => s.x + half));
  const minZ = Math.min(...component.map((s) => s.z - half));
  const maxZ = Math.max(...component.map((s) => s.z + half));
  const westM = Math.max(half, x - minX);
  const eastM = Math.max(half, maxX - x);
  const northM = Math.max(half, z - minZ);
  const southM = Math.max(half, maxZ - z);
  const canopyHeights = component.map((s) => s.canopyHeightM).sort((a, b) => a - b);
  const vegetationBases = component.map((s) => s.vegetationBaseHeightM).filter(Number.isFinite).sort((a, b) => a - b);
  const crownBaseHeightM = vegetationBases.length ? percentile(vegetationBases, 0.25) : null;
  const maxCanopyHeightM = canopyHeights[canopyHeights.length - 1];
  const offsetXM = (eastM - westM) / 2;
  const offsetZM = (southM - northM) / 2;
  const radiusXM = (eastM + westM) / 2;
  const radiusZM = (northM + southM) / 2;
  const asymmetry = Math.min(1, Math.hypot(offsetXM, offsetZM) / Math.max(0.5, Math.max(radiusXM, radiusZM)));

  return {
    schemaVersion: 1,
    source: "dsm-dtm-connected-canopy",
    sampleCount: component.length,
    westM: round3(westM),
    eastM: round3(eastM),
    northM: round3(northM),
    southM: round3(southM),
    radiusXM: round3(radiusXM),
    radiusZM: round3(radiusZM),
    offsetXM: round3(offsetXM),
    offsetZM: round3(offsetZM),
    maxCanopyHeightM: round3(maxCanopyHeightM),
    crownBaseHeightM: Number.isFinite(crownBaseHeightM) ? round3(crownBaseHeightM) : null,
    crownBaseObserved: Number.isFinite(crownBaseHeightM),
    asymmetry: round3(asymmetry),
    coverageAreaM2: round3(component.length * cell * cell),
    disconnectedSamplesRejected: Math.max(0, byCell.size - component.length)
  };
}

export function normalizeTreeReconstruction(reconstruction, { crownRadius, crownBase, treeHeight }) {
  const fallback = Math.max(0.5, Number(crownRadius) || 0.5);
  const west = positive(reconstruction?.westM, fallback);
  const east = positive(reconstruction?.eastM, fallback);
  const north = positive(reconstruction?.northM, fallback);
  const south = positive(reconstruction?.southM, fallback);
  const radiusX = Math.max(0.5, (west + east) / 2);
  const radiusZ = Math.max(0.5, (north + south) / 2);
  const offsetX = (east - west) / 2;
  const offsetZ = (south - north) / 2;
  const observedBase = Number(reconstruction?.crownBaseHeightM);
  const base = Number.isFinite(observedBase)
    ? clamp(Math.round(observedBase), 2, Math.max(2, treeHeight - 2))
    : crownBase;
  return {
    source: reconstruction?.source || "preset-symmetric",
    observed: Boolean(reconstruction && (Number.isFinite(reconstruction.westM) || Number.isFinite(reconstruction.radiusXM))),
    west,
    east,
    north,
    south,
    radiusX,
    radiusZ,
    offsetX,
    offsetZ,
    crownBase: base,
    crownBaseObserved: Number.isFinite(observedBase)
  };
}

export function crownReachFromTrunk(geometry, angle) {
  const dx = Math.cos(angle), dz = Math.sin(angle);
  const rx = Math.max(0.5, geometry.radiusX), rz = Math.max(0.5, geometry.radiusZ);
  const ox = geometry.offsetX, oz = geometry.offsetZ;
  const a = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
  const b = -2 * ((dx * ox) / (rx * rx) + (dz * oz) / (rz * rz));
  const c = (ox * ox) / (rx * rx) + (oz * oz) / (rz * rz) - 1;
  const disc = Math.max(0, b * b - 4 * a * c);
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  return Math.max(0.5, t);
}

export function insideCrownEnvelope(geometry, dx, dz, tolerance = 0.12) {
  const rx = Math.max(0.5, geometry.radiusX), rz = Math.max(0.5, geometry.radiusZ);
  const nx = (dx - geometry.offsetX) / rx;
  const nz = (dz - geometry.offsetZ) / rz;
  return nx * nx + nz * nz <= 1 + tolerance;
}

function normalizeSample(sample, index, threshold) {
  const x = Number(sample?.x), z = Number(sample?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const direct = Number(sample.canopyHeightM);
  const surface = Number(sample.surfaceM), ground = Number(sample.groundM);
  const canopyHeightM = Number.isFinite(direct) ? direct
    : Number.isFinite(surface) && Number.isFinite(ground) ? surface - ground : NaN;
  if (!Number.isFinite(canopyHeightM) || canopyHeightM < threshold) return null;
  const base = Number(sample.vegetationBaseHeightM ?? sample.crownBaseHeightM);
  return { x, z, canopyHeightM, vegetationBaseHeightM: Number.isFinite(base) ? base : null, index };
}

function nearestCell(cells, x, z) {
  return cells.reduce((best, sample) => {
    const distance = Math.hypot(sample.x - x, sample.z - z);
    return !best || distance < best.distance ? { ...sample, distance } : best;
  }, null);
}
function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function percentile(values, p) {
  if (!values.length) return NaN;
  const index = Math.min(values.length - 1, Math.max(0, p * (values.length - 1)));
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round3(value) { return Math.round(value * 1000) / 1000; }
