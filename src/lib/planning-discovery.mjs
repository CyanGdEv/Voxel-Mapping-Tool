import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, rm } from "node:fs/promises";
import { cachedBinary, cachedJson, ensureDir, fetchBinary, fetchJson, readJson, sha256, sha256File, writeJson } from "./io.mjs";
import { extractRasterPlanningPage } from "./planning-raster-extraction.mjs";
import { extractNativeDxfPlanning, looksLikeAsciiDxf } from "./planning-native-vector.mjs";
import { extractNativePlanningArchive } from "./planning-native-archive.mjs";
import {
  autoGeoreferencePlanningPage,
  corroborateAutomaticPlanningCollection,
  prepareAutomaticPlanningCorroboration
} from "./planning-auto-georeference.mjs";
import {
  applicationIdentity,
  classifyPlanningDocument,
  extractApplicationLinks,
  extractDocumentLinks,
  extractDocumentPageLinks,
  parsePlanningApplicationPage,
  classifyPlanningApplication
} from "./planning-portal-html.mjs";
import { planningCollectionEntry } from "./planning-manifest.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_PLANIT = "https://www.planit.org.uk/api/applics/geojson";
const MAX_APPLICATIONS_HARD = 2_000;
const MAX_DOCUMENTS_HARD = 500;
const MAX_PAGES_HARD = 50;
const MAX_PLANIT_CANDIDATE_SCAN = 600;
const APPLICATION_CRAWL_CONCURRENCY = 4;
const DOCUMENT_PROCESS_CONCURRENCY = 4;
export const PREPARED_SHARD_MARKER = "TPMAP_PREPARED_PLANNING_SHARD_V2";
export const PREPARED_MERGED_MARKER = "TPMAP_PREPARED_PLANNING_MERGED_V1";
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

  const planningRuntime = {
    ...runtime,
    planningPortalHealth: runtime.planningPortalHealth || new Map()
  };
  const plan = options.planningPlan
    ? await readJson(path.resolve(options.planningPlan))
    : await createAutomaticPlanningPlan(options, planningRuntime);
  return processAutomaticPlanningPlan(plan, options, planningRuntime);
}

export async function createAutomaticPlanningPlan(options, runtime) {
  const profile = options.parkProfile;
  if (!profile?.planningDiscovery) throw new Error("Automatic planning plan requires a supported park profile");
  const limits = discoveryLimits(options);
  const planningRuntime = { ...runtime, planningPortalHealth: runtime.planningPortalHealth || new Map() };
  const discovery = await discoverPlanningApplications(profile, options, planningRuntime, limits);
  emitProgress(planningRuntime,
    `Planning discovery: ${discovery.applications.length}/${discovery.summary.relevantApplications} relevant application(s) selected from ${discovery.summary.candidates} candidate(s); ${discovery.summary.rejectedApplications} rejected before portal crawl`);
  const applications = discovery.applications.slice(0, limits.applications);
  const documentQueue = [];
  const failures = [...discovery.failures], warnings = [...discovery.warnings], crawledApplications = [];
  for (let start = 0; start < applications.length && documentQueue.length < limits.documents;
    start += APPLICATION_CRAWL_CONCURRENCY) {
    const batch = applications.slice(start, start + APPLICATION_CRAWL_CONCURRENCY);
    const crawledBatch = await Promise.all(batch.map((application) =>
      crawlApplicationDocuments(application, profile, options, planningRuntime, limits)));
    for (const crawled of crawledBatch) {
      failures.push(...crawled.failures);
      warnings.push(...crawled.warnings);
      crawledApplications.push(crawled.application);
      for (const document of crawled.documents) {
        if (documentQueue.length >= limits.documents) break;
        documentQueue.push({ document, application: crawled.application });
      }
    }
    emitProgress(planningRuntime,
      `Planning crawl: ${Math.min(start + batch.length, applications.length)}/${applications.length} application(s), ${documentQueue.length}/${limits.documents} relevant document(s)`);
  }

  return {
    schemaVersion: 1,
    marker: "TPMAP_AUTOMATIC_PLANNING_PLAN_V1",
    parkId: profile.id,
    createdAt: new Date().toISOString(),
    discovery: discovery.summary,
    applications: crawledApplications,
    documentQueue,
    failures,
    warnings
  };
}

