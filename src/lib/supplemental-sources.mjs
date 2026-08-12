import path from "node:path";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { bboxCenter } from "./geo.mjs";
import { UserError, invariant } from "./errors.mjs";
import { cachedBinary, cachedJson, ensureDir, fetchBinary, fetchJson, readJson, sha256 } from "./io.mjs";
import { loadTreeSpeciesRaster } from "./tree-species-raster.mjs";

const OGL_3 = "Open Government Licence v3.0";
const PLANNING_DATA_URL = "https://www.planning.data.gov.uk/entity.geojson";
const TOW_OGC_URL = "https://environment.data.gov.uk/spatialdata/national-trees-outside-woodland-map/ogc/features/v1";
const MICROSOFT_BUILDINGS_INDEX = "https://bfppub.blob.core.windows.net/$web/2026-07-24/dataset-links.csv";
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const OPEN_AERIAL_MAP_API = "https://api.openaerialmap.org/meta";
const OS_NGD_API = "https://api.os.uk/features/ngd/ofa/v1";

const DEFAULT_PLANNING_DATASETS = [
  "tree",
  "tree-preservation-zone",
  "ancient-woodland",
  "listed-building",
  "scheduled-monument",
  "conservation-area",
  "park-and-garden"
];

export async function acquireSupplementalSources(options, context) {
  const wantsTreeSpecies = Boolean(options.treeSpecies || options.treeSpeciesMap || options.treeSpeciesMapUrl);
  const requested = Boolean(
    options.englandOpenData || options.treesOutsideWoodland || options.planningData ||
    options.microsoftBuildings || options.wikidataPlaces || options.wikimediaCommons ||
    options.openAerialMap || options.osNgd || wantsTreeSpecies || options.osOpenMapLocal?.length || options.sourceConfig?.length
  );
  const result = {
    schemaVersion: 1,
    status: requested ? "requested" : "disabled",
    collections: [],
    evidence: {},
    providers: {},
    warnings: [],
    failures: []
  };
  if (!requested) return result;

  const runtime = {
    ...context,
    maxFeatures: Math.max(1, Number(options.maxSupplementalFeatures ?? 50_000)),
    pageSize: Math.max(1, Math.min(10_000, Number(options.supplementalPageSize ?? 5_000))),
    maxDownloadBytes: Math.max(1, Number(options.maxSupplementalDownloadMb ?? 250)) * 1024 * 1024,
    strict: options.strictSupplementalSources === true,
    noCache: options.noCache === true
  };
  await ensureDir(path.join(runtime.cacheDir, "supplemental"));

  const run = async (id, fn) => {
    try {
      const value = await fn();
      if (!value) return;
      for (const collection of value.collections || []) addCollection(result, collection);
      if (value.evidence) result.evidence[id] = value.evidence;
      for (const warning of value.warnings || []) result.warnings.push(`${id}: ${warning}`);
    } catch (error) {
      const failure = { id, message: error?.message || String(error), details: error?.details || null };
      result.failures.push(failure);
      if (runtime.strict) throw error;
      result.warnings.push(`${id} unavailable: ${failure.message}`);
    }
  };

  if (options.englandOpenData || options.planningData) {
    await run("planning-data", () => acquirePlanningData(runtime, options));
  }
  let treeSpeciesSampler = null;
  if (wantsTreeSpecies) {
    await run("tree-species-map", async () => {
      const acquired = await loadTreeSpeciesRaster(options, runtime);
      treeSpeciesSampler = acquired.sampler;
      return acquired;
    });
  }
  if (options.englandOpenData || options.treesOutsideWoodland) {
    await run("trees-outside-woodland", () => acquireTreesOutsideWoodland(runtime, options, treeSpeciesSampler));
  }
  if (options.microsoftBuildings) {
    await run("microsoft-buildings", () => acquireMicrosoftBuildings(runtime, options));
  }
  if (options.wikidataPlaces) {
    await run("wikidata-places", () => acquireWikidataPlaces(runtime, options));
  }
  if (options.wikimediaCommons) {
    await run("wikimedia-commons", () => acquireWikimediaCommons(runtime, options));
  }
  if (options.openAerialMap) {
    await run("open-aerial-map", () => discoverOpenAerialMap(runtime, options));
  }
  if (options.osNgd) {
    await run("os-ngd", () => acquireOsNgd(runtime, options));
  }
  for (const filename of options.osOpenMapLocal || []) {
    await run(`os-openmap-local:${path.basename(filename)}`, () => acquireOsOpenMapLocal(runtime, filename));
  }
  for (const filename of options.sourceConfig || []) {
    const resolved = path.resolve(filename);
    const parsed = await readJson(resolved);
    const configs = Array.isArray(parsed) ? parsed : parsed.sources || [parsed];
    for (const [index, config] of configs.entries()) {
      await run(config.id || `source-config:${path.basename(filename)}:${index}`, () =>
        acquireConfiguredSource(runtime, config, resolved, index));
    }
  }

  result.status = result.collections.length || Object.keys(result.evidence).length
    ? result.failures.length ? "partial" : "active"
    : result.failures.length ? "failed-open" : "active-no-results";
  result.featureCount = result.collections.reduce((sum, entry) => sum + entry.collection.features.length, 0);
  result.collectionCount = result.collections.length;
  return result;
}

function addCollection(result, entry) {
  result.collections.push(entry);
  const provider = entry.collection?.source?.name || entry.provider || entry.adapter;
  result.providers[provider] = (result.providers[provider] || 0) + entry.collection.features.length;
}

