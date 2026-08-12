// TPMAP_PHASE34_BUILDING_ROOF_RECONSTRUCTION_V1
// Footprint-aware building vertical/roof reconstruction from planning geometry + DTM/DSM.

const DEFAULT_GRID_STEP_M = 2;
const MAX_GRID_SAMPLES = 256;
const FLAT_RELIEF_M = 0.6;
const PITCHED_RELIEF_M = 1.5;
const VERTICAL_EPSILON_M = 0.05;

export function reconstructBuildingRoofs(graph, sources = null, options = {}) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error("Phase 34 building roof reconstruction requires reconstruction graph");
  const elevation = sources?.elevation || sources?.lidar || null;
  const samplers = resolveSamplers(elevation);
  const diagnostics = {
    marker: "TPMAP_PHASE34_BUILDING_ROOF_RECONSTRUCTION_V1",
    buildingsVisited: 0,
    buildingsResolved: 0,
    buildingsPartial: 0,
    buildingsUnresolved: 0,
    footprintSamples: 0,
    dtmSamples: 0,
    dsmSamples: 0,
    rejectedPlanningTops: 0,
    flatRoofs: 0,
    pitchedRoofs: 0,
    complexRoofs: 0,
    unresolvedRoofs: 0
  };
  const compact = [];

  for (const node of graph.nodes) {
    if (node.type !== "building") continue;
    diagnostics.buildingsVisited += 1;
    const result = solveBuilding(node, samplers, options, diagnostics);
    Object.defineProperty(node, "buildingReconstruction", { enumerable: false, configurable: true, value: result });
    compact.push(compactBuilding(result));
    if (result.status === "resolved") diagnostics.buildingsResolved += 1;
    else if (result.status === "partial") diagnostics.buildingsPartial += 1;
    else diagnostics.buildingsUnresolved += 1;
    if (result.roof?.form === "flat") diagnostics.flatRoofs += 1;
    else if (["pitched", "shed"].includes(result.roof?.form)) diagnostics.pitchedRoofs += 1;
    else if (result.roof?.form === "complex") diagnostics.complexRoofs += 1;
    else diagnostics.unresolvedRoofs += 1;
  }

  graph.buildingReconstructions = compact;
  graph.summary = { ...(graph.summary || {}), buildingRoofReconstruction: diagnostics };
  return diagnostics;
}

export function validateBuildingReconstructions(graph) {
  const diag = graph?.summary?.buildingRoofReconstruction;
  if (!diag || diag.marker !== "TPMAP_PHASE34_BUILDING_ROOF_RECONSTRUCTION_V1") throw new Error("Phase 34 building roof diagnostics missing");
  for (const node of graph.nodes || []) {
    if (node.type !== "building") continue;
    const b = node.buildingReconstruction;
    if (!b) throw new Error(`Phase 34 building ${node.id} lacks reconstruction state`);
    if (b.status === "resolved") {
      if (!Number.isFinite(b.baseElevationM) || !Number.isFinite(b.topElevationM)) throw new Error(`Phase 34 building ${node.id} invalid resolved elevations`);
      if (b.topElevationM + VERTICAL_EPSILON_M < b.baseElevationM) throw new Error(`Phase 34 building ${node.id} top below base`);
    }
    if (b.roof?.ridgeDirectionDeg !== null && !Number.isFinite(b.roof.ridgeDirectionDeg)) throw new Error(`Phase 34 building ${node.id} invalid ridge direction`);
    if (b.osmDerived) throw new Error(`Phase 34 building ${node.id} used OSM-derived geometry`);
  }
  return graph;
}

