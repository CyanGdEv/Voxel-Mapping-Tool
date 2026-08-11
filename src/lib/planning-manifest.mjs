import path from "node:path";
import { readFile } from "node:fs/promises";
import { UserError, invariant } from "./errors.mjs";
import {
  cachedBinary,
  fetchBinary,
  readJson,
  sha256,
  sha256File
} from "./io.mjs";

const MAX_DOCUMENT_BYTES = 250 * 1024 * 1024;

export async function acquirePlanningEvidence(options, runtime) {
  const manifests = options.planningManifest || [];
  const directCollections = options.planning || [];
  const result = {
    schemaVersion: 1,
    status: manifests.length || directCollections.length ? "configured" : "not-configured",
    manifests: [],
    documents: [],
    collections: [],
    featureCount: 0,
    warnings: []
  };

  for (const filename of directCollections) {
    const resolved = path.resolve(filename);
    const collection = await readJson(resolved);
    result.collections.push(await planningCollectionEntry(collection, {
      id: `planning-file:${path.basename(resolved)}`,
      sourceFile: resolved,
      sourceUrl: `file://${path.basename(resolved)}`,
      authorityName: options.parkProfile?.planningAuthority?.name || "Configured planning evidence",
      applicationReference: collection.properties?.application_reference || null,
      applicationStatus: collection.properties?.application_status || "accepted"
    }));
  }

  for (const manifestLocation of manifests) {
    const loaded = await loadManifest(manifestLocation, runtime);
    const manifest = validateManifest(loaded.data, manifestLocation);
    const manifestEntry = {
      id: manifest.id,
      location: manifestLocation,
      sha256: sha256(loaded.data),
      authority: manifest.authority,
      documents: manifest.documents.length
    };
    result.manifests.push(manifestEntry);
    for (const document of manifest.documents) {
      const acquired = await acquireDocument(document, loaded.base, manifest, runtime, options);
      result.documents.push(acquired.evidence);
      for (const collection of acquired.collections) result.collections.push(collection);
    }
  }

  result.featureCount = result.collections.reduce(
    (total, entry) => total + (entry.collection?.features?.length || 0), 0
  );
  result.status = result.featureCount
    ? "planning-geometry-ready"
    : result.documents.length ? "documents-acquired-no-accepted-geometry" : result.status;
  if (result.documents.length && !result.featureCount) {
    result.warnings.push(
      "Planning documents were inventoried, but no accepted georeferenced GeoJSON derivative was supplied; raw drawings are evidence, not world geometry."
    );
  }
  return result;
}

export function compactPlanningEvidence(planning) {
  if (!planning) return null;
  return {
    schemaVersion: planning.schemaVersion,
    status: planning.status,
    featureCount: planning.featureCount,
    manifests: planning.manifests,
    documents: planning.documents,
    warnings: planning.warnings,
    collections: planning.collections.map((entry) => ({
      id: entry.id,
      adapter: entry.adapter,
      sourceFile: entry.sourceFile ? path.basename(entry.sourceFile) : null,
      sourceUrl: entry.sourceUrl,
      featureCount: entry.collection?.features?.length || 0,
      sha256: entry.sha256
    }))
  };
}

async function loadManifest(location, runtime) {
  if (/^https:\/\//i.test(location)) {
    const data = JSON.parse((await fetchBinary(location, {
      headers: { "User-Agent": runtime.userAgent, Accept: "application/json" }
    })).toString("utf8"));
    return { data, base: new URL(".", location).toString() };
  }
  const filename = path.resolve(location);
  return { data: await readJson(filename), base: path.dirname(filename) };
}

function validateManifest(manifest, location) {
  if (manifest?.schemaVersion !== 1) throw new UserError(`${location} has an unsupported planning manifest schema`);
  invariant(manifest.id, `${location} must have an id`);
  invariant(manifest.authority?.name && manifest.authority?.officialPortal,
    `${location} must identify an official planning authority and portal`);
  invariant(Array.isArray(manifest.documents), `${location} documents must be an array`);
  const ids = new Set();
  for (const document of manifest.documents) {
    invariant(document?.id && !ids.has(document.id), `${location} has a duplicate or missing document id`);
    ids.add(document.id);
    invariant(document.sourceUrl || document.file || document.derivedGeojson,
      `${location} document ${document.id} has no source`);
    invariant(document.applicationReference, `${location} document ${document.id} has no applicationReference`);
    invariant(document.applicationStatus, `${location} document ${document.id} has no applicationStatus`);
    invariant(document.reuseStatus,
      `${location} document ${document.id} must state reuseStatus; public viewing does not imply redistribution rights`);
    if (toArray(document.derivedGeojson).length) {
      invariant(typeof document.worldEligible === "boolean",
        `${location} document ${document.id} must explicitly set worldEligible for every georeferenced derivative`);
      if (document.worldEligible) invariant(document.worldEligibilityBasis,
        `${location} document ${document.id} must explain worldEligibilityBasis`);
    }
  }
  return manifest;
}

