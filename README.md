# signalk-grib-weather-provider

Signal K **Weather API provider** that serves forecasts from **local GRIB2 files**.
Each configured GRIB directory becomes an independent, selectable weather provider —
so you can expose, say, a short-term high-resolution model and a long-term global model
side by side, and pick one from any Weather API client (such as
[signalk-weather-map](https://github.com/macjl/signalk-weather-map)).

## How it works

```
GRIB2 files ──▶ WebAssembly ecCodes ──▶ .gribcache files ──▶ Weather API
 (your dir)    (in-process conversion)    (one per forecast hour)   (point forecasts)
```

1. The plugin periodically scans each configured directory for GRIB2 files
   (`.grb2`, `.grib2`, `.grb`, `.grib`).
2. New files are converted **in-process** by a WebAssembly build of
   [ecCodes](https://confluence.ecmwf.int/display/ECC)
   ([`@meri-imperiumi/eccodes-wasm`](https://github.com/meri-imperiumi/eccodes-wasm))
   into compact binary `.gribcache` files — **one per validity time**, so
   multi-timestep GRIB files are fully supported. No Docker, no containers, no
   external image to pull — the converter ships as a normal npm dependency.
3. Forecast queries are answered by reading only the 4 grid points surrounding the
   requested position (bilinear interpolation) — nothing is kept in RAM.

Extracted variables (when present): 10 m wind U/V, gust, 2 m temperature,
MSL pressure, 2 m relative humidity, total precipitation, total cloud cover.

Precipitation is de-cumulated within accumulation buckets and normalised to
**volume per hour**, so values are comparable across models and timestep sizes.
When two runs overlap, the most recent run wins for each validity time. Cache
files whose source GRIB has been deleted are purged automatically.

## Requirements

- Signal K server ≥ 2.x (Weather API)
- Node.js ≥ 24 (the WebAssembly build of ecCodes uses the 64-bit memory feature,
  available from Node 24). On older runtimes the plugin cannot convert GRIB files —
  upgrade your Signal K server's Node.

No other plugin, container runtime, or external image is required.

## Configuration

Sources are **discovered**: every non-hidden subdirectory of the configured
root is served as a weather provider named after the directory
(`<root>/gfs-0p25` → provider `signalk-grib-weather-provider:gfs-0p25`).
Create a directory, drop GRIB2 files in it, done — or let
[signalk-grib-downloader](https://github.com/macjl/signalk-grib-downloader)
manage the directories for you (it derives names as `<model>-<resolution>`).

| Option | Description |
|---|---|
| **GRIB root directory** | Parent directory of all sources. `~` is expanded. |
| Cache root (optional) | Where `.gribcache` trees are written, mirroring source names. Defaults to the plugin data directory. Keep it outside the GRIB root. |
| **Scan interval** | How often to discover sources and look for new files (default 5 min). |
| Max concurrent ingests | Cap on simultaneous in-process conversions (default 2). Each conversion loads full model grids into memory — keep low on small systems. |

New files are picked up at the next scan; sources appear and disappear with
their directories, without restarting. A GRIB file that fails to convert is
retried at most 5 times, then ignored until restart.

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
