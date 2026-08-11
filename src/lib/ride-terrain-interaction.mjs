// TPMAP_PHASE34_RIDE_TERRAIN_INTERACTION_V1
// Classify solved 3D ride geometry against bare-earth DTM without fabricating unresolved spans.

const DEFAULT_ELEVATED_CLEARANCE_M = 2.0;
const DEFAULT_NEAR_GRADE_M = 0.75;
const DEFAULT_TUNNEL_DEPTH_M = 1.5;

export function classifyRideTerrainInteractions(graph, sources = null, options = {}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error("Phase 34 ride terrain interaction requires reconstruction graph");
  const elevation = sources?.elevation || sources?.lidar || null;
  const dtm = resolveDtm(elevation);
  const diagnostics = {
    marker: "TPMAP_PHASE34_RIDE_TERRAIN_INTERACTION_V1",
    ridesVisited: 0, samplesResolved: 0, samplesUnresolved: 0,
    elevatedSamples: 0, nearGradeSamples: 0, cuttingSamples: 0, tunnelSamples: 0,
    interactionIntervals: 0, excavationIntervals: 0
  };
  const compact = [];
  for (const node of graph.nodes) {
    if (node.type !== "ride-track") continue;
    diagnostics.ridesVisited += 1;
    const result = solveRide(node, dtm, options, diagnostics);
    Object.defineProperty(node, "terrainInteraction", { enumerable: false, configurable: true, value: result });
    compact.push(compactResult(result));
  }
  graph.rideTerrainInteractions = compact;
  graph.summary = { ...(graph.summary || {}), rideTerrainInteraction: diagnostics };
  return diagnostics;
}

export function validateRideTerrainInteractions(graph) {
  const diag = graph?.summary?.rideTerrainInteraction;
  if (!diag || diag.marker !== "TPMAP_PHASE34_RIDE_TERRAIN_INTERACTION_V1") throw new Error("Phase 34 ride terrain interaction diagnostics missing");
  for (const node of graph.nodes || []) {
    if (node.type !== "ride-track") continue;
    const r = node.terrainInteraction;
    if (!r) throw new Error(`Phase 34 ride ${node.id} lacks terrain interaction state`);
    for (const s of r.samples || []) {
      if (s.status === "unresolved") {
        if (s.clearanceM !== null || s.groundY !== null) throw new Error(`Phase 34 ride ${node.id} fabricated unresolved terrain clearance`);
      } else if (!["elevated","near-grade","cutting","tunnel"].includes(s.status)) {
        throw new Error(`Phase 34 ride ${node.id} invalid terrain status ${s.status}`);
      }
    }
    for (const interval of r.intervals || []) {
      if (!(interval.endMeasureM > interval.startMeasureM)) throw new Error(`Phase 34 ride ${node.id} invalid terrain interval`);
    }
    if (r.osmDerived) throw new Error(`Phase 34 ride ${node.id} terrain interaction used OSM-derived evidence`);
  }
  return graph;
}

