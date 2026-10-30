# Changelog

## [0.7.0] - 2026-10-30

- First stable catalogue-based Weather API provider with verified private
  originals, offline restart support and automatic readonly access requests.
- Breaking upgrade from 0.6.x: require Node 24+, Forecast Dataset Provider 0.1.0
  and the coordinated Downloader 0.4.0 upgrade; shared-file scanning is removed.
- Version decoded caches and saved indexes by extractor revision. Rebuild
  unchanged originals after extractor changes without re-downloading, using new
  paths to avoid stale warm buffers and pooled handles. Retain the prior working
  source on a failed rebuild, and retire old trees only after a full success.
- Cover both same-name content replacement and extractor upgrades from #16.
- Replace the timing-sensitive warm/cold performance assertion with direct
  checks that warm queries return identical forecasts without filesystem I/O.
- Add docs/upgrading.md covering approvals, beta upgrades and rollback.

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.7.0-beta.3] - 2026-10-21

- Configure catalogue size limits in decimal MB (1 MB = 1,000,000 bytes), with
  defaults of 2000 MB per asset and 8000 MB per selected snapshot.
- Remove the old byte-valued settings without migrating or converting them.
- Validate positive finite limits and enforce the exact decimal-byte boundary
  before downloading oversized assets.

## [0.7.0-beta.2] - 2026-10-21

- Request catalogue access automatically through Signal K Access Requests when
  no token is configured; require administrator approval with this plugin's
  least-privilege permissions and persist the token privately.
- Resume pending requests across restarts, report waiting/denied states and
  resume catalogue work immediately after approval. Stop polling on plugin stop.
- Renew automatically issued tokens rejected with HTTP 401 while preserving
  manually configured or concurrently rotated tokens.
- Cover the access lifecycle, plugin startup and approval-driven resumption;
  validate both permission levels against an actual Signal K server.

## [0.7.0-beta.1] - 2026-10-21

- Discover complete GRIB forecast datasets through Forecast Dataset Provider
  contract 0.1; keep existing downloader source Weather API identifiers.
- Use authenticated readonly HTTP, version-bound URLs, streaming transfers,
  exact lengths and SHA-256 validation, with asset-level restart recovery.
- Keep private original/decoded caches keyed by dataset content version. Select
  the newest acquisition per downloader source; never write catalogue storage.
- Persist working forecasts across catalogue outages and restarts. A failed new
  conversion keeps the previous index; complete source replacements are atomic.
- Serialize scans, abort transfers and await ongoing scans on stop; expose
  operational status and immediate-refresh endpoints.
- Use the catalogue as the only input; remove local directory scanning and its
  `inputMode`/`rootDirectory` settings. Require Forecast Dataset Provider and Node 24+.
- Cover changed content under the same original asset name, including warmed
  slice buffers, replacement coverage and offline restart (PR #17 scenario).
- Add catalogue transport/lifecycle tests and real GRIB-to-Weather API coverage.


## [0.6.0] - 2026-10-20

### Added
- **850 hPa temperature and wind U/V in the grid cache** (`temp850`,
  `windU850`, `windV850`), extracted from GFS/ECMWF isobaric GRIB messages
  when present. These are the inputs of the thermal front parameter method
  for automatic surface-front detection (e.g. front-passage timing in
  signalk-passage-briefing); they are not mapped into the Weather API point
  responses. The cache format is unchanged and backward compatible: caches
  written before this change keep their field list and read as before.

### Changed
- Updated development dependencies (`@signalk/server-api` and `@types/node`).
- Removed obsolete Dependabot Docker updates for the deleted ecCodes container.

### Known limitations and upgrade notes
- Existing decoded caches are not automatically rebuilt when a GRIB file is
  replaced under the same basename or when extraction fields change. Newly
  decoded GRIB files include the 850 hPa fields when present, but existing caches
  may require manual regeneration to expose them. Automatic cache invalidation
  is tracked in [#16](https://github.com/macjl/signalk-grib-weather-provider/issues/16).
- The new 850 hPa fields are available through the grid cache only; Weather API
  point responses are unchanged.

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