export async function prepareAutomaticPlanningShard(plan, options, runtime) {
  validateAutomaticPlanningPlan(plan, options.parkProfile);
  const shardCount = Number(options.planningShardCount ?? 1);
  const shardIndex = Number(options.planningShardIndex ?? 0);
  const queue = selectPlanningShard(plan.documentQueue, shardIndex, shardCount);
  const limits = discoveryLimits(options);
  let processed = 0, acquired = 0, rawDocumentCacheHits = 0, pageResults = 0;
  const failures = [];
  const entries = await mapLimit(queue, DOCUMENT_PROCESS_CONCURRENCY, async ({ document, application }) => {
    let value = await processPlanningDocument(document, application, options.parkProfile, options, runtime, limits, true);
    if (!value.evidence.acquired) {
      value = await processPlanningDocument(document, application, options.parkProfile, options, runtime, limits, true);
      value.evidence.preparationRetries = (value.evidence.preparationRetries || 0) + 1;
    }
    processed += 1;
    if (value.evidence.acquired) acquired += 1;
    if (value.evidence.cacheHit) rawDocumentCacheHits += 1;
    pageResults += value.evidence.extraction.length;
    failures.push(...value.failures);
    emitProgress(runtime, `Planning shard ${shardIndex + 1}/${shardCount}: ${processed}/${queue.length} document(s)`);
    return {
      identity: planningDocumentIdentity({ document, application }),
      evidence: value.evidence,
      candidateCollection: value.candidateCollection,
      corroboration: prepareAutomaticPlanningCorroboration(planningCorroborationInput(application, document)),
      failures: value.failures,
      warnings: value.warnings
    };
  });
  const bundle = {
    schemaVersion: 2,
    marker: PREPARED_SHARD_MARKER,
    parkId: plan.parkId,
    planSha256: sha256(plan),
    shardIndex,
    shardCount,
    assignedDocumentIdentities: queue.map(planningDocumentIdentity),
    entries
  };
  const output = options.out ? await writeJson(path.resolve(options.out), bundle, 0) : null;
  return {
    schemaVersion: 1, parkId: plan.parkId, shardIndex, shardCount,
    assigned: queue.length, processed, acquired, rawDocumentCacheHits, pageResults, failures, output
  };
}

