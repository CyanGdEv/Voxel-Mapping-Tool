import path from "node:path";
import { bboxAreaKm2, bboxCenter, createProjector, parseBbox } from "./geo.mjs";
import { UserError, invariant } from "./errors.mjs";
import { cachedJson, ensureDir, fetchJson, readJson, sha256 } from "./io.mjs";
import { acquireLidarElevation } from "./lidar.mjs";
import { acquireOrthophotos } from "./orthophoto.mjs";
import { acquireSupplementalSources } from "./supplemental-sources.mjs";
import { acquirePlanningEvidence } from "./planning-manifest.mjs";

const DEFAULT_NOMINATIM = "https://nominatim.openstreetmap.org/search";
const DEFAULT_OVERPASS = "https://overpass-api.de/api/interpreter";
const DEFAULT_OPEN_METEO = "https://api.open-meteo.com/v1/elevation";

export async function acquireSources(options, progress = () => {}) {
  const cacheDir = path.resolve(options.cache || ".tpmap-cache");
  await ensureDir(cacheDir);
  const contact = options.contact || process.env.TPMAP_CONTACT;
  const userAgent = contact ? `VoxelMappingTool/0.2.0 (${contact})` : "VoxelMappingTool/0.2.0";

  let bbox = options.bbox ? parseBbox(options.bbox) : undefined;
  let geocoder = null;
  let suppliedBoundary = null;

  if (!bbox && !options.osm) {
    invariant(options.parkName, "Use --park-name, or provide both --osm and --bbox");
    invariant(options.acceptNominatimPolicy,
      "Live place lookup requires --accept-nominatim-policy. Read https://operations.osmfoundation.org/policies/nominatim/");
    invariant(contact,
      "Live OSM services require --contact with a project URL or email for an identifying User-Agent");
    geocoder = await resolveWithNominatim({ ...options, cacheDir, userAgent });
    bbox = geocoder.bbox;
    suppliedBoundary = geocoder.geometry?.type?.includes("Polygon") ? geocoder.geometry : null;
  }

  if (!bbox && options.osm) bbox = deriveBboxFromOverpass(await readJson(path.resolve(options.osm)));
  invariant(bbox, "Could not determine a park bounding box");

  const areaKm2 = bboxAreaKm2(bbox);
  const maxAreaKm2 = options.maxAreaKm2 ?? 12;
  if (areaKm2 > maxAreaKm2 && !options.allowLargeArea) {
    throw new UserError(
      `The requested bounding box is ${areaKm2.toFixed(2)} km²; the safety limit is ${maxAreaKm2} km²`,
      "Use a tighter --bbox or deliberately add --allow-large-area."
    );
  }

  const center = bboxCenter(bbox);
  progress("Acquiring alignment, terrain, and independent public datasets in parallel");
  const osmPromise = options.osm
    ? readJson(path.resolve(options.osm)).then((data) => ({
        data,
        dataHash: sha256(data),
        filename: path.resolve(options.osm),
        source: "local",
        cacheHit: true
      }))
    : fetchOverpass({ ...options, bbox, cacheDir, userAgent });
  const elevationPromise = acquireElevation({ ...options, bbox, cacheDir, userAgent });
  const supplementalPromise = acquireSupplementalSources(options, {
    bbox, center, cacheDir, userAgent
  });
  const orthophotoPromise = elevationPromise.then((elevation) => acquireOrthophotos(
    { ...options, bbox, cacheDir, userAgent },
    { center, projector: createProjector(center), elevation }
  ));
  const [osm, elevation, supplemental, orthophoto] = await Promise.all([
    osmPromise, elevationPromise, supplementalPromise, orthophotoPromise
  ]);
  progress("Discovering, downloading, and extracting official planning evidence");
  const planning = await acquirePlanningEvidence(options, {
    bbox, center, cacheDir, userAgent, elevation, orthophoto, supplemental, progress
  });
  return {
    parkName: options.parkName || geocoder?.displayName?.split(",")[0] || "Theme Park",
    bbox,
    areaKm2,
    center,
    suppliedBoundary,
    geocoder,
    osm,
    elevation,
    orthophoto,
    supplemental,
    planning,
    acquiredAt: new Date().toISOString()
  };
}

