import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { cachedBinary, cachedJson, ensureDir, fetchBinary, fetchJson, sha256File } from "./io.mjs";
import { extractRasterPlanningPage } from "./planning-raster-extraction.mjs";
import {
  autoGeoreferencePlanningPage,
  corroborateAutomaticPlanningCollection
} from "./planning-auto-georeference.mjs";
import {
  applicationIdentity,
  classifyPlanningDocument,
  extractApplicationLinks,
  extractDocumentLinks,
  extractDocumentPageLinks,
  parsePlanningApplicationPage,
  scorePlanningApplication
} from "./planning-portal-html.mjs";
import { planningCollectionEntry } from "./planning-manifest.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_PLANIT = "https://www.planit.org.uk/api/applics/geojson";
const MAX_APPLICATIONS_HARD = 2_000;
const MAX_DOCUMENTS_HARD = 500;
const MAX_PAGES_HARD = 50;
const APPLICATION_CRAWL_CONCURRENCY = 4;
const DOCUMENT_PROCESS_CONCURRENCY = 3;
const PORTAL_REQUEST_TIMEOUT_MS = 30_000;
const DOCUMENT_REQUEST_TIMEOUT_MS = 120_000;
const PORTAL_RETRIES = 1;
const PORTAL_FAILURE_THRESHOLD = 2;

export async function acquireAutomaticPlanningEvidence(options, runtime) {
  const profile = options.parkProfile;
  const result = automaticResult(profile);
  if (!profile?.planningDiscovery) {
    result.status = "unsupported-profile";
    result.warnings.push(`Park profile ${profile?.id || "unknown"} has no automatic planning-discovery adapter.`);
    return result;
  }

  const limits = discoveryLimits(options);
  const planningRuntime = {
    ...runtime,
    planningPortalHealth: runtime.planningPortalHealth || new Map()
  };
  const discovery = await discoverPlanningApplications(profile, options, planningRuntime, limits);
  result.discovery = discovery.summary;
  result.failures.push(...discovery.failures);
  result.warnings.push(...discovery.warnings);
  emitProgress(planningRuntime,
    `Planning discovery: ${discovery.applications.length} relevant application(s) from ${discovery.summary.candidates} candidate(s)`);

  const applications = discovery.applications.slice(0, limits.applications);
  const documentQueue = [];
  for (let start = 0; start < applications.length && documentQueue.length < limits.documents;
    start += APPLICATION_CRAWL_CONCURRENCY) {
    const batch = applications.slice(start, start + APPLICATION_CRAWL_CONCURRENCY);
    const crawledBatch = await Promise.all(batch.map((application) =>
      crawlApplicationDocuments(application, profile, options, planningRuntime, limits)));
    for (const crawled of crawledBatch) {
      result.failures.push(...crawled.failures);
      result.warnings.push(...crawled.warnings);
      result.applications.push(crawled.application);
      for (const document of crawled.documents) {
        if (documentQueue.length >= limits.documents) break;
        documentQueue.push({ document, application: crawled.application });
      }
    }
    emitProgress(planningRuntime,
      `Planning crawl: ${Math.min(start + batch.length, applications.length)}/${applications.length} application(s), ${documentQueue.length}/${limits.documents} relevant document(s)`);
  }

  let processedCount = 0;
  const processedDocuments = await mapLimit(documentQueue, DOCUMENT_PROCESS_CONCURRENCY, async ({ document, application }) => {
    const processed = await processPlanningDocument(document, application, profile, options, planningRuntime, limits);
    processedCount += 1;
    emitProgress(planningRuntime,
      `Planning extraction: ${processedCount}/${documentQueue.length} document(s), ${processed.evidence.extraction.length} page result(s) in latest document`);
    return processed;
  });
  for (let index = 0; index < processedDocuments.length; index += 1) {
    const processed = processedDocuments[index];
    const { document, application } = documentQueue[index];
    result.documents.push(processed.evidence);
    result.failures.push(...processed.failures);
    result.warnings.push(...processed.warnings);
    if (processed.collection) {
      result.collections.push(await planningCollectionEntry(processed.collection, {
        id: `planning:auto:${profile.id}:${safeId(application.reference)}:${safeId(document.id)}`,
        sourceFile: processed.sourceFile,
        sourceUrl: document.url,
        authorityName: profile.planningAuthority.name,
        applicationReference: application.reference,
        applicationStatus: application.status || application.decision || "discovered",
        documentHash: processed.evidence.sha256,
        documentRole: document.role,
        capturedAt: application.decisionDate || null,
        reuseStatus: "public-register-processing-only"
      }));
    }
  }

  result.featureCount = result.collections.reduce(
    (sum, entry) => sum + (entry.collection?.features?.length || 0), 0
  );
  result.status = result.featureCount
    ? "planning-geometry-ready"
    : result.documents.length
      ? "documents-acquired-no-accepted-geometry"
      : result.applications.length
        ? "applications-found-no-documents"
        : "no-applications-found";
  if (!result.featureCount) {
    result.warnings.push(
      "Automatic discovery found no planning geometry that passed scale, location, semantic, decision and current-state corroboration gates."
    );
  }
  return result;
}

