import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { readJson } from "./io.mjs";
import { UserError } from "./errors.mjs";

const PROFILE_DIRECTORY = fileURLToPath(new URL("../../config/parks/", import.meta.url));

export async function listParkProfiles() {
  const files = (await readdir(PROFILE_DIRECTORY))
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  return Promise.all(files.map(async (filename) => validateParkProfile(
    await readJson(path.join(PROFILE_DIRECTORY, filename)), filename
  )));
}

export async function loadParkProfile(identifier) {
  const query = normalizeIdentifier(identifier);
  if (!query) throw new UserError("--park requires a supported park identifier");
  const profiles = await listParkProfiles();
  const profile = profiles.find((candidate) => [candidate.id, candidate.name, ...(candidate.aliases || [])]
    .some((value) => normalizeIdentifier(value) === query));
  if (!profile) {
    throw new UserError(
      `Unknown park profile: ${identifier}`,
      `Supported profiles: ${profiles.map((candidate) => candidate.id).join(", ")}`
    );
  }
  return profile;
}

export function applyParkProfile(options, profile) {
  const bbox = profile.bbox;
  return {
    ...profile.defaults,
    ...options,
    parkProfile: profile,
    parkId: profile.id,
    parkName: options.parkName || profile.name,
    bbox: options.bbox || `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`,
    planningWorldAuthority: options.planningWorldAuthority || "planning-only",
    accuracyMode: options.accuracyMode || "verified",
    buildings: options.buildings || "shells"
  };
}

export function validateParkProfile(profile, source = "park profile") {
  if (profile?.schemaVersion !== 1) throw new UserError(`${source} has an unsupported schemaVersion`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(profile.id || ""))) {
    throw new UserError(`${source} has an invalid id`);
  }
  if (!profile.name) throw new UserError(`${source} has no name`);
  const bbox = profile.bbox || {};
  for (const key of ["south", "west", "north", "east"]) {
    if (!Number.isFinite(Number(bbox[key]))) throw new UserError(`${source} bbox.${key} must be numeric`);
  }
  if (!(Number(bbox.south) < Number(bbox.north) && Number(bbox.west) < Number(bbox.east))) {
    throw new UserError(`${source} has an invalid bounding box`);
  }
  if (!profile.planningAuthority?.name || !profile.planningAuthority?.officialPortal) {
    throw new UserError(`${source} must identify the official planning authority and portal`);
  }
  if (!profile.planningDiscovery?.portalType || !profile.planningDiscovery?.searchUrl) {
    throw new UserError(`${source} must configure automatic planning discovery`);
  }
  if (profile.worldCoverage) validateWorldCoverage(profile.worldCoverage, `${source} worldCoverage`);
  const discoveryUrl = new URL(profile.planningDiscovery.searchUrl);
  const allowedHosts = new Set((profile.planningDiscovery.allowedDocumentHosts || [])
    .map((host) => String(host).toLowerCase()));
  const allowLegacyHttp = profile.planningDiscovery.portalType === "legacy-idox" &&
    discoveryUrl.protocol === "http:" && allowedHosts.has(discoveryUrl.hostname.toLowerCase());
  if (discoveryUrl.protocol !== "https:" && !allowLegacyHttp) {
    throw new UserError(`${source} planningDiscovery.searchUrl must use HTTPS unless an allowlisted legacy-idox authority is HTTP-only`);
  }
  return profile;
}

export function validateWorldCoverage(coverage, source = "worldCoverage") {
  if (coverage?.schemaVersion !== 1) throw new UserError(`${source} has an unsupported schemaVersion`);
  const bounds = coverage.chunkBounds || {};
  for (const key of ["minChunkX", "minChunkZ", "maxChunkX", "maxChunkZ"]) {
    if (!Number.isInteger(Number(bounds[key]))) throw new UserError(`${source}.${key} must be an integer`);
  }
  if (Number(bounds.minChunkX) > Number(bounds.maxChunkX) || Number(bounds.minChunkZ) > Number(bounds.maxChunkZ)) {
    throw new UserError(`${source} has invalid chunk bounds`);
  }
  if (!Number.isInteger(Number(coverage.marginBlocks)) || Number(coverage.marginBlocks) < 0) {
    throw new UserError(`${source}.marginBlocks must be a non-negative integer`);
  }
  const expectedChunks = coverageChunkCount(coverage);
  if (!Number.isInteger(Number(coverage.expectedChunks)) || Number(coverage.expectedChunks) !== expectedChunks) {
    throw new UserError(`${source}.expectedChunks must equal its ${expectedChunks.toLocaleString()}-chunk rectangle`);
  }
  for (const key of ["minimumPlanningSpanRatioX", "minimumPlanningSpanRatioZ"]) {
    if (coverage[key] === undefined) continue;
    const value = Number(coverage[key]);
    if (!(value > 0 && value <= 1)) throw new UserError(`${source}.${key} must be greater than zero and at most one`);
  }
  return coverage;
}

export function coverageChunkCount(coverage) {
  const bounds = coverage?.chunkBounds || {};
  return (Number(bounds.maxChunkX) - Number(bounds.minChunkX) + 1) *
    (Number(bounds.maxChunkZ) - Number(bounds.minChunkZ) + 1);
}

export function coverageLocalBounds(coverage) {
  validateWorldCoverage(coverage);
  const bounds = coverage.chunkBounds;
  const margin = Number(coverage.marginBlocks);
  return {
    minX: Number(bounds.minChunkX) * 16 + margin,
    minZ: Number(bounds.minChunkZ) * 16 + margin,
    maxX: (Number(bounds.maxChunkX) + 1) * 16 - 1 - margin,
    maxZ: (Number(bounds.maxChunkZ) + 1) * 16 - 1 - margin
  };
}

function normalizeIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