async function acquireTreesOutsideWoodland(runtime, options, treeSpeciesSampler = null) {
  const baseUrl = options.treesOutsideWoodlandUrl || TOW_OGC_URL;
  const collectionsUrl = new URL(`${stripSlash(baseUrl)}/collections`);
  collectionsUrl.searchParams.set("f", "json");
  const { data: listing, cacheHit: listingCacheHit } = await cachedJson({
    cacheDir: path.join(runtime.cacheDir, "supplemental", "tow-collections"),
    key: collectionsUrl.toString(),
    noCache: runtime.noCache,
    fetcher: () => fetchJson(collectionsUrl, requestHeaders(runtime), { retries: 2 })
  });
  const candidates = (listing.collections || []).filter((collection) =>
    collectionIntersectsBbox(collection, runtime.bbox));
  const selected = options.treesOutsideWoodlandCollection
    ? candidates.filter((collection) => collection.id === options.treesOutsideWoodlandCollection)
    : candidates;
  if (!selected.length) return {
    collections: [],
    warnings: ["No regional TOW collection intersects the requested WGS84 bounding box."]
  };

  const output = [];
  let totalFeatures = 0;
  for (const collection of selected) {
    if (totalFeatures >= runtime.maxFeatures) break;
    const itemsUrl = `${stripSlash(baseUrl)}/collections/${encodeURIComponent(collection.id)}/items`;
    const acquired = await fetchOgcFeaturePages({
      ...runtime,
      maxFeatures: runtime.maxFeatures - totalFeatures
    }, {
      url: itemsUrl,
      bbox: runtime.bbox,
      limit: runtime.pageSize
    });
    const features = acquired.features.map((feature, index) => {
      const subtype = inferTowSubtype(feature.properties);
      const sourceId = firstString(feature.properties, ["tow_id", "TOW_ID"]);
      const tileId = firstString(feature.properties, ["km1_tile", "KM1_TILE"]);
      const standardized = standardizeFeature(feature, {
        idPrefix: `tow:${collection.id}`,
        index,
        // TOW_ID is not globally unique: the live service can return multiple
        // canopy polygons with the same TOW_ID and KM1 tile. Keep the upstream
        // identity readable while adding a deterministic per-response ordinal.
        explicitId: sourceId ? towFeatureId(collection.id, sourceId, tileId, index) : null,
        provider: "Forestry Commission / Forest Research",
        sourceUrl: baseUrl,
        license: OGL_3,
        dataset: `National Trees Outside Woodland Map/${collection.id}`,
        adapter: "ogc-api-features",
        kind: "vegetation",
        subtype,
        checkedAt: new Date().toISOString(),
        mergePolicy: subtype === "nfi-overhanging-canopy" ? "gap-fill" : "independent-detail",
        heightM: firstNumber(feature.properties, [
          "meanht", "MEANHT", "mean_height", "MeanHeight", "MEAN_HEIGHT",
          "maxht", "MAXHT", "max_height", "MaxHeight", "MAX_HEIGHT",
          "height_m", "height", "Height", "HEIGHT"
        ]),
        accuracyM: firstNumber(feature.properties, ["accuracy_m", "Accuracy", "ACCURACY"]),
        extra: {
          ...(subtype === "lone-tree-canopy" ? { tree_count: 1 } : {}),
          canopy_area_m2: firstNumber(feature.properties, ["tow_area_m", "TOW_Area_M", "shape_area"]),
          lidar_survey_year: firstNumber(feature.properties, ["lidar_survey_year", "LiDAR_Survey_Year"])
        }
      });
      const point = representativePoint(feature.geometry);
      const species = point && treeSpeciesSampler ? treeSpeciesSampler(point[0], point[1]) : null;
      if (species) {
        standardized.properties.tree_species_class = species.classCode;
        standardized.properties.tree_species_confidence = species.confidence;
        standardized.properties.tree_species_confidence_basis = species.confidenceBasis;
        standardized.properties.tree_species_source = "Forestry Commission Tree Species Map England";
        if (species.species && !standardized.properties.species) standardized.properties.species = species.species;
        if (species.leafType && !standardized.properties.leaf_type) standardized.properties.leaf_type = species.leafType;
      }
      return standardized;
    });
    totalFeatures += features.length;
    output.push(collectionEntry({
      id: `trees-outside-woodland:${collection.id}`,
      adapter: "ogc-api-features",
      provider: "Forestry Commission / Forest Research",
      endpoint: itemsUrl,
      cacheHit: listingCacheHit && acquired.cacheHits === acquired.pages,
      collection: featureCollection(features, {
        name: "Forestry Commission / Forest Research",
        url: baseUrl,
        license: OGL_3,
        dataset: `National Trees Outside Woodland Map/${collection.id}`,
        checked_at: new Date().toISOString()
      }),
      request: acquired.request
    }));
  }
  return {
    collections: output,
    warnings: totalFeatures >= runtime.maxFeatures
      ? [`Result capped at ${runtime.maxFeatures} TOW canopy features.`]
      : []
  };
}

async function acquirePlanningData(runtime, options) {
  const datasets = splitCsv(options.planningDatasets) || DEFAULT_PLANNING_DATASETS;
  const endpoint = options.planningDataUrl || PLANNING_DATA_URL;
  const polygon = bboxWkt(runtime.bbox);
  const features = [];
  let offset = 0;
  let pages = 0;
  let cacheHits = 0;
  while (features.length < runtime.maxFeatures) {
    const url = new URL(endpoint);
    for (const dataset of datasets) url.searchParams.append("dataset", dataset);
    url.searchParams.set("geometry", polygon);
    url.searchParams.set("geometry_relation", "intersects");
    url.searchParams.set("limit", String(Math.min(runtime.pageSize, runtime.maxFeatures - features.length)));
    url.searchParams.set("offset", String(offset));
    const { data, cacheHit } = await cachedJson({
      cacheDir: path.join(runtime.cacheDir, "supplemental", "planning-data"),
      key: url.toString(),
      noCache: runtime.noCache,
      fetcher: () => fetchJson(url, requestHeaders(runtime), { retries: 2 })
    });
    pages += 1;
    if (cacheHit) cacheHits += 1;
    const pageFeatures = Array.isArray(data.features) ? data.features : [];
    features.push(...pageFeatures);
    if (!pageFeatures.length || pageFeatures.length < Number(url.searchParams.get("limit"))) break;
    const next = findNextLink(data.links);
    if (!next && pageFeatures.length < runtime.pageSize) break;
    offset += pageFeatures.length;
    if (pages >= 100) break;
  }

  const standardized = features.slice(0, runtime.maxFeatures)
    .map((feature, index) => standardizePlanningFeature(feature, index, endpoint))
    .filter(Boolean);
  return {
    collections: [collectionEntry({
      id: "planning-data",
      adapter: "planning-data-api",
      provider: "Planning Data",
      endpoint,
      cacheHit: cacheHits === pages,
      collection: featureCollection(standardized, {
        name: "Planning Data",
        url: "https://www.planning.data.gov.uk/",
        license: OGL_3,
        dataset: datasets.join(","),
        checked_at: new Date().toISOString()
      }),
      request: { bbox: runtime.bbox, datasets, pages, truncated: features.length >= runtime.maxFeatures }
    })],
    warnings: features.length >= runtime.maxFeatures
      ? [`Result capped at ${runtime.maxFeatures} features; tighten the bbox or raise --max-supplemental-features.`]
      : []
  };
}

