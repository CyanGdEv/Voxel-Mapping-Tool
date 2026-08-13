import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  autoGeoreferencePlanningPage,
  corroborateAutomaticPlanningCollection,
  detectPlanningScales,
  prepareAutomaticPlanningCorroboration
} from "../src/lib/planning-auto-georeference.mjs";
import {
  acquireAutomaticPlanningEvidence,
  createAutomaticPlanningPlan,
  createPlanningExtractionScheduler,
  discoverPlanningApplications,
  loadPreparedPlanningDocuments,
  mergePreparedPlanningShardBundles,
  planningDocumentIdentity,
  PREPARED_MERGED_MARKER,
  PREPARED_SHARD_MARKER,
  retryPlanningOperation,
  requireAutomaticPlanningDocuments,
  seedPlanningDocumentFromCorpus,
  selectPlanningShard
} from "../src/lib/planning-discovery.mjs";
import {
  classifyPlanningDocument,
  classifyPlanningApplication,
  extractApplicationLinks,
  extractDocumentLinks,
  extractDocumentPageLinks,
  parsePlanningApplicationPage
} from "../src/lib/planning-portal-html.mjs";
import { classifyComprehensivePlanningLabel } from "../src/lib/planning-comprehensive-semantics.mjs";
import { extractNativeDxfPlanning, looksLikeAsciiDxf } from "../src/lib/planning-native-vector.mjs";
import { parseArgs } from "../src/lib/args.mjs";
import { acquirePlanningEvidence } from "../src/lib/planning-manifest.mjs";
import { sha256 } from "../src/lib/io.mjs";

const profile = {
  id: "fixture-park",
  name: "Fixture Park",
  bbox: { south: 51, west: -0.01, north: 51.02, east: 0.01 },
  planningAuthority: {
    name: "Fixture Council",
    officialPortal: "https://planning.example/search",
    searchTerms: ["Fixture Park", "FP1 1AA"]
  },
  planningDiscovery: {
    portalType: "idox",
    searchUrl: "https://planning.example/online-applications/search.do?action=simple",
    allowedDocumentHosts: ["planning.example"]
  }
};

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production GitHub Action requires only a park selection", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/generate-themepark.yml"), "utf8");
  const consolidation = await readFile(path.join(repositoryRoot, ".github/workflows/consolidate-planning-corpus.yml"), "utf8");
  const inputs = workflow.match(/inputs:\n([\s\S]*?)\n\npermissions:/)?.[1] || "";
  assert.match(inputs, /^\s{6}park:/m);
  assert.doesNotMatch(inputs, /planning_manifest|strict:/);
  assert.match(workflow, /--park "\$PARK_ID"/);
  assert.doesNotMatch(workflow, /--max-planning-applications 6/);
  assert.match(workflow, /--strict/);
  assert.doesNotMatch(workflow, /--planning-manifest/);
  assert.match(workflow, /secrets\.TPMAP_CONTACT \|\| format\(/);
  assert.doesNotMatch(workflow, /Configure the TPMAP_CONTACT repository secret/);
  assert.equal((workflow.match(/key: source-v3-[^\n]*github\.run_attempt/g) || []).length, 3,
    "source cache restore, save and corpus migration keys must be unique for every retry attempt");
  assert.match(workflow, /max-parallel: 20/);
  assert.match(workflow, /planning-shard-count 20/);
  assert.match(workflow, /--planning-plan planning-plan\.json/);
  assert.match(workflow, /quality-gate:/);
  assert.match(workflow, /merge-planning/);
  assert.doesNotMatch(workflow, /^  planning-merge:/m);
  assert.match(workflow, /planning-result-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /planning-finalized-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /planning-discovery-v2-/);
  assert.match(workflow, /planning-shard-v2-/);
  assert.match(workflow, /planning-corpus:/);
  assert.match(workflow, /planning-corpus-v1-/);
  assert.match(workflow, /Restore the legacy park-wide source cache for one-time corpus migration/);
  assert.match(workflow, /TPMAP_PLANNING_CORPUS_DIR: \.tpmap-cache\/planning-corpus/);
  assert.match(workflow, /Upload this shard's raw planning-document delta/);
  assert.match(workflow, /Configure bounded page-level extraction parallelism/);
  assert.match(workflow, /TPMAP_PLANNING_WORKERS=\$workers/);
  assert.match(workflow, /apt-get install --yes --no-install-recommends/);
  assert.match(workflow, /Save this shard's content-addressed planning cache/);
  assert.match(workflow, /Await and download exact planning shard coverage/);
  assert.match(workflow, /node scripts\/await-planning-results\.mjs/);
  assert.match(workflow, /--prepared-planning-directory \.tpmap-cache\/finalized-planning/);
  assert.match(workflow, /\.tpmap-cache\/prepared-planning\/shard-\$\{\{ matrix\.shard \}\}\.json/);
  assert.doesNotMatch(workflow, /--allow-prepared-planning-fallback/);
  const generateJob = workflow.split("\n  generate:\n")[1] || "";
  assert.match(generateJob, /needs: \[quality-gate, planning-plan, planning-corpus\]/);
  assert.doesNotMatch(generateJob, /needs:.*planning-extract|needs:.*planning-merge/);
  assert.doesNotMatch(generateJob, /Download frozen planning work queue/);
  assert.doesNotMatch(generateJob, /planning-cache-/);
  assert.doesNotMatch(generateJob, /sudo apt-get install.*(?:poppler|tesseract)/);
  assert.doesNotMatch(generateJob, /run: npm test/);
  assert.match(consolidation, /workflow_run:/);
  assert.match(workflow, /planning-corpus\/\.park-id/);
  assert.match(consolidation, /planning-corpus\/\.park-id/);
  assert.match(consolidation, /Consolidate content-addressed documents without changing evidence bytes/);
  assert.match(consolidation, /planning-documents-\$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(consolidation, /merge-multiple: true/);
  assert.match(consolidation, /planning-corpus-v1-/);
});

test("a shard seeds its active document cache from the shared park corpus", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tpmap-planning-corpus-"));
  const corpusDir = path.join(directory, "corpus");
  const cacheDir = path.join(directory, "active");
  const url = "https://planning.example/existing-layout.pdf";
  const basename = `${sha256(url)}.pdf`;
  await mkdir(path.join(corpusDir, profile.id), { recursive: true });
  await writeFile(path.join(corpusDir, profile.id, basename), "official planning bytes");

  assert.equal(await seedPlanningDocumentFromCorpus({
    cacheDir, corpusDir, profileId: profile.id, url, extension: ".pdf"
  }), true);
  assert.equal(await readFile(path.join(cacheDir, basename), "utf8"), "official planning bytes");
  assert.equal(await seedPlanningDocumentFromCorpus({
    cacheDir, corpusDir, profileId: profile.id, url, extension: ".pdf"
  }), false);
});

test("parallel planning shards cover every document exactly once", () => {
  const queue = Array.from({ length: 160 }, (_, index) => ({ index }));
  const shards = Array.from({ length: 20 }, (_, index) => selectPlanningShard(queue, index, 20));
  assert.ok(shards.every((shard) => shard.length === 8));
  assert.deepEqual(shards.flat().map((item) => item.index).sort((a, b) => a - b),
    queue.map((item) => item.index));
});

test("page-level planning work uses every bounded worker without oversubscription", async () => {
  const scheduler = createPlanningExtractionScheduler(3);
  let active = 0;
  let maximumActive = 0;
  const completionOrder = [];
  const results = await Promise.all(Array.from({ length: 9 }, (_, index) => scheduler.run(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, (9 - index) % 4));
    completionOrder.push(index);
    active -= 1;
    return index;
  })));
  assert.equal(maximumActive, 3);
  assert.deepEqual(results, Array.from({ length: 9 }, (_, index) => index));
  assert.equal(new Set(completionOrder).size, 9);

  const recovery = createPlanningExtractionScheduler(1);
  await assert.rejects(recovery.run(async () => { throw new Error("bounded task failed"); }), /bounded task failed/);
  assert.equal(await recovery.run(async () => "next task ran"), "next task ran");
});

