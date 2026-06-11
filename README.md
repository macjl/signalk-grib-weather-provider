# signalk-grib-weather-provider

Signal K **Weather API provider** that serves forecasts from **local GRIB2 files**.
Each configured GRIB directory becomes an independent, selectable weather provider —
so you can expose, say, a short-term high-resolution model and a long-term global model
side by side, and pick one from any Weather API client (such as
[signalk-weather-map](https://github.com/macjl/signalk-weather-map)).

## How it works

```
GRIB2 files ──▶ eccodes container job ──▶ .gribcache files ──▶ Weather API
 (your dir)      (one-shot Docker run)     (one per forecast hour)   (point forecasts)
```

1. The plugin periodically scans each configured directory for GRIB2 files
   (`.grb2`, `.grib2`, `.grb`, `.grib`).
2. New files are converted by a short-lived container job (Python +
   [ecCodes](https://confluence.ecmwf.int/display/ECC)) into compact binary
   `.gribcache` files — **one per validity time**, so multi-timestep GRIB files are
   fully supported.
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
- The [signalk-container](https://github.com/dirkwa/signalk-container) plugin with a
  working container runtime (Docker or Podman) — declared via `signalk.requires`,
  so the App Store installs it automatically alongside this plugin
- The eccodes conversion image `ghcr.io/macjl/signalk-grib-eccodes:latest`
  (multi-arch amd64/arm64). It is pulled automatically on first use; you can also
  build it yourself from [`eccodes-container/`](eccodes-container/):

  ```sh
  docker build -t ghcr.io/macjl/signalk-grib-eccodes:latest eccodes-container/
  ```

## Configuration

Sources are **discovered**: every non-hidden subdirectory of the configured
root is served as a weather provider named after the directory
(`<root>/gfs-0p25` → provider `signalk-grib-weather-provider:gfs-0p25`).
Create a directory, drop GRIB2 files in it, done — or let
[signalk-grib-downloader](https://github.com/macjl/signalk-grib-downloader)
manage the directories for you (it derives names as `<model>-<resolution>`).

| Option | Description |
|---|---|
| **GRIB root directory** | Parent directory of all sources. Must be reachable from the container runtime (inside the Signal K data directory, or bind-mounted). |
| Cache root (optional) | Where `.gribcache` trees are written, mirroring source names. Defaults to the plugin data directory. Keep it outside the GRIB root. |
| **Scan interval** | How often to discover sources and look for new files (default 5 min). |
| Max concurrent ingests | Cap on simultaneous conversion containers (default 2). |
| **Eccodes image** | Override the conversion image (default `ghcr.io/macjl/signalk-grib-eccodes:latest`). |

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