function standardizePlanningFeature(feature, index, endpoint) {
  if (!feature?.geometry) return null;
  const properties = feature.properties || {};
  const dataset = String(properties.dataset || properties.typology || "planning-entity");
  const mapping = {
    tree: ["vegetation", "protected-or-recorded-tree"],
    "tree-preservation-zone": ["detail", "tree-preservation-zone"],
    "tree-preservation-order": ["detail", "tree-preservation-order"],
    "ancient-woodland": ["vegetation", "ancient-woodland"],
    "listed-building": ["building", "listed-building"],
    "scheduled-monument": ["structure", "scheduled-monument"],
    "conservation-area": ["detail", "conservation-area"],
    "park-and-garden": ["detail", "registered-park-and-garden"]
  };
  let [kind, subtype] = mapping[dataset] || ["detail", dataset];
  if (dataset === "listed-building" && !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) {
    kind = "detail";
  }
  return standardizeFeature(feature, {
    idPrefix: `planning:${dataset}`,
    index,
    explicitId: properties.entity ? `planning:${dataset}:${properties.entity}` : null,
    provider: "Planning Data",
    sourceUrl: endpoint,
    license: OGL_3,
    dataset,
    adapter: "planning-data-api",
    kind,
    subtype,
    checkedAt: new Date().toISOString(),
    mergePolicy: "independent-detail"
  });
}

async function acquireMicrosoftBuildings(runtime, options) {
  const indexUrl = options.microsoftBuildingsIndexUrl || MICROSOFT_BUILDINGS_INDEX;
  const index = await fetchCachedText(runtime, indexUrl, "microsoft-buildings-index");
  const rows = parseCsv(index.text);
  const quadkeys = bboxQuadKeys(runtime.bbox, 9);
  const selected = selectMicrosoftRows(rows, quadkeys);
  if (!selected.length) return {
    collections: [],
    warnings: ["No Microsoft building partition matched the requested level-9 quadkeys."]
  };

  const features = [];
  let downloadedBytes = 0;
  const partitions = [];
  for (const row of selected) {
    if (features.length >= runtime.maxFeatures) break;
    const size = parseByteSize(valueByHeader(row, ["size", "bytes", "filesize"]));
    if (size && downloadedBytes + size > runtime.maxDownloadBytes) {
      throw new UserError(
        `Microsoft building partitions exceed the ${Math.round(runtime.maxDownloadBytes / 1024 / 1024)} MB safety limit`,
        "Use a tighter bbox or deliberately raise --max-supplemental-download-mb."
      );
    }
    const url = valueByHeader(row, ["url", "downloadurl", "location"]);
    if (!url || !/^https?:/i.test(url)) continue;
    const { data, cacheHit, filename } = await cachedBinary({
      cacheDir: path.join(runtime.cacheDir, "supplemental", "microsoft-buildings"),
      key: url,
      noCache: runtime.noCache,
      extension: ".csv.gz",
      fetcher: () => fetchBinary(url, requestHeaders(runtime), { retries: 2 })
    });
    const bytes = data || await readFile(filename);
    downloadedBytes += bytes.length;
    if (downloadedBytes > runtime.maxDownloadBytes) {
      throw new UserError(`Microsoft building downloads exceeded --max-supplemental-download-mb`);
    }
    let accepted = 0;
    for await (const line of gunzipLines(bytes)) {
      if (!line.trim() || features.length >= runtime.maxFeatures) continue;
      let raw;
      try { raw = JSON.parse(line); } catch { continue; }
      if (!raw.geometry || !geometryIntersectsBbox(raw.geometry, runtime.bbox)) continue;
      const properties = raw.properties || {};
      const confidence = firstNumber(properties, ["confidence", "Confidence"]);
      const minimum = Number(options.microsoftBuildingsMinConfidence ?? 0.65);
      if (confidence !== null && confidence >= 0 && confidence < minimum) continue;
      const height = firstNumber(properties, ["height", "height_m", "Height"]);
      features.push(standardizeFeature(raw, {
        idPrefix: "microsoft-building",
        index: features.length,
        provider: "Microsoft Global ML Building Footprints",
        sourceUrl: "https://github.com/microsoft/GlobalMLBuildingFootprints",
        license: "CDLA Permissive 2.0",
        dataset: valueByHeader(row, ["quadkey"]) || "level-9 partition",
        adapter: "geojsonl-gzip-partitions",
        kind: "building",
        subtype: "ml-building-footprint",
        checkedAt: new Date().toISOString(),
        mergePolicy: "gap-fill",
        heightM: height !== null && height >= 0 ? height : null,
        accuracyM: null,
        extra: {
          confidence,
          imagery_vintage: properties.capture_dates_range || properties.capture_date || null
        }
      }));
      accepted += 1;
    }
    partitions.push({
      quadkey: valueByHeader(row, ["quadkey"]),
      url,
      bytes: bytes.length,
      cacheHit,
      accepted
    });
  }

  return {
    collections: [collectionEntry({
      id: "microsoft-buildings",
      adapter: "geojsonl-gzip-partitions",
      provider: "Microsoft Global ML Building Footprints",
      endpoint: indexUrl,
      cacheHit: index.cacheHit && partitions.every((partition) => partition.cacheHit),
      collection: featureCollection(features, {
        name: "Microsoft Global ML Building Footprints",
        url: "https://github.com/microsoft/GlobalMLBuildingFootprints",
        license: "CDLA Permissive 2.0",
        dataset: "level-9 bounded partitions",
        checked_at: new Date().toISOString()
      }),
      request: {
        bbox: runtime.bbox,
        quadkeys: [...quadkeys],
        partitions,
        downloadedBytes,
        truncated: features.length >= runtime.maxFeatures
      }
    })],
    warnings: features.length >= runtime.maxFeatures
      ? [`Result capped at ${runtime.maxFeatures} building footprints.`]
      : []
  };
}