export async function discoverPlanningApplications(profile, options = {}, runtime = {}, suppliedLimits = null) {
  const limits = suppliedLimits || discoveryLimits(options);
  const failures = [], warnings = [];
  const candidates = [];
  try {
    candidates.push(...await discoverWithPlanIt(profile, options, runtime, limits));
  } catch (error) {
    failures.push(failure("planit", options.planitUrl || DEFAULT_PLANIT, error));
  }
  try {
    candidates.push(...await discoverWithOfficialPortal(profile, options, runtime));
  } catch (error) {
    failures.push(failure(profile.planningDiscovery.portalType, profile.planningDiscovery.searchUrl, error));
  }
  for (const url of profile.planningDiscovery.seedApplicationUrls || []) {
    candidates.push({ sourceUrl: url, discoveryProvider: "park-profile-official-seed", discoveryScore: 35 });
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const normalized = normalizeApplication(candidate);
    normalized.discoveryScore = scorePlanningApplication(normalized, profile);
    const keys = [
      applicationIdentity(normalized),
      normalized.sourceUrl ? applicationIdentity({ sourceUrl: normalized.sourceUrl }) : null
    ].filter(Boolean);
    const previous = keys.map((key) => deduped.get(key)).find(Boolean);
    const selected = previous
      ? {
          ...mergeApplication(
            normalized.discoveryScore > previous.discoveryScore ? normalized : previous,
            normalized.discoveryScore > previous.discoveryScore ? previous : normalized
          ),
          discoveryScore: Math.max(normalized.discoveryScore, previous.discoveryScore)
      }
      : normalized;
    if (previous) for (const [key, value] of deduped) if (value === previous) deduped.set(key, selected);
    for (const key of keys) deduped.set(key, selected);
  }
  const applications = [...new Set(deduped.values())]
    .filter((application) => application.discoveryScore >= 18 || application.discoveryProvider === "park-profile-official-seed")
    .sort((a, b) => b.discoveryScore - a.discoveryScore || String(a.reference).localeCompare(String(b.reference)))
    .slice(0, limits.applications);
  if (failures.length && applications.length) warnings.push("One or more discovery adapters failed; successful independent adapters were retained.");
  return {
    applications,
    failures,
    warnings,
    summary: {
      schemaVersion: 1,
      mode: "automatic-park-selection",
      parkId: profile.id,
      searchedAt: new Date().toISOString(),
      searchTerms: profile.planningAuthority.searchTerms,
      planitEndpoint: options.planitUrl || DEFAULT_PLANIT,
      officialPortal: profile.planningAuthority.officialPortal,
      officialSearchUrl: profile.planningDiscovery.searchUrl,
      portalType: profile.planningDiscovery.portalType,
      candidates: candidates.length,
      applications: applications.length,
      failures: failures.length
    }
  };
}

