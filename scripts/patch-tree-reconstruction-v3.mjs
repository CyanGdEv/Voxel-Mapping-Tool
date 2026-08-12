import { readFile, writeFile } from "node:fs/promises";

async function patchTreeReconstruction() {
  const path = new URL("../src/lib/tree-reconstruction.mjs", import.meta.url);
  let s = await readFile(path, "utf8");
  s = s.replace(
    `      key, label: anchor.id, anchor,\n      bottleneck: anchor.cell.canopyHeightM,\n      distance: Math.hypot(anchor.cell.x - anchor.x, anchor.cell.z - anchor.z)`,
    `      key, label: anchor.id, anchor, targetX: anchor.cell.x, targetZ: anchor.cell.z,\n      bottleneck: anchor.cell.canopyHeightM,\n      distance: Math.hypot(anchor.cell.x - anchor.x, anchor.cell.z - anchor.z)`
  );
  s = s.replace(
    `        anchor: state.anchor,\n        bottleneck: Math.min(state.bottleneck, next.canopyHeightM),`,
    `        anchor: state.anchor, targetX: next.x, targetZ: next.z,\n        bottleneck: Math.min(state.bottleneck, next.canopyHeightM),`
  );
  s = s.replace(
    `  const candidateDirect = Math.hypot(candidate.anchor.x - cellX(candidate.key), candidate.anchor.z - cellZ(candidate.key));\n  const currentDirect = Math.hypot(current.anchor.x - cellX(current.key), current.anchor.z - cellZ(current.key));`,
    `  const candidateDirect = Math.hypot(candidate.anchor.x - candidate.targetX, candidate.anchor.z - candidate.targetZ);\n  const currentDirect = Math.hypot(current.anchor.x - current.targetX, current.anchor.z - current.targetZ);`
  );
  s = s.replace(/\nfunction cellX\(key\) \{[^\n]+\}\nfunction cellZ\(key\) \{[^\n]+\}/, "");
  if (!s.includes("targetX: next.x, targetZ: next.z")) throw new Error("tree reconstruction flood target patch failed");
  await writeFile(path, s);
}

