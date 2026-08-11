import { stat } from "node:fs/promises";
import path from "node:path";
import { fromFile } from "geotiff";
import proj4 from "proj4";
import { geometryBounds, pointInPolygon } from "./geo.mjs";
import { UserError, invariant } from "./errors.mjs";
import { sha256File } from "./io.mjs";
import { sampleAerialClassification } from "./aerial-appearance.mjs";

const EARTH_RADIUS_M = 6_378_137;
const DEG = Math.PI / 180;
const DEFAULT_MAX_GSD_M = 1;
const DEFAULT_SAMPLE_SPACING_M = 2;
const DEFAULT_MAX_PATH_WIDTH_M = 24;
const DEFAULT_MIN_CONFIDENCE = 0.65;

/**
 * Loads one or more georeferenced RGB GeoTIFFs. Raster bytes and samplers stay
 * non-enumerable so evidence manifests retain hashes/metadata without copying
 * imagery into JSON output.
 */
export async function acquireOrthophotos(options, context) {
  const filenames = Array.isArray(options.orthophoto)
    ? options.orthophoto
    : options.orthophoto ? [options.orthophoto] : [];
  const mode = options.orthophotoMode || (filenames.length ? "evidence" : "off");
  if (mode === "off" || !filenames.length) {
    return {
      status: "not-supplied",
      mode,
      rasters: [],
      coverage: 0,
      warning: "No rights-cleared orthophoto was supplied; imagery-derived path evidence is unavailable."
    };
  }

  const source = {
    provider: options.orthophotoSource || "User-supplied orthophoto",
    sourceUrl: options.orthophotoSourceUrl || null,
    license: options.orthophotoLicense || null,
    capturedAt: options.orthophotoDate || null
  };
  // A generated fallback label is useful in QA output, but it is not provenance.
  // Evidence mode therefore requires the caller to identify both the provider
  // and the reuse licence explicitly.
  const provenanceComplete = Boolean(options.orthophotoSource && options.orthophotoLicense);
  if (mode === "evidence" && !provenanceComplete) {
    throw new UserError(
      "--orthophoto-mode evidence requires --orthophoto-source and --orthophoto-license",
      "Use assist mode for exploratory imagery whose reuse rights or provenance are incomplete."
    );
  }

  const rasters = [];
  for (const supplied of filenames) {
    const filename = path.resolve(supplied);
    const details = await stat(filename);
    invariant(details.isFile(), `Orthophoto is not a regular file: ${filename}`);
    const limitBytes = (options.maxOrthophotoMb || 1200) * 1024 * 1024;
    invariant(details.size <= limitBytes,
      `Orthophoto ${path.basename(filename)} is ${(details.size / 1024 / 1024).toFixed(1)} MiB; limit is ${options.maxOrthophotoMb || 1200} MiB`);
    rasters.push(await readOrthophotoRaster(filename, options, context));
  }

  const usable = rasters.filter((raster) => raster.resolutionM <= (options.orthophotoMaxGsdM || DEFAULT_MAX_GSD_M));
  const sampler = createMosaicSampler(usable);
  const result = {
    status: usable.length ? "available" : "too-coarse",
    mode,
    source,
    provenanceComplete,
    maxAcceptedGsdM: options.orthophotoMaxGsdM || DEFAULT_MAX_GSD_M,
    rasters: rasters.map(publicRasterMetadata),
    usableRasters: usable.length,
    coverage: usable.length ? 1 : 0,
    warning: usable.length ? null : `Every supplied orthophoto is coarser than ${options.orthophotoMaxGsdM || DEFAULT_MAX_GSD_M} m/pixel.`
  };
  Object.defineProperties(result, {
    sampleRgbLocal: { enumerable: false, value: sampler },
    minimumGsdM: {
      enumerable: false,
      value: usable.length ? Math.min(...usable.map((raster) => raster.resolutionM)) : null
    }
  });
  return result;
}

