# signalk-grib-weather-provider

Signal K **Weather API provider** that decodes immutable GRIB2 acquisitions from
[Forecast Dataset Provider](https://github.com/macjl/signalk-forecast-dataset-provider).
It discovers the catalogue through authenticated HTTP, keeps a private verified
copy of the selected assets, and serves the standard Weather API from decoded
local caches. No shared downloader/provider directory is needed.

Downloader sources keep their selectable provider IDs, for example
`signalk-grib-weather-provider:gfs-0p25`, so existing Weather API clients such as
[signalk-weather-map](https://github.com/macjl/signalk-weather-map) keep working.
An explicit `local` input mode remains available for legacy GRIB directories.

## How it works

```text
Forecast Dataset Provider ──HTTP + SHA-256──▶ private GRIB copy
                                               │
                                  WebAssembly ecCodes
                                               │
                                  decoded .gribcache slices
                                               │
                                         Weather API
```

1. Discover complete `grib2` forecast resources through provider contract 0.1,
   with pagination. Unverified acquisitions are eligible: requested fields and
   bounds are never used as proof of actual meteorological coverage.
2. For each downloader source, select the newest model cycle, then the latest
   acquisition time. Other producers receive independent `dataset-<UUID>`
   provider names. Historical acquisitions remain owned by the catalogue;
   this consumer reads only the selected acquisition per source.
3. Follow version-bound asset URLs on the configured server, stream exact
   original bytes to private files, and check their lengths and SHA-256 hashes.
   Interrupted transfers resume at asset level. Neither redirects nor arbitrary
   asset origins receive the consumer token.
4. Convert all selected assets with the bundled
   [ecCodes WebAssembly build](https://github.com/meri-imperiumi/eccodes-wasm).
   Each asset's decoded slices become usable only after a complete conversion.
   A source switches forecasts only when all of its assets decode successfully.
5. Answer point queries using bilinear interpolation of four surrounding grid
   points, with the same Weather API mapping and SI units as previous versions.

The consumer uses a **readonly** application token. It does not create/delete
catalogue datasets, publish verified inventory or depend on unimplemented
provider processing/subsetting capabilities.

Extracted variables (when present): 10 m wind U/V, gust, 2 m temperature,
surface temperature / sea surface temperature, MSL pressure, 2 m relative
humidity, total precipitation, total cloud cover, and 850 hPa temperature
plus wind U/V (the inputs of the thermal front parameter method for
automatic surface-front detection).

Surface temperature fields are exposed as `water.temperature`, so clients can
display the value through the standard Weather API water-temperature field.
Warning: when a GRIB provides generic surface temperature rather than a true
sea-surface-temperature field, the value is also available over land. In that
case it should be read as surface temperature, not as actual water temperature.

Precipitation is de-cumulated within accumulation buckets and normalised to
**volume per hour**, so values are comparable across models and timestep sizes.
Catalogue mode uses one complete selected acquisition per source. Local mode
retains the existing newest-run-per-validity selection. Private original and
decoded caches are pruned after successful catalogue discovery/replacement.

## Requirements

- Signal K server **2.34 or later within 2.x** with the Weather API.
- Node.js **24+** for ecCodes WebAssembly memory64 support.
- Enabled **Forecast Dataset Provider 0.1.x** for catalogue mode.

No container runtime or external ecCodes image is needed by the plugin.

## Configuration

| Option | Description |
|---|---|
| `inputMode` | `catalogue` by default; `local` explicitly enables legacy directory scanning. |
| `catalogueUrl` | Signal K base URL, default `http://127.0.0.1:3000`. Remote servers require HTTPS. |
| `catalogueTokenFile` | Absolute path to a readonly application token, default `<plugin data directory>/catalogue-token`. Store with mode `0600` for the server user. The file is reread for token rotation; contents never enter status or logs. |
| `maxAssetBytes` | Maximum bytes per selected GRIB asset, default 2 GiB. |
| `maxCatalogueCacheBytes` | Maximum original bytes in one selected catalogue snapshot, default 8 GiB. This is not a total disk quota; old/new copies may coexist while transferring. |
| `rootDirectory` | Parent of source directories in **local mode only**, default `~/.signalk/gribs`. `~` is expanded. |
| `cacheRoot` | Decoded-cache root, default `<plugin data directory>/cache`. Catalogue mode uses its `catalogue/` child so legacy caches remain intact. |
| `scanIntervalMinutes` | Discovery and conversion interval, default 5 minutes. |
| `maxConcurrentIngests` | Conversion concurrency, default 2. Each job loads full grids into memory. |
| `sliceCacheSizeMB` | RAM budget for decoded point-query buffers, default 64 MiB. |

Approve a dedicated **readonly** device through Signal K's Access Requests API
and place its token in `catalogueTokenFile`. The sandbox installation helper
performs this setup for the explicitly selected sandbox. Keep this consumer's
token separate from the downloader's readwrite producer token.

`GET /plugins/signalk-grib-weather-provider/status` exposes input mode,
source slice counts, selected dataset IDs/content versions and refresh errors.
`POST /plugins/signalk-grib-weather-provider/refresh` starts a scan immediately
(202); overlapping refreshes share the running scan. These operational routes
use Signal K's default administrator access control.

Catalogue failure preserves the last complete, hash-verified local mirror and
decoded index, including across a restart. An unsupported or failed new GRIB
conversion preserves the previously working forecasts and reports an error.
Removal from a successful catalogue listing removes the corresponding Weather
API source and private caches. A failed listing never authorizes deletion.
Scans are serialized; plugin stop aborts HTTP transfers and waits for the scan.

Original bytes live in `<plugin data directory>/catalogue-assets/`. Content
versions and asset identities form cache names, so replacing an acquisition
cannot silently reuse slices from different original bytes. Old caches from
0.6.x remain available for an explicit switch back to local mode or rollback.

In local mode, each non-hidden subdirectory of `rootDirectory` becomes a source,
with `.grb2`, `.grib2`, `.grb` or `.grib` inputs. Local scan/forecast behavior is
otherwise unchanged. Failed conversions retry up to five times per file path
and process lifetime; a server restart or a new content version allows retry.

## Development and verification

```sh
npm ci
npm test
npm pack
```

Run on Node 24+ for the full suite. Older developer runtimes explicitly skip
WebAssembly functional tests. Tests cover real GRIB decoding from catalogue
HTTP assets, hashes, pagination, asset-level resume, offline restart, failed
replacement recovery, source deletion, serialization and cancellation.
See [sandbox verification](docs/sandbox-verification.md) for live deployment
and Weather API parity checks.

## Models

Any GRIB2 file on a **regular latitude/longitude grid** works. Tested with NOAA GFS
(0.25° and 0.5°). Arpège, Arome and ICON use regular grids in their public
distributions and should work, but have not been validated yet.

## Limitations

- `getObservations` and `getWarnings` return empty arrays (forecast data only).
- `daily` forecast requests return an empty array — GRIB slices are
  point-in-time values, only `point` forecasts are served.
- Only regular lat/lon grids are supported (no Lambert, no rotated poles).
- All messages in one GRIB file must share the same grid.

## License

Apache-2.0