async function patchFidelity() {
  const path = new URL("../src/lib/fidelity.mjs", import.meta.url);
  let s = await readFile(path, "utf8");

  const treeHeader = `  const treeFeatures = map.features.filter((feature) => feature.kind === "vegetation");`;
  const treeHeaderNew = `${treeHeader}\n  const mappedTreeSeeds = treeFeatures\n    .filter((feature) => vegetationModelClass(feature) === "tree")\n    .map((feature) => ({ id: feature.id, point: geometryPoint(feature.localGeometry) }))\n    .filter((entry) => entry.point)\n    .map((entry) => ({ id: entry.id, x: entry.point[0], z: entry.point[1] }));`;
  if (!s.includes("const mappedTreeSeeds = treeFeatures")) s = s.replace(treeHeader, treeHeaderNew);

  s = s.replace(
    `feature.fidelity.tree = deriveTreeEvidence(feature, sources, options);`,
    `feature.fidelity.tree = deriveTreeEvidence(feature, sources, options, mappedTreeSeeds);`
  );
  s = s.replace(
    `function deriveTreeEvidence(feature, sources, options) {`,
    `function deriveTreeEvidence(feature, sources, options, mappedTreeSeeds = []) {`
  );
  s = s.replace(
    `? deriveTreeCrownReconstruction({ point, crownDiameter, heightM, elevation: sources.elevation, options })`,
    `? deriveTreeCrownReconstruction({ point, crownDiameter, heightM, elevation: sources.elevation, options, mappedTreeSeeds, featureId: feature.id })`
  );
  s = s.replace(
    `    crownSource = "dsm-dtm-connected-canopy";`,
    `    crownSource = reconstruction.source || "dsm-dtm-connected-canopy";`
  );
  s = s.replace(
    `    crownBaseHeightM: reconstruction?.crownBaseHeightM ?? null,`,
    `    crownBaseHeightM: reconstruction?.crownBaseHeightM ?? null,\n    touchingSamplesRejected: reconstruction?.touchingSamplesRejected || 0,\n    watershedCompetitors: reconstruction?.watershedCompetitors || 0,`
  );
  s = s.replace(
    `function deriveTreeCrownReconstruction({ point, crownDiameter, heightM, elevation, options }) {`,
    `function deriveTreeCrownReconstruction({ point, crownDiameter, heightM, elevation, options, mappedTreeSeeds = [], featureId = null }) {`
  );

  const samplesAnchor = `  const samples = [];`;
  const samplesNew = `  const competitorSeeds = mappedTreeSeeds\n    .filter((seed) => seed.id !== featureId)\n    .filter((seed) => Math.hypot(seed.x - point[0], seed.z - point[1]) <= searchRadiusM + Math.max(3, sampleStepM * 3))\n    .map((seed) => ({ x: seed.x, z: seed.z, id: seed.id }));\n  const samples = [];`;
  const crownFnIndex = s.indexOf("function deriveTreeCrownReconstruction");
  if (crownFnIndex < 0) throw new Error("deriveTreeCrownReconstruction missing");
  const samplesIndex = s.indexOf(samplesAnchor, crownFnIndex);
  if (samplesIndex >= 0 && !s.slice(crownFnIndex, samplesIndex + 500).includes("const competitorSeeds = mappedTreeSeeds")) {
    s = s.slice(0, samplesIndex) + samplesNew + s.slice(samplesIndex + samplesAnchor.length);
  }
  s = s.replace(
    `    maxSeedDistanceM: Math.max(2, Number(options.treeCrownSeedDistanceM ?? 3))\n  });`,
    `    maxSeedDistanceM: Math.max(2, Number(options.treeCrownSeedDistanceM ?? 3)),\n    competitorSeeds\n  });`
  );

  s = s.replace(
    `    crownEvidenced: entries.filter((entry) => entry.crownDiameterM !== null).length,`,
    `    crownEvidenced: entries.filter((entry) => entry.crownDiameterM !== null).length,\n    watershedSeparated: entries.filter((entry) => entry.watershedCompetitors > 0 && entry.touchingSamplesRejected > 0).length,`
  );

  for (const required of [
    "mappedTreeSeeds, featureId: feature.id",
    "const competitorSeeds = mappedTreeSeeds",
    "competitorSeeds\n  });",
    "watershedSeparated:"
  ]) if (!s.includes(required)) throw new Error(`fidelity V3 integration missing: ${required}`);
  await writeFile(path, s);
}

async function patchVegetationTests() {
  const path = new URL("../test/appearance-vegetation.test.mjs", import.meta.url);
  let s = await readFile(path, "utf8");
  if (s.includes('test("mapped touching trees use each other as LiDAR watershed seeds"')) return;
  s += `\n\ntest("mapped touching trees use each other as LiDAR watershed seeds", () => {\n  const left = {\n    id: "tree:left", kind: "vegetation", subtype: "tree", tags: {},\n    localGeometry: { type: "Point", coordinates: [0, 0] }, source: { provider: "fixture" }\n  };\n  const right = {\n    id: "tree:right", kind: "vegetation", subtype: "tree", tags: {},\n    localGeometry: { type: "Point", coordinates: [6, 0] }, source: { provider: "fixture" }\n  };\n  const canopy = (x, z) => Math.max(13 - Math.hypot(x, z) * 1.35, 12.5 - Math.hypot(x - 6, z) * 1.25, 0);\n  const elevation = {\n    resolutionM: 1,\n    samplePairLocal(x, z) {\n      const height = canopy(x, z);\n      return { terrain: 100, surface: 100 + height };\n    }\n  };\n  const map = { features: [left, right] };\n  enrichUniversalFidelity(map, { elevation }, { accuracyMode: "verified", treeCrownSearchRadiusM: 9 });\n  assert.equal(left.fidelity.tree.crownShapeSource, "dsm-dtm-seeded-watershed");\n  assert.equal(right.fidelity.tree.crownShapeSource, "dsm-dtm-seeded-watershed");\n  assert.ok(left.fidelity.tree.touchingSamplesRejected > 0);\n  assert.ok(right.fidelity.tree.touchingSamplesRejected > 0);\n  assert.equal(map.fidelity.trees.watershedSeparated, 2);\n});\n`;
  await writeFile(path, s);
}

await patchTreeReconstruction();
await patchFidelity();
await patchVegetationTests();
console.log("Applied Tree Reconstruction V3 watershed integration");
