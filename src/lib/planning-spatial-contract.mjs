import { UserError } from "./errors.mjs";
import { coverageLocalBounds } from "./park-profile.mjs";
import { isPlanningWorldFeature } from "./planning-world-authority.mjs";

export function assessPlanningSpatialContract(features, options = {}) {
  const coverage = options.parkProfile?.worldCoverage;
  if (!coverage) return {
    schemaVersion: 1,
    required: false,
    status: "not-configured",
    failures: []
  };

  const planning = features.filter(isPlanningWorldFeature);
  const featureBounds = boundsOf(planning.map((feature) => feature.localGeometry));
  const contractBounds = coverageLocalBounds(coverage);
  const contractWidth = contractBounds.maxX - contractBounds.minX + 1;
  const contractHeight = contractBounds.maxZ - contractBounds.minZ + 1;
  const spanX = featureBounds ? featureBounds.maxX - featureBounds.minX : 0;
  const spanZ = featureBounds ? featureBounds.maxZ - featureBounds.minZ : 0;
  const spanRatioX = contractWidth ? spanX / contractWidth : 0;
  const spanRatioZ = contractHeight ? spanZ / contractHeight : 0;
  const featureCounts = {};
  let outsideCoverage = 0;
  let unregisteredAutomaticFeatures = 0;
  let excessiveAnchorFanoutFeatures = 0;
  let rideEnvelopeFeatures = 0;
  const maximumFanout = Number(coverage.maximumSemanticAnchorFanout || 64);

  for (const feature of planning) {
    featureCounts[feature.kind] = (featureCounts[feature.kind] || 0) + 1;
    const bounds = boundsOf([feature.localGeometry]);
    if (!bounds || !boundsInside(bounds, contractBounds)) outsideCoverage += 1;
    const tags = feature.tags || {};
    if (tags.planning_auto_extracted === true && tags.planning_spatial_registration_verified !== true) {
      unregisteredAutomaticFeatures += 1;
    }
    if (Number(tags.planning_semantic_anchor_fanout || 0) > maximumFanout) excessiveAnchorFanoutFeatures += 1;
    const label = String(tags.planning_semantic_label || feature.name || "");
    if (feature.kind === "ride_track" && /\b(?:max(?:imum)?\s+dimensions?|envelope|limit of deviation|clearance)\b/i.test(label)) {
      rideEnvelopeFeatures += 1;
    }
  }

  const failures = [];
  const minimumX = Number(coverage.minimumPlanningSpanRatioX || 0);
  const minimumZ = Number(coverage.minimumPlanningSpanRatioZ || 0);
  if (!planning.length) failures.push("no planning world features survived spatial registration");
  if (spanRatioX < minimumX) failures.push(`planning X span ${percent(spanRatioX)} is below ${percent(minimumX)}`);
  if (spanRatioZ < minimumZ) failures.push(`planning Z span ${percent(spanRatioZ)} is below ${percent(minimumZ)}`);
  if (outsideCoverage) failures.push(`${outsideCoverage} planning feature(s) lie outside the configured park coverage`);
  if (unregisteredAutomaticFeatures) failures.push(`${unregisteredAutomaticFeatures} automatic feature(s) lack verified drawing registration`);
  if (excessiveAnchorFanoutFeatures) failures.push(`${excessiveAnchorFanoutFeatures} feature(s) exceed the OCR semantic-anchor fan-out limit`);
  if (rideEnvelopeFeatures) failures.push(`${rideEnvelopeFeatures} ride envelope/dimension feature(s) were misclassified as track centrelines`);
  for (const [kind, required] of Object.entries(coverage.minimumFeatureCounts || {})) {
    const actual = featureCounts[kind] || 0;
    if (actual < Number(required)) failures.push(`${kind} feature count ${actual} is below ${required}`);
  }

  return {
    schemaVersion: 1,
    required: true,
    status: failures.length ? "failed" : "passed",
    authority: coverage.authority || null,
    expectedWorldChunks: Number(coverage.expectedChunks),
    contractBounds,
    planningBounds: featureBounds,
    planningFeatures: planning.length,
    featureCounts,
    span: {
      xM: round(spanX),
      zM: round(spanZ),
      ratioX: round(spanRatioX),
      ratioZ: round(spanRatioZ),
      minimumRatioX: minimumX,
      minimumRatioZ: minimumZ
    },
    diagnostics: {
      outsideCoverage,
      unregisteredAutomaticFeatures,
      excessiveAnchorFanoutFeatures,
      rideEnvelopeFeatures,
      maximumSemanticAnchorFanout: maximumFanout
    },
    failures
  };
}

export function enforcePlanningSpatialContract(assessment) {
  if (!assessment?.required || assessment.status === "passed") return;
  throw new UserError(
    `Planning spatial contract failed: ${assessment.failures.join("; ")}`,
    "Correct or replace the unregistered planning geometry; a partial or collapsed park world will not be emitted."
  );
}

function boundsInside(inner, outer) {
  return inner.minX >= outer.minX && inner.minZ >= outer.minZ &&
    inner.maxX <= outer.maxX && inner.maxZ <= outer.maxZ;
}

function boundsOf(geometries) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      minX = Math.min(minX, Number(value[0]));
      minZ = Math.min(minZ, Number(value[1]));
      maxX = Math.max(maxX, Number(value[0]));
      maxZ = Math.max(maxZ, Number(value[1]));
      return;
    }
    for (const child of value) visit(child);
  };
  for (const geometry of geometries) visit(geometry?.coordinates);
  return [minX, minZ, maxX, maxZ].every(Number.isFinite) ? { minX, minZ, maxX, maxZ } : null;
}

const percent = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;
const round = (value) => Number(Number(value || 0).toFixed(4));
