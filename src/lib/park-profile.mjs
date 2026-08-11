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
  if (!/^https:\/\//i.test(profile.planningDiscovery.searchUrl)) {
    throw new UserError(`${source} planningDiscovery.searchUrl must use HTTPS`);
  }
  return profile;
}

function normalizeIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
