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