async function acquireWikidataPlaces(runtime, options) {
  const endpoint = options.wikidataUrl || WIKIDATA_SPARQL;
  const center = bboxCenter(runtime.bbox);
  const radiusKm = Math.min(20, Math.max(0.5, bboxRadiusKm(runtime.bbox) + 0.5));
  const limit = Math.max(1, Math.min(2_000, Number(options.wikidataLimit ?? 500)));
  const query = `SELECT ?item ?itemLabel ?location ?instance ?instanceLabel WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${center.lon} ${center.lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm.toFixed(3)}" .
  }
  OPTIONAL { ?item wdt:P31 ?instance . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${limit}`;
  const url = new URL(endpoint);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  const { data, cacheHit } = await cachedJson({
    cacheDir: path.join(runtime.cacheDir, "supplemental", "wikidata"),
    key: url.toString(),
    noCache: runtime.noCache,
    fetcher: () => fetchJson(url, {
      headers: { ...requestHeaders(runtime).headers, Accept: "application/sparql-results+json" }
    }, { retries: 2 })
  });
  const seen = new Set();
  const features = [];
  for (const row of data.results?.bindings || []) {
    const item = row.item?.value;
    if (!item || seen.has(item)) continue;
    const point = parseWktPoint(row.location?.value);
    if (!point || !pointInsideBbox(point, runtime.bbox)) continue;
    seen.add(item);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: point },
      properties: {
        id: `wikidata:${item.split("/").at(-1)}`,
        name: row.itemLabel?.value || null,
        kind: "attraction",
        subtype: "wikidata-place",
        wikidata: item.split("/").at(-1),
        instance_of: row.instanceLabel?.value || row.instance?.value || null,
        source_name: "Wikidata",
        source_url: item,
        source_dataset: "Wikidata Query Service nearby entities",
        license: "CC0-1.0",
        checked_at: new Date().toISOString(),
        merge_policy: "semantic-only"
      }
    });
  }
  return {
    collections: [collectionEntry({
      id: "wikidata-places",
      adapter: "sparql-nearby",
      provider: "Wikidata",
      endpoint,
      cacheHit,
      collection: featureCollection(features, {
        name: "Wikidata",
        url: endpoint,
        license: "CC0-1.0",
        dataset: "nearby georeferenced entities",
        checked_at: new Date().toISOString()
      }),
      request: { center, radiusKm, limit }
    })]
  };
}

async function acquireWikimediaCommons(runtime, options) {
  const endpoint = options.wikimediaCommonsUrl || COMMONS_API;
  const center = bboxCenter(runtime.bbox);
  const radiusM = Math.min(10_000, Math.ceil(bboxRadiusKm(runtime.bbox) * 1_000 + 500));
  const limit = Math.max(1, Math.min(500, Number(options.wikimediaCommonsLimit ?? 100)));
  const url = new URL(endpoint);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("generator", "geosearch");
  url.searchParams.set("ggsprimary", "all");
  url.searchParams.set("ggsnamespace", "6");
  url.searchParams.set("ggsradius", String(radiusM));
  url.searchParams.set("ggscoord", `${center.lat}|${center.lon}`);
  url.searchParams.set("ggslimit", String(limit));
  url.searchParams.set("prop", "coordinates|imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata|mime|size");
  url.searchParams.set("iiurlwidth", "640");
  const { data, cacheHit } = await cachedJson({
    cacheDir: path.join(runtime.cacheDir, "supplemental", "wikimedia-commons"),
    key: url.toString(),
    noCache: runtime.noCache,
    fetcher: () => fetchJson(url, requestHeaders(runtime), { retries: 2 })
  });
  const images = Object.values(data.query?.pages || {}).map((page) => {
    const info = page.imageinfo?.[0] || {};
    const coordinates = page.coordinates?.[0] || null;
    const meta = info.extmetadata || {};
    return {
      pageId: page.pageid,
      title: page.title,
      coordinates: coordinates ? { lat: coordinates.lat, lon: coordinates.lon } : null,
      thumbnailUrl: info.thumburl || null,
      descriptionUrl: info.descriptionurl || null,
      mime: info.mime || null,
      width: info.width || null,
      height: info.height || null,
      artist: stripHtml(meta.Artist?.value),
      license: meta.LicenseShortName?.value || null,
      licenseUrl: meta.LicenseUrl?.value || null,
      dateTimeOriginal: meta.DateTimeOriginal?.value || meta.DateTime?.value || null,
      categories: stripHtml(meta.Categories?.value)
    };
  }).filter((image) => image.coordinates && pointInsideBbox(
    [image.coordinates.lon, image.coordinates.lat], runtime.bbox));
  return {
    evidence: {
      provider: "Wikimedia Commons",
      endpoint,
      cacheHit,
      searchedCenter: center,
      searchedRadiusM: radiusM,
      count: images.length,
      images
    }
  };
}

async function discoverOpenAerialMap(runtime, options) {
  const endpoint = options.openAerialMapUrl || OPEN_AERIAL_MAP_API;
  const url = new URL(endpoint);
  url.searchParams.set("bbox", bboxArray(runtime.bbox).join(","));
  const { data, cacheHit } = await cachedJson({
    cacheDir: path.join(runtime.cacheDir, "supplemental", "open-aerial-map"),
    key: url.toString(),
    noCache: runtime.noCache,
    fetcher: () => fetchJson(url, requestHeaders(runtime), { retries: 2 })
  });
  const records = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
  const candidates = records.map((record) => ({
    id: record._id || record.id || record.uuid || null,
    title: record.title || record.name || null,
    provider: record.provider || record.contact || null,
    acquisitionStart: record.acquisition_start || record.acquisitionStart || null,
    acquisitionEnd: record.acquisition_end || record.acquisitionEnd || null,
    resolutionM: firstNumber(record, ["gsd", "resolution", "resolution_m"]),
    license: record.license || record.license_name || null,
    tms: record.tms || record.tiles || record.tile_url || null,
    url: record.url || record.meta_uri || record._links?.self || null,
    bbox: record.bbox || record.geojson?.bbox || null
  })).sort((a, b) => {
    const ad = Date.parse(a.acquisitionEnd || a.acquisitionStart || 0) || 0;
    const bd = Date.parse(b.acquisitionEnd || b.acquisitionStart || 0) || 0;
    if (ad !== bd) return bd - ad;
    return (a.resolutionM ?? Infinity) - (b.resolutionM ?? Infinity);
  });
  return {
    evidence: {
      provider: "OpenAerialMap",
      endpoint,
      cacheHit,
      bbox: runtime.bbox,
      count: candidates.length,
      candidates
    }
  };
}

