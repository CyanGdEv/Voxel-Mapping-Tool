import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { UserError, invariant } from "./errors.mjs";
import { readJson, sha256, sha256File } from "./io.mjs";


let lasModulePromise = null;
async function loadLas() {
  lasModulePromise ||= import("copc").then((module) => module.Las).catch((error) => {
    throw new UserError(
      "The optional COPC/LAS decoder is unavailable",
      `Install the 'copc' package before using --ride-point-cloud. ${error?.message || String(error)}`
    );
  });
  return lasModulePromise;
}

const PROFILE_MODES = new Set(["auto", "flat", "profile", "lidar", "hybrid"]);
const DIRECT_EVIDENCE = new Set([
  "surveyed",
  "manufacturer-cad",
  "planning-verified",
  "measured-lidar",
  "lidar-derived",
  "interpolated",
  "inferred"
]);
const DEFAULT_POINT_CLASSES = new Set([0, 1, 6]);
const EA_POINT_CLOUD_DATASET = "https://environment.data.gov.uk/dataset/094d4ec8-4c21-4aa6-817f-b7e45843c5e0";

export const RIDE_EVIDENCE_LEGEND = Object.freeze({
  "surveyed": { block: "minecraft:cyan_concrete", label: "Survey/CAD", tier: "A" },
  "manufacturer-cad": { block: "minecraft:cyan_concrete", label: "Manufacturer CAD", tier: "A" },
  "planning-verified": { block: "minecraft:blue_concrete", label: "Planning drawing", tier: "B" },
  "measured-lidar": { block: "minecraft:lime_concrete", label: "Measured LiDAR", tier: "B" },
  "lidar-derived": { block: "minecraft:lime_concrete", label: "LiDAR-derived", tier: "C" },
  "interpolated-lidar": { block: "minecraft:gold_block", label: "Interpolated between LiDAR returns", tier: "C" },
  "interpolated": { block: "minecraft:gold_block", label: "Interpolated between verified anchors", tier: "C" },
  "inferred": { block: "minecraft:yellow_concrete", label: "Inferred", tier: "D" },
  "none": { block: "minecraft:orange_concrete", label: "2D plan only", tier: "E" }
});

/**
 * Adds traceable 3D ride profiles to normalized ride-track features.
 *
 * Direct profiles are georeferenced GeoJSON LineStrings whose coordinates are
 * [longitude, latitude, elevation metres AOD]. Raw LAS/LAZ data is treated as
 * EPSG:27700 and is sampled only inside a narrow OSM track corridor.
 */
export async function integrateRideProfiles({ map, sources, options = {}, progress = () => {} }) {
  const mode = options.rideProfileMode || "auto";
  if (!PROFILE_MODES.has(mode)) {
    throw new UserError("--ride-profile-mode must be auto, flat, profile, lidar, or hybrid");
  }
  const directFiles = asArray(options.rideProfile);
  const pointCloudFiles = asArray(options.ridePointCloud);
  if (mode === "flat") return summarizeRideProfiles(map.features, []);
  if (mode === "profile" && !directFiles.length) {
    throw new UserError("--ride-profile-mode profile requires at least one --ride-profile FILE");
  }
  if (mode === "lidar" && !pointCloudFiles.length) {
    throw new UserError("--ride-profile-mode lidar requires at least one --ride-point-cloud FILE");
  }
  if (mode === "hybrid" && !directFiles.length && !pointCloudFiles.length) {
    throw new UserError("--ride-profile-mode hybrid requires --ride-profile and/or --ride-point-cloud input");
  }

  const sourceCatalog = [];
  if (["auto", "profile", "hybrid"].includes(mode)) {
    for (const filename of directFiles) {
      progress(`Reading verified ride profile ${path.basename(filename)}`);
      const source = await applyDirectProfileFile(map, path.resolve(filename));
      sourceCatalog.push(source);
    }
  }

  if (["auto", "lidar", "hybrid"].includes(mode) && pointCloudFiles.length) {
    invariant(typeof sources.elevation?.projectLocal === "function",
      "Raw ride point clouds require --elevation ea-lidar or geotiff so EPSG:27700 and the local map use the same OSTN15 transform");
    const tracks = map.features.filter((feature) => feature.kind === "ride_track" && !feature.rideProfile);
    if (tracks.length) {
      const index = new PointCloudIndex({
        cellSizeM: Math.max(1, Number(options.rideCorridorM) || 2.5),
        bounds: projectedTrackBounds(tracks, sources.elevation.projectLocal, Number(options.rideCorridorM) || 2.5)
      });
      for (const filename of pointCloudFiles) {
        progress(`Reading raw LiDAR ride evidence ${path.basename(filename)}`);
        const loaded = await readPointCloud(path.resolve(filename), options, index.bounds);
        enrichPointCloudProvenance(loaded.source, sources.elevation);
        const beforeIndexed = index.pointCount;
        const beforeClassRejected = index.rejectedByClass;
        index.add(loaded);
        loaded.source.indexedPointCount = index.pointCount - beforeIndexed;
        loaded.source.classRejectedPointCount = index.rejectedByClass - beforeClassRejected;
        sourceCatalog.push(loaded.source);
      }
      progress(`Fitting 3D ride profiles from ${index.pointCount.toLocaleString()} relevant point returns`);
      for (const feature of tracks) {
        const profile = deriveFeatureProfileFromPointCloud({
          feature,
          pointIndex: index,
          projectLocal: sources.elevation.projectLocal,
          terrainAt: sources.elevation.sampleLocal,
          options,
          sourceCatalog: sourceCatalog.filter((source) => source.kind === "point-cloud")
        });
        if (profile) {
          feature.rideProfile = profile;
          feature.verification.vertical = profile.coverage.vertical > 0.99
            ? "lidar-derived"
            : "lidar-derived-partial";
          feature.vertical.explicit = profile.coverage.vertical > 0;
        }
      }
    }
  }

  const summary = summarizeRideProfiles(map.features, sourceCatalog);
  map.rideProfiles = summary;
  return summary;
}

