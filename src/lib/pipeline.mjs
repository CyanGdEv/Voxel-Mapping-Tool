import path from "node:path";
import { acquireSources } from "./sources.mjs";
import { normalizeMap, refreshMapDerivedData } from "./osm.mjs";
import { enrichUniversalFidelity } from "./fidelity.mjs";
import { enrichOrthophotoEvidence } from "./orthophoto.mjs";
import { enhancePathGeometry } from "./path-geometry.mjs";
import { recoverPathTopology } from "./path-topology.mjs";
import { enrichTerrainDetails } from "./terrain-detail.mjs";
import { integrateRideProfiles, summarizeRideProfiles } from "./ride-profile.mjs";
import { assessAccuracy, enforceAccuracy } from "./confidence.mjs";
import { compileMap } from "./raster.mjs";
import { buildBedrockAddon } from "./bedrock.mjs";
import { buildBedrockWorld } from "./mcworld.mjs";
import { buildEvidenceReport } from "./report.mjs";
import { buildPreviewHtml, buildPreviewSvg } from "./preview.mjs";
import { ensureDir, sha256, slugify, writeJson, writeText } from "./io.mjs";
import {
  compactParkReconstructionGraph,
  reconstructPark,
  reconstructionCompilerMap
} from "./reconstruction-pipeline.mjs";
import { compactPlanningEvidence } from "./planning-manifest.mjs";
import { applyPlanningWorldAuthority } from "./planning-world-authority.mjs";

