import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildPark } from "../src/lib/pipeline.mjs";
import { listParkProfiles } from "../src/lib/park-profile.mjs";
import { acquirePlanningEvidence } from "../src/lib/planning-manifest.mjs";
import { applyPlanningWorldAuthority } from "../src/lib/planning-world-authority.mjs";
import {
  blockForThemeParkSurfaceStyle,
  resolveThemeParkSurfaceMaterial
} from "../src/lib/surface-material-library.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const osm = path.join(here, "fixtures", "mini-park.overpass.json");
const planning = path.join(here, "fixtures", "planning-authority.geojson");
const planningManifest = path.join(here, "fixtures", "planning-manifest.json");

test("ships profiles for the five requested UK parks", async () => {
  const profiles = await listParkProfiles();
  assert.deepEqual(profiles.map((profile) => profile.id), [
    "alton-towers-resort",
    "chessington-world-of-adventures",
    "drayton-manor-resort",
    "legoland-windsor-resort",
    "thorpe-park"
  ]);
  assert.ok(profiles.every((profile) => profile.planningAuthority.officialPortal.startsWith("https://")));
  assert.ok(profiles.every((profile) => profile.planningDiscovery.searchUrl.startsWith("https://")));
  assert.ok(profiles.every((profile) => ["idox", "legacy-idox", "northgate"].includes(profile.planningDiscovery.portalType)));
});

test("planning manifests require and retain an explicit current-world eligibility decision", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "voxel-map-planning-manifest-"));
  const result = await acquirePlanningEvidence({ planningManifest: [planningManifest] }, {
    cacheDir,
    userAgent: "VoxelMappingTool/test"
  });
  assert.equal(result.status, "planning-geometry-ready");
  assert.ok(result.featureCount > 0);
  assert.equal(result.documents[0].worldEligible, true);
  assert.match(result.documents[0].worldEligibilityBasis, /implemented fixture state/);
  assert.equal(result.documents[0].derivedCollectionsAccepted, 1);
});

test("planning-only authority rejects non-planning structures but keeps independent water and vegetation evidence", () => {
  const feature = (id, kind, source, tags = {}) => ({
    id, kind, source, tags, vertical: { heightM: null, elevationM: null }
  });
  const features = [
    feature("planning:building", "building", { provider: "Planning authority" }, { planning_authoritative: true }),
    feature("ml:building", "building", { provider: "Microsoft Global ML Building Footprints" }),
    feature("official:trees", "vegetation", { provider: "Forestry Commission" }),
    feature("official:water", "water", { provider: "Environment Agency" }),
    feature("wikidata:ride", "attraction", { provider: "Wikidata" })
  ];
  const evidence = applyPlanningWorldAuthority(features, { planningWorldAuthority: "planning-only" });
  assert.deepEqual(features.map((item) => item.id), ["planning:building", "official:trees", "official:water"]);
  assert.equal(evidence.nonPlanningGeometryRemoved, 2);
  assert.equal(evidence.independentFeaturesRetained, 2);
});

test("planning-only build removes every OSM world feature and temporary construction fence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voxel-map-authority-"));
  const result = await buildPark({
    parkName: "Planning Authority Fixture Park",
    osm,
    planning: [planning],
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    planningWorldAuthority: "planning-only",
    buildings: "shells",
    accuracyMode: "verified",
    out: directory,
    maxCells: 200_000,
    noAddon: true,
    noPreview: true
  });

  const authority = JSON.parse(await readFile(result.paths.sourceAuthority, "utf8"));
  const graph = JSON.parse(await readFile(result.paths.reconstructionGraph, "utf8"));
  const geojson = JSON.parse(await readFile(result.paths.geojson, "utf8"));
  const labels = JSON.parse(await readFile(result.paths.buildingLabels, "utf8"));
  const palette = JSON.parse(await readFile(result.paths.blockPalette, "utf8"));

  assert.equal(authority.mode, "planning-only");
  assert.equal(authority.world.zeroOsmWorldFeatures, true);
  assert.ok(authority.world.osmFeaturesRemoved > 0);
  assert.ok(!graph.nodes.some((node) => String(node.sourceFeatureId).startsWith("osm:")));
  assert.ok(!geojson.features.some((feature) => String(feature.id).startsWith("osm:")));
  assert.ok(!geojson.features.some((feature) => feature.id === "planning:temporary-red-fence"));
  assert.ok(labels.labels.some((label) => label.name === "Planning Hall"));
  assert.ok(palette.emittedBlocks.some((block) => block.endsWith("_slab")));
  assert.ok(palette.emittedBlocks.includes("minecraft:sandstone_wall"));
  assert.ok(palette.emittedBlocks.includes("minecraft:oak_trapdoor"));
  assert.equal(result.stats.worldValidation, "passed");
});

test("planning-only mode fails closed instead of compiling OSM as a fallback", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voxel-map-no-plan-"));
  await assert.rejects(() => buildPark({
    parkName: "No Planning Fixture",
    osm,
    bbox: "51.0000,-0.0020,51.0020,0.0020",
    elevation: "none",
    planningWorldAuthority: "planning-only",
    out: directory,
    noWorld: true,
    noAddon: true
  }), /requires at least one accepted planning feature/);
});

test("material presets keep exact weighted recipes and deterministic patterns", () => {
  const preset = resolveThemeParkSurfaceMaterial({ materialPreset: "weathered_asphalt" });
  assert.deepEqual(preset.palette.map((entry) => entry.percent), [45, 30, 15, 10]);
  const first = Array.from({ length: 32 }, (_, x) => blockForThemeParkSurfaceStyle(
    { materialPreset: "red_block_paving" }, x, 7, 1234
  ));
  const second = Array.from({ length: 32 }, (_, x) => blockForThemeParkSurfaceStyle(
    { materialPreset: "red_block_paving" }, x, 7, 1234
  ));
  assert.deepEqual(first, second);
  assert.ok(new Set(first).size > 1);
});
