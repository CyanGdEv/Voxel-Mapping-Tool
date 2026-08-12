const DEFAULT_MIN_CANOPY_HEIGHT_M = 2;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Reconstruct one tree crown from gridded surface/terrain evidence.
 *
 * Samples may provide either canopyHeightM directly or surfaceM + groundM.
 * First, only the connected canopy component containing/nearest the mapped trunk
 * is retained. When other mapped tree trunks occupy that same component, a
 * height-aware seeded watershed separates touching crowns at canopy saddles.
 * Crown-base height is emitted only when explicit vegetation-base observations
 * are present; DSM-DTM alone cannot reliably recover it.
 */
export function reconstructTreeCrownFromSamples({
  x,
  z,
  samples = [],
  cellSizeM = 1,
  minCanopyHeightM = DEFAULT_MIN_CANOPY_HEIGHT_M,
  maxSeedDistanceM = 3,
  competitorSeeds = []
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

  const connectedComponent = floodConnectedComponent(seedCell, byCell);
  if (!connectedComponent.length) return null;
  const disconnectedSamplesRejected = Math.max(0, byCell.size - connectedComponent.length);
  const watershed = splitTouchingCrown({
    component: connectedComponent,
    primary: { x, z },
    competitors: competitorSeeds,
    cell
  });
  const component = watershed.primaryCells;
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
    schemaVersion: 2,
    source: watershed.competitorCount > 0 ? "dsm-dtm-seeded-watershed" : "dsm-dtm-connected-canopy",
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
    disconnectedSamplesRejected,
    touchingSamplesRejected: watershed.rejectedCells,
    watershedCompetitors: watershed.competitorCount,
    watershedBoundaryCells: watershed.boundaryCells,
    watershedMinSaddleHeightM: Number.isFinite(watershed.minSaddleHeightM) ? round3(watershed.minSaddleHeightM) : null
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

function floodConnectedComponent(seedCell, byCell) {
  const component = [];
  const queue = [seedCell];
  const visited = new Set();
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const key = cellKey(current);
    if (visited.has(key)) continue;
    visited.add(key);
    component.push(current);
    for (const [dx, dz] of NEIGHBOURS) {
      const next = byCell.get(`${current.gx + dx},${current.gz + dz}`);
      if (next && !visited.has(cellKey(next))) queue.push(next);
    }
  }
  return component;
}

function splitTouchingCrown({ component, primary, competitors, cell }) {
  const cells = new Map(component.map((sample) => [cellKey(sample), sample]));
  const anchors = [{ id: "primary", x: primary.x, z: primary.z, cell: nearestCell(component, primary.x, primary.z) }];
  const seenSeedCells = new Set([cellKey(anchors[0].cell)]);
  let competitorIndex = 0;
  for (const candidate of competitors || []) {
    const cx = Number(candidate?.x ?? candidate?.[0]), cz = Number(candidate?.z ?? candidate?.[1]);
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
    if (Math.hypot(cx - primary.x, cz - primary.z) < cell * 0.75) continue;
    const nearest = nearestCell(component, cx, cz);
    if (!nearest || nearest.distance > Math.max(cell * 2.5, 2.5)) continue;
    const key = cellKey(nearest);
    if (seenSeedCells.has(key)) continue;
    seenSeedCells.add(key);
    anchors.push({ id: `competitor:${competitorIndex++}`, x: cx, z: cz, cell: nearest });
  }
  if (anchors.length === 1) {
    return { primaryCells: component, rejectedCells: 0, competitorCount: 0, boundaryCells: 0, minSaddleHeightM: null };
  }

  const ownership = new Map();
  const heap = new MaxHeap(compareFloodState);
  for (const anchor of anchors) {
    const key = cellKey(anchor.cell);
    const state = {
      key, label: anchor.id, anchor,
      bottleneck: anchor.cell.canopyHeightM,
      distance: Math.hypot(anchor.cell.x - anchor.x, anchor.cell.z - anchor.z)
    };
    const current = ownership.get(key);
    if (!current || betterFloodState(state, current)) {
      ownership.set(key, state);
      heap.push(state);
    }
  }

  while (heap.size) {
    const state = heap.pop();
    const currentOwner = ownership.get(state.key);
    if (!sameFloodState(state, currentOwner)) continue;
    const current = cells.get(state.key);
    if (!current) continue;
    for (const [dx, dz] of NEIGHBOURS) {
      const nextKey = `${current.gx + dx},${current.gz + dz}`;
      const next = cells.get(nextKey);
      if (!next) continue;
      const step = Math.hypot(dx, dz) * cell;
      const candidate = {
        key: nextKey,
        label: state.label,
        anchor: state.anchor,
        bottleneck: Math.min(state.bottleneck, next.canopyHeightM),
        distance: state.distance + step
      };
      const previous = ownership.get(nextKey);
      if (!previous || betterFloodState(candidate, previous)) {
        ownership.set(nextKey, candidate);
        heap.push(candidate);
      }
    }
  }

  const primaryCells = component.filter((sample) => ownership.get(cellKey(sample))?.label === "primary");
  let boundaryCells = 0;
  let minSaddleHeightM = Infinity;
  for (const sample of component) {
    const owner = ownership.get(cellKey(sample));
    if (!owner) continue;
    let boundary = false;
    for (const [dx, dz] of NEIGHBOURS) {
      const other = ownership.get(`${sample.gx + dx},${sample.gz + dz}`);
      if (other && other.label !== owner.label) { boundary = true; break; }
    }
    if (boundary) {
      boundaryCells += 1;
      minSaddleHeightM = Math.min(minSaddleHeightM, sample.canopyHeightM);
    }
  }
  return {
    primaryCells,
    rejectedCells: Math.max(0, component.length - primaryCells.length),
    competitorCount: anchors.length - 1,
    boundaryCells,
    minSaddleHeightM: Number.isFinite(minSaddleHeightM) ? minSaddleHeightM : null
  };
}

function betterFloodState(candidate, current) {
  const epsilon = 1e-9;
  if (candidate.bottleneck > current.bottleneck + epsilon) return true;
  if (candidate.bottleneck < current.bottleneck - epsilon) return false;
  const candidateDirect = Math.hypot(candidate.anchor.x - cellX(candidate.key), candidate.anchor.z - cellZ(candidate.key));
  const currentDirect = Math.hypot(current.anchor.x - cellX(current.key), current.anchor.z - cellZ(current.key));
  if (candidateDirect < currentDirect - epsilon) return true;
  if (candidateDirect > currentDirect + epsilon) return false;
  if (candidate.distance < current.distance - epsilon) return true;
  if (candidate.distance > current.distance + epsilon) return false;
  return candidate.label === "primary" && current.label !== "primary";
}

function compareFloodState(a, b) {
  if (a.bottleneck !== b.bottleneck) return a.bottleneck - b.bottleneck;
  return b.distance - a.distance;
}
function sameFloodState(a, b) {
  return Boolean(b) && a.label === b.label && a.bottleneck === b.bottleneck && a.distance === b.distance;
}

class MaxHeap {
  constructor(compare) { this.items = []; this.compare = compare; }
  get size() { return this.items.length; }
  push(value) {
    const items = this.items;
    items.push(value);
    let index = items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(items[index], items[parent]) <= 0) break;
      [items[index], items[parent]] = [items[parent], items[index]];
      index = parent;
    }
  }
  pop() {
    const items = this.items;
    if (!items.length) return null;
    const top = items[0];
    const tail = items.pop();
    if (items.length) {
      items[0] = tail;
      let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        let best = index;
        if (left < items.length && this.compare(items[left], items[best]) > 0) best = left;
        if (right < items.length && this.compare(items[right], items[best]) > 0) best = right;
        if (best === index) break;
        [items[index], items[best]] = [items[best], items[index]];
        index = best;
      }
    }
    return top;
  }
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
function cellKey(sample) { return `${sample.gx},${sample.gz}`; }
function cellX(key) { return Number(String(key).split(",")[0]); }
function cellZ(key) { return Number(String(key).split(",")[1]); }
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
