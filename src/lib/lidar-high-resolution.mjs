import path from "node:path";
import proj4 from "proj4";
import { acquireLidarElevation } from "./lidar.mjs";
import { cachedBinary, cachedJson, fetchBinary, fetchJson, sha256 } from "./io.mjs";

const DEFAULT_MAX_RESOLUTION_M = 0.5;
const DEFAULT_MAX_DOWNLOAD_MB = 256;
const EA_INDEX_WFS = "https://environment.data.gov.uk/spatialdata/survey-index-files/wfs";
const SURVEY_TYPENAME = "dataset-9f0fa3fc-a860-4729-adc9-47fe53f658d0:National_LIDAR_Programme_Index_Catalogue";
const BNG = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs";

export async function acquirePreferredEaLidar(options) {
  const wantsDsm = !options.noDsm;
  let survey = null;
  let preferred = null;
  try {
    survey = await acquireHighResolutionSurveyIndex(options);
    preferred = await acquireHighResolutionSurveyPair({
      survey,
      cacheDir: path.join(options.cacheDir, "lidar"),
      userAgent: options.userAgent,
      noCache: options.noCache,
      wantsDsm,
      maxResolutionM: Number(options.eaLidarMaxResolutionM ?? DEFAULT_MAX_RESOLUTION_M),
      maxDownloadMb: Number(options.maxLidarArchiveMb ?? DEFAULT_MAX_DOWNLOAD_MB),
      assetBaseUrl: options.eaLidarArchiveBaseUrl || process.env.TPMAP_EA_LIDAR_ARCHIVE_BASE_URL || null
    });
  } catch (error) {
    preferred = unavailable("high-resolution-discovery-failed", null, { error: error?.message || String(error) });
  }

  if (preferred?.status === "high-resolution-pair-acquired") {
    try {
      const result = await acquireLidarElevation({
        ...options,
        dtm: preferred.dtm.filename,
        dsm: preferred.dsm?.filename || null
      }, "geotiff");
      const selected = preferred.selectedResolutionM;
      if (!(result.resolutionM <= selected * 1.25 + 0.01)) {
        throw new Error(`selected ${selected} m survey produced ${result.resolutionM} m raster`);
      }
      result.provider = "Environment Agency time-stamped high-resolution LIDAR DTM/DSM";
      result.sourceKind = "ea-lidar-high-resolution";
      result.verticalAccuracyRmseM = 0.15;
      result.datum = "Ordnance Datum Newlyn";
      result.survey = survey;
      result.attribution = "© Environment Agency copyright and/or database right; OSTN15 © Ordnance Survey";
      result.license = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/";
      result.resolutionSelection = {
        used: `EA time-stamped ${selected} m survey raster`,
        usedResolutionM: result.resolutionM,
        archivePolicy: "finest-resolution-then-latest-survey; paired DTM/DSM required",
        selectedSurveyId: preferred.candidate?.surveyId || null,
        selectedTile: preferred.candidate?.tile || null,
        selectedFlownFrom: preferred.candidate?.flownFrom || null,
        selectedFlownTo: preferred.candidate?.flownTo || null,
        fallbackUsed: false,
        highResolutionStatus: preferred.status
      };
      return result;
    } catch (error) {
      preferred = { ...preferred, status: "high-resolution-validation-failed", error: error?.message || String(error) };
    }
  }

  const fallback = await acquireLidarElevation(options, "ea-lidar");
  fallback.resolutionSelection = {
    ...(fallback.resolutionSelection || {}),
    fallbackUsed: true,
    fallbackReason: preferred?.status || "high-resolution-unavailable",
    highResolutionCandidate: preferred?.candidate || null,
    highResolutionError: preferred?.error || null
  };
  return fallback;
}

export async function acquireHighResolutionSurveyIndex(options) {
  const bounds = projectBboxApprox(options.bbox);
  const endpoint = options.eaIndexWfsUrl || EA_INDEX_WFS;
  const url = new URL(endpoint);
  url.searchParams.set("service", "WFS");
  url.searchParams.set("version", "2.0.0");
  url.searchParams.set("request", "GetFeature");
  url.searchParams.set("typeNames", SURVEY_TYPENAME);
  url.searchParams.set("bbox", `${bounds.minE},${bounds.minN},${bounds.maxE},${bounds.maxN},urn:ogc:def:crs:EPSG::27700`);
  url.searchParams.set("outputFormat", "application/json");
  const { data, cacheHit } = await cachedJson({
    cacheDir: path.join(options.cacheDir, "lidar", "high-resolution-survey-index"),
    key: url.toString(),
    noCache: options.noCache,
    fetcher: () => fetchJson(url, { headers: { "User-Agent": options.userAgent, Accept: "application/json" } }, { retries: 2 })
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
  return {
    provider: "Environment Agency National LIDAR Programme index",
    cacheHit,
    tileCount: tiles.length,
    finestResolutionM: minimumResolution(tiles),
    tiles
  };
}

export function selectHighResolutionSurveyCandidate(tiles, {
  wantsDsm = true,
  maxResolutionM = DEFAULT_MAX_RESOLUTION_M
} = {}) {
  return (tiles || [])
    .filter((tile) => tile && Number.isFinite(Number(tile.resolutionM)) && Number(tile.resolutionM) > 0)
    .filter((tile) => Number(tile.resolutionM) <= maxResolutionM)
    .filter((tile) => Boolean(tile.dtm) && (!wantsDsm || Boolean(tile.dsm)))
    .sort((a, b) => Number(a.resolutionM) - Number(b.resolutionM) ||
      surveyTimestamp(b) - surveyTimestamp(a) ||
      String(a.tile || a.surveyId || "").localeCompare(String(b.tile || b.surveyId || "")))[0] || null;
}

export function resolveSurveyAssetUrl(value, baseUrl = null) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : null;
  } catch {
    if (!baseUrl) return null;
    try {
      const parsed = new URL(raw.replace(/^\/+/, ""), ensureTrailingSlash(baseUrl));
      return /^https?:$/.test(parsed.protocol) ? parsed.toString() : null;
    } catch { return null; }
  }
}

