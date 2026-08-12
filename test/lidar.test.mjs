import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeArrayBuffer } from "geotiff";
import { createProjectedRasterSampler, readGeoTiffRaster, selectBestSurveyTiles } from "../src/lib/lidar.mjs";
import { applyLidarBuildingHeights } from "../src/lib/osm.mjs";
import { extractRideProfileFromPoints } from "../src/lib/ride-profile.mjs";

test("reads and bilinearly samples an EPSG:27700 metre-grid GeoTIFF", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "themepark-lidar-test-"));
  const filename = path.join(directory, "dtm.tif");
  const values = new Float32Array([
    1, 2, 3,
    4, 5, 6,
    7, 8, 9
  ]);
  const bytes = writeArrayBuffer(values, {
    width: 3,
    height: 3,
    ModelPixelScale: [1, 1, 0],
    ModelTiepoint: [0, 0, 0, 100, 203, 0],
    ProjectedCSTypeGeoKey: 27700,
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: 1,
    SampleFormat: [3],
    BitsPerSample: [32]
  });
  await writeFile(filename, Buffer.from(bytes));

  const raster = await readGeoTiffRaster(filename, "test DTM");
  assert.deepEqual(raster.boundingBox, [100, 200, 103, 203]);
  assert.equal(raster.resolutionM, 1);
  assert.equal(raster.epsg, 27700);
  assert.equal(raster.min, 1);
  assert.equal(raster.max, 9);

  const sample = createProjectedRasterSampler(raster);
  assert.equal(sample(100.5, 202.5), 1);
  assert.equal(sample(101.5, 201.5), 5);
  assert.equal(sample(101, 202), 3);
  assert.equal(sample(99, 202), null);
});

test("LiDAR archive candidates prefer finest resolution and newest survey", () => {
  const ranked = selectBestSurveyTiles([
    { tile: "one-metre", resolutionM: 1, flownTo: "2025-01-01" },
    { tile: "older-25cm", resolutionM: 0.25, flownTo: "2022-01-01" },
    { tile: "newer-25cm", resolutionM: 0.25, flownTo: "2024-01-01" }
  ]);
  assert.deepEqual(ranked.map((tile) => tile.tile), ["newer-25cm", "older-25cm", "one-metre"]);
});

test("fills missing building heights from LiDAR while retaining tagged conflicts", () => {
  const untagged = buildingFeature("untagged", null, null);
  const tagged = buildingFeature("tagged", 3, "height");
  const elevation = {
    sourceKind: "ea-lidar",
    survey: { newestSurveyDate: "2022-01-05" },
    samplePairLocal: () => ({ terrain: 100, surface: 110 })
  };

  const stats = applyLidarBuildingHeights([untagged, tagged], elevation);
  assert.equal(stats.candidates, 2);
  assert.equal(stats.measured, 1);
  assert.equal(stats.comparedTagged, 1);
  assert.equal(stats.conflicts, 1);
  assert.equal(untagged.vertical.heightM, 10);
  assert.equal(untagged.vertical.heightSource, "ea-lidar-dsm-minus-dtm");
  assert.equal(untagged.verification.vertical, "measured-lidar");
  assert.equal(tagged.vertical.heightM, 3);
  assert.equal(tagged.vertical.lidarComparison.measuredHeightM, 10);
  assert.equal(tagged.vertical.lidarComparison.conflict, true);
});

test("fits a continuous ride elevation through LiDAR returns and rejects vegetation outliers", () => {
  const points = [];
  for (let x = 0; x <= 12; x += 1) {
    const trackHeight = 5 + Math.sin(x / 4) * 1.5;
    points.push(
      [x, 0.2, trackHeight - 0.08, 1, 120],
      [x, -0.2, trackHeight, 1, 125],
      [x, 0, trackHeight + 0.08, 1, 130],
      [x, 0.3, 18 + (x % 3), 6, 80]
    );
  }
  const pointIndex = {
    near(x, z, radius) {
      return points.filter((point) => Math.hypot(point[0] - x, point[1] - z) <= radius);
    }
  };
  const profile = extractRideProfileFromPoints({
    line: [[0, 0], [12, 0]],
    pointIndex,
    terrainAt: () => 0,
    sampleSpacingM: 1,
    corridorM: 0.75,
    maxInterpolationGapM: 3,
    minConfidence: 0.5
  });
  assert.ok(profile.length >= 12);
  assert.ok(profile.every((sample) => Number.isFinite(sample.elevationM)));
  assert.ok(profile.every((sample) => sample.elevationM < 10), "high building/vegetation returns must not become the fitted track");
  assert.ok(profile.every((sample) => sample.evidence === "lidar-derived"));
  assert.ok(profile.every((sample) => sample.confidence >= 0.5));
});

function buildingFeature(id, heightM, heightSource) {
  return {
    id,
    kind: "building",
    localGeometry: {
      type: "Polygon",
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]
    },
    vertical: { heightM, heightSource, explicit: heightM !== null },
    verification: { plan: "public-map", vertical: heightM !== null ? "tagged" : "unknown" }
  };
}
