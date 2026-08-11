# Voxel Mapping Tool

Voxel Mapping Tool is an automatic, evidence-first compiler that turns UK public geospatial and planning evidence into importable, one-block-per-metre Minecraft Bedrock theme-park worlds. The player chooses a supported park; the GitHub Actions job discovers the applications and drawings, extracts and aligns eligible planning geometry, builds the world, and emits the `.mcworld` with a machine-readable provenance and validation bundle.

The governing rule is deliberately strict: **planning geometry is the world source of truth; OpenStreetMap is registration/alignment-only.** A planning-only build removes every OSM- or Overture-derived world feature before reconstruction and fails if no accepted planning geometry remains.

## Supported park profiles

| Profile | Planning authority |
|---|---|
| `chessington-world-of-adventures` | Royal Borough of Kingston upon Thames |
| `alton-towers-resort` | Staffordshire Moorlands District Council |
| `legoland-windsor-resort` | Royal Borough of Windsor and Maidenhead |
| `thorpe-park` | Runnymede Borough Council |
| `drayton-manor-resort` | Lichfield District Council |

Each profile supplies bounded coordinates, its official planning portal adapter, fallback application seeds, search terms, and conservative source defaults. Run `npm run parks` to inspect them.

## Generate a park with GitHub Actions

1. Open **Actions → Generate 1:1 theme park → Run workflow**.
2. Select the park. This is the only run input.

The workflow automatically uses the repository URL as the identifying contact required by public-data services. Administrators may optionally override it with a monitored email or project URL in a `TPMAP_CONTACT` repository secret; players do not need to configure it.

The job searches the bounded [PlanIt application index](https://www.planit.org.uk/api/) and the selected park's official council register, follows official application/document links, ranks and downloads relevant drawings, extracts and georeferences plan geometry, checks decision/current-state evidence, then builds in `planning-only` mode. It independently validates LevelDB chunks and native signs, uploads the `.mcworld` as a direct file, and uploads the evidence bundle separately. Raw council documents remain in the private Actions cache and are not republished as artifacts.

The workflow intentionally fails when:

- no accepted planning derivative is present;
- council access controls or missing documents leave no confidence-gated planning geometry;
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

Raw PDFs/images are discovered from official application records, hashed, size-bounded and retained as processing-only evidence. The automatic extractor renders each bounded page, performs OCR and line/contour recovery, reads the stated drawing scale, associates geometry with planning labels, and aligns the drawing's red-line/site boundary to the official application location. OSM can supply registration control only; its geometry never replaces the extracted plan.

Automatic geometry is promoted only when scale, location, semantic association, application decision and current-state/as-built or independent DSM corroboration gates pass. Approved-but-unverified proposals remain in `planning-sources.json` and cannot enter the world. A manual [planning manifest](docs/PLANNING_MANIFEST.md) remains available as an expert override for inaccessible archives or higher-quality CAD/survey derivatives; use `--no-auto-planning` with those inputs.

```bash
node src/cli.mjs extract-plan --input drawing.pdf --page 1 --out out/drawing-review
```

This writes an SVG candidate layer, raw OCR lines, drawing-scale candidates and semantic anchors for diagnosis.

Older official applications are included by the bounded spatial search and per-park seed list. An approval alone still does not prove construction or continued existence.

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
- `planning-discovery.json` — searched adapters, application ranking, extraction decisions, warnings and access failures;
- `park-reconstruction-graph.json` — compact typed 3D intermediate representation;
- `building-labels.json` — sign text, feature IDs and exact coordinates;
- `evidence.json`, `fidelity.json`, `ACCURACY_REPORT.md` — source and confidence record;
- QA GeoJSON/JSON for orthophotos, paths, topology and terrain;
- `world-validation.json` and `planning-build-validation.json` in workflow builds.

## Accuracy boundary

“1:1” means **one Minecraft block equals one real-world metre**. It does not mean every publicly unavailable detail is known. A complete replica still requires complete, current, rights-compatible source evidence. The strict workflow is designed to expose and reject missing critical evidence rather than disguise it with plausible scenery.

## Licensing

The code is MIT licensed. Input data keeps its own licence and terms. Public visibility is not permission to redistribute a drawing. Store URLs, hashes and derived geometry only where the source terms allow it; otherwise use the document as processing-only evidence and keep it out of public artifacts.
