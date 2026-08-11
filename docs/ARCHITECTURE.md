# Architecture and authority invariants

## Pipeline

1. Load one of the five bounded park profiles.
2. Acquire OSM for coordinate registration and QA, plus selected public elevation, vegetation, water and imagery sources.
3. Acquire planning manifests and hash all source documents.
4. Accept only reviewed georeferenced derivatives whose manifest explicitly declares `worldEligible: true` and explains why they represent the requested real-world state.
5. Normalize all geometry to WGS84 and a local metre grid.
6. Apply planning-only authority and physically remove OSM/Overture world features.
7. Build the typed park reconstruction graph.
8. Resolve terrain, vertical observations, roofs, ride profiles, supports and vegetation without filling unresolved evidence gaps in verified mode.
9. Rasterize at exactly one metre, compile deterministic block operations and native Bedrock signs.
10. Write LevelDB chunks, package `.mcworld`, and validate it with both the writer and an independent reader.

## Hard invariants

- `planning-only` is the default at the CLI and `buildPark` entry point.
- A planning-only build cannot fall back to OSM.
- No node in a planning-only reconstruction graph may be OSM-derived.
- Temporary/red construction fences and `planning_exclude_from_world` features are excluded.
- A document derivative is not world eligible because its application was merely approved. Current-state eligibility is an explicit reviewed manifest decision.
- A missing elevation stays null until planning, survey, DTM/DSM or traceable interpolation resolves it.
- Interpolation is bounded between compatible ride anchors; no end extrapolation is performed.
- Every named polygonal building/structure accepted into the compiler receives a native Bedrock sign.
- Build products are emitted only after evidence reports are written; strict mode can therefore fail while preserving diagnostics.

## Reconstruction graph

The graph contains physical nodes, evidence-only observations and deterministic relationships. Node authority is separated into geometry and attributes. High-value relations include supports-to-rides, paths-to-buildings, bridges-to-water and barriers-to-paths.

Advanced stages attach resolved states back to compiler features:

- terrain: DTM/DSM samples and interactions;
- vertical: ground/base/top/height evidence selection and conflict reporting;
- roofs: footprint-aware DTM/DSM statistics and roof form evidence;
- rides: planning elevation anchors, continuous bounded segments and 3D samples;
- supports: planning support position/style, terrain footing and track connection;
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

## Deliberate boundary

The compiler does not autonomously scrape every council portal, solve CAPTCHA/session restrictions, or decide whether an approved plan was built. Those decisions require a reviewed evidence manifest. Raster/OCR extraction assists review but does not bypass georeferencing or provenance checks.
