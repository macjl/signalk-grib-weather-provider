# Changelog

All notable changes to this project will be documented in this file.

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