async function discoverWithPlanIt(profile, options, runtime, limits) {
  const endpoint = options.planitUrl || DEFAULT_PLANIT;
  const bbox = profile.bbox;
  const pageSize = Math.min(300, limits.applications);
  const applications = [];
  for (let page = 1; applications.length < limits.applications; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set("bbox", `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
    url.searchParams.set("pg_sz", String(pageSize));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "-start_date");
    url.searchParams.set("compress", "on");
    const data = runtime.fetchJson
      ? await runtime.fetchJson(url.toString(), { headers: requestHeaders(runtime.userAgent, "application/geo+json,application/json") })
      : (await cachedJson({
          cacheDir: path.join(runtime.cacheDir, "planning-discovery", "planit"),
          key: url.toString(),
          noCache: options.noCache,
          fetcher: () => fetchJson(url, { headers: requestHeaders(runtime.userAgent, "application/geo+json,application/json") })
        })).data;
    const features = data?.features || [];
    for (const feature of features) {
      const properties = feature.properties || {};
      const other = properties.other_fields || {};
      applications.push({
        ...properties,
        geometry: feature.geometry,
        reference: properties.reference || properties.altid || properties.uid || properties.name,
        address: properties.address || properties.location_text,
        proposal: properties.description,
        status: other.status || properties.status || properties.app_state,
        decision: other.decision || properties.decision || properties.app_state,
        decisionDate: properties.decided_date,
        sourceUrl: officialApplicationUrl(properties, profile),
        documentsUrl: allowedOfficialUrl(other.docs_url, profile),
        easting: other.easting ?? null,
        northing: other.northing ?? null,
        lat: other.lat ?? other.latitude ?? null,
        lon: other.lng ?? other.longitude ?? null,
        planitUrl: properties.link ? new URL(properties.link, "https://www.planit.org.uk").toString() : null,
        discoveryProvider: "PlanIt spatial index",
        locationConfidence: 0.94
      });
    }
    const total = Number(data?.total || features.length);
    if (!features.length || applications.length >= total || features.length < pageSize) break;
  }
  return applications;
}

async function discoverWithOfficialPortal(profile, options, runtime) {
  const adapter = profile.planningDiscovery;
  const applications = [];
  if (adapter.portalType !== "idox") return applications;
  for (const term of profile.planningAuthority.searchTerms || []) {
    const url = new URL(adapter.searchUrl);
    url.searchParams.set("searchType", "Application");
    url.searchParams.set("searchCriteria.simpleSearchString", term);
    const html = await fetchTextCached(url.toString(), options, runtime, "official-search");
    for (const link of extractApplicationLinks(html, url, adapter.allowedDocumentHosts || [])) {
      applications.push({ sourceUrl: link.url, description: link.text, discoveryProvider: "official-portal-search", discoveryScore: 45 });
    }
  }
  return applications;
}

async function crawlApplicationDocuments(applicationInput, profile, options, runtime, limits) {
  const failures = [], warnings = [];
  let application = { ...applicationInput };
  const documents = [];
  if (!application.sourceUrl) {
    warnings.push(`Application ${application.reference || "unknown"} has no official source URL and cannot supply authoritative drawings.`);
    return { application, documents, failures, warnings };
  }
  try {
    const html = await fetchTextCached(application.sourceUrl, options, runtime, "official-applications");
    application = mergeApplication(application, parsePlanningApplicationPage(html, application.sourceUrl));
    const allowed = profile.planningDiscovery.allowedDocumentHosts || [];
    documents.push(...extractDocumentLinks(html, application.sourceUrl, allowed));
    const documentPages = extractDocumentPageLinks(html, application.sourceUrl, allowed);
    if (application.documentsUrl) documentPages.push({ url: application.documentsUrl, text: "Official documents" });
    const syntheticIdox = idoxDocumentsUrl(application.sourceUrl);
    if (syntheticIdox) documentPages.push({ url: syntheticIdox, text: "Documents" });
    for (const pageLink of uniqueBy(documentPages, (item) => item.url).slice(0, 5)) {
      try {
        const documentHtml = await fetchTextCached(pageLink.url, options, runtime, "official-document-lists");
        documents.push(...extractDocumentLinks(documentHtml, pageLink.url, allowed));
      } catch (error) {
        failures.push(failure("official-document-list", pageLink.url, error, application.reference));
      }
    }
  } catch (error) {
    failures.push(failure("official-application", application.sourceUrl, error, application.reference));
  }
  const expanded = [];
  for (const candidate of uniqueBy(documents, (item) => item.url).slice(0, Math.min(limits.documents * 2, 200))) {
    if (!/(?:documentDetails\.do|DocDetails|DocumentDetails|StdDetails\.aspx)/i.test(candidate.url)) {
      expanded.push(candidate);
      continue;
    }
    try {
      const detailHtml = await fetchTextCached(candidate.url, options, runtime, "official-document-details");
      const nested = extractDocumentLinks(detailHtml, candidate.url, profile.planningDiscovery.allowedDocumentHosts || [])
        .filter((item) => item.url !== candidate.url);
      if (nested.length) expanded.push(...nested.map((item) => ({
        ...item,
        title: item.title === item.role ? candidate.title : item.title,
        role: item.role === "planning-document" ? candidate.role : item.role,
        score: Math.max(item.score, candidate.score)
      })));
      else expanded.push(candidate);
    } catch (error) {
      failures.push(failure("official-document-detail", candidate.url, error, application.reference));
      expanded.push(candidate);
    }
  }
  const ranked = uniqueBy(expanded, (item) => item.url)
    .filter((document) => document.relevant)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, Math.min(limits.documents, 80))
    .map((document, index) => ({
      ...document,
      id: `${safeId(application.reference)}-${index + 1}-${safeId(document.title || document.role)}`,
      url: document.url
    }));
  return { application, documents: ranked, failures, warnings };
}

async function processPlanningDocument(document, application, profile, options, runtime, limits) {
  const failures = [], warnings = [];
  let sourceFile = null, sourceHash = null, sizeBytes = null, sourceMime = null;
  const evidence = {
    id: document.id,
    applicationReference: application.reference || "unknown",
    applicationStatus: application.status || application.decision || "discovered",
    role: document.role,
    title: document.title,
    sourceUrl: document.url,
    officialPortal: profile.planningAuthority.officialPortal,
    authority: profile.planningAuthority.name,
    reuseStatus: "public-register-processing-only",
    acquired: false,
    worldEligible: false,
    worldEligibilityBasis: null,
    extraction: []
  };
  try {
    const extension = documentExtension(document.url);
    const cached = await cachedBinary({
      cacheDir: path.join(runtime.cacheDir, "planning-documents", profile.id),
      key: document.url,
      noCache: options.noCache,
      extension,
      fetcher: () => runtime.fetchBinary
        ? runtime.fetchBinary(document.url, { headers: requestHeaders(runtime.userAgent, "application/pdf,image/*,*/*") })
        : fetchPortalBinary(document.url, runtime, "application/pdf,image/*,*/*")
    });
    sourceFile = cached.filename;
    const bytes = await readFile(sourceFile);
    sizeBytes = bytes.length;
    if (sizeBytes > Number(options.maxPlanningDocumentMb || 250) * 1024 * 1024) throw new Error("document exceeds max-planning-document-mb");
    if (!supportedDocument(bytes)) throw new Error("official document response is not a supported PDF or image");
    sourceMime = detectDocumentMime(bytes, sourceFile);
    sourceHash = await sha256File(sourceFile);
    evidence.acquired = true;
    evidence.sha256 = sourceHash;
    evidence.sizeBytes = sizeBytes;
    evidence.cacheHit = cached.cacheHit;
  } catch (error) {
    if (sourceFile) await rm(sourceFile, { force: true }).catch(() => {});
    failures.push(failure("official-document", document.url, error, application.reference));
    return { evidence, collection: null, sourceFile, failures, warnings };
  }

  const pageCount = await documentPageCount(sourceFile, sourceMime);
  const features = [];
  for (let page = 1; page <= Math.min(pageCount, limits.pages); page += 1) {
    try {
      const extracted = await extractRasterPlanningPage({
        filename: sourceFile,
        page,
        workDirectory: path.join(runtime.cacheDir, "planning-extraction", profile.id, sourceHash.slice(0, 16)),
        document: { id: document.id, sha256: sourceHash, mime: sourceMime }
      });
      const georeferenced = autoGeoreferencePlanningPage({
        svg: extracted.svg,
        semantic: extracted.semantic,
        application,
        document: { ...document, dpi: 300 },
        profile,
        page,
        minimumConfidence: Number(options.planningGeorefMinConfidence || 0.72)
      });
      evidence.extraction.push(compactExtraction(georeferenced));
      features.push(...georeferenced.collection.features);
    } catch (error) {
      failures.push(failure("planning-page-extraction", `${document.url}#page=${page}`, error, application.reference));
    }
  }

  const collection = { type: "FeatureCollection", features };
  const eligibility = corroborateAutomaticPlanningCollection(collection, {
    ...application,
    proposal: `${application.proposal || ""} ${document.title || ""} ${document.role || ""}`
  }, runtime);
  evidence.worldEligible = eligibility.worldEligible && features.length > 0;
  evidence.worldEligibilityBasis = eligibility.basis;
  evidence.currentStateCorroboration = eligibility;
  evidence.derivedCollectionsDeclared = features.length ? 1 : 0;
  evidence.derivedCollectionsAccepted = evidence.worldEligible ? 1 : 0;
  if (features.length && !evidence.worldEligible) warnings.push(
    `${application.reference || "unknown"} ${document.title}: extracted geometry stayed evidence-only because current-state corroboration did not pass.`
  );
  return { evidence, collection: evidence.worldEligible ? collection : null, sourceFile, failures, warnings };
}

