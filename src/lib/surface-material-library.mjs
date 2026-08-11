// Voxel Mapping Tool surface material library v1.
// Exact percentages supplied for the theme-park generator; deterministic at 1 block = 1 metre.

const RAW = [
["weathered_asphalt","Weathered asphalt","fine_noise",[["gray_wool",45],["gray_concrete",30],["light_gray_concrete",15],["andesite",10]]],
["fresh_black_asphalt","Fresh black asphalt","fine_noise",[["black_concrete",55],["black_wool",25],["gray_concrete",15],["smooth_basalt",5]]],
["light_asphalt","Light asphalt","fine_noise",[["light_gray_concrete",45],["gray_wool",30],["andesite",15],["stone",10]]],
["red_tarmac","Red tarmac","fine_noise",[["red_concrete",55],["red_terracotta",25],["brick_block",10],["brown_terracotta",10]]],
["resin_bound_beige","Resin-bound beige","speckled",[["smooth_sandstone",40],["sandstone",25],["birch_planks",10],["packed_mud",10],["calcite",15]]],
["resin_bound_grey","Resin-bound grey","speckled",[["andesite",35],["light_gray_concrete",30],["stone",20],["polished_andesite",10],["gray_concrete",5]]],
["concrete_path","Concrete path","large_subtle_patches",[["light_gray_concrete",50],["smooth_stone",25],["stone",15],["andesite",10]]],
["old_concrete","Old concrete","patchy_weathered",[["smooth_stone",30],["light_gray_concrete",25],["stone",20],["andesite",15],["moss_block",5],["gravel",5]]],
["grey_block_paving","Grey block paving","repeating_paving_grid",[["stone_bricks",40],["andesite",25],["polished_andesite",15],["smooth_stone",10],["cracked_stone_bricks",10]]],
["red_block_paving","Red block paving","repeating_paving_grid",[["bricks",45],["red_terracotta",25],["granite",15],["polished_granite",10],["packed_mud",5]]],
["buff_paving","Buff paving","slab_grid",[["smooth_sandstone",35],["sandstone",30],["cut_sandstone",20],["birch_planks",5],["calcite",10]]],
["cobblestone","Cobblestone","irregular_clusters",[["cobblestone",55],["mossy_cobblestone",15],["andesite",10],["stone",10],["gravel",10]]],
["old_stone_paving","Old stone paving","larger_irregular_slabs",[["stone_bricks",30],["stone",25],["andesite",15],["cracked_stone_bricks",10],["mossy_stone_bricks",10],["cobblestone",10]]],
["gravel_path","Gravel path","dense_granular_noise",[["gravel",55],["andesite",15],["coarse_dirt",15],["stone",10],["tuff",5]]],
["hoggin_path","Hoggin path","fine_mottling",[["packed_mud",35],["coarse_dirt",25],["gravel",20],["brown_terracotta",10],["sand",10]]],
["dirt_trail","Dirt trail","directional_worn_patches",[["coarse_dirt",40],["dirt",30],["rooted_dirt",15],["packed_mud",10],["gravel",5]]],
["woodland_floor","Woodland floor","organic_clusters",[["podzol",35],["dirt",20],["coarse_dirt",15],["rooted_dirt",15],["moss_block",10],["brown_wool",5]]],
["mulch_planting_bed","Mulch / planting bed","organic_clusters",[["podzol",40],["brown_wool",20],["coarse_dirt",20],["rooted_dirt",10],["packed_mud",10]]],
["healthy_lawn","Healthy lawn","very_large_soft_patches",[["grass_block",70],["moss_block",20],["green_wool",5],["lime_terracotta",5]]],
["worn_grass","Worn grass","edge_biased_wear",[["grass_block",50],["moss_block",15],["dirt",15],["coarse_dirt",15],["rooted_dirt",5]]],
["boardwalk","Boardwalk","directional_strips",[["spruce_planks",55],["dark_oak_planks",20],["oak_planks",15],["stripped_spruce_wood",10]]],
["weathered_timber","Weathered timber","directional_strips",[["spruce_planks",35],["dark_oak_planks",25],["stripped_spruce_wood",20],["brown_terracotta",10],["mangrove_planks",10]]],
["sand_beach","Sand / beach","soft_noise",[["sand",65],["smooth_sandstone",15],["sandstone",10],["gravel",5],["calcite",5]]],
["natural_rock","Natural rock","large_clustered_blobs",[["stone",30],["andesite",20],["tuff",20],["cobblestone",10],["mossy_cobblestone",10],["gravel",10]]],
["dark_rockwork","Dark rockwork","large_irregular_blobs",[["tuff",30],["cobbled_deepslate",25],["deepslate",20],["blackstone",10],["andesite",10],["mossy_cobblestone",5]]],
["artificial_themed_rock","Artificial themed rock","layered_patches",[["tuff",35],["stone",25],["andesite",15],["packed_mud",10],["brown_terracotta",10],["mossy_cobblestone",5]]],
["old_brick_wall","Old brick wall","clustered_weathering",[["bricks",45],["terracotta",20],["mud_bricks",15],["cracked_stone_bricks",10],["mossy_stone_bricks",10]]],
["sandstone_wall","Sandstone wall","horizontal_courses",[["sandstone",40],["cut_sandstone",25],["smooth_sandstone",20],["calcite",5],["dripstone_block",10]]],
["industrial_service_paving","Industrial/service paving","fine_noise",[["gray_concrete",35],["smooth_stone",25],["stone",20],["andesite",15],["gravel",5]]]
];