async function applyDirectProfileFile(map, filename) {
  const collection = await readJson(filename);
  invariant(collection?.type === "FeatureCollection" && Array.isArray(collection.features),
    `${path.basename(filename)} must be a GeoJSON FeatureCollection`);
  let accepted = 0;
  for (const [index, raw] of collection.features.entries()) {
    const replacements = replacementIds(raw.properties || {});
    const replacementFeatures = replacements.length
      ? map.features.filter((candidate) => replacements.includes(candidate.id))
      : [];
    const feature = directProfileFeature(raw, map.projector, filename, index);
    inheritReplacementSemantics(feature, replacementFeatures);
    if (replacements.length) {
      map.features = map.features.filter((candidate) => !replacements.includes(candidate.id));
    }
    if (raw.properties?.replace_name === true) {
      const targetName = normalizedName(feature.name);
      map.features = map.features.filter((candidate) =>
        candidate.kind !== "ride_track" || normalizedName(candidate.name) !== targetName);
    }
    map.features.push(feature);
    accepted += 1;
  }
  return {
    kind: "direct-profile",
    file: path.basename(filename),
    sha256: await sha256File(filename),
    featureCount: accepted
  };
}

function inheritReplacementSemantics(feature, replacements) {
  if (!replacements.length) return;
  const inherited = {};
  const conflicts = new Set();
  for (const candidate of replacements) {
    for (const [key, value] of Object.entries(candidate.tags || {})) {
      if (conflicts.has(key)) continue;
      if (!Object.hasOwn(inherited, key)) inherited[key] = value;
      else if (String(inherited[key]) !== String(value)) {
        delete inherited[key];
        conflicts.add(key);
      }
    }
  }
  feature.tags = { ...inherited, ...(feature.tags || {}) };
  feature.rideProfile.planSemantics = {
    replacementFeatureIds: replacements.map((candidate) => candidate.id),
    sources: replacements.map((candidate) => candidate.source).filter(Boolean),
    inheritedTags: Object.fromEntries(Object.entries(inherited).filter(([key]) =>
      ["roller_coaster", "tunnel", "covered", "location", "layer", "bridge"].includes(key)
    )),
    conflicts: [...conflicts].sort(),
    alignment: measurePlanAlignment(feature.localGeometry, replacements.map((candidate) => candidate.localGeometry))
  };
}

function measurePlanAlignment(profileGeometry, sourceGeometries) {
  const profileLines = localGeometryLines(profileGeometry);
  const sourceLines = sourceGeometries.flatMap(localGeometryLines);
  if (!profileLines.length || !sourceLines.length) return null;
  const profilePoints = profileLines.flat();
  const sourcePoints = sourceLines.flat();
  const profileToSource = profilePoints.map((point) => nearestLineDistance(point, sourceLines));
  const sourceToProfile = sourcePoints.map((point) => nearestLineDistance(point, profileLines));
  const all = [...profileToSource, ...sourceToProfile].filter(Number.isFinite);
  const mean = (values) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
  const maxM = all.length ? Math.max(...all) : null;
  return {
    method: "bidirectional vertex-to-segment distance in local metres",
    profileToSourceMeanM: round3(mean(profileToSource)),
    sourceToProfileMeanM: round3(mean(sourceToProfile)),
    maxM: round3(maxM),
    status: maxM === null ? "unknown" : maxM <= 1 ? "aligned-within-1m" : maxM <= 3 ? "aligned-within-3m" : "review-required"
  };
}

function localGeometryLines(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function nearestLineDistance(point, lines) {
  let best = Infinity;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      best = Math.min(best, pointSegmentDistance(point, line[index - 1], line[index]));
    }
  }
  return best;
}

function pointSegmentDistance(point, from, to) {
  const dx = to[0] - from[0], dz = to[1] - from[1];
  const length2 = dx * dx + dz * dz;
  if (!length2) return Math.hypot(point[0] - from[0], point[1] - from[1]);
  const fraction = Math.max(0, Math.min(1,
    ((point[0] - from[0]) * dx + (point[1] - from[1]) * dz) / length2
  ));
  return Math.hypot(point[0] - (from[0] + dx * fraction), point[1] - (from[1] + dz * fraction));
}

