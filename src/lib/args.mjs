import { UserError } from "./errors.mjs";

const VALUE_FLAGS = new Set([
  "park", "park-name", "bbox", "osm", "out", "input", "page", "mime", "contact", "overpass-url",
  "nominatim-url", "cache", "elevation", "open-meteo-url",
  "open-meteo-api-key", "elevation-spacing", "dtm", "dsm", "ostn15-grid",
  "ea-dtm-wcs-url", "ea-dsm-wcs-url", "ea-index-wfs-url", "override", "overture",
  "public-data", "source-fusion-tolerance-m", "source-config", "os-openmap-local",
  "planning", "planning-manifest", "planning-world-authority", "max-planning-document-mb",
  "planit-url", "max-planning-applications", "max-planning-documents",
  "max-planning-pages-per-document", "planning-georef-min-confidence", "planning-plan",
  "planning-shard-index", "planning-shard-count", "prepared-planning-directory",
  "planning-datasets", "planning-data-url", "trees-outside-woodland-url",
  "trees-outside-woodland-collection", "microsoft-buildings-index-url",
  "microsoft-buildings-min-confidence", "wikidata-url", "wikidata-limit",
  "wikimedia-commons-url", "wikimedia-commons-limit", "open-aerial-map-url",
  "os-ngd-api-key", "os-ngd-url", "os-ngd-collections", "os-ngd-license", "os-ngd-max-collections",
  "tree-species-map", "tree-species-map-url", "tree-species-legend", "tree-species-min-confidence",
  "max-supplemental-features", "supplemental-page-size",
  "max-supplemental-download-mb", "scale",
  "max-area-km2", "max-cells", "min-confidence", "accuracy-mode",
  "minecraft-server-version", "min-engine-version", "ops-per-yield",
  "build-depth", "base-y", "palette", "world-margin", "max-world-chunks",
  "chunk-version", "block-data-version", "seed", "buildings",
  "ride-profile", "ride-point-cloud", "ride-profile-mode", "ride-corridor-m",
  "ride-sample-m", "ride-interpolation-gap-m", "point-cloud-skip",
  "max-point-cloud-mb", "min-ride-profile-confidence", "path-width-mode",
  "ride-terrain-mode", "ride-tunnel-width-m", "ride-tunnel-above-m",
  "ride-tunnel-below-m", "ride-tunnel-cover-m", "orthophoto", "orthophoto-source",
  "orthophoto-source-url", "orthophoto-license", "orthophoto-date",
  "orthophoto-crs", "orthophoto-proj4", "orthophoto-mode",
  "orthophoto-max-gsd-m", "orthophoto-sample-m", "orthophoto-path-max-width-m",
  "orthophoto-min-confidence", "orthophoto-material-min-confidence",
  "orthophoto-pattern-min-confidence", "orthophoto-edge-delta-e",
  "orthophoto-landcover-sample-m", "max-orthophoto-mb", "max-orthophoto-pixels",
  "path-geometry-mode", "path-snap-tolerance-m", "path-snap-min-confidence", "path-edge-mode",
  "path-discovery-mode", "path-discovery-grid-m", "path-discovery-colour-delta-e",
  "path-discovery-pixel-confidence", "path-discovery-min-confidence",
  "path-discovery-min-area-m2", "path-discovery-min-novel-area-m2",
  "path-discovery-min-edge-m", "path-discovery-existing-buffer-m",
  "path-discovery-terrain-sample-m", "path-discovery-steep-grade-percent",
  "path-discovery-ramp-grade-percent", "max-path-discovery-cells", "path-terrain-mode",
  "path-terrain-max-cut-fill-m", "terrain-detail-mode", "terrain-rock-density-per-100m2",
  "terrain-rock-min-spacing-m", "terrain-cliff-marker-spacing-m", "max-terrain-rocks",
  "aerial-terrain-mode", "aerial-terrain-grid-m", "aerial-terrain-min-confidence",
  "tree-density-per-100m2", "shrub-density-per-100m2", "tree-line-spacing-m",
  "vegetation-min-spacing-m", "max-vegetation-models"
]);