function automaticResult(profile) {
  return {
    schemaVersion: 1,
    automatic: true,
    parkId: profile?.id || null,
    status: "discovering",
    manifests: [],
    applications: [],
    documents: [],
    collections: [],
    featureCount: 0,
    discovery: null,
    warnings: [],
    failures: []
  };
}

function discoveryLimits(options) {
  return {
    applications: boundedInteger(options.maxPlanningApplications, 250, 1, MAX_APPLICATIONS_HARD),
    documents: boundedInteger(options.maxPlanningDocuments, 160, 1, MAX_DOCUMENTS_HARD),
    pages: boundedInteger(options.maxPlanningPagesPerDocument, 20, 1, MAX_PAGES_HARD)
  };
}

async function fetchTextCached(url, options, runtime, bucket) {
  assertPortalAvailable(url, runtime);
  try {
    if (runtime.fetchText) {
      const value = await runtime.fetchText(url, { headers: requestHeaders(runtime.userAgent, "text/html,application/xhtml+xml") });
      recordPortalSuccess(url, runtime);
      return value;
    }
    const cached = await cachedBinary({
      cacheDir: path.join(runtime.cacheDir, "planning-discovery", bucket),
      key: url,
      noCache: options.noCache,
      extension: ".html",
      fetcher: () => fetchBinary(url, {
        headers: requestHeaders(runtime.userAgent, "text/html,application/xhtml+xml")
      }, { timeoutMs: PORTAL_REQUEST_TIMEOUT_MS, retries: PORTAL_RETRIES })
    });
    recordPortalSuccess(url, runtime);
    return readFile(cached.filename, "utf8");
  } catch (error) {
    recordPortalFailure(url, runtime, error);
    throw error;
  }
}