async function acquireOsOpenMapLocal(runtime, filename) {
  const resolved = path.resolve(filename);
  const collection = await readJson(resolved);
  invariant(collection?.type === "FeatureCollection", `--os-openmap-local ${filename} must be GeoJSON`);
  const features = collection.features
    .filter((feature) => feature.geometry && geometryIntersectsBbox(feature.geometry, runtime.bbox))
    .slice(0, runtime.maxFeatures)
    .map((feature, index) => {
      const classification = classifyOsOpenMapLocal(feature.properties || {}, feature.geometry);
      return standardizeFeature(feature, {
        idPrefix: `os-openmap-local:${path.basename(filename)}`,
        index,
        provider: "Ordnance Survey",
        sourceUrl: "https://osdatahub.os.uk/downloads/open/OpenMapLocal",
        license: OGL_3,
        dataset: "OS OpenMap Local",
        adapter: "os-openmap-local-geojson",
        kind: classification.kind,
        subtype: classification.subtype,
        checkedAt: new Date().toISOString(),
        mergePolicy: "gap-fill"
      });
    });
  return {
    collections: [collectionEntry({
      id: `os-openmap-local:${path.basename(filename)}`,
      adapter: "os-openmap-local-geojson",
      provider: "Ordnance Survey",
      endpoint: resolved,
      cacheHit: true,
      collection: featureCollection(features, {
        name: "Ordnance Survey",
        url: "https://osdatahub.os.uk/downloads/open/OpenMapLocal",
        license: OGL_3,
        dataset: "OS OpenMap Local",
        checked_at: new Date().toISOString()
      }),
      request: { file: resolved, inputFeatures: collection.features.length }
    })]
  };
}

async function acquireOsNgd(runtime, options) {
  const apiKey = options.osNgdApiKey || process.env.OS_NGD_API_KEY || process.env.TPMAP_OS_NGD_API_KEY;
  const baseUrl = stripSlash(options.osNgdUrl || OS_NGD_API);
  if (!apiKey) return {
    collections: [],
    evidence: {
      provider: "Ordnance Survey",
      dataset: "OS National Geographic Database",
      endpoint: baseUrl,
      configured: false,
      reason: "OS_NGD_API_KEY is not configured"
    },
    warnings: ["OS NGD is enabled but no OS_NGD_API_KEY is configured; continuing with open sources."]
  };

  const listingUrl = new URL(`${baseUrl}/collections`);
  listingUrl.searchParams.set("f", "json");
  listingUrl.searchParams.set("key", apiKey);
  const { data: listing, cacheHit: listingCacheHit } = await cachedJson({
    cacheDir: path.join(runtime.cacheDir, "supplemental", "os-ngd-collections"),
    key: listingUrl.toString(),
    noCache: runtime.noCache,
    fetcher: () => fetchJson(listingUrl, requestHeaders(runtime), { retries: 2 })
  });
  const explicit = splitCsv(options.osNgdCollections);
  const useful = /building|structure|transport|path|land|water|site|named|street|road|rail|vegetation|hedge|field boundar/i;
  const selected = (listing.collections || []).filter((collection) => {
    if (explicit?.length) return explicit.includes(collection.id);
    return useful.test(`${collection.id || ""} ${collection.title || ""} ${collection.description || ""}`);
  }).slice(0, Math.max(1, Math.min(30, Number(options.osNgdMaxCollections ?? 20))));

  const collections = [];
  let remaining = runtime.maxFeatures;
  for (const collection of selected) {
    if (remaining <= 0) break;
    const itemsUrl = `${baseUrl}/collections/${encodeURIComponent(collection.id)}/items`;
    const acquired = await fetchOgcFeaturePages({ ...runtime, maxFeatures: remaining }, {
      url: itemsUrl,
      bbox: runtime.bbox,
      limit: runtime.pageSize,
      query: { key: apiKey }
    });
    const features = acquired.features.map((raw, index) => {
      const classification = classifyOsNgd(raw.properties || {}, raw.geometry, collection);
      const properties = raw.properties || {};
      return standardizeFeature(raw, {
        idPrefix: `os-ngd:${collection.id}`,
        index,
        provider: "Ordnance Survey",
        sourceUrl: "https://docs.os.uk/osngd",
        license: options.osNgdLicense || "OS Data Hub terms (account-specific)",
        dataset: `OS NGD/${collection.title || collection.id}`,
        adapter: "os-ngd-ogc-api-features",
        kind: classification.kind,
        subtype: classification.subtype,
        checkedAt: new Date().toISOString(),
        mergePolicy: ["water", "vegetation"].includes(classification.kind) ? "independent-detail" : "gap-fill",
        heightM: firstNumber(properties, [
          "relativeHeightMaximum", "relative_height_maximum", "relativeHeight", "height", "height_m",
          "RelativeHeightMaximum", "Height"
        ]),
        accuracyM: firstNumber(properties, ["accuracyOfPosition", "accuracy_m", "planimetricAccuracy"]),
        extra: {
          os_ngd_collection: collection.id,
          roof_shape: firstString(properties, ["roofShape", "roof_shape", "RoofShape"]),
          roof_material: firstString(properties, ["roofMaterial", "roof_material", "RoofMaterial"]),
          storeys: firstNumber(properties, ["numberOfStoreys", "storeys", "NumberOfStoreys"]),
          absolute_height_max_m: firstNumber(properties, ["absoluteHeightMaximum", "absolute_height_maximum"]),
          average_height_m: firstNumber(properties, ["averageHeight", "average_height"]),
          average_width_m: firstNumber(properties, ["averageWidth", "average_width"])
        }
      });
    });
    remaining -= features.length;
    collections.push(collectionEntry({
      id: `os-ngd:${collection.id}`,
      adapter: "os-ngd-ogc-api-features",
      provider: "Ordnance Survey",
      endpoint: itemsUrl,
      cacheHit: listingCacheHit && acquired.cacheHits === acquired.pages,
      collection: featureCollection(features, {
        name: "Ordnance Survey",
        url: "https://docs.os.uk/osngd",
        license: options.osNgdLicense || "OS Data Hub terms (account-specific)",
        dataset: `OS NGD/${collection.title || collection.id}`,
        checked_at: new Date().toISOString()
      }),
      request: { ...acquired.request, collection: collection.id }
    }));
  }
  return {
    collections,
    evidence: {
      provider: "Ordnance Survey",
      dataset: "OS National Geographic Database",
      endpoint: baseUrl,
      configured: true,
      discoveredCollections: listing.collections?.length || 0,
      selectedCollections: selected.map((collection) => ({ id: collection.id, title: collection.title || null }))
    },
    warnings: selected.length ? [] : ["No relevant OS NGD collections were found; use --os-ngd-collections to select explicit collection IDs."]
  };
}

async function acquireConfiguredSource(runtime, config, configFilename, index) {
  invariant(config && typeof config === "object", `${configFilename} source ${index} must be an object`);
  const type = String(config.type || "").toLowerCase();
  invariant(type, `${configFilename} source ${index} requires type`);
  if (type === "ogc-api-features") return acquireConfiguredOgc(runtime, config);
  if (type === "arcgis-feature-layer") return acquireConfiguredArcGis(runtime, config);
  if (type === "geojson-url") return acquireConfiguredGeoJsonUrl(runtime, config);
  if (type === "geojson-file") return acquireConfiguredGeoJsonFile(runtime, config, configFilename);
  throw new UserError(`Unsupported supplemental source type: ${type}`);
}