function directProfileFeature(raw, projector, filename, featureIndex) {
  const properties = raw?.properties || {};
  const geometry = raw?.geometry;
  invariant(["LineString", "MultiLineString"].includes(geometry?.type),
    `Ride profile ${featureIndex + 1} in ${path.basename(filename)} must be a LineString or MultiLineString`);
  const coordinateParts = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  invariant(coordinateParts.length && coordinateParts.every((part) => part.length >= 2),
    `Ride profile ${featureIndex + 1} has no usable line geometry`);
  const evidence = properties.evidence;
  invariant(DIRECT_EVIDENCE.has(evidence),
    `Ride profile ${featureIndex + 1} must declare evidence as ${[...DIRECT_EVIDENCE].join(", ")}`);
  invariant(properties.elevation_datum === "ODN" || properties.elevation_datum === "absolute-metres",
    `Ride profile ${featureIndex + 1} must declare elevation_datum as ODN or absolute-metres`);
  if (!["interpolated", "inferred"].includes(evidence)) {
    invariant(properties.source_name && properties.license && properties.checked_at,
      `Verified ride profile ${featureIndex + 1} requires source_name, license, and checked_at`);
  }

  const evidenceParts = normalizeNestedProperty(properties.evidence_by_vertex, coordinateParts);
  const confidenceParts = normalizeNestedProperty(properties.confidence_by_vertex, coordinateParts);
  const bankingParts = normalizeNestedProperty(properties.banking_deg, coordinateParts);
  let flatIndex = 0;
  const allowGaps = properties.allow_gaps === true;
  const parts = coordinateParts.map((coordinates, partIndex) => coordinates.map((coordinate, vertexIndex) => {
    invariant(Array.isArray(coordinate) && coordinate.length >= 3 && coordinate.slice(0, 2).every(Number.isFinite) &&
      (Number.isFinite(coordinate[2]) || (allowGaps && coordinate[2] === null)),
    `Every coordinate in ride profile ${featureIndex + 1} must be [longitude, latitude, elevation]${allowGaps ? " with null allowed for declared gaps" : ""}`);
    const [x, z] = projector.forward(coordinate);
    const vertexEvidence = evidenceParts?.[partIndex]?.[vertexIndex] || evidence;
    invariant(DIRECT_EVIDENCE.has(vertexEvidence) || vertexEvidence === "interpolated-lidar" ||
      (allowGaps && vertexEvidence === "none"),
      `Unsupported evidence value at ride-profile vertex ${flatIndex + 1}: ${vertexEvidence}`);
    invariant(Number.isFinite(coordinate[2]) ? vertexEvidence !== "none" : vertexEvidence === "none",
      `Ride profile ${featureIndex + 1} must pair null elevation only with evidence=none`);
    const defaultConfidence = confidenceForEvidence(vertexEvidence);
    const suppliedConfidence = numberOrNull(confidenceParts?.[partIndex]?.[vertexIndex]);
    flatIndex += 1;
    return {
      x,
      z,
      elevationM: Number.isFinite(coordinate[2]) ? coordinate[2] : null,
      bankingDeg: null,
      evidence: vertexEvidence,
      confidence: clamp(suppliedConfidence ?? numberOrNull(properties.confidence) ?? defaultConfidence, 0, 1),
      sourceRef: properties.source_url || path.basename(filename)
    };
  }));
  const name = properties.ride_name || properties.name || null;
  const source = {
    provider: properties.source_name || "Supplied ride profile",
    sourceUrl: properties.source_url || null,
    timestamp: properties.checked_at || null,
    license: properties.license || null,
    file: path.basename(filename)
  };
  const profile = finalizeProfile({
    method: properties.method || evidence,
    parts,
    source,
    warnings: bankingParts
      ? ["Supplied banking values were ignored because ride tracks render as a one-block centreline."]
      : [],
    validation: properties.validation || null
  });
  const twoDimensional = coordinateParts.map((part) => part.map(([lon, lat]) => [lon, lat]));
  const localParts = parts.map((part) => part.map((sample) => [sample.x, sample.z]));
  return {
    id: properties.id || `ride-profile:${path.basename(filename)}:${featureIndex}:${sha256(raw).slice(0, 12)}`,
    name,
    kind: "ride_track",
    subtype: properties.subtype || "coaster",
    tags: properties,
    geometry: geometry.type === "LineString"
      ? { type: "LineString", coordinates: twoDimensional[0] }
      : { type: "MultiLineString", coordinates: twoDimensional },
    localGeometry: geometry.type === "LineString"
      ? { type: "LineString", coordinates: localParts[0] }
      : { type: "MultiLineString", coordinates: localParts },
    vertical: {
      heightM: null,
      heightSource: null,
      minHeightM: 0,
      elevationM: null,
      explicit: true
    },
    source,
    verification: {
      plan: properties.plan_verified === false ? "profile-unverified-plan" : "profile-supplied",
      vertical: evidence
    },
    rideProfile: profile
  };
}