test("prepared planning shards merge once in frozen plan order with exact integrity", () => {
  const plan = syntheticPlanningPlan(40);
  const bundles = syntheticPreparedBundles(plan, 20);
  const merged = mergePreparedPlanningShardBundles(bundles, plan, profile);
  assert.equal(merged.marker, PREPARED_MERGED_MARKER);
  assert.equal(merged.shardCount, 20);
  assert.equal(merged.documentCount, 40);
  assert.equal(merged.entriesSha256, sha256(merged.entries));
  assert.deepEqual(merged.entries.map((entry) => entry.identity),
    plan.documentQueue.map(planningDocumentIdentity));
  assert.equal(merged.entries[0].failures[0].adapter, "planning-page-extraction");
  assert.ok(merged.entries.every((entry) => !("document" in entry) && !("application" in entry)));

  assert.throws(() => mergePreparedPlanningShardBundles(bundles.slice(1), plan, profile),
    /expected 20 shard bundles but found 19/);
  const tampered = structuredClone(bundles);
  tampered[0].assignedDocumentIdentities.reverse();
  assert.throws(() => mergePreparedPlanningShardBundles(tampered, plan, profile),
    /assignment does not match/);
  const swapped = structuredClone(bundles);
  [swapped[0].entries[0], swapped[1].entries[0]] = [swapped[1].entries[0], swapped[0].entries[0]];
  assert.throws(() => mergePreparedPlanningShardBundles(swapped, plan, profile),
    /entries do not match its frozen assignment/);
});

test("planning extraction retries only the failed bounded operation once", async () => {
  let recoveredAttempts = 0;
  const recovered = await retryPlanningOperation(async () => {
    recoveredAttempts += 1;
    if (recoveredAttempts === 1) throw new Error("transient page failure");
    return "page-result";
  });
  assert.deepEqual(recovered, { value: "page-result", retries: 1 });
  assert.equal(recoveredAttempts, 2);

  let failedAttempts = 0;
  await assert.rejects(async () => retryPlanningOperation(async () => {
    failedAttempts += 1;
    throw new Error("persistent page failure");
  }), (error) => error.message === "persistent page failure" && error.planningRetryCount === 1);
  assert.equal(failedAttempts, 2);
});

