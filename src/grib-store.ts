import * as fs from 'fs'
import * as path from 'path'
import { Position, WeatherData, WeatherForecastType, WeatherReqParams } from '@signalk/server-api'
import { CacheEntry, SourceConfig, TimeSlice } from './types'
import { readCacheHeader, queryAtPosition, queryAtPositionSync, evictStaleCache, clearGribCache, configureGribCache } from './grib-cache'
import { toWeatherData } from './weather-mapper'
import { ingestGrib, gribBasename, CACHE_FILE_RE, EXTRACTOR_REVISION } from './ingest-manager'

const DEFAULT_MAX_CONCURRENT_INGESTS = 2
const DEFAULT_SLICE_CACHE_MB = 64

export interface ScanSummary {
  sources: { name: string; slices: number; datasetId?: string; version?: string }[]
  errors: string[]
}

export interface GribStoreOptions {
  sourceProvider: (signal: AbortSignal) => Promise<{ sources: SourceConfig[]; errors: string[] }>
  snapshotFile?: string
  maxConcurrentIngests?: number
  sliceCacheSizeMB?: number
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

  private scanTask: Promise<void> | null = null
  private stopped = false
  private controller = new AbortController()
  private sourceProvider: GribStoreOptions['sourceProvider']
  private snapshotFile?: string
  private references = new Map<string, { datasetId?: string; version?: string }>()

  constructor(
    private cacheRoot: string,
    private log: (msg: string) => void,
    private onScan: ((summary: ScanSummary) => void) | undefined,
    options: GribStoreOptions
  ) {
    this.sourceProvider = options.sourceProvider
    this.snapshotFile = options.snapshotFile
    configureGribCache({
      maxBufferBytes: (options.sliceCacheSizeMB ?? DEFAULT_SLICE_CACHE_MB) * 1024 * 1024,
    })
    this.maxConcurrentIngests = options.maxConcurrentIngests ?? DEFAULT_MAX_CONCURRENT_INGESTS
  }

  private maxConcurrentIngests: number

