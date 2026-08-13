import { geometryBounds } from "./geo.mjs";

const STYLE = {
  park_boundary: { fill: "#eef5e8", stroke: "#284b34", width: 2 },
  surface: { fill: "#cfe8bd", stroke: "#90b77e", width: 0.5 },
  water: { fill: "#8ed1e8", stroke: "#348aaa", width: 1 },
  building: { fill: "#d7b49e", stroke: "#7a4f39", width: 1 },
  path: { fill: "none", stroke: "#e9d8a6", width: 3 },
  road: { fill: "none", stroke: "#6c757d", width: 4 },
  ride_track: { fill: "none", stroke: "#e63946", width: 2 },
  ride_support: { fill: "none", stroke: "#8d99ae", width: 1 },
  ride_attachment: { fill: "none", stroke: "#f59e0b", width: 1.5 },
  attraction: { fill: "#f6bd60", stroke: "#9c6644", width: 1 },
  rail: { fill: "none", stroke: "#343a40", width: 2 },
  barrier: { fill: "none", stroke: "#5f6f52", width: 1 },
  amenity: { fill: "#f4a261", stroke: "#7f5539", width: 1 },
  structure: { fill: "#adb5bd", stroke: "#495057", width: 1 },
  vegetation: { fill: "#4f772d", stroke: "#31572c", width: 1 },
  detail: { fill: "#9d4edd", stroke: "#5a189a", width: 1 }
};

export function buildPreviewSvg(parkName, map, accuracy) {
  const bounds = geometryBounds(map.boundary.localGeometry);
  const widthM = Math.max(1, bounds.maxX - bounds.minX);
  const heightM = Math.max(1, bounds.maxZ - bounds.minZ);
  const margin = Math.max(widthM, heightM) * 0.03;
  const view = [bounds.minX - margin, bounds.minZ - margin, widthM + margin * 2, heightM + margin * 2];
  const ordered = [...map.features].sort((a, b) => layer(a.kind) - layer(b.kind));
  const paths = ordered.map((feature) => renderFeature(feature)).join("\n");
  const confidence = `${(accuracy.score * 100).toFixed(1)}% · grade ${accuracy.grade}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(" ")}" role="img" aria-label="${escapeXml(parkName)} public-data plan">
  <rect x="${view[0]}" y="${view[1]}" width="${view[2]}" height="${view[3]}" fill="#f7f5ef"/>
  <g stroke-linecap="round" stroke-linejoin="round">${paths}</g>
  <g transform="translate(${bounds.minX},${bounds.minZ})">
    <rect x="0" y="0" width="${Math.min(290, widthM * 0.42)}" height="${Math.min(58, heightM * 0.15)}" rx="5" fill="#ffffff" fill-opacity="0.9" stroke="#1d3557" stroke-width="0.8"/>
    <text x="9" y="18" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="#1d3557">${escapeXml(parkName)}</text>
    <text x="9" y="36" font-family="system-ui,sans-serif" font-size="9" fill="#33415c">1 block = 1 metre · confidence ${confidence}</text>
    <text x="9" y="49" font-family="system-ui,sans-serif" font-size="7" fill="#59636e">© OpenStreetMap contributors · evidence preview</text>
  </g>
</svg>`;
}

export function buildPreviewHtml(parkName, svg, accuracy) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(parkName)} public-data preview</title>
<style>body{margin:0;background:#161a1d;color:#f8f9fa;font-family:system-ui,sans-serif}main{max-width:1400px;margin:auto;padding:24px}h1{font-size:clamp(1.4rem,3vw,2.4rem);margin:.2rem 0}.meta{color:#adb5bd;margin:0 0 16px}.map{background:white;border-radius:14px;overflow:hidden}.map svg{display:block;width:100%;height:auto}.warning{padding:14px 16px;background:#3d2f16;border:1px solid #8c6b2e;border-radius:10px;margin-top:16px}</style>
</head><body><main><h1>${escapeXml(parkName)}</h1><p class="meta">Public-data reconstruction · confidence ${(accuracy.score * 100).toFixed(1)}% · grade ${accuracy.grade}</p><div class="map">${svg}</div><p class="warning">${escapeXml(accuracy.claim)}</p></main></body></html>`;
}

function renderFeature(feature) {
  const route = ["path", "road"].includes(feature.kind);
  const style = feature.kind === "ride_track" ? rideStyle(feature) : route ? routeStyle(feature) : (STYLE[feature.kind] || STYLE.structure);
  const attributes = `fill="${style.fill}" fill-rule="evenodd" stroke="${style.stroke}" stroke-width="${style.width}"${route ? "" : " vector-effect=\"non-scaling-stroke\""}`;
  const geometry = feature.localGeometry;
  if (geometry.type === "Point") {
    const [x, z] = geometry.coordinates;
    return `<circle cx="${x}" cy="${z}" r="2.5" ${attributes}><title>${escapeXml(feature.name || feature.subtype || feature.kind)}</title></circle>`;
  }
  const path = geometryToPath(geometry);
  const routeEvidence = route
    ? ` · width ${feature.fidelity?.path?.widthM ?? "area"} m (${feature.fidelity?.path?.widthStatus || "unknown"})`
    : "";
  return path ? `<path d="${path}" ${attributes}><title>${escapeXml(`${feature.name || feature.subtype || feature.kind}${routeEvidence}`)}</title></path>` : "";
}

function routeStyle(feature) {
  const area = ["Polygon", "MultiPolygon"].includes(feature.localGeometry?.type);
  const style = feature.surfaceStyle || {};
  const stroke = style.colour || (style.appearanceStatus === "unknown-visible-fallback"
    ? "#ea580c"
    : feature.kind === "road" ? "#6c757d" : "#bda66b");
  return {
    fill: area ? stroke : "none",
    stroke,
    width: area ? 0.5 : Math.max(1, feature.fidelity?.path?.rasterWidthM || 1)
  };
}

function rideStyle(feature) {
  const counts = feature.rideProfile?.evidenceCounts || {};
  const evidence = Object.entries(counts)
    .filter(([name]) => name !== "none")
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "none";
  const stroke = ({
    surveyed: "#00a6a6",
    "manufacturer-cad": "#00a6a6",
    "planning-verified": "#2563eb",
    "measured-lidar": "#65a30d",
    "lidar-derived": "#65a30d",
    interpolated: "#d4a017",
    "interpolated-lidar": "#d4a017",
    inferred: "#ca8a04",
    none: "#ea580c"
  })[evidence] || "#ea580c";
  return { fill: "none", stroke, width: 2 };
}

function geometryToPath(geometry) {
  const line = (points, close = false) => points.map(([x, z], index) => `${index ? "L" : "M"}${x.toFixed(2)} ${z.toFixed(2)}`).join(" ") + (close ? " Z" : "");
  if (geometry.type === "LineString") return line(geometry.coordinates);
  if (geometry.type === "Polygon") return geometry.coordinates.map((ring) => line(ring, true)).join(" ");
  if (geometry.type === "MultiLineString") return geometry.coordinates.map((points) => line(points)).join(" ");
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flatMap((polygon) => polygon.map((ring) => line(ring, true))).join(" ");
  return "";
}

function layer(kind) {
  return ({ park_boundary: 0, surface: 1, water: 2, road: 3, path: 4, building: 5, attraction: 6, ride_support: 7, ride_track: 8, ride_attachment: 9, barrier: 10 })[kind] ?? 11;
}

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]);
}