test("prepared handoff retains shard failures without downloading or extracting documents again", async () => {
  const plan = syntheticPlanningPlan(160);
  const merged = mergePreparedPlanningShardBundles(syntheticPreparedBundles(plan, 20), plan, profile);
  const directory = await mkdtemp(path.join(os.tmpdir(), "tpmap-zero-rework-handoff-"));
  await writeFile(path.join(directory, "prepared-planning.json"), JSON.stringify(merged));
  let fetches = 0;
  const progress = [];
  const processed = await loadPreparedPlanningDocuments(
    directory,
    plan,
    plan.documentQueue,
    { parkProfile: profile },
    {
      center: { lon: 0, lat: 51.01 },
      cacheDir: directory,
      fetchBinary: async () => { fetches += 1; throw new Error("handoff must not fetch"); },
      progress: (message) => progress.push(message)
    }
  );
  assert.equal(fetches, 0);
  assert.equal(processed.length, 160);
  assert.deepEqual({
    mode: processed.handoffDiagnostics.mode,
    documents: processed.handoffDiagnostics.documents,
    downloads: processed.handoffDiagnostics.downloads,
    extractionRetries: processed.handoffDiagnostics.extractionRetries
  }, { mode: "zero-rework", documents: 160, downloads: 0, extractionRetries: 0 });
  assert.ok(processed.every((entry) => entry.evidence.preparedHandoffMode === "zero-rework"));
  assert.equal(processed[0].evidence.acquired, true);
  assert.equal(processed[0].failures[0].adapter, "planning-page-extraction");
  assert.ok(progress.every((message) => /(?:zero|0) extraction retries/.test(message)));
  assert.match(progress.at(-1), /0 downloads; 0 extraction retries/);
});

test("an invalid prepared handoff fails closed instead of silently starting serial extraction", async () => {
  const plan = syntheticPlanningPlan(1);
  const directory = await mkdtemp(path.join(os.tmpdir(), "tpmap-invalid-handoff-"));
  const planPath = path.join(directory, "planning-plan.json");
  await writeFile(planPath, JSON.stringify(plan));
  let fetches = 0;
  await assert.rejects(() => acquireAutomaticPlanningEvidence({
    parkProfile: profile,
    planningPlan: planPath,
    preparedPlanningDirectory: directory
  }, {
    center: { lon: 0, lat: 51.01 },
    cacheDir: directory,
    fetchBinary: async () => { fetches += 1; throw new Error("must not fetch"); },
    progress() {}
  }), /Prepared planning handoff failed closed/);
  assert.equal(fetches, 0);
});

test("prepared planning corroboration preserves DSM evidence and eligibility", () => {
  const collection = {
    type: "FeatureCollection",
    features: [0, 1, 2].map((index) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [index * 0.00001, 51.01] },
      properties: {
        kind: "building",
        planning_authoritative: true,
        planning_spatial_registration_verified: true
      }
    }))
  };
  let samples = 0;
  const runtime = {
    center: { lon: 0, lat: 51.01 },
    elevation: {
      samplePairLocal() {
        samples += 1;
        return { terrain: 100, surface: 105 };
      }
    }
  };
  const existingInput = { status: "Approved and completed", proposal: "Existing as-built station" };
  const existing = corroborateAutomaticPlanningCollection(
    collection, existingInput, runtime, prepareAutomaticPlanningCorroboration(existingInput)
  );
  assert.equal(existing.worldEligible, true);
  assert.equal(existing.dsm.samples, 3);
  assert.equal(samples, 3);

  const proposedInput = { status: "Approved", proposal: "Proposed station" };
  const proposed = corroborateAutomaticPlanningCollection(
    collection, proposedInput, runtime, prepareAutomaticPlanningCorroboration(proposedInput)
  );
  assert.equal(proposed.worldEligible, true);
  assert.equal(proposed.dsm.samples, 3);
  assert.equal(samples, 6);
});

test("automatic planning controls are bounded and can be explicitly disabled for expert inputs", () => {
  const parsed = parseArgs([
    "build", "--park", "thorpe-park", "--max-planning-applications", "300",
    "--max-planning-documents", "120", "--max-planning-pages-per-document", "16",
    "--planning-georef-min-confidence", "0.8", "--no-auto-planning",
    "--allow-prepared-planning-fallback"
  ]).options;
  assert.equal(parsed.maxPlanningApplications, 300);
  assert.equal(parsed.maxPlanningDocuments, 120);
  assert.equal(parsed.maxPlanningPagesPerDocument, 16);
  assert.equal(parsed.planningGeorefMinConfidence, 0.8);
  assert.equal(parsed.noAutoPlanning, true);
  assert.equal(parsed.allowPreparedPlanningFallback, true);
});

test("official portal HTML adapters recover applications, metadata and ranked drawing links", () => {
  const html = `
    <table>
      <tr><th>Application number</th><td>25/0042/FUL</td></tr>
      <tr><th>Site address</th><td>Fixture Park FP1 1AA</td></tr>
      <tr><th>Proposal</th><td>Existing roller coaster support replacement</td></tr>
      <tr><th>Decision</th><td>Approved</td></tr>
      <tr><th>Decision date</th><td>10/07/2025</td></tr>
    </table>
    <a href="applicationDetails.do?activeTab=summary&keyVal=ABC">Application</a>
    <a href="applicationDetails.do?activeTab=documents&keyVal=ABC">Documents</a>
    <a href="download/approved-ride-layout.pdf">Approved Ride Layout and Elevations</a>
    <a href="download/application-form.pdf">Application Form</a>`;
  const base = "https://planning.example/online-applications/search.do";
  assert.equal(extractApplicationLinks(html, base).length, 2);
  const documents = extractDocumentLinks(html, base, ["planning.example"]);
  assert.equal(documents[0].role, "ride-layout-and-structure");
  assert.equal(documents[0].relevant, true);
  assert.equal(documents.some((item) => /application-form/.test(item.url)), true);
  assert.equal(classifyPlanningDocument("Application Form", "form.pdf").relevant, false);
  const parsed = parsePlanningApplicationPage(html, base);
  assert.equal(parsed.reference, "25/0042/FUL");
  assert.match(parsed.address, /Fixture Park/);
  assert.equal(parsed.decisionDate, "2025-07-10");
});

