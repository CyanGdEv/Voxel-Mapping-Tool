import path from "node:path";
import proj4 from "proj4";
import { fromFile, fromUrl } from "geotiff";
import { ensureDir, readJson, sha256, writeJson } from "./io.mjs";

const BNG = "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs";

/** Loads only the requested park window from the Forestry Commission classification raster. */
export async function loadTreeSpeciesRaster(options, runtime) {
  const source = options.treeSpeciesMap || options.treeSpeciesMapUrl || process.env.TPMAP_TREE_SPECIES_MAP_URL;
  if (!source) return {
    sampler: null,
    evidence: {
      provider: "Forestry Commission",
      dataset: "Tree Species Map England",
      configured: false,
      reason: "TPMAP_TREE_SPECIES_MAP_URL or --tree-species-map is not configured"
    },
    warnings: ["Tree Species Map is enabled but no bounded/COG raster URL or local raster is configured."]
  };
  const remote = /^https?:\/\//i.test(source);
  const tiff = remote ? await fromUrl(source) : await fromFile(path.resolve(source));
  try {
    const image = await tiff.getImage();
    const geoKeys = image.getGeoKeys();
    const epsg = Number(geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey);
    if (epsg !== 27700) throw new Error(`Tree Species Map must use EPSG:27700; received ${epsg || "unknown CRS"}`);
    const [originX, originY] = image.getOrigin();
    const [resolutionX, resolutionY] = image.getResolution();
    const width = image.getWidth(), height = image.getHeight();
    const corners = [
      [runtime.bbox.west, runtime.bbox.south], [runtime.bbox.east, runtime.bbox.south],
      [runtime.bbox.west, runtime.bbox.north], [runtime.bbox.east, runtime.bbox.north]
    ].map((point) => proj4("EPSG:4326", BNG, point));
    const pixels = corners.map(([x, y]) => [(x - originX) / resolutionX, (y - originY) / resolutionY]);
    const left = clamp(Math.floor(Math.min(...pixels.map((point) => point[0]))), 0, width);
    const right = clamp(Math.ceil(Math.max(...pixels.map((point) => point[0]))) + 1, 0, width);
    const top = clamp(Math.floor(Math.min(...pixels.map((point) => point[1]))), 0, height);
    const bottom = clamp(Math.ceil(Math.max(...pixels.map((point) => point[1]))) + 1, 0, height);
    if (right <= left || bottom <= top) throw new Error("Tree Species Map does not intersect the selected park");
    const samplesPerPixel = Number(image.getFileDirectory().SamplesPerPixel || 1);
    const sampleIndexes = samplesPerPixel > 1 ? [0, 1] : [0];
    const cachedWindow = await readCachedWindow({
      image, source, runtime, window: [left, top, right, bottom], samples: sampleIndexes
    });
    const classes = cachedWindow.classes, confidenceValues = cachedWindow.confidenceValues;
    const windowWidth = right - left, windowHeight = bottom - top;
    const legend = await loadLegend(options);
    const minimumConfidence = Number(options.treeSpeciesMinConfidence ?? 0.65);
    const sampler = (lon, lat) => {
      const [x, y] = proj4("EPSG:4326", BNG, [lon, lat]);
      const column = Math.floor((x - originX) / resolutionX) - left;
      const row = Math.floor((y - originY) / resolutionY) - top;
      if (column < 0 || row < 0 || column >= windowWidth || row >= windowHeight) return null;
      const index = row * windowWidth + column;
      const classCode = Number(classes[index]);
      if (!Number.isFinite(classCode) || classCode === 0) return null;
      const rawConfidence = confidenceValues ? Number(confidenceValues[index]) : null;
      const confidence = Number.isFinite(rawConfidence)
        ? rawConfidence > 1 ? rawConfidence / 100 : rawConfidence
        : 0.89;
      if (confidence < minimumConfidence) return null;
      const entry = legend.get(String(classCode)) || null;
      const species = typeof entry === "string" ? entry : entry?.species || entry?.name || null;
      return {
        classCode,
        species,
        leafType: entry?.leafType || inferLeafType(species),
        confidence: round(confidence),
        confidenceBasis: confidenceValues ? "classification-confidence-raster" : "dataset-overall-accuracy"
      };
    };
    return {
      sampler,
      evidence: {
        provider: "Forestry Commission",
        dataset: "Tree Species Map England",
        source: remote ? source : path.resolve(source),
        license: "Open Government Licence v3.0",
        attribution: "© Forestry Commission copyright and/or database right 2024",
        resolutionM: Math.max(Math.abs(resolutionX), Math.abs(resolutionY)),
        crs: "EPSG:27700",
        classificationBand: 1,
        confidenceBand: confidenceValues ? 2 : null,
        cacheHit: cachedWindow.cacheHit,
        legendClasses: legend.size,
        window: { left, top, right, bottom, width: windowWidth, height: windowHeight }
      },
      warnings: legend.size ? [] : ["Tree species class codes are available, but names need --tree-species-legend JSON before species-specific blocks can be selected."]
    };
  } finally {
    if (!remote && typeof tiff.close === "function") await tiff.close();
  }
}

async function readCachedWindow({ image, source, runtime, window, samples }) {
  const directory = path.join(runtime.cacheDir || ".tpmap-cache", "supplemental", "tree-species-windows");
  await ensureDir(directory);
  const filename = path.join(directory, `${sha256({ source, window, samples, schema: 1 })}.json`);
  if (!runtime.noCache) {
    try {
      const value = await readJson(filename);
      if (Array.isArray(value.classes)) return {
        classes: value.classes,
        confidenceValues: Array.isArray(value.confidenceValues) ? value.confidenceValues : null,
        cacheHit: true
      };
    } catch { /* acquire the bounded window */ }
  }
  const rasters = await image.readRasters({ window, samples });
  const value = {
    classes: Array.from(rasters[0] || []),
    confidenceValues: rasters[1] ? Array.from(rasters[1]) : null
  };
  await writeJson(filename, value, 0);
  return { ...value, cacheHit: false };
}

async function loadLegend(options) {
  let value = null;
  if (options.treeSpeciesLegend) value = await readJson(path.resolve(options.treeSpeciesLegend));
  else if (process.env.TPMAP_TREE_SPECIES_LEGEND_JSON) value = JSON.parse(process.env.TPMAP_TREE_SPECIES_LEGEND_JSON);
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(entry?.code ?? index), entry])
    : Object.entries(value || {});
  return new Map(entries.map(([code, entry]) => [String(code), typeof entry === "string" ? entry : { ...entry }]));
}

function inferLeafType(species) {
  const value = String(species || "").toLowerCase();
  if (/spruce|pine|fir|larch|cedar|cypress|hemlock|douglas|conifer/.test(value)) return "needleleaved";
  return value ? "broadleaved" : null;
}
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function round(value) { return Math.round(value * 1_000) / 1_000; }