const BOOLEAN_FLAGS = new Set([
  "help", "strict", "accept-nominatim-policy", "accept-open-meteo-terms",
  "commercial", "allow-large-area", "no-cache", "no-addon", "no-world", "no-preview",
  "no-dsm", "no-ride-info-signs", "quiet", "england-open-data",
  "trees-outside-woodland", "planning-data", "microsoft-buildings",
  "wikidata-places", "wikimedia-commons", "open-aerial-map",
  "os-ngd",
  "tree-species",
  "strict-supplemental-sources", "no-auto-planning", "allow-prepared-planning-fallback"
]);

export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0]?.startsWith("--") ? "help" : (args.shift() || "help");
  const options = {
    override: [], overture: [], publicData: [], sourceConfig: [], osOpenMapLocal: [],
    planning: [], planningManifest: [], rideProfile: [], ridePointCloud: [], orthophoto: []
  };

  while (args.length) {
    const token = args.shift();
    if (!token.startsWith("--")) {
      throw new UserError(`Unexpected positional argument: ${token}`);
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const key = equals >= 0 ? body.slice(0, equals) : body;
    let value = equals >= 0 ? body.slice(equals + 1) : undefined;

    if (BOOLEAN_FLAGS.has(key)) {
      options[toCamel(key)] = value === undefined ? true : value !== "false";
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new UserError(`Unknown option: --${key}`);
    if (value === undefined) value = args.shift();
    if (value === undefined || value.startsWith("--")) {
      throw new UserError(`Option --${key} requires a value`);
    }
    const camel = toCamel(key);
    if (key === "override") options.override.push(value);
    else if (key === "overture") options.overture.push(value);
    else if (key === "public-data") options.publicData.push(value);
    else if (key === "planning") options.planning.push(value);
    else if (key === "planning-manifest") options.planningManifest.push(value);
    else if (key === "source-config") options.sourceConfig.push(value);
    else if (key === "os-openmap-local") options.osOpenMapLocal.push(value);
    else if (key === "ride-profile") options.rideProfile.push(value);
    else if (key === "ride-point-cloud") options.ridePointCloud.push(value);
    else if (key === "orthophoto") options.orthophoto.push(value);
    else options[camel] = value;
  }

  return { command, options: normalize(options) };
}

function normalize(options) {
  const numberKeys = [
    "elevationSpacing", "scale", "maxAreaKm2", "maxCells", "minConfidence",
    "opsPerYield", "buildDepth", "baseY", "worldMargin", "maxWorldChunks",
    "chunkVersion", "blockDataVersion", "seed", "rideCorridorM", "rideSampleM",
    "rideInterpolationGapM", "pointCloudSkip", "maxPointCloudMb",
    "minRideProfileConfidence", "rideTunnelWidthM", "rideTunnelAboveM",
    "rideTunnelBelowM", "rideTunnelCoverM", "orthophotoMaxGsdM", "orthophotoSampleM",
    "orthophotoPathMaxWidthM", "orthophotoMinConfidence",
    "orthophotoMaterialMinConfidence", "orthophotoPatternMinConfidence",
    "orthophotoEdgeDeltaE", "orthophotoLandcoverSampleM", "maxOrthophotoMb",
    "maxOrthophotoPixels", "pathSnapToleranceM", "pathSnapMinConfidence",
    "pathDiscoveryGridM", "pathDiscoveryColourDeltaE",
    "pathDiscoveryPixelConfidence", "pathDiscoveryMinConfidence",
    "pathDiscoveryMinAreaM2", "pathDiscoveryMinNovelAreaM2", "pathDiscoveryMinEdgeM",
    "pathDiscoveryExistingBufferM", "pathDiscoveryTerrainSampleM",
    "pathDiscoverySteepGradePercent", "pathDiscoveryRampGradePercent",
    "maxPathDiscoveryCells", "pathTerrainMaxCutFillM", "sourceFusionToleranceM",
    "terrainRockDensityPer100m2",
    "terrainRockMinSpacingM", "terrainCliffMarkerSpacingM", "maxTerrainRocks",
    "aerialTerrainGridM", "aerialTerrainMinConfidence", "treeDensityPer100m2",
    "shrubDensityPer100m2", "treeLineSpacingM", "vegetationMinSpacingM",
    "maxVegetationModels", "microsoftBuildingsMinConfidence", "wikidataLimit", "page",
    "wikimediaCommonsLimit", "maxSupplementalFeatures", "supplementalPageSize",
    "maxSupplementalDownloadMb", "maxPlanningDocumentMb", "maxPlanningApplications",
    "maxPlanningDocuments", "maxPlanningPagesPerDocument", "planningGeorefMinConfidence",
    "planningShardIndex", "planningShardCount", "osNgdMaxCollections", "treeSpeciesMinConfidence"
  ];
  for (const key of numberKeys) {
    if (options[key] === undefined) continue;
    const value = Number(options[key]);
    if (!Number.isFinite(value)) throw new UserError(`--${toKebab(key)} must be a number`);
    options[key] = value;
  }
  if (options.minEngineVersion) {
    const parts = options.minEngineVersion.split(".").map(Number);
    if (parts.length !== 3 || parts.some((v) => !Number.isInteger(v) || v < 0)) {
      throw new UserError("--min-engine-version must look like 1.21.100");
    }
    options.minEngineVersion = parts;
  }
  if (options.pathWidthMode && !["inferred", "source-only"].includes(options.pathWidthMode)) {
    throw new UserError("--path-width-mode must be inferred or source-only");
  }
  if (options.rideTerrainMode && !["inferred", "evidence", "off"].includes(options.rideTerrainMode)) {
    throw new UserError("--ride-terrain-mode must be inferred, evidence, or off");
  }
  if (options.orthophotoMode && !["evidence", "assist", "off"].includes(options.orthophotoMode)) {
    throw new UserError("--orthophoto-mode must be evidence, assist, or off");
  }
  if (options.pathGeometryMode && !["repair", "qa", "off"].includes(options.pathGeometryMode)) {
    throw new UserError("--path-geometry-mode must be repair, qa, or off");
  }
  if (options.pathEdgeMode && !["evidence", "off"].includes(options.pathEdgeMode)) {
    throw new UserError("--path-edge-mode must be evidence or off");
  }
  if (options.pathDiscoveryMode && !["evidence", "qa", "off"].includes(options.pathDiscoveryMode)) {
    throw new UserError("--path-discovery-mode must be evidence, qa, or off");
  }
  if (options.pathTerrainMode && !["conform", "evidence", "off"].includes(options.pathTerrainMode)) {
    throw new UserError("--path-terrain-mode must be conform, evidence, or off");
  }
  if (options.terrainDetailMode && !["evidence", "plausible", "off"].includes(options.terrainDetailMode)) {
    throw new UserError("--terrain-detail-mode must be evidence, plausible, or off");
  }
  if (options.aerialTerrainMode && !["evidence", "qa", "off"].includes(options.aerialTerrainMode)) {
    throw new UserError("--aerial-terrain-mode must be evidence, qa, or off");
  }
  if (options.planningWorldAuthority && !["planning-only", "fixture"].includes(options.planningWorldAuthority)) {
    throw new UserError("--planning-world-authority must be planning-only or fixture");
  }
  options.planningWorldAuthority ||= "planning-only";
  if (options.microsoftBuildingsMinConfidence !== undefined &&
    (options.microsoftBuildingsMinConfidence < 0 || options.microsoftBuildingsMinConfidence > 1)) {
    throw new UserError("--microsoft-buildings-min-confidence must be between 0 and 1");
  }
  if (options.treeSpeciesMinConfidence !== undefined &&
    (options.treeSpeciesMinConfidence < 0 || options.treeSpeciesMinConfidence > 1)) {
    throw new UserError("--tree-species-min-confidence must be between 0 and 1");
  }
  for (const [key, minimum, maximum] of [
    ["maxPlanningApplications", 1, 2000],
    ["maxPlanningDocuments", 1, 500],
    ["maxPlanningPagesPerDocument", 1, 50]
  ]) {
    if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key] < minimum || options[key] > maximum)) {
      throw new UserError(`--${toKebab(key)} must be an integer between ${minimum} and ${maximum}`);
    }
  }
  if (options.planningShardCount !== undefined &&
    (!Number.isInteger(options.planningShardCount) || options.planningShardCount < 1 || options.planningShardCount > 64)) {
    throw new UserError("--planning-shard-count must be an integer between 1 and 64");
  }
  if (options.planningShardIndex !== undefined &&
    (!Number.isInteger(options.planningShardIndex) || options.planningShardIndex < 0 ||
      options.planningShardIndex >= (options.planningShardCount ?? 1))) {
    throw new UserError("--planning-shard-index must be zero-based and smaller than --planning-shard-count");
  }
  if (options.planningGeorefMinConfidence !== undefined &&
    (options.planningGeorefMinConfidence < 0.5 || options.planningGeorefMinConfidence > 1)) {
    throw new UserError("--planning-georef-min-confidence must be between 0.5 and 1");
  }
  for (const [key, minimum, maximum] of [
    ["wikidataLimit", 1, 2000], ["wikimediaCommonsLimit", 1, 500],
    ["maxSupplementalFeatures", 1, 500000], ["supplementalPageSize", 1, 10000],
    ["maxSupplementalDownloadMb", 1, 5000], ["osNgdMaxCollections", 1, 30]
  ]) {
    if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key] < minimum || options[key] > maximum)) {
      throw new UserError(`--${toKebab(key)} must be an integer between ${minimum} and ${maximum}`);
    }
  }
  validatePathRecoveryNumbers(options);
  if (options.orthophotoDate && !Number.isFinite(Date.parse(options.orthophotoDate))) {
    throw new UserError("--orthophoto-date must be an ISO date or timestamp");
  }
  if (options.page !== undefined && (!Number.isInteger(options.page) || options.page < 1 || options.page > 10_000)) {
    throw new UserError("--page must be an integer between 1 and 10000");
  }
  return options;
}