export async function readOrthophotoRaster(filename, options, context) {
  let tiff;
  try {
    tiff = await fromFile(filename);
    const image = await tiff.getImage();
    const width = image.getWidth(), height = image.getHeight();
    invariant(width > 1 && height > 1, "Orthophoto GeoTIFF is too small");
    invariant(width * height <= (options.maxOrthophotoPixels || 120_000_000),
      `Orthophoto contains ${(width * height).toLocaleString()} pixels; crop it to the park or raise --max-orthophoto-pixels deliberately`);
    invariant(image.getSamplesPerPixel() >= 3, "Orthophoto GeoTIFF requires at least three colour bands");

    const geoKeys = image.getGeoKeys();
    const embeddedEpsg = Number(geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey);
    const epsg = parseEpsg(options.orthophotoCrs) || embeddedEpsg;
    invariant(Number.isFinite(epsg),
      "Orthophoto GeoTIFF has no supported CRS; add --orthophoto-crs and optionally --orthophoto-proj4");
    const boundingBox = image.getBoundingBox().map(Number);
    const resolution = image.getResolution().map(Math.abs);
    invariant(boundingBox.every(Number.isFinite) && resolution[0] > 0 && resolution[1] > 0,
      "Orthophoto GeoTIFF has invalid georeferencing");
    const resolutionM = projectedResolutionMetres(resolution, epsg, context.center.lat);
    const rgb = await image.readRGB({ interleave: true });
    invariant(rgb.length === width * height * 3, "Orthophoto RGB decoder returned an unexpected sample count");
    const localToImage = await createLocalToImageTransform(epsg, options, context);
    const sampleImage = createRgbSampler({ width, height, boundingBox, rgb });
    const raster = {
      filename: path.resolve(filename),
      file: path.basename(filename),
      sha256: await sha256File(filename),
      width,
      height,
      epsg,
      boundingBox,
      resolution,
      resolutionM: round3(resolutionM)
    };
    Object.defineProperty(raster, "sampleRgbLocal", {
      enumerable: false,
      value(x, z) {
        const projected = localToImage(x, z);
        return projected ? sampleImage(projected[0], projected[1]) : null;
      }
    });
    return raster;
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Could not read orthophoto GeoTIFF: ${path.basename(filename)}`, error?.message || String(error));
  } finally {
    await tiff?.close?.();
  }
}

/**
 * Measures mapped linear routes against imagery. OSM remains the topology
 * seed; accepted image edges replace only unsupported width/appearance values.
 */
export function enrichOrthophotoEvidence(map, sources, options = {}) {
  const imagery = sources.orthophoto;
  const mode = imagery?.mode || "off";
  const observations = [];
  if (mode === "off" || imagery?.status !== "available" || typeof imagery.sampleRgbLocal !== "function") {
    const summary = emptySummary(imagery);
    map.orthophoto = summary;
    return { summary, qaGeojson: emptyQa(map, imagery) };
  }

  for (const feature of map.features) {
    if (!["path", "road"].includes(feature.kind)) continue;
    if (!["LineString", "MultiLineString"].includes(feature.localGeometry?.type)) continue;
    const observation = analyzePathFeature(feature, imagery, options, map.projector);
    feature.orthophoto = { path: observation.public };
    Object.defineProperty(feature.orthophoto.path, "corridorLocal", {
      enumerable: false,
      value: observation.corridorLocal
    });
    observations.push(observation);
  }

  const accepted = observations.filter((item) => item.public.status === "accepted");
  const compilationEligible = accepted.filter((item) => item.public.compilationEligible);
  const totalLengthM = observations.reduce((sum, item) => sum + item.public.routeLengthM, 0);
  const measuredLengthM = accepted.reduce((sum, item) => sum + item.public.measuredLengthM, 0);
  const landCover = analyzeLandCover(map, imagery, options);
  const summary = {
    schemaVersion: 1,
    status: accepted.length ? "available" : "no-accepted-path-observations",
    mode,
    source: imagery.source,
    rasters: imagery.rasters,
    analyzedFeatures: observations.length,
    acceptedFeatures: accepted.length,
    compilationEligibleFeatures: compilationEligible.length,
    rejectedFeatures: observations.length - accepted.length,
    routeLengthM: round1(totalLengthM),
    measuredRouteLengthM: round1(measuredLengthM),
    measuredRouteCoverage: ratio(measuredLengthM, totalLengthM),
    widthObservedFeatures: accepted.filter((item) => item.public.widthM !== null).length,
    colourObservedFeatures: accepted.filter((item) => item.public.colour).length,
    materialClassifiedFeatures: accepted.filter((item) => item.public.material).length,
    patternClassifiedFeatures: accepted.filter((item) => item.public.pattern).length,
    rejectionReasons: countBy(observations.filter((item) => item.public.status !== "accepted"),
      (item) => item.public.rejectionReason || "unknown"),
    landCover,
    limitations: [
      "Mapped routes seed the search; this phase does not claim that every unmapped or obscured path has been discovered.",
      "Shadows, tree canopy, temporary objects, survey age, and image compression can prevent an edge observation.",
      "Material and laying pattern are promoted only when spectral/texture confidence clears the configured gate.",
      "Natural-ground aerial classes may texture terrain in evidence mode; hardscape, water, roofs, and shadow remain review-only."
    ],
    observations: observations.map((item) => item.public)
  };
  if (typeof landCover.sampleLocal === "function") {
    Object.defineProperty(summary, "sampleTerrainLocal", {
      enumerable: false,
      value: landCover.sampleLocal
    });
  }
  map.orthophoto = summary;
  return { summary, qaGeojson: buildQaGeojson(map, observations, landCover, imagery) };
}

export function analyzePathFeature(feature, imagery, options = {}, projector = null) {
  const sampleSpacingM = Math.max(0.5, options.orthophotoSampleM || DEFAULT_SAMPLE_SPACING_M);
  const maxWidthM = Math.max(2, options.orthophotoPathMaxWidthM || DEFAULT_MAX_PATH_WIDTH_M);
  const stepM = clamp(Math.max(imagery.minimumGsdM || 0.25, 0.25), 0.25, 0.75);
  const minConfidence = options.orthophotoMinConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const sections = [];
  let routeLengthM = 0;

  for (const [lineIndex, line] of lineStrings(feature.localGeometry).entries()) {
    const samples = sampleLine(line, sampleSpacingM, lineIndex);
    routeLengthM += lineLength(line);
    for (const sample of samples) {
      const section = analyzeCrossSection(sample, imagery.sampleRgbLocal, {
        stepM,
        maxWidthM,
        colourThreshold: options.orthophotoEdgeDeltaE || 18
      });
      sections.push(section);
    }
  }

  const valid = sections.filter((section) => section.accepted);
  const minimumSections = Math.min(3, Math.max(1, Math.ceil(sections.length * 0.2)));
  const coverage = ratio(valid.length, sections.length);
  const widths = valid.map((section) => section.widthM).sort((a, b) => a - b);
  const widthM = widths.length ? round1(median(widths)) : null;
  const widthRangeM = widths.length ? [round1(percentile(widths, 0.1)), round1(percentile(widths, 0.9))] : null;
  const widthMad = widths.length ? median(widths.map((value) => Math.abs(value - median(widths))).sort((a, b) => a - b)) : null;
  const edgeContrast = valid.length ? mean(valid.map((section) => section.edgeContrast)) : 0;
  const resolutionScore = clamp(1 - ((imagery.minimumGsdM || 1) - 0.1) / 1.4, 0.35, 1);
  const consistency = widthM ? clamp(1 - (widthMad || 0) / Math.max(1, widthM), 0, 1) : 0;
  const provenanceScore = imagery.provenanceComplete ? 1 : imagery.mode === "assist" ? 0.55 : 0;
  const confidence = round3(
    0.08 + 0.25 * coverage + 0.2 * resolutionScore +
    0.22 * clamp(edgeContrast / 35, 0, 1) + 0.15 * consistency + 0.1 * provenanceScore
  );
  const accepted = valid.length >= minimumSections && confidence >= minConfidence;
  const colourEvidence = accepted ? deriveObservedColour(valid) : null;
  const appearanceSamples = accepted ? valid.flatMap((section) => section.interiorRgb) : [];
  const material = accepted ? classifyMaterial(appearanceSamples, imagery.minimumGsdM) : null;
  const pattern = accepted ? classifyPattern(appearanceSamples, imagery.minimumGsdM) : null;
  const acceptedSections = accepted ? filterOutlierSections(valid, widthM, widthMad) : [];
  const corridorLocal = accepted ? corridorFromSections(acceptedSections, sampleSpacingM) : null;
  const measuredLengthM = acceptedSections.length * sampleSpacingM;
  const source = {
    method: "orthophoto cross-section edge measurement",
    provider: imagery.source?.provider || null,
    sourceUrl: imagery.source?.sourceUrl || null,
    license: imagery.source?.license || null,
    capturedAt: imagery.source?.capturedAt || null,
    rasterHashes: imagery.rasters.map((raster) => raster.sha256),
    gsdM: imagery.minimumGsdM
  };
  const rejectionReason = accepted ? null
    : valid.length < minimumSections ? "insufficient-visible-cross-sections"
      : confidence < minConfidence ? "confidence-below-threshold" : "no-usable-image-evidence";

  return {
    corridorLocal,
    sections,
    public: {
      schemaVersion: 1,
      featureId: feature.id,
      featureName: feature.name,
      featureKind: feature.kind,
      status: accepted ? "accepted" : "rejected",
      compilationEligible: Boolean(accepted && imagery.mode === "evidence" && imagery.provenanceComplete),
      rejectionReason,
      routeLengthM: round1(routeLengthM),
      sampledCrossSections: sections.length,
      acceptedCrossSections: acceptedSections.length,
      rejectedCrossSections: sections.length - valid.length,
      coverage,
      measuredLengthM: round1(Math.min(routeLengthM, measuredLengthM)),
      widthM: accepted ? widthM : null,
      rasterWidthM: accepted ? Math.max(1, Math.round(widthM)) : null,
      widthRangeM: accepted ? widthRangeM : null,
      widthMadM: accepted ? round2(widthMad || 0) : null,
      edgeContrastDeltaE76: accepted ? round1(edgeContrast) : null,
      colour: colourEvidence?.hex || null,
      colourRgb: colourEvidence?.rgb || null,
      colourConfidence: colourEvidence?.confidence || 0,
      shadowRejectedSamples: colourEvidence?.shadowRejected || 0,
      material: material?.confidence >= (options.orthophotoMaterialMinConfidence || 0.82) ? material.value : null,
      materialCandidate: material,
      pattern: pattern?.confidence >= (options.orthophotoPatternMinConfidence || 0.82) ? pattern.value : null,
      patternCandidate: pattern,
      confidence,
      source,
      method: {
        seed: "mapped route centreline",
        edge: "bidirectional CIELAB discontinuity",
        colour: "shadow-rejected robust interior median",
        width: "median accepted cross-section edge distance",
        corridor: "variable-width cross-section envelope"
      },
      qaCrossSections: acceptedSections.map((section) => ({
        center: roundPoint(section.center),
        left: roundPoint(section.left),
        right: roundPoint(section.right),
        widthM: round2(section.widthM),
        edgeContrastDeltaE76: round1(section.edgeContrast)
      })),
      qaGeometry: corridorLocal && projector ? localGeometryToWgs84(corridorLocal, projector) : null
    }
  };
}

function analyzeCrossSection(sample, sampleRgb, settings) {
  const centerPatch = patchSamples(sampleRgb, sample.center, sample.tangent, sample.normal, settings.stepM);
  if (centerPatch.length < 3) return rejectedSection(sample, "imagery-gap");
  const centerRgb = robustRgb(centerPatch);
  if (looksVegetated(centerRgb)) return rejectedSection(sample, "canopy-or-vegetation-occlusion");
  const maxHalf = settings.maxWidthM / 2;
  const left = findEdge(-1), right = findEdge(1);
  if (!left || !right) return rejectedSection(sample, "edge-not-bounded");
  const widthM = left.insideOffset + right.insideOffset;
  if (widthM < 0.75 || widthM > settings.maxWidthM) return rejectedSection(sample, "implausible-width");
  const leftPoint = offsetPoint(sample.center, sample.normal, -left.insideOffset);
  const rightPoint = offsetPoint(sample.center, sample.normal, right.insideOffset);
  const interiorRgb = [];
  for (let offset = -left.insideOffset; offset <= right.insideOffset + 1e-9; offset += settings.stepM) {
    const rgb = sampleRgb(...offsetPoint(sample.center, sample.normal, offset));
    if (rgb && !looksVegetated(rgb)) interiorRgb.push(rgb);
  }
  return {
    ...sample,
    accepted: true,
    reason: null,
    left: leftPoint,
    right: rightPoint,
    leftM: left.insideOffset,
    rightM: right.insideOffset,
    widthM,
    edgeContrast: (left.contrast + right.contrast) / 2,
    centerRgb,
    interiorRgb
  };

  function findEdge(direction) {
    let previous = centerRgb;
    let insideOffset = 0;
    let mismatches = 0;
    let strongest = 0;
    for (let offset = settings.stepM; offset <= maxHalf + settings.stepM / 2; offset += settings.stepM) {
      const rgb = sampleRgb(...offsetPoint(sample.center, sample.normal, direction * offset));
      if (!rgb) return null;
      const seedDelta = deltaE76(rgb, centerRgb);
      const localDelta = deltaE76(rgb, previous);
      strongest = Math.max(strongest, seedDelta, localDelta);
      if (seedDelta > settings.colourThreshold && localDelta > settings.colourThreshold * 0.55) mismatches += 1;
      else mismatches = 0;
      if (mismatches >= 1) {
        if (insideOffset < settings.stepM) return null;
        return { insideOffset, contrast: Math.max(seedDelta, localDelta) };
      }
      insideOffset = offset;
      previous = rgb;
    }
    return strongest > settings.colourThreshold ? { insideOffset, contrast: strongest } : null;
  }
}

function sampleLine(line, spacingM, lineIndex) {
  const samples = [];
  let chainage = 0;
  for (let index = 1; index < line.length; index += 1) {
    const from = line[index - 1], to = line[index];
    const dx = to[0] - from[0], dz = to[1] - from[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.05) continue;
    const tangent = [dx / length, dz / length];
    const normal = [-tangent[1], tangent[0]];
    const steps = Math.max(1, Math.floor(length / spacingM));
    for (let step = index === 1 ? 0 : 1; step <= steps; step += 1) {
      const distance = Math.min(length, step * spacingM);
      samples.push({
        lineIndex,
        segmentIndex: index - 1,
        chainageM: chainage + distance,
        center: [from[0] + tangent[0] * distance, from[1] + tangent[1] * distance],
        tangent,
        normal
      });
    }
    chainage += length;
  }
  return samples;
}

function corridorFromSections(sections, sampleSpacingM) {
  const polygons = [];
  const sorted = [...sections].sort((a, b) => a.lineIndex - b.lineIndex || a.chainageM - b.chainageM);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1], current = sorted[index];
    if (previous.lineIndex !== current.lineIndex) continue;
    if (current.chainageM - previous.chainageM > sampleSpacingM * 2.5) continue;
    const ring = [previous.left, current.left, current.right, previous.right, previous.left]
      .map((point) => [point[0], point[1]]);
    polygons.push([ring]);
  }
  if (!polygons.length && sorted.length) {
    const section = sorted[0], half = Math.max(0.5, sampleSpacingM / 2);
    const before = offsetPoint(section.center, section.tangent, -half);
    const after = offsetPoint(section.center, section.tangent, half);
    polygons.push([[section.left, offsetPoint(after, section.normal, -section.leftM),
      offsetPoint(after, section.normal, section.rightM), section.right,
      offsetPoint(before, section.normal, section.rightM), offsetPoint(before, section.normal, -section.leftM), section.left]]);
  }
  return polygons.length ? { type: "MultiPolygon", coordinates: polygons } : null;
}

function deriveObservedColour(sections) {
  const values = sections.flatMap((section) => section.interiorRgb).filter(Boolean);
  if (!values.length) return null;
  const luminances = values.map(relativeLuminance).sort((a, b) => a - b);
  const shadowFloor = percentile(luminances, 0.2);
  const accepted = values.filter((rgb) => relativeLuminance(rgb) >= shadowFloor);
  const rgb = robustRgb(accepted.length ? accepted : values).map(Math.round);
  const distances = accepted.map((sample) => deltaE76(sample, rgb));
  const dispersion = distances.length ? median(distances.sort((a, b) => a - b)) : 0;
  return {
    rgb,
    hex: `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`,
    confidence: round3(clamp(0.96 - dispersion / 55, 0.45, 0.96)),
    shadowRejected: values.length - accepted.length
  };
}

function classifyMaterial(samples, gsdM) {
  if (samples.length < 8) return null;
  const colour = robustRgb(samples);
  const lab = rgbToLab(colour);
  const saturation = rgbSaturation(colour);
  const texture = mean(samples.map((sample) => deltaE76(sample, colour)));
  const resolution = Number(gsdM || 1);
  if (saturation < 0.2 && lab[0] < 52 && texture < 14) {
    return { value: "asphalt", confidence: round3(clamp(0.84 + (0.5 - resolution) * 0.08 - texture / 180, 0.68, 0.92)), method: "dark neutral low-texture spectral class" };
  }
  if (saturation < 0.18 && lab[0] >= 52 && lab[0] < 86 && texture < 12) {
    return { value: "concrete", confidence: round3(clamp(0.83 + (0.5 - resolution) * 0.06 - texture / 180, 0.67, 0.9)), method: "light neutral low-texture spectral class" };
  }
  if (saturation < 0.24 && texture > 18) {
    return { value: "gravel", confidence: round3(clamp(0.72 + (0.5 - resolution) * 0.08, 0.58, 0.8)), method: "neutral high-texture spectral candidate" };
  }
  const warmSoil = colour[0] > colour[1] * 1.13 && colour[1] > colour[2] * 1.12 &&
    saturation >= 0.18 && saturation <= 0.62 && lab[0] >= 28 && lab[0] <= 68;
  if (warmSoil) {
    const textureScore = clamp(1 - Math.abs(texture - 10) / 18, 0, 1);
    return {
      value: "earth",
      confidence: round3(clamp(0.74 + textureScore * 0.12 + (0.5 - resolution) * 0.05, 0.68, 0.88)),
      method: "warm brown route-seeded soil candidate; mulch/paving ambiguity remains confidence-gated"
    };
  }
  if (colour[0] > colour[1] * 1.15 && colour[1] > colour[2] * 1.05 && resolution <= 0.35) {
    return { value: "paving_stones", confidence: 0.7, method: "warm modular-surface candidate" };
  }
  return { value: null, confidence: 0, method: "unclassified" };
}

function classifyPattern(samples, gsdM) {
  if (samples.length < 8) return null;
  const centre = robustRgb(samples);
  const texture = mean(samples.map((sample) => deltaE76(sample, centre)));
  if (texture < 7 && Number(gsdM || 1) <= 0.6) {
    return { value: "solid", confidence: round3(clamp(0.91 - texture / 80, 0.82, 0.93)), method: "uniform orthophoto appearance" };
  }
  return { value: null, confidence: 0, method: "no defensible repeated laying pattern" };
}

function analyzeLandCover(map, imagery, options) {
  const spacingM = Math.max(1, options.orthophotoLandcoverSampleM || 5);
  const polygons = map.boundary.localGeometry.type === "Polygon"
    ? [map.boundary.localGeometry.coordinates]
    : map.boundary.localGeometry.type === "MultiPolygon" ? map.boundary.localGeometry.coordinates : [];
  if (!polygons.length) return { status: "boundary-unavailable", sampleSpacingM: spacingM, samples: 0, classes: {} };
  const bounds = geometryBounds(map.boundary.localGeometry);
  const samples = [];
  const counts = {};
  const sampleLocal = (x, z) => sampleAerialClassification(
    imagery.sampleRgbLocal, x, z, imagery.minimumGsdM || 0.5
  );
  for (let z = Math.floor(bounds.minZ); z <= Math.ceil(bounds.maxZ); z += spacingM) {
    for (let x = Math.floor(bounds.minX); x <= Math.ceil(bounds.maxX); x += spacingM) {
      if (!polygons.some((polygon) => pointInPolygon(x, z, polygon))) continue;
      const classification = sampleLocal(x, z);
      if (!classification) continue;
      counts[classification.class] = (counts[classification.class] || 0) + 1;
      if (classification.confidence >= 0.7 && samples.length < 8000) {
        samples.push({ x, z, ...classification });
      }
    }
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const compilationEligible = Boolean(
    imagery.mode === "evidence" && imagery.provenanceComplete && total
  );
  const result = {
    status: total ? "candidate-observations" : "no-coverage",
    compilationStatus: compilationEligible
      ? "natural-ground texture and vegetation-density evidence may compile; hardscape/water/shadow remain review-only"
      : "qa-only; imagery provenance or evidence mode is insufficient for compilation",
    compilationEligible,
    sampleSpacingM: spacingM,
    samples: total,
    classes: counts,
    classCoverage: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, ratio(value, total)])),
    qaSamples: samples,
    limitations: [
      "Aerial natural-ground classes texture only cells not later overwritten by mapped paths, roads, water, or explicit land-cover polygons.",
      "Water, roof, neutral-hardscape, and shadow candidates never become geometry from colour alone.",
      "Canopy classes adjust vegetation density only inside mapped vegetation cover or mapped tree lines."
    ]
  };
  Object.defineProperty(result, "sampleLocal", { enumerable: false, value: sampleLocal });
  return result;
}

function buildQaGeojson(map, observations, landCover, imagery) {
  const features = [];
  for (const observation of observations) {
    if (!observation.public.qaGeometry) continue;
    features.push({
      type: "Feature",
      id: `orthophoto:${observation.public.featureId}`,
      geometry: observation.public.qaGeometry,
      properties: {
        feature_id: observation.public.featureId,
        feature_name: observation.public.featureName,
        status: observation.public.status,
        width_m: observation.public.widthM,
        width_range_m: observation.public.widthRangeM,
        colour: observation.public.colour,
        material: observation.public.material,
        material_candidate: observation.public.materialCandidate,
        pattern: observation.public.pattern,
        confidence: observation.public.confidence,
        source: observation.public.source
      }
    });
  }
  for (const sample of landCover.qaSamples || []) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: map.projector.inverse([sample.x, sample.z]) },
      properties: {
        kind: "orthophoto_landcover_candidate",
        class: sample.class,
        confidence: sample.confidence,
        rgb: sample.rgb,
        source: imagery.source
      }
    });
  }
  return {
    type: "FeatureCollection",
    name: `${map.geojson?.name || "Theme Park"} orthophoto QA evidence`,
    features
  };
}

function emptyQa(map, imagery) {
  return {
    type: "FeatureCollection",
    name: `${map.geojson?.name || "Theme Park"} orthophoto QA evidence`,
    properties: { status: imagery?.status || "not-supplied" },
    features: []
  };
}

function emptySummary(imagery) {
  return {
    schemaVersion: 1,
    status: imagery?.status || "not-supplied",
    mode: imagery?.mode || "off",
    source: imagery?.source || null,
    rasters: imagery?.rasters || [],
    analyzedFeatures: 0,
    acceptedFeatures: 0,
    compilationEligibleFeatures: 0,
    rejectedFeatures: 0,
    routeLengthM: 0,
    measuredRouteLengthM: 0,
    measuredRouteCoverage: 0,
    widthObservedFeatures: 0,
    colourObservedFeatures: 0,
    materialClassifiedFeatures: 0,
    patternClassifiedFeatures: 0,
    rejectionReasons: {},
    landCover: { status: "not-analyzed", samples: 0, classes: {} },
    limitations: [imagery?.warning || "No orthophoto capability was active."]
  };
}

function createMosaicSampler(rasters) {
  const ranked = [...rasters].sort((a, b) => a.resolutionM - b.resolutionM);
  return (x, z) => {
    for (const raster of ranked) {
      const rgb = raster.sampleRgbLocal(x, z);
      if (rgb) return rgb;
    }
    return null;
  };
}

function createRgbSampler({ width, height, boundingBox, rgb }) {
  const [minX, minY, maxX, maxY] = boundingBox;
  const pixelWidth = (maxX - minX) / width;
  const pixelHeight = (maxY - minY) / height;
  return (x, y) => {
    const column = Math.floor((x - minX) / pixelWidth);
    const row = Math.floor((maxY - y) / pixelHeight);
    if (column < 0 || row < 0 || column >= width || row >= height) return null;
    const index = (row * width + column) * 3;
    const result = [Number(rgb[index]), Number(rgb[index + 1]), Number(rgb[index + 2])];
    return result.every(Number.isFinite) ? result : null;
  };
}

async function createLocalToImageTransform(epsg, options, context) {
  if (epsg === 4326) return (x, z) => context.projector.inverse([x, z]);
  if (epsg === 27700 && typeof context.elevation?.projectLocal === "function") {
    return (x, z) => context.elevation.projectLocal(x, z);
  }
  defineKnownProjection(epsg, options.orthophotoProj4);
  try {
    const transform = proj4("EPSG:4326", `EPSG:${epsg}`);
    return (x, z) => transform.forward(context.projector.inverse([x, z]));
  } catch (error) {
    throw new UserError(
      `Orthophoto CRS EPSG:${epsg} is not registered`,
      `Supply --orthophoto-proj4 with its projection definition. ${error?.message || ""}`.trim()
    );
  }
}

function defineKnownProjection(epsg, customDefinition) {
  if (customDefinition) proj4.defs(`EPSG:${epsg}`, customDefinition);
  if (proj4.defs(`EPSG:${epsg}`)) return;
  if (epsg >= 32601 && epsg <= 32660) {
    proj4.defs(`EPSG:${epsg}`, `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs +type=crs`);
  } else if (epsg >= 32701 && epsg <= 32760) {
    proj4.defs(`EPSG:${epsg}`, `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs +type=crs`);
  } else if (epsg === 27700) {
    proj4.defs("EPSG:27700", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs +type=crs");
  }
}

function projectedResolutionMetres(resolution, epsg, latitude) {
  if (epsg !== 4326) return Math.max(resolution[0], resolution[1]);
  const x = resolution[0] * DEG * EARTH_RADIUS_M * Math.cos(latitude * DEG);
  const y = resolution[1] * DEG * EARTH_RADIUS_M;
  return Math.max(Math.abs(x), Math.abs(y));
}

function parseEpsg(value) {
  if (!value) return null;
  const match = String(value).match(/(?:EPSG\s*:\s*)?(\d+)/i);
  return match ? Number(match[1]) : null;
}

function publicRasterMetadata(raster) {
  return {
    file: raster.file,
    sha256: raster.sha256,
    width: raster.width,
    height: raster.height,
    epsg: raster.epsg,
    bounds: raster.boundingBox,
    resolution: raster.resolution,
    resolutionM: raster.resolutionM
  };
}

function patchSamples(sampleRgb, center, tangent, normal, stepM) {
  const values = [];
  for (const along of [-stepM, 0, stepM]) {
    for (const across of [-stepM / 2, 0, stepM / 2]) {
      const point = [
        center[0] + tangent[0] * along + normal[0] * across,
        center[1] + tangent[1] * along + normal[1] * across
      ];
      const rgb = sampleRgb(point[0], point[1]);
      if (rgb) values.push(rgb);
    }
  }
  return values;
}

function filterOutlierSections(sections, widthM, widthMad) {
  const tolerance = Math.max(1.5, (widthMad || 0) * 3, widthM * 0.4);
  return sections.filter((section) => Math.abs(section.widthM - widthM) <= tolerance);
}

function rejectedSection(sample, reason) {
  return { ...sample, accepted: false, reason, left: null, right: null, widthM: null, edgeContrast: 0, interiorRgb: [] };
}

function offsetPoint(point, direction, distance) {
  return [point[0] + direction[0] * distance, point[1] + direction[1] * distance];
}

function lineStrings(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function lineLength(line) {
  let total = 0;
  for (let index = 1; index < line.length; index += 1) {
    total += Math.hypot(line[index][0] - line[index - 1][0], line[index][1] - line[index - 1][1]);
  }
  return total;
}

function localGeometryToWgs84(geometry, projector) {
  return {
    type: geometry.type,
    coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map((point) => projector.inverse(point))))
  };
}

function robustRgb(values) {
  return [0, 1, 2].map((band) => median(values.map((value) => value[band]).sort((a, b) => a - b)));
}

function looksVegetated([r, g, b]) {
  return g > 55 && g - (r + b) / 2 > 22;
}

function relativeLuminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function rgbSaturation(rgb) {
  const max = Math.max(...rgb), min = Math.min(...rgb);
  return max ? (max - min) / max : 0;
}

function deltaE76(first, second) {
  const a = rgbToLab(first), b = rgbToLab(second);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function rgbToLab(rgb) {
  const linear = rgb.map((value) => {
    const channel = clamp(value / 255, 0, 1);
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const x = (linear[0] * 0.4124 + linear[1] * 0.3576 + linear[2] * 0.1805) / 0.95047;
  const y = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const z = (linear[0] * 0.0193 + linear[1] * 0.1192 + linear[2] * 0.9505) / 1.08883;
  const f = (value) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function countBy(values, selector) {
  const result = {};
  for (const value of values) {
    const key = selector(value);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function roundPoint(point) {
  return point.map((value) => round2(value));
}

const ratio = (numerator, denominator) => denominator ? round3(numerator / denominator) : 0;
const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