async function processAutomaticPlanningPlan(plan, options, planningRuntime) {
  const profile = options.parkProfile;
  validateAutomaticPlanningPlan(plan, profile);
  const limits = discoveryLimits(options);
  const result = automaticResult(profile);
  result.discovery = plan.discovery;
  result.failures.push(...(plan.failures || []));
  result.warnings.push(...(plan.warnings || []));
  result.applications.push(...plan.applications);
  const documentQueue = plan.documentQueue.slice(0, limits.documents);

  let processedDocuments = null;
  if (options.preparedPlanningDirectory) {
    try {
      processedDocuments = await loadPreparedPlanningDocuments(
        path.resolve(options.preparedPlanningDirectory), plan, documentQueue, options, planningRuntime
      );
      result.preparedHandoff = processedDocuments.handoffDiagnostics;
      emitProgress(planningRuntime,
        `Planning extraction: reused ${processedDocuments.length}/${documentQueue.length} prepared document result(s)`);
    } catch (error) {
      if (!options.allowPreparedPlanningFallback) {
        throw new Error(`Prepared planning handoff failed closed: ${error.message}`);
      }
      result.warnings.push(`Prepared planning handoff was not reusable (${error.message}); explicit fallback enabled.`);
    }
  }
  if (!processedDocuments) {
    let processedCount = 0;
    processedDocuments = await mapLimit(documentQueue, DOCUMENT_PROCESS_CONCURRENCY, async ({ document, application }) => {
      const processed = await processPlanningDocument(document, application, profile, options, planningRuntime, limits);
      processedCount += 1;
      emitProgress(planningRuntime,
        `Planning extraction: ${processedCount}/${documentQueue.length} document(s), ${processed.evidence.extraction.length} page result(s) in latest document`);
      return processed;
    });
  }
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

export async function mergePreparedPlanningShards({ directory, plan, profile, output }) {
  const filenames = (await readdir(path.resolve(directory), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(path.resolve(directory), entry.name))
    .sort();
  if (!filenames.length) throw new Error("no prepared shard bundles were found");
  const bundles = (await Promise.all(filenames.map(readJson)))
    .filter((bundle) => bundle?.marker === PREPARED_SHARD_MARKER);
  const merged = mergePreparedPlanningShardBundles(bundles, plan, profile);
  const outputPath = output ? await writeJson(path.resolve(output), merged, 0) : null;
  return {
    schemaVersion: 1,
    parkId: merged.parkId,
    shardCount: merged.shardCount,
    documents: merged.entries.length,
    entriesSha256: merged.entriesSha256,
    output: outputPath,
    bundle: merged
  };
}

export function mergePreparedPlanningShardBundles(bundles, plan, profile = null) {
  validateAutomaticPlanningPlan(plan, profile || { id: plan?.parkId });
  if (!Array.isArray(bundles) || !bundles.length) throw new Error("no prepared shard bundles were found");
  const expectedPlanHash = sha256(plan);
  const shardCount = bundles[0]?.shardCount;
  if (!Number.isInteger(shardCount) || shardCount < 1 || bundles.length !== shardCount) {
    throw new Error(`expected ${shardCount || "all"} shard bundles but found ${bundles.length}`);
  }
  const shardIndexes = new Set();
  const byIdentity = new Map();
  const queueByIdentity = new Map(plan.documentQueue.map((item) => [planningDocumentIdentity(item), item]));
  for (const bundle of bundles) {
    if (bundle?.schemaVersion !== 2 || bundle?.marker !== PREPARED_SHARD_MARKER ||
      bundle.parkId !== plan.parkId || bundle.planSha256 !== expectedPlanHash || bundle.shardCount !== shardCount) {
      throw new Error("prepared shard metadata does not match the frozen planning plan");
    }
    if (!Number.isInteger(bundle.shardIndex) || bundle.shardIndex < 0 || bundle.shardIndex >= shardCount ||
      shardIndexes.has(bundle.shardIndex) || !Array.isArray(bundle.entries)) {
      throw new Error("prepared shard indexes or entries are invalid");
    }
    const assigned = selectPlanningShard(plan.documentQueue, bundle.shardIndex, shardCount)
      .map(planningDocumentIdentity);
    if (sha256(bundle.assignedDocumentIdentities || []) !== sha256(assigned)) {
      throw new Error(`prepared shard ${bundle.shardIndex} assignment does not match the frozen plan`);
    }
    if (sha256(bundle.entries.map((entry) => entry?.identity)) !== sha256(assigned)) {
      throw new Error(`prepared shard ${bundle.shardIndex} entries do not match its frozen assignment`);
    }
    shardIndexes.add(bundle.shardIndex);
    for (const entry of bundle.entries) {
      if (!entry?.identity || byIdentity.has(entry.identity) || !queueByIdentity.has(entry.identity)) {
        throw new Error("prepared document identity is missing, duplicated, or outside the plan");
      }
      validatePreparedCorroboration(entry, queueByIdentity.get(entry.identity));
      byIdentity.set(entry.identity, entry);
    }
  }
  const expectedIdentities = plan.documentQueue.map(planningDocumentIdentity);
  if (byIdentity.size !== expectedIdentities.length || expectedIdentities.some((identity) => !byIdentity.has(identity))) {
    throw new Error(`prepared coverage ${byIdentity.size}/${expectedIdentities.length} does not exactly match the plan`);
  }
  const entries = expectedIdentities.map((identity) => byIdentity.get(identity));
  return {
    schemaVersion: 1,
    marker: PREPARED_MERGED_MARKER,
    parkId: plan.parkId,
    planSha256: expectedPlanHash,
    shardCount,
    documentCount: entries.length,
    entriesSha256: sha256(entries),
    entries
  };
}

export async function loadPreparedPlanningDocuments(directory, plan, documentQueue, options, runtime) {
  const filenames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  if (!filenames.length) throw new Error("no prepared planning bundle was found");
  const files = await Promise.all(filenames.map(readJson));
  const mergedFiles = files.filter((bundle) => bundle?.marker === PREPARED_MERGED_MARKER);
  if (mergedFiles.length > 1) throw new Error("multiple merged planning bundles were found");
  const merged = mergedFiles[0] || mergePreparedPlanningShardBundles(
    files.filter((bundle) => bundle?.marker === PREPARED_SHARD_MARKER), plan, options.parkProfile
  );
  validateMergedPlanningBundle(merged, plan, documentQueue);
  const byIdentity = new Map(merged.entries.map((entry) => [entry.identity, entry]));

  const startedAt = Date.now();
  const progressEvery = Math.max(1, Math.ceil(documentQueue.length / 20));
  let completed = 0;
  const processedDocuments = [];
  for (const { document, application } of documentQueue) {
    const entry = byIdentity.get(planningDocumentIdentity({ document, application }));
    validatePreparedCorroboration(entry, { document, application });
    const processed = finalizePlanningDocument({
      evidence: {
        ...entry.evidence,
        preparedShardHit: true,
        preparedHandoffMode: "zero-rework"
      },
      candidateCollection: entry.candidateCollection,
      sourceFile: null,
      failures: [...(entry.failures || [])],
      warnings: [...(entry.warnings || [])]
    }, application, document, runtime, entry.corroboration);
    completed += 1;
    if (completed === documentQueue.length || completed % progressEvery === 0) {
      emitProgress(runtime, `Planning prepared merge: ${completed}/${documentQueue.length} document(s), zero extraction retries`);
    }
    processedDocuments.push(processed);
  }
  const handoffDiagnostics = {
    mode: "zero-rework",
    documents: completed,
    durationMs: Date.now() - startedAt,
    downloads: 0,
    extractionRetries: 0,
    planSha256: merged.planSha256,
    entriesSha256: merged.entriesSha256
  };
  Object.defineProperty(processedDocuments, "handoffDiagnostics", {
    enumerable: false,
    value: handoffDiagnostics
  });
  emitProgress(runtime,
    `Planning prepared merge complete: ${completed} document(s) in ${handoffDiagnostics.durationMs} ms; 0 downloads; 0 extraction retries`);
  return processedDocuments;
}

function validateMergedPlanningBundle(bundle, plan, documentQueue) {
  if (bundle?.schemaVersion !== 1 || bundle?.marker !== PREPARED_MERGED_MARKER ||
    bundle.parkId !== plan.parkId || bundle.planSha256 !== sha256(plan) ||
    bundle.documentCount !== bundle.entries?.length || bundle.entriesSha256 !== sha256(bundle.entries || [])) {
    throw new Error("merged planning bundle failed its integrity contract");
  }
  const expected = documentQueue.map(planningDocumentIdentity);
  const actual = bundle.entries.map((entry) => entry.identity);
  if (sha256(actual) !== sha256(expected)) throw new Error("merged planning bundle order or coverage does not match the plan");
}

function validatePreparedCorroboration(entry, { document, application }) {
  const expected = prepareAutomaticPlanningCorroboration(planningCorroborationInput(application, document));
  if (sha256(entry.corroboration) !== sha256(expected)) {
    throw new Error(`prepared corroboration does not match document ${document?.id || entry.identity}`);
  }
}

export function selectPlanningShard(documentQueue, shardIndex, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1 || !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error("Invalid planning shard selection");
  }
  return documentQueue.filter((_, index) => index % shardCount === shardIndex);
}

function validateAutomaticPlanningPlan(plan, profile) {
  if (plan?.schemaVersion !== 1 || plan?.marker !== "TPMAP_AUTOMATIC_PLANNING_PLAN_V1") throw new Error("Unsupported automatic planning plan");
  if (plan.parkId !== profile?.id) throw new Error(`Planning plan park mismatch: ${plan.parkId || "unknown"}`);
  if (!Array.isArray(plan.applications) || !Array.isArray(plan.documentQueue)) throw new Error("Automatic planning plan arrays are missing");
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
  const priorityUrls = (profile.planningDiscovery.priorityApplicationUrls || []).map(canonicalUrl);
  for (const url of profile.planningDiscovery.seedApplicationUrls || []) {
    const priorityIndex = priorityUrls.indexOf(canonicalUrl(url));
    candidates.push({
      sourceUrl: url,
      discoveryProvider: "park-profile-official-seed",
      discoveryScore: priorityIndex >= 0 ? 10_000 - priorityIndex * 100 : 35
    });
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const normalized = normalizeApplication(candidate);
    const triage = classifyPlanningApplication(normalized, profile);
    normalized.discoveryScore = triage.score;
    normalized.discoveryRelevant = triage.relevant;
    normalized.discoverySiteMatch = triage.siteMatch;
    normalized.discoveryCategories = triage.categories;
    normalized.discoveryExcludedReason = triage.excludedReason;
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
  const minimumApplicationScore = Number(profile.planningDiscovery.minimumApplicationScore ?? 180);
  const uniqueApplications = [...new Set(deduped.values())];
  const relevantApplications = uniqueApplications
    .filter((application) => (application.discoveryRelevant && application.discoveryScore >= minimumApplicationScore) || application.discoveryProvider === "park-profile-official-seed")
    .sort((a, b) => b.discoveryScore - a.discoveryScore || String(a.reference).localeCompare(String(b.reference)))
  const applications = relevantApplications.slice(0, limits.applications);
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
      triagedApplications: uniqueApplications.length,
      relevantApplications: relevantApplications.length,
      rejectedApplications: uniqueApplications.length - relevantApplications.length,
      deferredApplications: relevantApplications.length - applications.length,
      applications: applications.length,
      minimumApplicationScore,
      failures: failures.length
    }
  };
}

