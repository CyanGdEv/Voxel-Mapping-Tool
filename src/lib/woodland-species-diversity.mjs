const DEFAULT_RADIUS_M = 24;

export function resolveLocalSpeciesDiversity({ x, z, parent, speciesSources = [], mappedTrees = [], radiusM = DEFAULT_RADIUS_M, seedKey = "" }) {
  const direct = directSpeciesAt(x, z, speciesSources);
  if (direct) return { ...direct, distribution: [{ ...identity(direct), weight: 1 }], diversitySource: "direct-species-evidence" };

  const candidates = [];
  for (const feature of speciesSources) {
    const evidence = speciesFrom(feature);
    if (!evidence) continue;
    const geometry = feature.localGeometry || feature.geometry;
    let distanceM = 0;
    if (geometry?.type === "Point") {
      const point = pointOf(geometry);
      if (!point) continue;
      distanceM = Math.hypot(point[0] - x, point[1] - z);
      if (distanceM > radiusM) continue;
    } else if (geometry?.type === "Polygon" || geometry?.type === "MultiPolygon") {
      if (!pointInGeometry(x, z, geometry)) continue;
    } else continue;
    candidates.push(weighted(evidence, 1.35 * distanceWeight(distanceM, radiusM), "tree-species-map-local-pool"));
  }

  for (const feature of mappedTrees) {
    const evidence = speciesFrom(feature);
    const point = pointOf(feature.localGeometry);
    if (!evidence || !point) continue;
    const distanceM = Math.hypot(point[0] - x, point[1] - z);
    if (distanceM > radiusM) continue;
    candidates.push(weighted(evidence, distanceWeight(distanceM, radiusM), "nearby-classified-tree-pool"));
  }

  const parentEvidence = speciesFrom(parent);
  if (parentEvidence) candidates.push(weighted(parentEvidence, 0.75, "parent-woodland-composition"));
  else {
    const morphology = morphologyFromParent(parent);
    if (morphology) candidates.push(weighted(morphology, 0.25, "parent-woodland-morphology"));
  }

  const distribution = collapseDistribution(candidates);
  if (!distribution.length) return null;
  if (distribution.length === 1) {
    const only = distribution[0];
    return { ...only, source: only.sources[0] || "local-species-pool", confidence: confidenceFor(only, distribution), distribution, diversitySource: "local-weighted-composition" };
  }

  const selected = deterministicPick(distribution, `${seedKey}|${round1(x)}|${round1(z)}`);
  return {
    species: selected.species || null,
    genus: selected.genus || null,
    leafType: selected.leafType || null,
    source: "local-weighted-species-diversity",
    confidence: confidenceFor(selected, distribution),
    distribution,
    diversitySource: "local-weighted-composition"
  };
}

export function collapseSpeciesDistribution(entries = []) {
  return collapseDistribution(entries);
}

function directSpeciesAt(x, z, sources) {
  const matches = [];
  for (const feature of sources) {
    const evidence = speciesFrom(feature);
    if (!evidence) continue;
    const geometry = feature.localGeometry || feature.geometry;
    if (geometry?.type === "Point") {
      const p = pointOf(geometry); if (!p) continue;
      const d = Math.hypot(p[0] - x, p[1] - z);
      if (d <= 4) matches.push({ ...evidence, distanceM: d, source: "tree-species-map" });
    } else if ((geometry?.type === "Polygon" || geometry?.type === "MultiPolygon") && pointInGeometry(x, z, geometry)) {
      matches.push({ ...evidence, distanceM: 0, source: "tree-species-map" });
    }
  }
  return matches.sort((a,b) => a.distanceM - b.distanceM)[0] || null;
}

function weighted(evidence, weight, source) { return { ...evidence, weight: Math.max(0, Number(weight) || 0), source }; }
function distanceWeight(distanceM, radiusM) { const t = Math.max(0, 1 - distanceM / Math.max(1, radiusM)); return 0.15 + t * t * 0.85; }

function collapseDistribution(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry || !(entry.weight > 0)) continue;
    const key = speciesKey(entry);
    if (!key) continue;
    const current = map.get(key) || { ...identity(entry), weight: 0, sources: [] };
    current.weight += entry.weight;
    if (entry.source && !current.sources.includes(entry.source)) current.sources.push(entry.source);
    map.set(key, current);
  }
  const total = [...map.values()].reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0)) return [];
  return [...map.values()].map(item => ({ ...item, weight: item.weight / total })).sort((a,b) => b.weight - a.weight || speciesKey(a).localeCompare(speciesKey(b)));
}

