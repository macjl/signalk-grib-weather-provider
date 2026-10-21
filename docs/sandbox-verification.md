# Sandbox verification — catalogue Weather API consumer

Integration performed on 2026-10-21 in the existing `signalk-sandbox` container:
Signal K 2.34.0, Node 24.21.0, Forecast Dataset Provider 0.1.0 and catalogue-aware
GRIB Downloader 0.4.0-beta.1. Weather Provider version: 0.7.0-beta.1, branch
`feature/forecast-dataset-provider`.

## Results

The real catalogue acquisition `62dae367-ced8-474a-a363-ca07392c82a0`, content
version `0fe6d08a39245b7bcfe4d15609ccff2c359b72b64f4f939a584141f03178a89f`,
was discovered and read with a separate **readonly** application token.

- 129 original GRIB assets, 46,476,556 bytes, downloaded through the catalogue's
  version-bound HTTP URLs; every local asset's length and SHA-256 were checked.
- 129 decoded forecast slices exposed under the existing
  `signalk-grib-weather-provider:gfs-0p25` provider ID.
- Three forecast samples at latitude 43°, longitude 7° matched the old
  shared-directory provider's complete JSON responses exactly, including dates,
  wind, temperature and the remaining available fields.
- The consumer token can discover/read content and is denied publication writes.
  The token is stored as a server-user owned `0600` file and never printed.
- All 44 other plugin configuration files are unchanged. The Weather Provider's
  existing configuration is preserved with only `inputMode: catalogue` added.
- The original GRIB directory and legacy decoded caches are retained. The new
  consumer uses its own `catalogue-assets` and `cache/catalogue` trees.
- The full test suite passes on the sandbox's Node 24 runtime, without skipped
  WebAssembly tests. Tests include real GRIB decoding over HTTP with a deliberately
  nonexistent shared GRIB path, offline restart, failed replacement preservation,
  authoritative deletion and scan cancellation.

The provider's inventory stays unmodified. Successful point forecasts do not
imply that a verified inventory was published back to the catalogue.

## Deployment helpers and rollback

`tools/install-sandbox.cjs` runs as root inside the explicitly selected sandbox
and asserts `SIGNALK_CONTAINER_ID=signalk-sandbox`. Supply the absolute built
archive path under `/home/node/.signalk/local-packages/`. It archives the previous
plugin, backs up package manifests, security configuration and the Weather
Provider configuration, and records a Weather API baseline before installation.
It provisions only a readonly consumer device through the ordinary Access API.
Existing dependency trees are not re-resolved. It switches only this plugin to
catalogue mode, retaining its other settings. Restart the existing container to
load the new package, preserving the image, mounts and overlays.

`tools/verify-sandbox.cjs` uses in-memory, short-lived administrator credentials
for operational routes and the dedicated readonly token for catalogue access.
It can request an immediate scan while awaiting initial startup, checks original
hashes, provider identity, response parity and unchanged configurations. Its
publication-denial request cannot create data. It neither deletes real datasets
nor changes another plugin's settings.

Initial 0.6.0 rollback files:
`/home/node/.signalk/local-packages/grib-weather-before-forecast-2026-10-21T14-01-09-582Z`.
The latest backup is referenced by
`/home/node/.signalk/local-packages/grib-weather-forecast-backup.json`.
Backups contain sensitive security data and remain in private directories.
To roll back, stop the plugin, restore its archived package, manifests and
Weather Provider configuration, then restart the existing container. Legacy
local GRIB/decoded caches are still present. Catalogue-owned datasets are
independent and remain available to other consumers.

## Scope

The consumer still uses its existing regular-latitude/longitude decoder,
interpolation, precipitation handling and Weather API mapping. It does not add
processor dispatch, server-side subsets, catalogue inventory enrichment, daily
aggregation, rotated grids or a general multi-asset field-merging engine.
