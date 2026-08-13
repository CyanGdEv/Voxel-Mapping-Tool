import { readFile, writeFile } from "node:fs/promises";
const path = new URL("../src/lib/osm.mjs", import.meta.url);
let source = await readFile(path, "utf8");
source = source.replace(
'    if (feature.source.elementType === "relation") summary.relationFeatures += 1;\n    const polygons = feature.geometry.type === "Polygon"\n      ? [feature.geometry.coordinates]\n      : feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [];',
'    if (feature?.source?.elementType === "relation") summary.relationFeatures += 1;\n    const geometry = feature?.geometry;\n    const polygons = geometry?.type === "Polygon"\n      ? [geometry.coordinates]\n      : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];'
);
source = source.replace(
'  for (const feature of features) {\n    if (feature.tags.bridge && feature.tags.bridge !== "no") summary.bridges += 1;\n    if (feature.tags.tunnel && feature.tags.tunnel !== "no") summary.tunnels += 1;\n    const layer = Number(feature.tags.layer);',
'  for (const feature of features) {\n    const tags = feature?.tags || {};\n    if (tags.bridge && tags.bridge !== "no") summary.bridges += 1;\n    if (tags.tunnel && tags.tunnel !== "no") summary.tunnels += 1;\n    const layer = Number(tags.layer);'
);
source = source.replace('    if (feature.tags.entrance || feature.tags.door) summary.mappedEntrances += 1;\n    if (feature.tags.entrance === "main") summary.mappedMainEntrances += 1;', '    if (tags.entrance || tags.door) summary.mappedEntrances += 1;\n    if (tags.entrance === "main") summary.mappedMainEntrances += 1;');
source = source.replace('    geometry: feature.geometry,', '    geometry: feature?.geometry ?? null,');
for (const marker of ['const geometry = feature?.geometry;', 'const tags = feature?.tags || {};', 'geometry: feature?.geometry ?? null']) {
  if (!source.includes(marker)) throw new Error(`Missing hardening marker: ${marker}`);
}
await writeFile(path, source);
console.log("Applied geometry-less topology hardening");