async function readPointCloud(filename, options, bounds = null) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".json") return readJsonPointCloud(filename);
  if (![".las", ".laz"].includes(extension)) {
    throw new UserError(`Unsupported point-cloud file: ${path.basename(filename)} (use .las, .laz, or test .json)`);
  }
  const details = await stat(filename);
  const maxMb = Math.max(1, Number(options.maxPointCloudMb) || 1200);
  if (details.size > maxMb * 1024 * 1024) {
    throw new UserError(
      `${path.basename(filename)} is ${(details.size / 1024 / 1024).toFixed(1)} MB; the in-memory safety limit is ${maxMb} MB`,
      "Crop the LAZ to the park first, increase --point-cloud-skip, or deliberately raise --max-point-cloud-mb."
    );
  }
  const skip = Math.max(1, Math.round(Number(options.pointCloudSkip) || 1));
  const bytes = await readFile(filename);
  let header;
  try {
    const Las = await loadLas();
    header = Las.Header.parse(bytes.subarray(0, Math.min(bytes.length, 375)));
  } catch (error) {
    throw new UserError(`Could not read point-cloud header ${path.basename(filename)}`, error?.message || String(error));
  }
  invariant(header.pointCount > 0 && header.pointDataRecordLength >= 20,
    `${path.basename(filename)} contains no readable point records`);
  const decoded = await decodeLazCorridor({ bytes, header, bounds, skip, filename });
  const fileHash = await sha256File(filename);
  return {
    positions: decoded.positions,
    classifications: decoded.classifications,
    intensities: decoded.intensities,
    source: {
      kind: "point-cloud",
      file: path.basename(filename),
      sha256: fileHash,
      format: extension.slice(1).toUpperCase(),
      lasVersion: `${header.majorVersion}.${header.minorVersion}`,
      pointDataRecordFormat: header.pointDataRecordFormat,
      sourcePointCount: header.pointCount,
      decodedPointCount: header.pointCount,
      boundsRetainedPointCount: decoded.positions.length / 3,
      boundsRejectedPointCount: decoded.rejectedByBounds,
      skip,
      crs: "EPSG:27700"
    }
  };
}

async function decodeLazCorridor({ bytes, header, bounds, skip, filename }) {
  const Las = await loadLas();
  const pointFormat = header.pointDataRecordFormat & 0x3f;
  invariant([0, 1, 2, 3, 6, 7, 8].includes(pointFormat),
    `${path.basename(filename)} uses unsupported LAS point format ${pointFormat}`);
  const LazPerf = await Las.PointData.createLazPerf();
  const blobPointer = LazPerf._malloc(bytes.byteLength);
  const pointPointer = LazPerf._malloc(header.pointDataRecordLength);
  invariant(blobPointer && pointPointer, `Not enough memory to decode ${path.basename(filename)}`);
  const reader = new LazPerf.LASZip();
  const positions = [], classifications = [], intensities = [];
  let rejectedByBounds = 0, relevantIndex = 0;
  try {
    LazPerf.HEAPU8.set(bytes, blobPointer);
    reader.open(blobPointer, bytes.byteLength);
    let pointView = new DataView(LazPerf.HEAPU8.buffer, pointPointer, header.pointDataRecordLength);
    for (let index = 0; index < header.pointCount; index += 1) {
      reader.getPoint(pointPointer);
      if (pointView.buffer !== LazPerf.HEAPU8.buffer) {
        pointView = new DataView(LazPerf.HEAPU8.buffer, pointPointer, header.pointDataRecordLength);
      }
      const easting = pointView.getInt32(0, true) * header.scale[0] + header.offset[0];
      const northing = pointView.getInt32(4, true) * header.scale[1] + header.offset[1];
      if (bounds && (easting < bounds.minX || easting > bounds.maxX ||
        northing < bounds.minY || northing > bounds.maxY)) {
        rejectedByBounds += 1;
        continue;
      }
      if (relevantIndex++ % skip !== 0) continue;
      const elevation = pointView.getInt32(8, true) * header.scale[2] + header.offset[2];
      const classification = pointFormat >= 6
        ? pointView.getUint8(16)
        : pointView.getUint8(15) & 0x1f;
      positions.push(easting, northing, elevation);
      classifications.push(classification);
      intensities.push(pointView.getUint16(12, true));
    }
  } catch (error) {
    throw new UserError(`Could not decode point cloud ${path.basename(filename)}`, error?.message || String(error));
  } finally {
    reader.delete();
    LazPerf._free(pointPointer);
    LazPerf._free(blobPointer);
  }
  return {
    positions: Float64Array.from(positions),
    classifications: Uint8Array.from(classifications),
    intensities: Uint16Array.from(intensities),
    rejectedByBounds
  };
}

