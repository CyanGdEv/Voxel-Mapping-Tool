#!/usr/bin/env node
import path from "node:path";
import { bboxCenter, createProjector } from "../src/lib/geo.mjs";
import { readJson, sha256File, writeJson } from "../src/lib/io.mjs";

const [inputGeoJson, evidenceJson, outputGeoJson] = process.argv.slice(2);
if (!inputGeoJson || !evidenceJson || !outputGeoJson) {
  throw new Error("Usage: export-embedded-ride-profiles.mjs INPUT.geojson EVIDENCE.json OUTPUT.geojson");
}

const [map, evidence, inputHash] = await Promise.all([
  readJson(path.resolve(inputGeoJson)),
  readJson(path.resolve(evidenceJson)),
  sha256File(path.resolve(inputGeoJson))
]);
const projector = createProjector(bboxCenter(evidence.bbox));
const features = [];
for (const sourceFeature of map.features || []) {
  const profile = sourceFeature.properties?._ride_profile;
  if (!profile?.parts?.length) continue;
  const coordinateParts = [];
  const evidenceParts = [];
  const confidenceParts = [];
  for (const part of profile.parts) {
    const coordinates = [], evidenceValues = [], confidenceValues = [];
    for (const sample of part) {
      const [lon, lat] = projector.inverse([sample.x, sample.z]);
      coordinates.push([lon, lat, Number.isFinite(sample.elevationM) ? sample.elevationM : null]);
      evidenceValues.push(Number.isFinite(sample.elevationM) ? sample.evidence || "inferred" : "none");
      confidenceValues.push(Number.isFinite(sample.confidence) ? sample.confidence : 0);
    }
    if (coordinates.length < 2) continue;
    coordinateParts.push(coordinates);
    evidenceParts.push(evidenceValues);
    confidenceParts.push(confidenceValues);
  }
  if (!coordinateParts.length) continue;
  const source = profile.source || {};
  const properties = {
    id: `portable-v07:${sourceFeature.id}`,
    replaces: sourceFeature.id,
    ride_name: sourceFeature.properties?.name || null,
    kind: "ride_track",
    subtype: sourceFeature.properties?.subtype || "coaster",
    evidence: "lidar-derived",
    evidence_by_vertex: coordinateParts.length === 1 ? evidenceParts[0] : evidenceParts,
    confidence_by_vertex: coordinateParts.length === 1 ? confidenceParts[0] : confidenceParts,
    allow_gaps: true,
    elevation_datum: "ODN",
    method: profile.method || "exported traceable LiDAR profile",
    source_name: source.provider || "Raw classified LiDAR point cloud derivative",
    source_url: source.datasets?.[0] || null,
    license: source.license || "Source licence recorded in parent evidence package",
    checked_at: source.surveyDates?.filter(Boolean).sort().at(-1) || evidence.source?.elevation?.survey?.newestSurveyDate,
    source_profile_sha256: inputHash,
    source_files: source.files || [],
    source_hashes: source.hashes || [],
    validation: {
      exportedFrom: path.basename(inputGeoJson),
      sourceProfileSha256: inputHash,
      originalCoverage: profile.coverage || null
    }
  };
  features.push({
    type: "Feature",
    properties,
    geometry: coordinateParts.length === 1
      ? { type: "LineString", coordinates: coordinateParts[0] }
      : { type: "MultiLineString", coordinates: coordinateParts }
  });
}

await writeJson(path.resolve(outputGeoJson), {
  type: "FeatureCollection",
  name: `${map.name || "Theme park"} portable ride profiles`,
  sourceProfileSha256: inputHash,
  features
});
console.log(JSON.stringify({ output: path.resolve(outputGeoJson), features: features.length, sourceProfileSha256: inputHash }, null, 2));