const ALIASES = {
"weathered asphalt":"weathered_asphalt","old asphalt":"weathered_asphalt",asphalt:"weathered_asphalt",tarmac:"weathered_asphalt",
"fresh black asphalt":"fresh_black_asphalt","fresh asphalt":"fresh_black_asphalt","black asphalt":"fresh_black_asphalt","new asphalt":"fresh_black_asphalt",
"light asphalt":"light_asphalt","pale asphalt":"light_asphalt","red tarmac":"red_tarmac","red asphalt":"red_tarmac",
"resin bound beige":"resin_bound_beige","beige resin":"resin_bound_beige","resin beige":"resin_bound_beige",
"resin bound grey":"resin_bound_grey","resin bound gray":"resin_bound_grey","grey resin":"resin_bound_grey","gray resin":"resin_bound_grey",
concrete:"concrete_path","concrete path":"concrete_path","old concrete":"old_concrete","weathered concrete":"old_concrete",
"grey block paving":"grey_block_paving","gray block paving":"grey_block_paving","block paving":"grey_block_paving","paving stones":"grey_block_paving","red block paving":"red_block_paving","buff paving":"buff_paving","buff block paving":"buff_paving",
cobblestone:"cobblestone",sett:"cobblestone",setts:"cobblestone","old stone paving":"old_stone_paving","stone paving":"old_stone_paving",
gravel:"gravel_path","gravel path":"gravel_path","fine gravel":"gravel_path",hoggin:"hoggin_path",compacted:"hoggin_path","compacted path":"hoggin_path",
dirt:"dirt_trail",earth:"dirt_trail",ground:"dirt_trail","dirt trail":"dirt_trail","woodland floor":"woodland_floor","forest floor":"woodland_floor",
mulch:"mulch_planting_bed","planting bed":"mulch_planting_bed",flowerbed:"mulch_planting_bed",grass:"healthy_lawn",lawn:"healthy_lawn","healthy lawn":"healthy_lawn","worn grass":"worn_grass",
boardwalk:"boardwalk",timber:"weathered_timber","weathered timber":"weathered_timber",wood:"boardwalk",sand:"sand_beach",beach:"sand_beach","sand beach":"sand_beach",
rock:"natural_rock",stone:"natural_rock","natural rock":"natural_rock","dark rockwork":"dark_rockwork","dark rock":"dark_rockwork","artificial themed rock":"artificial_themed_rock","themed rock":"artificial_themed_rock",rockwork:"artificial_themed_rock",
brick:"old_brick_wall",bricks:"old_brick_wall","old brick wall":"old_brick_wall","sandstone wall":"sandstone_wall","industrial paving":"industrial_service_paving","service paving":"industrial_service_paving","industrial service paving":"industrial_service_paving"
};

