import assert from "node:assert/strict";
import test from "node:test";
import { assessAccuracy, enforceAccuracy } from "../src/lib/confidence.mjs";

test("strict one-block centreline output reports absent or partial ride elevation without blocking", () => {
  for (const verticalCoverage of [0, 0.5]) {
    const accuracy = assessAccuracy(accuracyFixture(verticalCoverage), sourceFixture(), {
      strict: true,
      minConfidence: 0
    });
    const expectedCode = verticalCoverage
      ? "RIDE_VERTICAL_GEOMETRY_PARTIAL"
      : "RIDE_VERTICAL_GEOMETRY_ABSENT";
    const gap = accuracy.gaps.find((item) => item.code === expectedCode);

    assert.equal(gap?.severity, "high");
    assert.match(gap?.message || "", /one-block centreline/i);
    assert.equal(accuracy.exact3d, false);
    assert.doesNotThrow(() => enforceAccuracy(accuracy, { strict: true, minConfidence: 0 }));
  }
});

test("strict verified output reports unresolved ride attachments without blocking when they are withheld", () => {
  const map = accuracyFixture(0.5);
  map.features.push({
    id: "ride-attachment:test",
    kind: "ride_attachment",
    source: map.features[0].source,
    vertical: { heightM: null, heightSource: null },
    rideAttachmentReconstruction: { status: "withheld" }
  });

  const accuracy = assessAccuracy(map, sourceFixture(), { strict: true, minConfidence: 0 });
  const gap = accuracy.gaps.find((item) => item.code === "RIDE_ATTACHMENTS_WITHHELD");

  assert.equal(gap?.severity, "high");
  assert.match(gap?.message || "", /withholds them/i);
  assert.equal(accuracy.exact3d, false);
  assert.doesNotThrow(() => enforceAccuracy(accuracy, { strict: true, minConfidence: 0 }));
});

test("strict verified output reports plan-only bridge heights without blocking", () => {
  const map = accuracyFixture(0.5);
  map.fidelity.bridges = { mappedFeatures: 2, verticalEvidenced: 1, planOnly: 1 };

  const accuracy = assessAccuracy(map, sourceFixture(), { strict: true, minConfidence: 0 });
  const gap = accuracy.gaps.find((item) => item.code === "BRIDGE_VERTICAL_GEOMETRY_PARTIAL");

  assert.equal(gap?.severity, "high");
  assert.match(gap?.message || "", /instead of inventing deck height/i);
  assert.equal(accuracy.exact3d, false);
  assert.doesNotThrow(() => enforceAccuracy(accuracy, { strict: true, minConfidence: 0 }));
});

test("strict evidence gate still blocks genuinely critical geometry failures", () => {
  const map = accuracyFixture(0.5);
  map.boundary = { verified: false, subtype: "unknown" };
  const accuracy = assessAccuracy(map, sourceFixture(), { strict: true, minConfidence: 0 });
  const gap = accuracy.gaps.find((item) => item.code === "BOUNDARY_UNVERIFIED");

  assert.equal(gap?.severity, "critical");
  assert.throws(
    () => enforceAccuracy(accuracy, { strict: true, minConfidence: 0 }),
    /Strict evidence gate failed/
  );
});

function accuracyFixture(verticalCoverage) {
  const source = { provider: "official planning fixture", timestamp: "2026-08-13T00:00:00.000Z" };
  return {
    boundary: { verified: true, subtype: "planning-boundary" },
    features: [
      {
        id: "ride:test",
        kind: "ride_track",
        source,
        vertical: { heightM: null, heightSource: null },
        rideProfile: verticalCoverage ? {
          coverage: { vertical: verticalCoverage, banking: 0 },
          parts: [[
            { elevationM: 100, evidence: "planning-drawing" },
            { elevationM: null, evidence: "none" }
          ]]
        } : null
      },
      { id: "path:test", kind: "path", source, vertical: { heightM: null, heightSource: null } }
    ],
    rideProfiles: { totals: { verticalCoverage, bankingCoverage: 0 } },
    fidelity: {
      surfaces: { widthCoverage: 1, materialCoverage: 1, colourCoverage: 1, explicitPatternCoverage: 1 },
      pathNetwork: { components: 1 },
      trees: { mappedFeatures: 1, heightEvidenced: 1 },
      bridges: { mappedFeatures: 0, verticalEvidenced: 0 }
    },
    pathGeometry: {},
    pathTopology: {}
  };
}

function sourceFixture() {
  return {
    elevation: {
      provider: "fixture-dtm",
      resolutionM: 1,
      dtm: { coverage: 100 },
      structureHeightStats: { conflicts: 0 }
    }
  };
}
