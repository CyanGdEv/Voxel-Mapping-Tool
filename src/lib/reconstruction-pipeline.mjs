import {
  buildParkReconstructionGraph,
  compactParkReconstructionGraph,
  reconstructionCompilerMap,
  validateParkReconstructionGraph
} from "./park-reconstruction-graph.mjs";
import { buildTerrainSurfaceModel, validateTerrainSurfaceModel } from "./terrain-surface-model.mjs";
import { solveParkVerticalEvidence, validateVerticalResolution } from "./vertical-evidence-engine.mjs";
import { reconstructBuildingRoofs, validateBuildingReconstructions } from "./building-roof-reconstruction.mjs";
import { solveRideVerticalProfiles, validateRideVerticalProfiles } from "./ride-vertical-profile.mjs";
import { buildRide3dGeometry, validateRide3dGeometry } from "./ride-3d-geometry.mjs";
import { reconstructRideAttachments, validateRideAttachmentReconstructions } from "./ride-attachment-reconstruction.mjs";
import { classifyRideTerrainInteractions, validateRideTerrainInteractions } from "./ride-terrain-interaction.mjs";
import { reconstructRideSupports, validateRideSupportReconstructions } from "./ride-support-reconstruction.mjs";
import { reconstructVegetation, validateVegetationReconstructions } from "./vegetation-reconstruction.mjs";

export function reconstructPark({ parkName, map, sources, accuracy, options = {} }) {
  const graph = buildParkReconstructionGraph({ parkName, map, sources, accuracy, options });
  const diagnostics = {};
  const planningOnly = String(options.planningWorldAuthority || "planning-only").toLowerCase() === "planning-only";

  if (!planningOnly) {
    graph.summary.reconstructionPipeline = {
      marker: "VOXEL_MAPPING_RECONSTRUCTION_PIPELINE_V1",
      stages: [],
      status: "advanced-reconstruction-skipped-for-explicit-fixture-mode",
      planningWorldAuthority: options.planningWorldAuthority
    };
    validateParkReconstructionGraph(graph);
    return { graph, diagnostics };
  }

  diagnostics.terrainSurface = buildTerrainSurfaceModel(graph, sources, options);
  validateTerrainSurfaceModel(graph);

  diagnostics.vertical = solveParkVerticalEvidence(graph, options);
  validateVerticalResolution(graph);

  diagnostics.buildings = reconstructBuildingRoofs(graph, sources, options);
  validateBuildingReconstructions(graph);

  diagnostics.rideProfiles = solveRideVerticalProfiles(graph, options);
  validateRideVerticalProfiles(graph);

  diagnostics.rides3d = buildRide3dGeometry(graph, options);
  validateRide3dGeometry(graph);

  diagnostics.rideAttachments = reconstructRideAttachments(graph, options);
  validateRideAttachmentReconstructions(graph);

  diagnostics.rideTerrain = classifyRideTerrainInteractions(graph, sources, options);
  validateRideTerrainInteractions(graph);

  diagnostics.rideSupports = reconstructRideSupports(graph, options);
  validateRideSupportReconstructions(graph);

  diagnostics.vegetation = reconstructVegetation(graph, sources, options);
  validateVegetationReconstructions(graph);

  projectReconstructionToCompilerFeatures(graph);

  graph.summary.reconstructionPipeline = {
    marker: "VOXEL_MAPPING_RECONSTRUCTION_PIPELINE_V1",
    stages: Object.keys(diagnostics),
    status: "complete",
    planningWorldAuthority: options.planningWorldAuthority || "planning-only"
  };
  validateParkReconstructionGraph(graph, {
    requirePlanningOnlyClean: String(options.planningWorldAuthority || "planning-only") === "planning-only"
  });
  return { graph, diagnostics };
}

