# Planning manifest contract

A manifest binds official planning records to reviewed georeferenced geometry. It is the hand-off between planning research and deterministic world generation.

Validate documents against [`schemas/planning-manifest.schema.json`](../schemas/planning-manifest.schema.json).

## Minimal example

```json
{
  "schemaVersion": 1,
  "id": "park-current-state-2026-08",
  "parkId": "thorpe-park",
  "authority": {
    "name": "Runnymede Borough Council",
    "officialPortal": "https://www.runnymede.gov.uk/planning-permission/view-object-support-application-1"
  },
  "reviewedAt": "2026-08-11",
  "documents": [
    {
      "id": "application-plan",
      "applicationReference": "RU.00/0000",
      "applicationStatus": "implemented",
      "role": "approved-site-layout",
      "sourceUrl": "https://planning.example/document.pdf",
      "mime": "application/pdf",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "reuseStatus": "public-register-processing-only",
      "derivedGeojson": "derived/application-plan.geojson",
      "worldEligible": true,
      "worldEligibilityBasis": "Site inspection and dated aerial evidence confirm this approved layout was built and remains present."
    }
  ]
}
```

## Rules

- Use the official authority portal as the primary record.
- Record the application reference, status, document role and source URL.
- Pin acquired documents with SHA-256 whenever stable bytes are available.
- State reuse rights independently from public availability.
- A derivative must explicitly set `worldEligible`.
- `worldEligible: true` requires a written basis showing the drawing represents the requested current/historic state. Approval alone is insufficient.
- Ineligible/rejected/superseded/proposed derivatives remain evidence but are not fused into the world.
- Derivatives must be WGS84 GeoJSON FeatureCollections and carry enough properties to classify their geometry.
- Use separate features for plan geometry and vertical observations such as ride elevation points, finished-floor levels and water levels.

## Recommended GeoJSON properties

Common:

- `id`, `kind`, `name`
- `planning_reference`, `application_status`, `planning_authoritative`
- `height_m`, `elevation_m`, `width`
- `material`, `surface_material`, `surface:pattern`
- `planning_feature_class`, `planning_feature_state`

Kinds include `park_boundary`, `path`, `road`, `building`, `structure`, `ride_track`, `ride_support`, `water`, `vegetation`, `barrier`, `surface`, `terrain_detail` and `detail`.

Use `planning_feature_class` values such as `ride-elevation`, `building-level`, `water-level` or `terrain-level` for evidence-only level observations. Use `planning_exclude_from_world: true` for construction/annotation geometry. Temporary red construction fencing is also rejected automatically.

For material shapes and support styles, see [Architecture](ARCHITECTURE.md#material-and-block-shape-contract).

## Older attractions

Search the authority archive by park address, attraction name, operator and application reference. Add older approved/as-built drawings when they remain the best source for an extant attraction. Record supersession and current-state checks in `worldEligibilityBasis`; do not merge mutually inconsistent generations into one world.