async function discoverWithPlanIt(profile, options, runtime, limits) {
  const endpoint = options.planitUrl || DEFAULT_PLANIT;
  const bbox = profile.bbox;
  const candidateLimit = Math.min(MAX_PLANIT_CANDIDATE_SCAN, Math.max(300, limits.applications * 2));
  const pageSize = Math.min(300, candidateLimit);
  const applications = [];
  for (let page = 1; applications.length < candidateLimit; page += 1) {
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
      if (applications.length >= candidateLimit) break;
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

async function processPlanningDocument(document, application, profile, options, runtime, limits, deferEligibility = false) {
  const failures = [], warnings = [];
  let sourceFile = null, sourceHash = null, sizeBytes = null, sourceMime = null, sourceBytes = null;
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
    sourceBytes = await readFile(sourceFile);
    sizeBytes = sourceBytes.length;
    if (sizeBytes > Number(options.maxPlanningDocumentMb || 250) * 1024 * 1024) throw new Error("document exceeds max-planning-document-mb");
    sourceMime = detectDocumentMime(sourceBytes, sourceFile);
    if (!supportedDocument(sourceBytes, sourceMime)) throw new Error("official document response is not a supported planning document");
    sourceHash = await sha256File(sourceFile);
    evidence.acquired = true;
    evidence.sha256 = sourceHash;
    evidence.sizeBytes = sizeBytes;
    evidence.cacheHit = cached.cacheHit;
  } catch (error) {
    if (sourceFile) await rm(sourceFile, { force: true }).catch(() => {});
    failures.push(failure("official-document", document.url, error, application.reference));
    return { evidence, collection: null, candidateCollection: null, sourceFile, failures, warnings };
  }

  const directNative = sourceMime === "application/dxf" || sourceMime === "application/ifc";
  if (!directNative && sourceMime !== "application/zip") sourceBytes = null;
  const features = [];
  if (directNative) {
    try {
      const georeferenced = extractNativeDxfPlanning({
        bytes: sourceBytes,
        application,
        document,
        profile,
        minimumConfidence: Number(options.planningGeorefMinConfidence || 0.72)
      });
      evidence.extraction.push(compactExtraction(georeferenced));
      features.push(...georeferenced.collection.features);
    } catch (error) {
      failures.push(failure("planning-native-dxf-extraction", document.url, error, application.reference));
    }
  } else if (sourceMime === "application/zip") {
    try {
      const { value: extracted, retries } = await retryPlanningOperation(() =>
        extractNativePlanningArchive({
          bytes: sourceBytes,
          application,
          document,
          profile,
          minimumConfidence: Number(options.planningGeorefMinConfidence || 0.72)
        }));
      recordPreparationRetries(evidence, retries);
      evidence.extraction.push(compactExtraction(extracted));
      evidence.archive = extracted.archive;
      features.push(...extracted.collection.features);
    } catch (error) {
      recordPreparationRetries(evidence, error.planningRetryCount || 0);
      failures.push(failure("planning-native-archive-extraction", document.url, error, application.reference));
    }
  } else if (isRasterPlanningDocument(sourceMime)) {
    const pageCount = await documentPageCount(sourceFile, sourceMime);
    for (let page = 1; page <= Math.min(pageCount, limits.pages); page += 1) {
      try {
        const { value: georeferenced, retries } = await retryPlanningOperation(async () => {
          const extracted = await extractRasterPlanningPage({
            filename: sourceFile,
            page,
            workDirectory: path.join(runtime.cacheDir, "planning-extraction", profile.id, sourceHash.slice(0, 16)),
            document: { id: document.id, sha256: sourceHash, mime: sourceMime }
          });
          return autoGeoreferencePlanningPage({
            svg: extracted.svg,
            semantic: extracted.semantic,
            application,
            document: { ...document, dpi: 300 },
            profile,
            page,
            minimumConfidence: Number(options.planningGeorefMinConfidence || 0.72)
          });
        });
        recordPreparationRetries(evidence, retries);
        evidence.extraction.push(compactExtraction(georeferenced));
        features.push(...georeferenced.collection.features);
      } catch (error) {
        recordPreparationRetries(evidence, error.planningRetryCount || 0);
        failures.push(failure("planning-page-extraction", `${document.url}#page=${page}`, error, application.reference));
      }
    }
  } else {
    evidence.extraction.push({
      status: "native-planning-format-inventoried",
      page: null,
      confidence: 0,
      nativeFormat: sourceMime,
      acceptedFeatures: 0
    });
    warnings.push(`${document.title || document.id}: ${sourceMime} was preserved in the evidence cache but needs an external converter before geometry can be promoted.`);
  }

  const collection = { type: "FeatureCollection", features };
  evidence.derivedCollectionsDeclared = features.length ? 1 : 0;
  const processed = { evidence, collection: null, candidateCollection: collection, sourceFile, failures, warnings };
  return deferEligibility ? processed : finalizePlanningDocument(processed, application, document, runtime);
}

export async function retryPlanningOperation(operation) {
  try {
    return { value: await operation(), retries: 0 };
  } catch (firstError) {
    try {
      return { value: await operation(), retries: 1 };
    } catch (error) {
      const finalError = error instanceof Error ? error : new Error(String(error));
      finalError.planningRetryCount = 1;
      finalError.firstAttemptMessage = firstError?.message || String(firstError);
      throw finalError;
    }
  }
}

function recordPreparationRetries(evidence, retries) {
  if (!retries) return;
  evidence.preparationRetries = (evidence.preparationRetries || 0) + retries;
}

function finalizePlanningDocument(processed, application, document, runtime, preparedCorroboration = null) {
  const { evidence, candidateCollection, warnings } = processed;
  if (!candidateCollection) return processed;
  const features = candidateCollection.features || [];
  const input = planningCorroborationInput(application, document);
  const eligibility = corroborateAutomaticPlanningCollection(
    candidateCollection, input, runtime, preparedCorroboration
  );
  evidence.worldEligible = eligibility.worldEligible && features.length > 0;
  evidence.worldEligibilityBasis = eligibility.basis;
  evidence.currentStateCorroboration = eligibility;
  evidence.derivedCollectionsAccepted = evidence.worldEligible ? 1 : 0;
  if (features.length && !evidence.worldEligible) warnings.push(
    `${application.reference || "unknown"} ${document.title}: extracted geometry stayed evidence-only because current-state corroboration did not pass.`
  );
  return { ...processed, collection: evidence.worldEligible ? candidateCollection : null };
}

function planningCorroborationInput(application, document) {
  return {
    ...application,
    proposal: `${application?.proposal || ""} ${document?.title || ""} ${document?.role || ""}`
  };
}

export function planningDocumentIdentity({ document, application }) {
  return sha256(`${application?.reference || "unknown"}\n${document?.id || "unknown"}\n${document?.url || ""}`);
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
    preparedHandoff: null,
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
    sourceUrl: Object.hasOwn(application, "sourceUrl")
      ? application.sourceUrl
      : application.url || null
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
    nativeFormat: value.nativeFormat || null,
    registration: value.registration || null,
    acceptedFeatures: value.collection?.features?.length || 0,
    archive: value.archive ? {
      entries: value.archive.entries,
      relevantMembers: value.archive.relevantMembers,
      nativeMembersQueued: value.archive.nativeMembersQueued,
      nativeMembersDecoded: value.archive.nativeMembersDecoded,
      nativeBudgetBytes: value.archive.nativeBudgetBytes,
      members: value.archive.members
    } : null
  };
}

