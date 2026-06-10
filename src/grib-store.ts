import * as fs from 'fs'
import * as path from 'path'
import { Position, WeatherData, WeatherForecastType, WeatherReqParams } from '@signalk/server-api'
import { CacheEntry, SourceConfig, TimeSlice } from './types'
import { readCacheHeader, queryAtPosition } from './grib-cache'
import { toWeatherData } from './weather-mapper'
import { ingestGrib, gribBasename, ensureImage, CACHE_FILE_RE, DEFAULT_ECCODES_IMAGE } from './ingest-manager'

const GRIB_EXTENSIONS = new Set(['.grb2', '.grib2', '.grb', '.grib'])

export interface ScanSummary {
  sources: { name: string; slices: number }[]
  errors: string[]
}

export class GribStore {
  // Per-source list of indexed .gribcache entries, deduplicated and sorted ascending by validAt
  private index = new Map<string, CacheEntry[]>()
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private eccodesImage: string

  constructor(
    private sources: SourceConfig[],
    private log: (msg: string) => void,
    eccodesImage?: string,
    private onScan?: (summary: ScanSummary) => void
  ) {
    this.eccodesImage = eccodesImage ?? DEFAULT_ECCODES_IMAGE
  }

  async start(scanIntervalMinutes = 5): Promise<void> {
    await ensureImage(this.eccodesImage, this.log).catch(err =>
      this.log(`Warning: could not verify eccodes image — ${err}`)
    )
    await this.scanAll()
    this.scanTimer = setInterval(
      () => this.scanAll().catch(err => this.log(`Scan error: ${err}`)),
      scanIntervalMinutes * 60_000
    )
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
  }

  // Called by each per-source provider registered in index.ts.
  async getForecastsForSource(
    sourceName: string,
    position: Position,
    type: WeatherForecastType,
    options: WeatherReqParams = {}
  ): Promise<WeatherData[]> {
    // GRIB slices are point-in-time values — we cannot honestly answer a
    // 'daily' (aggregated min/max) request, so return an empty result.
    if (type !== 'point') return []

    const entries = this.index.get(sourceName)
    if (!entries || entries.length === 0) return []

    const startDate = options.startDate
      ? new Date(options.startDate.includes('T') ? options.startDate : options.startDate + 'T00:00:00Z')
      : new Date()

    let startIdx = entries.findIndex(e => e.meta.validAt >= startDate)
    if (startIdx === -1) return []
    const endIdx = options.maxCount
      ? Math.min(entries.length, startIdx + options.maxCount)
      : entries.length

    const lat = position.latitude
    const lon = position.longitude

    // Precipitation handling. GRIB precip is accumulated over a window
    // [start, end] in forecast hours (precipAccum). Successive slices often
    // share the same window origin (GFS: [0,3], [0,6], [6,9], [6,12], …) —
    // subtracting the previous slice of the same run and bucket yields the
    // volume since that slice. The result is then normalised to volume per
    // hour so values are comparable across models and timestep sizes.
    let prev: { ref: number | null; accum: [number, number]; raw: number } | null = null

    // Seed with the slice just before the window, if it chains with the first one.
    const first = entries[startIdx]
    const firstAccum = first.meta.precipAccum
    if (startIdx > 0 && firstAccum !== null) {
      const p = entries[startIdx - 1]
      const pa = p.meta.precipAccum
      if (this.sameRun(p, first) && pa !== null && pa[0] === firstAccum[0] && pa[1] < firstAccum[1]) {
        try {
          const v = await queryAtPosition(p.filePath, p.meta, lat, lon)
          if (v['precip'] !== undefined) {
            prev = { ref: p.meta.refTime?.getTime() ?? null, accum: pa, raw: v['precip'] }
          }
        } catch { /* seed is best-effort */ }
      }
    }

    const results: WeatherData[] = []
    for (let i = startIdx; i < endIdx; i++) {
      const entry = entries[i]
      try {
        const values = await queryAtPosition(entry.filePath, entry.meta, lat, lon)
        if (Object.keys(values).length === 0) continue

        const rawPrecip = values['precip']
        const accum = entry.meta.precipAccum
        if (rawPrecip !== undefined && accum !== null) {
          const ref = entry.meta.refTime?.getTime() ?? null
          let stepVol = rawPrecip
          let windowH = accum[1] - accum[0]
          if (prev && ref !== null && prev.ref === ref &&
              prev.accum[0] === accum[0] && prev.accum[1] > accum[0] && prev.accum[1] < accum[1]) {
            stepVol = Math.max(0, rawPrecip - prev.raw)
            windowH = accum[1] - prev.accum[1]
          }
          values['precip'] = windowH > 0 ? stepVol / windowH : stepVol
          prev = { ref, accum, raw: rawPrecip }
        }
        // Unknown accumulation window: serve raw value, keep the chain as is.

        const slice: TimeSlice = { validAt: entry.meta.validAt, values }
        results.push(toWeatherData(slice, type))
      } catch (err) {
        this.log(`Query error for ${entry.filePath}: ${err}`)
      }
    }
    return results
  }