export async function acquireHighResolutionSurveyPair({
  survey,
  cacheDir,
  userAgent,
  noCache = false,
  wantsDsm = true,
  maxResolutionM = DEFAULT_MAX_RESOLUTION_M,
  maxDownloadMb = DEFAULT_MAX_DOWNLOAD_MB,
  assetBaseUrl = null,
  assetLoader = null
}) {
  const candidate = selectHighResolutionSurveyCandidate(survey?.tiles, { wantsDsm, maxResolutionM });
  if (!candidate) return unavailable("no-sub-metre-paired-survey", null);

  const dtmUrl = resolveSurveyAssetUrl(candidate.dtm, assetBaseUrl);
  const dsmUrl = wantsDsm ? resolveSurveyAssetUrl(candidate.dsm, assetBaseUrl) : null;
  if (!dtmUrl || (wantsDsm && !dsmUrl)) {
    return unavailable("survey-assets-not-addressable", candidate, {
      dtmReference: candidate.dtm || null,
      dsmReference: candidate.dsm || null
    });
  }
  if (![dtmUrl, dsmUrl].filter(Boolean).every(isDirectGeoTiff)) {
    return unavailable("survey-assets-require-bounded-archive-extraction", candidate, { dtmUrl, dsmUrl });
  }

  try {
    const load = assetLoader || acquireBoundedRaster;
    const dtm = await load({ url: dtmUrl, role: "dtm", cacheDir, userAgent, noCache, maxDownloadMb, candidate });
    const dsm = wantsDsm ? await load({ url: dsmUrl, role: "dsm", cacheDir, userAgent, noCache, maxDownloadMb, candidate }) : null;
    return {
      status: "high-resolution-pair-acquired",
      candidate,
      dtm,
      dsm,
      selectedResolutionM: Number(candidate.resolutionM),
      source: "Environment Agency time-stamped LiDAR survey archive"
    };
  } catch (error) {
    return unavailable("high-resolution-acquisition-failed", candidate, {
      error: error?.message || String(error), dtmUrl, dsmUrl
    });
  }
}

async function acquireBoundedRaster({ url, role, cacheDir, userAgent, noCache, maxDownloadMb, candidate }) {
  const maxBytes = Math.max(1, Number(maxDownloadMb || DEFAULT_MAX_DOWNLOAD_MB)) * 1024 * 1024;
  const cached = await cachedBinary({
    cacheDir: path.join(cacheDir, "high-resolution", role),
    key: url,
    noCache,
    extension: extensionFor(url),
    fetcher: async () => {
      const bytes = await fetchBinary(url, {
        headers: { "User-Agent": userAgent || "VoxelMappingTool/0.2.0", Accept: "image/tiff,*/*;q=0.5" }
      }, { timeoutMs: 240_000, retries: 2 });
      if (bytes.length > maxBytes) throw new Error(`${role.toUpperCase()} high-resolution LiDAR asset exceeds ${maxDownloadMb} MB bound`);
      return bytes;
    }
  });
  return {
    filename: cached.filename,
    cacheHit: cached.cacheHit,
    endpoint: url,
    queryHash: sha256(url),
    role,
    surveyId: candidate.surveyId || null,
    tile: candidate.tile || null,
    flownFrom: candidate.flownFrom || null,
    flownTo: candidate.flownTo || null,
    declaredResolutionM: Number(candidate.resolutionM)
  };
}

function projectBboxApprox(bbox) {
  const corners = [[bbox.west, bbox.south], [bbox.west, bbox.north], [bbox.east, bbox.south], [bbox.east, bbox.north]]
    .map((point) => proj4("EPSG:4326", BNG, point));
  const eastings = corners.map((p) => p[0]), northings = corners.map((p) => p[1]);
  return {
    minE: Math.floor(Math.min(...eastings)) - 5,
    minN: Math.floor(Math.min(...northings)) - 5,
    maxE: Math.ceil(Math.max(...eastings)) + 5,
    maxN: Math.ceil(Math.max(...northings)) + 5
  };
}
function unavailable(status, candidate, extra = {}) {
  return { status, candidate, dtm: null, dsm: null, selectedResolutionM: null, ...extra };
}
function isDirectGeoTiff(value) {
  try { return /\.tiff?$/i.test(new URL(value).pathname); }
  catch { return false; }
}
function extensionFor(value) {
  try {
    const ext = path.extname(new URL(value).pathname).toLowerCase();
    return [".tif", ".tiff"].includes(ext) ? ext : ".tif";
  } catch { return ".tif"; }
}
function surveyTimestamp(tile) {
  return Math.max(Date.parse(tile?.flownTo || 0) || 0, Date.parse(tile?.flownFrom || 0) || 0);
}
function minimumResolution(tiles) {
  const values = (tiles || []).map((tile) => Number(tile.resolutionM)).filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.min(...values) : null;
}
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function ensureTrailingSlash(value) { return String(value).endsWith("/") ? String(value) : `${value}/`; }