const blockId = (value) => {
  let id = String(value || "").trim().toLowerCase().replace(/^minecraft:/, "");
  if (id === "bricks") id = "brick_block";
  if (id === "rooted_dirt") id = "dirt_with_roots";
  return /^[a-z0-9_]+$/.test(id) ? `minecraft:${id}` : null;
};

export const THEMEPARK_SURFACE_MATERIAL_PRESETS = Object.freeze(Object.fromEntries(RAW.map(([id,label,pattern,palette]) => [id, Object.freeze({
  schemaVersion: 1, id, label, pattern,
  palette: Object.freeze(palette.map(([block,percent]) => Object.freeze({ block: blockId(block), weight: percent / 100, percent })))
})])));

export function withThemeParkMaterialHints(style, feature = null) {
  const base = style && typeof style === "object" ? style : {};
  const tags = feature?.tags || {};
  const explicitCandidates = [
    base.materialPreset, base.material_preset, base.preset,
    tags["tpmap:material"], tags["themepark:material"], tags.surface_material,
    tags["surface:material"], feature?.surfaceMaterial, feature?.material
  ];
  // A colour-matched three-block palette is already an observation, so retain
  // it unless planning evidence supplied an explicit material preset. Generic
  // surface tags remain a fallback for source records without such a palette.
  const fallbackCandidates = Array.isArray(base.paletteBlocks) && base.paletteBlocks.length
    ? []
    : [
        base.material, base.materialClass, base.surface, base.name, base.label,
        base.role, base.appearanceStatus, tags.surface, tags.material
      ];
  const candidates = [...explicitCandidates, ...fallbackCandidates];
  let preset = null;
  for (const hint of candidates) {
    if (!firstText(hint)) continue;
    preset = resolveThemeParkSurfaceMaterial({ ...base, palette: null, materialPreset: hint });
    if (preset) break;
  }
  if (!preset) return base;
  return {
    ...base,
    materialPreset: preset.id,
    materialLabel: preset.label,
    palette: preset.palette,
    pattern: base.pattern || preset.pattern,
    schemaVersion: Math.max(2, Number(base.schemaVersion) || 0)
  };
}

export function resolveThemeParkSurfaceMaterial(style) {
  if (!style || typeof style !== "object") return null;
  if (Array.isArray(style.palette) && style.palette.length) {
    const palette = normalizePalette(style.palette);
    if (palette) return { id: style.materialPreset || "custom_weighted_surface", label: style.materialLabel || style.label || "Custom weighted surface", pattern: normPattern(style.pattern), palette };
  }
  for (const candidate of [style.materialPreset, style.material_preset, style.preset, style.material, style.materialClass, style.surface, style.name, style.label, style.role, style.appearanceStatus]) {
    const id = resolveCandidate(candidate, style);
    if (id && THEMEPARK_SURFACE_MATERIAL_PRESETS[id]) return THEMEPARK_SURFACE_MATERIAL_PRESETS[id];
  }
  return null;
}

export function blockForThemeParkSurfaceStyle(style, x, z, seed = 0) {
  if (!style?.materialPreset && !style?.material_preset && !style?.preset && !Array.isArray(style?.palette)) {
    return null;
  }
  const preset = resolveThemeParkSurfaceMaterial(style);
  if (!preset) return null;
  return weightedBlock(preset.palette, patternRandom(normPattern(preset.pattern || style?.pattern), Number(x)||0, Number(z)||0, seed, preset.id));
}