  private sameRun(a: CacheEntry, b: CacheEntry): boolean {
    const ra = a.meta.refTime?.getTime()
    const rb = b.meta.refTime?.getTime()
    return ra !== undefined && rb !== undefined && ra === rb
  }

  private async scanAll(): Promise<void> {
    const summary: ScanSummary = { sources: [], errors: [] }
    for (const source of this.sources) {
      try {
        const slices = await this.scanSource(source)
        summary.sources.push({ name: source.name, slices })
      } catch (err) {
        const msg = `Scan error for source "${source.name}": ${err}`
        this.log(msg)
        summary.errors.push(msg)
        summary.sources.push({ name: source.name, slices: this.index.get(source.name)?.length ?? 0 })
      }
    }
    this.onScan?.(summary)
  }

  // Returns the number of indexed slices for the source.
  private async scanSource(source: SourceConfig): Promise<number> {
    const gribDir  = source.directory
    const cacheDir = source.cacheDirectory ?? gribDir

    // List GRIB files → map basename → full path
    let gribFiles: string[]
    try {
      gribFiles = fs.readdirSync(gribDir)
        .filter(f => GRIB_EXTENSIONS.has(path.extname(f).toLowerCase()))
        .map(f => path.join(gribDir, f))
    } catch {
      throw new Error(`Cannot read directory: ${gribDir}`)
    }
    const gribBasenames = new Set(gribFiles.map(gribBasename))

    // Purge: remove cache files that are legacy-format (no .t<stamp> suffix)
    // or whose source GRIB no longer exists.
    let cacheListing: string[]
    try {
      cacheListing = fs.readdirSync(cacheDir)
    } catch {
      cacheListing = []  // cache dir may not exist yet — ingest creates it
    }
    const ingestedBasenames = new Set<string>()
    for (const f of cacheListing) {
      if (!f.endsWith('.gribcache')) continue
      const m = CACHE_FILE_RE.exec(f)
      if (m && gribBasenames.has(m[1])) {
        ingestedBasenames.add(m[1])
      } else {
        const stale = path.join(cacheDir, f)
        this.log(`Purging stale cache file: ${f}`)
        fs.promises.unlink(stale).catch(err => this.log(`Cannot purge ${f}: ${err}`))
      }
    }

    // Ingest GRIB files that have no cache slices yet
    const toIngest = gribFiles.filter(g => !ingestedBasenames.has(gribBasename(g)))
    await Promise.all(toIngest.map(gribPath =>
      ingestGrib(gribPath, cacheDir, this.eccodesImage, this.log).catch(err =>
        this.log(`Ingest failed for ${path.basename(gribPath)}: ${err}`)
      )
    ))

    // Re-read cache directory and build index
    let cacheFiles: string[]
    try {
      cacheFiles = fs.readdirSync(cacheDir)
        .filter(f => CACHE_FILE_RE.test(f))
        .map(f => path.join(cacheDir, f))
    } catch {
      throw new Error(`Cannot read cache directory: ${cacheDir}`)
    }

    const parsed: CacheEntry[] = []
    for (const filePath of cacheFiles) {
      try {
        const meta = await readCacheHeader(filePath)
        parsed.push({ filePath, meta })
      } catch (err) {
        // Unreadable or outdated format — delete so the GRIB gets re-ingested
        this.log(`Purging unreadable cache file ${path.basename(filePath)}: ${err}`)
        fs.promises.unlink(filePath).catch(() => {})
      }
    }

    // Deduplicate by validity time — the most recent run wins
    const byTime = new Map<number, CacheEntry>()
    for (const entry of parsed) {
      const t = entry.meta.validAt.getTime()
      const existing = byTime.get(t)
      if (!existing ||
          (entry.meta.refTime?.getTime() ?? 0) > (existing.meta.refTime?.getTime() ?? 0)) {
        byTime.set(t, entry)
      }
    }

    const entries = [...byTime.values()]
      .sort((a, b) => a.meta.validAt.getTime() - b.meta.validAt.getTime())

    this.index.set(source.name, entries)
    this.log(`Source "${source.name}": ${entries.length} slice(s) indexed (${parsed.length} cache files)`)
    return entries.length
  }
}