test("native ASCII DXF planning drawings retain model-space precision", () => {
  const dxf = Buffer.from(`0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\nProposed Building Footprint\n70\n1\n10\n0\n20\n0\n10\n20\n20\n0\n10\n20\n20\n10\n10\n0\n20\n10\n0\nTEXT\n8\nAnnotations\n10\n10\n20\n5\n1\nNew station building FFL 95.20m\n0\nENDSEC\n0\nEOF\n`);
  assert.equal(looksLikeAsciiDxf(dxf), true);
  const result = extractNativeDxfPlanning({
    bytes: dxf,
    application: { reference: "25/0042/FUL", geometry: { type: "Point", coordinates: [0, 51.01] } },
    document: { id: "station-cad", role: "site-layout" },
    profile,
    minimumConfidence: 0.72
  });
  assert.equal(result.status, "native-dxf-geometry-ready");
  assert.equal(result.registration, "local-model-space");
  assert.ok(result.collection.features.some((feature) => feature.properties.kind === "building"));
  assert.ok(result.collection.features.every((feature) => feature.properties.planning_georeference_method.startsWith("native-dxf-")));
  const unregistered = extractNativeDxfPlanning({
    bytes: dxf, application: { reference: "25/0043/FUL" }, document: { id: "unlocated-cad" }, profile
  });
  assert.equal(unregistered.status, "native-dxf-registration-unavailable");
});

test("native planning file types are discovered and ranked", () => {
  const documents = extractDocumentLinks(`
    <a href="drawings/ride-general-arrangement.dxf">Approved ride layout CAD</a>
    <a href="models/station.ifc">Station building model</a>`,
  "https://planning.example/application/42", ["planning.example"]);
  assert.deepEqual(documents.map((document) => path.extname(new URL(document.url).pathname)).sort(), [".dxf", ".ifc"]);
  assert.ok(documents.every((document) => document.relevant));
});

test("legacy Idox AppBlobImage links become allowlisted integrity-checkable documents", () => {
  const base = "http://planning.example/portal/servlets/ApplicationSearchServlet?PKID=42";
  const html = `<table>
    <tr><th>Application number</th><td>SMD/2025/0042</td><th>Application type</th><td>Full</td></tr>
    <tr><th>Site address</th><td>Fixture Park</td><th>Proposal</th><td>Existing ride alterations</td></tr>
    <tr><th>Decision</th><td>Planning Permission - Approved</td><th>Decision Date</th><td>23/06/2025</td></tr>
  </table><a href="javascript:AppBlobImage('385881');">Site Plan as Existing - Scale 1:500</a>`;
  const documents = extractDocumentLinks(html, base, ["planning.example"]);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].url,
    "http://planning.example/portal/servlets/AttachmentShowServlet?ImageName=385881");
  assert.equal(documents[0].relevant, true);
  assert.equal(documents[0].role, "site-layout");
  const application = parsePlanningApplicationPage(html, base);
  assert.equal(application.reference, "SMD/2025/0042");
  assert.equal(application.proposal, "Existing ride alterations");
  assert.equal(application.decision, "Planning Permission - Approved");
  assert.equal(application.decisionDate, "2025-06-23");
  assert.equal(application.easting, null);
});

test("Northgate document-list links decode hexadecimal entities and NEC document models", () => {
  const northgate = "https://planning.runnymede.gov.uk/Northgate/PlanningExplorer/Generic/StdDetails.aspx";
  const details = `<a href="&#xD;&#xA;https://docs.runnymede.gov.uk/PublicAccess_LIVE/SearchResult/RunThirdPartySearch?FileSystemId=PL&amp;FOLDER1_REF=RU.21/2180">View Documents</a>`;
  const pages = extractDocumentLinks(details, northgate, ["docs.runnymede.gov.uk"]);
  assert.equal(pages.length, 0, "a document-list page must not be mistaken for a PDF");
  assert.equal(extractDocumentPageLinks(details, northgate, ["docs.runnymede.gov.uk"])[0].url,
    "https://docs.runnymede.gov.uk/PublicAccess_LIVE/SearchResult/RunThirdPartySearch?FileSystemId=PL&FOLDER1_REF=RU.21/2180");

  const listPage = `<script>var model ={"Rows":[
    {"Guid":"967DFF22E4FE4DF1BBA45E8BC5BE2448","Doc_Type":"Plan","Doc_Ref2":"Proposed ride layout and elevations"},
    {"Guid":"21C011E4B42A47A79907C8DA2D527315","Doc_Type":"Consultation Response","Doc_Ref2":"Natural England"}
  ]};</script>`;
  const documents = extractDocumentLinks(listPage,
    "https://docs.runnymede.gov.uk/PublicAccess_LIVE/SearchResult/RunThirdPartySearch?FileSystemId=PL",
    ["docs.runnymede.gov.uk"]);
  assert.equal(documents.length, 2);
  assert.equal(documents[0].url,
    "https://docs.runnymede.gov.uk/PublicAccess_Live/Document/ViewDocument?id=967DFF22E4FE4DF1BBA45E8BC5BE2448");
  assert.equal(documents[0].role, "ride-layout-and-structure");
  assert.equal(documents[0].relevant, true);
  assert.equal(documents[1].relevant, false);
});

