# Voxel Mapping Tool

Voxel Mapping Tool is an evidence-first compiler that turns reviewed UK geospatial and planning evidence into importable, one-block-per-metre Minecraft Bedrock theme-park worlds. It runs locally or from GitHub Actions and emits the `.mcworld` together with a machine-readable provenance and validation bundle.

The governing rule is deliberately strict: **planning geometry is the world source of truth; OpenStreetMap is registration/alignment-only.** A planning-only build removes every OSM- or Overture-derived world feature before reconstruction and fails if no accepted planning geometry remains.

## Supported park profiles

| Profile | Planning authority |
|---|---|
| `chessington-world-of-adventures` | Royal Borough of Kingston upon Thames |
| `alton-towers-resort` | Staffordshire Moorlands District Council |
| `legoland-windsor-resort` | Royal Borough of Windsor and Maidenhead |
| `thorpe-park` | Runnymede Borough Council |
| `drayton-manor-resort` | Lichfield District Council |

Each profile supplies bounded coordinates, its official planning portal, search terms, and conservative source defaults. Run `npm run parks` to inspect them.

## Generate a park with GitHub Actions

1. Add a repository secret named `TPMAP_CONTACT`. Use a project URL or monitored email; live OSM services require an identifying user agent.
2. Prepare and review a [planning manifest](docs/PLANNING_MANIFEST.md). Commit it and its GeoJSON derivatives, or host the manifest and derivatives at public HTTPS URLs.
3. Open **Actions → Generate 1:1 theme park → Run workflow**.
4. Select the park and enter the manifest path/URL.

The job tests the compiler, obtains bounded public sources, builds in `planning-only` mode, validates the LevelDB chunks and native signs with an independent reader, uploads the `.mcworld` as a direct file, and uploads the evidence bundle separately.

The workflow intentionally fails when:

- no accepted planning derivative is present;
- any OSM-derived geometry reaches the reconstruction graph;
- strict evidence gates are not met;
- a named building is missing its in-world sign; or
- the finished Bedrock archive cannot be decoded and validated.

## Local fixture

Node.js 20 or newer is required; CI uses Node.js 22.

```bash
npm ci
npm run ci
```

That command runs the complete test suite, creates a small planning-authoritative fixture world, then independently opens and validates the `.mcworld`.

A real local build uses the same contract:

```bash
export TPMAP_CONTACT="https://example.org/voxel-map"
node src/cli.mjs build \
  --park alton-towers-resort \
  --planning-manifest evidence/alton-towers.json \
  --planning-world-authority planning-only \
  --accuracy-mode verified \
  --buildings shells \
  --strict \
  --no-addon \
  --out out/alton-towers
```

## Evidence authority

| Rank | Evidence | World use |
|---:|---|---|
| 1 | Survey/CAD and reviewed, implemented planning derivatives | Authoritative horizontal geometry, dimensions, materials, levels, ride layouts and supports |
| 2 | Environment Agency DTM/DSM or supplied survey rasters | Ground, roof/canopy/surface heights and terrain interaction |
| 3 | Rights-cleared orthophotos and official land/water/tree datasets | Appearance, canopy, water and gap review where provenance and reuse allow |
| 4 | Other licensed public observations | Corroboration, labels or explicit gap-fill under recorded policy |
| — | OSM and OSM-derived Overture | Registration, source discovery and QA only; never emitted in `planning-only` worlds |

Unknown detail remains unknown in `verified` mode. The compiler does not silently convert a planning proposal into current reality, infer banking, or treat a public-register PDF as redistributable.

## What the compiler reconstructs

- exact 1 metre horizontal and vertical voxel scale;
- planning-authoritative paths, plazas, queues, buildings, walls, fences, water, vegetation and ride alignments;
- DTM terrain and DSM-derived roof/surface elevation where matching LiDAR exists;
- planning elevation anchors into bounded 3D ride profiles, without extrapolating unresolved gaps;
- explicit support styles (`column`, `a-frame`, `portal`, `lattice`) and grounded footings;
- material-specific deterministic paving recipes and patterns;
- evidence-driven slabs, stairs, walls, fences and trapdoors through planning `minecraft_shape` tags;
- trees, tree cover, shrubs, hedges, retaining walls, tunnels and bridge structures;
- a two-sided native Bedrock sign for every named building represented by accepted planning geometry.

The typed reconstruction graph sits between GIS normalization and voxel compilation. It records geometry authority, lifecycle, levels, material evidence, relationships, unresolved observations, roof analysis, ride profiles and support reconstruction.

## Planning drawings

Raw PDFs/images are inventoried, hashed, size-bounded and retained as evidence. The repository includes conservative PDF/raster rendering, OCR and line/contour extraction helpers, but extracted pixels are **not** automatically promoted to world geometry. A human-reviewed, georeferenced GeoJSON derivative and an explicit `worldEligible` decision are required.

```bash
node src/cli.mjs extract-plan --input drawing.pdf --page 1 --out out/drawing-review
```

This writes an SVG candidate layer and semantic OCR anchors for review; it is not a substitute for scale, rotation and georeferencing control points.

This matters for older attractions: use the authority archive and older application references, then mark only geometry verified to describe the current or requested historic state. An approval alone does not prove construction or continued existence.

See:

- [Planning manifest contract](docs/PLANNING_MANIFEST.md)
- [Architecture and authority invariants](docs/ARCHITECTURE.md)
- [Public source catalogue](docs/DATA_SOURCES.md)
- [Machine-readable source catalogue](config/source-catalog.json)

## Outputs

Each build directory contains:

- `*_1to1.mcworld` — complete importable Bedrock world;
- `world-manifest.json`, `block-palette.json` — archive/chunk/palette evidence;
- `source-authority.json` — proof of the planning-only policy and zero-OSM invariant;
- `planning-sources.json` — document hashes, reuse state and accepted derivatives;
- `park-reconstruction-graph.json` — compact typed 3D intermediate representation;
- `building-labels.json` — sign text, feature IDs and exact coordinates;
- `evidence.json`, `fidelity.json`, `ACCURACY_REPORT.md` — source and confidence record;
- QA GeoJSON/JSON for orthophotos, paths, topology and terrain;
- `world-validation.json` and `planning-build-validation.json` in workflow builds.

## Accuracy boundary

“1:1” means **one Minecraft block equals one real-world metre**. It does not mean every publicly unavailable detail is known. A complete replica still requires complete, current, rights-compatible source evidence. The strict workflow is designed to expose and reject missing critical evidence rather than disguise it with plausible scenery.

## Licensing

The code is MIT licensed. Input data keeps its own licence and terms. Public visibility is not permission to redistribute a drawing. Store URLs, hashes and derived geometry only where the source terms allow it; otherwise use the document as processing-only evidence and keep it out of public artifacts.