function officialApplicationUrl(properties, profile) {
  for (const key of ["url", "application_url", "comment_url", "external_url", "web_url", "source_url"]) {
    const value = properties?.[key];
    const allowed = allowedOfficialUrl(value, profile);
    if (allowed && !/planit\.org\.uk/i.test(allowed)) return allowed;
  }
  const other = properties?.other_fields || {};
  for (const [key, value] of Object.entries(other)) {
    const allowed = /url|link/i.test(key) ? allowedOfficialUrl(value, profile) : null;
    if (allowed && !/planit\.org\.uk/i.test(allowed)) return allowed;
  }
  return null;
}

function allowedOfficialUrl(value, profile) {
  try {
    const url = new URL(String(value || ""));
    const allowedHosts = new Set((profile?.planningDiscovery?.allowedDocumentHosts || [])
      .map((host) => String(host).toLowerCase()));
    return /^https?:$/.test(url.protocol) && allowedHosts.has(url.hostname.toLowerCase())
      ? url.toString()
      : null;
  } catch { return null; }
}

async function fetchPortalBinary(url, runtime, accept) {
  assertPortalAvailable(url, runtime);
  try {
    const bytes = await fetchBinary(url, {
      headers: requestHeaders(runtime.userAgent, accept)
    }, { timeoutMs: DOCUMENT_REQUEST_TIMEOUT_MS, retries: PORTAL_RETRIES });
    recordPortalSuccess(url, runtime);
    return bytes;
  } catch (error) {
    recordPortalFailure(url, runtime, error);
    throw error;
  }
}