async function resolveWithNominatim({ parkName, nominatimUrl, cacheDir, userAgent, noCache }) {
  const endpoint = nominatimUrl || DEFAULT_NOMINATIM;
  const url = new URL(endpoint);
  url.searchParams.set("q", parkName);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("polygon_geojson", "1");
  url.searchParams.set("addressdetails", "1");

  const { data, cacheHit } = await cachedJson({
    cacheDir: path.join(cacheDir, "nominatim"),
    key: url.toString(),
    noCache,
    fetcher: () => fetchJson(url, { headers: { "User-Agent": userAgent, Accept: "application/json" } }, { retries: 1 })
  });
  invariant(Array.isArray(data) && data.length, `No place named “${parkName}” was found`);
  const ranked = [...data].sort((a, b) => rankPlace(b, parkName) - rankPlace(a, parkName));
  const choice = ranked[0];
  const bounds = choice.boundingbox?.map(Number);
  invariant(bounds?.length === 4 && bounds.every(Number.isFinite), "The geocoder result has no valid bounding box");
  return {
    provider: "OpenStreetMap Nominatim",
    policy: "https://operations.osmfoundation.org/policies/nominatim/",
    cacheHit,
    placeId: choice.place_id,
    osmType: choice.osm_type,
    osmId: choice.osm_id,
    displayName: choice.display_name,
    bbox: { south: bounds[0], north: bounds[1], west: bounds[2], east: bounds[3] },
    geometry: choice.geojson || null,
    candidates: ranked.slice(0, 5).map((item) => ({
      placeId: item.place_id, displayName: item.display_name, type: item.type, importance: item.importance
    }))
  };
}

function rankPlace(place, query) {
  let score = Number(place.importance || 0);
  if (place.type === "theme_park" || place.addresstype === "theme_park") score += 10;
  if (String(place.display_name).toLowerCase().startsWith(query.toLowerCase())) score += 2;
  return score;
}

async function fetchOverpass({ bbox, overpassUrl, cacheDir, userAgent, noCache }) {
  const endpoint = overpassUrl || DEFAULT_OVERPASS;
  const query = buildOverpassQuery(bbox);
  const { data, cacheHit } = await cachedJson({
    cacheDir: path.join(cacheDir, "overpass"),
    key: `${endpoint}\n${query}`,
    noCache,
    fetcher: () => fetchJson(endpoint, {
      method: "POST",
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: new URLSearchParams({ data: query })
    }, { timeoutMs: 180_000, retries: 2 })
  });
  invariant(Array.isArray(data?.elements), "Overpass returned no elements array");
  return {
    data,
    source: "live",
    cacheHit,
    endpoint,
    queryHash: sha256(query),
    query,
    attribution: "© OpenStreetMap contributors, ODbL 1.0",
    license: "https://www.openstreetmap.org/copyright"
  };
}

export function buildOverpassQuery({ south, west, north, east }) {
  const bbox = [south, west, north, east].map((value) => value.toFixed(7)).join(",");
  return `[out:json][timeout:120][bbox:${bbox}];
(
  nwr["tourism"="theme_park"];
  nwr["tourism"];
  nwr["building"];
  nwr["highway"];
  nwr["area:highway"];
  nwr["attraction"];
  nwr["roller_coaster"];
  nwr["railway"];
  nwr["natural"];
  nwr["geological"];
  nwr["landuse"];
  nwr["leisure"];
  nwr["waterway"];
  nwr["barrier"];
  nwr["amenity"];
  nwr["man_made"];
  nwr["shop"];
  nwr["entrance"];
  nwr["door"];
  nwr["historic"];
  nwr["information"];
  nwr["playground"];
  nwr["public_transport"];
  nwr["landcover"];
);
out meta geom;`;
}