function validatePathRecoveryNumbers(options) {
  const range = (key, minimum, maximum, label = toKebab(key)) => {
    if (options[key] === undefined) return;
    if (options[key] < minimum || options[key] > maximum) {
      throw new UserError(`--${label} must be between ${minimum} and ${maximum}`);
    }
  };
  range("pathSnapToleranceM", 0.25, 10);
  range("pathSnapMinConfidence", 0, 1);
  range("pathDiscoveryGridM", 0.5, 10);
  range("pathDiscoveryColourDeltaE", 4, 100);
  range("pathDiscoveryPixelConfidence", 0, 1);
  range("pathDiscoveryMinConfidence", 0, 1);
  range("pathDiscoveryMinAreaM2", 1, 1_000_000);
  range("pathDiscoveryMinNovelAreaM2", 1, 1_000_000);
  range("pathDiscoveryMinEdgeM", 1, 10_000);
  range("pathDiscoveryExistingBufferM", 0, 100);
  range("pathDiscoveryTerrainSampleM", 1, 100);
  range("pathDiscoveryRampGradePercent", 0, 100);
  range("pathDiscoverySteepGradePercent", 0, 200);
  range("pathTerrainMaxCutFillM", 0, 8);
  range("sourceFusionToleranceM", 0.25, 25);
  range("terrainRockDensityPer100m2", 0, 20);
  range("terrainRockMinSpacingM", 1, 50);
  range("terrainCliffMarkerSpacingM", 1, 50);
  range("aerialTerrainGridM", 1, 20);
  range("aerialTerrainMinConfidence", 0, 1);
  range("treeDensityPer100m2", 0, 50);
  range("shrubDensityPer100m2", 0, 100);
  range("treeLineSpacingM", 1, 30);
  range("vegetationMinSpacingM", 1, 30);
  if (options.maxPathDiscoveryCells !== undefined &&
    (!Number.isInteger(options.maxPathDiscoveryCells) || options.maxPathDiscoveryCells < 1_000)) {
    throw new UserError("--max-path-discovery-cells must be an integer of at least 1000");
  }
  if (options.maxTerrainRocks !== undefined &&
    (!Number.isInteger(options.maxTerrainRocks) || options.maxTerrainRocks < 0 || options.maxTerrainRocks > 100_000)) {
    throw new UserError("--max-terrain-rocks must be an integer between 0 and 100000");
  }
  if (options.maxVegetationModels !== undefined &&
    (!Number.isInteger(options.maxVegetationModels) || options.maxVegetationModels < 0 || options.maxVegetationModels > 200_000)) {
    throw new UserError("--max-vegetation-models must be an integer between 0 and 200000");
  }
  if (options.pathDiscoveryRampGradePercent !== undefined &&
    options.pathDiscoverySteepGradePercent !== undefined &&
    options.pathDiscoverySteepGradePercent < options.pathDiscoveryRampGradePercent) {
    throw new UserError("--path-discovery-steep-grade-percent cannot be below the ramp-grade threshold");
  }
}

const toCamel = (value) => value.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const toKebab = (value) => value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
