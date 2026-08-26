import * as fs from 'fs'
import * as path from 'path'
import { Position, WeatherData, WeatherForecastType, WeatherReqParams } from '@signalk/server-api'
import { CacheEntry, SourceConfig, TimeSlice } from './types'
import { readCacheHeader, queryAtPosition } from './grib-cache'
import { toWeatherData } from './weather-mapper'
import { ingestGrib, gribBasename, CACHE_FILE_RE } from './ingest-manager'

const GRIB_EXTENSIONS = new Set(['.grb2', '.grib2', '.grb', '.grib'])
const DEFAULT_MAX_CONCURRENT_INGESTS = 2

export interface ScanSummary {
  sources: { name: string; slices: number }[]
  errors: string[]
}

// Run fn over items with at most `limit` concurrent executions.
// Each ingest loads full model grids in memory — unbounded parallelism can
// exhaust the host (tens of GRIB files arrive per run).
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    let item: T | undefined
    while ((item = queue.shift()) !== undefined) {
      await fn(item)
    }
  })
  await Promise.all(workers)
}

export class GribStore {
  // Per-source list of indexed .gribcache entries, deduplicated and sorted ascending by validAt
  private index = new Map<string, CacheEntry[]>()
  private scanTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private rootDirectory: string,
    private cacheRoot: string,
    private log: (msg: string) => void,
    private onScan?: (summary: ScanSummary) => void,
    private maxConcurrentIngests: number = DEFAULT_MAX_CONCURRENT_INGESTS
  ) {}

  // Each non-hidden subdirectory of rootDirectory is a source. Its name is
  // the provider ID suffix and display name; caches mirror it under cacheRoot.
  private discoverSources(): SourceConfig[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.rootDirectory, { withFileTypes: true })
    } catch {
      throw new Error(`Cannot read root directory: ${this.rootDirectory}`)
    }
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        directory: path.join(this.rootDirectory, e.name),
        cacheDirectory: path.join(this.cacheRoot, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async start(scanIntervalMinutes = 5): Promise<void> {
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
    let sources: SourceConfig[]
    try {
      sources = this.discoverSources()
    } catch (err) {
      summary.errors.push(String(err))
      this.log(String(err))
      this.onScan?.(summary)
      return
    }

    for (const source of sources) {
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

    // Drop index entries and cache trees of sources whose directory is gone
    const names = new Set(sources.map(s => s.name))
    for (const name of [...this.index.keys()]) {
      if (!names.has(name)) {
        this.index.delete(name)
        this.log(`Source "${name}" removed`)
      }
    }
    try {
      for (const e of fs.readdirSync(this.cacheRoot, { withFileTypes: true })) {
        if (e.isDirectory() && !names.has(e.name)) {
          this.log(`Purging orphan cache tree: ${e.name}`)
          fs.promises.rm(path.join(this.cacheRoot, e.name), { recursive: true, force: true })
            .catch(err => this.log(`Cannot purge cache tree ${e.name}: ${err}`))
        }
      }
    } catch { /* cacheRoot may not exist yet */ }

    this.onScan?.(summary)
  }

  // Returns the number of indexed slices for the source.
  private async scanSource(source: SourceConfig): Promise<number> {
    const gribDir  = source.directory
    const cacheDir = source.cacheDirectory

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

    // Ingest GRIB files that have no cache slices yet — bounded concurrency
    const toIngest = gribFiles.filter(g => !ingestedBasenames.has(gribBasename(g)))
    await mapLimit(toIngest, this.maxConcurrentIngests, gribPath =>
      ingestGrib(gribPath, cacheDir, this.log).then(() => {}).catch(err =>
        this.log(`Ingest failed for ${path.basename(gribPath)}: ${err}`)
      )
    )

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
