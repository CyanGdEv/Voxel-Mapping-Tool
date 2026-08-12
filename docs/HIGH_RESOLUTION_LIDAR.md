# High-resolution LiDAR selection

For live Environment Agency elevation, the mapper now attempts a bounded time-stamped survey selection before falling back to the 1 m composite WCS.

Selection policy:

1. Query the EA National LIDAR Programme survey index for the park bounds.
2. Require a coherent DTM/DSM pair when DSM reconstruction is enabled.
3. Prefer the finest eligible resolution first (25 cm before 50 cm), then the newest survey within the same resolution.
4. Promote only addressable HTTP(S) GeoTIFF assets that remain under the configured download bound and pass the existing EPSG:27700/alignment/resolution validation.
5. If assets are filename-only, ZIP-based, unavailable, oversized, invalid, or fail validation, retain the survey as evidence and fall back to the EA 1 m composite WCS. The fallback reason is recorded in `resolutionSelection`.

Time-stamped EA products are commonly delivered as 5 km GeoTIFF ZIP tiles. ZIP members are deliberately not decompressed by this first slice because a 25 cm 5 km raster can be extremely large when expanded. A later bounded archive-cropping stage should stream/crop only the park AOI before raster decoding rather than inflate a full tile into memory.

Environment variables/options used by the adapter:

- `TPMAP_EA_LIDAR_ARCHIVE_BASE_URL`: optional base URL used only when survey-index asset references are relative paths.
- internal default maximum selected survey resolution: 0.5 m.
- internal default high-resolution raster download bound: 256 MB per DTM/DSM asset.

No high-resolution source can bypass the existing planning authority policy. LiDAR remains terrain/surface/vertical evidence and corroboration.