async function acquireConfiguredOgc(runtime, config) {
  requireSourceMetadata(config);
  const base = stripSlash(config.url);
  const itemsUrl = config.collection
    ? `${base}/collections/${encodeURIComponent(config.collection)}/items`
    : /\/items$/i.test(base) ? base : null;
  invariant(itemsUrl, `OGC source ${config.id || config.url} requires collection or an /items URL`);
  const acquired = await fetchOgcFeaturePages(runtime, {
    url: itemsUrl,
    bbox: runtime.bbox,
    limit: Number(config.pageSize || runtime.pageSize),
    query: config.query || {}
  });
  const features = acquired.features.map((feature, index) => standardizeConfiguredFeature(feature, config, index));
  return {
    collections: [collectionEntry({
      id: config.id || `ogc:${sha256(config).slice(0, 12)}`,
      adapter: "ogc-api-features",
      provider: config.provider,
      endpoint: itemsUrl,
      cacheHit: acquired.cacheHits === acquired.pages,
      collection: featureCollection(features, sourceMetadata(config)),
      request: acquired.request
    })]
  };
}

async function acquireConfiguredArcGis(runtime, config) {
  requireSourceMetadata(config);
  const layerUrl = stripSlash(config.url);
  const features = [];
  let offset = 0;
  let pages = 0;
  let cacheHits = 0;
  while (features.length < runtime.maxFeatures) {
    const url = new URL(`${layerUrl}/query`);
    url.searchParams.set("where", config.where || "1=1");
    url.searchParams.set("geometry", bboxArray(runtime.bbox).join(","));
    url.searchParams.set("geometryType", "esriGeometryEnvelope");
    url.searchParams.set("inSR", "4326");
    url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    url.searchParams.set("outFields", config.outFields || "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", String(Math.min(runtime.pageSize, runtime.maxFeatures - features.length)));
    url.searchParams.set("f", "geojson");
    const { data, cacheHit } = await cachedJson({
      cacheDir: path.join(runtime.cacheDir, "supplemental", "arcgis"),
      key: url.toString(),
      noCache: runtime.noCache,
      fetcher: () => fetchJson(url, requestHeaders(runtime), { retries: 2 })
    });
    pages += 1;
    if (cacheHit) cacheHits += 1;
    const page = data.features || [];
    features.push(...page);
    if (!data.properties?.exceededTransferLimit && !data.exceededTransferLimit && page.length < runtime.pageSize) break;
    if (!page.length || pages >= 100) break;
    offset += page.length;
  }
  const standardized = features.slice(0, runtime.maxFeatures)
    .map((feature, index) => standardizeConfiguredFeature(feature, config, index));
  return {
    collections: [collectionEntry({
      id: config.id || `arcgis:${sha256(config).slice(0, 12)}`,
      adapter: "arcgis-feature-layer",
      provider: config.provider,
      endpoint: layerUrl,
      cacheHit: cacheHits === pages,
      collection: featureCollection(standardized, sourceMetadata(config)),
      request: { bbox: runtime.bbox, pages, truncated: features.length >= runtime.maxFeatures }
    })]
  };
}

async function acquireConfiguredGeoJsonUrl(runtime, config) {
  requireSourceMetadata(config);
  const { data, cacheHit } = await cachedJson({
    cacheDir: path.join(runtime.cacheDir, "supplemental", "geojson-url"),
    key: config.url,
    noCache: runtime.noCache,
    fetcher: () => fetchJson(config.url, requestHeaders(runtime), { retries: 2 })
  });
  return configuredGeoJsonResult(runtime, config, data, cacheHit, config.url);
}

async function acquireConfiguredGeoJsonFile(runtime, config, configFilename) {
  requireSourceMetadata(config);
  const filename = path.resolve(path.dirname(configFilename), config.file);
  const data = await readJson(filename);
  return configuredGeoJsonResult(runtime, config, data, true, filename);
}

function configuredGeoJsonResult(runtime, config, data, cacheHit, endpoint) {
  invariant(data?.type === "FeatureCollection", `${config.id || endpoint} must return a GeoJSON FeatureCollection`);
  const features = data.features
    .filter((feature) => feature.geometry && geometryIntersectsBbox(feature.geometry, runtime.bbox))
    .slice(0, runtime.maxFeatures)
    .map((feature, index) => standardizeConfiguredFeature(feature, config, index));
  return {
    collections: [collectionEntry({
      id: config.id || `geojson:${sha256(config).slice(0, 12)}`,
      adapter: endpoint.startsWith?.("http") ? "geojson-url" : "geojson-file",
      provider: config.provider,
      endpoint,
      cacheHit,
      collection: featureCollection(features, sourceMetadata(config)),
      request: { bbox: runtime.bbox, inputFeatures: data.features.length }
    })]
  };
}

async function fetchOgcFeaturePages(runtime, { url, bbox, limit, query = {} }) {
  const features = [];
  let nextUrl = new URL(url);
  nextUrl.searchParams.set("bbox", bboxArray(bbox).join(","));
  nextUrl.searchParams.set("limit", String(Math.min(limit, runtime.maxFeatures)));
  nextUrl.searchParams.set("f", "json");
  for (const [key, value] of Object.entries(query)) nextUrl.searchParams.set(key, String(value));
  let pages = 0;
  let cacheHits = 0;
  while (nextUrl && features.length < runtime.maxFeatures) {
    for (const [key, value] of Object.entries(query)) if (!nextUrl.searchParams.has(key)) nextUrl.searchParams.set(key, String(value));
    const requestUrl = nextUrl.toString();
    const { data, cacheHit } = await cachedJson({
      cacheDir: path.join(runtime.cacheDir, "supplemental", "ogc-features"),
      key: requestUrl,
      noCache: runtime.noCache,
      fetcher: () => fetchJson(requestUrl, requestHeaders(runtime), { retries: 2 })
    });
    pages += 1;
    if (cacheHit) cacheHits += 1;
    const page = Array.isArray(data.features) ? data.features : [];
    features.push(...page.slice(0, runtime.maxFeatures - features.length));
    const next = findNextLink(data.links);
    nextUrl = next ? new URL(next, requestUrl) : null;
    if (!nextUrl || !page.length || pages >= 100) break;
  }
  return {
    features,
    pages,
    cacheHits,
    request: { bbox, pages, truncated: features.length >= runtime.maxFeatures }
  };
}