test("document tabs and table sort links are never downloaded as drawing files", () => {
  const base = "https://planning.example/online-applications/applicationDetails.do?keyVal=ABC";
  const html = `<a href="applicationDetails.do?activeTab=documents&amp;keyVal=ABC">Documents</a>
    <a href="applicationDetails.do?activeTab=documents&amp;keyVal=ABC&amp;documentOrdering.orderBy=date">Date published</a>
    <a href="files/ABC/pdf/site-layout.pdf">Site layout</a>`;
  const documents = extractDocumentLinks(html, base, ["planning.example"]);
  assert.deepEqual(documents.map((item) => item.title), ["Site layout"]);
});

test("automatic discovery merges PlanIt spatial results with official portal search and removes unrelated records", async () => {
  const planit = {
    type: "FeatureCollection",
    total: 2,
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 51.01] },
        properties: {
          reference: "25/0042/FUL",
          address: "Fixture Park FP1 1AA",
          description: "Existing roller coaster support replacement",
          decision: "Approved",
          source_url: "https://planning.example/online-applications/applicationDetails.do?keyVal=ABC"
        }
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0.009, 51.019] },
        properties: {
          reference: "25/9999/HOU",
          address: "Unrelated Cottage",
          description: "Rear house extension",
          decision: "Approved"
        }
      }
    ]
  };
  const result = await discoverPlanningApplications(profile, { maxPlanningApplications: 20 }, {
    cacheDir: "/tmp/not-used",
    userAgent: "VoxelMappingTool/test",
    fetchJson: async () => planit,
    fetchText: async () => '<a href="applicationDetails.do?activeTab=summary&keyVal=ABC">Fixture Park application</a>'
  });
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].reference, "25/0042/FUL");
  assert.equal(result.summary.mode, "automatic-park-selection");
  assert.equal(result.failures.length, 0);
});

test("metadata triage scans beyond the crawl cap and selects geometry-rich park applications", async () => {
  let requestedPageSize = null;
  const result = await discoverPlanningApplications(profile, { maxPlanningApplications: 1 }, {
    cacheDir: "/tmp/not-used",
    userAgent: "VoxelMappingTool/test",
    fetchJson: async (url) => {
      requestedPageSize = Number(new URL(url).searchParams.get("pg_sz"));
      return {
        type: "FeatureCollection",
        total: 2,
        features: [{
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 51.01] },
          properties: {
            reference: "25/0001/SCR",
            address: "Fixture Park FP1 1AA",
            description: "Screening Opinion Request",
            url: "https://planning.example/online-applications/applicationDetails.do?keyVal=NEW"
          }
        }, {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 51.01] },
          properties: {
            reference: "18/0042/FUL",
            address: "Fixture Park FP1 1AA",
            description: "Construction of roller coaster, station building, paths and landscaping",
            url: "https://planning.example/online-applications/applicationDetails.do?keyVal=VALUABLE"
          }
        }]
      };
    },
    fetchText: async () => ""
  });
  assert.equal(requestedPageSize, 300);
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].reference, "18/0042/FUL");
  assert.equal(result.summary.minimumApplicationScore, 180);
  assert.equal(result.summary.rejectedApplications, 1);
});

test("metadata triage requires park identity and keeps geometry-bearing condition records", () => {
  const condition = classifyPlanningApplication({
    address: "Fixture Park, FP1 1AA",
    proposal: "Discharge of conditions 3 and 6 for approved site layout, paths and materials"
  }, profile);
  assert.equal(condition.relevant, true);
  assert.ok(condition.categories.includes("condition"));
  assert.ok(condition.categories.includes("site-layout"));

  const nearbyHouse = classifyPlanningApplication({
    address: "Unrelated Cottage",
    proposal: "Construction of house, access, drainage, landscaping and retaining walls"
  }, profile);
  assert.equal(nearbyHouse.relevant, false);
  assert.equal(nearbyHouse.excludedReason, "outside-park-identity");

  const consultation = classifyPlanningApplication({
    address: "Fixture Park, FP1 1AA",
    proposal: "Consultation from adjoining authority in connection with an application for a ride"
  }, profile);
  assert.equal(consultation.relevant, false);
  assert.equal(consultation.excludedReason, "consultation-copy");

  const townAliasProfile = {
    ...profile,
    name: "Chessington World of Adventures Resort",
    aliases: ["Chessington"],
    planningAuthority: { ...profile.planningAuthority, searchTerms: ["Chessington World of Adventures", "Leatherhead Road", "KT9 2NE"] }
  };
  const sameTown = classifyPlanningApplication({
    address: "Chessington High Street",
    proposal: "Construction of a building and landscaped parking area"
  }, townAliasProfile);
  assert.equal(sameTown.relevant, false, "a broad CLI alias must not become a planning-site identity");
});

