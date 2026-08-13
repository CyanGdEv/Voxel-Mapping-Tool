export function buildEvidenceReport({ parkName, sources, map, accuracy, compilation }) {
  const percentage = (accuracy.score * 100).toFixed(1);
  const componentRows = Object.entries(accuracy.components)
    .map(([name, score]) => `| ${title(name)} | ${(score * 100).toFixed(1)}% | ${(accuracy.weights[name] * 100).toFixed(0)}% |`)
    .join("\n");
  const counts = Object.entries(accuracy.counts).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `| ${name} | ${count} |`).join("\n") || "| none | 0 |";
  const gaps = accuracy.gaps.length
    ? accuracy.gaps.map((gap) => `- **${gap.severity.toUpperCase()} · ${gap.code}:** ${gap.message}`).join("\n")
    : "- No evidence gaps were detected by this version of the validator.";
  const elevation = sources.elevation.provider === "none"
    ? "None (flat datum)"
    : `${sources.elevation.provider}, ${sources.elevation.resolutionM} m source resolution${
      Number.isFinite(sources.elevation.verticalAccuracyRmseM)
        ? `, ±${sources.elevation.verticalAccuracyRmseM} m stated vertical RMSE`
        : ""
    }`;
  const heightStats = sources.elevation.structureHeightStats;
  const buildingMode = compilation?.meta?.buildingMode || "markers";
  const terrainLimitation = sources.elevation.provider === "none"
    ? "No terrain accuracy is available because the world uses a flat datum."
    : sources.elevation.resolutionM > 10
      ? `Terrain detail is source-limited by a ${sources.elevation.resolutionM}-metre elevation grid.`
      : `LiDAR improves terrain and building-height evidence, but raster cells can still contain vegetation, temporary objects, water artefacts, and survey-age differences.${
        buildingMode === "markers" ? " This build intentionally represents buildings as marked footprints rather than LiDAR roof surfaces." : ""
      }`;

  return `# ${parkName} — evidence and accuracy report

Generated: ${new Date().toISOString()}

## Result

**Confidence: ${percentage}% (grade ${accuracy.grade})**

${accuracy.claim}

${accuracy.gradeConstraint ? `${accuracy.gradeConstraint} The uncapped score-only grade is ${accuracy.scoreGrade}.` : "No grade cap was required."}

The horizontal Minecraft scale is exactly **1 block = 1 metre**. That scale guarantee does not turn incomplete public observations into missing façade, terrain, or ride-profile detail. Unknown data is reported here and is either omitted or visibly represented as a ground-plan marker, depending on the selected accuracy mode.

## Evidence score

| Component | Score | Weight |
| --- | ---: | ---: |
${componentRows}

## Coverage

| Feature class | Count |
| --- | ---: |
${counts}

- Park area queried: ${sources.areaKm2.toFixed(3)} km²
- Planning acquisition: ${sources.planning?.automatic ? `automatic park-selection workflow; ${sources.planning.applications?.length || 0} application(s), ${sources.planning.documents?.length || 0} relevant document(s), ${sources.planning.featureCount || 0} promoted feature(s)` : "manual planning manifest/GeoJSON"}
- Planning discovery failures: ${sources.planning?.failures?.length || 0}; warnings: ${sources.planning?.warnings?.length || 0}
- Normalized source features: ${map.features.length}
- Non-OSM map inputs accepted: ${map.sourceFusion?.acceptedFeatures ?? 0} (${map.sourceFusion?.overture?.accepted ?? 0} Overture gap feature(s), ${map.sourceFusion?.publicData?.accepted ?? 0} public-data observation(s))
- Overture overlap safeguards: ${map.sourceFusion?.overture?.duplicatesWithheld ?? 0} duplicate(s) and ${map.sourceFusion?.overture?.partialOverlapsWithheld ?? 0} partial overlap(s) withheld
- OSM relation features assembled: ${map.topology?.relationFeatures ?? 0}
- Disjoint polygon parts retained: ${map.topology?.polygonParts ?? 0}
- Interior rings retained as holes: ${map.topology?.interiorRings ?? 0}
- Buildings with vertical evidence: ${accuracy.evidence.buildingsWithExplicitHeight}/${accuracy.evidence.buildings}
- Buildings with tagged/override height: ${accuracy.evidence.buildingsWithTaggedHeight}/${accuracy.evidence.buildings}
- Buildings with LiDAR-measured height: ${accuracy.evidence.buildingsWithLidarMeasuredHeight}/${accuracy.evidence.buildings}
- Tagged-height/LiDAR conflicts retained for review: ${accuracy.evidence.buildingHeightConflicts}
- Ride tracks with vertical evidence: ${accuracy.evidence.rideTracksWithVerticalEvidence}/${accuracy.evidence.rideTracks}
- Ride tracks with complete elevation profiles: ${accuracy.evidence.rideTracksWithFullElevation}/${accuracy.evidence.rideTracks}
- Length-weighted ride elevation coverage: ${(accuracy.evidence.rideVerticalCoverage * 100).toFixed(1)}%
- Ride representation: one-block-wide 3D centreline; banking and cross ties are intentionally not rendered
- Detected ride attachments resolved: ${accuracy.evidence.rideAttachmentsResolved}/${accuracy.evidence.rideAttachments}
- Replacement 3D profiles requiring plan-alignment review: ${accuracy.evidence.ridePlanProfilesNeedingReview ?? 0}
- Terrain source: ${elevation}
- Valid terrain raster coverage: ${Number.isFinite(accuracy.evidence.terrainCoverage) ? `${(accuracy.evidence.terrainCoverage * 100).toFixed(1)}%` : "unknown"}
- LiDAR survey date: ${accuracy.evidence.lidarSurveyDate || "not applicable or unavailable"}
- Newest OSM element timestamp: ${accuracy.evidence.newestSourceTimestamp || "unknown"}
- Mapped route length: ${accuracy.evidence.pathNetwork?.totalLengthM?.toLocaleString?.() ?? 0} m
- Source-relative guest path components: ${accuracy.evidence.pathNetwork?.components ?? 0}
- Conservative mapped-gap repair: ${accuracy.evidence.pathGeometryEvidence?.compiledConnectors ?? 0} compiled connector(s), ${accuracy.evidence.pathGeometryEvidence?.repairedLengthM ?? 0} m, reducing ${accuracy.evidence.pathGeometryEvidence?.componentReduction ?? 0} component(s) and ${accuracy.evidence.pathGeometryEvidence?.danglingEndpointReduction ?? 0} dangling endpoint(s)
- Path width evidence: ${((accuracy.evidence.surfaceEvidence?.widthCoverage || 0) * 100).toFixed(1)}%; inferred-width coverage: ${((accuracy.evidence.surfaceEvidence?.inferredWidthCoverage || 0) * 100).toFixed(1)}%; compiled-width coverage: ${((accuracy.evidence.surfaceEvidence?.compiledWidthCoverage || 0) * 100).toFixed(1)}%
- Orthophoto-measured path width: ${((accuracy.evidence.surfaceEvidence?.orthophotoWidthCoverage || 0) * 100).toFixed(1)}%; accepted imagery route coverage: ${((accuracy.evidence.orthophotoEvidence?.measuredRouteCoverage || 0) * 100).toFixed(1)}%
- Mean compiled linear-route width: ${accuracy.evidence.surfaceEvidence?.meanCompiledRasterWidthM ?? "unknown"} m
- Path material evidence: ${((accuracy.evidence.surfaceEvidence?.materialCoverage || 0) * 100).toFixed(1)}%
- Path colour evidence: ${((accuracy.evidence.surfaceEvidence?.colourCoverage || 0) * 100).toFixed(1)}%
- Explicit path-pattern evidence: ${((accuracy.evidence.surfaceEvidence?.explicitPatternCoverage || 0) * 100).toFixed(1)}%
- Orthophoto path observations accepted/rejected: ${accuracy.evidence.orthophotoEvidence?.acceptedFeatures ?? 0}/${accuracy.evidence.orthophotoEvidence?.rejectedFeatures ?? 0}; compilation-eligible: ${accuracy.evidence.orthophotoEvidence?.compilationEligibleFeatures ?? 0}; minimum source GSD: ${sources.orthophoto?.rasters?.length ? `${Math.min(...sources.orthophoto.rasters.map((raster) => raster.resolutionM))} m` : "not available"}
- Orthophoto land-cover QA samples: ${accuracy.evidence.orthophotoEvidence?.landCover?.samples?.toLocaleString?.() ?? 0}; compilation status: ${accuracy.evidence.orthophotoEvidence?.landCover?.compilationStatus || "not active"}
- Walkable-surface recovery: ${accuracy.evidence.pathTopologyEvidence?.connectedComponents ?? 0} connected component(s), ${accuracy.evidence.pathTopologyEvidence?.acceptedGraphEdges ?? 0} accepted graph edge(s), ${accuracy.evidence.pathTopologyEvidence?.recoveredLengthM ?? 0} m recovered centreline, ${accuracy.evidence.pathTopologyEvidence?.recoveredAreaM2 ?? 0} m² compiled novel area
- Recovered topology structure: ${accuracy.evidence.pathTopologyEvidence?.connectorEdges ?? 0} connector(s), ${accuracy.evidence.pathTopologyEvidence?.extensionEdges ?? 0} extension(s), ${accuracy.evidence.pathTopologyEvidence?.junctionNodes ?? 0} junction node(s); mode ${accuracy.evidence.pathTopologyEvidence?.mode || "off"}
- Recovered path terrain review: ${accuracy.evidence.pathTopologyEvidence?.terrain?.rampCandidateEdges ?? 0} ramp candidate(s), ${accuracy.evidence.pathTopologyEvidence?.terrain?.steepReviewEdges ?? 0} steep edge(s), ${accuracy.evidence.pathTopologyEvidence?.terrain?.bridgeReviewEdges ?? 0} bridge-required edge(s)
- Individual tree/tree-row features: ${accuracy.evidence.treeEvidence?.mappedFeatures ?? 0}; height-evidenced: ${accuracy.evidence.treeEvidence?.heightEvidenced ?? 0}; crown-evidenced: ${accuracy.evidence.treeEvidence?.crownEvidenced ?? 0}
- Bridges: ${accuracy.evidence.bridgeEvidence?.mappedFeatures ?? 0}; deck elevation evidenced: ${accuracy.evidence.bridgeEvidence?.verticalEvidenced ?? 0}; plan-only: ${accuracy.evidence.bridgeEvidence?.planOnly ?? 0}
- Natural-surface paths: ${map.terrainDetails?.dirtPaths?.features ?? 0} feature(s), ${map.terrainDetails?.dirtPaths?.lengthM ?? 0} m; materials ${formatObject(map.terrainDetails?.dirtPaths?.materials)}
- Rock/landform evidence: ${map.terrainDetails?.rocks?.pointFeatures ?? 0} point(s), ${map.terrainDetails?.rocks?.cliffOrOutcropLines ?? 0} cliff/outcrop line(s), ${map.terrainDetails?.rocks?.surfaceFeatures ?? 0} mapped surface(s)

## Evidence gaps

${gaps}

## Minecraft compilation

- Estimated block writes: ${compilation?.stats?.estimatedBlocks?.toLocaleString?.() ?? "not compiled"}
- Compressed fill operations: ${compilation?.stats?.operations?.toLocaleString?.() ?? "not compiled"}
- Work chunks: ${compilation?.stats?.chunks?.toLocaleString?.() ?? "not compiled"}
- Raster cells evaluated: ${compilation?.stats?.rasterCells?.toLocaleString?.() ?? "not compiled"}
- Accuracy mode: ${compilation?.meta?.accuracyMode || "not compiled"}
- Building output mode: ${buildingMode}
- Building/structure footprints marked: ${compilation?.meta?.verticalStats?.buildingMarkerFootprints?.toLocaleString?.() ?? 0}
- Point-mapped building markers: ${compilation?.meta?.verticalStats?.pointBuildingMarkers?.toLocaleString?.() ?? 0}
- Out-of-boundary/non-area features not represented: ${compilation?.meta?.verticalStats?.unrepresentedBuildingFeatures?.toLocaleString?.() ?? 0}
- Ground-outline marker cells: ${compilation?.meta?.verticalStats?.buildingMarkerCells?.toLocaleString?.() ?? 0}
- Named two-sided signs: ${compilation?.meta?.verticalStats?.buildingSigns?.toLocaleString?.() ?? 0}
- Player map-evidence boards: ${compilation?.meta?.verticalStats?.playerInformationSigns?.toLocaleString?.() ?? 0}
- Named ride-evidence signs: ${compilation?.meta?.verticalStats?.rideInformationSigns?.toLocaleString?.() ?? 0}
- Signs placed from mapped building entrances: ${compilation?.meta?.verticalStats?.signsAtMappedEntrances?.toLocaleString?.() ?? 0}
- Signs placed nearest mapped paths: ${compilation?.meta?.verticalStats?.signsNearMappedPaths?.toLocaleString?.() ?? 0}
- Signs retained at mapped structure points: ${compilation?.meta?.verticalStats?.signsAtMappedPoints?.toLocaleString?.() ?? 0}
- Signs using an interior fallback: ${compilation?.meta?.verticalStats?.signsAtInteriorFallback?.toLocaleString?.() ?? 0}
- Unnamed marked footprints: ${compilation?.meta?.verticalStats?.unnamedBuildingMarkers?.toLocaleString?.() ?? 0}
- LiDAR-derived building heights compiled into shells: ${compilation?.meta?.verticalStats?.measuredBuildingHeights?.toLocaleString?.() ?? 0}
- DSM roof cells compiled in shell mode: ${compilation?.meta?.verticalStats?.lidarRoofCells?.toLocaleString?.() ?? 0}
- Explicit OSM bridge/tunnel/layer classifications retained in evidence: ${map.semantics?.bridges ?? 0}/${map.semantics?.tunnels ?? 0}/${map.semantics?.layered ?? 0}
- Evidence-driven bridge decks: ${compilation?.meta?.verticalStats?.bridgeDeckFeatures?.toLocaleString?.() ?? 0}; deck/rail/support blocks: ${compilation?.meta?.verticalStats?.bridgeDeckBlocks?.toLocaleString?.() ?? 0}/${compilation?.meta?.verticalStats?.bridgeRailBlocks?.toLocaleString?.() ?? 0}/${compilation?.meta?.verticalStats?.bridgeSupportBlocks?.toLocaleString?.() ?? 0}
- Bridge plan markers with unknown height: ${compilation?.meta?.verticalStats?.bridgePlanOnly?.toLocaleString?.() ?? 0}
- Evidence-driven tree models: ${compilation?.meta?.verticalStats?.treeModels?.toLocaleString?.() ?? 0}; position-only tree markers: ${compilation?.meta?.verticalStats?.treePositionMarkers?.toLocaleString?.() ?? 0}
- Tree trunk/leaf blocks: ${compilation?.meta?.verticalStats?.treeTrunkBlocks?.toLocaleString?.() ?? 0}/${compilation?.meta?.verticalStats?.treeLeafBlocks?.toLocaleString?.() ?? 0}
- Recovered-path terrain output: ${compilation?.meta?.pathTerrainOutput?.status || "not active"}; adjusted cells ${compilation?.meta?.pathTerrainOutput?.adjustedCells ?? 0}; cut/fill ${compilation?.meta?.pathTerrainOutput?.cutVolumeM3 ?? 0}/${compilation?.meta?.pathTerrainOutput?.fillVolumeM3 ?? 0} m³; maximum adjustment ${compilation?.meta?.pathTerrainOutput?.maxAdjustmentM ?? 0} m
- Terrain-detail output: mode ${compilation?.meta?.verticalStats?.terrainDetailMode || "off"}; dimensioned rock models ${compilation?.meta?.verticalStats?.terrainRockDimensionedModels ?? 0}; exact position markers ${compilation?.meta?.verticalStats?.terrainRockPositionMarkers ?? 0}; inferred polygon clusters ${compilation?.meta?.verticalStats?.terrainInferredRockClusters ?? 0}; cliff marker blocks ${compilation?.meta?.verticalStats?.terrainCliffMarkerBlocks ?? 0}; total rock blocks ${compilation?.meta?.verticalStats?.terrainRockBlocks ?? 0}
- 3D-profiled ride-track features: ${compilation?.meta?.verticalStats?.profiledRideTracks?.toLocaleString?.() ?? 0}
- 3D ride-centreline blocks emitted: ${compilation?.meta?.verticalStats?.rideProfileBlocks?.toLocaleString?.() ?? 0}; fixed width: ${compilation?.meta?.verticalStats?.rideTrackWidthBlocks ?? 1} block
- Ride-profile evidence blocks: ${formatObject(compilation?.meta?.verticalStats?.rideProfileEvidenceBlocks)}
- Banking rendered: ${compilation?.meta?.verticalStats?.rideBankingRendered === true ? "yes" : "no"}; cross ties rendered: ${compilation?.meta?.verticalStats?.rideCrossTiesRendered === true ? "yes" : "no"}
- Detected ride attachments rendered/withheld: ${compilation?.meta?.verticalStats?.rideAttachmentRendered?.toLocaleString?.() ?? 0}/${compilation?.meta?.verticalStats?.rideAttachmentWithheld?.toLocaleString?.() ?? 0}; blocks: ${compilation?.meta?.verticalStats?.rideAttachmentBlocks?.toLocaleString?.() ?? 0}; types: ${formatObject(compilation?.meta?.verticalStats?.rideAttachmentTypes)}
- Ride terrain mode: ${compilation?.meta?.verticalStats?.rideTerrainMode || "off"}
- Source-tagged ride tunnel features: ${compilation?.meta?.verticalStats?.rideExplicitTunnelFeatures?.toLocaleString?.() ?? 0}; terrain-detected tunnel features: ${compilation?.meta?.verticalStats?.rideTerrainDetectedTunnelFeatures?.toLocaleString?.() ?? 0}
- Tunnel track blocks: ${compilation?.meta?.verticalStats?.rideTunnelTrackBlocks?.toLocaleString?.() ?? 0}; inferred-height tunnel track blocks: ${compilation?.meta?.verticalStats?.rideTunnelInferredTrackBlocks?.toLocaleString?.() ?? 0}
- Tunnel excavation/lining blocks: ${compilation?.meta?.verticalStats?.rideTunnelExcavatedBlocks?.toLocaleString?.() ?? 0}/${compilation?.meta?.verticalStats?.rideTunnelLiningBlocks?.toLocaleString?.() ?? 0}; portal frames: ${compilation?.meta?.verticalStats?.rideTunnelPortalFrames?.toLocaleString?.() ?? 0}
- Detected planning support frames/blocks: ${compilation?.meta?.verticalStats?.rideSupportFrames?.toLocaleString?.() ?? 0}/${compilation?.meta?.verticalStats?.rideSupportBlocks?.toLocaleString?.() ?? 0}
- Spawn selection: ${compilation?.meta?.spawnLocal?.source || "unknown"}${compilation?.meta?.spawnLocal?.entranceFeatureId ? ` (${compilation.meta.spawnLocal.entranceFeatureId})` : ""}

Track colours are evidence, not decoration: cyan is surveyed/manufacturer data, blue is a verified planning drawing, lime is LiDAR-derived, gold is bounded interpolation, yellow is inference, and orange is 2D plan geometry with no usable height profile. Every ride track is a one-block centreline; ride-side signs expose vertical coverage and confidence to players.

Tunnel excavation follows source-tagged underground topology and the terrain/profile intersection. Missing hidden elevations are filled only in \`ride-terrain-mode=inferred\`, remain yellow, and are counted separately. Supports, catwalks, evacuation stairs, maintenance/station platforms, handrails, fences, and ride-access paths compile only from detected planning geometry; the compiler does not generate them from spacing or side-offset priors.

## Source provenance and licences

- Base map geometry: © OpenStreetMap contributors, Open Database Licence (ODbL 1.0). https://www.openstreetmap.org/copyright
- Geocoding policy: https://operations.osmfoundation.org/policies/nominatim/
- OSM geometry source: ${sources.osm.queryHash
    ? `Overpass API bounded query, query hash \`${sources.osm.queryHash}\``
    : `offline Overpass snapshot, data hash \`${sources.osm.dataHash || "recorded in evidence.json"}\``}.