function projectReconstructionToCompilerFeatures(graph) {
  for (const node of graph.nodes) {
    const feature = node.sourceFeature;
    if (!feature) continue;
    feature.reconstruction = {
      verticalStatus: node.verticalResolution?.status || null,
      buildingStatus: node.buildingReconstruction?.status || null,
      ride3dStatus: node.geometry3d?.status || null,
      supportStatus: node.supportReconstruction?.status || null,
      rideAttachmentStatus: node.rideAttachmentReconstruction?.status || null,
      authority: "planning-reconstruction-graph"
    };
    feature.vertical ||= {};
    if (Number.isFinite(node.vertical?.heightM)) feature.vertical.heightM = node.vertical.heightM;
    // A sampled terrain/base level is not an explicit object elevation. Keeping
    // these fields separate prevents every 2D ride line from being promoted to
    // a supposedly verified flat 3D track.
    if (Number.isFinite(node.vertical?.baseElevationM)) feature.vertical.baseElevationM = node.vertical.baseElevationM;
    if (Number.isFinite(node.vertical?.groundElevationM)) feature.vertical.groundElevationM = node.vertical.groundElevationM;

    const building = node.buildingReconstruction;
    if (building) {
      feature.buildingReconstruction = building;
      if (building.status === "resolved" && Number.isFinite(building.heightM)) {
        feature.vertical.heightM = building.heightM;
        feature.vertical.baseElevationM = building.baseElevationM;
        feature.vertical.explicit = true;
        feature.vertical.heightSource = String(building.authority?.top || "").includes("dsm")
          ? "phase34-dsm-minus-dtm"
          : "phase34-planning-roof";
      }
    }

    const geometry3d = node.geometry3d;
    if (!feature.rideProfile && geometry3d && ["resolved", "partial"].includes(geometry3d.status)) {
      const samples = geometry3d.samples.map((sample) => ({
        x: sample.x,
        z: sample.z,
        elevationM: sample.resolved ? sample.y : null,
        bankingDeg: null,
        evidence: sample.resolved ? "planning-verified" : "none",
        confidence: sample.resolved ? node.confidence?.vertical ?? node.confidence?.overall ?? 0.8 : 0,
        sourceRef: node.evidence?.sourceUrl || node.evidence?.planningReference || node.id
      }));
      const resolved = samples.filter((sample) => Number.isFinite(sample.elevationM));
      feature.rideProfile = {
        schemaVersion: 1,
        representation: "one-block-centreline",
        widthBlocks: 1,
        bankingRendered: false,
        crossTiesRendered: false,
        method: "planning-elevation-anchors",
        source: {
          provider: feature.source?.provider || "Planning authority",
          sourceUrl: feature.source?.sourceUrl || null,
          timestamp: feature.source?.timestamp || null,
          license: feature.source?.license || null
        },
        coordinateReference: { horizontal: "local 1 m map grid", elevation: "metres ODN/declared planning datum" },
        parts: [samples],
        sampleCount: samples.length,
        evidenceCounts: {
          "planning-verified": resolved.length,
          none: samples.length - resolved.length
        },
        coverage: { vertical: samples.length ? resolved.length / samples.length : 0, banking: 0 },
        confidence: resolved.length
          ? resolved.reduce((sum, sample) => sum + sample.confidence, 0) / resolved.length
          : 0,
        heightRangeM: resolved.length ? {
          min: Math.min(...resolved.map((sample) => sample.elevationM)),
          max: Math.max(...resolved.map((sample) => sample.elevationM))
        } : null,
        bankingMethod: "not-rendered-one-block-centreline",
        warnings: ["Banking and cross ties are outside the one-block centreline representation."],
        validation: { policy: geometry3d.policy, graphNode: node.id }
      };
      feature.verification ||= {};
      feature.verification.vertical = geometry3d.status === "resolved"
        ? "planning-verified"
        : "planning-verified-partial";
    }

    if (node.supportReconstruction) {
      feature.supportReconstruction = node.supportReconstruction;
      if (node.supportReconstruction.status === "resolved") {
        feature.vertical.heightM = node.supportReconstruction.verticalHeightM;
        feature.vertical.explicit = true;
      }
    }

    if (node.rideAttachmentReconstruction) {
      feature.rideAttachmentReconstruction = node.rideAttachmentReconstruction;
    }
  }
}

export { compactParkReconstructionGraph, reconstructionCompilerMap };