test("PlanIt raw URLs cannot bypass a park's official-host allowlist", async () => {
  const result = await discoverPlanningApplications(profile, { maxPlanningApplications: 20 }, {
    cacheDir: "/tmp/not-used",
    userAgent: "VoxelMappingTool/test",
    fetchJson: async () => ({
      type: "FeatureCollection",
      total: 1,
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 51.01] },
        properties: {
          reference: "25/0043/CNA",
          address: "Fixture Park FP1 1AA",
          description: "Existing ride consultation",
          url: "https://neighbouring-council.example/applicationDetails.do?keyVal=FOREIGN"
        }
      }]
    }),
    fetchText: async () => ""
  });
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].sourceUrl, null);
});

test("blocked discovery services produce diagnostics instead of silently substituting map geometry", async () => {
  const result = await discoverPlanningApplications(profile, {}, {
    cacheDir: "/tmp/not-used",
    userAgent: "VoxelMappingTool/test",
    fetchJson: async () => { throw new Error("PlanIt rate limited"); },
    fetchText: async () => { throw new Error("Council access denied"); }
  });
  assert.equal(result.applications.length, 0);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures.map((item) => item.error).join(" "), /rate limited|access denied/);
});

test("an unavailable official host opens a circuit instead of timing out once per application", async () => {
  let portalCalls = 0;
  const applications = Array.from({ length: 12 }, (_, index) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 51.01] },
    properties: {
      reference: `25/${String(index).padStart(4, "0")}/FUL`,
      address: "Fixture Park FP1 1AA",
      description: "Existing ride structure",
      app_state: "Permitted",
      url: `http://planning.example/applicationDetails.do?keyVal=${index}`
    }
  }));
  const result = await acquirePlanningEvidence({ parkProfile: profile }, {
    bbox: profile.bbox,
    center: { lat: 51.01, lon: 0 },
    cacheDir: "/tmp/not-used",
    userAgent: "VoxelMappingTool/test",
    fetchJson: async () => ({ type: "FeatureCollection", total: applications.length, features: applications }),
    fetchText: async () => {
      portalCalls += 1;
      throw new Error("HTTP 502 from planning.example");
    }
  });
  assert.equal(result.applications.length, 12);
  assert.ok(portalCalls <= 5, `portal was called ${portalCalls} times`);
  assert.match(result.failures.map((item) => item.error).join(" "), /circuit open/);
});

test("official archive seeds remain discoverable when a legacy portal has no machine-search endpoint", async () => {
  const legacyProfile = {
    ...profile,
    planningDiscovery: {
      portalType: "legacy-idox",
      searchUrl: "https://planning.example/legacy/ApplicationSearchServlet",
      allowedDocumentHosts: ["planning.example"],
      seedApplicationUrls: ["https://planning.example/legacy/ApplicationSearchServlet?PKID=42"]
    }
  };
  const result = await discoverPlanningApplications(legacyProfile, {}, {
    cacheDir: "/tmp/not-used",
    userAgent: "VoxelMappingTool/test",
    fetchJson: async () => { throw new Error("index unavailable"); }
  });
  assert.equal(result.applications.length, 1);
  assert.match(result.applications[0].sourceUrl, /PKID=42/);
  assert.equal(result.applications[0].discoveryProvider, "park-profile-official-seed");
});

test("priority archive seeds survive a deliberately small application limit", async () => {
  const preferred = "https://planning.example/legacy/ApplicationSearchServlet?PKID=WICKER";
  const secondary = "https://planning.example/legacy/ApplicationSearchServlet?PKID=GARDENS";
  const priorityProfile = {
    ...profile,
    planningDiscovery: {
      portalType: "legacy-idox",
      searchUrl: "https://planning.example/legacy/ApplicationSearchServlet",
      allowedDocumentHosts: ["planning.example"],
      seedApplicationUrls: [secondary, preferred],
      priorityApplicationUrls: [preferred, secondary]
    }
  };
  const result = await discoverPlanningApplications(priorityProfile, { maxPlanningApplications: 1 }, {
    cacheDir: "/tmp/not-used",
    userAgent: "VoxelMappingTool/test",
    fetchJson: async () => ({ type: "FeatureCollection", total: 0, features: [] })
  });
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].sourceUrl, preferred);
  assert.ok(result.applications[0].discoveryScore >= 9_000);
});

