import path from "node:path";
import { fromFile } from "geotiff";
import proj4 from "proj4";
import { bboxCenter, createProjector } from "./geo.mjs";
import { UserError, invariant } from "./errors.mjs";
import {
  cachedBinary, cachedJson, ensureDir, fetchBinary, fetchJson, sha256, sha256File
} from "./io.mjs";

const EA_DTM_DATASET = "13787b9a-26a4-4775-8523-806d13af58fc";
const EA_DSM_DATASET = "9ba4d5ac-d596-445a-9056-dae3ddec0178";
const EA_DTM_WCS = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs";
const EA_DSM_WCS = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-surface-model-last-return-dsm-1m/wcs";
const EA_INDEX_WFS = "https://environment.data.gov.uk/spatialdata/survey-index-files/wfs";
const OSTN15_URL = "https://cdn.proj.org/uk_os_OSTN15_NTv2_OSGBtoETRS.tif";
const OSTN15_NAME = "OSTN15_NTv2_OSGBtoETRS";
const BNG_DEFINITION = `+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +nadgrids=${OSTN15_NAME} +units=m +no_defs +type=crs`;
const SURVEY_TYPENAME = "dataset-9f0fa3fc-a860-4729-adc9-47fe53f658d0:National_LIDAR_Programme_Index_Catalogue";

let registeredGridPath = null;
let registeredGridPromise = null;

export async function acquireLidarElevation(options, provider) {
  invariant(options.bbox, "LiDAR elevation requires a WGS84 bounding box");
  const cacheDir = path.join(options.cacheDir, "lidar");
  await ensureDir(cacheDir);
  const transform = await createOstn15Transform({ ...options, cacheDir });
  const projectedBounds = projectBbox(options.bbox, transform.forward);

  const isLive = provider === "ea-lidar";
  if (!isLive && provider !== "geotiff") throw new UserError(`Unsupported LiDAR provider: ${provider}`);
  if (!isLive && !options.dtm) throw new UserError("--elevation geotiff requires --dtm FILE");

  const dtmSource = isLive
    ? await acquireCoverage({
      endpoint: options.eaDtmWcsUrl || EA_DTM_WCS,
      coverageId: `${EA_DTM_DATASET}__Lidar_Composite_Elevation_DTM_1m`,
      bounds: projectedBounds,
      cacheDir,
      userAgent: options.userAgent,
      noCache: options.noCache,
      role: "dtm"
    })
    : { filename: path.resolve(options.dtm), cacheHit: true, endpoint: null, queryHash: null };

  const wantsDsm = !options.noDsm && (isLive || options.dsm);
  const dsmSource = !wantsDsm ? null : isLive
    ? await acquireCoverage({
      endpoint: options.eaDsmWcsUrl || EA_DSM_WCS,
      coverageId: `${EA_DSM_DATASET}__Lidar_Composite_Elevation_LZ_DSM_1m`,
      bounds: projectedBounds,
      cacheDir,
      userAgent: options.userAgent,
      noCache: options.noCache,
      role: "dsm"
    })
    : { filename: path.resolve(options.dsm), cacheHit: true, endpoint: null, queryHash: null };

  const dtm = await readGeoTiffRaster(dtmSource.filename, "DTM");
  const dsm = dsmSource ? await readGeoTiffRaster(dsmSource.filename, "DSM") : null;
  if (dsm) validateAlignedRasters(dtm, dsm);
  const [dtmHash, dsmHash] = await Promise.all([
    sha256File(dtmSource.filename),
    dsmSource ? sha256File(dsmSource.filename) : null
  ]);

  const survey = isLive
    ? await acquireSurveyMetadata({
      endpoint: options.eaIndexWfsUrl || EA_INDEX_WFS,
      bounds: projectedBounds,
      cacheDir,
      userAgent: options.userAgent,
      noCache: options.noCache
    })
    : null;

  const localProjector = createProjector(bboxCenter(options.bbox));
  const terrainSampler = createProjectedRasterSampler(dtm);
  const surfaceSampler = dsm ? createProjectedRasterSampler(dsm) : null;
  const projectLocal = (xOrPoint, zValue) => {
    const [x, z] = Array.isArray(xOrPoint) ? xOrPoint : [xOrPoint, zValue];
    return transform.forward(localProjector.inverse([x, z]));
  };
  const result = {
    provider: isLive
      ? "Environment Agency National LIDAR Programme DTM/DSM"
      : "Local GeoTIFF DTM/DSM",
    sourceKind: isLive ? "ea-lidar" : "geotiff",
    resolutionM: Math.max(dtm.resolutionM, dsm?.resolutionM || 0),
    verticalAccuracyRmseM: isLive ? 0.15 : null,
    datum: isLive ? "Ordnance Datum Newlyn" : "source GeoTIFF datum",
    crs: "EPSG:27700",
    minM: dtm.min,
    maxM: dtm.max,
    projectedBounds,
    dtm: publicRasterMetadata(dtm, dtmSource, dtmHash),
    dsm: dsm ? publicRasterMetadata(dsm, dsmSource, dsmHash) : null,
    survey,
    resolutionSelection: {
      used: isLive ? "EA 1 m composite WCS" : "supplied GeoTIFF",
      usedResolutionM: Math.max(dtm.resolutionM, dsm?.resolutionM || 0),
      archivePolicy: "finest-resolution-then-latest-survey",
      finestArchiveResolutionM: survey?.finestResolutionM ?? null,
      higherResolutionArchiveAvailable: Number.isFinite(survey?.finestResolutionM) && survey.finestResolutionM < 1,
      bestArchiveCandidates: survey?.bestAvailableTiles || []
    },
    transformation: {
      name: "OSTN15",
      grid: path.basename(transform.gridPath),
      gridHash: await sha256File(transform.gridPath),
      gridSource: transform.gridSource,
      license: "BSD-2-Clause"
    },
    attribution: isLive
      ? "© Environment Agency copyright and/or database right; OSTN15 © Ordnance Survey"
      : "User-supplied GeoTIFF elevation; OSTN15 © Ordnance Survey",
    license: isLive
      ? "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"
      : null,
    dataset: isLive
      ? "https://environment.data.gov.uk/dataset/2e8d0733-4f43-48b4-9e51-631c25d1b0a9"
      : null,
    warning: dsm ? null : "No DSM was selected; measured structure heights and roof surfaces are unavailable."
  };

  Object.defineProperties(result, {
    projectLocal: {
      enumerable: false,
      value: projectLocal
    },
    sampleLocal: {
      enumerable: false,
      value(x, z) {
        const [easting, northing] = projectLocal(x, z);
        return terrainSampler(easting, northing);
      }
    },
    sampleSurfaceLocal: {
      enumerable: false,
      value: surfaceSampler ? (x, z) => {
        const [easting, northing] = projectLocal(x, z);
        return surfaceSampler(easting, northing);
      } : null
    },
    samplePairLocal: {
      enumerable: false,
      value: surfaceSampler ? (x, z) => {
        const [easting, northing] = projectLocal(x, z);
        return { terrain: terrainSampler(easting, northing), surface: surfaceSampler(easting, northing) };
      } : null
    }
  });
  return result;
}

