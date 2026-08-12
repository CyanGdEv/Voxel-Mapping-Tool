import {
  blockForThemeParkSurfaceStyle,
  withThemeParkMaterialHints
} from "./surface-material-library.mjs";
import { polygonArea } from "./geo.mjs";
import { reconstructTreeCrownFromSamples } from "./tree-reconstruction.mjs";

const PATH_KINDS = new Set(["path", "road"]);

const NAMED_COLOURS = Object.freeze({
  black: "#202124", charcoal: "#343434", grey: "#808080", gray: "#808080",
  "dark grey": "#4b4b4b", "dark gray": "#4b4b4b", "light grey": "#c5c5c5",
  "light gray": "#c5c5c5", white: "#f2f2f2", red: "#a63d32", brick: "#9b4b3f",
  brown: "#765341", buff: "#c8ad7f", beige: "#c9b99a", tan: "#b89363",
  yellow: "#d5b53f", orange: "#c87832", blue: "#416b9b", green: "#5f7f4a"
});

// Approximate sRGB values for full Bedrock blocks. Selection is driven by the
// observed surface colour; the block texture is then constrained by material.
const BLOCK_COLOURS = Object.freeze([
  { block: "minecraft:black_concrete", rgb: [28, 30, 31], texture: "smooth", materials: ["asphalt", "rubber", "unknown"] },
  { block: "minecraft:gray_concrete", rgb: [55, 58, 62], texture: "smooth", materials: ["asphalt", "concrete", "rubber", "unknown"] },
  { block: "minecraft:gray_concrete_powder", rgb: [76, 81, 84], texture: "granular", materials: ["asphalt", "gravel", "compacted", "unknown"] },
  { block: "minecraft:deepslate", rgb: [79, 79, 82], texture: "stone", materials: ["stone", "sett", "cobblestone", "unknown"] },
  { block: "minecraft:tuff", rgb: [108, 109, 102], texture: "stone", materials: ["stone", "sett", "gravel", "unknown"] },
  { block: "minecraft:andesite", rgb: [136, 136, 136], texture: "stone", materials: ["stone", "sett", "gravel", "concrete", "unknown"] },
  { block: "minecraft:polished_andesite", rgb: [132, 134, 133], texture: "masonry", materials: ["paving_stones", "concrete", "stone", "unknown"] },
  { block: "minecraft:stone", rgb: [125, 125, 125], texture: "stone", materials: ["stone", "concrete", "sett", "unknown"] },
  { block: "minecraft:smooth_stone", rgb: [158, 158, 158], texture: "smooth", materials: ["concrete", "paving_stones", "unknown"] },
  { block: "minecraft:light_gray_concrete", rgb: [125, 125, 115], texture: "smooth", materials: ["asphalt", "concrete", "paving_stones", "unknown"] },
  { block: "minecraft:light_gray_concrete_powder", rgb: [154, 154, 148], texture: "granular", materials: ["concrete", "fine_gravel", "gravel", "unknown"] },
  { block: "minecraft:calcite", rgb: [223, 224, 220], texture: "stone", materials: ["concrete", "stone", "paving_stones", "unknown"] },
  { block: "minecraft:white_concrete", rgb: [207, 213, 214], texture: "smooth", materials: ["concrete", "paving_stones", "rubber", "unknown"] },
  { block: "minecraft:stone_bricks", rgb: [122, 121, 120], texture: "masonry", materials: ["paving_stones", "sett", "cobblestone", "stone"] },
  { block: "minecraft:cobblestone", rgb: [119, 118, 119], texture: "cobbled", materials: ["sett", "cobblestone", "stone", "gravel"] },
  { block: "minecraft:gravel", rgb: [131, 127, 126], texture: "granular", materials: ["gravel", "compacted", "fine_gravel"] },
  { block: "minecraft:brick_block", rgb: [151, 76, 62], texture: "masonry", materials: ["brick", "paving_stones", "sett"] },
  { block: "minecraft:red_terracotta", rgb: [143, 61, 47], texture: "masonry", materials: ["brick", "paving_stones", "rubber", "unknown"] },
  { block: "minecraft:red_concrete", rgb: [142, 32, 32], texture: "smooth", materials: ["concrete", "paving_stones", "rubber", "unknown"] },
  { block: "minecraft:orange_terracotta", rgb: [161, 83, 37], texture: "masonry", materials: ["brick", "paving_stones", "earth", "unknown"] },
  { block: "minecraft:brown_terracotta", rgb: [77, 51, 36], texture: "masonry", materials: ["brick", "paving_stones", "earth", "unknown"] },
  { block: "minecraft:brown_concrete", rgb: [96, 59, 31], texture: "smooth", materials: ["concrete", "paving_stones", "rubber", "unknown"] },
  { block: "minecraft:mud_bricks", rgb: [137, 104, 79], texture: "masonry", materials: ["brick", "paving_stones", "earth", "compacted"] },
  { block: "minecraft:packed_mud", rgb: [142, 106, 79], texture: "earth", materials: ["earth", "dirt", "compacted"] },
  { block: "minecraft:coarse_dirt", rgb: [119, 85, 59], texture: "earth", materials: ["earth", "dirt", "compacted"] },
  { block: "minecraft:dirt", rgb: [134, 96, 67], texture: "earth", materials: ["earth", "dirt"] },
  { block: "minecraft:dirt_with_roots", rgb: [144, 103, 76], texture: "earth", materials: ["earth", "dirt", "compacted"] },
  { block: "minecraft:podzol", rgb: [91, 63, 24], texture: "earth", materials: ["earth", "dirt", "woodland_floor"] },
  { block: "minecraft:sand", rgb: [219, 207, 163], texture: "granular", materials: ["sand", "fine_gravel"] },
  { block: "minecraft:smooth_sandstone", rgb: [223, 214, 170], texture: "smooth", materials: ["sand", "paving_stones", "stone"] },
  { block: "minecraft:sandstone", rgb: [216, 203, 155], texture: "stone", materials: ["sand", "stone", "paving_stones"] },
  { block: "minecraft:yellow_terracotta", rgb: [186, 133, 35], texture: "masonry", materials: ["paving_stones", "brick", "earth", "unknown"] },
  { block: "minecraft:yellow_concrete", rgb: [241, 175, 21], texture: "smooth", materials: ["concrete", "paving_stones", "rubber", "unknown"] },
  { block: "minecraft:orange_concrete", rgb: [224, 97, 0], texture: "smooth", materials: ["concrete", "paving_stones", "rubber", "unknown"] },
  { block: "minecraft:blue_concrete", rgb: [44, 46, 143], texture: "smooth", materials: ["concrete", "rubber", "unknown"] },
  { block: "minecraft:cyan_terracotta", rgb: [86, 91, 91], texture: "masonry", materials: ["paving_stones", "concrete", "unknown"] },
  { block: "minecraft:green_concrete", rgb: [73, 91, 36], texture: "smooth", materials: ["concrete", "rubber", "grass", "unknown"] },
  { block: "minecraft:moss_block", rgb: [89, 109, 45], texture: "organic", materials: ["grass", "vegetation", "woodland_floor"] },
  { block: "minecraft:grass_block", rgb: [91, 130, 54], texture: "organic", materials: ["grass", "vegetation"] },
  { block: "minecraft:spruce_planks", rgb: [114, 84, 48], texture: "planks", materials: ["wood", "boardwalk"] },
  { block: "minecraft:dark_oak_planks", rgb: [67, 43, 20], texture: "planks", materials: ["wood", "boardwalk"] },
  { block: "minecraft:oak_planks", rgb: [162, 130, 79], texture: "planks", materials: ["wood", "boardwalk"] }
]);

const MATERIAL_ALIASES = Object.freeze({
  asphalt: "asphalt", paved: "asphalt", tarmac: "asphalt", bitumen: "asphalt",
  concrete: "concrete", "concrete:plates": "concrete", "concrete:lanes": "concrete",
  paving_stones: "paving_stones", paving_slabs: "paving_stones", slabs: "paving_stones",
  flagstone: "paving_stones", tiles: "paving_stones", block_paving: "paving_stones",
  grey_block_paving: "paving_stones", gray_block_paving: "paving_stones",
  red_block_paving: "paving_stones", buff_paving: "paving_stones",
  resin_bound_beige: "paving_stones", resin_bound_grey: "paving_stones", resin_bound_gray: "paving_stones",
  weathered_asphalt: "asphalt", fresh_black_asphalt: "asphalt", light_asphalt: "asphalt", red_tarmac: "asphalt",
  brick: "brick", bricks: "brick", clay_pavers: "brick", sett: "sett",
  unhewn_cobblestone: "cobblestone", cobblestone: "cobblestone", gravel: "gravel",
  fine_gravel: "fine_gravel", compacted: "compacted", wood: "wood", wooden: "wood",
  boardwalk: "boardwalk", earth: "earth", dirt: "dirt", ground: "earth", mud: "earth",
  mulch: "earth", woodchips: "earth", sand: "sand", grass: "grass", rubber: "rubber",
  tartan: "rubber", stone: "stone", limestone: "stone", sandstone: "stone"
});

