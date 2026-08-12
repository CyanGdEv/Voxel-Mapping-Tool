import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  autoGeoreferencePlanningPage,
  corroborateAutomaticPlanningCollection,
  detectPlanningScales
} from "../src/lib/planning-auto-georeference.mjs";
import { discoverPlanningApplications, selectPlanningShard } from "../src/lib/planning-discovery.mjs";
import {
  classifyPlanningDocument,
  classifyPlanningApplication,
  extractApplicationLinks,
  extractDocumentLinks,
  extractDocumentPageLinks,
  parsePlanningApplicationPage
} from "../src/lib/planning-portal-html.mjs";
import { classifyComprehensivePlanningLabel } from "../src/lib/planning-comprehensive-semantics.mjs";
import { parseArgs } from "../src/lib/args.mjs";
import { acquirePlanningEvidence } from "../src/lib/planning-manifest.mjs";

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
  const inputs = workflow.match(/inputs:\n([\s\S]*?)\n\npermissions:/)?.[1] || "";
  assert.match(inputs, /^\s{6}park:/m);
  assert.doesNotMatch(inputs, /planning_manifest|strict:/);
  assert.match(workflow, /--park "\$PARK_ID"/);
  assert.doesNotMatch(workflow, /--max-planning-applications 6/);
  assert.match(workflow, /--strict/);
  assert.doesNotMatch(workflow, /--planning-manifest/);
  assert.match(workflow, /secrets\.TPMAP_CONTACT \|\| format\(/);
  assert.doesNotMatch(workflow, /Configure the TPMAP_CONTACT repository secret/);
  assert.equal((workflow.match(/key: source-v3-[^\n]*github\.run_attempt/g) || []).length, 2,
    "source cache restore and save keys must be unique for every retry attempt");
  assert.match(workflow, /max-parallel: 20/);
  assert.match(workflow, /planning-shard-count 20/);
  assert.match(workflow, /merge-multiple: true/);
  assert.match(workflow, /--planning-plan planning-plan\.json/);
});

test("parallel planning shards cover every document exactly once", () => {
  const queue = Array.from({ length: 160 }, (_, index) => ({ index }));
  const shards = Array.from({ length: 20 }, (_, index) => selectPlanningShard(queue, index, 20));
  assert.ok(shards.every((shard) => shard.length === 8));
  assert.deepEqual(shards.flat().map((item) => item.index).sort((a, b) => a - b),
    queue.map((item) => item.index));
});

test("automatic planning controls are bounded and can be explicitly disabled for expert inputs", () => {
  const parsed = parseArgs([
    "build", "--park", "thorpe-park", "--max-planning-applications", "300",
    "--max-planning-documents", "120", "--max-planning-pages-per-document", "16",
    "--planning-georef-min-confidence", "0.8", "--no-auto-planning"
  ]).options;
  assert.equal(parsed.maxPlanningApplications, 300);
  assert.equal(parsed.maxPlanningDocuments, 120);
  assert.equal(parsed.maxPlanningPagesPerDocument, 16);
  assert.equal(parsed.planningGeorefMinConfidence, 0.8);
  assert.equal(parsed.noAutoPlanning, true);
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
    semantic: { anchors, rawLines: [{ text: "Scale 1:500" }] },
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
      properties: { kind: "building", planning_authoritative: true }
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

function anchor(text, cx, cy) {
  const semantic = classifyComprehensivePlanningLabel(text);
  assert.ok(semantic, `fixture text must classify: ${text}`);
  return {
    text, cx, cy, xMin: cx - 20, xMax: cx + 20, yMin: cy - 8, yMax: cy + 8,
    ocrConfidence: 0.95, semantic
  };
}