async function acquireElevation(options) {
  const provider = options.elevation || "none";
  if (provider === "none") {
    return {
      provider: "none",
      resolutionM: null,
      points: [],
      warning: "No terrain source was selected; a flat verified datum will be used."
    };
  }
  if (provider === "ea-lidar" || provider === "geotiff") {
    return acquireLidarElevation(options, provider);
  }
  if (provider !== "open-meteo") throw new UserError(`Unsupported elevation provider: ${provider}`);
  invariant(options.acceptOpenMeteoTerms,
    "Open-Meteo elevation requires --accept-open-meteo-terms. Commercial use requires an appropriate plan/API endpoint.");
  const apiKey = options.openMeteoApiKey || process.env.TPMAP_OPEN_METEO_API_KEY;
  if (options.commercial && !apiKey) {
    throw new UserError("Commercial Open-Meteo use requires --open-meteo-api-key (or choose --elevation none)");
  }

  const endpoint = options.openMeteoUrl || (options.commercial
    ? "https://customer-api.open-meteo.com/v1/elevation"
    : DEFAULT_OPEN_METEO);
  const spacingM = Math.max(30, options.elevationSpacing || 90);
  const projector = createProjector(bboxCenter(options.bbox));
  const [minX, maxZ] = projector.forward([options.bbox.west, options.bbox.south]);
  const [maxX, minZ] = projector.forward([options.bbox.east, options.bbox.north]);
  const columns = Math.max(2, Math.ceil((maxX - minX) / spacingM) + 1);
  const rows = Math.max(2, Math.ceil((maxZ - minZ) / spacingM) + 1);
  const coordinates = [];
  for (let row = 0; row < rows; row += 1) {
    const z = minZ + (row / (rows - 1)) * (maxZ - minZ);
    for (let column = 0; column < columns; column += 1) {
      const x = minX + (column / (columns - 1)) * (maxX - minX);
      const [lon, lat] = projector.inverse([x, z]);
      coordinates.push({ x, z, lat, lon });
    }
  }

  const key = `${endpoint}:${coordinates.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(";")}`;
  const { data, cacheHit } = await cachedJson({
    cacheDir: path.join(options.cacheDir, "elevation"),
    key,
    noCache: options.noCache,
    fetcher: async () => {
      const elevation = [];
      for (let i = 0; i < coordinates.length; i += 100) {
        const batch = coordinates.slice(i, i + 100);
        const url = new URL(endpoint);
        url.searchParams.set("latitude", batch.map((p) => p.lat.toFixed(6)).join(","));
        url.searchParams.set("longitude", batch.map((p) => p.lon.toFixed(6)).join(","));
        if (apiKey) url.searchParams.set("apikey", apiKey);
        const response = await fetchJson(url, { headers: { "User-Agent": options.userAgent } }, { retries: 2 });
        invariant(Array.isArray(response.elevation) && response.elevation.length === batch.length,
          "Open-Meteo returned an unexpected elevation response");
        elevation.push(...response.elevation);
      }
      return { elevation };
    }
  });

  return {
    provider: "Open-Meteo / Copernicus DEM GLO-90",
    endpoint,
    cacheHit,
    resolutionM: 90,
    requestedSpacingM: spacingM,
    rows,
    columns,
    bounds: { minX, minZ, maxX, maxZ },
    points: coordinates.map((point, index) => ({ ...point, elevation: Number(data.elevation[index]) })),
    attribution: "Elevation: Open-Meteo; Copernicus DEM GLO-90",
    license: "https://open-meteo.com/en/docs/elevation-api"
  };
}

function deriveBboxFromOverpass(data) {
  const values = [];
  for (const element of data?.elements || []) {
    if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) values.push([element.lat, element.lon]);
    for (const point of element.geometry || []) {
      if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) values.push([point.lat, point.lon]);
    }
    for (const member of element.members || []) {
      for (const point of member.geometry || []) {
        if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) values.push([point.lat, point.lon]);
      }
    }
  }
  invariant(values.length, "The supplied Overpass JSON contains no coordinates; add --bbox");
  const latitudes = values.map(([lat]) => lat);
  const longitudes = values.map(([, lon]) => lon);
  const padding = 0.0001;
  return {
    south: Math.min(...latitudes) - padding,
    north: Math.max(...latitudes) + padding,
    west: Math.min(...longitudes) - padding,
    east: Math.max(...longitudes) + padding
  };
}