function solveBuilding(node, samplers, options, diagnostics) {
  if (node.authority?.osmDerived) throw new Error(`Phase 34 building roof rejected OSM-derived building ${node.id}`);
  const polygon = asPolygon(node.geometry?.local);
  if (!polygon) return unresolved(node, "missing-building-footprint");
  const step = clamp(options.buildingSurfaceSampleStepM, DEFAULT_GRID_STEP_M, 0.5, 8);
  const samplePoints = footprintSamplePoints(polygon, step, MAX_GRID_SAMPLES);
  diagnostics.footprintSamples += samplePoints.length;

  const dtm = [], dsm = [];
  for (const p of samplePoints) {
    const ground = samplers.dtm ? finite(samplers.dtm(p[0], p[1])) : null;
    const top = samplers.dsm ? finite(samplers.dsm(p[0], p[1])) : null;
    if (ground !== null) { dtm.push({ x: p[0], z: p[1], y: ground }); diagnostics.dtmSamples += 1; }
    if (top !== null) { dsm.push({ x: p[0], z: p[1], y: top }); diagnostics.dsmSamples += 1; }
  }

  const planningBase = finite(node.vertical?.baseElevationM);
  const planningTop = finite(node.vertical?.topElevationM);
  const base = planningBase ?? robustMedian(dtm.map((s) => s.y)) ?? finite(node.terrainSurface?.dtmElevationM);
  const dsmTop = percentile(dsm.map((s) => s.y), 0.9) ?? finite(node.terrainSurface?.dsmElevationM);
  const planningTopRejected = planningTop !== null && base !== null && planningTop + VERTICAL_EPSILON_M < base;
  if (planningTopRejected) diagnostics.rejectedPlanningTops += 1;
  const top = planningTopRejected ? dsmTop : (planningTop ?? dsmTop);
  const roof = inferRoof(dsm, node, options);

  const status = base !== null && top !== null ? "resolved" : (base !== null || top !== null || roof.form !== "unresolved" ? "partial" : "unresolved");
  return {
    marker: "TPMAP_PHASE34_BUILDING_ROOF_RECONSTRUCTION_V1",
    buildingId: node.id,
    status,
    reason: status === "unresolved" ? "insufficient-vertical-evidence" : null,
    baseElevationM: base === null ? null : round3(base),
    topElevationM: top === null ? null : round3(top),
    heightM: base !== null && top !== null ? round3(Math.max(0, top - base)) : null,
    footprintSampleCount: samplePoints.length,
    dtmSampleCount: dtm.length,
    dsmSampleCount: dsm.length,
    roof,
    authority: {
      footprint: node.authority?.geometry || null,
      base: planningBase !== null ? "planning-vertical" : dtm.length ? samplers.dtmSource : "unresolved",
      top: !planningTopRejected && planningTop !== null ? "planning-vertical" : dsm.length ? samplers.dsmSource : "unresolved"
    },
    rejectedVerticalEvidence: planningTopRejected ? {
      property: "topElevationM",
      valueM: round3(planningTop),
      reason: "planning-top-below-resolved-base"
    } : null,
    osmDerived: false,
    policy: "planning-footprint-plus-footprint-aware-dtm-dsm-no-generic-extrusion"
  };
}

function inferRoof(samples, node, options) {
  if (samples.length < 4) return { form: "unresolved", reason: "insufficient-dsm-samples", eaveElevationM: null, ridgeElevationM: null, reliefM: null, ridgeDirectionDeg: null, confidence: 0 };
  const ys = samples.map((s) => s.y);
  const low = percentile(ys, 0.2), high = percentile(ys, 0.9), median = robustMedian(ys);
  const relief = high !== null && low !== null ? high - low : null;
  if (relief === null) return { form: "unresolved", reason: "invalid-dsm", eaveElevationM: null, ridgeElevationM: null, reliefM: null, ridgeDirectionDeg: null, confidence: 0 };
  if (relief <= (finite(options.buildingFlatRoofReliefM) ?? FLAT_RELIEF_M)) {
    return { form: "flat", reason: null, eaveElevationM: round3(median), ridgeElevationM: round3(median), reliefM: round3(relief), ridgeDirectionDeg: null, confidence: confidenceFromSamples(samples.length, relief, "flat") };
  }
  const plane = fitPlane(samples);
  const direction = plane ? normalToRiseDirectionDeg(plane.a, plane.b) : null;
  const pitchedThreshold = finite(options.buildingPitchedRoofReliefM) ?? PITCHED_RELIEF_M;
  const form = relief >= pitchedThreshold && plane && plane.r2 >= 0.55 ? "shed" : relief >= pitchedThreshold ? "pitched" : "complex";
  return {
    form,
    reason: null,
    eaveElevationM: round3(low),
    ridgeElevationM: round3(high),
    reliefM: round3(relief),
    ridgeDirectionDeg: direction,
    planeR2: plane ? round3(plane.r2) : null,
    confidence: confidenceFromSamples(samples.length, relief, form)
  };
}

function fitPlane(samples) {
  const n = samples.length;
  let sx=0, sz=0, sy=0, sxx=0, szz=0, sxz=0, sxy=0, szy=0;
  for (const p of samples) { sx+=p.x; sz+=p.z; sy+=p.y; sxx+=p.x*p.x; szz+=p.z*p.z; sxz+=p.x*p.z; sxy+=p.x*p.y; szy+=p.z*p.y; }
  const A = [[sxx,sxz,sx],[sxz,szz,sz],[sx,sz,n]], B=[sxy,szy,sy];
  const sol = solve3(A,B); if (!sol) return null;
  const [a,b,c]=sol, mean=sy/n;
  let ssTot=0, ssRes=0;
  for (const p of samples) { const pred=a*p.x+b*p.z+c; ssTot+=(p.y-mean)**2; ssRes+=(p.y-pred)**2; }
  return { a,b,c,r2:ssTot>1e-9?Math.max(0,1-ssRes/ssTot):1 };
}