function solveRide(node, dtm, options, diagnostics) {
  if (node.authority?.osmDerived) throw new Error(`Phase 34 ride terrain interaction rejected OSM-derived ride ${node.id}`);
  const g = node.geometry3d;
  if (!g || !Array.isArray(g.samples) || !g.samples.length) return unresolved(node, "missing-3d-ride-geometry");
  const elevated = finite(options.rideElevatedClearanceM) ?? DEFAULT_ELEVATED_CLEARANCE_M;
  const nearGrade = finite(options.rideNearGradeToleranceM) ?? DEFAULT_NEAR_GRADE_M;
  const tunnelDepth = finite(options.rideTunnelDepthM) ?? DEFAULT_TUNNEL_DEPTH_M;
  const samples = [];
  for (const s of g.samples) {
    if (!s.resolved || !Number.isFinite(s.y) || !dtm) {
      diagnostics.samplesUnresolved += 1;
      samples.push({ measureM:s.measureM, x:s.x, y:s.y, z:s.z, groundY:null, clearanceM:null, status:"unresolved", reason:!dtm?"missing-dtm-sampler":"unresolved-track-y" });
      continue;
    }
    const groundY = finite(dtm(s.x, s.z));
    if (groundY === null) {
      diagnostics.samplesUnresolved += 1;
      samples.push({ measureM:s.measureM, x:s.x, y:s.y, z:s.z, groundY:null, clearanceM:null, status:"unresolved", reason:"missing-dtm-sample" });
      continue;
    }
    const clearance = s.y - groundY;
    let status;
    if (clearance >= elevated) status = "elevated";
    else if (clearance >= -nearGrade) status = "near-grade";
    else if (clearance <= -tunnelDepth) status = "tunnel";
    else status = "cutting";
    diagnostics.samplesResolved += 1;
    if (status === "elevated") diagnostics.elevatedSamples += 1;
    else if (status === "near-grade") diagnostics.nearGradeSamples += 1;
    else if (status === "cutting") diagnostics.cuttingSamples += 1;
    else diagnostics.tunnelSamples += 1;
    samples.push({ measureM:s.measureM, x:s.x, y:s.y, z:s.z, groundY:round3(groundY), clearanceM:round3(clearance), status, reason:null });
  }
  const intervals = buildIntervals(samples, diagnostics);
  const status = samples.every(s=>s.status!=="unresolved") ? "resolved" : samples.some(s=>s.status!=="unresolved") ? "partial" : "unresolved";
  return {
    marker:"TPMAP_PHASE34_RIDE_TERRAIN_INTERACTION_V1", rideId:node.id, status,
    thresholds:{ elevatedClearanceM:elevated, nearGradeToleranceM:nearGrade, tunnelDepthM:tunnelDepth },
    samples, intervals,
    excavationIntervals: intervals.filter(i=>i.status==="cutting"||i.status==="tunnel").map(i=>({ ...i, excavationRequired:true })),
    osmDerived:false,
    policy:"planning-3d-ride-vs-independent-dtm-no-unresolved-extrapolation"
  };
}

function buildIntervals(samples, diagnostics) {
  const out=[]; let current=null;
  for (const s of samples) {
    const key=s.status;
    if (!current || current.status!==key) {
      if (current) finishInterval(current,out,diagnostics);
      current={status:key,startMeasureM:s.measureM,endMeasureM:s.measureM,minClearanceM:s.clearanceM,maxClearanceM:s.clearanceM};
    } else {
      current.endMeasureM=s.measureM;
      if (s.clearanceM!==null) {
        current.minClearanceM=current.minClearanceM===null?s.clearanceM:Math.min(current.minClearanceM,s.clearanceM);
        current.maxClearanceM=current.maxClearanceM===null?s.clearanceM:Math.max(current.maxClearanceM,s.clearanceM);
      }
    }
  }
  if (current) finishInterval(current,out,diagnostics);
  return out;
}
function finishInterval(i,out,d){ if (i.endMeasureM>i.startMeasureM) { i.startMeasureM=round3(i.startMeasureM); i.endMeasureM=round3(i.endMeasureM); if(i.minClearanceM!==null)i.minClearanceM=round3(i.minClearanceM); if(i.maxClearanceM!==null)i.maxClearanceM=round3(i.maxClearanceM); out.push(i); d.interactionIntervals+=1; if(i.status==="cutting"||i.status==="tunnel")d.excavationIntervals+=1; } }
function resolveDtm(e){for(const n of ["sampleDtmLocal","sampleGroundLocal","sampleTerrainLocal","sampleLocal"])if(typeof e?.[n]==="function")return e[n].bind(e);return null;}
function compactResult(r){return{rideId:r.rideId,status:r.status,intervals:(r.intervals||[]).map(i=>({status:i.status,startMeasureM:i.startMeasureM,endMeasureM:i.endMeasureM,minClearanceM:i.minClearanceM,maxClearanceM:i.maxClearanceM})),excavationIntervals:(r.excavationIntervals||[]).length};}
function unresolved(node,reason){return{marker:"TPMAP_PHASE34_RIDE_TERRAIN_INTERACTION_V1",rideId:node.id,status:"unresolved",reason,thresholds:null,samples:[],intervals:[],excavationIntervals:[],osmDerived:false,policy:"planning-3d-ride-vs-independent-dtm-no-unresolved-extrapolation"};}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;} function round3(v){return Math.round(Number(v)*1000)/1000;}
