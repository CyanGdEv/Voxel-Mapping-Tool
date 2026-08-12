import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireHighResolutionSurveyPair,
  resolveSurveyAssetUrl,
  selectHighResolutionSurveyCandidate
} from "../src/lib/lidar-high-resolution.mjs";

const tiles = [
  { tile: "SK04", surveyId: "old-25", resolutionM: 0.25, flownTo: "2021-05-01", dtm: "https://example.test/old-dtm.tif", dsm: "https://example.test/old-dsm.tif" },
  { tile: "SK04", surveyId: "new-25", resolutionM: 0.25, flownTo: "2024-06-01", dtm: "https://example.test/new-dtm.tif", dsm: "https://example.test/new-dsm.tif" },
  { tile: "SK04", surveyId: "new-50", resolutionM: 0.5, flownTo: "2025-06-01", dtm: "https://example.test/50-dtm.tif", dsm: "https://example.test/50-dsm.tif" },
  { tile: "SK04", surveyId: "latest-1m", resolutionM: 1, flownTo: "2026-06-01", dtm: "https://example.test/1m-dtm.tif", dsm: "https://example.test/1m-dsm.tif" }
];

test("sub-metre survey selection prefers finest resolution before newest date", () => {
  const selected = selectHighResolutionSurveyCandidate(tiles);
  assert.equal(selected.surveyId, "new-25");
  assert.equal(selected.resolutionM, 0.25);
});

test("paired DTM/DSM is mandatory when surface reconstruction is enabled", () => {
  const selected = selectHighResolutionSurveyCandidate([
    { surveyId: "dtm-only", resolutionM: 0.25, flownTo: "2026-01-01", dtm: "https://example.test/dtm.tif", dsm: null },
    { surveyId: "paired", resolutionM: 0.5, flownTo: "2025-01-01", dtm: "https://example.test/dtm2.tif", dsm: "https://example.test/dsm2.tif" }
  ]);
  assert.equal(selected.surveyId, "paired");
});

test("relative survey assets are only promoted with an explicit archive base", () => {
  assert.equal(resolveSurveyAssetUrl("tiles/SK04_DTM.tif"), null);
  assert.equal(
    resolveSurveyAssetUrl("tiles/SK04_DTM.tif", "https://example.test/lidar/"),
    "https://example.test/lidar/tiles/SK04_DTM.tif"
  );
});

test("high-resolution pair acquisition keeps a coherent candidate and provenance", async () => {
  const loaded = [];
  const result = await acquireHighResolutionSurveyPair({
    survey: { tiles },
    cacheDir: "/tmp/unused",
    wantsDsm: true,
    assetLoader: async ({ url, role, candidate }) => {
      loaded.push([role, url, candidate.surveyId]);
      return { filename: `/tmp/${role}.tif`, role, endpoint: url, surveyId: candidate.surveyId };
    }
  });
  assert.equal(result.status, "high-resolution-pair-acquired");
  assert.equal(result.selectedResolutionM, 0.25);
  assert.equal(result.candidate.surveyId, "new-25");
  assert.deepEqual(loaded.map((entry) => entry[0]), ["dtm", "dsm"]);
  assert.ok(loaded.every((entry) => entry[2] === "new-25"));
});

test("ZIP archive references fail closed instead of being treated as GeoTIFF", async () => {
  const result = await acquireHighResolutionSurveyPair({
    survey: { tiles: [{ surveyId: "zip", resolutionM: 0.25, dtm: "https://example.test/dtm.zip", dsm: "https://example.test/dsm.zip" }] },
    cacheDir: "/tmp/unused"
  });
  assert.equal(result.status, "survey-assets-require-bounded-archive-extraction");
  assert.equal(result.dtm, null);
});