function deterministicPick(distribution, key) {
  const r = hashUnit(key);
  let acc = 0;
  for (const item of distribution) { acc += item.weight; if (r <= acc + 1e-12) return item; }
  return distribution[distribution.length - 1];
}
function hashUnit(text) { let h = 2166136261 >>> 0; for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
function confidenceFor(selected, distribution) { const dominance = selected?.weight || 0; const evidenceMass = Math.min(1, distribution.length / 4); return round3(Math.min(0.93, 0.52 + dominance * 0.28 + evidenceMass * 0.12)); }
function identity(v) { return { species: v.species || null, genus: v.genus || null, leafType: v.leafType || null }; }
function speciesKey(v) { return String(v?.species || v?.genus || v?.leafType || "").toLowerCase().trim(); }

function speciesFrom(value) {
  const tags = value?.tags || value?.properties || value?.attributes || value || {};
  const species = firstText(tags.species, tags.tree_species, tags.common_name, tags.commonName, tags.species_name, tags.speciesName, tags.scientific_name, tags.scientificName, tags.binomial);
  const genus = firstText(tags.genus, species?.split?.(/\s+/)?.[0]);
  const leafType = normalizeLeafType(firstText(tags.leaf_type, tags.leafType, tags.foliage, tags.woodland_type, tags.woodlandType)) || inferLeafType(species || genus);
  if (!species && !genus && !leafType) return null;
  return { species: species || null, genus: genus || null, leafType: leafType || null };
}
function morphologyFromParent(parent) {
  const tags = parent?.tags || {};
  const text = [parent?.subtype, tags.leaf_type, tags.leafType, tags.woodland, tags.woodland_type, tags.forest_type, tags.trees].filter(Boolean).join(" ").toLowerCase();
  if (/conifer|needle|spruce|pine|fir|cedar|evergreen/.test(text)) return { species: null, genus: null, leafType: "needleleaved" };
  if (/broad|deciduous|oak|beech|birch|ash|maple|sycamore|lime/.test(text)) return { species: null, genus: null, leafType: "broadleaved" };
  return null;
}
function normalizeLeafType(value) { const t=String(value||"").toLowerCase(); if (/needle|conifer|evergreen/.test(t)) return "needleleaved"; if (/broad|deciduous/.test(t)) return "broadleaved"; return null; }
function inferLeafType(value) { const t=String(value||"").toLowerCase(); if (/spruce|pine|fir|cedar|larch|yew|picea|pinus|abies|cedrus|larix|taxus/.test(t)) return "needleleaved"; if (/oak|beech|birch|ash|maple|sycamore|willow|lime|alder|poplar|quercus|fagus|betula|fraxinus|acer|salix|tilia|alnus|populus/.test(t)) return "broadleaved"; return null; }
function firstText(...values) { for (const v of values) if (typeof v === "string" && v.trim()) return v.trim(); return null; }
function pointOf(g) { if (g?.type !== "Point") return null; const x=Number(g.coordinates?.[0]), z=Number(g.coordinates?.[1]); return Number.isFinite(x)&&Number.isFinite(z)?[x,z]:null; }
function pointInGeometry(x,z,g){ if(g?.type==="Polygon")return pointInPolygon(x,z,g.coordinates); if(g?.type==="MultiPolygon")return g.coordinates.some(p=>pointInPolygon(x,z,p)); return false; }
function pointInPolygon(x,z,rings){ if(!rings?.length||!pointInRing(x,z,rings[0]))return false; for(let i=1;i<rings.length;i++)if(pointInRing(x,z,rings[i]))return false; return true; }
function pointInRing(x,z,ring){ let inside=false; for(let i=0,j=ring.length-1;i<ring.length;j=i++){ const xi=Number(ring[i]?.[0]),zi=Number(ring[i]?.[1]),xj=Number(ring[j]?.[0]),zj=Number(ring[j]?.[1]); if(![xi,zi,xj,zj].every(Number.isFinite))continue; if(((zi>z)!==(zj>z))&&(x<(xj-xi)*(z-zi)/((zj-zi)||1e-12)+xi))inside=!inside; } return inside; }
function round1(v){ return Math.round(Number(v)*10)/10; }
function round3(v){ return Math.round(Number(v)*1000)/1000; }