function assertPortalAvailable(url, runtime) {
  const state = portalState(url, runtime);
  if (state?.open) throw new Error(
    `official planning portal circuit open after ${state.failures} outage response(s): ${new URL(url).hostname}`
  );
}

function recordPortalSuccess(url, runtime) {
  const health = runtime.planningPortalHealth;
  if (!health) return;
  const host = new URL(url).hostname.toLowerCase();
  health.set(host, { failures: 0, open: false });
}

function recordPortalFailure(url, runtime, error) {
  if (!isPortalOutage(error) || !runtime.planningPortalHealth) return;
  const host = new URL(url).hostname.toLowerCase();
  const previous = runtime.planningPortalHealth.get(host) || { failures: 0, open: false };
  const failures = previous.failures + 1;
  runtime.planningPortalHealth.set(host, {
    failures,
    open: failures >= PORTAL_FAILURE_THRESHOLD,
    lastError: error?.message || String(error)
  });
}

function portalState(url, runtime) {
  try { return runtime.planningPortalHealth?.get(new URL(url).hostname.toLowerCase()) || null; }
  catch { return null; }
}

function isPortalOutage(error) {
  return /HTTP (?:408|425|429|5\d\d)|aborted|abort|timeout|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i
    .test(error?.message || String(error));
}

function emitProgress(runtime, message) {
  if (typeof runtime.progress === "function") runtime.progress(message);
}

function normalizeApplication(application) {
  return {
    ...application,
    reference: application.reference || application.altid || application.uid || null,
    address: application.address || application.location || null,
    proposal: application.proposal || application.description || null,
    sourceUrl: application.sourceUrl || application.url || null
  };
}

function mergeApplication(existing, parsed) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(parsed || {})) if ((merged[key] === undefined || merged[key] === null || merged[key] === "") && value) merged[key] = value;
  return merged;
}

function idoxDocumentsUrl(value) {
  if (!/applicationDetails\.do/i.test(value)) return null;
  const url = new URL(value);
  url.searchParams.set("activeTab", "documents");
  return url.toString();
}

async function documentPageCount(filename, mime) {
  if (mime !== "application/pdf") return 1;
  try {
    const { stdout } = await execFileAsync("pdfinfo", [filename], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
    const pages = Number(stdout.match(/^Pages:\s+(\d+)/mi)?.[1]);
    return Number.isInteger(pages) && pages > 0 ? pages : 1;
  } catch { return 1; }
}

function compactExtraction(value) {
  return {
    status: value.status,
    page: value.page || null,
    confidence: value.confidence,
    scale: value.scale,
    location: value.location,
    origin: value.origin,
    shapes: value.shapes,
    associatedShapes: value.associatedShapes,
    acceptedFeatures: value.collection?.features?.length || 0
  };
}

function supportedDocument(bytes) {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return true;
  const hex = bytes.subarray(0, 12).toString("hex");
  return /^(?:89504e47|ffd8ff|49492a00|4d4d002a)/i.test(hex);
}

function detectDocumentMime(bytes, filename) {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  const hex = bytes.subarray(0, 12).toString("hex").toLowerCase();
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("49492a00") || hex.startsWith("4d4d002a")) return "image/tiff";
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.tiff?$/i.test(filename)) return "image/tiff";
  return "application/octet-stream";
}

function documentExtension(value) {
  let extension = "";
  try { extension = path.extname(new URL(value).pathname).toLowerCase(); } catch { extension = path.extname(String(value)).toLowerCase(); }
  return /^\.(?:pdf|png|jpe?g|tiff?)$/.test(extension) ? extension : ".pdf";
}

function requestHeaders(userAgent, accept) {
  return { "User-Agent": userAgent || "VoxelMappingTool/0.2.0", Accept: accept, "Accept-Language": "en-GB,en;q=0.8" };
}

function failure(adapter, url, error, reference = null) {
  return { adapter, url, applicationReference: reference, error: error?.message || String(error) };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = value === undefined ? fallback : Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function uniqueBy(values, key) {
  const seen = new Set();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function mapLimit(values, concurrency, worker) {
  const results = new Array(values.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

function safeId(value) {
  return String(value || "unknown").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80);
}
