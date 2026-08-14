import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sourcePath = process.argv[2] ?? 'source/planning-evidence-unregistered.geojson';
const outputDir = process.argv[3] ?? 'planning-seeds/alton-towers-resort';
const q = 100;
const expectedSha256 = '592f13a73c046d87584463d6d80826b107cfbfc82c5806be9af131afcc1cde1b';
const allowedDocuments = new Set([
  'smd-2022-0556-1-atph-sa-xx-xx-dr-a-0102-rev-p02-site-plan-as-existing',
  'smd-2020-0553-21-3029-sa-xx-04-dr-a-0224-p0-1-the-attic-level-04-services-and-fixing-details',
  'smd-2022-0556-42-updated-drainage-strategy-plan',
  'smd-2020-0553-22-3029-sa-xx-gf-dr-a-0222-p0-1-sub-species-level-gf-services-and-fixing-details',
  'smd-2011-1051-5-rev-block-plan-prop',
  'smd-2022-0556-11-373-104-4-landscape-plan-proposed',
  'smd-2022-0556-31-landscape-plan-with-felled-trees-rpas',
  'smd-2022-0556-32-planting-plan-east',
  'smd-2014-0107-8-site-plan-showing-constraints-373-85-3b-2-5-2014',
  'smd-2022-0556-33-planting-plan-north',
  'smd-2017-0111-1-373-95-7b-site-plan-proposed-showing-woodland-path',
  'smd-2014-0107-9-site-plan-showing-final-fencing-373-85-3-1a-2-5-2014',
  'smd-2022-0556-34-planting-plan-south',
  'smd-2017-0111-2-373-95-8b-site-plan-landscape',
  'smd-2020-0553-14-3029-sa-sm-02-dr-a-0208-p0-1-gf-02-proposed-level-2',
  'smd-2022-0556-35-planting-plan-west',
  'smd-2020-0553-15-3029-sa-sm-03-dr-a-0209-p0-5-proposed-level-3',
  'smd-2014-0107-11-site-plan-west-showing-constraints-373-85-4b-2-5-2014',
  'smd-2016-0040-15-location-plan',
  'smd-2022-0556-36-woodland-planting-outside-red-line',
  'smd-2020-0553-16-3029-sa-sm-04-dr-a-0210-p0-3-04-proposed-level-4',
  'smd-2014-0107-12-373-85-1-atr-key-plan',
  'smd-2016-0040-16-fencing-and-landscaping-details',
  'smd-2022-0556-37-woodland-planting-ex-red-line-rpas-fells',
  'smd-2022-0556-18-atph-sa-xx-xx-dr-a-0101-rev-p02-location-plan',
  'smd-2020-0553-18-3029-sa-sm-gf-dr-a-0207-p0-5-gf-proposed-ground-floor-level-1',
  'smd-2011-1051-1-rev-site-plan-exist',
  'smd-2014-0107-14-proposed-tree-house-plan-concept-1',
  'smd-2014-0107-34-ats-pl-206-d-amended-drawing',
  'smd-2022-0556-19-atph-sa-xx-xx-dr-a-0105-rev-p02-demolition-plan',
  'smd-2020-0553-19-3029-sa-xx-00-dr-a-0221-p0-1-altonville-mines-level-00-services-and-fixing-detai',
  'smd-2011-1051-2-rev-site-plan-prop',
  'smd-2011-1051-3-rev-fencing-plan',
  'smd-2022-0556-4-373-104-3-site-plan-as-extg',
  'smd-2015-0473-2-existing-station-plan',
  'smd-2011-1051-7-rev-mesh-canopies-plan',
  'smd-2014-0107-22-373-85-2a-amended-drawing',
  'smd-2016-0040-6-site-plan-and-phasing',
  'smd-2014-0107-23-373-85-3-1-amended-drawing',
  'smd-2016-0040-7-proposed-site-plan',
  'smd-2014-0107-24-373-85-3a-amended-drawing',
  'smd-2022-0556-49-woodland-planting-outside-red-line',
  'smd-2015-0473-7-proposed-site-and-roof-plan',
  'smd-2014-0107-5-proposed-tree-house-layout',
  'smd-2014-0107-25-373-85-4a-amended-drawing',
  'smd-2022-0556-10-site-plan-as-extg',
  'smd-2022-0556-30-landscape-plan-proposed',
  'smd-2022-0556-50-woodland-planting-ex-red-line-rpas-fells',
  'smd-2014-0107-26-373-85-5a-amended-drawing'
]);

