// TPMAP_PHASE34_VEGETATION_RECONSTRUCTION_V1
// Evidence-bounded vegetation digital twin from planning geometry plus separated DTM/DSM.

const DEFAULT_SAMPLE_STEP_M = 2;
const MAX_SAMPLES = 256;

export function reconstructVegetation(graph, sources = null, options = {}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error("Phase 34 vegetation reconstruction requires reconstruction graph");
  const elevation = sources?.elevation || sources?.lidar || null;
  const samplers = resolveSamplers(elevation);
  const diagnostics = {
    marker: "TPMAP_PHASE34_VEGETATION_RECONSTRUCTION_V1",
    vegetationVisited: 0,
    resolved: 0,
    partial: 0,
    unresolved: 0,
    individualTrees: 0,
    canopyGroups: 0,
    woodland: 0,
    dtmSamples: 0,
    dsmSamples: 0
  };
  const compact = [];

  for (const node of graph.nodes) {
    if (node.type !== "vegetation") continue;
    diagnostics.vegetationVisited += 1;
    const result = solve(node, samplers, options, diagnostics);
    Object.defineProperty(node, "vegetationReconstruction", { enumerable: false, configurable: true, value: result });
    compact.push(compactResult(result));
    if (result.status === "resolved") diagnostics.resolved += 1;
    else if (result.status === "partial") diagnostics.partial += 1;
    else diagnostics.unresolved += 1;
    if (result.classification === "individual-tree") diagnostics.individualTrees += 1;
    else if (result.classification === "woodland") diagnostics.woodland += 1;
    else if (result.classification === "canopy-group") diagnostics.canopyGroups += 1;
  }

  graph.vegetationReconstructions = compact;
  graph.summary = { ...(graph.summary || {}), vegetationReconstruction: diagnostics };
  return diagnostics;
}

export function validateVegetationReconstructions(graph) {
  const d = graph?.summary?.vegetationReconstruction;
  if (!d || d.marker !== "TPMAP_PHASE34_VEGETATION_RECONSTRUCTION_V1") throw new Error("Phase 34 vegetation diagnostics missing");
  for (const node of graph.nodes || []) {
    if (node.type !== "vegetation") continue;
    const v = node.vegetationReconstruction;
    if (!v) throw new Error(`Phase 34 vegetation ${node.id} missing reconstruction state`);
    if (v.status === "resolved") {
      if (!Number.isFinite(v.groundElevationM) || !Number.isFinite(v.canopyTopElevationM) || !Number.isFinite(v.heightM)) throw new Error(`Phase 34 vegetation ${node.id} invalid resolved verticals`);
      if (v.heightM < 0) throw new Error(`Phase 34 vegetation ${node.id} negative height`);
    }
    if (v.osmDerived) throw new Error(`Phase 34 vegetation ${node.id} used OSM-derived geometry`);
  }
  return graph;
}

function solve(node, samplers, options, diagnostics) {
  if (node.authority?.osmDerived) throw new Error(`Phase 34 vegetation reconstruction rejected OSM-derived node ${node.id}`);
  const geom = node.geometry?.local;
  const sampleStepM = clamp(options.vegetationSampleStepM, DEFAULT_SAMPLE_STEP_M, 0.5, 8);
  const points = sampleGeometry(geom, sampleStepM, MAX_SAMPLES);
  const dtm = [], dsm = [];
  for (const [x,z] of points) {
    const g = samplers.dtm ? finite(samplers.dtm(x,z)) : null;
    const t = samplers.dsm ? finite(samplers.dsm(x,z)) : null;
    if (g !== null) { dtm.push(g); diagnostics.dtmSamples += 1; }
    if (t !== null) { dsm.push(t); diagnostics.dsmSamples += 1; }
  }

  const planningHeight = explicitHeight(node);
  const ground = median(dtm) ?? finite(node.terrainSurface?.dtmElevationM) ?? finite(node.vertical?.groundElevationM);
  const canopyTop = percentile(dsm, 0.9) ?? finite(node.terrainSurface?.dsmElevationM) ?? (ground !== null && planningHeight !== null ? ground + planningHeight : null);
  const height = planningHeight ?? (ground !== null && canopyTop !== null ? Math.max(0, canopyTop - ground) : null);
  const crown = crownMetrics(geom, node);
  const classification = classify(node, crown, height);
  const status = ground !== null && canopyTop !== null && height !== null ? "resolved" : (ground !== null || canopyTop !== null || crown.areaM2 !== null ? "partial" : "unresolved");

  return {
    marker: "TPMAP_PHASE34_VEGETATION_RECONSTRUCTION_V1",
    vegetationId: node.id,
    status,
    classification,
    groundElevationM: ground === null ? null : round3(ground),
    canopyTopElevationM: canopyTop === null ? null : round3(canopyTop),
    heightM: height === null ? null : round3(height),
    crownAreaM2: crown.areaM2,
    crownDiameterM: crown.diameterM,
    crownVolumeM3: crown.areaM2 !== null && height !== null ? round3(crown.areaM2 * Math.max(0, height) * 0.55) : null,
    sampleCount: points.length,
    dtmSampleCount: dtm.length,
    dsmSampleCount: dsm.length,
    authority: {
      geometry: node.authority?.geometry || null,
      height: planningHeight !== null ? "planning-vertical" : dsm.length ? samplers.dsmSource : "unresolved",
      ground: dtm.length ? samplers.dtmSource : ground !== null ? "existing-ground" : "unresolved"
    },
    osmDerived: false,
    policy: "planning-vegetation-geometry-plus-dtm-dsm-no-species-fabrication"
  };
}

