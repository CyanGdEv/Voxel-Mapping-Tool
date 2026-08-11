#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
assert.ok(options.directory, "--directory is required");
const directory = path.resolve(options.directory);

const readJson = async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"));
const [result, authority, planning, graph, labels] = await Promise.all([
  readJson("build-result.json"),
  readJson("source-authority.json"),
  readJson("planning-sources.json"),
  readJson("park-reconstruction-graph.json"),
  readJson("building-labels.json")
]);
const geojson = JSON.parse(await readFile(result.paths.geojson, "utf8"));

assert.equal(authority.mode, "planning-only");
assert.equal(authority.world?.zeroOsmWorldFeatures, true, "OSM-derived world geometry remains");
assert.ok(planning.featureCount > 0, "no accepted planning geometry was compiled");
assert.ok(!graph.nodes.some((node) => String(node.sourceFeatureId).startsWith("osm:")),
  "reconstruction graph contains an OSM node");
const permittedIndependentKinds = new Set(["vegetation", "water", "terrain-detail"]);
assert.deepEqual(graph.nodes.filter((node) =>
  !String(node.geometryAuthority || "").startsWith("planning") &&
  !permittedIndependentKinds.has(node.type)
).map((node) => node.sourceFeatureId), [], "non-planning physical geometry reached the world graph");
assert.ok(!geojson.features.some((feature) => String(feature.id).startsWith("osm:")),
  "normalized world GeoJSON contains an OSM feature");
assert.ok(!geojson.features.some((feature) => feature.properties?.planning_exclude_from_world === true),
  "planning-excluded construction geometry reached the world");
assert.equal(result.stats.worldValidation, "passed", "internal Bedrock validation did not pass");

const labelIds = new Set(labels.labels.map((label) => String(label.featureId)));
const namedBuildings = geojson.features.filter((feature) =>
  ["building", "structure"].includes(feature.properties?.kind) && feature.properties?.name
);
const missingLabels = namedBuildings.filter((feature) => !labelIds.has(String(feature.id)));
assert.deepEqual(missingLabels.map((feature) => feature.id), [], "named buildings are missing world signs");

const report = {
  schemaVersion: 1,
  status: "passed",
  parkName: result.parkName,
  authorityMode: authority.mode,
  planningFeatures: planning.featureCount,
  reconstructionNodes: graph.nodes.length,
  osmWorldFeatures: 0,
  namedBuildings: namedBuildings.length,
  namedBuildingLabels: labels.count,
  worldValidation: result.stats.worldValidation
};
await writeFile(path.join(directory, "planning-build-validation.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    assert.ok(key && value, "arguments must be --key value pairs");
    result[key] = value;
  }
  return result;
}