function resolveCandidate(candidate, style) {
  if (candidate == null) return null;
  const value = norm(candidate); if (!value) return null;
  const exact = value.replace(/ /g,"_"); if (THEMEPARK_SURFACE_MATERIAL_PRESETS[exact]) return exact;
  if (ALIASES[value]) {
    if (value === "asphalt") return asphaltFromColour(style);
    if (value === "block paving" || value === "paving stones") return pavingFromColour(style);
    return ALIASES[value];
  }
  if (value.includes("asphalt") || value.includes("tarmac")) return asphaltFromColour(style,value);
  if (value.includes("resin")) return warm(readRgb(style)) ? "resin_bound_beige" : "resin_bound_grey";
  if (value.includes("paving") || value.includes("paver")) return pavingFromColour(style,value);
  if (value.includes("cobble") || value.includes("sett")) return "cobblestone";
  if (value.includes("gravel")) return "gravel_path";
  if (value.includes("hoggin") || value.includes("compacted")) return "hoggin_path";
  if (value.includes("mulch") || value.includes("planting")) return "mulch_planting_bed";
  if (value.includes("woodland") || value.includes("forest floor")) return "woodland_floor";
  if (value.includes("worn grass")) return "worn_grass";
  if (value.includes("grass") || value.includes("lawn")) return "healthy_lawn";
  if (value.includes("boardwalk")) return "boardwalk";
  if (value.includes("timber")) return "weathered_timber";
  if (value.includes("sandstone") && value.includes("wall")) return "sandstone_wall";
  if (value.includes("brick") && value.includes("wall")) return "old_brick_wall";
  if (value.includes("industrial") || value.includes("service paving")) return "industrial_service_paving";
  if (value.includes("themed rock") || value.includes("artificial rock") || value === "rockwork") return "artificial_themed_rock";
  if (value.includes("dark rock")) return "dark_rockwork";
  if (value.includes("rock")) return "natural_rock";
  if (value.includes("sand") || value.includes("beach")) return "sand_beach";
  if (value.includes("old concrete") || value.includes("weathered concrete")) return "old_concrete";
  if (value.includes("concrete")) return "concrete_path";
  if (value.includes("dirt") || value.includes("earth")) return "dirt_trail";
  return null;
}

