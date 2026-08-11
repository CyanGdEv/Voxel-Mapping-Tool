import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.mjs";

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError(`Invalid JSON in ${filename}: ${error.message}`);
    throw error;
  }
}

export async function writeJson(filename, value, spaces = 2) {
  return writeText(filename, `${JSON.stringify(value, null, spaces)}\n`);
}

export async function writeText(filename, value) {
  await ensureDir(path.dirname(filename));
  const temp = `${filename}.tmp-${process.pid}`;
  await writeFile(temp, value);
  await rename(temp, filename);
  return filename;
}

export async function writeBinary(filename, value) {
  await ensureDir(path.dirname(filename));
  const temp = `${filename}.tmp-${process.pid}`;
  await writeFile(temp, value);
  await rename(temp, filename);
  return filename;
}

export function slugify(value) {
  return String(value || "theme-park")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase() || "theme-park";
}

export function sha256(value) {
  const bytes = typeof value === "string" || Buffer.isBuffer(value) || ArrayBuffer.isView(value)
    ? value
    : value instanceof ArrayBuffer ? new Uint8Array(value) : JSON.stringify(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function cachedJson({ cacheDir, key, noCache, fetcher }) {
  const filename = path.join(cacheDir, `${sha256(key)}.json`);
  if (!noCache && await exists(filename)) return { data: await readJson(filename), cacheHit: true, filename };
  const data = await fetcher();
  await writeJson(filename, data);
  return { data, cacheHit: false, filename };
}

export async function cachedBinary({ cacheDir, key, noCache, fetcher, extension = ".bin" }) {
  const suffix = String(extension).startsWith(".") ? extension : `.${extension}`;
  const filename = path.join(cacheDir, `${sha256(key)}${suffix}`);
  if (!noCache && await exists(filename)) return { data: null, cacheHit: true, filename };
  const data = await fetcher();
  await writeBinary(filename, data);
  return { data, cacheHit: false, filename };
}

export async function fetchJson(url, init = {}, { timeoutMs = 120_000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const body = await response.text();
      if (!response.ok) throw new UserError(`HTTP ${response.status} from ${new URL(url).host}`, body.slice(0, 500));
      try {
        return JSON.parse(body);
      } catch {
        throw new UserError(`Expected JSON from ${new URL(url).host}`, body.slice(0, 500));
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function fetchBinary(url, init = {}, { timeoutMs = 180_000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text();
        throw new UserError(`HTTP ${response.status} from ${new URL(url).host}`, body.slice(0, 500));
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
