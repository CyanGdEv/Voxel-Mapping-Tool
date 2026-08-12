import path from "node:path";
import { cachedBinary, fetchBinary, sha256 } from "./io.mjs";

const DEFAULT_MAX_RESOLUTION_M = 0.5;
const DEFAULT_MAX_DOWNLOAD_MB = 256;

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

/**
 * Acquires a coherent sub-metre DTM/DSM pair only when the survey index exposes
 * usable HTTP(S) raster assets. The caller validates the GeoTIFFs before use.
 * ZIP/unknown assets stay evidence-only here; a 1 m WCS fallback remains safe.
 */
export async function acquireHighResolutionSurveyPair({
  survey,
  cacheDir,
  userAgent,
  noCache = false,
  wantsDsm = true,
  maxResolutionM = DEFAULT_MAX_RESOLUTION_M,
  maxDownloadMb = DEFAULT_MAX_DOWNLOAD_MB,
  assetBaseUrl = process.env.TPMAP_EA_LIDAR_ARCHIVE_BASE_URL || null,
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
    return unavailable("survey-assets-require-archive-extraction", candidate, { dtmUrl, dsmUrl });
  }

  try {
    const load = assetLoader || ((args) => acquireBoundedRaster(args));
    const dtm = await load({
      url: dtmUrl, role: "dtm", cacheDir, userAgent, noCache, maxDownloadMb, candidate
    });
    const dsm = wantsDsm ? await load({
      url: dsmUrl, role: "dsm", cacheDir, userAgent, noCache, maxDownloadMb, candidate
    }) : null;
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
      if (bytes.length > maxBytes) throw new Error(
        `${role.toUpperCase()} high-resolution LiDAR asset exceeds ${maxDownloadMb} MB bound`
      );
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

function unavailable(status, candidate, extra = {}) {
  return { status, candidate, dtm: null, dsm: null, selectedResolutionM: null, ...extra };
}
function isDirectGeoTiff(value) {
  try { return /\.tiff?(?:$|[?#])/i.test(new URL(value).pathname); }
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
function ensureTrailingSlash(value) { return String(value).endsWith("/") ? String(value) : `${value}/`; }