test("a configured public archive recovers council-submitted documents with explicit provenance", async () => {
  const archiveProfile = {
    ...profile,
    planningDiscovery: {
      ...profile.planningDiscovery,
      documentArchives: [{
        provider: "Fixture public planning archive",
        applicationUrlTemplate: "https://archive.example/app/{portalKey}/",
        allowedDocumentHosts: ["archive.example"],
        landingPathPrefix: "/docs/",
        rawDocumentBaseUrl: "https://files.archive.example/",
        verifyRawDocuments: true
      }]
    }
  };
  const plan = await createAutomaticPlanningPlan({
    parkProfile: archiveProfile,
    maxPlanningApplications: 1,
    maxPlanningDocuments: 10
  }, {
    bbox: archiveProfile.bbox,
    cacheDir: "/tmp/not-used",
    userAgent: "VoxelMappingTool/test",
    fetchJson: async () => ({
      type: "FeatureCollection",
      total: 1,
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 51.01] },
        properties: {
          reference: "25/0042/FUL",
          address: "Fixture Park FP1 1AA",
          description: "Existing roller coaster layout and ride structure",
          app_state: "Permitted",
          url: "https://planning.example/online-applications/applicationDetails.do?keyVal=ABC42"
        }
      }]
    }),
    fetchHead: async (url) => url.endsWith("stale.pdf")
      ? ({ ok: false, status: 404 })
      : ({ ok: true, status: 200 }),
    fetchText: async (url) => {
      if (url.includes("search.do")) return "";
      if (url === "https://archive.example/app/ABC42/") return `
        <table><tr><td>21/11/2024</td><td>Existing ride layout drawing</td>
        <td><a href="https://archive.example/docs/20241121/ABC42/layout.pdf"><i>PDF</i></a></td></tr>
        <tr><td>21/11/2024</td><td>Removed duplicate</td>
        <td><a href="https://archive.example/docs/20241121/ABC42/stale.pdf"><i>PDF</i></a></td></tr></table>`;
      throw new Error("HTTP 502 from official planning register");
    }
  });

  assert.equal(plan.documentQueue.length, 1);
  const { document, application } = plan.documentQueue[0];
  assert.equal(document.title, "Existing ride layout drawing - PDF");
  assert.equal(document.url, "https://files.archive.example/20241121/ABC42/layout.pdf");
  assert.equal(document.retrievalProvider, "Fixture public planning archive");
  assert.equal(document.retrievalApplicationUrl, "https://archive.example/app/ABC42/");
  assert.equal(document.archivedDocumentUrl, "https://archive.example/docs/20241121/ABC42/layout.pdf");
  assert.equal(document.officialApplicationUrl, application.sourceUrl);
  assert.match(plan.failures.map((item) => item.error).join(" "), /HTTP 502/);
  assert.ok(plan.failures.some((item) => item.adapter === "archived-planning-document-preflight"));
  assert.match(plan.warnings.join(" "), /official application provenance was retained/);
});

test("empty automatic planning plans fail before extraction shards start", () => {
  assert.throws(() => requireAutomaticPlanningDocuments({ applications: [{ reference: "A" }], documentQueue: [] }),
    /no retrievable planning documents; refusing to start empty extraction shards/);
  const usable = { applications: [], documentQueue: [{ document: { id: "one" } }] };
  assert.equal(requireAutomaticPlanningDocuments(usable), usable);
});

test("Chessington config prioritizes recoverable official applications and a bounded archive", async () => {
  const chessington = JSON.parse(await readFile(
    path.join(repositoryRoot, "config/parks/chessington-world-of-adventures.json"), "utf8"
  ));
  assert.ok(chessington.planningDiscovery.priorityApplicationUrls.length >= 10);
  assert.deepEqual(chessington.planningDiscovery.seedApplicationUrls,
    chessington.planningDiscovery.priorityApplicationUrls);
  assert.deepEqual(chessington.planningDiscovery.documentArchives, [{
    provider: "Planning Alerts public archive",
    applicationUrlTemplate: "https://planning.org.uk/app/94/{portalKey}/",
    allowedDocumentHosts: ["planning.org.uk"],
    landingPathPrefix: "/docs/",
    rawDocumentBaseUrl: "https://docs.planning.org.uk/",
    verifyRawDocuments: true
  }]);
});

test("planning acquisition automatically invokes discovery when a supported park has no manual manifest", async () => {
  const planit = {
    type: "FeatureCollection",
    total: 1,
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 51.01] },
      properties: {
        reference: "25/0042/FUL",
        address: "Fixture Park FP1 1AA",
        description: "Existing ride structure",
        app_state: "Permitted",
        url: "https://planning.example/online-applications/applicationDetails.do?keyVal=ABC"
      }
    }]
  };
  const result = await acquirePlanningEvidence({ parkProfile: profile }, {
    bbox: profile.bbox,
    center: { lat: 51.01, lon: 0 },
    cacheDir: "/tmp/not-used",
    userAgent: "VoxelMappingTool/test",
    fetchJson: async () => planit,
    fetchText: async (url) => url.includes("search.do")
      ? ""
      : "<table><tr><th>Application number</th><td>25/0042/FUL</td></tr></table>"
  });
  assert.equal(result.automatic, true);
  assert.equal(result.applications.length, 1);
  assert.equal(result.status, "applications-found-no-documents");
  assert.equal(result.featureCount, 0);
});