function enrichPointCloudProvenance(source, elevation) {
  const tile = elevation?.survey?.tiles?.find((candidate) => candidate.pointCloud === source.file);
  if (!tile) return;
  source.provider = "Environment Agency National LiDAR Programme Point Cloud";
  source.tile = tile.tile;
  source.surveyId = tile.surveyId;
  source.surveyDate = tile.flownFrom || tile.flownTo || null;
  source.resolutionM = tile.resolutionM;
  source.dataset = EA_POINT_CLOUD_DATASET;
  source.terrainDataset = elevation.dataset || null;
  source.license = elevation.license || null;
  source.attribution = elevation.attribution || null;
}

async function readJsonPointCloud(filename) {
  const data = await readJson(filename);
  invariant(data?.crs === "EPSG:27700" && Array.isArray(data.points),
    "JSON point-cloud fixtures must declare crs EPSG:27700 and a points array");
  const positions = new Float64Array(data.points.length * 3);
  const classifications = new Uint8Array(data.points.length);
  const intensities = new Uint16Array(data.points.length);
  data.points.forEach((point, index) => {
    const values = Array.isArray(point) ? point : [point.x, point.y, point.z, point.classification, point.intensity];
    invariant(values.slice(0, 3).every(Number.isFinite), "Point-cloud JSON contains an invalid XYZ coordinate");
    positions.set(values.slice(0, 3), index * 3);
    classifications[index] = Number(values[3]) || 0;
    intensities[index] = Number(values[4]) || 0;
  });
  return {
    positions,
    classifications,
    intensities,
    source: {
      kind: "point-cloud",
      file: path.basename(filename),
      sha256: await sha256File(filename),
      format: "JSON fixture",
      sourcePointCount: data.points.length,
      decodedPointCount: data.points.length,
      skip: 1,
      crs: data.crs
    }
  };
}

class PointCloudIndex {
  constructor({ cellSizeM, bounds }) {
    this.cellSizeM = cellSizeM;
    this.bounds = bounds;
    this.cells = new Map();
    this.pointCount = 0;
    this.rejectedByBounds = 0;
    this.rejectedByClass = 0;
  }

  add(cloud) {
    const positions = cloud.positions;
    const classes = cloud.classifications;
    const intensities = cloud.intensities;
    for (let index = 0; index < positions.length / 3; index += 1) {
      const easting = positions[index * 3];
      const northing = positions[index * 3 + 1];
      const elevation = positions[index * 3 + 2];
      if (!Number.isFinite(easting) || !Number.isFinite(northing) || !Number.isFinite(elevation)) continue;
      if (this.bounds && (easting < this.bounds.minX || easting > this.bounds.maxX ||
        northing < this.bounds.minY || northing > this.bounds.maxY)) {
        this.rejectedByBounds += 1;
        continue;
      }
      const classification = classes?.[index] ?? 0;
      if (!DEFAULT_POINT_CLASSES.has(classification)) {
        this.rejectedByClass += 1;
        continue;
      }
      const key = this.key(easting, northing);
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push([easting, northing, elevation, classification, intensities?.[index] || 0]);
      this.pointCount += 1;
    }
  }

  near(easting, northing, radiusM) {
    const minX = Math.floor((easting - radiusM) / this.cellSizeM);
    const maxX = Math.floor((easting + radiusM) / this.cellSizeM);
    const minY = Math.floor((northing - radiusM) / this.cellSizeM);
    const maxY = Math.floor((northing + radiusM) / this.cellSizeM);
    const radius2 = radiusM * radiusM;
    const result = [];
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        for (const point of this.cells.get(`${x},${y}`) || []) {
          const dx = point[0] - easting, dy = point[1] - northing;
          if (dx * dx + dy * dy <= radius2) result.push(point);
        }
      }
    }
    return result;
  }

  key(easting, northing) {
    return `${Math.floor(easting / this.cellSizeM)},${Math.floor(northing / this.cellSizeM)}`;
  }
}

function deriveFeatureProfileFromPointCloud({
  feature, pointIndex, projectLocal, terrainAt, options, sourceCatalog
}) {
  const lines = localLineStrings(feature.localGeometry);
  const parts = lines.map((line) => extractRideProfileFromPoints({
    line,
    pointIndex,
    projectLocal,
    terrainAt,
    sampleSpacingM: Math.max(0.5, Number(options.rideSampleM) || 1),
    corridorM: Math.max(0.75, Number(options.rideCorridorM) || 2.5),
    maxInterpolationGapM: Math.max(0, Number(options.rideInterpolationGapM) || 12),
    minConfidence: clamp(Number(options.minRideProfileConfidence) || 0.55, 0, 1)
  }));
  const sampleCount = parts.reduce((sum, part) => sum + part.length, 0);
  const verticalCount = parts.flat().filter((sample) => Number.isFinite(sample.elevationM)).length;
  if (!sampleCount || !verticalCount) return null;
  return finalizeProfile({
    method: "OSM corridor + classified raw LiDAR point returns + continuity-constrained spline samples",
    parts,
    source: {
      provider: "Raw classified LiDAR point cloud",
      files: sourceCatalog.map((source) => source.file),
      hashes: sourceCatalog.map((source) => source.sha256),
      surveyDates: sourceCatalog.map((source) => source.surveyDate).filter(Boolean),
      datasets: [...new Set(sourceCatalog.map((source) => source.dataset).filter(Boolean))],
      license: sourceCatalog.map((source) => source.license).find(Boolean) || null,
      crs: "EPSG:27700"
    },
    warnings: [
      "Automated LiDAR classification can confuse rails with supports, buildings, or vegetation.",
      ...(verticalCount < sampleCount ? ["Unobserved gaps remain 2D-only unless bounded interpolation was possible."] : [])
    ]
  });
}

