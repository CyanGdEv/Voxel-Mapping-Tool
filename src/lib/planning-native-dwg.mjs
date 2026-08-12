import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  extractNativeDxfPlanning as extractStrictDxfPlanning,
  looksLikeAsciiDxf as looksLikeStrictAsciiDxf
} from "./planning-native-dxf.mjs";

const DEFAULT_CONVERTER = "dwg2dxf";
const LIBREDWG_VERSION = "0.14";
const CONVERTER_TIMEOUT_MS = 90_000;
const BOOTSTRAP_TIMEOUT_MS = 240_000;
const VERSION_CACHE = new Map();

/**
 * Converts a native DWG to an intermediate ASCII DXF with GNU LibreDWG and
 * immediately reuses the strict native DXF planning decoder. The DWG remains
 * the evidence identity; the DXF is an implementation detail and is never
 * treated as an independent source.
 */
export function extractNativeDwgPlanning({
  bytes,
  application = {},
  document = {},
  profile,
  minimumConfidence = 0.72,
  converterPath = process.env.TPMAP_DWG2DXF || DEFAULT_CONVERTER,
  converterVersion = process.env.TPMAP_DWG2DXF_VERSION || null,
  convertDwg = null
}) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!looksLikeDwg(source)) return empty("native-dwg-signature-invalid", null, converterPath);
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");

  let converted;
  let detectedVersion = converterVersion;
  let effectiveConverterPath = converterPath;
  try {
    if (typeof convertDwg === "function") {
      const result = convertDwg(source, { converterPath, document, application });
      converted = Buffer.isBuffer(result) ? result : Buffer.from(result || []);
      detectedVersion ||= "injected-test-converter";
    } else {
      let result;
      try {
        result = convertWithLibreDwg(source, effectiveConverterPath);
      } catch (error) {
        if (!converterUnavailable(error) || !shouldBootstrapConverter(converterPath)) throw error;
        effectiveConverterPath = bootstrapLibreDwg();
        result = convertWithLibreDwg(source, effectiveConverterPath);
      }
      converted = result.bytes;
      detectedVersion ||= result.version;
    }
  } catch (error) {
    const unavailable = converterUnavailable(error);
    return empty(unavailable ? "native-dwg-converter-unavailable" : "native-dwg-conversion-failed", error, effectiveConverterPath, {
      sourceHash,
      converterVersion: detectedVersion
    });
  }

  if (!looksLikeStrictAsciiDxf(converted)) {
    return empty("native-dwg-conversion-invalid-dxf", new Error("DWG converter did not produce ASCII DXF"), effectiveConverterPath, {
      sourceHash,
      converterVersion: detectedVersion
    });
  }

  const extracted = extractStrictDxfPlanning({
    bytes: converted,
    application,
    document,
    profile,
    minimumConfidence
  });
  const features = extracted.collection?.features || [];
  const convertedHash = crypto.createHash("sha256").update(converted).digest("hex");

  for (const feature of features) {
    feature.properties ||= {};
    feature.properties.source = "official-planning-native-dwg";
    feature.properties.planning_native_source_format = "dwg";
    feature.properties.planning_native_source_sha256 = sourceHash;
    feature.properties.planning_native_conversion = "gnu-libredwg-dwg2dxf";
    feature.properties.planning_native_converter_version = detectedVersion || "unknown";
    feature.properties.planning_native_intermediate_sha256 = convertedHash;
    feature.properties.planning_georeference_method = String(feature.properties.planning_georeference_method || "native-dxf")
      .replace(/^native-dxf/, "native-dwg-converted-dxf");
  }

  return {
    ...extracted,
    status: features.length
      ? "native-dwg-geometry-ready"
      : String(extracted.status || "native-dxf-no-semantic-geometry").replace(/^native-dxf/, "native-dwg"),
    nativeFormat: "dwg",
    conversion: {
      engine: "GNU LibreDWG dwg2dxf",
      converterPath: effectiveConverterPath,
      version: detectedVersion || "unknown",
      sourceSha256: sourceHash,
      intermediateSha256: convertedHash,
      intermediateBytes: converted.length
    },
    collection: { type: "FeatureCollection", features }
  };
}

export function looksLikeDwg(bytes) {
  const head = Buffer.isBuffer(bytes) ? bytes.subarray(0, 16) : Buffer.from(bytes || []).subarray(0, 16);
  return /^AC10\d{2}/.test(head.toString("ascii"));
}

function convertWithLibreDwg(source, converterPath) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tpmap-dwg-"));
  const input = path.join(directory, "source.dwg");
  const output = path.join(directory, "converted.dxf");
  try {
    writeFileSync(input, source, { flag: "wx" });
    execFileSync(converterPath, ["-y", "-o", output, input], {
      timeout: CONVERTER_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const bytes = readFileSync(output);
    return { bytes, version: converterVersion(converterPath) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function shouldBootstrapConverter(converterPath) {
  if (converterPath !== DEFAULT_CONVERTER) return false;
  if (process.env.TPMAP_AUTO_BUILD_DWG_CONVERTER === "0") return false;
  return process.env.TPMAP_AUTO_BUILD_DWG_CONVERTER === "1" || process.env.GITHUB_ACTIONS === "true";
}

function bootstrapLibreDwg() {
  const prefix = path.resolve(
    process.env.TPMAP_DWG_TOOL_PREFIX || path.join(".tpmap-cache", "native-tools", `libredwg-${LIBREDWG_VERSION}`)
  );
  const executable = path.join(prefix, "bin", "dwg2dxf");
  if (existsSync(executable)) return executable;

  const script = path.resolve("scripts", "build-libredwg.sh");
  if (!existsSync(script)) {
    const error = new Error(`LibreDWG bootstrap script is missing: ${script}`);
    error.code = "ENOENT";
    throw error;
  }
  execFileSync("bash", [script, prefix], {
    timeout: BOOTSTRAP_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!existsSync(executable)) throw new Error("LibreDWG bootstrap completed without dwg2dxf");
  return executable;
}

function converterUnavailable(error) {
  return error?.code === "ENOENT" || /ENOENT|not found|no such file/i.test(error?.message || String(error));
}

function converterVersion(converterPath) {
  if (VERSION_CACHE.has(converterPath)) return VERSION_CACHE.get(converterPath);
  let value = "unknown";
  try {
    const stdout = execFileSync(converterPath, ["--version"], {
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    value = String(stdout || "").split(/\r?\n/).find(Boolean)?.trim() || "unknown";
  } catch { /* conversion already proved the executable works */ }
  VERSION_CACHE.set(converterPath, value);
  return value;
}

function empty(status, error, converterPath, extra = {}) {
  return {
    status,
    page: 1,
    confidence: 0,
    scale: null,
    location: null,
    origin: null,
    shapes: 0,
    associatedShapes: 0,
    nativeFormat: "dwg",
    registration: null,
    conversion: {
      engine: "GNU LibreDWG dwg2dxf",
      converterPath,
      version: extra.converterVersion || null,
      sourceSha256: extra.sourceHash || null,
      error: error ? (error?.message || String(error)) : null
    },
    collection: { type: "FeatureCollection", features: [] }
  };
}
