import { UserError } from "./errors.mjs";

const WEIGHTS = {
  boundary: 0.18,
  planimetry: 0.24,
  rides: 0.22,
  structures: 0.16,
  terrain: 0.14,
  freshness: 0.06
};

export function assessAccuracy(map, sources, options = {}) {
  const features = map.features;
  const counts = countBy(features, (feature) => feature.kind);
  const buildings = features.filter((feature) => feature.kind === "building");
  const tracks = features.filter((feature) => feature.kind === "ride_track");
  const rideAttachments = features.filter((feature) => feature.kind === "ride_attachment");
  const attractions = features.filter((feature) => feature.kind === "attraction");
  const paths = features.filter((feature) => ["path", "road"].includes(feature.kind));
  const fidelity = map.fidelity || {};
  const surfaceEvidence = fidelity.surfaces || {};
  const pathNetwork = fidelity.pathNetwork || {};
  const pathGeometry = map.pathGeometry || {};
  const pathTopology = map.pathTopology || {};
  const treeEvidence = fidelity.trees || {};
  const bridgeEvidence = fidelity.bridges || {};
  const explicitBuildings = buildings.filter((feature) => feature.vertical.heightM !== null);
  const lidarMeasuredBuildings = buildings.filter((feature) =>
    String(feature.vertical.heightSource || "").endsWith("dsm-minus-dtm"));
  const taggedBuildings = explicitBuildings.filter((feature) =>
    !String(feature.vertical.heightSource || "").endsWith("dsm-minus-dtm"));
  const profiledTracks = tracks.filter((feature) => feature.rideProfile?.coverage?.vertical > 0);
  const fullElevationTracks = tracks.filter((feature) => feature.rideProfile?.coverage?.vertical >= 0.999);
  const rideVerticalCoverage = clamp(map.rideProfiles?.totals?.verticalCoverage || 0);
  const resolvedRideAttachments = rideAttachments.filter((feature) => feature.rideAttachmentReconstruction?.status === "resolved");
  const rideEvidenceCounts = aggregateRideEvidence(tracks);
  const explicitTunnelTracks = tracks.filter(hasRideTunnelSemantics);
  const tunnelProfileGaps = explicitTunnelTracks.reduce((sum, feature) => sum +
    (feature.rideProfile?.parts || []).flat().filter((sample) => !Number.isFinite(sample.elevationM)).length, 0);
  const misalignedProfiles = tracks.filter((feature) =>
    feature.rideProfile?.planSemantics?.alignment?.status === "review-required");
  const dated = features.map((feature) => Date.parse(feature.source.timestamp)).filter(Number.isFinite);
  const newest = dated.length ? new Date(Math.max(...dated)).toISOString() : null;
  const ageDays = dated.length ? (Date.now() - Math.max(...dated)) / 86_400_000 : null;

  const boundary = map.boundary.verified ? 1 : map.boundary.subtype === "geocoder-polygon" ? 0.75 : 0.25;
  const planimetry = clamp(
    0.2 + Math.min(0.45, features.length / 200) +
    (counts.path ? 0.08 : 0) + (counts.building ? 0.11 : 0) + (counts.water ? 0.08 : 0) +
    0.04 * (surfaceEvidence.widthCoverage || 0) +
    0.04 * (surfaceEvidence.materialCoverage || 0) +
    0.04 * (surfaceEvidence.colourCoverage || 0)
  );
  const rides = clamp(
    (attractions.length ? 0.2 : 0) + (tracks.length ? 0.3 : 0) +
    0.5 * rideVerticalCoverage
  );
  const structures = buildings.length
    ? clamp(0.45 + 0.55 * (explicitBuildings.length / buildings.length))
    : 0;
  const terrainCoverage = Number.isFinite(sources.elevation?.dtm?.coverage)
    ? clamp(sources.elevation.dtm.coverage / 100)
    : 1;
  const terrain = sources.elevation.provider === "none" ? 0.1
    : (sources.elevation.resolutionM <= 5 ? 0.95
      : sources.elevation.resolutionM <= 30 ? 0.75 : 0.45) * terrainCoverage;
  const freshness = ageDays === null ? 0.25
    : ageDays <= 180 ? 1
      : ageDays <= 730 ? 0.75
        : ageDays <= 1825 ? 0.5 : 0.2;

  const components = { boundary, planimetry, rides, structures, terrain, freshness };
  const overall = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + components[key] * weight, 0);
  const gaps = [];
  if (!map.boundary.verified) gaps.push({ severity: "critical", code: "BOUNDARY_UNVERIFIED", message: "No verified park polygon was found." });
  if (!tracks.length) gaps.push({ severity: "high", code: "RIDE_TRACKS_ABSENT", message: "No roller-coaster track centreline was found in public map data." });
  else if (!rideVerticalCoverage) gaps.push({ severity: "critical", code: "RIDE_VERTICAL_GEOMETRY_ABSENT", message: "Ride tracks have public plan geometry but no measured or verified elevation profile." });
  else if (rideVerticalCoverage < 0.999) gaps.push({ severity: "critical", code: "RIDE_VERTICAL_GEOMETRY_PARTIAL", message: `Measured/verified ride elevation covers ${(rideVerticalCoverage * 100).toFixed(1)}% of mapped track length; remaining sections stay visibly 2D-only except explicitly tunnel-tagged gaps may use disclosed terrain-constrained inference when enabled.` });
  const interpolatedRideSamples = (rideEvidenceCounts.interpolated || 0) + (rideEvidenceCounts["interpolated-lidar"] || 0);
  if (interpolatedRideSamples) gaps.push({ severity: "medium", code: "RIDE_PROFILE_INTERPOLATED", message: `${interpolatedRideSamples} ride-profile sample(s) are explicitly bounded interpolation rather than direct observations.` });
  if (rideEvidenceCounts.inferred) gaps.push({ severity: "high", code: "RIDE_PROFILE_INFERRED", message: `${rideEvidenceCounts.inferred} ride-profile sample(s) are inferred rather than measured or verified.` });
  if (tunnelProfileGaps && (options.rideTerrainMode || "inferred") === "inferred") gaps.push({
    severity: "high", code: "RIDE_TUNNEL_HEIGHT_INFERRED",
    message: `${explicitTunnelTracks.length} mapped tunnel feature(s) contain ${tunnelProfileGaps} hidden profile sample gap(s); tunnel topology is source-tagged, while missing height is DTM-constrained inference and renders yellow.`
  });
  if (tunnelProfileGaps && options.rideTerrainMode === "evidence") gaps.push({
    severity: "critical", code: "RIDE_TUNNEL_VERTICAL_PARTIAL",
    message: `${explicitTunnelTracks.length} mapped tunnel feature(s) contain ${tunnelProfileGaps} hidden profile sample gap(s); evidence mode excavates only height-evidenced portions.`
  });
  if (resolvedRideAttachments.length < rideAttachments.length) gaps.push({
    severity: "critical", code: "RIDE_ATTACHMENTS_WITHHELD",
    message: `${rideAttachments.length - resolvedRideAttachments.length} of ${rideAttachments.length} detected ride attachment feature(s) lack enough vertical/ride evidence to compile without fabrication.`
  });
  if (misalignedProfiles.length) gaps.push({
    severity: "critical", code: "RIDE_PLAN_PROFILE_MISALIGNED",
    message: `${misalignedProfiles.length} replacement 3D ride profile(s) deviate by more than 3 m from the source plan geometry and require review.`
  });
  if (explicitBuildings.length < buildings.length) gaps.push({ severity: "high", code: "BUILDING_HEIGHTS_PARTIAL", message: `${buildings.length - explicitBuildings.length} building footprints have neither a public height tag nor a usable LiDAR measurement.` });
  const lidarConflicts = sources.elevation?.structureHeightStats?.conflicts || 0;
  if (lidarConflicts) gaps.push({ severity: "medium", code: "BUILDING_HEIGHT_CONFLICTS", message: `${lidarConflicts} tagged building heights differ materially from the LiDAR DSM-minus-DTM measurement; tagged values were preserved for review.` });
  if (sources.elevation.provider === "none") gaps.push({ severity: "high", code: "TERRAIN_FLAT_DATUM", message: "No elevation dataset was selected." });
  else if (sources.elevation.resolutionM > 10) gaps.push({ severity: "high", code: "TERRAIN_NOT_SURVEY_GRADE", message: `Terrain resolution is ${sources.elevation.resolutionM} m, not 1 m survey data.` });
  if (sources.elevation.provider !== "none" && terrainCoverage < 0.99) gaps.push({ severity: "high", code: "TERRAIN_COVERAGE_PARTIAL", message: `Valid terrain cells cover ${(terrainCoverage * 100).toFixed(1)}% of the selected raster; uncovered cells use the build datum.` });
  if (!counts.path) gaps.push({ severity: "high", code: "PATH_NETWORK_ABSENT", message: "No guest path network was found." });
  else {
    const inferredWidths = surfaceEvidence.widthStatusFeatures?.["class-prior"] || 0;
    const markerWidths = surfaceEvidence.widthStatusFeatures?.["unknown-marker"] || 0;
    const imageWidths = surfaceEvidence.widthStatusFeatures?.["orthophoto-edge-observed"] || 0;
    if ((surfaceEvidence.widthCoverage || 0) < 0.999) gaps.push({
      severity: "medium", code: "PATH_WIDTHS_PARTIAL",
      message: `Observed/tag-derived width covers ${((surfaceEvidence.widthCoverage || 0) * 100).toFixed(1)}% of mapped linear route length; ${imageWidths} segment(s) use accepted orthophoto edges, ${inferredWidths} use disclosed route-class priors, and ${markerWidths} remain one-block markers.`
    });
    if ((surfaceEvidence.materialCoverage || 0) < 0.999) gaps.push({
      severity: "high", code: "PATH_MATERIALS_PARTIAL",
      message: `Observed path material covers ${((surfaceEvidence.materialCoverage || 0) * 100).toFixed(1)}% of mapped route length.`
    });
    if ((surfaceEvidence.colourCoverage || 0) < 0.999) gaps.push({
      severity: "high", code: "PATH_COLOURS_PARTIAL",
      message: `Observed path colour covers ${((surfaceEvidence.colourCoverage || 0) * 100).toFixed(1)}% of mapped route length; unknown surfaces use a visible fallback.`
    });
    if ((surfaceEvidence.explicitPatternCoverage || 0) < 0.999) gaps.push({
      severity: "medium", code: "PATH_PATTERNS_PARTIAL",
      message: `Observed laying pattern covers ${((surfaceEvidence.explicitPatternCoverage || 0) * 100).toFixed(1)}% of mapped route length.`
    });
    if ((pathNetwork.components || 0) > 1) gaps.push({
      severity: (pathNetwork.components || 0) > 3 ? "high" : "medium", code: "PATH_TOPOLOGY_FRAGMENTED",
      message: `The source-relative guest network has ${pathNetwork.components} disconnected components and ${pathNetwork.danglingEndpoints || 0} dangling endpoints after ${pathGeometry.compiledConnectors || 0} conservative mapped-gap repair(s).`
    });
    if ((pathGeometry.candidateConnectors || 0) > (pathGeometry.compiledConnectors || 0)) gaps.push({
      severity: "medium", code: "PATH_SOURCE_REPAIR_REVIEW",
      message: `${(pathGeometry.candidateConnectors || 0) - (pathGeometry.compiledConnectors || 0)} short mapped endpoint-gap candidate(s) remain QA-only or below the confidence gate.`
    });
    gaps.push({
      severity: "high", code: "PATH_COMPLETENESS_SOURCE_LIMITED",
      message: "Mapped topology has been validated, but no universal public source can prove that every visible guest, queue, service, and temporary path is present."
    });
    if (map.orthophoto?.status !== "available") gaps.push({
      severity: "high", code: "ORTHOPHOTO_PATH_EVIDENCE_UNAVAILABLE",
      message: sources.orthophoto?.warning || "No rights-cleared sub-metre orthophoto supplied accepted path-edge observations."
    });
    else if ((map.orthophoto.compilationEligibleFeatures || 0) === 0) gaps.push({
      severity: "high", code: "ORTHOPHOTO_PATH_EVIDENCE_QA_ONLY",
      message: "Orthophoto observations are available for QA, but none are eligible to affect the world. Use evidence mode with an explicit provider and reuse licence after alignment and rights review."
    });
    else if ((map.orthophoto.measuredRouteCoverage || 0) < 0.8) gaps.push({
      severity: "medium", code: "ORTHOPHOTO_PATH_EVIDENCE_PARTIAL",
      message: `Orthophoto edge measurement covers ${((map.orthophoto.measuredRouteCoverage || 0) * 100).toFixed(1)}% of mapped route length; canopy, shadows, image gaps, or weak edge contrast prevented the remainder.`
    });
    if ((options.pathDiscoveryMode || "off") !== "off") {
      if (pathTopology.status !== "available") gaps.push({
        severity: "medium", code: "PATH_TOPOLOGY_RECOVERY_EMPTY",
        message: "Walkable-surface recovery found no connected, sufficiently large image-visible path component beyond the mapped routes."
      });
      else if (!pathTopology.compilationPermitted) gaps.push({
        severity: "high", code: "PATH_TOPOLOGY_RECOVERY_QA_ONLY",
        message: `${pathTopology.candidateGraphEdges || 0} image-derived graph edge(s) are available for QA, but none may alter the world without evidence mode and provenance-complete imagery.`
      });
      if (pathTopology.terrain?.steepReviewEdges) gaps.push({
        severity: "high", code: "PATH_TERRAIN_STEEP_REVIEW",
        message: `${pathTopology.terrain.steepReviewEdges} recovered path edge(s) exceed the configured terrain-grade gate and require explicit stairs or surveyed earthworks.`
      });
      if (pathTopology.terrain?.bridgeReviewEdges) gaps.push({
        severity: "critical", code: "PATH_BRIDGE_STRUCTURE_REVIEW",
        message: `${pathTopology.terrain.bridgeReviewEdges} recovered path edge(s) cross mapped water or require separate bridge evidence; they were not compiled as ground paths.`
      });
    }
  }
  if (bridgeEvidence.mappedFeatures && bridgeEvidence.verticalEvidenced < bridgeEvidence.mappedFeatures) gaps.push({
    severity: "critical", code: "BRIDGE_VERTICAL_GEOMETRY_PARTIAL",
    message: `${bridgeEvidence.mappedFeatures - bridgeEvidence.verticalEvidenced} of ${bridgeEvidence.mappedFeatures} mapped bridge features have no explicit or measured deck elevation; verified output keeps them as orange plan markers.`
  });
  if (!treeEvidence.mappedFeatures) gaps.push({
    severity: "high", code: "TREE_DATA_ABSENT",
    message: "No mapped tree points, tree rows, woodland/scrub polygons, orchards, or hedges were found. Aerial canopy may texture terrain but cannot define exact vegetation extents by itself."
  });
  else if (treeEvidence.heightEvidenced < treeEvidence.mappedFeatures) gaps.push({
    severity: "medium", code: "TREE_HEIGHTS_PARTIAL",
    message: `${treeEvidence.mappedFeatures - treeEvidence.heightEvidenced} of ${treeEvidence.mappedFeatures} mapped vegetation features lack tagged or DSM-measured height evidence; mapped cover uses clearly reported density-derived models.`
  });
  const unknownMaterials = buildings.filter((feature) => !feature.tags?.material && !feature.tags?.["building:material"]).length;
  if (unknownMaterials) gaps.push({ severity: "medium", code: "BUILDING_MATERIALS_PARTIAL", message: `${unknownMaterials} buildings have no public material tag.` });
  if (!dated.length) gaps.push({ severity: "medium", code: "FRESHNESS_UNKNOWN", message: "Source element timestamps are unavailable." });

  const exact3d = !gaps.some((gap) => [
    "BOUNDARY_UNVERIFIED",
    "RIDE_VERTICAL_GEOMETRY_ABSENT",
    "RIDE_VERTICAL_GEOMETRY_PARTIAL",
    "RIDE_ATTACHMENTS_WITHHELD",
    "RIDE_PLAN_PROFILE_MISALIGNED",
    "BRIDGE_VERTICAL_GEOMETRY_PARTIAL",
    "TERRAIN_NOT_SURVEY_GRADE",
    "TERRAIN_FLAT_DATUM"
  ].includes(gap.code));
  const scoreGrade = grade(overall);
  const hasCriticalGap = gaps.some((gap) => gap.severity === "critical");
  const evidenceGrade = hasCriticalGap ? capGrade(scoreGrade, "B") : scoreGrade;
  const result = {
    score: round(overall),
    grade: evidenceGrade,
    scoreGrade,
    gradeConstraint: hasCriticalGap
      ? "Grade capped at B because one or more critical evidence gaps remain."
      : null,
    exact3d,
    claim: exact3d
      ? "All critical 3D evidence gates passed for the available source set."
      : "This build is a traceable public-data reconstruction, not a guaranteed survey-grade 1:1 replica.",
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, round(value)])),
    weights: WEIGHTS,
    counts,
    evidence: {
      features: features.length,
      buildings: buildings.length,
      buildingsWithExplicitHeight: explicitBuildings.length,
      buildingsWithTaggedHeight: taggedBuildings.length,
      buildingsWithLidarMeasuredHeight: lidarMeasuredBuildings.length,
      buildingHeightConflicts: lidarConflicts,
      rideTracks: tracks.length,
      rideTracksWithVerticalEvidence: profiledTracks.length,
      rideTracksWithFullElevation: fullElevationTracks.length,
      rideTracksWithBankingEvidence: 0,
      rideTracksWithFullBanking: 0,
      rideVerticalCoverage: round(rideVerticalCoverage),
      rideBankingCoverage: 0,
      rideTrackRepresentation: "one-block-centreline",
      rideTrackWidthBlocks: 1,
      rideBankingRendered: false,
      rideCrossTiesRendered: false,
      rideAttachments: rideAttachments.length,
      rideAttachmentsResolved: resolvedRideAttachments.length,
      rideEvidenceCounts,
      ridePlanProfilesNeedingReview: misalignedProfiles.length,
      attractions: attractions.length,
      newestSourceTimestamp: newest,
      lidarSurveyDate: sources.elevation?.survey?.newestSurveyDate || null,
      terrainResolutionM: sources.elevation?.resolutionM ?? null,
      terrainCoverage: round(terrainCoverage),
      terrainVerticalAccuracyRmseM: sources.elevation?.verticalAccuracyRmseM ?? null,
      pathNetwork,
      surfaceEvidence,
      orthophotoEvidence: map.orthophoto || null,
      pathGeometryEvidence: pathGeometry,
      pathTopologyEvidence: pathTopology,
      treeEvidence,
      bridgeEvidence
    },
    gaps,
    thresholds: {
      requestedMinimum: options.minConfidence ?? 0.75,
      strict: Boolean(options.strict)
    }
  };

  return result;
}