function classify(node, crown, height) {
  const tags = node.sourceFeature?.tags || {};
  const semantic = String(node.semantics?.planningClass || tags.vegetation || tags.natural || "").toLowerCase();
  if (semantic.includes("woodland") || semantic.includes("wood")) return "woodland";
  if (semantic.includes("tree") && crown.areaM2 !== null && crown.areaM2 <= 180) return "individual-tree";
  if (node.geometry?.local?.type === "Point") return "individual-tree";
  if (crown.areaM2 !== null && crown.areaM2 <= 180 && (height ?? 0) >= 3) return "individual-tree";
  return "canopy-group";
}

function explicitHeight(node) {
  const s = node.sourceFeature || {}, tags = s.tags || {};
  for (const v of [s.vertical?.heightM, tags.height_m, tags.tree_height_m, tags.canopy_height_m, node.vertical?.heightM]) {
    const n = finite(v); if (n !== null) return n;
  }
  return null;
}

function crownMetrics(g, node) {
  if (!g) return { areaM2: null, diameterM: null };
  if (g.type === "Point") {
    const tags = node.sourceFeature?.tags || {};
    const d = finite(tags.crown_diameter_m) ?? finite(tags.crown_width_m);
    return { areaM2: d !== null ? round3(Math.PI*(d/2)**2) : null, diameterM: d === null ? null : round3(d) };
  }
  const ring = g.type === "Polygon" ? g.coordinates?.[0] : g.type === "MultiPolygon" ? g.coordinates?.[0]?.[0] : null;
  if (!Array.isArray(ring) || ring.length < 4) return { areaM2: null, diameterM: null };
  const area = Math.abs(polygonArea(ring));
  return { areaM2: round3(area), diameterM: area > 0 ? round3(2*Math.sqrt(area/Math.PI)) : null };
}

function sampleGeometry(g, step, cap) {
  if (!g) return [];
  if (g.type === "Point") return [[+g.coordinates[0], +g.coordinates[1]]];
  const ring = g.type === "Polygon" ? g.coordinates?.[0] : g.type === "MultiPolygon" ? g.coordinates?.[0]?.[0] : null;
  if (!Array.isArray(ring) || ring.length < 4) return [];
  const xs=ring.map(p=>+p[0]), zs=ring.map(p=>+p[1]); const minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs); const out=[];
  for(let x=minX+step/2;x<=maxX;x+=step) for(let z=minZ+step/2;z<=maxZ;z+=step){ if(out.length>=cap) return out; if(pointInPolygon([x,z],ring)) out.push([x,z]); }
  if (!out.length) out.push([xs.reduce((a,b)=>a+b,0)/xs.length,zs.reduce((a,b)=>a+b,0)/zs.length]);
  return out;
}
function pointInPolygon(p,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const xi=+ring[i][0],zi=+ring[i][1],xj=+ring[j][0],zj=+ring[j][1];if(((zi>p[1])!==(zj>p[1]))&&(p[0]<(xj-xi)*(p[1]-zi)/(zj-zi+1e-12)+xi))inside=!inside;}return inside;}
function polygonArea(r){let a=0;for(let i=0,j=r.length-1;i<r.length;j=i++)a+=(+r[j][0])*(+r[i][1])-(+r[i][0])*(+r[j][1]);return a/2;}
function resolveSamplers(e){const bind=n=>typeof e?.[n]==="function"?e[n].bind(e):null;return{dtm:bind("sampleDtmLocal")||bind("sampleGroundLocal")||bind("sampleTerrainLocal")||bind("sampleLocal"),dsm:bind("sampleDsmLocal")||bind("sampleSurfaceLocal")||bind("sampleObjectTopLocal"),dtmSource:e?.dtmSourceKind||e?.groundSourceKind||e?.sourceKind||"terrain-elevation-sampler",dsmSource:e?.dsmSourceKind||e?.surfaceSourceKind||"lidar-dsm"};}
function percentile(a,p){const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const i=(v.length-1)*p,l=Math.floor(i),h=Math.ceil(i);return v[l]+(v[h]-v[l])*(i-l);} function median(a){return percentile(a,0.5);}
function compactResult(v){return{vegetationId:v.vegetationId,status:v.status,classification:v.classification,groundElevationM:v.groundElevationM,canopyTopElevationM:v.canopyTopElevationM,heightM:v.heightM,crownAreaM2:v.crownAreaM2,crownDiameterM:v.crownDiameterM,crownVolumeM3:v.crownVolumeM3};}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}function round3(v){return Math.round(Number(v)*1000)/1000;}function clamp(v,f,min,max){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):f;}