export async function readGeoTiffRaster(filename, role = "raster") {
  let tiff;
  try {
    tiff = await fromFile(filename);
    const image = await tiff.getImage();
    const geoKeys = image.getGeoKeys();
    const epsg = Number(geoKeys.ProjectedCSTypeGeoKey);
    invariant(epsg === 27700, `${role} GeoTIFF must use EPSG:27700; found ${Number.isFinite(epsg) ? `EPSG:${epsg}` : "no projected CRS"}`);
    const width = image.getWidth(), height = image.getHeight();
    invariant(width > 1 && height > 1, `${role} GeoTIFF is too small`);
    const boundingBox = image.getBoundingBox().map(Number);
    const resolution = image.getResolution().map(Math.abs);
    invariant(resolution[0] > 0 && resolution[1] > 0, `${role} GeoTIFF has invalid pixel resolution`);
    const values = await image.readRasters({ samples: [0], interleave: true });
    invariant(values.length === width * height, `${role} GeoTIFF must contain one readable elevation band`);
    const noData = image.getGDALNoData();
    let min = Infinity, max = -Infinity, validCells = 0;
    for (const value of values) {
      if (!validElevation(value, noData)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      validCells += 1;
    }
    invariant(validCells > 0, `${role} GeoTIFF contains no valid elevation cells`);
    return {
      filename: path.resolve(filename), width, height, boundingBox, resolution,
      resolutionM: Math.max(resolution[0], resolution[1]), noData, values,
      min, max, validCells, totalCells: width * height, epsg
    };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Could not read ${role} GeoTIFF: ${path.basename(filename)}`, error?.message || String(error));
  } finally {
    await tiff?.close?.();
  }
}

export function createProjectedRasterSampler(raster) {
  const [minX, minY, maxX, maxY] = raster.boundingBox;
  const pixelWidth = (maxX - minX) / raster.width;
  const pixelHeight = (maxY - minY) / raster.height;
  return (x, y) => {
    const fx = (x - minX) / pixelWidth - 0.5;
    const fy = (maxY - y) / pixelHeight - 0.5;
    if (fx < -0.5 || fy < -0.5 || fx > raster.width - 0.5 || fy > raster.height - 0.5) return null;
    const x0 = clamp(Math.floor(fx), 0, raster.width - 1);
    const y0 = clamp(Math.floor(fy), 0, raster.height - 1);
    const x1 = Math.min(raster.width - 1, x0 + 1);
    const y1 = Math.min(raster.height - 1, y0 + 1);
    const tx = clamp(fx - Math.floor(fx), 0, 1);
    const ty = clamp(fy - Math.floor(fy), 0, 1);
    const samples = [
      [raster.values[y0 * raster.width + x0], (1 - tx) * (1 - ty)],
      [raster.values[y0 * raster.width + x1], tx * (1 - ty)],
      [raster.values[y1 * raster.width + x0], (1 - tx) * ty],
      [raster.values[y1 * raster.width + x1], tx * ty]
    ].filter(([value, weight]) => weight > 0 && validElevation(value, raster.noData));
    if (!samples.length) return null;
    const weight = samples.reduce((sum, sample) => sum + sample[1], 0);
    return samples.reduce((sum, sample) => sum + sample[0] * sample[1], 0) / weight;
  };
}

async function createOstn15Transform(options) {
  let gridPath, gridSource;
  if (options.ostn15Grid) {
    gridPath = path.resolve(options.ostn15Grid);
    gridSource = "user-supplied";
  } else {
    const cached = await cachedBinary({
      cacheDir: path.join(options.cacheDir, "ostn15"), key: OSTN15_URL,
      noCache: options.noCache,
      extension: ".tif",
      fetcher: () => fetchBinary(OSTN15_URL, { headers: { "User-Agent": options.userAgent } })
    });
    gridPath = cached.filename;
    gridSource = OSTN15_URL;
  }
  if (registeredGridPath !== gridPath) {
    registeredGridPath = gridPath;
    registeredGridPromise = (async () => {
      const tiff = await fromFile(gridPath);
      const registration = proj4.nadgrid(OSTN15_NAME, tiff);
      if (registration?.ready) await registration.ready;
      proj4.defs("EPSG:27700", BNG_DEFINITION);
    })();
  }
  await registeredGridPromise;
  return {
    gridPath, gridSource,
    forward: ([lon, lat]) => proj4("EPSG:4326", "EPSG:27700", [lon, lat]),
    inverse: ([easting, northing]) => proj4("EPSG:27700", "EPSG:4326", [easting, northing])
  };
}

function projectBbox(bbox, forward) {
  const points = [
    [bbox.west, bbox.south], [bbox.west, bbox.north],
    [bbox.east, bbox.south], [bbox.east, bbox.north]
  ].map(forward);
  const eastings = points.map((point) => point[0]);
  const northings = points.map((point) => point[1]);
  const padding = 2;
  return {
    minE: Math.floor(Math.min(...eastings)) - padding,
    minN: Math.floor(Math.min(...northings)) - padding,
    maxE: Math.ceil(Math.max(...eastings)) + padding,
    maxN: Math.ceil(Math.max(...northings)) + padding
  };
}

async function acquireCoverage({ endpoint, coverageId, bounds, cacheDir, userAgent, noCache, role }) {
  const url = new URL(endpoint);
  url.searchParams.set("service", "WCS");
  url.searchParams.set("version", "2.0.1");
  url.searchParams.set("request", "GetCoverage");
  url.searchParams.set("coverageId", coverageId);
  url.searchParams.set("format", "image/tiff");
  url.searchParams.append("subset", `E(${bounds.minE},${bounds.maxE})`);
  url.searchParams.append("subset", `N(${bounds.minN},${bounds.maxN})`);
  const cached = await cachedBinary({
    cacheDir: path.join(cacheDir, "coverage"), key: url.toString(), noCache,
    extension: ".tif",
    fetcher: () => fetchBinary(url, { headers: { "User-Agent": userAgent, Accept: "image/tiff" } }, { timeoutMs: 240_000, retries: 2 })
  });
  return { filename: cached.filename, cacheHit: cached.cacheHit, endpoint, queryHash: sha256(url.toString()), role };
}

async function acquireSurveyMetadata({ endpoint, bounds, cacheDir, userAgent, noCache }) {
  const url = new URL(endpoint);
  url.searchParams.set("service", "WFS");
  url.searchParams.set("version", "2.0.0");
  url.searchParams.set("request", "GetFeature");
  url.searchParams.set("typeNames", SURVEY_TYPENAME);
  url.searchParams.set("bbox", `${bounds.minE},${bounds.minN},${bounds.maxE},${bounds.maxN},urn:ogc:def:crs:EPSG::27700`);
  url.searchParams.set("outputFormat", "application/json");
  const { data, cacheHit } = await cachedJson({
    cacheDir: path.join(cacheDir, "survey-index"), key: url.toString(), noCache,
    fetcher: () => fetchJson(url, { headers: { "User-Agent": userAgent, Accept: "application/json" } })
  });
  const tiles = (data.features || []).map((feature) => feature.properties || {}).map((properties) => ({
    tile: properties.tilename || null,
    surveyId: properties.polygon_id || null,
    flownFrom: properties.sd_flown || null,
    flownTo: properties.ed_flown || null,
    resolutionM: numberOrNull(properties.resolution),
    pointCloud: properties.pnt_fn || null,
    dtm: properties.dtm_fn || null,
    dsm: properties.dsm_fn || null,
    survey: properties.surveys || null
  }));
  const dates = tiles.flatMap((tile) => [Date.parse(tile.flownFrom), Date.parse(tile.flownTo)]).filter(Number.isFinite);
  const ranked = selectBestSurveyTiles(tiles);
  const resolutions = tiles.map((tile) => tile.resolutionM).filter((value) => Number.isFinite(value) && value > 0);
  return {
    provider: "Environment Agency National LIDAR Programme index",
    cacheHit,
    tileCount: tiles.length,
    newestSurveyDate: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    oldestSurveyDate: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
    finestResolutionM: resolutions.length ? Math.min(...resolutions) : null,
    bestAvailableTiles: ranked.slice(0, 12),
    tiles
  };
}

export function selectBestSurveyTiles(tiles) {
  return (tiles || []).filter((tile) => tile && Number.isFinite(tile.resolutionM) && tile.resolutionM > 0)
    .sort((a, b) => a.resolutionM - b.resolutionM ||
      surveyTimestamp(b) - surveyTimestamp(a) ||
      String(a.tile || a.surveyId || "").localeCompare(String(b.tile || b.surveyId || "")));
}

function surveyTimestamp(tile) {
  return Math.max(Date.parse(tile.flownTo || 0) || 0, Date.parse(tile.flownFrom || 0) || 0);
}

function publicRasterMetadata(raster, source, fileHash) {
  return {
    file: path.basename(raster.filename), width: raster.width, height: raster.height,
    sha256: fileHash,
    bounds: raster.boundingBox, resolutionM: raster.resolutionM,
    validCells: raster.validCells, totalCells: raster.totalCells,
    coverage: Math.round((raster.validCells / raster.totalCells) * 100_000) / 1000,
    minM: raster.min, maxM: raster.max, cacheHit: source.cacheHit,
    endpoint: source.endpoint, queryHash: source.queryHash
  };
}

function validateAlignedRasters(dtm, dsm) {
  const same = dtm.width === dsm.width && dtm.height === dsm.height &&
    dtm.boundingBox.every((value, index) => Math.abs(value - dsm.boundingBox[index]) < 0.001) &&
    Math.abs(dtm.resolutionM - dsm.resolutionM) < 0.001;
  invariant(same, "DTM and DSM GeoTIFFs must have matching bounds, dimensions, and resolution");
}

function validElevation(value, noData) {
  return Number.isFinite(value) && value > -1e20 && (noData === null || noData === undefined || value !== noData);
}

const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
