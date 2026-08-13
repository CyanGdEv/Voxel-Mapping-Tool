#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const PREPARED_SHARD_MARKER = "TPMAP_PREPARED_PLANNING_SHARD_V2";
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export async function awaitPlanningResults({
  repository,
  runId,
  runAttempt,
  expected = 20,
  outputDirectory,
  planningPlanFile = "planning-plan.json",
  token,
  timeoutMs = 45 * 60 * 1000,
  pollIntervalMs = 10_000,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  progress = () => {}
}) {
  if (!/^[^/]+\/[^/]+$/.test(String(repository || ""))) throw new Error("repository must use owner/name form");
  if (!Number.isInteger(Number(runId)) || Number(runId) < 1) throw new Error("runId must be a positive integer");
  if (!Number.isInteger(Number(runAttempt)) || Number(runAttempt) < 1) throw new Error("runAttempt must be a positive integer");
  if (!Number.isInteger(Number(expected)) || Number(expected) < 1 || Number(expected) > 100) throw new Error("expected must be between 1 and 100");
  if (!outputDirectory) throw new Error("outputDirectory is required");
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  const apiRoot = `https://api.github.com/repos/${repository}/actions/runs/${Number(runId)}`;
  const deadline = Date.now() + Number(timeoutMs);
  let selectedAttempt = null;
  let currentPlanMisses = 0;
  let reported = -1;
  while (true) {
    const artifactPayload = await githubJson(fetchImpl, `${apiRoot}/artifacts?per_page=100`, token);
    const availableArtifacts = artifactPayload.artifacts || [];
    if (selectedAttempt === null) {
      const currentPlanName = `planning-plan-${Number(runId)}-${Number(runAttempt)}`;
      if (availableArtifacts.some((artifact) => !artifact.expired && artifact.name === currentPlanName)) {
        selectedAttempt = Number(runAttempt);
      } else {
        currentPlanMisses += 1;
        if (currentPlanMisses >= 2) {
          selectedAttempt = latestCompletePlanningAttempt(
            availableArtifacts,
            Number(runId),
            Number(runAttempt),
            Number(expected)
          );
          if (selectedAttempt !== null) {
            progress(`Planning coordinator: reusing complete artifacts from run attempt ${selectedAttempt}`);
          }
        }
      }
    }
    const prefix = selectedAttempt === null
      ? `planning-result-${Number(runId)}-${Number(runAttempt)}-`
      : `planning-result-${Number(runId)}-${selectedAttempt}-`;
    const artifacts = exactShardArtifacts(availableArtifacts, prefix, Number(expected));
    if (artifacts.length !== reported) {
      progress(`Planning coordinator: ${artifacts.length}/${expected} finalized shard artifact(s) ready`);
      reported = artifacts.length;
    }
    if (selectedAttempt !== null && artifacts.length === Number(expected)) {
      const planArtifact = availableArtifacts.find((artifact) =>
        !artifact.expired && artifact.name === `planning-plan-${Number(runId)}-${selectedAttempt}`);
      if (!planArtifact) throw new Error(`planning plan artifact for run attempt ${selectedAttempt} disappeared`);
      const files = await downloadShardArtifacts({
        artifacts,
        expected: Number(expected),
        outputDirectory,
        token,
        fetchImpl
      });
      await downloadPlanningPlanArtifact({
        artifact: planArtifact,
        outputFile: planningPlanFile,
        token,
        fetchImpl
      });
      return {
        repository,
        runId: Number(runId),
        runAttempt: Number(runAttempt),
        sourceRunAttempt: selectedAttempt,
        planningPlanFile: path.resolve(planningPlanFile),
        shards: files.length,
        files
      };
    }

    const jobPayload = await githubJson(fetchImpl, `${apiRoot}/jobs?filter=latest&per_page=100`, token);
    const failed = (jobPayload.jobs || []).filter((job) =>
      /^planning-extract \(\d+\)$/.test(String(job.name || "")) &&
      (selectedAttempt === null || job.run_attempt === undefined || Number(job.run_attempt) === selectedAttempt) &&
      job.status === "completed" && job.conclusion !== "success");
    if (failed.length) {
      throw new Error(`planning extraction failed before handoff: ${failed.map((job) => `${job.name}=${job.conclusion}`).join(", ")}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for exact planning coverage (${artifacts.length}/${expected} shard artifacts)`);
    }
    await sleep(Number(pollIntervalMs));
  }
}

