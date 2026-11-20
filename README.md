# signalk-grib-weather-provider

Signal K **Weather API provider** that decodes immutable GRIB2 acquisitions from
[Forecast Dataset Provider](https://github.com/macjl/signalk-forecast-dataset-provider).
It reads the catalogue directly in the same Signal K instance, keeps a private
verified copy of the selected assets, and serves the standard Weather API from
decoded local caches.

Downloader sources keep their selectable provider IDs, for example
`signalk-grib-weather-provider:gfs-0p25`, so existing Weather API clients such as
[signalk-weather-map](https://github.com/macjl/signalk-weather-map) keep working.
The catalogue is the only input. Shared GRIB directory scanning is no longer supported.

**Upgrade together:** update Forecast Dataset Provider to 0.4.0 or later before
upgrading this plugin. If you also use GRIB Downloader, update it to 0.8.0 or
later. See the [historical upgrade guide](docs/upgrading.md) for the transition
from the 0.6.x shared-directory releases.

## How it works

```text
Forecast Dataset Provider ──local access──▶ verified private GRIB copy
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
3. Stream the version's original assets to private files and check their
   lengths and SHA-256 hashes. Interrupted transfers resume at asset level.
4. Convert all selected assets with the bundled
   [ecCodes WebAssembly build](https://github.com/meri-imperiumi/eccodes-wasm).
   Each asset's decoded slices become usable only after a complete conversion.
   A source switches forecasts only when all of its assets decode successfully.
5. Answer point queries using bilinear interpolation of four surrounding grid
   points, with the same Weather API mapping and SI units as previous versions.

The consumer uses the catalogue's read operations without a token.

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
The provider uses one complete selected acquisition per source. Private original and
decoded caches are pruned after successful catalogue discovery/replacement.

## Requirements

- Signal K server **2.34 or later within 2.x** with the Weather API.
- Node.js **24+** for ecCodes WebAssembly memory64 support.
- Enabled **Forecast Dataset Provider 0.4.0 or later** on the same Signal K server.

No container runtime or external ecCodes image is needed by the plugin.

## Configuration

| Option | Description |
|---|---|
| `maxAssetMB` | Maximum size per selected GRIB asset, default 2000 MB. 1 MB = 1,000,000 bytes; decimals are allowed. |
| `maxCatalogueCacheMB` | Maximum combined original file sizes in one selected catalogue snapshot, default 8000 MB. This is not a total disk quota; old/new copies may coexist while transferring. |
| `cacheRoot` | Decoded-cache root, default `<plugin data directory>/cache`. Its `catalogue/` child holds decoded acquisitions. |
| `scanIntervalMinutes` | Discovery and conversion interval, default 5 minutes. |
| `maxConcurrentIngests` | Conversion concurrency, default 2. Each job loads full grids into memory. |
| `sliceCacheSizeMB` | RAM budget for decoded point-query buffers, default 64 MiB. |

Size limits now use **MB** (1 MB = 1,000,000 bytes). The former byte-valued
settings are ignored; there is no migration. Configure the new MB fields or
leave their new defaults of 2000 and 8000 MB.

The plugin waits for a compatible Forecast Dataset Provider in the same
Signal K instance. Previous catalogue URL and token settings are ignored.
To use GRIBs from another Signal K server, configure it as a download
source in GRIB Downloader. Once published locally, those datasets are
available to the Weather Provider.

`GET /plugins/signalk-grib-weather-provider/status` exposes the catalogue
transport (`local` or `waiting`), source slice counts, selected dataset
IDs/content versions and refresh errors.
`POST /plugins/signalk-grib-weather-provider/refresh` starts a scan immediately
(202); overlapping refreshes share the running scan. These operational routes
use Signal K's default administrator access control.

Catalogue failure preserves the last complete, hash-verified local mirror and
decoded index, including across a restart. An unsupported or failed new GRIB
conversion preserves the previously working forecasts and reports an error.
Removal from a successful catalogue listing removes the corresponding Weather
API source and private caches. A failed listing never authorizes deletion.
Scans are serialized. Stopping the plugin aborts asset transfers and waits for
the scan.

Original bytes live in `<plugin data directory>/catalogue-assets/`. Content
versions and asset identities form cache names, so replacing an acquisition
cannot silently reuse slices from different original bytes. Old caches from
0.6.x are left untouched for a rollback to the previous plugin version.

Decoded caches and saved indexes also carry an extractor revision. An extractor
change rebuilds slices from the unchanged private GRIB mirror, including offline,
under different paths so old buffers and pooled handles cannot alias new output.
A source's old extractor tree is removed only after its full rebuild succeeds.
Developers must bump `EXTRACTOR_REVISION` when changing extraction rules, fields,
the cache layout or the ecCodes decoder. The first stable release rebuilds beta
decoded caches once; it does not re-download already mirrored originals.

When upgrading from a shared directory, install a compatible Dataset Provider. Old
`inputMode` and `rootDirectory` configuration fields are ignored; they never
enable directory scanning or a fallback when the catalogue is unavailable.
Existing files must be published by a catalogue producer before they are eligible.
Failed conversions retry up to five times per file path
and process lifetime; a server restart or a new content version allows retry.

## Development and verification

```sh
npm ci
npm test
npm pack
```

Run on Node 24+ for the full suite. Older developer runtimes explicitly skip
WebAssembly functional tests. Tests cover real GRIB decoding from catalogue
assets, hashes, pagination, asset-level resume, offline restart, failed
replacement recovery, source deletion, serialization and cancellation. A real
GRIB regression test replaces a regional asset with a global asset under the
same original asset name, checks warm-cache invalidation and an offline restart.
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