const DEFAULT_MATERIAL_BLOCKS = Object.freeze({
  asphalt: ["minecraft:gray_concrete", "minecraft:black_concrete", "minecraft:gray_concrete_powder"],
  concrete: ["minecraft:light_gray_concrete", "minecraft:smooth_stone", "minecraft:light_gray_concrete_powder"],
  paving_stones: ["minecraft:stone_bricks", "minecraft:polished_andesite", "minecraft:light_gray_concrete"],
  brick: ["minecraft:brick_block", "minecraft:red_terracotta", "minecraft:mud_bricks"],
  sett: ["minecraft:cobblestone", "minecraft:stone_bricks", "minecraft:tuff"],
  cobblestone: ["minecraft:cobblestone", "minecraft:stone_bricks", "minecraft:andesite"],
  gravel: ["minecraft:gravel", "minecraft:andesite", "minecraft:gray_concrete_powder"],
  fine_gravel: ["minecraft:light_gray_concrete_powder", "minecraft:gravel", "minecraft:sand"],
  compacted: ["minecraft:gravel", "minecraft:coarse_dirt", "minecraft:packed_mud"],
  wood: ["minecraft:spruce_planks", "minecraft:oak_planks", "minecraft:dark_oak_planks"],
  boardwalk: ["minecraft:spruce_planks", "minecraft:dark_oak_planks", "minecraft:oak_planks"],
  earth: ["minecraft:coarse_dirt", "minecraft:dirt_with_roots", "minecraft:podzol"],
  dirt: ["minecraft:dirt", "minecraft:coarse_dirt", "minecraft:dirt_with_roots"],
  sand: ["minecraft:sand", "minecraft:smooth_sandstone", "minecraft:sandstone"],
  grass: ["minecraft:grass_block", "minecraft:moss_block", "minecraft:coarse_dirt"],
  rubber: ["minecraft:black_concrete", "minecraft:gray_concrete", "minecraft:red_concrete"],
  stone: ["minecraft:stone_bricks", "minecraft:andesite", "minecraft:tuff"]
});

export function enrichUniversalFidelity(map, sources, options = {}) {
  const pathFeatures = map.features.filter((feature) => PATH_KINDS.has(feature.kind));
  const treeFeatures = map.features.filter((feature) => feature.kind === "vegetation");
  const bridgeFeatures = pathFeatures.filter(isBridgeFeature);
  const terrainDetailFeatures = map.features.filter((feature) => feature.terrainDetail);

  for (const feature of pathFeatures) {
    feature.fidelity ||= {};
    feature.fidelity.path = derivePathEvidence(feature, options);
    feature.surfaceStyle = feature.fidelity.path.surfaceStyle;
    feature.pathEdgeStyle = feature.fidelity.path.edgeStyle;
  }
  for (const feature of bridgeFeatures) {
    feature.fidelity.bridge = deriveBridgeEvidence(feature, sources, options);
  }
  for (const feature of treeFeatures) {
    feature.fidelity ||= {};
    feature.fidelity.tree = deriveTreeEvidence(feature, sources, options);
  }
  for (const feature of terrainDetailFeatures) {
    feature.fidelity ||= {};
    feature.fidelity.terrainDetail = feature.terrainDetail;
  }

  const pathNetwork = summarizePathNetwork(pathFeatures, map.pathTopology, map.pathGeometry);
  const surfaces = summarizeSurfaceEvidence(pathFeatures, options);
  const trees = summarizeTreeEvidence(treeFeatures);
  const bridges = summarizeBridgeEvidence(bridgeFeatures);
  const sourceCapabilities = buildSourceCapabilities({
    sources, pathNetwork, surfaces, trees, bridges,
    orthophoto: map.orthophoto, pathGeometry: map.pathGeometry, pathTopology: map.pathTopology,
    terrainDetails: map.terrainDetails
  });
  const fidelity = {
    schemaVersion: 1,
    model: "universal-capability-fusion",
    generatedAt: new Date().toISOString(),
    rule: "Unknown observations remain unknown; park-specific evidence is optional and never required by the compiler.",
    pathNetwork,
    surfaces,
    orthophoto: map.orthophoto,
    pathGeometry: map.pathGeometry,
    pathTopology: map.pathTopology,
    terrainDetails: map.terrainDetails,
    trees,
    bridges,
    sourceCapabilities,
    featureObservations: map.features
      .filter((feature) => feature.fidelity)
      .map((feature) => ({ id: feature.id, kind: feature.kind, name: feature.name, ...feature.fidelity }))
  };
  map.fidelity = fidelity;
  return fidelity;
}

export function deriveSurfaceStyle(feature, options = {}) {
  const tags = feature.tags || {};
  const image = feature.orthophoto?.path?.status === "accepted" &&
    feature.orthophoto.path.compilationEligible !== false ? feature.orthophoto.path : null;
  const taggedMaterial = firstValue(
    tags.surface, tags.material, tags.surface_material, tags["surface:material"],
    tags["tpmap:material"], tags["themepark:material"], tags.paving
  );
  const rawMaterial = firstValue(taggedMaterial, image?.material);
  const material = normalizeMaterial(rawMaterial);
  const taggedColour = firstValue(
    tags["surface:colour"], tags["surface:color"], tags.surface_colour, tags.surface_color,
    tags.colour, tags.color, tags.rgb, tags.surface_rgb
  );
  const rawColour = firstValue(taggedColour, image?.colour);
  const colour = parseColour(rawColour);
  const taggedPattern = firstValue(
    tags["surface:pattern"], tags["paving_stones:pattern"], tags.paving_pattern, tags.pattern
  );
  const rawPattern = firstValue(taggedPattern, image?.pattern);
  const explicitPattern = normalizePattern(rawPattern);
  const blocks = chooseSurfaceBlocks(material, colour);
  const hasObservedAppearance = Boolean(material || colour || explicitPattern);
  const verified = (options.accuracyMode || "verified") === "verified";
  const fallback = verified
    ? ["minecraft:orange_concrete", "minecraft:orange_concrete"]
    : feature.kind === "road"
      ? ["minecraft:gray_concrete", "minecraft:black_concrete"]
      : ["minecraft:gravel", "minecraft:andesite"];
  const [primaryBlock, secondaryBlock, tertiaryBlock = secondaryBlock] = blocks || [...fallback, fallback[1]];
  const pattern = explicitPattern || (hasObservedAppearance ? defaultPattern(material) : "solid");
  const patternScale = clamp(Math.round(parseLength(firstValue(
    tags["surface:pattern_scale"], tags.pattern_scale, tags.paver_size_m
  )) || defaultPatternScale(material)), 1, 12);
  const patternRotation = normalizePatternRotation(firstValue(
    tags["surface:pattern_direction"], tags.pattern_direction, tags.direction
  ));
  const minecraftShape = normalizeMinecraftShape(firstValue(
    tags.minecraft_shape, tags["minecraft:shape"], tags.block_shape, tags.blockShape
  ));
  const minecraftDirection = normalizeMinecraftDirection(firstValue(
    tags.minecraft_direction, tags["minecraft:direction"], tags.block_direction
  ));
  const colourError = colour ? colourDistance(colour.rgb, blockRgb(primaryBlock)) : null;
  const imageMaterial = !taggedMaterial && Boolean(image?.material);
  const imageColour = !taggedColour && Boolean(image?.colour);
  const imagePattern = !taggedPattern && Boolean(image?.pattern);
  return withThemeParkMaterialHints({
    schemaVersion: 1,
    material: material || null,
    materialObservedAs: rawMaterial || null,
    materialSource: material ? imageMaterial
      ? orthophotoSource(image, "orthophoto spectral/texture material classification")
      : evidenceSource(feature, "surface/material tag") : null,
    colour: colour?.hex || null,
    colourObservedAs: rawColour || null,
    colourSource: colour ? imageColour
      ? orthophotoSource(image, "orthophoto shadow-rejected surface colour observation")
      : evidenceSource(feature, "surface colour observation") : null,
    nearestBlockColourDeltaE76: colourError === null ? null : round1(colourError),
    pattern,
    patternObservedAs: rawPattern || null,
    patternSource: explicitPattern ? imagePattern
      ? orthophotoSource(image, "orthophoto texture-pattern classification")
      : evidenceSource(feature, "surface pattern observation") : null,
    primaryBlock,
    secondaryBlock,
    tertiaryBlock,
    paletteBlocks: [primaryBlock, secondaryBlock, tertiaryBlock],
    paletteWeights: paletteWeightsFor(material, pattern),
    patternScale,
    patternRotation,
    minecraftShape,
    minecraftDirection,
    appearanceStatus: hasObservedAppearance
      ? (imageMaterial || imageColour || imagePattern ? "orthophoto-observed" : "observed-or-tagged")
      : "unknown-visible-fallback",
    confidence: round3(
      (material ? 0.38 * (imageMaterial ? image?.materialCandidate?.confidence || 0 : 1) : 0) +
      (colour ? 0.38 * (imageColour ? image?.colourConfidence || 0 : 1) : 0) +
      (explicitPattern ? 0.24 * (imagePattern ? image?.patternCandidate?.confidence || 0 : 1) : 0)
    )
  }, feature);
}

