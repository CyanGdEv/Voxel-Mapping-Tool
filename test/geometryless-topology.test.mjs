import assert from "node:assert/strict";
import test from "node:test";
import { refreshMapDerivedData } from "../src/lib/osm.mjs";

test("derived map summaries preserve geometry-less evidence without crashing", () => {
  const map = {
    geojson: { name: "Production-shaped park" },
    features: [
      {
        id: "ride:evidence-only",
        name: "3D ride evidence",
        kind: "ride_track",
        subtype: "evidence",
        geometry: undefined,
        tags: undefined,
        source: { provider: "planning-ride-evidence" },
        vertical: {},
        verification: { plan: "planning" }
      },
      {
        id: "planning:polygon",
        name: "Valid polygon",
        kind: "surface",
        subtype: "planning",
        geometry: { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,0]]] },
        tags: {},
        source: { provider: "planning", elementType: "relation" },
        vertical: {},
        verification: { plan: "planning" }
      }
    ]
  };

  assert.doesNotThrow(() => refreshMapDerivedData(map));
  assert.equal(map.geojson.features[0].geometry, null);
  assert.equal(map.topology.polygonFeatures, 1);
  assert.equal(map.topology.relationFeatures, 1);
  assert.equal(map.semantics.bridges, 0);
});
