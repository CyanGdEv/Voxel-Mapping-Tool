// TPMAP_PHASE30D_RASTER_PLANNING_GEOMETRY
// TPMAP_PHASE30D_CONTENT_ADDRESSED_RASTER_DERIVATIVES
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { classifyComprehensivePlanningLabel } from "./planning-comprehensive-semantics.mjs";
import { detectPlanningScales } from "./planning-auto-georeference.mjs";

const execFileAsync = promisify(execFile);
const MODULE = fileURLToPath(import.meta.url);
const SEMANTICS_MODULE = fileURLToPath(new URL("./planning-comprehensive-semantics.mjs", import.meta.url));
const TOOL = fileURLToPath(new URL("../tools/planning_raster_vectorize.py", import.meta.url));
const DERIVATIVE_SCHEMA = 1;
const DERIVATIVE_NAMESPACE = "tpmap-planning-raster-derivative-v1";
const MAX_COMPRESSED_ENTRY_BYTES = 32 * 1024 * 1024;
const sourceDigestCache = new Map();
let behaviorDigestPromise = null;

export async function extractRasterPlanningPage({ filename, page = 1, workDirectory, document = {} }) {
  await mkdir(workDirectory, { recursive: true });
  const key = safeKey(document.sha256 || document.cacheKey || document.id || "planning-raster");
  let cache = null;
  try { cache = await derivativeCacheContext(filename, page, document); } catch { cache = null; }
  if (cache) {
    const hit = await readCachedDerivative(cache);
    if (hit) {
      return {
        svg: hit.svg,
        semantic: hit.semantic,
        image: filename,
        derivativeCache: { status: "hit", key: cache.key }
      };
    }
  }

  const image = await rasterImage(filename, page, workDirectory, key, document.mime);
  const output = path.join(workDirectory, `${key}-p${page}-raster.svg`);
  const redOcr = path.join(workDirectory, `${key}-p${page}-red-ocr.png`);
  await rm(output, { force: true });
  await rm(redOcr, { force: true });
  await execFileAsync("python3", [TOOL, "--input", image, "--output", output, "--red-ocr-output", redOcr, "--max-shapes", "50000"], {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024
  });
  const svg = await readFile(output, "utf8");
  const [primaryText, redText] = await Promise.all([
    extractRasterTextObservations(image),
    extractRasterTextObservations(redOcr, { coordinateScale: 0.5, minimumConfidence: 20 })
  ]);
  const anchors = mergeOcrAnchors(primaryText.anchors, redText.anchors);
  const rawLines = mergeRawLines(primaryText.lines, redText.lines);
  const semantic = {
    anchors,
    rawLines,
    scaleCandidates: detectPlanningScales(rawLines.map((line) => line.text).join("\n")),
    source: "tesseract-tsv"
  };
  if (cache) await writeCachedDerivative(cache, { svg, semantic });
  return {
    svg,
    semantic,
    image,
    derivativeCache: { status: cache ? "miss-stored" : "disabled", key: cache?.key || null }
  };
}

async function derivativeCacheContext(filename, page, document) {
  const root = derivativeCacheRoot();
  if (!root) return null;
  const sourceSha256 = await sha256FileOnce(filename);
  const behaviorDigest = await planningRasterBehaviorDigest();
  const mime = String(document?.mime || "");
  const key = planningRasterDerivativeFingerprint({ sourceSha256, behaviorDigest, page, mime });
  return {
    root,
    key,
    sourceSha256,
    behaviorDigest,
    page: positiveInteger(page, 1),
    mime,
    filename: path.join(root, key.slice(0, 2), `${key}.json.gz`)
  };
}

