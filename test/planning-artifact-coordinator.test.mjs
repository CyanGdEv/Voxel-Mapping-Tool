import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { zipSync } from "fflate";
import {
  awaitPlanningResults,
  exactShardArtifacts,
  latestCompletePlanningAttempt
} from "../scripts/await-planning-results.mjs";

test("generation coordinator consumes exact shard artifacts while the matrix is still running", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tpmap-planning-coordinator-"));
  const planFile = path.join(directory, "planning-plan.json");
  const progress = [];
  let artifactPolls = 0;
  const result = await awaitPlanningResults({
    repository: "fixture/repository",
    runId: 123,
    runAttempt: 2,
    expected: 2,
    outputDirectory: directory,
    planningPlanFile: planFile,
    token: "fixture-token",
    pollIntervalMs: 0,
    sleep: async () => {},
    progress: (message) => progress.push(message),
    fetchImpl: async (url) => {
      if (url.endsWith("/artifacts?per_page=100")) {
        artifactPolls += 1;
        return jsonResponse({ artifacts: artifactPolls === 1
          ? [planArtifact(), artifact(0)]
          : [artifact(1), planArtifact(), artifact(0)] });
      }
      if (url.endsWith("/jobs?filter=latest&per_page=100")) {
        return jsonResponse({ jobs: [{ name: "planning-extract (1)", status: "in_progress", conclusion: null }] });
      }
      if (url.endsWith("/plan")) return new Response(planArchive(), { status: 200 });
      const index = Number(url.split("/").at(-1));
      return new Response(shardArchive(index, 2), { status: 200 });
    }
  });

  assert.equal(result.shards, 2);
  assert.equal(result.sourceRunAttempt, 2);
  assert.equal(artifactPolls, 2);
  assert.match(progress[0], /1\/2/);
  assert.match(progress.at(-1), /2\/2/);
  assert.equal(JSON.parse(await readFile(planFile, "utf8")).documentQueue.length, 2);
  for (let index = 0; index < 2; index += 1) {
    const bundle = JSON.parse(await readFile(path.join(directory, `shard-${index}.json`), "utf8"));
    assert.equal(bundle.shardIndex, index);
    assert.equal(bundle.shardCount, 2);
  }
});

test("generation coordinator fails immediately when a planning shard fails", async () => {
  await assert.rejects(() => awaitPlanningResults({
    repository: "fixture/repository",
    runId: 456,
    runAttempt: 1,
    expected: 2,
    outputDirectory: path.join(os.tmpdir(), "tpmap-planning-coordinator-unused"),
    token: "fixture-token",
    sleep: async () => {},
    fetchImpl: async (url) => url.includes("/artifacts")
      ? jsonResponse({ artifacts: [] })
      : jsonResponse({ jobs: [{ name: "planning-extract (1)", status: "completed", conclusion: "failure" }] })
  }), /planning-extract \(1\)=failure/);
});

test("exact shard artifact selection rejects duplicates and ignores unrelated artifacts", () => {
  const prefix = "planning-result-123-1-";
  assert.deepEqual(exactShardArtifacts([
    { name: "unrelated", expired: false },
    { name: `${prefix}1`, expired: false, id: 2 },
    { name: `${prefix}0`, expired: false, id: 1 }
  ], prefix, 2).map((item) => item.shardIndex), [0, 1]);
  assert.throws(() => exactShardArtifacts([
    { name: `${prefix}0`, expired: false },
    { name: `${prefix}0`, expired: false }
  ], prefix, 2), /duplicate planning result artifact/);
});

test("a failed-job rerun can reuse the latest earlier complete planning attempt", () => {
  const artifacts = [
    { name: "planning-plan-777-1", expired: false },
    { name: "planning-result-777-1-0", expired: false },
    { name: "planning-result-777-1-1", expired: false },
    { name: "planning-plan-777-2", expired: false },
    { name: "planning-result-777-2-0", expired: false }
  ];
  assert.equal(latestCompletePlanningAttempt(artifacts, 777, 3, 2), 1);
});

function artifact(index) {
  return {
    id: index + 1,
    name: `planning-result-123-2-${index}`,
    expired: false,
    archive_download_url: `https://artifacts.example/${index}`
  };
}

function planArtifact() {
  return {
    id: 99,
    name: "planning-plan-123-2",
    expired: false,
    archive_download_url: "https://artifacts.example/plan"
  };
}

function shardArchive(index, shardCount) {
  const payload = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    marker: "TPMAP_PREPARED_PLANNING_SHARD_V2",
    shardIndex: index,
    shardCount
  }));
  return zipSync({ [`nested/shard-${index}.json`]: payload });
}

function planArchive() {
  return zipSync({ "planning-plan.json": Buffer.from(JSON.stringify({
    schemaVersion: 1,
    marker: "TPMAP_AUTOMATIC_PLANNING_PLAN_V1",
    documentQueue: [{}, {}]
  })) });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