async function acquireDocument(document, base, manifest, runtime, options) {
  let sourceFile = null;
  let sourceHash = document.sha256 || null;
  let sizeBytes = null;
  const shouldAcquire = document.acquire !== false && (document.file || document.sourceUrl);
  if (shouldAcquire) {
    const source = resolveLocation(document.file || document.sourceUrl, base);
    if (/^https:\/\//i.test(source)) {
      const extension = safeExtension(source, document.mime);
      const cached = await cachedBinary({
        cacheDir: path.join(runtime.cacheDir, "planning-documents"),
        key: source,
        noCache: options.noCache,
        extension,
        fetcher: () => fetchBinary(source, {
          headers: { "User-Agent": runtime.userAgent, Accept: document.mime || "application/pdf,*/*" }
        }, { timeoutMs: 180_000, retries: 2 })
      });
      sourceFile = cached.filename;
    } else {
      sourceFile = path.resolve(source);
    }
    const bytes = await readFile(sourceFile);
    sizeBytes = bytes.length;
    if (sizeBytes > Number(options.maxPlanningDocumentMb || 250) * 1024 * 1024 || sizeBytes > MAX_DOCUMENT_BYTES) {
      throw new UserError(`Planning document ${document.id} exceeds the bounded document size`);
    }
    sourceHash = await sha256File(sourceFile);
    if (document.sha256 && sourceHash !== String(document.sha256).toLowerCase()) {
      throw new UserError(`Planning document ${document.id} SHA-256 does not match its manifest`);
    }
  }

  const derivatives = toArray(document.derivedGeojson);
  const collections = [];
  for (const derivative of document.worldEligible === true ? derivatives : []) {
    const location = resolveLocation(derivative, base);
    let collection;
    let derivativeHash;
    let sourceFilename = null;
    if (/^https:\/\//i.test(location)) {
      const bytes = await fetchBinary(location, {
        headers: { "User-Agent": runtime.userAgent, Accept: "application/geo+json,application/json" }
      });
      collection = JSON.parse(bytes.toString("utf8"));
      derivativeHash = sha256(bytes);
    } else {
      sourceFilename = path.resolve(location);
      collection = await readJson(sourceFilename);
      derivativeHash = await sha256File(sourceFilename);
    }
    collections.push(await planningCollectionEntry(collection, {
      id: `planning:${manifest.id}:${document.id}:${derivativeHash.slice(0, 12)}`,
      sourceFile: sourceFilename,
      sourceUrl: document.sourceUrl || manifest.authority.officialPortal,
      authorityName: manifest.authority.name,
      applicationReference: document.applicationReference,
      applicationStatus: document.applicationStatus,
      documentHash: sourceHash,
      documentRole: document.role || "planning-drawing",
      capturedAt: document.decisionDate || document.publishedAt || null,
      reuseStatus: document.reuseStatus
    }));
  }

  return {
    evidence: {
      id: document.id,
      applicationReference: document.applicationReference,
      applicationStatus: document.applicationStatus,
      role: document.role || null,
      sourceUrl: document.sourceUrl || null,
      officialPortal: manifest.authority.officialPortal,
      authority: manifest.authority.name,
      reuseStatus: document.reuseStatus,
      sha256: sourceHash,
      sizeBytes,
      acquired: Boolean(sourceFile),
      derivedCollectionsDeclared: derivatives.length,
      derivedCollectionsAccepted: collections.length,
      worldEligible: document.worldEligible === true,
      worldEligibilityBasis: document.worldEligibilityBasis || null
    },
    collections
  };
}

async function planningCollectionEntry(collection, context) {
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new UserError(`Planning derivative ${context.id} must be a GeoJSON FeatureCollection`);
  }
  const features = collection.features.map((feature, index) => {
    if (!feature?.geometry) throw new UserError(`Planning derivative ${context.id} feature ${index} has no geometry`);
    const properties = { ...(feature.properties || {}) };
    if (properties.planning_exclude_from_world === true || isConstructionFence(properties)) {
      properties.planning_exclude_from_world = true;
      properties.planning_exclusion_reason ||= "temporary-construction-fence";
    }
    return {
      ...feature,
      properties: {
        ...properties,
        id: properties.id || `${context.id}:${index}`,
        source_name: properties.source_name || context.authorityName,
        source_url: properties.source_url || context.sourceUrl,
        license: properties.license || context.reuseStatus || "public-register-processing-only",
        source_dataset: properties.source_dataset || "planning-drawing-vector",
        planning_authority: true,
        planning_authoritative: properties.planning_authoritative !== false,
        planning_reference: properties.planning_reference || context.applicationReference,
        application_status: properties.application_status || context.applicationStatus,
        document_sha256: properties.document_sha256 || context.documentHash || null,
        document_role: properties.document_role || context.documentRole || null,
        checked_at: properties.checked_at || context.capturedAt || null,
        merge_policy: properties.merge_policy || "planning-authoritative"
      }
    };
  }).filter((feature) => feature.properties.planning_exclude_from_world !== true);
  const normalized = {
    ...collection,
    source: {
      name: context.authorityName,
      url: context.sourceUrl,
      license: context.reuseStatus || "public-register-processing-only",
      dataset: "planning-drawing-vector"
    },
    features
  };
  return {
    id: context.id,
    adapter: "planning-manifest-geojson",
    sourceFile: context.sourceFile || null,
    sourceUrl: context.sourceUrl,
    sha256: sha256(normalized),
    collection: normalized
  };
}

function isConstructionFence(properties) {
  const semantic = String(
    properties.semantic_class || properties.planning_feature_class || properties.subtype || ""
  ).toLowerCase();
  const state = String(properties.planning_feature_state || properties.lifecycle || "").toLowerCase();
  const colour = String(properties.stroke || properties.colour || properties.color || "").toLowerCase();
  return semantic.includes("construction-fence") || (
    (state.includes("temporary") || properties.temporary === true) &&
    (semantic.includes("fence") || properties.barrier === "fence") &&
    (colour.includes("red") || colour === "#ff0000" || colour === "#f00")
  );
}

function resolveLocation(location, base) {
  if (/^https:\/\//i.test(location)) return location;
  if (/^https:\/\//i.test(base)) return new URL(location, base).toString();
  return path.resolve(base, location);
}

function safeExtension(location, mime) {
  const pathname = new URL(location).pathname;
  const extension = path.extname(pathname).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  if (mime === "application/pdf") return ".pdf";
  return ".bin";
}

function toArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}
