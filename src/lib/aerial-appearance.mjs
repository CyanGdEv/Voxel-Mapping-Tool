const TERRAIN_STYLES = Object.freeze({
  "dense-tree-canopy": {
    material: "woodland_floor",
    primaryBlock: "minecraft:moss_block",
    secondaryBlock: "minecraft:podzol",
    tertiaryBlock: "minecraft:grass_block",
    pattern: "organic",
    paletteWeights: [0.54, 0.28, 0.18]
  },
  vegetation: {
    material: "vegetation",
    primaryBlock: "minecraft:grass_block",
    secondaryBlock: "minecraft:moss_block",
    tertiaryBlock: "minecraft:podzol",
    pattern: "organic",
    paletteWeights: [0.68, 0.24, 0.08]
  },
  grass: {
    material: "grass",
    primaryBlock: "minecraft:grass_block",
    secondaryBlock: "minecraft:moss_block",
    tertiaryBlock: "minecraft:coarse_dirt",
    pattern: "organic",
    paletteWeights: [0.78, 0.16, 0.06]
  },
  "dry-grass": {
    material: "dry_grass",
    primaryBlock: "minecraft:grass_block",
    secondaryBlock: "minecraft:coarse_dirt",
    tertiaryBlock: "minecraft:dirt_with_roots",
    pattern: "organic",
    paletteWeights: [0.54, 0.3, 0.16]
  },
  "soil-mulch": {
    material: "earth",
    primaryBlock: "minecraft:podzol",
    secondaryBlock: "minecraft:coarse_dirt",
    tertiaryBlock: "minecraft:dirt_with_roots",
    pattern: "organic",
    paletteWeights: [0.46, 0.36, 0.18]
  },
  "rock-gravel": {
    material: "gravel",
    primaryBlock: "minecraft:gravel",
    secondaryBlock: "minecraft:andesite",
    tertiaryBlock: "minecraft:stone",
    pattern: "speckled",
    paletteWeights: [0.48, 0.32, 0.2]
  },
  sand: {
    material: "sand",
    primaryBlock: "minecraft:sand",
    secondaryBlock: "minecraft:smooth_sandstone",
    tertiaryBlock: "minecraft:sandstone",
    pattern: "speckled",
    paletteWeights: [0.72, 0.18, 0.1]
  }
});

/**
 * Samples a small metric patch around a local projected coordinate and returns
 * a conservative aerial appearance class. The classifier is intentionally
 * limited to classes that can safely texture natural ground or inform
 * vegetation density; roof/hardscape/water candidates stay review-only.
 */
export function sampleAerialClassification(sampleRgb, x, z, gsdM = 0.5) {
  if (typeof sampleRgb !== "function") return null;
  const radius = clamp(Math.max(0.5, Number(gsdM || 0.5) * 1.75), 0.5, 2);
  const offsets = [
    [0, 0], [-radius, 0], [radius, 0], [0, -radius], [0, radius],
    [-radius, -radius], [radius, -radius], [-radius, radius], [radius, radius]
  ];
  const samples = offsets.map(([dx, dz]) => sampleRgb(x + dx, z + dz)).filter(validRgb);
  return samples.length >= 3 ? classifyAerialPatch(samples) : null;
}