test("drawing scale, red-line alignment and semantic extraction produce planning-authoritative GeoJSON", () => {
  const svg = `<svg width="1000" height="1000" viewBox="0 0 1000 1000">
    <polygon points="100,100 900,100 900,900 100,900" stroke="rgb(220,20,20)" fill="none" />
    <polygon points="250,250 450,250 450,450 250,450" stroke="rgb(30,30,30)" fill="none" />
    <line x1="250" y1="720" x2="750" y2="720" stroke="rgb(20,20,20)" />
  </svg>`;
  const anchors = [
    anchor("Existing station building FFL 112.4", 350, 350),
    anchor("Existing roller coaster track alignment", 500, 720)
  ];
  const result = autoGeoreferencePlanningPage({
    svg,
    semantic: { anchors, rawLines: [{ text: "Scale 1:500" }], northDegrees: 0 },
    application: {
      reference: "25/0042/FUL",
      geometry: { type: "Point", coordinates: [-0.002, 51.01] },
      locationConfidence: 0.95
    },
    document: { id: "approved-layout", title: "Existing as-built layout" },
    profile,
    minimumConfidence: 0.7
  });
  assert.equal(detectPlanningScales("Scale 1:500 at A1")[0].denominator, 500);
  assert.equal(result.status, "geometry-ready");
  assert.equal(result.origin.method, "red-line-boundary");
  assert.ok(result.collection.features.some((feature) => feature.properties.kind === "building"));
  assert.ok(result.collection.features.some((feature) => feature.properties.kind === "ride_track"));
  assert.ok(result.collection.features.every((feature) => feature.properties.planning_authoritative));
  assert.ok(result.collection.features.every((feature) => feature.properties.planning_georeference_confidence >= 0.7));
});

test("automatic world eligibility requires an accepted decision plus as-built/current-state evidence", () => {
  const collection = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 51] },
      properties: {
        kind: "building",
        planning_authoritative: true,
        planning_spatial_registration_verified: true
      }
    }]
  };
  const eligible = corroborateAutomaticPlanningCollection(collection, {
    status: "Approved and completed",
    proposal: "Existing as-built station building"
  });
  assert.equal(eligible.worldEligible, true);
  const proposedOnly = corroborateAutomaticPlanningCollection(collection, {
    status: "Approved",
    proposal: "Proposed station building"
  });
  assert.equal(proposedOnly.worldEligible, false);
});

test("planning labels distinguish detected ride attachments from generic site features", () => {
  const cases = new Map([
    ["Existing left-hand coaster catwalk 1.2m wide", ["ride-catwalk", "catwalk", "track-relative", "left"]],
    ["Emergency ride access stairs", ["ride-evacuation-stair", "evacuation_stair", "terrain-following", null]],
    ["Track maintenance platform", ["ride-maintenance-platform", "maintenance_platform", "track-relative", null]],
    ["Station boarding platform", ["ride-station-platform", "station_platform", "track-relative", null]],
    ["Safety handrail to ride platform", ["ride-handrail", "handrail", "track-relative", null]],
    ["Roller coaster perimeter fence", ["ride-fence", "fence", "terrain-following", null]],
    ["Ride maintenance access path", ["ride-access-path", "access_path", "terrain-following", null]]
  ]);
  for (const [label, expected] of cases) {
    const semantic = classifyComprehensivePlanningLabel(label);
    assert.equal(semantic.className, "ride_attachment", label);
    assert.deepEqual([
      semantic.featureClass,
      semantic.attachmentType,
      semantic.attachmentVerticalMode,
      semantic.attachmentSide
    ], expected, label);
  }
  assert.equal(classifyComprehensivePlanningLabel("Permanent perimeter fence").className, "fence");
  assert.equal(classifyComprehensivePlanningLabel("Pedestrian access path").className, "path");
});

function syntheticPlanningPlan(count) {
  return {
    schemaVersion: 1,
    marker: "TPMAP_AUTOMATIC_PLANNING_PLAN_V1",
    parkId: profile.id,
    createdAt: "2026-08-13T00:00:00.000Z",
    discovery: {},
    applications: [],
    failures: [],
    warnings: [],
    documentQueue: Array.from({ length: count }, (_, index) => ({
      application: {
        reference: `APP-${index}`,
        status: "Approved and completed",
        proposal: "Existing as-built park feature"
      },
      document: {
        id: `document-${index}`,
        title: `Existing drawing ${index}`,
        role: "site-layout",
        url: `https://planning.example/documents/${index}.pdf`
      }
    }))
  };
}

function syntheticPreparedBundles(plan, shardCount) {
  return Array.from({ length: shardCount }, (_, shardIndex) => {
    const assigned = selectPlanningShard(plan.documentQueue, shardIndex, shardCount);
    return {
      schemaVersion: 2,
      marker: PREPARED_SHARD_MARKER,
      parkId: plan.parkId,
      planSha256: sha256(plan),
      shardIndex,
      shardCount,
      assignedDocumentIdentities: assigned.map(planningDocumentIdentity),
      entries: assigned.map((item, entryIndex) => ({
        identity: planningDocumentIdentity(item),
        evidence: {
          id: item.document.id,
          acquired: true,
          worldEligible: false,
          extraction: [{ page: 1, status: "geometry-ready" }]
        },
        candidateCollection: {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 51.01] },
            properties: { kind: "building", planning_authoritative: true }
          }]
        },
        corroboration: prepareAutomaticPlanningCorroboration({
          ...item.application,
          proposal: `${item.application.proposal || ""} ${item.document.title || ""} ${item.document.role || ""}`
        }),
        failures: shardIndex === 0 && entryIndex === 0
          ? [{ adapter: "planning-page-extraction", error: "prepared failure retained" }]
          : [],
        warnings: []
      }))
    };
  });
}

function anchor(text, cx, cy) {
  const semantic = classifyComprehensivePlanningLabel(text);
  assert.ok(semantic, `fixture text must classify: ${text}`);
  return {
    text, cx, cy, xMin: cx - 20, xMax: cx + 20, yMin: cy - 8, yMax: cy + 8,
    ocrConfidence: 0.95, semantic
  };
}
