import path from "node:path";
import { unzipSync } from "fflate";
import { extractNativeDxfPlanning } from "./planning-native-vector.mjs";

const MAX_ARCHIVE_ENTRIES = 512;
const MAX_RELEVANT_MEMBERS = 128;
const MAX_NATIVE_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_TOTAL_BYTES = 192 * 1024 * 1024;
const NATIVE_EXTENSIONS = new Set([".dwg", ".dxf", ".ifc"]);
const RELEVANT_EXTENSIONS = new Set([
  ".dwg", ".dxf", ".ifc", ".ifczip", ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".zip"
]);

/**
 * Safely inventories an official planning ZIP and decodes embedded DWG/DXF/IFC
 * members without writing archive paths to disk. Other CAD/raster files remain
 * explicit evidence inventory for later conversion/reconciliation.
 */
export function extractNativePlanningArchive({
  bytes,
  application = {},
  document = {},
  profile,
  minimumConfidence = 0.72,
  maxEntries = MAX_ARCHIVE_ENTRIES,
  maxRelevantMembers = MAX_RELEVANT_MEMBERS,
  maxNativeMemberBytes = MAX_NATIVE_MEMBER_BYTES,
  maxNativeTotalBytes = MAX_NATIVE_TOTAL_BYTES
}) {
  const archiveBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  let entryCount = 0;
  let relevantCount = 0;
  let nativeBudgetBytes = 0;
  const inventory = [];

  const decoded = unzipSync(new Uint8Array(archiveBytes), {
    filter(file) {
      entryCount += 1;
      if (entryCount > maxEntries) throw new Error(`planning ZIP exceeds ${maxEntries} entries`);
      const name = safeArchivePath(file.name);
      if (!name) return false;
      const extension = path.posix.extname(name).toLowerCase();
      if (!RELEVANT_EXTENSIONS.has(extension)) return false;

      relevantCount += 1;
      if (relevantCount > maxRelevantMembers) {
        throw new Error(`planning ZIP exceeds ${maxRelevantMembers} relevant members`);
      }
      const originalSize = Number(file.originalSize);
      const nativeDecodable = NATIVE_EXTENSIONS.has(extension);
      const item = {
        name,
        extension,
        sizeBytes: Number.isFinite(originalSize) ? originalSize : null,
        nativeDecodable,
        status: nativeDecodable ? "queued-native-decode" : "inventoried"
      };
      inventory.push(item);

      if (!nativeDecodable) return false;
      if (!Number.isFinite(originalSize) || originalSize < 0 || originalSize > maxNativeMemberBytes) {
        item.status = "withheld-size-bound";
        return false;
      }
      if (nativeBudgetBytes + originalSize > maxNativeTotalBytes) {
        item.status = "withheld-total-size-bound";
        return false;
      }
      nativeBudgetBytes += originalSize;
      return true;
    }
  });

  const inventoryByName = new Map(inventory.map((item) => [item.name, item]));
  const extractions = [];
  const features = [];
  for (const [rawName, data] of Object.entries(decoded)) {
    const name = safeArchivePath(rawName);
    if (!name) continue;
    const item = inventoryByName.get(name);
    if (!item?.nativeDecodable) continue;
    const member = Buffer.from(data);
    if (member.length > maxNativeMemberBytes) {
      item.status = "withheld-size-bound";
      continue;
    }

    try {
      const nestedDocument = {
        ...document,
        id: `${document.id || document.title || "planning-archive"}:${safeId(name)}`,
        title: `${document.title || document.id || "Planning archive"} — ${name}`,
        role: document.role || "planning-document",
        archiveMember: name
      };
      const extracted = extractNativeDxfPlanning({
        bytes: member,
        application,
        document: nestedDocument,
        profile,
        minimumConfidence
      });
      const acceptedFeatures = extracted.collection?.features?.length || 0;
      item.status = acceptedFeatures ? "geometry-ready" : extracted.status || "decoded-no-geometry";
      item.acceptedFeatures = acceptedFeatures;
      extractions.push({ ...extracted, archiveMember: name });
      for (const feature of extracted.collection?.features || []) {
        feature.properties ||= {};
        feature.properties.planning_archive_member = name;
        feature.properties.planning_archive_container_id = document.id || document.title || "unknown";
        feature.properties.planning_archive_member_size_bytes = member.length;
        features.push(feature);
      }
    } catch (error) {
      item.status = "decode-failed";
      item.error = error?.message || String(error);
    }
  }

  return {
    status: features.length ? "native-archive-geometry-ready" : "native-archive-inventoried-no-geometry",
    page: 1,
    confidence: extractions.length
      ? Math.max(...extractions.map((item) => Number(item.confidence) || 0))
      : 0,
    scale: null,
    location: null,
    origin: null,
    shapes: extractions.reduce((sum, item) => sum + (Number(item.shapes) || 0), 0),
    associatedShapes: features.length,
    nativeFormat: "zip",
    registration: "per-native-member",
    archive: {
      entries: entryCount,
      relevantMembers: inventory.length,
      nativeMembersQueued: inventory.filter((item) => item.nativeDecodable).length,
      nativeMembersDecoded: extractions.length,
      nativeBudgetBytes,
      members: inventory
    },
    extractions,
    collection: { type: "FeatureCollection", features }
  };
}

function safeArchivePath(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || raw.endsWith("/")) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`planning ZIP contains absolute member path: ${raw}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`planning ZIP contains unsafe member path: ${raw}`);
  }
  return normalized;
}

function safeId(value) {
  return String(value || "unknown")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 100);
}