function supportedDocument(bytes, mime = detectDocumentMime(bytes, "")) {
  return isRasterPlanningDocument(mime) || [
    "application/dxf", "application/vnd.dwg", "application/ifc", "application/zip"
  ].includes(mime);
}

function detectDocumentMime(bytes, filename) {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  const hex = bytes.subarray(0, 12).toString("hex").toLowerCase();
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("49492a00") || hex.startsWith("4d4d002a")) return "image/tiff";
  if (hex.startsWith("504b0304")) return "application/zip";
  if (/ISO-10303-21/i.test(bytes.subarray(0, 256).toString("ascii")) || /\.ifc$/i.test(filename)) return "application/ifc";
  if (looksLikeAsciiDxf(bytes) || /\.dxf$/i.test(filename)) return "application/dxf";
  if (/^AC10\d{2}/.test(bytes.subarray(0, 6).toString("ascii")) || /\.dwg$/i.test(filename)) return "application/vnd.dwg";
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.tiff?$/i.test(filename)) return "image/tiff";
  return "application/octet-stream";
}

function documentExtension(value) {
  let extension = "";
  try { extension = path.extname(new URL(value).pathname).toLowerCase(); } catch { extension = path.extname(String(value)).toLowerCase(); }
  return /^\.(?:pdf|png|jpe?g|tiff?|dxf|dwg|ifc|zip)$/.test(extension) ? extension : ".pdf";
}

function isRasterPlanningDocument(mime) {
  return mime === "application/pdf" || /^image\/(?:png|jpeg|tiff)$/.test(mime);
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

function canonicalUrl(value) {
  try { return new URL(String(value || "")).toString(); }
  catch { return String(value || ""); }
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