function standardizeConfiguredFeature(feature, config, index) {
  const properties = feature.properties || {};
  const kind = readMappedValue(properties, config.kindProperty) || config.kind || inferGenericKind(properties, feature.geometry);
  const subtype = readMappedValue(properties, config.subtypeProperty) || config.subtype || inferGenericSubtype(properties);
  const heightM = firstNumber(properties, asList(config.heightProperties || ["height_m", "height", "Height"]));
  return standardizeFeature(feature, {
    idPrefix: config.id || config.provider,
    index,
    provider: config.provider,
    sourceUrl: config.sourceUrl || config.url,
    license: config.license,
    dataset: config.dataset || config.id || null,
    adapter: config.type,
    kind,
    subtype,
    checkedAt: config.checkedAt || new Date().toISOString(),
    mergePolicy: config.mergePolicy || "independent-detail",
    heightM,
    accuracyM: firstNumber(properties, asList(config.accuracyProperties || ["accuracy_m"])),
    extra: config.constantProperties || null
  });
}

function standardizeFeature(feature, metadata) {
  const properties = { ...(feature.properties || {}), ...(metadata.extra || {}) };
  const existingId = metadata.explicitId || properties.id || feature.id || null;
  return {
    type: "Feature",
    id: feature.id || undefined,
    geometry: feature.geometry,
    properties: {
      ...properties,
      id: existingId || `${metadata.idPrefix}:${metadata.index}:${sha256(feature).slice(0, 10)}`,
      name: properties.name || properties.title || properties.Name || null,
      kind: metadata.kind || properties.kind || "detail",
      subtype: metadata.subtype || properties.subtype || "public-observation",
      height_m: metadata.heightM ?? properties.height_m ?? null,
      accuracy_m: metadata.accuracyM ?? properties.accuracy_m ?? null,
      source_name: metadata.provider,
      source_url: metadata.sourceUrl,
      source_dataset: metadata.dataset,
      source_adapter: metadata.adapter || null,
      license: metadata.license,
      checked_at: metadata.checkedAt,
      merge_policy: metadata.mergePolicy
    }
  };
}

function featureCollection(features, source) {
  return { type: "FeatureCollection", source, features };
}

function collectionEntry({ id, adapter, provider, endpoint, cacheHit, collection, request }) {
  return { id, adapter, provider, endpoint, cacheHit, collection, request };
}

function sourceMetadata(config) {
  return {
    name: config.provider,
    url: config.sourceUrl || config.url,
    license: config.license,
    dataset: config.dataset || config.id || null,
    checked_at: config.checkedAt || new Date().toISOString()
  };
}

function requireSourceMetadata(config) {
  invariant(config.url || config.file, `Supplemental source ${config.id || "entry"} requires url or file`);
  invariant(config.provider, `Supplemental source ${config.id || config.url || config.file} requires provider`);
  invariant(config.license, `Supplemental source ${config.id || config.url || config.file} requires license`);
  invariant(config.sourceUrl || config.url,
    `Supplemental source ${config.id || config.file || "entry"} requires sourceUrl for provenance`);
}

function classifyOsOpenMapLocal(properties, geometry) {
  const text = Object.values(properties).filter((value) => typeof value === "string").join(" ").toLowerCase();
  if (/building|glasshouse/.test(text) && geometry.type.includes("Polygon")) return { kind: "building", subtype: "os-openmap-building" };
  if (/footpath|path|pedestrian|cycle path/.test(text)) return { kind: "path", subtype: "os-openmap-path" };
  if (/road|motorway|street/.test(text)) return { kind: "road", subtype: "os-openmap-road" };
  if (/wood|forest|trees|scrub/.test(text)) return { kind: "vegetation", subtype: "os-openmap-vegetation" };
  if (/water|lake|pond|river|stream/.test(text)) return { kind: "water", subtype: "os-openmap-water" };
  if (/rail/.test(text)) return { kind: "rail", subtype: "os-openmap-rail" };
  if (/barrier|fence|wall/.test(text)) return { kind: "barrier", subtype: "os-openmap-barrier" };
  return { kind: geometry.type.includes("Polygon") ? "surface" : "detail", subtype: "os-openmap-local" };
}

function classifyOsNgd(properties, geometry, collection = {}) {
  const text = `${collection.id || ""} ${collection.title || ""} ${Object.values(properties).filter((value) => typeof value === "string").join(" ")}`.toLowerCase();
  const polygon = geometry?.type?.includes("Polygon");
  if (/building/.test(text) && polygon) return { kind: "building", subtype: "os-ngd-building" };
  if (/footpath|path|pedestrian|footbridge|steps|transport.*path/.test(text)) return { kind: "path", subtype: /bridge/.test(text) ? "os-ngd-footbridge" : "os-ngd-path" };
  if (/hedge|field boundar|fence|wall|barrier|railing/.test(text)) return { kind: /hedge/.test(text) ? "vegetation" : "barrier", subtype: /hedge/.test(text) ? "os-ngd-hedge" : "os-ngd-boundary-structure" };
  if (/water|lake|pond|river|stream|watercourse/.test(text)) return { kind: "water", subtype: "os-ngd-water" };
  if (/tree|woodland|vegetation|scrub/.test(text)) return { kind: "vegetation", subtype: "os-ngd-vegetation" };
  if (/bridge|structure|statue|monument|mast|tower|street light|streetlight/.test(text)) return { kind: "structure", subtype: "os-ngd-structure" };
  if (/road|street|carriageway/.test(text)) return { kind: "road", subtype: "os-ngd-road" };
  return { kind: polygon ? "surface" : "detail", subtype: "os-ngd-feature" };
}

function inferTowSubtype(properties = {}) {
  const value = firstString(properties, [
    "woodland_type", "Woodland_Type", "WoodlandType", "WOODLAND_TYPE",
    "tow_type", "TOW_TYPE", "type", "Type", "class", "Class"
  ]);
  if (!value) return "tree-canopy";
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (normalized.includes("lone")) return "lone-tree-canopy";
  if (normalized.includes("group")) return "tree-group-canopy";
  if (normalized.includes("small") && normalized.includes("wood")) return "small-woodland";
  if (normalized.includes("nfi") && normalized.includes("ohc")) return "nfi-overhanging-canopy";
  return normalized || "tree-canopy";
}

