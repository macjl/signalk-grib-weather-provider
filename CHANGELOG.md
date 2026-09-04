# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0] — 2026-09-04

### Added
- Surface temperature / sea surface temperature extraction from GRIB `t` and
  `sst` surface fields, exposed as `water.temperature` in Weather API responses

## [0.4.1] — 2026-08-28

### Added
- App Store recommendations for `signalk-grib-downloader` and
  `signalk-weather-map`

## [0.4.0] — 2026-08-28

### Changed
- Weather point queries no longer pay per-slice file open/read/close on disk:
  decoded slice data is buffered in RAM (default 64 MB, configurable via the
  new `sliceCacheSizeMB` setting) and reused synchronously, so a point
  forecast becomes pure in-memory math after the first query of a run.
  Cache entries are dropped automatically when the scan purges their files.
  Slice files larger than 8 MB each (whole-globe 0.25° grids) are instead
  served through a pool of open file handles, removing the open/close churn
  on that path too. On the cold path the four bilinear corner reads are
  merged into two contiguous reads

### Fixed
- `validAt` ISO strings are memoized at scan time instead of being
  recomputed for every slice on every request
- Short reads from `.gribcache` files (truncated or mid-write files) are now
  detected and rejected instead of silently serving zeros
- Cache files are written atomically (temp file + rename), so a scan can no
  longer observe a half-written slice

## [0.3.0] — 2026-08-26

### Changed (breaking)
- GRIB→cache conversion now runs in-process through the WebAssembly build of
  ecCodes (`@meri-imperiumi/eccodes-wasm`) instead of a one-shot Docker
  container job. The `signalk-container` plugin and a container runtime are no
  longer required — `signalk.requires` and the `eccodesImage` setting have been
  removed, and the `eccodes-container/` directory (Dockerfile + `grib2cache.py`)
  has been deleted. The `.gribcache` binary format is unchanged, so existing
  caches remain valid and the two backends produce interchangeable output.

### Added
- TypeScript port of the conversion logic (`src/ingest-wasm.ts`) with message
  splitting and float32 encoding, backed by tests against a real GFS fixture
  committed under `test/fixtures/`

## [0.2.3] — 2026-07-02

### Changed
- Updated npm development dependencies, GitHub Actions, and the eccodes container base image
- Replaced the npm publish workflow with the common release-driven publish workflow

### Fixed
- Explicitly include Node.js types in the TypeScript configuration for TypeScript 6 compatibility

## [0.2.2] — 2026-06-11

### Changed
- `rootDirectory` defaults to `~/.signalk/gribs` — readable, and inside the mounted volume on containerized installs

## [0.2.1] — 2026-06-11

### Fixed
- `~` is now expanded in `rootDirectory` and `cacheRoot`
- `rootDirectory` gets a portable default (`<signalk-config>/gribs`) that is always reachable from the container runtime, containerized or not

## [0.2.0] — 2026-06-11

### Changed (breaking)
- Sources are now **discovered** from a single `rootDirectory`: every subdirectory is served as a provider named after the directory. The per-source configuration array (`sources`) is gone — replace it with `rootDirectory` (and optionally `cacheRoot`)
- Caches moved out of the GRIB directories: `.gribcache` trees live under `cacheRoot` (default: the plugin data directory), mirroring source names
- Providers register and unregister dynamically as directories appear and disappear — no restart needed

### Fixed
- Ingest concurrency is now bounded (`maxConcurrentIngests`, default 2) — previously all pending GRIB files of a source were converted in parallel, spawning dozens of simultaneous containers that could exhaust the host's memory and I/O
- `grib2cache.py` converts grids to float32 at read time and frees each slice after writing, halving the peak memory of a conversion job (an AROME SP1 package now converts within a 1 GB memory cap)

### Added
- shortName aliases: `max_i10fg` (AROME/ICON gust), `tcc|atmosphere` (NOMADS-filtered GFS cloud cover), `CLCT|surface` (ICON cloud cover)

## [0.1.0] — 2026-06-10

### Added
- Signal K Weather API provider backed by local GRIB2 files
- Multi-source: each configured GRIB directory registers as an independent weather provider (`signalk-grib-weather-provider:<source-id>`)
- GRIB → cache conversion via a one-shot eccodes container job (`ghcr.io/macjl/signalk-grib-eccodes`), managed through the signalk-container plugin
- `.gribcache` binary format v2: one file per validity time, with model run reference time and precipitation accumulation window in the header
- Multi-timestep GRIB files supported (one cache slice per validity time)
- Bilinear interpolation over the 4 surrounding grid points, disk-only reads (no grids in RAM)
- Longitude normalisation across the antimeridian
- Deduplication of overlapping runs — the most recent run wins per validity time
- Precipitation de-cumulation within accumulation buckets, normalised to volume per hour (comparable across models and timestep sizes)
- App Store screenshot; eccodes image tagged with the release version in addition to `latest`
- Automatic purge of orphaned and legacy cache files
- Ingest retry limit (5 attempts per file), then the file is ignored until restart
- Plugin status reporting after each scan (slice counts per source, error count)
- Unit tests (`node --test`) for cache parsing, interpolation and weather mapping
- `daily` forecast requests honestly return an empty array (only `point` forecasts are served)