export async function buildPark(options = {}, progress = () => {}) {
  options = { planningWorldAuthority: "planning-only", ...options };
  progress("Resolving bounded public sources");
  const sources = await acquireSources(options);
  const parkName = sources.parkName;
  const slug = slugify(parkName);
  const outputDir = path.resolve(options.out || path.join("out", slug));
  await ensureDir(outputDir);

  progress("Normalizing map geometry and provenance");
  const map = await normalizeMap(sources, options);
  progress("Repairing source-relative path gaps and area geometry");
  const pathGeometryEvidence = enhancePathGeometry(map, options);
  progress("Measuring image-visible path edges and surface appearance");
  const orthophotoEvidence = enrichOrthophotoEvidence(map, sources, options);
  progress("Recovering image-visible walkable areas and path topology");
  const pathTopologyEvidence = recoverPathTopology(map, sources, options);
  progress("Inventorying dirt paths, rocks, cliffs, and mapped ground detail");
  const terrainDetails = enrichTerrainDetails(map, sources, options);
  progress("Fusing universal path, surface, tree, and bridge evidence");
  const fidelity = enrichUniversalFidelity(map, sources, options);
  progress("Integrating traceable 3D ride evidence");
  const rideProfiles = await integrateRideProfiles({ map, sources, options, progress });
  map.rideProfiles = rideProfiles;
  refreshMapDerivedData(map);
  if (String(options.planningWorldAuthority).toLowerCase() === "planning-only") {
    const finalAuthority = applyPlanningWorldAuthority(map.features, options);
    map.sourceFusion.planningAuthority.world.postEnhancement = finalAuthority;
    map.sourceFusion.planningAuthority.world.zeroOsmWorldFeatures = finalAuthority.zeroOsmWorldFeatures;
    refreshMapDerivedData(map);
  }
  let accuracy = assessAccuracy(map, sources, options);

  progress("Resolving the typed 3D park reconstruction graph");
  const reconstruction = reconstructPark({ parkName, map, sources, accuracy, options });
  map.reconstructionGraph = reconstruction.graph;
  map.rideProfiles = summarizeRideProfiles(map.features, rideProfiles.sourceCatalog || []);
  accuracy = assessAccuracy(map, sources, options);
  reconstruction.graph.sourceState.accuracy = {
    score: accuracy.score,
    grade: accuracy.grade,
    exact3d: accuracy.exact3d
  };
  const reconstructionMap = reconstructionCompilerMap(map);

  progress("Compiling 1 m raster and chunked Bedrock operations");
  const compilation = compileMap({ parkName, map: reconstructionMap, sources, accuracy, options });

  const geojsonPath = await writeJson(path.join(outputDir, `${slug}.geojson`), map.geojson);
  const evidencePath = await writeJson(path.join(outputDir, "evidence.json"), {
    schemaVersion: 2,
    parkName,
    generatedAt: new Date().toISOString(),
    bbox: sources.bbox,
    areaKm2: sources.areaKm2,
    source: {
      geocoder: sources.geocoder,
      osm: withoutLargeData(sources.osm),
      elevation: withoutLargeData(sources.elevation),
      orthophoto: withoutLargeData(sources.orthophoto),
      planning: compactPlanningEvidence(sources.planning),
      supplemental: compactSupplementalSources(sources.supplemental),
      mapFusion: sources.mapFusion,
      acquiredAt: sources.acquiredAt
    },
    fidelity,
    pathGeometry: pathGeometryEvidence.summary,
    pathTopology: pathTopologyEvidence.summary,
    terrainDetails,
    rideProfiles: compactRideEvidence(rideProfiles),
    reconstructionGraph: reconstruction.graph.summary,
    reconstructionDiagnostics: reconstruction.diagnostics,
    accuracy,
    compilation: { meta: compilation.meta, stats: compilation.stats }
  });
  const fidelityPath = await writeJson(path.join(outputDir, "fidelity.json"), fidelity);
  const reconstructionGraphPath = await writeJson(
    path.join(outputDir, "park-reconstruction-graph.json"),
    compactParkReconstructionGraph(reconstruction.graph),
    0
  );
  const planningSourcesPath = await writeJson(
    path.join(outputDir, "planning-sources.json"),
    compactPlanningEvidence(sources.planning)
  );
  const planningDiscoveryPath = sources.planning?.automatic
    ? await writeJson(path.join(outputDir, "planning-discovery.json"), {
        schemaVersion: 1,
        ...sources.planning.discovery,
        applications: compactPlanningEvidence(sources.planning).applications,
        documents: sources.planning.documents,
        failures: sources.planning.failures || [],
        warnings: sources.planning.warnings || []
      })
    : null;
  const sourceAuthorityPath = await writeJson(path.join(outputDir, "source-authority.json"), {
    schemaVersion: 1,
    mode: options.planningWorldAuthority || "planning-only",
    policy: map.sourceFusion?.policy?.worldAuthority || null,
    world: map.sourceFusion?.planningAuthority?.world || null,
    invariant: "OSM and OSM-derived geometry are registration-only and absent from world reconstruction."
  });
  const orthophotoEvidencePath = await writeJson(
    path.join(outputDir, "orthophoto-evidence.json"), orthophotoEvidence.summary
  );
  const orthophotoQaPath = await writeJson(
    path.join(outputDir, "orthophoto-qa.geojson"), orthophotoEvidence.qaGeojson
  );
  const pathGeometryEvidencePath = await writeJson(
    path.join(outputDir, "path-geometry-evidence.json"), pathGeometryEvidence.summary
  );
  const pathGeometryQaPath = await writeJson(
    path.join(outputDir, "path-geometry-qa.geojson"), pathGeometryEvidence.qaGeojson
  );
  const pathTopologyEvidencePath = await writeJson(
    path.join(outputDir, "path-topology-evidence.json"), pathTopologyEvidence.summary
  );
  const pathTopologyQaPath = await writeJson(
    path.join(outputDir, "path-topology-qa.geojson"), pathTopologyEvidence.qaGeojson
  );
  const terrainDetailsPath = await writeJson(
    path.join(outputDir, "terrain-detail-evidence.json"), terrainDetails
  );
  const sourceFusionPath = await writeJson(
    path.join(outputDir, "source-fusion.json"), map.sourceFusion
  );
  const supplementalSourcesPath = await writeJson(
    path.join(outputDir, "supplemental-sources.json"), compactSupplementalSources(sources.supplemental)
  );
  const buildingSigns = compilation.signs.filter((sign) => !sign.role || sign.role === "building");
  const buildingLabelsPath = await writeJson(path.join(outputDir, "building-labels.json"), {
    schemaVersion: 1,
    parkName,
    mode: compilation.meta.buildingMode,
    count: buildingSigns.length,
    labels: buildingSigns.map((sign) => ({
      featureId: sign.featureId,
      featureKind: sign.featureKind,
      name: sign.name,
      displayedText: sign.text,
      coordinates: {
        x: sign.x,
        y: compilation.meta.baseY + sign.y,
        z: sign.z,
        relativeY: sign.y
      },
      placement: {
        method: sign.placementSource,
        entranceFeatureId: sign.entranceFeatureId,
        distanceToMappedPathM: sign.distanceToMappedPathM,
        overlapsMappedPath: sign.overlapsMappedPath
      }
    }))
  });
  const rideProfilesPath = await writeJson(path.join(outputDir, "ride-profiles.json"), rideProfiles);
  const reportPath = await writeText(path.join(outputDir, "ACCURACY_REPORT.md"), buildEvidenceReport({
    parkName, sources, map, accuracy, compilation
  }));

  let previewSvgPath = null, previewHtmlPath = null;
  if (!options.noPreview) {
    const svg = buildPreviewSvg(parkName, map, accuracy);
    previewSvgPath = await writeText(path.join(outputDir, "preview.svg"), svg);
    previewHtmlPath = await writeText(path.join(outputDir, "preview.html"), buildPreviewHtml(parkName, svg, accuracy));
  }

  // Strict mode deliberately writes its evidence and preview before refusing
  // to create either Minecraft output.
  enforceAccuracy(accuracy, options);

  let addon = null;
  let world = null;
  if (!options.noWorld) {
    progress("Writing a complete Minecraft Bedrock .mcworld");
    world = await buildBedrockWorld({ parkName, slug, compilation, outputDir, options, progress });
  }
  if (!options.noAddon) {
    progress("Packaging the Minecraft Bedrock builder add-on");
    addon = await buildBedrockAddon({ parkName, slug, compilation, outputDir, options });
  }

  const result = {
    parkName,
    slug,
    outputDir,
    confidence: accuracy.score,
    grade: accuracy.grade,
    exact3d: accuracy.exact3d,
    paths: {
      geojson: geojsonPath,
      evidence: evidencePath,
      fidelity: fidelityPath,
      reconstructionGraph: reconstructionGraphPath,
      planningSources: planningSourcesPath,
      planningDiscovery: planningDiscoveryPath,
      sourceAuthority: sourceAuthorityPath,
      orthophotoEvidence: orthophotoEvidencePath,
      orthophotoQa: orthophotoQaPath,
      pathGeometryEvidence: pathGeometryEvidencePath,
      pathGeometryQa: pathGeometryQaPath,
      pathTopologyEvidence: pathTopologyEvidencePath,
      pathTopologyQa: pathTopologyQaPath,
      terrainDetails: terrainDetailsPath,
      sourceFusion: sourceFusionPath,
      supplementalSources: supplementalSourcesPath,
      buildingLabels: buildingLabelsPath,
      rideProfiles: rideProfilesPath,
      report: reportPath,
      previewSvg: previewSvgPath,
      previewHtml: previewHtmlPath,
      world: world?.mcworldPath || null,
      worldManifest: world?.worldManifestPath || null,
      blockPalette: world?.palettePath || null,
      addon: addon?.addonPath || null,
      behaviorPack: addon?.packRoot || null
    },
    stats: {
      ...compilation.stats,
      worldChunks: world?.chunkCount || 0,
      worldValidation: world?.validation?.status || null
    },
    warnings: accuracy.gaps
  };
  await writeJson(path.join(outputDir, "build-result.json"), result);
  progress("Build complete");
  return result;
}