export function blockForSurfaceStyle(style, x, z, seed = 0) {
  return applyExplicitMinecraftShape(rawBlockForSurfaceStyle(style, x, z, seed), style);
}

function rawBlockForSurfaceStyle(style, x, z, seed = 0) {
  if (!style) return "minecraft:grass_block";
  const themeParkBlock = blockForThemeParkSurfaceStyle(style, x, z, seed);
  if (themeParkBlock) return themeParkBlock;
  const palette = [style.primaryBlock, style.secondaryBlock, style.tertiaryBlock]
    .filter(Boolean);
  const primary = palette[0] || "minecraft:grass_block";
  const secondary = palette[1] || primary;
  const tertiary = palette[2] || secondary;
  if (palette.every((block) => block === primary) || style.pattern === "solid") return primary;

  const scale = Math.max(1, Math.round(style.patternScale || 1));
  const rotation = Number(style.patternRotation || 0);
  const rawX = Math.round(x), rawZ = Math.round(z);
  const rotated = rotateGrid(rawX, rawZ, rotation);
  const px = mod(Math.floor(rotated[0] / scale), 24);
  const pz = mod(Math.floor(rotated[1] / scale), 24);

  if (style.pattern === "checker") return (px + pz) % 2 ? secondary : primary;
  if (style.pattern === "herringbone") {
    if ((px + 2 * pz) % 7 === 0) return tertiary;
    return ((px + 2 * pz) % 4 === 0 || (2 * px + pz) % 5 === 0) ? secondary : primary;
  }
  if (style.pattern === "running_bond") {
    if ((px + pz) % 11 === 0) return tertiary;
    return ((px + (pz % 2) * 2) % 5 === 0) ? secondary : primary;
  }
  if (style.pattern === "grid") return (px % 4 === 0 || pz % 4 === 0) ? secondary : primary;
  if (style.pattern === "slabs") return (px % 5 === 0 || pz % 7 === 0) ? secondary : primary;
  if (style.pattern === "stripes") return px % 3 === 0 ? secondary : primary;
  if (style.pattern === "mosaic") {
    const roll = hash2d(Math.floor(rawX / scale), Math.floor(rawZ / scale), seed) % 100;
    return roll < 20 ? tertiary : roll < 48 ? secondary : primary;
  }
  if (["mixed", "speckled", "organic"].includes(style.pattern)) {
    const weights = normalizeWeights(style.paletteWeights || paletteWeightsFor(style.material, style.pattern));
    const roll = hash2d(rawX, rawZ, seed) % 10_000 / 10_000;
    if (roll < weights[0]) return primary;
    if (roll < weights[0] + weights[1]) return secondary;
    return tertiary;
  }
  return hash2d(rawX, rawZ, seed) % 100 < 18 ? secondary : primary;
}

export function isBridgeFeature(feature) {
  const value = String(feature.tags?.bridge || "").toLowerCase();
  return (value && value !== "no") || feature.tags?.man_made === "bridge" || feature.tags?.highway === "via_ferrata";
}

function derivePathEvidence(feature, options) {
  const tags = feature.tags || {};
  const role = classifyPathRole(tags, feature.kind);
  const width = derivePathWidth(feature, role, options);
  const surfaceStyle = deriveSurfaceStyle(feature, options);
  return {
    role,
    geometryClass: ["Polygon", "MultiPolygon"].includes(feature.localGeometry?.type) ? "area" : "linear",
    sourceRepair: feature.pathGeometry || null,
    ...width,
    accessibility: {
      foot: tags.foot || null,
      wheelchair: tags.wheelchair || null,
      access: tags.access || null,
      steps: tags.highway === "steps"
    },
    bridge: isBridgeFeature(feature),
    tunnel: Boolean(tags.tunnel && tags.tunnel !== "no"),
    layer: numericOrNull(tags.layer),
    surfaceStyle,
    edgeStyle: derivePathEdgeStyle(feature, surfaceStyle, options)
  };
}

