#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { parseArgs } from "./lib/args.mjs";
import { UserError } from "./lib/errors.mjs";
import { ensureDir, readJson, writeJson, writeText } from "./lib/io.mjs";
import { buildPark } from "./lib/pipeline.mjs";
import { applyParkProfile, listParkProfiles, loadParkProfile } from "./lib/park-profile.mjs";
import { extractRasterPlanningPage } from "./lib/planning-raster-extraction.mjs";
import {
  createAutomaticPlanningPlan,
  prepareAutomaticPlanningShard
} from "./lib/planning-discovery.mjs";
import { bboxCenter } from "./lib/geo.mjs";

const HELP = `Voxel Mapping Tool 0.2.0 — automatic evidence-first 1:1 theme-park-to-Bedrock compiler

Usage
  voxel-map build --park PARK [options]
  voxel-map planning-plan --park PARK --out planning-plan.json
  voxel-map prepare-planning --park PARK --planning-plan planning-plan.json --planning-shard-index 0 --planning-shard-count 20
  voxel-map parks
  voxel-map extract-plan --input DRAWING.pdf [--page 1] [--out DIRECTORY]
  voxel-map inspect --osm FILE [--bbox S,W,N,E]
  voxel-map doctor

Fast offline example
  npm run build:fixture

Live public-data build
  voxel-map build \\
    --park alton-towers-resort \\
    --contact "you@example.com" \\
    --planning-world-authority planning-only \\
    --strict \\
    --out out/alton-towers

  Selecting --park automatically searches the national PlanIt spatial index and
  the park's official council register, downloads relevant planning drawings,
  extracts/georeferences confidence-gated geometry, and builds the world.

Core options
  --park ID                        Built-in park profile; run "voxel-map parks"
  --park-name NAME                 Theme park search name
  --bbox S,W,N,E                   Explicit WGS84 bounds; bypasses geocoding
  --osm FILE                       Offline Overpass JSON; bypasses network map fetch
  --overture FILE                  Overture GeoJSON gap-fill input; repeatable
  --public-data FILE               Licensed public/park GIS GeoJSON; repeatable
  --planning FILE                  Trusted planning GeoJSON (fixture/manual use); repeatable
  --planning-manifest FILE_OR_URL  Planning document/evidence manifest; repeatable
  --no-auto-planning              Disable automatic discovery when using expert/manual inputs
  --planit-url URL                Replaceable PlanIt application-index endpoint
  --max-planning-applications 250 Bounded automatic application-search limit
  --max-planning-documents 160    Bounded relevant-document download limit
  --max-planning-pages-per-document 20
                                    Bounded drawing-page extraction limit
  --planning-plan FILE              Frozen automatic document queue produced by planning-plan
  --planning-shard-index N          Zero-based extraction shard (CI preparation command)
  --planning-shard-count N          Total extraction shards; every document remains covered once
  --prepared-planning-directory DIR Reuse validated extraction-shard results during the final build
  --planning-georef-min-confidence .72
                                    Minimum automatic drawing alignment confidence
  --planning-world-authority planning-only|fixture
                                    OSM is registration-only by default; fixture is test-only
  --source-fusion-tolerance-m 3    Overture duplicate/overlap comparison tolerance
  --override FILE                  Verified GeoJSON override; repeatable
  --out DIRECTORY                  Output directory
  --accuracy-mode verified|plausible
                                    Unknown vertical detail stays marked or becomes an explicit estimate
  --strict                         Refuse output below evidence gates
  --min-confidence 0.75            Strict-mode score threshold
  --max-area-km2 12                Bounded-query safety limit
  --max-cells 2500000              1 m raster memory/build safety limit
  --allow-large-area               Deliberately exceed area safety limit

Supplemental public source fusion
  --england-open-data              Enable Planning Data + National Trees Outside Woodland
  --trees-outside-woodland         Bounded Forestry Commission canopy polygons and heights
  --planning-data                  Bounded Planning Data trees, TPO zones, woodland and listed buildings
  --planning-datasets CSV          Override the Planning Data dataset list
  --microsoft-buildings            Download only intersecting level-9 ML building partitions
  --microsoft-buildings-min-confidence .65
                                    Minimum footprint confidence when supplied
  --os-openmap-local FILE          OS OpenMap Local exported as WGS84 GeoJSON; repeatable
  --wikidata-places                Add bounded CC0 attraction/place labels
  --wikimedia-commons              Record nearby geotagged photo/licence evidence
  --open-aerial-map                Discover open aerial imagery candidates for the bbox
  --source-config FILE             Generic OGC API, ArcGIS or GeoJSON adapter config; repeatable
  --max-supplemental-features 50000
                                    Per-adapter bounded feature safety limit
  --supplemental-page-size 5000    Bounded API page size
  --max-supplemental-download-mb 250
                                    Compressed-source download safety limit
  --strict-supplemental-sources    Fail the build instead of recording an unavailable adapter

Public service consent
  --contact URL_OR_EMAIL            Required identifying User-Agent for live OSM services
  --accept-nominatim-policy         Confirms the OSMF public geocoder policy
  --elevation none|open-meteo|ea-lidar|geotiff
                                    Terrain source (default: none)
  --dtm FILE                        EPSG:27700 1 m terrain GeoTIFF (geotiff mode)
  --dsm FILE                        Matching surface GeoTIFF for height evidence / optional shell roofs
  --ostn15-grid FILE                Local OSTN15 transformation GeoTIFF
  --no-dsm                          Use bare-earth terrain without surface heights
  --accept-open-meteo-terms         Confirms selected Open-Meteo terms
  --commercial                      Treat the run as commercial Open-Meteo use
  --open-meteo-api-key KEY          Customer API key for commercial use
  --overpass-url URL                Replaceable/self-hosted Overpass endpoint
  --nominatim-url URL               Replaceable/self-hosted Nominatim endpoint
  --open-meteo-url URL              Replaceable/customer elevation endpoint
  --ea-dtm-wcs-url URL              Replaceable Environment Agency DTM WCS
  --ea-dsm-wcs-url URL              Replaceable Environment Agency DSM WCS
  --ea-index-wfs-url URL            Replaceable LiDAR survey-index WFS
  --cache DIRECTORY                 Response cache (default .tpmap-cache)
  --no-cache                        Refresh bounded source requests

3D ride evidence
  --ride-profile FILE               3D GeoJSON [lon,lat,elevation]; repeatable
  --ride-point-cloud FILE           Classified EPSG:27700 LAS/LAZ; repeatable
  --ride-profile-mode auto|flat|profile|lidar|hybrid
                                    Use supplied profiles and/or fit LiDAR inside the OSM corridor
  --ride-corridor-m 2.5             Point-cloud search radius around mapped track
  --ride-sample-m 1                 Profile sampling interval
  --ride-interpolation-gap-m 12     Maximum bounded LiDAR gap to interpolate
  --point-cloud-skip 1              Decode every Nth point for memory control
  --max-point-cloud-mb 1200         In-memory source-file safety limit
  --min-ride-profile-confidence .55 Reject weak automated LiDAR candidates
  --no-ride-info-signs              Do not place player-readable evidence signs

Orthophoto path evidence
  --orthophoto FILE                 Georeferenced RGB GeoTIFF; repeatable
  --orthophoto-source NAME          Explicit imagery provider / collection
  --orthophoto-source-url URL       Source or catalogue record
  --orthophoto-license ID           Reuse licence required in evidence mode
  --orthophoto-date DATE            Capture date or timestamp
  --orthophoto-mode evidence|assist|off
                                    Compile licensed evidence, create QA only, or disable
  --orthophoto-crs EPSG:CODE        Override a missing/incorrect embedded CRS
  --orthophoto-proj4 DEFINITION     Register a custom projected CRS
  --orthophoto-max-gsd-m 1          Reject imagery coarser than this resolution
  --orthophoto-sample-m 2           Centreline cross-section spacing
  --orthophoto-path-max-width-m 24  Maximum bounded path-edge search width
  --orthophoto-min-confidence .65   Minimum width/corridor acceptance confidence
  --orthophoto-material-min-confidence .82
                                    Minimum material classification confidence
  --orthophoto-pattern-min-confidence .82
                                    Minimum visible-pattern classification confidence
  --orthophoto-edge-delta-e 18      CIELAB edge contrast threshold
  --orthophoto-landcover-sample-m 5 Aerial terrain/canopy analysis spacing
  --aerial-terrain-mode evidence|qa|off
                                    Compile rights-cleared natural-ground textures, review only, or disable
  --aerial-terrain-grid-m 2        Terrain texture sampling grid
  --aerial-terrain-min-confidence .7
                                    Minimum natural-ground classification confidence
  --max-orthophoto-mb 1200          Source-file memory safety limit
  --max-orthophoto-pixels 120000000 Decoded raster safety limit

Mapped path geometry and walkable-area recovery
  --path-geometry-mode repair|qa|off
                                    Repair short source-relative endpoint gaps, review only, or disable
  --path-snap-tolerance-m 2.5      Maximum mapped endpoint-to-route repair distance
  --path-snap-min-confidence .72   Minimum source-relative repair confidence
  --path-edge-mode evidence|off    Render only explicitly tagged kerbs/path edges, or disable
  --path-discovery-mode evidence|qa|off
                                    Compile licensed connected path evidence, emit review layers only, or disable
  --path-discovery-grid-m 1         Walkable-surface classification grid size
  --path-discovery-colour-delta-e 20
                                    Maximum CIELAB distance from accepted mapped-path appearance
  --path-discovery-pixel-confidence .58
                                    Minimum per-cell hardscape confidence
  --path-discovery-min-confidence .74
                                    Minimum connected-component/edge confidence
  --path-discovery-min-area-m2 12   Minimum connected visible hardscape component
  --path-discovery-min-novel-area-m2 8
                                    Minimum area beyond the existing mapped route envelope
  --path-discovery-min-edge-m 5     Minimum recovered graph edge length
  --path-discovery-existing-buffer-m 2.5
                                    Distance used to classify connectors/extensions beyond mapped routes
  --path-discovery-terrain-sample-m 2
                                    DTM grade sampling interval
  --path-discovery-ramp-grade-percent 8.3
                                    Grade above which a recovered edge is labelled a ramp candidate
  --path-discovery-steep-grade-percent 16
                                    Reject as stairs/earthworks review above this grade
  --max-path-discovery-cells 3000000
                                    Analysis-grid memory safety limit
  --path-terrain-mode conform|evidence|off
                                    Bounded smoothing, unchanged source DTM, or no recovered-path terrain treatment
  --path-terrain-max-cut-fill-m 2   Maximum conform-mode change from source terrain per path cell

Terrain surface and rock detail
  --terrain-detail-mode evidence|plausible|off
                                    Exact mapped rock detail and tagged dirt paths; optionally add disclosed clusters inside mapped rock surfaces
  --terrain-rock-density-per-100m2 .75
                                    Plausible-mode cluster density inside bare-rock/scree/quarry polygons
  --terrain-rock-min-spacing-m 4    Minimum inferred-cluster spacing
  --terrain-cliff-marker-spacing-m 2
                                    Spacing for exact mapped cliff/outcrop plan markers
  --max-terrain-rocks 2000          Vertical rock-model safety limit

Vegetation and canopy reconstruction
  --tree-density-per-100m2 2.2      Density-derived trees inside mapped woodland/tree cover
  --shrub-density-per-100m2 12      Bush clusters inside mapped scrub/shrub cover
  --tree-line-spacing-m 4           Default spacing for mapped tree rows
  --vegetation-min-spacing-m 4      Minimum deterministic tree spacing in mapped cover
  --max-vegetation-models 15000     Tree/bush model safety limit

Direct Bedrock world compiler
  --scale 1                         Fixed: one block per metre
  --buildings markers|shells        Ground outlines + named signs (default), or legacy 3D shells
  --path-width-mode inferred|source-only
                                    Use disclosed route-class priors when width is absent (default), or 1-block evidence markers
  --ride-terrain-mode inferred|evidence|off
                                      Terrain-aware ride tunnels and supports
  --ride-tunnel-width-m 7             Nominal tunnel clearance width
  --ride-tunnel-above-m 4             Clearance above the track centreline
  --ride-tunnel-below-m 2             Clearance below the track centreline
  --ride-tunnel-cover-m 1             Minimum terrain cover for detected tunnels
  --ride-support-spacing-m 6          Inferred support-frame spacing
  --ride-support-min-height-m 4       Minimum track height for inferred supports
  --palette realistic|clean        Deterministic textured or literal source palette
  --world-margin 32                 Finished terrain around the park, in blocks
  --max-world-chunks 12000          Direct-world size safety limit
  --base-y 64                       Public elevation datum's Bedrock Y level
  --seed INTEGER                    Reproducible texturing/world seed
  --no-world                        Skip the complete prebuilt .mcworld

Optional runtime add-on compiler
  --build-depth 8                   Terrain foundation depth in blocks
  --ops-per-yield 12                Commands per scheduler yield
  --minecraft-server-version 2.3.0  @minecraft/server stable module target
  --min-engine-version 1.21.130     Pack minimum engine version
  --no-addon                        Skip the optional runtime builder add-on
  --no-preview                      Skip SVG/HTML plan preview

Generated add-on commands (not needed by the .mcworld)
  /scriptevent tpmap:arm
  /scriptevent tpmap:build
  /scriptevent tpmap:status
  /scriptevent tpmap:cancel

Accuracy promise
  The unit conversion is exactly 1 block = 1 metre. Public data cannot guarantee
  complete survey-grade geometry. The evidence report exposes every critical gap;
  strict mode refuses to conceal one. The .mcworld contains prebuilt LevelDB
  chunks and imports directly into Minecraft Bedrock.
`;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const { command } = parsed;
  let { options } = parsed;
  if (command === "help" || options.help) {
    console.log(HELP);
    return;
  }
  if (command === "doctor") {
    const major = Number(process.versions.node.split(".")[0]);
    let levelDb = false, chunkCodec = false, nativeError = null;
    try {
      const [{ LevelDB }, codec] = await Promise.all([
        import("@8crafter/leveldb-zlib"),
        import("mcbe-leveldb")
      ]);
      levelDb = typeof LevelDB === "function";
      chunkCodec = typeof codec.entryContentTypeToFormatMap?.SubChunkPrefix?.serialize === "function";
    } catch (error) {
      nativeError = error?.message || String(error);
    }
    console.log(JSON.stringify({
      ok: major >= 20 && typeof fetch === "function" && levelDb && chunkCodec,
      node: process.versions.node,
      fetch: typeof fetch === "function",
      bedrockLevelDb: levelDb,
      bedrockChunkCodec: chunkCodec,
      nativeError,
      platform: process.platform,
      notes: [
        "Live service reachability is checked only during a live build.",
        "The direct .mcworld is self-contained; the optional add-on changes blocks in another world."
      ]
    }, null, 2));
    return;
  }
  if (command === "parks") {
    const profiles = await listParkProfiles();
    console.log(JSON.stringify(profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      planningAuthority: profile.planningAuthority.name,
      planningDiscovery: profile.planningDiscovery.portalType,
      bbox: profile.bbox
    })), null, 2));
    return;
  }
  if (command === "inspect") {
    if (!options.osm) throw new UserError("inspect requires --osm FILE");
    const data = await readJson(options.osm);
    const counts = {};
    for (const element of data.elements || []) counts[element.type] = (counts[element.type] || 0) + 1;
    console.log(JSON.stringify({ elements: data.elements?.length || 0, counts, generator: data.generator || null }, null, 2));
    return;
  }
  if (command === "extract-plan") {
    if (!options.input) throw new UserError("extract-plan requires --input FILE");
    const outputDir = path.resolve(options.out || "out/planning-extraction");
    await ensureDir(outputDir);
    const result = await extractRasterPlanningPage({
      filename: path.resolve(options.input),
      page: options.page || 1,
      workDirectory: outputDir,
      document: { id: path.basename(options.input), mime: options.mime || null }
    });
    const svg = await writeText(path.join(outputDir, "planning-page.svg"), result.svg);
    const semantics = await writeJson(path.join(outputDir, "planning-semantics.json"), result.semantic);
    console.log(JSON.stringify({ svg, semantics, derivativeCache: result.derivativeCache }, null, 2));
    return;
  }
  if (!["build", "planning-plan", "prepare-planning"].includes(command)) throw new UserError(`Unknown command: ${command}`);
  if (options.park) options = applyParkProfile(options, await loadParkProfile(options.park));
  if (["planning-plan", "prepare-planning"].includes(command)) {
    if (!options.parkProfile) throw new UserError(`${command} requires --park`);
    const cacheDir = path.resolve(options.cache || ".tpmap-cache");
    await ensureDir(cacheDir);
    const contact = options.contact || process.env.TPMAP_CONTACT;
    const runtime = {
      bbox: options.parkProfile.bbox,
      center: bboxCenter(options.parkProfile.bbox),
      cacheDir,
      userAgent: contact ? `VoxelMappingTool/0.2.0 (${contact})` : "VoxelMappingTool/0.2.0",
      progress: options.quiet ? () => {} : (message) => console.error(`• ${message}`)
    };
    if (command === "planning-plan") {
      const plan = await createAutomaticPlanningPlan(options, runtime);
      const output = path.resolve(options.out || "planning-plan.json");
      await writeJson(output, plan, 0);
      console.log(JSON.stringify({ output, applications: plan.applications.length, documents: plan.documentQueue.length }, null, 2));
      return;
    }
    if (!options.planningPlan) throw new UserError("prepare-planning requires --planning-plan FILE");
    const plan = await readJson(path.resolve(options.planningPlan));
    const summary = await prepareAutomaticPlanningShard(plan, options, runtime);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const progress = options.quiet ? () => {} : (message) => console.error(`• ${message}`);
  const result = await buildPark(options, progress);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  if (error instanceof UserError) {
    console.error(`Voxel Mapping Tool: ${error.message}`);
    if (error.details) console.error(error.details);
    process.exitCode = 2;
    return;
  }
  console.error(error?.stack || error);
  process.exitCode = 1;
});
