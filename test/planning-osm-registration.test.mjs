import test from "node:test";
import assert from "node:assert/strict";
import { createProjector } from "../src/lib/geo.mjs";
import { registerPlanningCollectionToOsm } from "../src/lib/planning-osm-registration.mjs";

const center = { lon: 0, lat: 51.01 };
const projector = createProjector(center);

test("OSM resolves drawing scale, rotation and position without becoming world geometry", () => {
  const trueTransform = transform(0.1, 30, 80, -60);
  const building = [[0, 0], [100, 0], [100, 80], [0, 80], [0, 0]];
  const path = [[-50, 150], [0, 180], [100, 200], [180, 180]];
  const collection = {
    type: "FeatureCollection",
    features: [
      pendingFeature("building", { type: "Polygon", coordinates: [building] }),
      pendingFeature("path", { type: "LineString", coordinates: path })
    ]
  };
  const osm = {
    elements: [
      {
        type: "way", id: 10, tags: { building: "yes" },
        geometry: building.map((point) => lonLatPoint(trueTransform(point)))
      },
      {
        type: "way", id: 11, tags: { highway: "footway" },
        geometry: path.map((point) => lonLatPoint(trueTransform(point)))
      }
    ]
  };
  const result = registerPlanningCollectionToOsm(collection, {
    application: { geometry: { type: "Point", coordinates: [center.lon, center.lat] } },
    runtime: { center, osm: { data: osm, dataHash: "fixture-osm-sha" } }
  });
  assert.equal(result.registration.status, "verified-osm-similarity");
  assert.equal(result.registration.verified, true);
  assert.equal(result.collection.features.length, 2, "OSM reference features must not be copied");
  assert.ok(Math.abs(result.registration.scaleMPerPixel - 0.1) < 0.02);
  assert.ok(angleDifference(result.registration.rotationDegrees, 30) <= 5);
  assert.ok(result.collection.features.every((feature) =>
    feature.properties.planning_spatial_registration_verified === true));
  assert.ok(result.collection.features.every((feature) =>
    feature.properties.planning_osm_reference_only === true));

  const registeredStart = result.collection.features[0].geometry.coordinates[0][0];
  const expectedStart = projector.inverse(trueTransform(building[0]));
  assert.ok(distanceDegrees(registeredStart, expectedStart) < 0.00005);
});

test("weak or underspecified OSM matches remain pending and fail closed", () => {
  const collection = {
    type: "FeatureCollection",
    features: [pendingFeature("path", {
      type: "LineString",
      coordinates: [[0, 0], [10, 0], [20, 0]]
    })]
  };
  const result = registerPlanningCollectionToOsm(collection, {
    application: { geometry: { type: "Point", coordinates: [center.lon, center.lat] } },
    runtime: {
      center,
      osm: { data: { elements: [{
        type: "way", id: 20, tags: { highway: "footway" },
        geometry: [[0, 0], [1, 0], [2, 0]].map((point) => lonLatPoint(point))
      }] } }
    }
  });

  assert.equal(result.registration.verified, false);
  assert.equal(result.registration.status, "insufficient-planning-registration-samples");
  assert.equal(result.collection.features[0].properties.planning_registration_pending, true);
  assert.equal(result.collection.features[0].properties.planning_spatial_registration_verified, false);
});

function pendingFeature(kind, geometry) {
  return {
    type: "Feature",
    geometry,
    properties: {
      kind,
      planning_authoritative: true,
      planning_auto_extracted: true,
      planning_registration_pending: true,
      planning_spatial_registration_verified: false,
      planning_nominal_metres_per_pixel: 0.1
    }
  };
}

function transform(scale, degrees, tx, tz) {
  const radians = degrees * Math.PI / 180;
  return ([x, y]) => [
    tx + scale * (x * Math.cos(radians) - y * Math.sin(radians)),
    tz + scale * (x * Math.sin(radians) + y * Math.cos(radians))
  ];
}

function lonLatPoint(local) {
  const [lon, lat] = projector.inverse(local);
  return { lon, lat };
}

function angleDifference(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

function distanceDegrees(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