export function derivePathWidth(feature, role = classifyPathRole(feature.tags || {}, feature.kind), options = {}) {
  const tags = feature.tags || {};
  if (["Polygon", "MultiPolygon"].includes(feature.localGeometry?.type)) {
    return {
      widthM: null,
      rasterWidthM: null,
      widthRangeM: null,
      widthStatus: "area-footprint",
      widthConfidence: 0.98,
      widthSource: evidenceSource(feature, "mapped area footprint; scalar width not required")
    };
  }

  const widthStart = parseLength(firstValue(tags["width:start"], tags.width_start, tags["width:begin"]));
  const widthEnd = parseLength(firstValue(tags["width:end"], tags.width_end, tags["width:finish"]));
  if (Number.isFinite(widthStart) && widthStart > 0 && Number.isFinite(widthEnd) && widthEnd > 0) {
    const startM = clamp(round1(widthStart), 0.5, 40);
    const endM = clamp(round1(widthEnd), 0.5, 40);
    const nominal = round1((startM + endM) / 2);
    return {
      widthM: nominal,
      rasterWidthM: rasterWidth(nominal),
      widthRangeM: [Math.min(startM, endM), Math.max(startM, endM)],
      widthStatus: "variable-width-tagged",
      widthConfidence: 0.92,
      widthProfile: { method: "linear-endpoint-interpolation", startM, endM },
      widthSource: evidenceSource(feature, "tagged start/end width profile")
    };
  }

  const directCandidates = [
    [tags.width, "observed-width", "width observation", 0.95],
    [tags.measured_width_m, "observed-width", "measured width observation", 0.98],
    [tags["width:carriageway"], "observed-width", "carriageway width observation", 0.92]
  ];
  for (const [raw, status, method, confidence] of directCandidates) {
    const parsed = parseLength(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    const widthM = clamp(round1(parsed), 0.5, 40);
    return {
      widthM,
      rasterWidthM: rasterWidth(widthM),
      widthRangeM: status === "observed-width" ? [widthM, widthM] : [round1(widthM * 0.8), round1(widthM * 1.2)],
      widthStatus: status,
      widthConfidence: confidence,
      widthSource: evidenceSource(feature, method)
    };
  }

  const image = feature.orthophoto?.path;
  if (image?.status === "accepted" && image.compilationEligible !== false &&
      Number.isFinite(image.widthM) && image.widthM > 0) {
    const widthM = clamp(round1(image.widthM), 0.5, 40);
    return {
      widthM,
      rasterWidthM: rasterWidth(widthM),
      widthRangeM: image.widthRangeM || [widthM, widthM],
      widthStatus: "orthophoto-edge-observed",
      widthConfidence: image.confidence,
      widthSource: {
        ...orthophotoSource(image, "orthophoto cross-section edge measurement"),
        observed: true,
        acceptedCrossSections: image.acceptedCrossSections,
        edgeContrastDeltaE76: image.edgeContrastDeltaE76,
        variableWidthCorridor: Boolean(image.qaGeometry)
      }
    };
  }

  const estimated = parseLength(tags.est_width);
  if (Number.isFinite(estimated) && estimated > 0) {
    const widthM = clamp(round1(estimated), 0.5, 40);
    return {
      widthM,
      rasterWidthM: rasterWidth(widthM),
      widthRangeM: [round1(widthM * 0.8), round1(widthM * 1.2)],
      widthStatus: "tag-estimate",
      widthConfidence: 0.76,
      widthSource: evidenceSource(feature, "estimated-width tag")
    };
  }

  const lanes = integerOrNull(tags.lanes);
  if (feature.kind === "road" && lanes) {
    const laneWidth = clamp(parseLength(tags.lane_width) || 3.1, 2.4, 4);
    const widthM = round1(lanes * laneWidth);
    return {
      widthM,
      rasterWidthM: rasterWidth(widthM),
      widthRangeM: [round1(lanes * Math.max(2.4, laneWidth - 0.4)), round1(lanes * Math.min(4, laneWidth + 0.4))],
      widthStatus: "lanes-derived",
      widthConfidence: tags.lane_width ? 0.82 : 0.64,
      widthSource: {
        ...evidenceSource(feature, "lane-count-derived width"),
        lanes,
        laneWidthM: laneWidth,
        inference: !tags.lane_width
      }
    };
  }

  const mode = options.pathWidthMode || "inferred";
  if (mode === "source-only") {
    return {
      widthM: null,
      rasterWidthM: 1,
      widthRangeM: null,
      widthStatus: "unknown-marker",
      widthConfidence: 0,
      widthSource: null
    };
  }

  const prior = universalWidthPrior(feature, role);
  return {
    widthM: prior.nominal,
    rasterWidthM: rasterWidth(prior.nominal),
    widthRangeM: prior.range,
    widthStatus: "class-prior",
    widthConfidence: prior.confidence,
    widthSource: {
      ...evidenceSource(feature, "universal route-class width prior"),
      observed: false,
      basis: prior.basis,
      rangeM: prior.range
    }
  };
}

function universalWidthPrior(feature, role) {
  const tags = feature.tags || {};
  const highway = String(tags.highway || "").toLowerCase();
  const footway = String(tags.footway || "").toLowerCase();
  const service = String(tags.service || "").toLowerCase();
  const make = (nominal, min, max, confidence, extra = {}) => ({
    nominal, range: [min, max], confidence, basis: { highway, role, footway: footway || null, service: service || null, ...extra }
  });

  if (role === "queue") return make(2, 1.4, 2.5, 0.56, { use: "queue-line" });
  if (highway === "pedestrian") return make(6, 3.5, 10, 0.5, { use: "pedestrian-plaza-centreline" });
  if (highway === "steps") return make(2.5, 1.5, 4, 0.5, { use: "steps" });
  if (highway === "corridor" || tags.indoor === "yes") return make(2, 1.5, 3, 0.52, { use: "indoor-corridor" });
  if (footway === "sidewalk") return make(2, 1.5, 3, 0.54, { use: "sidewalk" });
  if (footway === "crossing") return make(3, 2, 5, 0.48, { use: "crossing" });
  if (highway === "cycleway") return make(3, 2, 4.5, 0.52, { use: "cycleway" });
  if (highway === "bridleway") return make(3, 2, 4.5, 0.48, { use: "bridleway" });
  if (highway === "footway") {
    return role === "service"
      ? make(2, 1.2, 3, 0.43, { use: "restricted-footway" })
      : make(3, 2, 5, 0.5, { use: "guest-footway" });
  }
  if (highway === "path") {
    return role === "service"
      ? make(2, 1, 3, 0.4, { use: "restricted-path" })
      : make(2.5, 1.5, 4, 0.46, { use: "guest-path" });
  }
  if (highway === "track") return make(3, 2, 4.5, 0.45, { use: "track-road" });
  if (highway === "service") {
    if (service === "parking_aisle") return make(5, 3.5, 6.5, 0.48, { use: "parking-aisle" });
    return make(4, 3, 5.5, 0.5, { use: "service-road" });
  }
  if (["living_street", "residential", "unclassified"].includes(highway)) return make(5.5, 4, 7, 0.5, { use: "local-road" });
  if (["tertiary", "secondary"].includes(highway)) return make(7, 5.5, 9, 0.48, { use: "two-lane-road" });
  if (["primary", "trunk"].includes(highway)) return make(8, 6.5, 11, 0.45, { use: "major-road" });
  return feature.kind === "road"
    ? make(4, 3, 6, 0.35, { use: "unclassified-road-fallback" })
    : make(2.5, 1.5, 4, 0.36, { use: "pedestrian-route-fallback" });
}

export function derivePathEdgeStyle(feature, surfaceStyle = deriveSurfaceStyle(feature), options = {}) {
  if ((options.pathEdgeMode || "evidence") === "off") return null;
  const tags = feature.tags || {};
  const rawKerb = firstValue(
    tags.kerb, tags["kerb:left"], tags["kerb:right"], tags["barrier:kerb"],
    tags.edging, tags.edge, tags["path:edge"]
  );
  const edgeMaterialRaw = firstValue(tags["edge:material"], tags.edge_material, tags["kerb:material"], tags.border_material);
  const edgeColourRaw = firstValue(tags["edge:colour"], tags["edge:color"], tags["kerb:colour"], tags["kerb:color"]);
  const explicitKerb = rawKerb !== null && rawKerb !== undefined && !["", "no", "none", "flush", "lowered"].includes(String(rawKerb).toLowerCase());
  const hasEvidence = explicitKerb || edgeMaterialRaw || edgeColourRaw || feature.tags?.barrier === "kerb";
  if (!hasEvidence) return null;
  const material = normalizeMaterial(edgeMaterialRaw) ||
    (String(rawKerb || "").toLowerCase().includes("stone") ? "stone" : "concrete");
  const colour = parseColour(edgeColourRaw);
  const blocks = chooseSurfaceBlocks(material, colour) || DEFAULT_MATERIAL_BLOCKS[material] ||
    ["minecraft:light_gray_concrete", "minecraft:smooth_stone", "minecraft:stone_bricks"];
  const [primaryBlock, secondaryBlock, tertiaryBlock = secondaryBlock] = blocks;
  return {
    schemaVersion: 1,
    enabled: true,
    role: "path-edge",
    material,
    colour: colour?.hex || null,
    primaryBlock,
    secondaryBlock,
    tertiaryBlock,
    paletteBlocks: [primaryBlock, secondaryBlock, tertiaryBlock],
    paletteWeights: [0.86, 0.12, 0.02],
    pattern: "mixed",
    patternScale: 2,
    patternRotation: surfaceStyle?.patternRotation || 0,
    widthBlocks: 1,
    confidence: edgeMaterialRaw || edgeColourRaw ? 0.92 : 0.84,
    source: evidenceSource(feature, "explicit kerb/edge tag")
  };
}

function deriveBridgeEvidence(feature, sources, options) {
  const tags = feature.tags || {};
  const explicitDeck = parseLength(firstValue(
    tags["bridge:deck:ele"], tags.deck_ele, tags.deck_elevation_m, tags.elevation_m, tags.ele
  ));
  const explicitClearance = parseLength(firstValue(
    tags["bridge:clearance"], tags.clearance, tags["maxheight:physical"], tags.min_height
  ));
  const samples = sampleGeometry(feature.localGeometry, 2)
    .map(([x, z]) => ({ x, z, pair: sources.elevation?.samplePairLocal?.(x, z) }))
    .filter(({ pair }) => Number.isFinite(pair?.surface) && Number.isFinite(pair?.terrain))
    .map(({ pair }) => ({ terrain: pair.terrain, surface: pair.surface, height: pair.surface - pair.terrain }))
    .filter((sample) => sample.height >= 0.6 && sample.height <= 35);
  let deckElevationM = explicitDeck;
  let deckHeightSource = explicitDeck === null ? null : "explicit-deck-elevation";
  let confidence = explicitDeck === null ? 0 : 0.95;
  if (deckElevationM === null && samples.length >= 3) {
    deckElevationM = percentile(samples.map((sample) => sample.surface).sort((a, b) => a - b), 0.35);
    deckHeightSource = "dsm-minus-dtm-bridge-corridor";
    confidence = Math.min(0.88, 0.55 + Math.log2(samples.length + 1) * 0.045);
  }
  const structure = normalizeBridgeStructure(firstValue(tags["bridge:structure"], tags.bridge, tags.man_made));
  const inferredAllowed = (options.accuracyMode || "verified") === "plausible";
  return {
    structure,
    widthM: feature.fidelity?.path?.widthM,
    deckElevationM: deckElevationM === null ? null : round2(deckElevationM),
    deckHeightSource,
    explicitClearanceM: explicitClearance,
    layer: numericOrNull(tags.layer),
    covered: truthyTag(tags.covered) || tags.bridge === "covered",
    parapet: firstValue(tags["bridge:parapet"], tags.barrier) || null,
    verticalStatus: deckElevationM !== null ? "measured-or-explicit" : inferredAllowed ? "inference-permitted" : "height-unknown-plan-only",
    sampleCount: samples.length,
    confidence: round3(confidence),
    source: deckHeightSource ? evidenceSource(feature, deckHeightSource) : null
  };
}

function deriveTreeEvidence(feature, sources, options) {
  const tags = feature.tags || {};
  const geometry = feature.localGeometry?.type || null;
  const point = geometryPoint(feature.localGeometry);
  const modelClass = vegetationModelClass(feature);
  const taggedHeight = parseLength(firstValue(tags.height_m, tags.height));
  let crownDiameter = parseLength(firstValue(
    tags.crown_diameter_m, tags.diameter_crown, tags["diameter:crown"], tags.crown_diameter
  ));
  let crownSource = crownDiameter === null ? null : "tagged-crown-diameter";
  if (crownDiameter === null && modelClass === "tree" && ["Polygon", "MultiPolygon"].includes(geometry)) {
    const areaM2 = geometryPolygonArea(feature.localGeometry);
    if (areaM2 > 0) {
      crownDiameter = round1(2 * Math.sqrt(areaM2 / Math.PI));
      crownSource = "mapped-canopy-equivalent-diameter";
    }
  }
  let heightM = taggedHeight;
  let heightSource = taggedHeight === null ? null : "tagged-tree-height";
  let confidence = taggedHeight === null ? 0 : 0.88;
  if (heightM === null && point && typeof sources.elevation?.samplePairLocal === "function") {
    const pair = sources.elevation.samplePairLocal(point[0], point[1]);
    const measured = Number.isFinite(pair?.surface) && Number.isFinite(pair?.terrain) ? pair.surface - pair.terrain : null;
    if (Number.isFinite(measured) && measured >= 2 && measured <= 60) {
      heightM = round1(measured);
      heightSource = "dsm-minus-dtm-at-mapped-tree";
      confidence = 0.72;
    }
  }

  const reconstruction = point && modelClass === "tree"
    ? deriveTreeCrownReconstruction({ point, crownDiameter, heightM, elevation: sources.elevation, options })
    : null;
  if (crownDiameter === null && reconstruction) {
    crownDiameter = round1(Math.max(
      reconstruction.westM + reconstruction.eastM,
      reconstruction.northM + reconstruction.southM
    ));
    crownSource = "dsm-dtm-connected-canopy";
  }

  const taggedSpacing = parseLength(firstValue(tags.tree_spacing_m, tags.spacing, tags["tree:spacing"]));
  const treeCount = integerOrNull(firstValue(tags.tree_count, tags.count, tags.trees))
    ?? (modelClass === "tree" ? 1 : null);
  const taggedDensityPer100M2 = densityPer100M2(tags);
  const densityPer100M2Value = Number.isFinite(taggedDensityPer100M2)
    ? taggedDensityPer100M2
    : defaultVegetationDensity(modelClass, options);
  const spacingM = taggedSpacing || defaultVegetationSpacing(modelClass, options);
  const polygonCover = ["Polygon", "MultiPolygon"].includes(geometry);
  const lineCover = ["LineString", "MultiLineString"].includes(geometry);
  const positionStatus = point ? "mapped-position"
    : lineCover ? "density-derived-along-mapped-line"
      : polygonCover ? "density-derived-inside-mapped-cover" : "unrepresented";
  const inferredAllowed = (options.accuracyMode || "verified") === "plausible";

  return {
    geometry,
    modelClass,
    subtype: feature.subtype || null,
    heightM,
    heightSource,
    crownDiameterM: crownDiameter,
    crownSource,
    reconstruction,
    crownShapeSource: reconstruction?.source || null,
    crownShapeSampleCount: reconstruction?.sampleCount || 0,
    crownBaseHeightM: reconstruction?.crownBaseHeightM ?? null,
    spacingM,
    spacingSource: taggedSpacing ? "tagged-spacing" : `default-${modelClass}-spacing`,
    densityPer100M2: densityPer100M2Value,
    densitySource: Number.isFinite(taggedDensityPer100M2) ? "tagged-density" : `default-${modelClass}-density`,
    treeCount,
    leafType: firstValue(tags.leaf_type, tags["leaf:type"]) || null,
    leafCycle: firstValue(tags.leaf_cycle, tags["leaf:cycle"]) || null,
    species: firstValue(tags.species, tags.genus, tags.taxonomy) || null,
    positionStatus,
    modelStatus: heightM !== null ? "height-evidenced"
      : point && !inferredAllowed ? "position-only-marker"
        : "mapped-cover-density-model",
    confidence: round3(Math.max(confidence, polygonCover || lineCover ? 0.66 : 0.45)),
    source: heightSource ? evidenceSource(feature, heightSource)
      : evidenceSource(feature, polygonCover || lineCover ? "mapped vegetation extent" : "mapped vegetation position")
  };
}

function deriveTreeCrownReconstruction({ point, crownDiameter, heightM, elevation, options }) {
  if (typeof elevation?.samplePairLocal !== "function") return null;
  const resolutionM = Math.max(0.25, Math.min(2, Number(elevation.resolutionM) || 1));
  const sampleStepM = Math.max(0.5, Number(options.treeCrownSampleStepM ?? Math.min(1, resolutionM)));
  const observedRadius = Number.isFinite(crownDiameter) ? crownDiameter / 2 : null;
  const heightRadius = Number.isFinite(heightM) ? Math.max(4, Math.min(14, heightM * 0.55)) : 7;
  const searchRadiusM = Math.max(3, Math.min(20, Number(
    options.treeCrownSearchRadiusM ?? (observedRadius ? observedRadius + Math.max(2, sampleStepM * 2) : heightRadius)
  )));
  const samples = [];
  for (let dz = -searchRadiusM; dz <= searchRadiusM + 1e-9; dz += sampleStepM) {
    for (let dx = -searchRadiusM; dx <= searchRadiusM + 1e-9; dx += sampleStepM) {
      if (dx * dx + dz * dz > searchRadiusM * searchRadiusM) continue;
      const x = point[0] + dx, z = point[1] + dz;
      const pair = elevation.samplePairLocal(x, z);
      if (!Number.isFinite(pair?.surface) || !Number.isFinite(pair?.terrain)) continue;
      samples.push({ x, z, surfaceM: pair.surface, groundM: pair.terrain });
    }
  }
  const reconstruction = reconstructTreeCrownFromSamples({
    x: point[0], z: point[1], samples, cellSizeM: sampleStepM,
    minCanopyHeightM: Math.max(1.5, Number(options.treeMinCanopyHeightM ?? 2)),
    maxSeedDistanceM: Math.max(2, Number(options.treeCrownSeedDistanceM ?? 3))
  });
  if (!reconstruction) return null;

  // A tagged/mapped crown diameter is higher-authority horizontal evidence than
  // a DSM segmentation edge. Preserve its outer diameter while retaining the
  // LiDAR-derived asymmetry and centre offset as a normalized directional shape.
  if (Number.isFinite(crownDiameter) && crownDiameter > 0) {
    const measuredDiameter = Math.max(
      reconstruction.westM + reconstruction.eastM,
      reconstruction.northM + reconstruction.southM
    );
    if (measuredDiameter > crownDiameter && measuredDiameter > 0) {
      const scale = crownDiameter / measuredDiameter;
      for (const key of ["westM", "eastM", "northM", "southM", "radiusXM", "radiusZM", "offsetXM", "offsetZM"]) {
        if (Number.isFinite(reconstruction[key])) reconstruction[key] = round3(reconstruction[key] * scale);
      }
      reconstruction.horizontalEnvelopeClampedToMappedCrown = true;
    }
  }
  return reconstruction;
}

function vegetationModelClass(feature) {
  const tags = feature.tags || {};
  const subtype = String(feature.subtype || tags.natural || tags.landuse || tags.landcover || tags.barrier || "")
    .toLowerCase().replace(/[ -]+/g, "_");
  if ([
    "tree", "lone_tree_canopy", "lone_tree", "tree_canopy",
    "protected_or_recorded_tree", "recorded_tree", "individual_tree", "surveyed_tree"
  ].includes(subtype)) return "tree";
  if (subtype === "tree_row") return "tree-row";
  if (subtype === "hedge" || tags.barrier === "hedge") return "hedge";
  if (["scrub", "shrub", "shrubs", "bush", "bushes"].includes(subtype)) return "shrubland";
  if (["orchard", "vineyard", "plant_nursery"].includes(subtype)) return "orchard";
  if (["wood", "forest", "trees", "tree_cover"].includes(subtype)) return "woodland";
  return ["Polygon", "MultiPolygon"].includes(feature.localGeometry?.type) ? "woodland" : "tree-row";
}

function geometryPolygonArea(geometry) {
  if (!geometry) return 0;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates || [];
  let total = 0;
  for (const polygon of polygons) {
    if (!polygon?.length) continue;
    total += Math.abs(polygonArea(polygon[0]));
    for (const hole of polygon.slice(1)) total -= Math.abs(polygonArea(hole));
  }
  return Math.max(0, total);
}

function densityPer100M2(tags) {
  const directRaw = firstValue(tags.trees_per_100m2, tags.tree_density_per_100m2);
  if (directRaw !== null) {
    const direct = Number(directRaw);
    if (Number.isFinite(direct) && direct >= 0) return direct;
  }
  const hectareRaw = firstValue(tags.trees_per_hectare, tags.tree_density_per_hectare);
  if (hectareRaw !== null) {
    const perHectare = Number(hectareRaw);
    if (Number.isFinite(perHectare) && perHectare >= 0) return perHectare / 100;
  }
  return null;
}

function defaultVegetationDensity(modelClass, options) {
  if (modelClass === "shrubland") return Math.max(0, Number(options.shrubDensityPer100m2 ?? 12));
  if (modelClass === "orchard") return Math.max(0, Number(options.treeDensityPer100m2 ?? 2.2) * 0.65);
  if (modelClass === "woodland") return Math.max(0, Number(options.treeDensityPer100m2 ?? 2.2));
  return 0;
}

function defaultVegetationSpacing(modelClass, options) {
  if (modelClass === "hedge") return 1;
  if (modelClass === "tree-row") return Math.max(2, Number(options.treeLineSpacingM ?? 4));
  if (modelClass === "orchard") return Math.max(3, Number(options.vegetationMinSpacingM ?? 5));
  if (modelClass === "woodland") return Math.max(3, Number(options.vegetationMinSpacingM ?? 4));
  if (modelClass === "shrubland") return Math.max(1.5, Number(options.vegetationMinSpacingM ?? 4) * 0.5);
  return null;
}

function summarizePathNetwork(features, recoveredTopology = null, sourceRepair = null) {
  const topologyFeatures = features.filter((feature) => feature.tags?.["orthophoto:discovered"] !== "yes");
  const guest = topologyFeatures.filter((feature) => feature.fidelity?.path?.role !== "service");
  const graph = buildFeatureConnectivity(guest);
  const totalLengthM = topologyFeatures.reduce((sum, feature) => sum + geometryLength(feature.localGeometry), 0);
  const guestLengthM = guest.reduce((sum, feature) => sum + geometryLength(feature.localGeometry), 0);
  return {
    featureCount: features.length,
    guestFeatureCount: guest.length,
    serviceFeatureCount: topologyFeatures.length - guest.length,
    queueFeatureCount: features.filter((feature) => feature.fidelity?.path?.role === "queue").length,
    totalLengthM: round1(totalLengthM),
    guestLengthM: round1(guestLengthM),
    components: graph.components,
    isolatedFeatures: graph.isolatedFeatures,
    nodes: graph.nodes,
    edges: graph.edges,
    danglingEndpoints: graph.danglingEndpoints,
    sourceRepair: sourceRepair ? {
      status: sourceRepair.status,
      mode: sourceRepair.mode,
      candidateConnectors: sourceRepair.candidateConnectors || 0,
      compiledConnectors: sourceRepair.compiledConnectors || 0,
      repairedLengthM: sourceRepair.repairedLengthM || 0,
      componentReduction: sourceRepair.componentReduction || 0,
      danglingEndpointReduction: sourceRepair.danglingEndpointReduction || 0
    } : null,
    recoveredTopology: recoveredTopology ? {
      status: recoveredTopology.status,
      acceptedGraphEdges: recoveredTopology.acceptedGraphEdges || 0,
      recoveredLengthM: recoveredTopology.recoveredLengthM || 0,
      recoveredAreaM2: recoveredTopology.recoveredAreaM2 || 0,
      connectorEdges: recoveredTopology.connectorEdges || 0,
      extensionEdges: recoveredTopology.extensionEdges || 0,
      junctionNodes: recoveredTopology.junctionNodes || 0
    } : null,
    completenessClaim: "Topology is complete only relative to fused source lines; unseen or unmapped paths remain an explicit source gap."
  };
}

function summarizeSurfaceEvidence(features, options = {}) {
  const linearFeatures = features.filter((feature) => ["LineString", "MultiLineString"].includes(feature.localGeometry?.type));
  const lengths = linearFeatures.map((feature) => ({ feature, length: geometryLength(feature.localGeometry) }));
  const total = lengths.reduce((sum, item) => sum + item.length, 0);
  const covered = (selector) => lengths.reduce((sum, item) => sum + (selector(item.feature) ? item.length : 0), 0);
  const widthEvidenceStatuses = new Set(["observed-width", "variable-width-tagged", "orthophoto-edge-observed", "tag-estimate", "lanes-derived"]);
  const statusLengths = {};
  for (const item of lengths) {
    const status = item.feature.fidelity?.path?.widthStatus || "unknown-marker";
    statusLengths[status] = (statusLengths[status] || 0) + item.length;
  }
  const compiledWidthMetres = lengths.reduce((sum, item) => {
    const widthM = item.feature.fidelity?.path?.rasterWidthM;
    return sum + (Number.isFinite(widthM) ? widthM * item.length : 0);
  }, 0);
  return {
    widthMode: options.pathWidthMode || "inferred",
    pathAndRoadFeatures: features.length,
    linearFeatures: linearFeatures.length,
    areaFootprintFeatures: features.length - linearFeatures.length,
    lengthM: round1(total),
    widthCoverage: ratio(covered((feature) => widthEvidenceStatuses.has(feature.fidelity?.path?.widthStatus)), total),
    observedWidthCoverage: ratio(covered((feature) => feature.fidelity?.path?.widthStatus === "observed-width"), total),
    orthophotoWidthCoverage: ratio(covered((feature) => feature.fidelity?.path?.widthStatus === "orthophoto-edge-observed"), total),
    inferredWidthCoverage: ratio(covered((feature) => feature.fidelity?.path?.widthStatus === "class-prior"), total),
    compiledWidthCoverage: ratio(covered((feature) => Number.isFinite(feature.fidelity?.path?.rasterWidthM)), total),
    meanCompiledRasterWidthM: total ? round2(compiledWidthMetres / total) : null,
    widthStatusFeatures: countBy(linearFeatures, (feature) => feature.fidelity?.path?.widthStatus || "unknown-marker"),
    widthStatusLengthM: Object.fromEntries(Object.entries(statusLengths).map(([status, length]) => [status, round1(length)])),
    materialCoverage: ratio(covered((feature) => Boolean(
      feature.surfaceStyle?.material || feature.surfaceStyle?.materialPreset
    )), total),
    colourCoverage: ratio(covered((feature) => Boolean(feature.surfaceStyle?.colour)), total),
    explicitPatternCoverage: ratio(covered((feature) => Boolean(feature.surfaceStyle?.patternSource)), total),
    explicitEdgeCoverage: ratio(covered((feature) => Boolean(feature.fidelity?.path?.edgeStyle?.enabled)), total),
    repairedConnectorFeatures: features.filter((feature) => feature.pathGeometry?.status === "compiled-repair").length,
    orthophotoMaterialCoverage: ratio(covered((feature) => feature.surfaceStyle?.materialSource?.sourceKind === "orthophoto"), total),
    orthophotoColourCoverage: ratio(covered((feature) => feature.surfaceStyle?.colourSource?.sourceKind === "orthophoto"), total),
    orthophotoPatternCoverage: ratio(covered((feature) => feature.surfaceStyle?.patternSource?.sourceKind === "orthophoto"), total),
    unknownAppearanceFeatures: features.filter((feature) => feature.surfaceStyle?.appearanceStatus === "unknown-visible-fallback").length,
    note: "Explicit measurements take precedence, followed by accepted orthophoto edges, tag estimates, lane derivation, and finally disclosed class priors. Colour/material/pattern promotion remains confidence-gated."
  };
}

function summarizeTreeEvidence(features) {
  const entries = features.map((feature) => feature.fidelity?.tree).filter(Boolean);
  return {
    mappedFeatures: entries.length,
    pointTrees: entries.filter((entry) => entry.geometry === "Point").length,
    treeRows: entries.filter((entry) => entry.modelClass === "tree-row").length,
    woodlandPolygons: entries.filter((entry) => entry.modelClass === "woodland").length,
    shrubPolygons: entries.filter((entry) => entry.modelClass === "shrubland").length,
    hedgeFeatures: entries.filter((entry) => entry.modelClass === "hedge").length,
    orchardFeatures: entries.filter((entry) => entry.modelClass === "orchard").length,
    densityDerivedFeatures: entries.filter((entry) => String(entry.positionStatus || "").startsWith("density-derived")).length,
    heightEvidenced: entries.filter((entry) => entry.heightM !== null).length,
    crownEvidenced: entries.filter((entry) => entry.crownDiameterM !== null).length,
    speciesEvidenced: entries.filter((entry) => entry.species).length,
    positionOnly: entries.filter((entry) => entry.modelStatus === "position-only-marker").length
  };
}

function summarizeBridgeEvidence(features) {
  const entries = features.map((feature) => feature.fidelity?.bridge).filter(Boolean);
  return {
    mappedFeatures: entries.length,
    verticalEvidenced: entries.filter((entry) => entry.deckElevationM !== null).length,
    explicitClearance: entries.filter((entry) => entry.explicitClearanceM !== null).length,
    planOnly: entries.filter((entry) => entry.verticalStatus === "height-unknown-plan-only").length,
    structures: countBy(entries, (entry) => entry.structure)
  };
}

function buildSourceCapabilities({
  sources, pathNetwork, surfaces, trees, bridges, orthophoto, pathGeometry, pathTopology, terrainDetails
}) {
  const capability = (status, coverage, source, limitation) => ({ status, coverage, source, limitation });
  return {
    pathGeometry: capability(pathNetwork.featureCount ? "available" : "missing", pathNetwork.featureCount ? 1 : 0,
      pathTopology?.acceptedGraphEdges
        ? "OSM/Overpass, source-relative endpoint repair, Overture gap fill, public GeoJSON, and licensed orthophoto topology recovery"
        : pathGeometry?.compiledConnectors
          ? "OSM/Overpass plus disclosed source-relative endpoint repair"
          : sources.mapFusion?.acceptedFeatures
          ? "OSM/Overpass plus provenance-gated Overture/public GeoJSON fusion"
          : "OSM/Overpass plus portable GeoJSON overrides",
      "Source-relative topology remains incomplete where routes are obscured, isolated, private, or absent from every active source."),
    mappedPathRepair: capability(pathGeometry?.compiledConnectors ? "available" : pathGeometry?.status || "missing",
      pathGeometry?.compiledConnectors ? 1 : 0,
      "source-relative mapped endpoint repair",
      pathGeometry?.limitations?.join(" ") || "No conservative mapped gap repair was active."),
    pathTopologyRecovery: capability(pathTopology?.status === "available" ? "available" : pathTopology?.status || "missing",
      pathTopology?.acceptedGraphEdges ? 1 : 0,
      pathTopology?.source?.provider || "none",
      pathTopology?.limitations?.join(" ") || "No evidence-gated walkable-surface recovery was active."),
    pathWidth: capability(surfaces.widthCoverage === 1 ? "available" : surfaces.widthCoverage ? "partial" : "missing",
      surfaces.widthCoverage, "width observations, accepted orthophoto edges, tag estimates, and lane derivation",
      `Observed/derived evidence covers ${(surfaces.widthCoverage * 100).toFixed(1)}%; ${(surfaces.orthophotoWidthCoverage * 100).toFixed(1)}% is orthophoto-measured and compiled coverage is ${(surfaces.compiledWidthCoverage * 100).toFixed(1)}%.`),
    pathMaterial: capability(surfaces.materialCoverage === 1 ? "available" : surfaces.materialCoverage ? "partial" : "missing",
      surfaces.materialCoverage, "surface/material observations plus confidence-gated orthophoto spectral classes", "Unknown material remains visibly unknown when classification confidence is insufficient."),
    pathColour: capability(surfaces.colourCoverage === 1 ? "available" : surfaces.colourCoverage ? "partial" : "missing",
      surfaces.colourCoverage, "surface:colour, portable observations, or shadow-rejected orthophoto samples", "Sub-metre orthophotos are needed where tags are absent."),
    pathPattern: capability(surfaces.explicitPatternCoverage === 1 ? "available" : surfaces.explicitPatternCoverage ? "partial" : "missing",
      surfaces.explicitPatternCoverage, "surface pattern observations plus confidence-gated orthophoto texture classes", "Block texture is not claimed as the real laying pattern without evidence."),
    naturalPathSurfaces: capability(terrainDetails?.dirtPaths?.features ? "available" : "missing",
      terrainDetails?.dirtPaths?.features ? 1 : 0,
      "surface/material tags, portable observations, and route-seeded orthophoto material candidates",
      terrainDetails?.limitations?.[0] || "No dirt/ground path observations were active."),
    terrainDetails: capability(terrainDetails?.status === "available" ? "partial" : terrainDetails?.status || "missing",
      terrainDetails?.rocks?.pointFeatures || terrainDetails?.rocks?.surfaceFeatures ? 1 : 0,
      "OSM, Overture/public GeoJSON, mapped rock/stone/cliff features, and bare-rock/scree/quarry polygons",
      terrainDetails?.limitations?.slice(1, 3).join(" ") || "No mapped rock-detail evidence was active."),
    orthophoto: capability(orthophoto?.status === "available" ? "available" : orthophoto?.status || "missing",
      orthophoto?.measuredRouteCoverage || 0,
      orthophoto?.source?.provider || "none",
      orthophoto?.limitations?.join(" ") || sources.orthophoto?.warning || "No rights-cleared high-resolution image source was active."),
    individualTrees: capability(trees.mappedFeatures ? "partial" : "missing", trees.mappedFeatures ? ratio(trees.heightEvidenced, trees.mappedFeatures) : 0,
      "mapped tree points, rows, woodland/scrub/orchard polygons, hedges, aerial canopy classes, and optional DSM observations",
      "Exact tree positions are preserved where mapped; mapped cover polygons use deterministic density-derived positions and report them separately."),
    bridgeVertical: capability(!bridges.mappedFeatures ? "not-applicable" : bridges.planOnly ? "partial" : "available",
      bridges.mappedFeatures ? ratio(bridges.verticalEvidenced, bridges.mappedFeatures) : 1,
      "bridge tags plus optional DSM/DTM or portable survey observations", "OSM layer is relative topology, not metres."),
    terrain: capability(sources.elevation?.provider === "none" ? "missing" : "available",
      sources.elevation?.provider === "none" ? 0 : 1, sources.elevation?.provider || "none",
      sources.elevation?.warning || null)
  };
}

function buildFeatureConnectivity(features) {
  if (!features.length) return { components: 0, isolatedFeatures: 0, nodes: 0, edges: 0, danglingEndpoints: 0 };
  const parent = features.map((_, index) => index);
  const rank = features.map(() => 0);
  const buckets = new Map();
  const degrees = new Map();
  let edges = 0;
  const find = (value) => parent[value] === value ? value : (parent[value] = find(parent[value]));
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) [a, b] = [b, a];
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a] += 1;
  };
  features.forEach((feature, featureIndex) => {
    for (const line of geometryLines(feature.localGeometry)) {
      for (let index = 0; index < line.length; index += 1) {
        const key = nodeKey(line[index]);
        if (!buckets.has(key)) buckets.set(key, []);
        for (const other of buckets.get(key)) union(featureIndex, other);
        buckets.get(key).push(featureIndex);
        if (index) {
          const previous = nodeKey(line[index - 1]);
          degrees.set(previous, (degrees.get(previous) || 0) + 1);
          degrees.set(key, (degrees.get(key) || 0) + 1);
          edges += 1;
        }
      }
    }
  });
  const groups = new Map();
  features.forEach((_, index) => groups.set(find(index), (groups.get(find(index)) || 0) + 1));
  return {
    components: groups.size,
    isolatedFeatures: [...groups.values()].filter((count) => count === 1).length,
    nodes: degrees.size,
    edges,
    danglingEndpoints: [...degrees.values()].filter((degree) => degree === 1).length
  };
}