/**
 * Public for deterministic unit testing and alternate point-cloud adapters.
 */
export function extractRideProfileFromPoints({
  line,
  pointIndex,
  projectLocal = (point) => point,
  terrainAt = () => 0,
  sampleSpacingM = 1,
  corridorM = 2.5,
  maxInterpolationGapM = 12,
  minConfidence = 0.55
}) {
  const samples = resampleLine(line, sampleSpacingM).map((sample) => {
    const [easting, northing] = projectLocal([sample.x, sample.z]);
    const terrain = terrainAt(sample.x, sample.z);
    const candidates = clusterHeightCandidates(
      pointIndex.near(easting, northing, corridorM),
      Number.isFinite(terrain) ? terrain : null
    );
    return { ...sample, easting, northing, terrainM: terrain, candidates };
  });
  chooseContinuousCandidates(samples);
  for (const sample of samples) {
    const chosen = sample.chosen;
    if (!chosen || chosen.confidence < minConfidence) {
      sample.elevationM = null;
      sample.bankingDeg = null;
      sample.evidence = "none";
      sample.confidence = 0;
    } else {
      sample.elevationM = chosen.elevationM;
      sample.bankingDeg = null;
      sample.evidence = "lidar-derived";
      sample.confidence = chosen.confidence;
      sample.returnCount = chosen.count;
      sample.classifications = chosen.classifications;
    }
    delete sample.candidates;
    delete sample.chosen;
    delete sample.easting;
    delete sample.northing;
  }
  interpolateShortGaps(samples, maxInterpolationGapM);
  return samples;
}

function clusterHeightCandidates(points, terrainM) {
  const binSize = 0.5;
  const bins = new Map();
  for (const point of points) {
    const elevation = point[2];
    const relative = Number.isFinite(terrainM) ? elevation - terrainM : null;
    if (relative !== null && (relative < 0.45 || relative > 80)) continue;
    const key = Math.round(elevation / binSize);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(point);
  }
  return [...bins.values()].map((group) => {
    const elevations = group.map((point) => point[2]).sort((a, b) => a - b);
    const elevationM = percentile(elevations, 0.5);
    const classifications = countBy(group, (point) => String(point[3]));
    const unclassifiedShare = group.filter((point) => point[3] === 0 || point[3] === 1).length / group.length;
    const heightAboveTerrain = Number.isFinite(terrainM) ? elevationM - terrainM : 0;
    const densityScore = Math.min(1, Math.log2(group.length + 1) / 2.6);
    const baseConfidence = 0.36 + 0.34 * densityScore + 0.12 * unclassifiedShare - Math.max(0, heightAboveTerrain - 45) * 0.004;
    return {
      elevationM,
      count: group.length,
      classifications,
      quality: Math.log2(group.length + 1) * 1.35 + unclassifiedShare * 0.35 - heightAboveTerrain * 0.008,
      baseConfidence: clamp(baseConfidence, 0.25, 0.86)
    };
  }).sort((a, b) => b.quality - a.quality).slice(0, 8);
}

function chooseContinuousCandidates(samples) {
  let start = 0;
  while (start < samples.length) {
    while (start < samples.length && !samples[start].candidates.length) start += 1;
    if (start >= samples.length) break;
    let end = start;
    while (end + 1 < samples.length && samples[end + 1].candidates.length) end += 1;
    const scores = [], previous = [];
    for (let index = start; index <= end; index += 1) {
      const candidates = samples[index].candidates;
      scores[index] = new Array(candidates.length).fill(-Infinity);
      previous[index] = new Array(candidates.length).fill(-1);
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex];
        if (index === start) {
          scores[index][candidateIndex] = candidate.quality;
          continue;
        }
        const distance = Math.max(0.25, samples[index].chainageM - samples[index - 1].chainageM);
        for (let priorIndex = 0; priorIndex < samples[index - 1].candidates.length; priorIndex += 1) {
          const prior = samples[index - 1].candidates[priorIndex];
          const delta = Math.abs(candidate.elevationM - prior.elevationM);
          const slope = delta / distance;
          if (slope > 3.5) continue;
          const transitionPenalty = delta * 0.34 + Math.max(0, slope - 1.15) * 1.8;
          const value = scores[index - 1][priorIndex] + candidate.quality - transitionPenalty;
          if (value > scores[index][candidateIndex]) {
            scores[index][candidateIndex] = value;
            previous[index][candidateIndex] = priorIndex;
          }
        }
      }
    }
    let cursor = scores[end].reduce((best, value, index, values) => value > values[best] ? index : best, 0);
    for (let index = end; index >= start; index -= 1) {
      const candidate = samples[index].candidates[cursor];
      if (!candidate) break;
      const second = samples[index].candidates.find((value, candidateIndex) => candidateIndex !== cursor);
      const ambiguity = second ? clamp(1 - Math.abs(candidate.quality - second.quality) / 3, 0, 1) : 0;
      const continuity = index === start ? 0.6 : clamp(1 - Math.abs(
        candidate.elevationM - (samples[index - 1].candidates[previous[index][cursor]]?.elevationM ?? candidate.elevationM)
      ) / 5, 0, 1);
      candidate.confidence = clamp(candidate.baseConfidence + continuity * 0.12 - ambiguity * 0.08, 0, 0.9);
      samples[index].chosen = candidate;
      cursor = previous[index][cursor];
      if (cursor < 0 && index > start) break;
    }
    start = end + 1;
  }
}

