# Architecture and authority invariants

## Pipeline

1. Load one of the five bounded park profiles.
2. Query PlanIt within the park bounding box and independently search the configured official council portal; merge and deduplicate application references.
3. Follow official application/document links, rank relevant drawings, download them into the private content-addressed cache, and record hashes/provenance.
4. Prefer native planning geometry before raster extraction: parse ASCII DXF directly, decode supported IFC extrusions/placements, expand bounded ZIP bundles, and convert native DWG through pinned GNU LibreDWG `dwg2dxf` into a transient ASCII DXF that is immediately passed through the same strict native DXF parser. Unsupported/ambiguous CAD/BIM members remain evidence inventory. Only when no usable native geometry exists are bounded PDF/image pages rendered, OCR/vector semantics recovered, and planning geometry aligned using the drawing red-line/site boundary and official application location.
5. Promote only confidence-gated geometry from accepted applications with current-state/as-built evidence or independent DSM structural corroboration. Manual manifests remain an expert override.
6. Acquire OSM for coordinate registration and QA, plus public elevation, vegetation, water and imagery sources.
7. Normalize accepted geometry to WGS84 and a local metre grid.
8. Apply planning-only authority and physically remove OSM/Overture world features.
9. Build the typed park reconstruction graph and resolve terrain, vertical observations, roofs, one-block ride centrelines, detected supports/attachments and vegetation.
10. Rasterize at exactly one metre, write LevelDB chunks, package `.mcworld`, and validate it with both the writer and an independent reader.

## Hard invariants

- `planning-only` is the default at the CLI and `buildPark` entry point.
- A planning-only build cannot fall back to OSM.
- No node in a planning-only reconstruction graph may be OSM-derived.
- Temporary/red construction fences and `planning_exclude_from_world` features are excluded.
- A document derivative is not world eligible because its application was merely approved. Automatic promotion additionally requires as-built/current-state language or independent DSM structural corroboration; manual derivatives require an explicit reviewed decision.
- Native CAD conversion never changes evidence identity: the original official DWG hash remains authoritative provenance, while converted DXF hashes are recorded only as intermediate transformation evidence.
- Missing/failed DWG conversion, unsupported IFC geometry, unsafe ZIP members and unregistered native geometry remain evidence-only; they are never rasterized or guessed into world authority merely because a native file exists.
- A missing elevation stays null until planning, survey, DTM/DSM or traceable interpolation resolves it.
- Interpolation is bounded between compatible ride anchors; no end extrapolation is performed.
- Ride track output is exactly one block wide. Banking and cross ties are outside the representation.
- Supports and ride attachments retain detected planning geometry; no spacing, mirroring or side-offset prior creates missing features.
- Every named polygonal building/structure accepted into the compiler receives a native Bedrock sign.
- Independent OS NGD geometry cannot override planning geometry; Tree Species Map classes are used only above the configured confidence gate and never fabricate an unmapped tree.
- Build products are emitted only after evidence reports are written; strict mode can therefore fail while preserving diagnostics.

## Reconstruction graph

The graph contains physical nodes, evidence-only observations and deterministic relationships. Node authority is separated into geometry and attributes. High-value relations include supports-to-rides, attachments-to-rides, paths-to-buildings, bridges-to-water and barriers-to-paths.

Advanced stages attach resolved states back to compiler features:

- terrain: DTM/DSM samples and interactions;
- vertical: ground/base/top/height evidence selection and conflict reporting;
- roofs: footprint-aware DTM/DSM statistics and roof form evidence;
- rides: planning elevation anchors, continuous bounded segments and one-block 3D centreline samples;
- supports: planning support position/style, terrain footing and track connection;
- ride attachments: detected catwalk, evacuation stair, maintenance/station platform, handrail, fence and access-path geometry, resolved against explicit elevation, terrain or nearby 3D ride samples;
- vegetation: evidence-driven tree/canopy/shrub reconstruction.

## Material and block-shape contract

Planning derivatives may use `surface_material` and `surface:pattern` for deterministic material recipes. They may add:

| Property | Accepted values |
|---|---|
| `minecraft_shape` | `slab`, `stairs`, `wall`, `fence`, `trapdoor` |
| `minecraft_direction` | `south`, `west`, `north`, `east`, or `0..3` |
| `support_style` | `column`, `a-frame`, `portal`, `lattice` |
| `support_axis` | `x` or `z` for portal supports |
| `support_material` | `steel`, `wood`/`timber` |

These are evidence fields, not cosmetic guesses. Bedrock stateful block specifications survive both direct LevelDB output and the optional command-based builder add-on.

## Portal and evidence boundary

Automatic discovery uses bounded requests, caching, identifying user agents, official-host allowlists, application/document limits and fail-closed provenance. It does not evade CAPTCHA, geographic restrictions, authentication or authority downtime. If both the national index and official portal cannot provide usable official documents, strict generation stops with a diagnostic bundle rather than substituting OSM. The manual manifest path exists for records that must legally or technically be obtained outside the automated run.