function inferGenericKind(properties, geometry) {
  const text = JSON.stringify(properties).toLowerCase();
  if (/building|structure/.test(text)) return "building";
  if (/tree|woodland|forest|canopy|vegetation/.test(text)) return "vegetation";
  if (/footway|path|pedestrian/.test(text)) return "path";
  if (/road|highway/.test(text)) return "road";
  if (/water|river|lake|pond/.test(text)) return "water";
  return geometry?.type?.includes("Polygon") ? "surface" : "detail";
}

function inferGenericSubtype(properties) {
  return firstString(properties, ["subtype", "type", "class", "category", "descriptiveTerm"]) || "public-observation";
}

function representativePoint(geometry) {
  const points = [];
  const visit = (value) => {
    if (Array.isArray(value) && value.length >= 2 && value.slice(0, 2).every(Number.isFinite)) points.push(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
  };
  visit(geometry?.coordinates);
  if (!points.length) return null;
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length
  ];
}

function collectionIntersectsBbox(collection, bbox) {
  const extents = collection.extent?.spatial?.bbox || collection.extent?.bbox || [];
  if (!Array.isArray(extents) || !extents.length) return true;
  return extents.some((extent) => {
    const values = Array.isArray(extent[0]) ? extent[0] : extent;
    if (!Array.isArray(values) || values.length < 4) return true;
    return bboxIntersects(bbox, { west: values[0], south: values[1], east: values[2], north: values[3] });
  });
}

function geometryIntersectsBbox(geometry, bbox) {
  const bounds = geometryBoundsWgs84(geometry);
  return bounds ? bboxIntersects(bbox, bounds) : false;
}

function geometryBoundsWgs84(geometry) {
  if (!geometry?.coordinates) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      west = Math.min(west, value[0]); east = Math.max(east, value[0]);
      south = Math.min(south, value[1]); north = Math.max(north, value[1]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

function bboxIntersects(a, b) {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

function pointInsideBbox([lon, lat], bbox) {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function bboxArray(bbox) {
  return [bbox.west, bbox.south, bbox.east, bbox.north];
}

function bboxWkt(bbox) {
  return `POLYGON((${bbox.west} ${bbox.south},${bbox.east} ${bbox.south},${bbox.east} ${bbox.north},${bbox.west} ${bbox.north},${bbox.west} ${bbox.south}))`;
}

function bboxRadiusKm(bbox) {
  const center = bboxCenter(bbox);
  return haversineKm(center.lat, center.lon, bbox.north, bbox.east);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371.0088;
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function bboxQuadKeys(bbox, zoom) {
  const nw = latLonToTile(bbox.north, bbox.west, zoom);
  const se = latLonToTile(bbox.south, bbox.east, zoom);
  const keys = new Set();
  for (let y = nw.y; y <= se.y; y += 1) for (let x = nw.x; x <= se.x; x += 1) {
    keys.add(tileToQuadKey(x, y, zoom));
  }
  return keys;
}

function latLonToTile(lat, lon, zoom) {
  const n = 2 ** zoom;
  const clippedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = clippedLat * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

function tileToQuadKey(tileX, tileY, level) {
  let key = "";
  for (let i = level; i > 0; i -= 1) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((tileX & mask) !== 0) digit += 1;
    if ((tileY & mask) !== 0) digit += 2;
    key += digit;
  }
  return key;
}

function selectMicrosoftRows(rows, quadkeys) {
  const matching = rows.filter((row) => quadkeys.has(String(valueByHeader(row, ["quadkey", "quad_key", "tile"]) || "")));
  const byQuadkey = new Map();
  for (const row of matching) {
    const key = String(valueByHeader(row, ["quadkey", "quad_key", "tile"]));
    const previous = byQuadkey.get(key);
    if (!previous || rowDate(row) > rowDate(previous)) byQuadkey.set(key, row);
  }
  return [...byQuadkey.values()];
}

function rowDate(row) {
  const value = valueByHeader(row, ["uploaddate", "date", "updated", "release"]);
  return Date.parse(value || 0) || 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => normalizeHeader(header));
  return rows.filter((values) => values.some((value) => value !== "")).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueByHeader(row, names) {
  for (const name of names) {
    const value = row[normalizeHeader(name)];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

async function* gunzipLines(bytes) {
  const gunzip = createGunzip();
  const input = Readable.from([bytes]);
  const lines = createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
  for await (const line of lines) yield line;
}

function parseByteSize(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const match = String(value).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|KIB|MIB|GIB)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || "B").toUpperCase();
  const powers = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3 };
  return Math.ceil(amount * (1024 ** powers[unit]));
}

async function fetchCachedText(runtime, url, namespace) {
  const { data, cacheHit, filename } = await cachedBinary({
    cacheDir: path.join(runtime.cacheDir, "supplemental", namespace),
    key: url,
    noCache: runtime.noCache,
    extension: ".txt",
    fetcher: () => fetchBinary(url, requestHeaders(runtime), { retries: 2 })
  });
  const bytes = data || await readFile(filename);
  return { text: bytes.toString("utf8"), cacheHit, filename };
}

function requestHeaders(runtime) {
  return { headers: { "User-Agent": runtime.userAgent, Accept: "application/json, application/geo+json;q=0.9, */*;q=0.1" } };
}

function findNextLink(links) {
  if (!links) return null;
  if (typeof links === "object" && !Array.isArray(links)) return links.next || links.Next || null;
  return links.find?.((link) => link.rel === "next")?.href || null;
}

function parseWktPoint(value) {
  const match = String(value || "").match(/Point\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function splitCsv(value) {
  if (!value) return null;
  const values = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  return values.length ? values : null;
}

function asList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function readMappedValue(properties, key) {
  if (!key) return null;
  return properties[key] ?? null;
}

function firstNumber(object = {}, keys = []) {
  for (const key of keys) {
    const value = object?.[key];
    const number = typeof value === "string" ? Number(value.replace(/[^0-9+-.eE]/g, "")) : Number(value);
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(number)) return number;
  }
  return null;
}

function firstString(object = {}, keys = []) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return null;
}

function towFeatureId(collectionId, sourceId, tileId, index) {
  return `tow:${collectionId}:${sourceId}:${tileId || "no-tile"}:${index}`;
}

function stripHtml(value) {
  return value ? String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : null;
}

function stripSlash(value) {
  return String(value).replace(/\/+$/, "");
}

export const __test = {
  bboxQuadKeys,
  parseCsv,
  geometryIntersectsBbox,
  standardizePlanningFeature,
  classifyOsOpenMapLocal,
  classifyOsNgd,
  selectMicrosoftRows,
  inferTowSubtype,
  towFeatureId,
  parseByteSize,
  gunzipLines
};
