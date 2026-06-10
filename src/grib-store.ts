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

    // Precipitation de-cumulation: when precip is accumulated from run start
    // (precipAccum[0] === 0), the per-step volume is the difference with the
    // previous slice of the same run. Track the previous slice's raw value.
    let prevPrecip: number | undefined
    let prevRefTime: number | null = null

    // Seed with the slice just before the window, if it belongs to the same run.
    const first = entries[startIdx]
    if (startIdx > 0 && this.cumulativePrecip(first)) {
      const prev = entries[startIdx - 1]
      if (this.sameRun(prev, first)) {
        try {
          const v = await queryAtPosition(prev.filePath, prev.meta, lat, lon)
          prevPrecip  = v['precip']
          prevRefTime = prev.meta.refTime?.getTime() ?? null
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
        if (rawPrecip !== undefined && this.cumulativePrecip(entry)) {
          const ref = entry.meta.refTime?.getTime() ?? null
          if (prevPrecip !== undefined && ref !== null && ref === prevRefTime) {
            values['precip'] = Math.max(0, rawPrecip - prevPrecip)
          }
          // else: first slice of a run — the cumulative value IS the step value
        }
        prevPrecip  = rawPrecip
        prevRefTime = entry.meta.refTime?.getTime() ?? null

        const slice: TimeSlice = { validAt: entry.meta.validAt, values }
        results.push(toWeatherData(slice, type))
      } catch (err) {
        this.log(`Query error for ${entry.filePath}: ${err}`)
      }
    }
    return results
  }

  private cumulativePrecip(e: CacheEntry): boolean {
    // precipAccum [0, N] = accumulated since run start → needs de-cumulation.
    // [M, N] with M > 0 = interval bucket → already a per-step volume.
    // Unknown window → serve as-is.
    return e.meta.precipAccum !== null && e.meta.precipAccum[0] === 0
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