export function classifyAerialPatch(samples) {
  const valid = (samples || []).filter(validRgb);
  if (!valid.length) return null;
  const rgb = robustRgb(valid).map(Math.round);
  const texture = median(valid.map((sample) => deltaE76(sample, rgb)).sort((a, b) => a - b)) || 0;
  const luminance = relativeLuminance(rgb);
  const saturation = rgbSaturation(rgb);
  const [r, g, b] = rgb;
  const greenIndex = (g - (r + b) / 2) / 255;
  const blueIndex = (b - (r + g) / 2) / 255;
  const warmth = (r - b) / 255;
  const yellowGreen = (Math.min(r, g) - b) / 255;

  const finish = (className, confidence, extra = {}) => ({
    class: className,
    confidence: round3(clamp(confidence, 0, 0.99)),
    rgb,
    hex: rgbToHex(rgb),
    textureDeltaE76: round1(texture),
    luminance: round3(luminance),
    saturation: round3(saturation),
    greenIndex: round3(greenIndex),
    ...extra
  });

  if (luminance < 0.045) return finish("shadow", 0.88, { compilationEligible: false });
  if (blueIndex > 0.1 && b > 55 && luminance < 0.58) {
    return finish("water-candidate", 0.64 + blueIndex * 1.6, { compilationEligible: false });
  }
  if (greenIndex > 0.075 && g > 48) {
    const dense = texture >= 8 || luminance < 0.34 || saturation > 0.42;
    if (dense) {
      return finish("dense-tree-canopy", 0.72 + greenIndex * 1.45 + Math.min(0.12, texture / 120), {
        compilationEligible: true,
        vegetationDensity: "dense"
      });
    }
    return finish(luminance > 0.42 ? "grass" : "vegetation", 0.7 + greenIndex * 1.35, {
      compilationEligible: true,
      vegetationDensity: luminance > 0.42 ? "low" : "medium"
    });
  }
  const warmBrown = r > g * 1.06 && g > b * 1.04 && warmth > 0.08 && luminance >= 0.12 && luminance <= 0.62;
  if (warmBrown) {
    return finish("soil-mulch", 0.69 + Math.min(0.14, warmth * 0.7) + Math.min(0.08, texture / 160), {
      compilationEligible: true
    });
  }
  if (yellowGreen > 0.08 && warmth > 0.04 && luminance > 0.24 && g >= r * 0.84) {
    return finish("dry-grass", 0.67 + yellowGreen * 1.2, { compilationEligible: true });
  }
  if (saturation < 0.2 && texture >= 8 && luminance >= 0.16 && luminance <= 0.72) {
    return finish("rock-gravel", 0.66 + Math.min(0.16, texture / 100), { compilationEligible: true });
  }
  if (warmth > 0.03 && saturation < 0.28 && luminance > 0.62) {
    return finish("sand", 0.66 + Math.min(0.16, luminance * 0.16), { compilationEligible: true });
  }
  if (saturation < 0.2 && luminance > 0.08 && luminance < 0.84) {
    return finish("neutral-hardscape-candidate", 0.68 - saturation * 0.5, { compilationEligible: false });
  }
  return finish("unclassified", 0.35, { compilationEligible: false });
}

export function terrainStyleForAerialClass(classification) {
  const base = classification ? TERRAIN_STYLES[classification.class] : null;
  if (!base || classification.compilationEligible === false) return null;
  return {
    schemaVersion: 1,
    role: "aerial-terrain",
    aerialClass: classification.class,
    aerialConfidence: classification.confidence,
    colour: classification.hex || null,
    appearanceStatus: "orthophoto-observed-terrain",
    ...base
  };
}

/** Chooses a Bedrock leaf palette from observed canopy colour and source tags. */
export function vegetationPaletteForRgb(rgb, leafType = null, leafCycle = null) {
  const type = String(leafType || "").toLowerCase();
  const cycle = String(leafCycle || "").toLowerCase();
  if (type.includes("needle") || type.includes("conifer")) {
    return ["minecraft:spruce_leaves", "minecraft:dark_oak_leaves"];
  }
  if (!validRgb(rgb)) return cycle.includes("evergreen")
    ? ["minecraft:dark_oak_leaves", "minecraft:oak_leaves"]
    : ["minecraft:oak_leaves", "minecraft:birch_leaves"];
  const [r, g, b] = rgb;
  const luminance = relativeLuminance(rgb);
  const warmth = (r - b) / 255;
  if (luminance < 0.24 || g < 82) return ["minecraft:dark_oak_leaves", "minecraft:spruce_leaves"];
  if (g > 125 && warmth > 0.08) return ["minecraft:birch_leaves", "minecraft:azalea_leaves"];
  if (g > 118) return ["minecraft:oak_leaves", "minecraft:azalea_leaves"];
  return ["minecraft:oak_leaves", "minecraft:dark_oak_leaves"];
}

function validRgb(value) {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite);
}

function robustRgb(values) {
  return [0, 1, 2].map((band) => median(values.map((value) => value[band]).sort((a, b) => a - b)));
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

function rgbToHex(rgb) {
  return `#${rgb.map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

const round1 = (value) => Math.round(value * 10) / 10;
const round3 = (value) => Math.round(value * 1000) / 1000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