function asphaltFromColour(style, value="") {
  if (value.includes("red")) return "red_tarmac";
  if (/(fresh|black|new)/.test(value)) return "fresh_black_asphalt";
  if (/(light|pale)/.test(value)) return "light_asphalt";
  const rgb=readRgb(style); if(!rgb) return "weathered_asphalt";
  const [r,g,b]=rgb; if(r>g*1.22&&r>b*1.18&&r>95) return "red_tarmac";
  const lum=.2126*r+.7152*g+.0722*b; return lum<62?"fresh_black_asphalt":lum>145?"light_asphalt":"weathered_asphalt";
}
function pavingFromColour(style,value="") {
  if(value.includes("red")) return "red_block_paving";
  if(/(buff|beige)/.test(value)) return "buff_paving";
  const rgb=readRgb(style); if(!rgb) return "grey_block_paving";
  const [r,g,b]=rgb; if(r>g*1.18&&r>b*1.25&&r>90) return "red_block_paving";
  return warm(rgb)?"buff_paving":"grey_block_paving";
}
function readRgb(style) {
  for(const value of [style?.observedRgb,style?.measuredRgb,style?.rgb,style?.colourRgb,style?.colorRgb,style?.observedColor,style?.observedColour,style?.color,style?.colour]) {
    if(Array.isArray(value)&&value.length>=3) return value.slice(0,3).map(byte);
    if(value&&typeof value==="object"&&[value.r,value.g,value.b].every(Number.isFinite)) return [byte(value.r),byte(value.g),byte(value.b)];
    if(typeof value==="string") { const m=value.trim().match(/^#?([0-9a-f]{6})$/i); if(m) return [0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16)); }
  } return null;
}
const warm=(rgb)=>!!rgb&&rgb[0]>135&&rgb[1]>115&&rgb[2]<rgb[1]*.92&&rgb[0]>rgb[2]*1.22;
const byte=(n)=>Math.max(0,Math.min(255,Math.round(Number(n)||0)));
const firstText=(...v)=>v.find(x=>typeof x==="string"&&x.trim())||null;
const norm=(v)=>String(v||"").trim().toLowerCase().replace(/[_/]+/g," ").replace(/[-–—]+/g," ").replace(/\s+/g," ");
const normPattern=(v)=>norm(v||"fine noise").replace(/ /g,"_");
function normalizePalette(palette){let total=0;const out=[];for(const e of palette){const block=blockId(e?.block||e?.id||e?.name),raw=Number(e?.weight??e?.percent??e?.percentage);if(!block||!Number.isFinite(raw)||raw<=0)continue;const weight=raw>1?raw/100:raw;out.push({block,weight});total+=weight;}return out.length&&total>0?out.map(e=>({block:e.block,weight:e.weight/total})):null;}
function weightedBlock(palette,random){const p=normalizePalette(palette)||palette;let cursor=0;for(const e of p){cursor+=Number(e.weight)||0;if(random<cursor)return blockId(e.block)||"minecraft:stone";}return blockId(p.at(-1)?.block)||"minecraft:stone";}

function patternRandom(pattern,x,z,seed,id){let ax=x,az=z,salt=pattern;switch(pattern){
case"speckled":salt+=":"+Math.abs((x*17+z*31)%11);break;
case"large_subtle_patches":ax=Math.floor(x/4);az=Math.floor(z/4);salt+=":"+((x+z)&1);break;
case"patchy_weathered":ax=Math.floor(x/3);az=Math.floor(z/3);salt+=":"+Math.abs((x*5-z*3)%7);break;
case"repeating_paving_grid":salt+=":"+mod(x,4)+":"+mod(z,4);ax=Math.floor(x/4);az=Math.floor(z/4);break;
case"slab_grid":salt+=":"+mod(x,3)+":"+mod(z,2);ax=Math.floor(x/3);az=Math.floor(z/2);break;
case"irregular_clusters":ax=Math.floor((x+hash(seed,id,x,z,"jx")*2)/2);az=Math.floor((z+hash(seed,id,x,z,"jz")*2)/2);break;
case"larger_irregular_slabs":ax=Math.floor((x+hash(seed,id,x,z,"jx")*3)/4);az=Math.floor((z+hash(seed,id,x,z,"jz")*3)/3);break;
case"dense_granular_noise":salt+=":"+(x*3+z*5);break;
case"fine_mottling":ax=Math.floor(x/2);az=Math.floor(z/2);salt+=":"+mod(x+z,3);break;
case"directional_worn_patches":ax=Math.floor((x+z*.35)/4);az=Math.floor(z/2);break;
case"organic_clusters":ax=Math.floor((x+Math.sin(z*.7)*2)/3);az=Math.floor((z+Math.cos(x*.6)*2)/3);break;
case"very_large_soft_patches":ax=Math.floor((x+Math.sin(z*.23)*3)/8);az=Math.floor((z+Math.cos(x*.19)*3)/8);break;
case"edge_biased_wear":{const edge=Math.min(mod(x,9),8-mod(x,9),mod(z,9),8-mod(z,9));salt+=":edge"+Math.min(2,edge);ax=Math.floor(x/3);az=Math.floor(z/3);break;}
case"directional_strips":ax=Math.floor(x/2);az=0;salt+=":"+mod(z,5);break;
case"soft_noise":ax=Math.floor(x/3);az=Math.floor(z/3);salt+=":"+mod(x+z,2);break;
case"large_clustered_blobs":ax=Math.floor((x+Math.sin(z*.4)*2)/5);az=Math.floor((z+Math.cos(x*.37)*2)/5);break;
case"large_irregular_blobs":ax=Math.floor((x+hash(seed,id,x,z,"bx")*4)/5);az=Math.floor((z+hash(seed,id,x,z,"bz")*4)/5);break;
case"layered_patches":ax=Math.floor(x/4);az=Math.floor(z/2);salt+=":"+mod(z,4);break;
case"clustered_weathering":ax=Math.floor(x/3);az=Math.floor(z/3);salt+=":"+mod(x-z,5);break;
case"horizontal_courses":ax=Math.floor(x/3);salt+=":"+mod(z,3);break;}return hash(seed,id,ax,az,salt);}
function hash(seed,id,x,z,salt){const text=String(seed)+"|"+id+"|"+x+"|"+z+"|"+salt;let h=2166136261>>>0;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}h^=h>>>16;h=Math.imul(h,0x7feb352d)>>>0;h^=h>>>15;h=Math.imul(h,0x846ca68b)>>>0;h^=h>>>16;return(h>>>0)/4294967296;}
const mod=(v,d)=>((Math.trunc(v)%d)+d)%d;