${sources.elevation.provider === "none" ? "- Elevation: none." : `- Elevation: ${sources.elevation.attribution}. Licence: ${sources.elevation.license || "recorded by the supplied dataset"}. Dataset: ${sources.elevation.dataset || "user-supplied GeoTIFF"}.`}
${sources.elevation.dtm?.sha256 ? `- DTM SHA-256: \`${sources.elevation.dtm.sha256}\`.` : ""}
${sources.elevation.dsm?.sha256 ? `- DSM SHA-256: \`${sources.elevation.dsm.sha256}\`.` : ""}
${sources.elevation.transformation ? `- Coordinate transformation: ${sources.elevation.transformation.name}, grid SHA-256 \`${sources.elevation.transformation.gridHash}\`, source ${sources.elevation.transformation.gridSource}.` : ""}
${sources.orthophoto?.status === "available" ? `- Orthophoto: ${sources.orthophoto.source?.provider}; captured ${sources.orthophoto.source?.capturedAt || "date unknown"}; licence ${sources.orthophoto.source?.license || "not recorded"}; raster SHA-256 ${sources.orthophoto.rasters.map((raster) => `\`${raster.sha256}\``).join(", ")}.` : `- Orthophoto: unavailable (${sources.orthophoto?.warning || "not supplied"})`}
${formatFusionSources(map.sourceFusion)}
${sources.planning?.automatic ? `- Planning discovery: bounded PlanIt spatial index plus ${sources.planning.discovery?.portalType || "configured"} official-portal adapter; official drawing URLs and hashes are recorded in \`planning-sources.json\`.` : "- Planning acquisition: reviewed manual manifest/GeoJSON input."}
${heightStats ? `- Structure-height method: ${heightStats.method}; ${heightStats.measured}/${heightStats.candidates} missing-height buildings measured, ${heightStats.conflicts} tagged conflicts retained.` : ""}
${(map.rideProfiles?.sourceCatalog || []).map((source) => `- Ride-profile input: ${source.file || source.kind}, SHA-256 \`${source.sha256 || "recorded by source"}\`${source.crs ? `, ${source.crs}` : ""}.`).join("\n")}
- Universal fidelity model: OSM-compatible paths, surfaces, bridges, and trees plus portable GeoJSON observations. The active source capability matrix is stored in \`fidelity.json\`.
- Any override file remains subject to the source and licence recorded in its GeoJSON properties.

## What is and is not guaranteed

Guaranteed by this tool:

- 1:1 horizontal unit conversion: one WGS84-derived metre becomes one Minecraft block.
- Every generated feature retains a source identifier and verification state.
- Strict mode refuses output when configured evidence thresholds are not met.
- The compiler does not silently label inferred vertical geometry as verified.
- Ride tracks compile as exactly one block of centreline width, with no banking or cross ties.
- Ride attachments retain their detected plan geometry and are withheld when vertical evidence cannot be resolved without fabrication.
- OSM multipolygon outer members are assembled into parts and inner members are subtracted as holes.

Not guaranteed by public data:

- Completeness, recency, cadastral/survey accuracy, private backstage detail, interiors, individual vegetation, or exact architectural materials.
- A roller coaster's 3D centreline elevation, supports, attachments, or tunnel profile where only a 2D public line is available. LiDAR-derived candidates remain explicitly distinct from survey/CAD geometry.
- Tunnel tags prove relative underground topology, not the exact hidden bore, portal shape, structural lining, or rail elevation. The generic clearance envelope and any hidden-height interpolation are disclosed compiler assumptions.
- OSM \`layer\` values express relative stacking order, not a measured height; they are preserved as evidence and are never converted directly into metres.
- Path connectivity is validated relative to fused source lines. It cannot prove that an obscured, private, newly built, or temporary path was absent from reality.
- Overture is accepted only as conservative gap fill because its transportation product includes OSM-derived geometry; an Overture match is not counted as independent corroboration.
- Broad land-cover products such as ESA WorldCover can identify coarse cover classes but cannot prove a path edge, individual tree, or boulder position at Minecraft's one-metre grid.
- Orthophoto edge extraction is seeded by mapped routes and cannot discover a path hidden by canopy or absent from every topology source. Accepted sections use a variable-width envelope; unsupported gaps retain a one-block centreline rather than an invented width.
- Walkable-surface recovery can extend beyond mapped centrelines only through connected, image-visible hardscape matching a licensed path appearance prototype. It does not silently classify isolated hardscape, obscured paths, access rights, stairs, ramps, or bridges as verified routes.
- Recovered candidates conflicting with mapped buildings, water, or vegetation are masked. Steep candidates and water crossings require explicit terrain/bridge evidence before compilation.
- Where a linear route has no explicit or accepted orthophoto width, the default compiler uses a disclosed range-bounded prior based on route class and access role. Use \`--path-width-mode source-only\` to retain one-block unknown-width markers instead.
- Path colour and laying pattern are used only when supplied or accepted by confidence-gated orthophoto analysis; orange route blocks identify unknown appearance in verified mode.
- Orthophoto \`assist\` mode is QA-only. Its observations remain reviewable but cannot change path width, colour, material, pattern, or blocks until evidence mode's explicit provider and licence gate is satisfied.
- ${terrainLimitation}

For a defensible full 3D result, add verified ride centreline elevations, detected support and attachment geometry, façade/material observations, and any survey overrides, then rerun with \`--strict\`.
`;
}

const title = (value) => value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
const formatObject = (value) => Object.entries(value || {}).map(([key, count]) => `${key}=${count}`).join(", ") || "none";
const formatFusionSources = (fusion) => {
  if (!fusion || fusion.status === "osm-only") return "- Additional map-source fusion: none supplied.";
  const overture = fusion.overture?.files || [];
  const publicFiles = fusion.publicData?.files || [];
  return [
    overture.length
      ? `- Overture map inputs: ${overture.map((file) => `${file.file} (SHA-256 \`${file.sha256}\`)`).join(", ")}; ODbL 1.0; gap-fill policy recorded in source-fusion.json.`
      : null,
    publicFiles.length
      ? `- Public-data GeoJSON inputs: ${publicFiles.map((file) => `${file.file} (SHA-256 \`${file.sha256}\`)`).join(", ")}; feature-level provider, URL, and licence are retained in the normalized GeoJSON.`
      : null
  ].filter(Boolean).join("\n") || "- Additional map-source fusion: inputs supplied, no features accepted.";
};