function derivativeCacheRoot() {
  const explicit = String(process.env.TPMAP_PLANNING_DERIVATIVE_CACHE_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  const shared = String(process.env.TPMAP_SHARED_CACHE_DIR || "").trim();
  if (!shared) return null;
  // This is deterministic build infrastructure, not independent source evidence.
  // Keeping it under prepared-generator makes Phase 29H's existing evidence
  // fingerprint exclusion apply without weakening runtime-cache integrity sealing.
  return path.resolve(shared, "prepared-generator", "planning-raster-derivatives-v1");
}

export function planningRasterDerivativeFingerprint({ sourceSha256, behaviorDigest, page = 1, mime = "" }) {
  if (!/^[a-f0-9]{64}$/.test(String(sourceSha256 || ""))) throw new Error("planning raster cache requires an exact source SHA-256");
  if (!/^[a-f0-9]{64}$/.test(String(behaviorDigest || ""))) throw new Error("planning raster cache requires an exact behavior SHA-256");
  const hash = createHash("sha256");
  hash.update(DERIVATIVE_NAMESPACE); hash.update("\0");
  hash.update(String(sourceSha256)); hash.update("\0");
  hash.update(String(behaviorDigest)); hash.update("\0");
  hash.update(String(positiveInteger(page, 1))); hash.update("\0");
  hash.update(String(mime || "")); hash.update("\0");
  return hash.digest("hex");
}

async function planningRasterBehaviorDigest() {
  if (!behaviorDigestPromise) behaviorDigestPromise = computePlanningRasterBehaviorDigest();
  return behaviorDigestPromise;
}

async function computePlanningRasterBehaviorDigest() {
  const hash = createHash("sha256");
  hash.update("tpmap-planning-raster-behavior-v1\0");
  hash.update(`${process.platform}\0${process.arch}\0${process.version}\0`);
  for (const filename of [MODULE, SEMANTICS_MODULE, TOOL]) {
    const bytes = await readFile(filename);
    hash.update(path.basename(filename)); hash.update("\0");
    hash.update(bytes); hash.update("\0");
  }
  for (const [command, args] of [
    ["pdftocairo", ["-v"]],
    ["tesseract", ["--version"]],
    ["python3", ["-c", "import cv2,sys; print(sys.version.split()[0]); print(cv2.__version__)"]]
  ]) {
    hash.update(command); hash.update("\0");
    hash.update(await commandSignature(command, args)); hash.update("\0");
  }
  return hash.digest("hex");
}

async function commandSignature(command, args) {
  try {
    const result = await execFileAsync(command, args, { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
    return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  } catch (error) {
    return `unavailable:${error?.code || error?.message || "unknown"}`;
  }
}

async function readCachedDerivative(cache) {
  let compressed;
  try {
    compressed = await readFile(cache.filename);
    if (!compressed.length || compressed.length > MAX_COMPRESSED_ENTRY_BYTES) throw new Error("invalid compressed derivative size");
    const payload = JSON.parse(gunzipSync(compressed).toString("utf8"));
    if (payload?.schemaVersion !== DERIVATIVE_SCHEMA || payload?.namespace !== DERIVATIVE_NAMESPACE) throw new Error("schema mismatch");
    if (payload.key !== cache.key || payload.sourceSha256 !== cache.sourceSha256 || payload.behaviorDigest !== cache.behaviorDigest) throw new Error("cache identity mismatch");
    if (Number(payload.page) !== cache.page || String(payload.mime || "") !== cache.mime) throw new Error("cache input mismatch");
    if (typeof payload?.result?.svg !== "string" || !Array.isArray(payload?.result?.semantic?.anchors)) throw new Error("cache payload shape mismatch");
    if (sha256Text(payload.result.svg) !== payload.svgSha256) throw new Error("cached SVG hash mismatch");
    if (sha256Text(JSON.stringify(payload.result.semantic)) !== payload.semanticSha256) throw new Error("cached semantic hash mismatch");
    return payload.result;
  } catch {
    if (compressed) await rm(cache.filename, { force: true }).catch(() => {});
    return null;
  }
}

async function writeCachedDerivative(cache, result) {
  let temporary = null;
  try {
    const payload = {
      schemaVersion: DERIVATIVE_SCHEMA,
      namespace: DERIVATIVE_NAMESPACE,
      key: cache.key,
      sourceSha256: cache.sourceSha256,
      behaviorDigest: cache.behaviorDigest,
      page: cache.page,
      mime: cache.mime,
      svgSha256: sha256Text(result.svg),
      semanticSha256: sha256Text(JSON.stringify(result.semantic)),
      result
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 6 });
    if (compressed.length > MAX_COMPRESSED_ENTRY_BYTES) return;
    const directory = path.dirname(cache.filename);
    await mkdir(directory, { recursive: true });
    temporary = `${cache.filename}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, compressed);
    await rename(temporary, cache.filename);
  } catch {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
    // Cache storage must never change extraction behavior or fail a world build.
  }
}

async function sha256FileOnce(filename) {
  const resolved = path.resolve(filename);
  let promise = sourceDigestCache.get(resolved);
  if (!promise) {
    promise = readFile(resolved).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
    sourceDigestCache.set(resolved, promise);
  }
  return promise;
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function rasterImage(filename, page, workDirectory, key, mime) {
  if (String(mime || "").startsWith("image/")) return filename;
  const prefix = path.join(workDirectory, `${key}-p${page}-render`);
  const output = `${prefix}.png`;
  await rm(output, { force: true });
  await execFileAsync("pdftocairo", [
    "-png", "-singlefile", "-r", "300", "-f", String(page), "-l", String(page), filename, prefix
  ], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  return output;
}

export async function extractRasterTextAnchors(filename, options = {}) {
  return (await extractRasterTextObservations(filename, options)).anchors;
}

export async function extractRasterTextObservations(filename, options = {}) {
  try {
    const { stdout } = await execFileAsync("tesseract", [filename, "stdout", "--psm", "11", "tsv"], {
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8"
    });
    return parseTesseractTsvObservations(stdout, options);
  } catch {
    return { anchors: [], lines: [] };
  }
}

export function parseTesseractTsv(value, options = {}) {
  return parseTesseractTsvObservations(value, options).anchors;
}

export function parseTesseractTsvObservations(value, options = {}) {
  const coordinateScale = Number(options.coordinateScale) || 1;
  const minimumConfidence = Number(options.minimumConfidence ?? 35);
  const rows = String(value || "").split(/\r?\n/).slice(1).map((line) => line.split("\t"));
  const lines = new Map();
  for (const fields of rows) {
    if (fields.length < 12) continue;
    const confidence = Number(fields[10]);
    const text = fields.slice(11).join("\t").trim();
    if (!text || !Number.isFinite(confidence) || confidence < minimumConfidence) continue;
    const key = fields.slice(1, 5).join(":");
    const x = Number(fields[6]) * coordinateScale, y = Number(fields[7]) * coordinateScale;
    const width = Number(fields[8]) * coordinateScale, height = Number(fields[9]) * coordinateScale;
    if (![x, y, width, height].every(Number.isFinite)) continue;
    const line = lines.get(key) || { words: [], xMin: x, yMin: y, xMax: x + width, yMax: y + height, confidence: 0 };
    line.words.push(text);
    line.xMin = Math.min(line.xMin, x); line.yMin = Math.min(line.yMin, y);
    line.xMax = Math.max(line.xMax, x + width); line.yMax = Math.max(line.yMax, y + height);
    line.confidence = Math.max(line.confidence, confidence);
    lines.set(key, line);
  }
  const rawLines = [...lines.values()].map((line) => ({
    text: line.words.join(" "),
    xMin: line.xMin, yMin: line.yMin, xMax: line.xMax, yMax: line.yMax,
    cx: (line.xMin + line.xMax) / 2,
    cy: (line.yMin + line.yMax) / 2,
    ocrConfidence: line.confidence / 100
  }));
  const anchors = rawLines.flatMap((line) => {
    const sourceText = line.text;
    const semantic = classifyComprehensivePlanningLabel(sourceText);
    if (!semantic) return [];
    return [{
      text: sourceText,
      xMin: line.xMin, yMin: line.yMin, xMax: line.xMax, yMax: line.yMax,
      cx: line.cx,
      cy: line.cy,
      ocrConfidence: line.ocrConfidence,
      semantic
    }];
  });
  return { anchors, lines: rawLines };
}

function mergeOcrAnchors(...groups) {
  const anchors = [], seen = new Set();
  for (const anchor of groups.flat()) {
    const key = `${anchor.semantic?.featureClass}:${Math.round(anchor.cx)}:${Math.round(anchor.cy)}:${String(anchor.text).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push(anchor);
  }
  return anchors;
}

function mergeRawLines(...groups) {
  const lines = [], seen = new Set();
  for (const line of groups.flat()) {
    const key = `${Math.round(line.cx)}:${Math.round(line.cy)}:${String(line.text).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function safeKey(value) {
  return String(value || "drawing").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
}