const collection = JSON.parse(await readFile(sourcePath, 'utf8'));
const eligible = (collection.features ?? []).filter((feature) => {
  const p = feature?.properties ?? {};
  return allowedDocuments.has(p.planning_document_id)
    && p.planning_scale_verified === true
    && p.planning_exclude_from_world !== true
    && ['LineString', 'Polygon'].includes(feature?.geometry?.type);
});
const kinds = [...new Set(eligible.map((feature) => feature.properties.kind))].sort();
const kindIndex = new Map(kinds.map((kind, index) => [kind, index]));
const documents = [], documentIndex = new Map(), rows = [], seen = new Set(), kindCounts = {};

function encodeLine(coordinates) {
  const output = [];
  let previousX = 0, previousY = 0;
  for (let index = 0; index < coordinates.length; index += 1) {
    const point = coordinates[index];
    const x = Math.round(Number(point[0]) * q), y = Math.round(Number(point[1]) * q);
    if (index === 0) output.push(x, y);
    else output.push(x - previousX, y - previousY);
    previousX = x; previousY = y;
  }
  return output;
}

for (const feature of eligible) {
  const p = feature.properties, geometry = feature.geometry, kind = p.kind;
  const encoded = geometry.type === 'LineString'
    ? [0, encodeLine(geometry.coordinates)]
    : [1, geometry.coordinates.map(encodeLine)];
  const signature = JSON.stringify(encoded);
  const dedupe = `${p.planning_document_sha256 ?? p.planning_document_id}|${kind}|${signature}`;
  if (seen.has(dedupe)) continue;
  seen.add(dedupe);
  const documentId = p.planning_document_id;
  if (!documentIndex.has(documentId)) {
    documentIndex.set(documentId, documents.length);
    documents.push([
      documentId,
      p.planning_application_reference ?? null,
      p.planning_document_sha256 ?? null,
      p.application_status ?? null,
      p.decision ?? null,
      p.decision_date ?? null,
      p.application_proposal ?? null,
      p.planning_scale_denominator ?? null
    ]);
  }
  rows.push([documentIndex.get(documentId), kindIndex.get(kind), encoded]);
  kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
}

const compact = { s: 'voxel-mapper.planning-seed-compact.v1', q, k: kinds, d: documents, f: rows };
const raw = Buffer.from(JSON.stringify(compact) + '\n');
const evidenceSha256 = createHash('sha256').update(raw).digest('hex');
if (evidenceSha256 !== expectedSha256) throw new Error(`compact seed is not deterministic: expected ${expectedSha256}, got ${evidenceSha256}`);
if (documents.length !== 49 || rows.length !== 22494) throw new Error(`unexpected compact seed counts documents=${documents.length} features=${rows.length}`);
const compressed = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } });
const applicationReferences = [...new Set(documents.map((document) => document[1]).filter(Boolean))].sort();
const manifest = {
  schema: 'voxel-mapper.planning-seed-manifest.v1',
  format: 'voxel-mapper.planning-seed-compact.v1',
  encoding: 'brotli-base64',
  parkId: 'alton-towers-resort',
  sourceRepository: 'CyanGdEv/Voxel-Mapping-Tool',
  sourceRunId: 31740816954,
  sourceMigrationRunId: 31829266717,
  documentCount: documents.length,
  featureCount: rows.length,
  evidenceSha256,
  coordinateQuantizationMetres: 0.01,
  applicationReferences,
  kindCounts,
  filterPolicy: 'current-registration-compatible PDF plan geometry only; verified metric scale; exact recovered document allowlist; duplicate geometry collapsed by source document SHA + kind + 1 cm geometry signature'
};
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'planning-evidence-compact.json.br.b64'), compressed.toString('base64') + '\n');
await writeFile(path.join(outputDir, 'seed-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`published seed documents=${documents.length} features=${rows.length} compressed=${compressed.length} sha256=${evidenceSha256}`);