function solve3(A,B) {
  const m=A.map((r,i)=>[...r,B[i]]);
  for(let c=0;c<3;c++){ let p=c; for(let r=c+1;r<3;r++) if(Math.abs(m[r][c])>Math.abs(m[p][c])) p=r; if(Math.abs(m[p][c])<1e-9) return null; [m[c],m[p]]=[m[p],m[c]]; const d=m[c][c]; for(let k=c;k<4;k++)m[c][k]/=d; for(let r=0;r<3;r++){ if(r===c)continue; const f=m[r][c]; for(let k=c;k<4;k++)m[r][k]-=f*m[c][k]; }}
  return [m[0][3],m[1][3],m[2][3]];
}

function footprintSamplePoints(poly, step, cap) {
  const ring=poly[0]; if (!Array.isArray(ring) || ring.length<4) return [];
  const xs=ring.map(p=>Number(p[0])).filter(Number.isFinite), zs=ring.map(p=>Number(p[1])).filter(Number.isFinite); if(!xs.length||!zs.length)return[];
  const minX=Math.min(...xs), maxX=Math.max(...xs), minZ=Math.min(...zs), maxZ=Math.max(...zs); const out=[];
  const centroid=[xs.reduce((a,b)=>a+b,0)/xs.length,zs.reduce((a,b)=>a+b,0)/zs.length]; if(pointInPolygon(centroid,ring))out.push(centroid);
  for(let x=minX+step/2;x<=maxX;x+=step){ for(let z=minZ+step/2;z<=maxZ;z+=step){ if(out.length>=cap) return out; if(pointInPolygon([x,z],ring))out.push([x,z]); }}
  return out;
}
function pointInPolygon(p, ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const xi=Number(ring[i][0]),zi=Number(ring[i][1]),xj=Number(ring[j][0]),zj=Number(ring[j][1]);const hit=((zi>p[1])!==(zj>p[1]))&&(p[0]<(xj-xi)*(p[1]-zi)/(zj-zi+1e-12)+xi);if(hit)inside=!inside;}return inside;}
function asPolygon(g){ if(!g)return null; if(g.type==="Polygon")return g.coordinates; if(g.type==="MultiPolygon")return g.coordinates?.[0]||null; return null; }
function resolveSamplers(e){const bind=n=>typeof e?.[n]==="function"?e[n].bind(e):null;return{dtm:bind("sampleDtmLocal")||bind("sampleGroundLocal")||bind("sampleTerrainLocal")||bind("sampleLocal"),dsm:bind("sampleDsmLocal")||bind("sampleSurfaceLocal")||bind("sampleObjectTopLocal"),dtmSource:e?.dtmSourceKind||e?.groundSourceKind||e?.sourceKind||"terrain-elevation-sampler",dsmSource:e?.dsmSourceKind||e?.surfaceSourceKind||"lidar-dsm"};}
function percentile(a,p){const v=a.filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return null;const i=(v.length-1)*p,l=Math.floor(i),h=Math.ceil(i);return v[l]+(v[h]-v[l])*(i-l);}
function robustMedian(a){return percentile(a,0.5);}
function confidenceFromSamples(n,relief,form){let c=Math.min(0.98,0.55+Math.min(n,64)/160);if(form==="complex")c-=0.12;if(relief<0.15)c-=0.05;return round3(Math.max(0.3,c));}
function normalToRiseDirectionDeg(a,b){const deg=Math.atan2(b,a)*180/Math.PI;return round3((deg+360)%360);}
function compactBuilding(b){return{buildingId:b.buildingId,status:b.status,baseElevationM:b.baseElevationM,topElevationM:b.topElevationM,heightM:b.heightM,roof:b.roof,footprintSampleCount:b.footprintSampleCount,dtmSampleCount:b.dtmSampleCount,dsmSampleCount:b.dsmSampleCount};}
function unresolved(node,reason){return{marker:"TPMAP_PHASE34_BUILDING_ROOF_RECONSTRUCTION_V1",buildingId:node.id,status:"unresolved",reason,baseElevationM:null,topElevationM:null,heightM:null,footprintSampleCount:0,dtmSampleCount:0,dsmSampleCount:0,roof:{form:"unresolved",reason,eaveElevationM:null,ridgeElevationM:null,reliefM:null,ridgeDirectionDeg:null,confidence:0},authority:{footprint:node.authority?.geometry||null,base:"unresolved",top:"unresolved"},rejectedVerticalEvidence:null,osmDerived:false,policy:"planning-footprint-plus-footprint-aware-dtm-dsm-no-generic-extrusion"};}
function finite(v){if(v===undefined||v===null||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null;} function round3(v){return Math.round(Number(v)*1000)/1000;} function clamp(v,f,min,max){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):f;}