function hasRideTunnelSemantics(feature) {
  const tunnel = String(feature.tags?.tunnel || "").toLowerCase();
  return Boolean((tunnel && !["no", "false", "0"].includes(tunnel)) ||
    String(feature.tags?.location || "").toLowerCase() === "underground");
}

export function enforceAccuracy(accuracy, options = {}) {
  if (!options.strict) return;
  const blockers = accuracy.gaps.filter((gap) => gap.severity === "critical");
  const minimum = options.minConfidence ?? 0.75;
  if (blockers.length || accuracy.score < minimum) {
    throw new UserError(
      `Strict evidence gate failed: confidence ${(accuracy.score * 100).toFixed(1)}%, ${blockers.length} critical gap(s)`,
      `Evidence files were still written.\n${blockers.map((gap) => `${gap.code}: ${gap.message}`).join("\n")}`
    );
  }
}

function countBy(values, selector) {
  const result = {};
  for (const value of values) {
    const key = selector(value);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function aggregateRideEvidence(tracks) {
  const result = {};
  for (const feature of tracks) {
    for (const [evidence, count] of Object.entries(feature.rideProfile?.evidenceCounts || {})) {
      result[evidence] = (result[evidence] || 0) + count;
    }
  }
  return result;
}

const clamp = (value) => Math.max(0, Math.min(1, value));
const round = (value) => Math.round(value * 1000) / 1000;
const grade = (value) => value >= 0.9 ? "A" : value >= 0.8 ? "B" : value >= 0.65 ? "C" : value >= 0.5 ? "D" : "E";
const capGrade = (value, maximum) => {
  const order = ["A", "B", "C", "D", "E"];
  return order.indexOf(value) < order.indexOf(maximum) ? maximum : value;
};