function chooseSurfaceBlocks(material, colour) {
  if (colour) {
    const ranked = BLOCK_COLOURS
      .map((entry) => ({
        ...entry,
        distance: colourDistance(colour.rgb, entry.rgb),
        materialPenalty: material && !entry.materials.includes(material) ? 24 : 0,
        texturePenalty: material ? texturePenaltyForMaterial(material, entry.texture) : 0
      }))
      .sort((a, b) => (a.distance + a.materialPenalty + a.texturePenalty) -
        (b.distance + b.materialPenalty + b.texturePenalty));
    const selected = [];
    for (const candidate of ranked) {
      if (selected.some((entry) => entry.block === candidate.block)) continue;
      selected.push(candidate);
      if (selected.length === 3) break;
    }
    return selected.map((entry) => entry.block);
  }
  return material ? DEFAULT_MATERIAL_BLOCKS[material] || null : null;
}

function parseColour(value) {
  if (value === null || value === undefined || value === "") return null;
  let text = String(value).trim().toLowerCase().replace(/[_-]+/g, " ");
  text = NAMED_COLOURS[text] || text;
  const short = text.match(/^#?([0-9a-f]{3})$/i);
  if (short) text = `#${[...short[1]].map((digit) => digit.repeat(2)).join("")}`;
  const match = text.match(/^#?([0-9a-f]{6})$/i);
  if (!match) {
    const rgb = text.match(/^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
    if (!rgb) return null;
    const values = rgb.slice(1).map(Number);
    if (values.some((part) => part > 255)) return null;
    return { rgb: values, hex: `#${values.map((part) => part.toString(16).padStart(2, "0")).join("")}` };
  }
  const hex = `#${match[1].toLowerCase()}`;
  return { hex, rgb: [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) };
}

function normalizeMaterial(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase().replace(/[ -]+/g, "_");
  return MATERIAL_ALIASES[key] || null;
}

function normalizePattern(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase().replace(/[ -]+/g, "_");
  if (["herringbone", "basketweave", "running_bond", "stack_bond", "checker", "grid", "stripes", "random", "mixed", "solid", "slabs", "mosaic", "speckled", "organic"].includes(key)) {
    if (key === "basketweave" || key === "stack_bond") return "grid";
    if (key === "random") return "mixed";
    return key;
  }
  return null;
}

function defaultPattern(material) {
  if (material === "paving_stones") return "slabs";
  if (material === "brick") return "running_bond";
  if (["sett", "cobblestone"].includes(material)) return "mosaic";
  if (["gravel", "fine_gravel", "compacted"].includes(material)) return "speckled";
  if (["earth", "dirt", "grass"].includes(material)) return "organic";
  if (["wood", "boardwalk"].includes(material)) return "stripes";
  return "solid";
}

function defaultPatternScale(material) {
  if (["brick", "sett", "cobblestone"].includes(material)) return 1;
  if (material === "paving_stones") return 2;
  if (["wood", "boardwalk"].includes(material)) return 1;
  if (["gravel", "fine_gravel", "earth", "dirt", "grass"].includes(material)) return 2;
  return 1;
}

function normalizePatternRotation(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(String(value).match(/-?\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(number)) return 0;
  const normalized = ((Math.round(number / 90) * 90) % 360 + 360) % 360;
  return normalized;
}

function normalizeMinecraftShape(value) {
  const shape = String(value || "").trim().toLowerCase().replace(/[ _]+/g, "-");
  return ["slab", "stairs", "wall", "fence", "trapdoor"].includes(shape) ? shape : null;
}

function normalizeMinecraftDirection(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const named = { south: 0, west: 1, north: 2, east: 3 };
  if (Object.hasOwn(named, text)) return named[text];
  const number = Number(text);
  return Number.isInteger(number) && number >= 0 && number <= 3 ? number : 0;
}

function applyExplicitMinecraftShape(block, style) {
  const shape = style?.minecraftShape;
  if (!shape || !block) return block;
  const direction = normalizeMinecraftDirection(style.minecraftDirection);
  const material = String(block).toLowerCase();
  const family = material.includes("sandstone") ? "sandstone"
    : material.includes("brick") || material.includes("red_terracotta") ? "brick"
      : material.includes("spruce") ? "spruce"
        : material.includes("dark_oak") ? "dark_oak"
          : material.includes("birch") ? "birch"
            : material.includes("oak") || material.includes("plank") ? "oak"
              : "stone_brick";
  if (shape === "slab") {
    return `minecraft:${family}_slab[minecraft:vertical_half=bottom]`;
  }
  if (shape === "stairs") {
    return `minecraft:${family}_stairs[upside_down_bit=false,weirdo_direction=${direction}]`;
  }
  if (shape === "wall") {
    const wallFamily = ["sandstone", "brick", "stone_brick"].includes(family) ? family : "cobblestone";
    return `minecraft:${wallFamily}_wall`;
  }
  if (shape === "fence") {
    const wood = ["spruce", "dark_oak", "birch", "oak"].includes(family) ? family : "oak";
    return `minecraft:${wood}_fence`;
  }
  const wood = ["spruce", "dark_oak", "birch", "oak"].includes(family) ? family : "oak";
  return `minecraft:${wood}_trapdoor[direction=${direction},open_bit=false,upside_down_bit=false]`;
}

function paletteWeightsFor(material, pattern) {
  if (pattern === "solid") return [1, 0, 0];
  if (["mixed", "speckled", "organic", "mosaic"].includes(pattern)) {
    if (["earth", "dirt", "grass"].includes(material)) return [0.66, 0.24, 0.1];
    return [0.7, 0.22, 0.08];
  }
  return [0.78, 0.17, 0.05];
}

function normalizeWeights(weights) {
  const values = [0, 1, 2].map((index) => Math.max(0, Number(weights?.[index] || 0)));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  return values.map((value) => value / total);
}

function texturePenaltyForMaterial(material, texture) {
  const expected = {
    asphalt: ["smooth", "granular"], concrete: ["smooth", "masonry"],
    paving_stones: ["masonry", "stone"], brick: ["masonry"], sett: ["cobbled", "stone"],
    cobblestone: ["cobbled", "stone"], gravel: ["granular", "stone"], fine_gravel: ["granular"],
    compacted: ["granular", "earth"], wood: ["planks"], boardwalk: ["planks"],
    earth: ["earth", "organic"], dirt: ["earth"], sand: ["granular", "smooth"],
    grass: ["organic"], rubber: ["smooth"], stone: ["stone", "masonry"]
  }[material] || [];
  return expected.includes(texture) ? 0 : 8;
}

function rotateGrid(x, z, rotation) {
  if (rotation === 90) return [-z, x];
  if (rotation === 180) return [-x, -z];
  if (rotation === 270) return [z, -x];
  return [x, z];
}

export function classifyPathRole(tags = {}, featureKind = null) {
  const highway = String(tags.highway || tags["area:highway"] || "").toLowerCase();
  const access = String(tags.access || "").toLowerCase();
  const service = String(tags.service || "").toLowerCase();
  const name = String(tags.name || "").toLowerCase();
  const queueEvidence = truthyTag(tags.queue) || tags.footway === "queue" || highway === "queue" ||
    tags.attraction === "queue" || tags.amenity === "queue" || truthyTag(tags["queue:line"]) ||
    (access === "customers" && /queue|entrance line/.test(name));
  if (queueEvidence) return "queue";
  const restricted = ["private", "no", "permit", "delivery", "agricultural", "forestry"].includes(access) ||
    ["private", "no"].includes(String(tags.foot || "").toLowerCase()) ||
    ["private", "no"].includes(String(tags.motor_vehicle || "").toLowerCase());
  const serviceRoad = highway === "service" || highway === "track" || Boolean(service) ||
    truthyTag(tags.backstage) || truthyTag(tags.staff) || truthyTag(tags["staff_only"]);
  if (restricted || serviceRoad) return "service";
  if (featureKind === "road" && !["pedestrian", "living_street"].includes(highway)) return "service";
  return "guest";
}

function normalizeBridgeStructure(value) {
  const key = String(value || "unknown").toLowerCase();
  if (key.includes("boardwalk")) return "boardwalk";
  if (key.includes("covered")) return "covered";
  if (key.includes("suspension")) return "suspension";
  if (key.includes("arch")) return "arch";
  if (key.includes("viaduct")) return "viaduct";
  if (key.includes("movable")) return "movable";
  if (key === "yes" || key === "bridge") return "generic-deck";
  return key || "unknown";
}

function evidenceSource(feature, method) {
  return {
    method,
    provider: feature.source?.provider || null,
    featureId: feature.id,
    timestamp: feature.source?.timestamp || null,
    license: feature.source?.license || null,
    sourceUrl: feature.source?.sourceUrl || null,
    file: feature.source?.file || null
  };
}

function orthophotoSource(observation, method) {
  const source = observation?.source || {};
  return {
    method,
    sourceKind: "orthophoto",
    provider: source.provider || null,
    featureId: observation?.featureId || null,
    timestamp: source.capturedAt || null,
    license: source.license || null,
    sourceUrl: source.sourceUrl || null,
    rasterHashes: source.rasterHashes || [],
    gsdM: source.gsdM ?? null,
    confidence: observation?.confidence ?? null
  };
}

function sampleGeometry(geometry, spacingM) {
  const result = [];
  for (const line of geometryLines(geometry)) {
    if (!line.length) continue;
    result.push(line[0]);
    for (let index = 1; index < line.length; index += 1) {
      const from = line[index - 1], to = line[index];
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const steps = Math.max(1, Math.ceil(length / spacingM));
      for (let step = 1; step <= steps; step += 1) {
        const fraction = step / steps;
        result.push([from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction]);
      }
    }
  }
  return result;
}

function geometryLength(geometry) {
  let total = 0;
  for (const line of geometryLines(geometry)) {
    for (let index = 1; index < line.length; index += 1) {
      total += Math.hypot(line[index][0] - line[index - 1][0], line[index][1] - line[index - 1][1]);
    }
  }
  return total;
}

function geometryLines(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

function geometryPoint(geometry) {
  return geometry?.type === "Point" ? geometry.coordinates : null;
}

function nodeKey([x, z]) {
  return `${Math.round(x * 2) / 2},${Math.round(z * 2) / 2}`;
}

function colourDistance(first, second) {
  const a = rgbToLab(first), b = rgbToLab(second);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function rgbToLab(rgb) {
  const linear = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const x = (linear[0] * 0.4124 + linear[1] * 0.3576 + linear[2] * 0.1805) / 0.95047;
  const y = (linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722);
  const z = (linear[0] * 0.0193 + linear[1] * 0.1192 + linear[2] * 0.9505) / 1.08883;
  const f = (value) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function blockRgb(block) {
  return BLOCK_COLOURS.find((entry) => entry.block === block)?.rgb || [128, 128, 128];
}

function countBy(values, selector) {
  const result = {};
  for (const value of values) {
    const key = selector(value) || "unknown";
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

function parseLength(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = String(value).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
}

function numericOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function truthyTag(value) {
  return ["yes", "true", "1", "designated"].includes(String(value || "").toLowerCase());
}

function hash2d(x, z, seed) {
  let value = (Math.imul(Math.round(x), 374761393) ^ Math.imul(Math.round(z), 668265263) ^ Math.imul(seed | 0, 1442695041)) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function ratio(numerator, denominator) {
  return denominator ? round3(numerator / denominator) : 0;
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function rasterWidth(widthM) {
  return Math.max(1, Math.min(40, Math.round(widthM)));
}

const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
