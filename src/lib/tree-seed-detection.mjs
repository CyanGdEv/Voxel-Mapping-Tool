const DEFAULTS = Object.freeze({
  minCanopyHeightM: 4,
  minPeakProminenceM: 1.25,
  minSeedSeparationM: 3.5,
  mappedSuppressionRadiusM: 2.5,
  maxSeeds: 2048
});

/**
 * Detect evidence-backed individual-tree seed positions from DSM-DTM canopy samples.
 *
 * This is intentionally conservative: samples are expected to have already been
 * constrained to a mapped/authoritative vegetation extent. A candidate must be
 * a local canopy-height maximum, exceed a local prominence threshold, remain
 * separated from stronger peaks, and stay clear of already mapped tree trunks.
 */
export function detectTreeSeedsFromCanopySamples({
  samples = [],
  cellSizeM = 1,
  mappedSeeds = [],
  minCanopyHeightM = DEFAULTS.minCanopyHeightM,
  minPeakProminenceM = DEFAULTS.minPeakProminenceM,
  minSeedSeparationM = DEFAULTS.minSeedSeparationM,
  mappedSuppressionRadiusM = DEFAULTS.mappedSuppressionRadiusM,
  maxSeeds = DEFAULTS.maxSeeds
} = {}) {
  const cell = Math.max(0.25, Number(cellSizeM) || 1);
  const threshold = Math.max(1, Number(minCanopyHeightM) || DEFAULTS.minCanopyHeightM);
  const prominenceThreshold = Math.max(0, Number(minPeakProminenceM) || DEFAULTS.minPeakProminenceM);
  const separation = Math.max(cell, Number(minSeedSeparationM) || DEFAULTS.minSeedSeparationM);
  const mappedSuppression = Math.max(cell, Number(mappedSuppressionRadiusM) || DEFAULTS.mappedSuppressionRadiusM);
  const limit = Math.max(1, Math.min(10000, Math.floor(Number(maxSeeds) || DEFAULTS.maxSeeds)));

  const usable = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = normalizeSample(samples[index], index, threshold);
    if (sample) usable.push(sample);
  }
  if (!usable.length) return [];

  const byCell = new Map();
  for (const sample of usable) {
    const gx = Math.round(sample.x / cell), gz = Math.round(sample.z / cell);
    const key = `${gx},${gz}`;
    const prior = byCell.get(key);
    if (!prior || sample.canopyHeightM > prior.canopyHeightM) byCell.set(key, { ...sample, gx, gz });
  }

  const candidates = [];
  for (const sample of byCell.values()) {
    const neighborhood = neighborsWithin(byCell, sample.gx, sample.gz, 1);
    if (neighborhood.some((other) => other.canopyHeightM > sample.canopyHeightM + 1e-9)) continue;

    // Require deterministic ownership of flat plateaus so a level crown does not
    // emit one seed per raster cell.
    const equalHigherPriority = neighborhood.some((other) =>
      Math.abs(other.canopyHeightM - sample.canopyHeightM) <= 1e-9 &&
      (other.gz < sample.gz || (other.gz === sample.gz && other.gx < sample.gx))
    );
    if (equalHigherPriority) continue;

    const ringRadiusCells = Math.max(2, Math.ceil(separation / cell));
    const ring = neighborsWithin(byCell, sample.gx, sample.gz, ringRadiusCells)
      .filter((other) => Math.max(Math.abs(other.gx - sample.gx), Math.abs(other.gz - sample.gz)) >= 2);
    const localFloor = ring.length
      ? percentile(ring.map((other) => other.canopyHeightM).sort((a, b) => a - b), 0.65)
      : threshold;
    const prominenceM = sample.canopyHeightM - localFloor;
    if (prominenceM + 1e-9 < prominenceThreshold) continue;

    if (mappedSeeds.some((seed) => {
      const sx = Number(seed?.x ?? seed?.[0]), sz = Number(seed?.z ?? seed?.[1]);
      return Number.isFinite(sx) && Number.isFinite(sz) && Math.hypot(sample.x - sx, sample.z - sz) < mappedSuppression;
    })) continue;

    candidates.push({
      x: sample.x,
      z: sample.z,
      canopyHeightM: round3(sample.canopyHeightM),
      prominenceM: round3(prominenceM),
      source: "dsm-dtm-canopy-local-maximum",
      confidence: round3(confidenceFor(sample.canopyHeightM, prominenceM, threshold, prominenceThreshold)),
      sampleIndex: sample.index
    });
  }

  candidates.sort((a, b) =>
    b.canopyHeightM - a.canopyHeightM ||
    b.prominenceM - a.prominenceM ||
    a.z - b.z || a.x - b.x
  );

  const accepted = [];
  for (const candidate of candidates) {
    if (accepted.some((seed) => Math.hypot(seed.x - candidate.x, seed.z - candidate.z) < separation)) continue;
    accepted.push(candidate);
    if (accepted.length >= limit) break;
  }
  return accepted;
}

function normalizeSample(sample, index, threshold) {
  const x = Number(sample?.x), z = Number(sample?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const direct = Number(sample?.canopyHeightM);
  const surface = Number(sample?.surfaceM), ground = Number(sample?.groundM);
  const canopyHeightM = Number.isFinite(direct)
    ? direct
    : Number.isFinite(surface) && Number.isFinite(ground)
      ? surface - ground
      : NaN;
  if (!Number.isFinite(canopyHeightM) || canopyHeightM < threshold) return null;
  return { x, z, canopyHeightM, index };
}

function neighborsWithin(byCell, gx, gz, radius) {
  const out = [];
  for (let dz = -radius; dz <= radius; dz += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx === 0 && dz === 0) continue;
      const other = byCell.get(`${gx + dx},${gz + dz}`);
      if (other) out.push(other);
    }
  }
  return out;
}

function confidenceFor(height, prominence, threshold, prominenceThreshold) {
  const heightScore = Math.min(1, Math.max(0, (height - threshold) / 12));
  const prominenceScore = Math.min(1, Math.max(0, prominence / Math.max(0.5, prominenceThreshold * 2.5)));
  return Math.min(0.94, 0.55 + heightScore * 0.18 + prominenceScore * 0.21);
}

function percentile(values, p) {
  if (!values.length) return NaN;
  const index = Math.min(values.length - 1, Math.max(0, p * (values.length - 1)));
  const lo = Math.floor(index), hi = Math.ceil(index);
  if (lo === hi) return values[lo];
  return values[lo] + (values[hi] - values[lo]) * (index - lo);
}
function round3(value) { return Math.round(value * 1000) / 1000; }