export function latestCompletePlanningAttempt(artifacts, runId, currentAttempt, expected) {
  const attempts = artifacts.flatMap((artifact) => {
    const match = String(artifact?.name || "").match(new RegExp(`^planning-plan-${Number(runId)}-(\\d+)$`));
    if (!match || artifact.expired) return [];
    const attempt = Number(match[1]);
    return attempt < currentAttempt ? [attempt] : [];
  }).sort((left, right) => right - left);
  for (const attempt of [...new Set(attempts)]) {
    const prefix = `planning-result-${Number(runId)}-${attempt}-`;
    if (exactShardArtifacts(artifacts, prefix, expected).length === expected) return attempt;
  }
  return null;
}

export function exactShardArtifacts(artifacts, prefix, expected) {
  const byIndex = new Map();
  for (const artifact of artifacts) {
    if (artifact?.expired) continue;
    const name = String(artifact?.name || "");
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const index = Number(suffix);
    if (index < 0 || index >= expected) continue;
    if (byIndex.has(index)) throw new Error(`duplicate planning result artifact for shard ${index}`);
    byIndex.set(index, { ...artifact, shardIndex: index });
  }
  return [...byIndex.values()].sort((left, right) => left.shardIndex - right.shardIndex);
}

async function downloadShardArtifacts({ artifacts, expected, outputDirectory, token, fetchImpl }) {
  const target = path.resolve(outputDirectory);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  return mapLimit(artifacts, 4, async (artifact) => {
    const jsonEntries = await downloadJsonEntries({ artifact, token, fetchImpl });
    if (jsonEntries.length !== 1) throw new Error(`planning artifact ${artifact.name} must contain exactly one JSON bundle`);
    const bytes = jsonEntries[0][1];
    let bundle;
    try { bundle = JSON.parse(Buffer.from(bytes).toString("utf8")); }
    catch { throw new Error(`planning artifact ${artifact.name} contains invalid JSON`); }
    if (bundle?.marker !== PREPARED_SHARD_MARKER || bundle.shardIndex !== artifact.shardIndex || bundle.shardCount !== expected) {
      throw new Error(`planning artifact ${artifact.name} failed its shard identity contract`);
    }
    const filename = path.join(target, `shard-${artifact.shardIndex}.json`);
    await writeFile(filename, bytes);
    return filename;
  });
}

async function downloadPlanningPlanArtifact({ artifact, outputFile, token, fetchImpl }) {
  const entries = await downloadJsonEntries({ artifact, token, fetchImpl });
  if (entries.length !== 1) throw new Error(`planning artifact ${artifact.name} must contain exactly one JSON bundle`);
  const bytes = entries[0][1];
  let plan;
  try { plan = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error(`planning artifact ${artifact.name} contains invalid JSON`); }
  if (plan?.marker !== "TPMAP_AUTOMATIC_PLANNING_PLAN_V1" || !Array.isArray(plan.documentQueue)) {
    throw new Error(`planning artifact ${artifact.name} failed its frozen-plan contract`);
  }
  const filename = path.resolve(outputFile);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes);
}

async function downloadJsonEntries({ artifact, token, fetchImpl }) {
  const response = await fetchImpl(artifact.archive_download_url, {
    headers: githubHeaders(token),
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`planning artifact ${artifact.name} download failed: HTTP ${response.status}`);
  const declaredBytes = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`planning artifact ${artifact.name} exceeds the coordinator size limit`);
  }
  const archive = new Uint8Array(await response.arrayBuffer());
  if (!archive.length || archive.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`planning artifact ${artifact.name} has an invalid archive size`);
  }
  return Object.entries(unzipSync(archive)).filter(([filename]) => filename.endsWith(".json"));
}

async function githubJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    const message = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`GitHub Actions API failed: HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }
  return response.json();
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "Voxel-Mapping-Tool/planning-coordinator"
  };
}

async function mapLimit(values, concurrency, worker) {
  const output = new Array(values.length);
  let next = 0;
  const run = async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return output;
}

function cliOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid coordinator argument ${key || "(missing)"}`);
    values[key.slice(2)] = value;
  }
  return values;
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  const result = await awaitPlanningResults({
    repository: options.repository || process.env.GITHUB_REPOSITORY,
    runId: Number(options["run-id"] || process.env.GITHUB_RUN_ID),
    runAttempt: Number(options["run-attempt"] || process.env.GITHUB_RUN_ATTEMPT),
    expected: Number(options.expected || 20),
    outputDirectory: options.out || ".tpmap-cache/prepared-planning-shards",
    planningPlanFile: options["plan-out"] || "planning-plan.json",
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    timeoutMs: Number(options["timeout-ms"] || 45 * 60 * 1000),
    progress: (message) => console.error(`• ${message}`)
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