function interpolateShortGaps(samples, maxGapM) {
  if (maxGapM <= 0) return;
  let index = 0;
  while (index < samples.length) {
    if (Number.isFinite(samples[index].elevationM)) { index += 1; continue; }
    const start = index;
    while (index < samples.length && !Number.isFinite(samples[index].elevationM)) index += 1;
    const left = samples[start - 1], right = samples[index];
    if (!left || !right || !Number.isFinite(left.elevationM) || !Number.isFinite(right.elevationM)) continue;
    const gap = right.chainageM - left.chainageM;
    if (gap > maxGapM) continue;
    for (let cursor = start; cursor < index; cursor += 1) {
      const fraction = (samples[cursor].chainageM - left.chainageM) / gap;
      samples[cursor].elevationM = left.elevationM + (right.elevationM - left.elevationM) * fraction;
      samples[cursor].bankingDeg = null;
      samples[cursor].evidence = "interpolated-lidar";
      samples[cursor].confidence = Math.min(left.confidence, right.confidence) * 0.72;
      samples[cursor].interpolatedBetweenM = [left.chainageM, right.chainageM];
    }
  }
}

function finalizeProfile({ method, parts, source, warnings = [], validation = null }) {
  const samples = parts.flat();
  const vertical = samples.filter((sample) => Number.isFinite(sample.elevationM));
  const ignoredBankingSamples = samples.filter((sample) => Number.isFinite(sample.bankingDeg)).length;
  for (const sample of samples) sample.bankingDeg = null;
  const evidenceCounts = countBy(samples, (sample) => sample.evidence || "none");
  const verticalCoverage = samples.length ? vertical.length / samples.length : 0;
  const confidence = vertical.length
    ? vertical.reduce((sum, sample) => sum + (sample.confidence || 0), 0) / vertical.length
    : 0;
  return {
    schemaVersion: 1,
    representation: "one-block-centreline",
    widthBlocks: 1,
    bankingRendered: false,
    crossTiesRendered: false,
    method,
    source,
    coordinateReference: { horizontal: "local 1 m map grid", elevation: "metres ODN/declared absolute datum" },
    parts,
    sampleCount: samples.length,
    evidenceCounts,
    coverage: {
      vertical: round3(verticalCoverage),
      banking: 0
    },
    confidence: round3(confidence),
    heightRangeM: vertical.length ? {
      min: round3(Math.min(...vertical.map((sample) => sample.elevationM))),
      max: round3(Math.max(...vertical.map((sample) => sample.elevationM)))
    } : null,
    bankingMethod: "not-rendered-one-block-centreline",
    warnings: [
      ...warnings,
      ...(ignoredBankingSamples && !warnings.some((warning) => warning.includes("banking"))
        ? [`Ignored banking values on ${ignoredBankingSamples} sample(s); the renderer emits only a one-block centreline.`]
        : [])
    ],
    validation
  };
}