function withoutLargeData(value) {
  if (!value) return value;
  const { data, points, query, ...rest } = value;
  return {
    ...rest,
    dataHash: data ? sha256(data) : undefined,
    pointCount: points?.length,
    query: query || undefined
  };
}

function compactRideEvidence(value) {
  if (!value) return value;
  const { profiles, ...summary } = value;
  return {
    ...summary,
    profiles: (profiles || []).map(({ profile, ...entry }) => ({
      ...entry,
      profile: {
        schemaVersion: profile.schemaVersion,
        method: profile.method,
        source: profile.source,
        sampleCount: profile.sampleCount,
        evidenceCounts: profile.evidenceCounts,
        coverage: profile.coverage,
        confidence: profile.confidence,
        heightRangeM: profile.heightRangeM,
        bankingMethod: profile.bankingMethod,
        warnings: profile.warnings,
        validation: profile.validation
      }
    }))
  };
}

function compactSupplementalSources(value) {
  if (!value) return value;
  return {
    schemaVersion: value.schemaVersion,
    status: value.status,
    featureCount: value.featureCount || 0,
    collectionCount: value.collectionCount || 0,
    providers: value.providers || {},
    warnings: value.warnings || [],
    failures: value.failures || [],
    evidence: value.evidence || {},
    collections: (value.collections || []).map((entry) => ({
      id: entry.id, adapter: entry.adapter, provider: entry.provider, endpoint: entry.endpoint,
      cacheHit: entry.cacheHit, request: entry.request, featureCount: entry.collection?.features?.length || 0,
      source: entry.collection?.source || null
    }))
  };
}