  async start(scanIntervalMinutes = 5): Promise<void> {
    if (this.snapshotFile) {
      try {
        const saved = JSON.parse(await fs.promises.readFile(this.snapshotFile, 'utf8')) as {
          extractorRevision: string
          sources: Record<string, { files: string[]; datasetId?: string; version?: string }>
        }
        if (saved.extractorRevision !== EXTRACTOR_REVISION) throw new Error('Decoded forecast index needs rebuilding for the current extractor')
        for (const [name, source] of Object.entries(saved.sources)) {
          const entries: CacheEntry[] = []
          for (const filePath of source.files) {
            const relative = path.relative(this.cacheRoot, filePath)
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid saved cache path')
            const meta = await readCacheHeader(filePath)
            entries.push({ filePath, meta, validAtISO: meta.validAt.toISOString() })
          }
          this.index.set(name, entries)
          this.references.set(name, { datasetId: source.datasetId, version: source.version })
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`Cannot restore decoded forecast index: ${error}`) }
    }
    await this.scanAll()
    if (this.stopped) return
    this.scanTimer = setInterval(
      () => this.scanAll().catch(err => this.log(`Scan error: ${err}`)),
      scanIntervalMinutes * 60_000
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.controller.abort(new Error('Weather Provider stopped'))
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    clearGribCache()
    if (this.scanTask) { await this.scanTask; clearGribCache() }
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
          const v = queryAtPositionSync(p.filePath, p.meta, lat, lon)
            ?? await queryAtPosition(p.filePath, p.meta, lat, lon)
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
        // P3: buffered slices resolve synchronously (zero syscalls); only a
        // cold slice awaits open/read/prime.
        const values = queryAtPositionSync(entry.filePath, entry.meta, lat, lon)
          ?? await queryAtPosition(entry.filePath, entry.meta, lat, lon)
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

        const slice: TimeSlice = { validAt: entry.meta.validAt, validAtISO: entry.validAtISO, values }
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

  refresh(): Promise<void> { return this.scanAll() }

  private scanAll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (!this.scanTask) this.scanTask = this.doScanAll().finally(() => { this.scanTask = null })
    return this.scanTask
  }

  private async doScanAll(): Promise<void> {
    const summary: ScanSummary = { sources: [], errors: [] }
    let sources: SourceConfig[]
    try {
      const result = await this.sourceProvider(this.controller.signal)
      sources = result.sources
      summary.errors.push(...result.errors)
    } catch (err) {
      summary.errors.push(String(err))
      this.log(String(err))
      if (!this.stopped) {
        summary.sources = [...this.index].map(([name, entries]) => ({ name, slices: entries.length, ...this.references.get(name) }))
        this.onScan?.(summary)
      }
      return
    }

    for (const source of sources) {
      if (this.stopped) return
      try {
        const slices = await this.scanSource(source)
        this.references.set(source.name, { datasetId: source.datasetId, version: source.version })
        summary.sources.push({ name: source.name, slices, ...this.references.get(source.name) })
      } catch (err) {
        const msg = `Scan error for source "${source.name}": ${err}`
        this.log(msg)
        summary.errors.push(msg)
        summary.sources.push({ name: source.name, slices: this.index.get(source.name)?.length ?? 0, ...this.references.get(source.name) })
      }
    }

    if (this.stopped) return

    // Drop index entries and cache trees of sources removed from the catalogue.
    const names = new Set(sources.map(s => s.name))
    for (const name of [...this.index.keys()]) {
      if (!names.has(name)) {
        this.index.delete(name)
        this.references.delete(name)
        this.log(`Source "${name}" removed`)
      }
    }

    // Drop slice-cache entries whose cache files the scans have purged
    const evicted = evictStaleCache()
    if (evicted > 0) this.log(`Slice cache: dropped ${evicted} stale entr${evicted === 1 ? 'y' : 'ies'}`)

    try {
      for (const e of fs.readdirSync(this.cacheRoot, { withFileTypes: true })) {
        if (e.isDirectory() && !names.has(e.name)) {
          this.log(`Purging orphan cache tree: ${e.name}`)
          await fs.promises.rm(path.join(this.cacheRoot, e.name), { recursive: true, force: true })
            .catch(err => this.log(`Cannot purge cache tree ${e.name}: ${err}`))
        }
      }
    } catch { /* cacheRoot may not exist yet */ }

    if (this.snapshotFile) {
      const snapshot = Object.fromEntries([...this.index].map(([name, entries]) => [name, { files: entries.map(e => e.filePath), ...this.references.get(name) }]))
      await fs.promises.mkdir(path.dirname(this.snapshotFile), { recursive: true })
      await fs.promises.writeFile(this.snapshotFile + '.tmp', JSON.stringify({ extractorRevision: EXTRACTOR_REVISION, sources: snapshot }), { mode: 0o600 })
      await fs.promises.rename(this.snapshotFile + '.tmp', this.snapshotFile)
    }
    this.onScan?.(summary)
  }

  // In catalogue mode publish decoded slices only after an entire asset succeeds.
  private async ingestCatalogueAsset(gribPath: string, cacheDir: string): Promise<void> {
    const base = gribBasename(gribPath)
    const temporary = path.join(cacheDir, `.ingest-${base}`)
    await fs.promises.rm(temporary, { recursive: true, force: true })
    try {
      if (!(await ingestGrib(gribPath, temporary, this.log))) throw new Error(`Asset conversion unavailable: ${base}`)
      const files = (await fs.promises.readdir(temporary)).filter(f => CACHE_FILE_RE.test(f))
      if (!files.length) throw new Error(`No decoded slices for ${base}`)
      for (const file of files) await readCacheHeader(path.join(temporary, file))
      this.controller.signal.throwIfAborted()
      await fs.promises.mkdir(cacheDir, { recursive: true })
      for (const file of files) await fs.promises.rename(path.join(temporary, file), path.join(cacheDir, file))
      const receipt = path.join(cacheDir, `.${base}.complete`)
      await fs.promises.writeFile(receipt + '.tmp', JSON.stringify(files))
      await fs.promises.rename(receipt + '.tmp', receipt)
    } finally { await fs.promises.rm(temporary, { recursive: true, force: true }) }
  }

  // Returns the number of indexed slices for the source.
  private async scanSource(source: SourceConfig): Promise<number> {
    // Different extractors never overwrite a path held by a warm buffer or
    // pooled handle. A failed rebuild leaves the previous in-memory index usable.
    const cacheDir = path.join(source.cacheDirectory, EXTRACTOR_REVISION)
    const gribFiles = source.files
    const gribBasenames = new Set(gribFiles.map(gribBasename))

    // Only a completed conversion receipt authorizes reuse of decoded slices.
    let cacheListing: string[]
    try {
      cacheListing = fs.readdirSync(cacheDir)
    } catch {
      cacheListing = []  // cache dir may not exist yet — ingest creates it
    }
    const ingestedBasenames = new Set<string>()
    for (const base of gribBasenames) {
      try {
        const receipt = JSON.parse(fs.readFileSync(path.join(cacheDir, `.${base}.complete`), 'utf8')) as string[]
        if (receipt.length && receipt.every(file => CACHE_FILE_RE.exec(file)?.[1] === base && fs.existsSync(path.join(cacheDir, file)))) ingestedBasenames.add(base)
      } catch { /* retry incomplete conversions */ }
    }
    for (const f of cacheListing) {
      if (f.endsWith('.gribcache.tmp')) {
        // Leftover temp file from an interrupted ingest — remove when stale
        try {
          const st = fs.statSync(path.join(cacheDir, f))
          if (Date.now() - st.mtimeMs > 3600_000) {
            this.log(`Purging stale ingest temp file: ${f}`)
            fs.promises.unlink(path.join(cacheDir, f)).catch(() => {})
          }
        } catch { /* vanished meanwhile */ }
        continue
      }
    }

    // Ingest GRIB files that have no cache slices yet — bounded concurrency
    const toIngest = gribFiles.filter(g => !ingestedBasenames.has(gribBasename(g)))
    const failures: string[] = []
    await mapLimit(toIngest, this.maxConcurrentIngests, async gribPath => {
      if (this.stopped) return
      try {
        await this.ingestCatalogueAsset(gribPath, cacheDir)
      } catch (error) {
        failures.push(String(error))
        this.log(`Ingest failed for ${path.basename(gribPath)}: ${error}`)
      }
    })
    this.controller.signal.throwIfAborted()
    if (failures.length) throw new Error(`${failures.length} catalogue asset(s) could not be decoded; retaining previous forecasts`)

    // Re-read cache directory and build index
    let cacheFiles: string[]
    try {
      cacheFiles = fs.readdirSync(cacheDir)
        .filter(f => CACHE_FILE_RE.test(f) && gribBasenames.has(CACHE_FILE_RE.exec(f)![1]))
        .map(f => path.join(cacheDir, f))
    } catch {
      throw new Error(`Cannot read cache directory: ${cacheDir}`)
    }

    const parsed: CacheEntry[] = []
    for (const filePath of cacheFiles) {
      try {
        const meta = await readCacheHeader(filePath)
        parsed.push({ filePath, meta, validAtISO: meta.validAt.toISOString() })
      } catch (err) {
        const base = CACHE_FILE_RE.exec(path.basename(filePath))![1]
        await fs.promises.rm(path.join(cacheDir, `.${base}.complete`), { force: true })
        throw err
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

    this.controller.signal.throwIfAborted()
    this.index.set(source.name, entries)
    // Retire old extractor trees and pre-revision beta caches only after every
    // asset of the source has converted successfully.
    for (const file of await fs.promises.readdir(source.cacheDirectory)) {
      if ((/^extractor-v\d+$/.test(file) && file !== EXTRACTOR_REVISION) ||
          CACHE_FILE_RE.test(file) || /^\..+\.complete$/.test(file)) {
        await fs.promises.rm(path.join(source.cacheDirectory, file), { recursive: true, force: true })
      }
    }
    for (const file of await fs.promises.readdir(cacheDir)) {
      const base = CACHE_FILE_RE.exec(file)?.[1]
      const receiptBase = /^\.(.+)\.complete$/.exec(file)?.[1]
      if ((base && !gribBasenames.has(base)) || (receiptBase && !gribBasenames.has(receiptBase))) {
        await fs.promises.rm(path.join(cacheDir, file), { force: true })
      }
    }
    this.log(`Source "${source.name}": ${entries.length} slice(s) indexed (${parsed.length} cache files)`)
    return entries.length
  }
}