export function summarizeRideProfiles(features, sourceCatalog = []) {
  const tracks = features.filter((feature) => feature.kind === "ride_track");
  const groups = new Map();
  for (const feature of tracks) {
    const key = feature.name || feature.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(feature);
  }
  const rides = [...groups.entries()].map(([key, group]) => {
    const profiles = group.map((feature) => feature.rideProfile).filter(Boolean);
    const samples = profiles.flatMap((profile) => profile.parts.flat());
    const totalPlanSamples = profiles.length
      ? samples.length
      : group.reduce((sum, feature) => sum + localLineStrings(feature.localGeometry).reduce((n, line) => n + line.length, 0), 0);
    const vertical = samples.filter((sample) => Number.isFinite(sample.elevationM));
    const evidenceCounts = countBy(samples, (sample) => sample.evidence || "none");
    const profileSources = uniqueObjects(profiles.map((profile) => profile.source));
    const latestEvidenceDate = latestSourceDate(profileSources);
    const verticalCoverage = totalPlanSamples ? vertical.length / totalPlanSamples : 0;
    return {
      name: group[0].name || null,
      key,
      featureIds: group.map((feature) => feature.id),
      representation: "one-block-centreline",
      widthBlocks: 1,
      bankingRendered: false,
      crossTiesRendered: false,
      status: verticalCoverage >= 0.999
        ? "full-3d-centreline"
        : verticalCoverage > 0 ? "partial-3d-centreline" : "2d-centreline",
      verticalCoverage: round3(verticalCoverage),
      bankingCoverage: 0,
      confidence: vertical.length
        ? round3(vertical.reduce((sum, sample) => sum + (sample.confidence || 0), 0) / vertical.length)
        : 0,
      evidenceCounts,
      profileMethods: [...new Set(profiles.map((profile) => profile.method))],
      sources: profileSources,
      latestEvidenceDate,
      heightRangeM: vertical.length ? {
        min: round3(Math.min(...vertical.map((sample) => sample.elevationM))),
        max: round3(Math.max(...vertical.map((sample) => sample.elevationM)))
      } : null
    };
  }).sort((a, b) => String(a.name || a.key).localeCompare(String(b.name || b.key)));
  const profiledFeatures = tracks.filter((feature) => feature.rideProfile);
  const verticalCoverage = weightedProfileCoverage(tracks, "vertical");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    legend: RIDE_EVIDENCE_LEGEND,
    sourceCatalog,
    representation: {
      track: "one-block-centreline",
      widthBlocks: 1,
      bankingRendered: false,
      crossTiesRendered: false
    },
    totals: {
      trackFeatures: tracks.length,
      profiledTrackFeatures: profiledFeatures.length,
      namedRides: rides.filter((ride) => ride.name).length,
      verticalCoverage: round3(verticalCoverage),
      bankingCoverage: 0
    },
    rides,
    profiles: profiledFeatures.map((feature) => ({
      featureId: feature.id,
      name: feature.name,
      subtype: feature.subtype,
      profile: feature.rideProfile
    }))
  };
}

function weightedProfileCoverage(tracks, component) {
  let numerator = 0, denominator = 0;
  for (const feature of tracks) {
    const weight = Math.max(1, localLineStrings(feature.localGeometry).reduce((sum, line) => sum + lineLength(line), 0));
    numerator += weight * (feature.rideProfile?.coverage?.[component] || 0);
    denominator += weight;
  }
  return denominator ? numerator / denominator : 0;
}

function projectedTrackBounds(tracks, projectLocal, padding) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const feature of tracks) {
    for (const line of localLineStrings(feature.localGeometry)) {
      for (const point of line) {
        const [x, y] = projectLocal(point);
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }
  }
  if (!Number.isFinite(bounds.minX)) return null;
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding
  };
}

function resampleLine(line, spacingM) {
  if (!line?.length) return [];
  const result = [{ x: line[0][0], z: line[0][1], chainageM: 0 }];
  let chainage = 0;
  for (let index = 1; index < line.length; index += 1) {
    const [x0, z0] = line[index - 1], [x1, z1] = line[index];
    const length = Math.hypot(x1 - x0, z1 - z0);
    if (!length) continue;
    const steps = Math.max(1, Math.ceil(length / spacingM));
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / steps;
      result.push({
        x: x0 + (x1 - x0) * fraction,
        z: z0 + (z1 - z0) * fraction,
        chainageM: chainage + length * fraction
      });
    }
    chainage += length;
  }
  return result;
}

function localLineStrings(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function lineLength(line) {
  let result = 0;
  for (let index = 1; index < line.length; index += 1) {
    result += Math.hypot(line[index][0] - line[index - 1][0], line[index][1] - line[index - 1][1]);
  }
  return result;
}

function replacementIds(properties) {
  const value = properties.replaces ?? properties.target_id;
  return asArray(value).flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}

function normalizeNestedProperty(value, coordinateParts) {
  if (!Array.isArray(value)) return null;
  if (coordinateParts.length === 1 && !Array.isArray(value[0])) return [value];
  return value;
}

function confidenceForEvidence(evidence) {
  return ({
    "surveyed": 0.98,
    "manufacturer-cad": 0.99,
    "planning-verified": 0.9,
    "measured-lidar": 0.88,
    "lidar-derived": 0.72,
    "interpolated-lidar": 0.58,
    "interpolated": 0.65,
    "inferred": 0.35
  })[evidence] ?? 0;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

function countBy(values, selector) {
  const result = {};
  for (const value of values) {
    const key = selector(value);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function uniqueObjects(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function latestSourceDate(sources) {
  const candidates = sources.flatMap((source) => [
    source?.timestamp,
    source?.surveyDate,
    ...(Array.isArray(source?.surveyDates) ? source.surveyDates : [])
  ]).filter(Boolean).map((value) => new Date(value)).filter((value) => Number.isFinite(value.getTime()));
  if (!candidates.length) return null;
  return new Date(Math.max(...candidates.map((value) => value.getTime()))).toISOString();
}

const normalizedName = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round3 = (value) => Math.round(value * 1000) / 1000;
const asArray = (value) => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
