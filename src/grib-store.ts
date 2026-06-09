import * as fs from 'fs'
import * as path from 'path'
import { Position, WeatherData, WeatherForecastType, WeatherReqParams } from '@signalk/server-api'
import { CacheEntry, SourceConfig, TimeSlice } from './types'
import { readCacheHeader, queryAtPosition } from './grib-cache'
import { toWeatherData } from './weather-mapper'
import { ingestGrib, cachePathFor, ensureImage, DEFAULT_ECCODES_IMAGE } from './ingest-manager'

const GRIB_EXTENSIONS = new Set(['.grb2', '.grib2', '.grb', '.grib'])

export class GribStore {
  // Per-source list of indexed .gribcache entries, sorted ascending by validAt
  private index = new Map<string, CacheEntry[]>()
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private eccodesImage: string

  constructor(
    private sources: SourceConfig[],
    private log: (msg: string) => void,
    eccodesImage?: string
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
    const entries = this.index.get(sourceName)
    if (!entries || entries.length === 0) return []

    const startDate = options.startDate
      ? new Date(options.startDate + 'T00:00:00Z')
      : new Date()

    let series = entries.filter(e => e.meta.validAt >= startDate)
    if (options.maxCount) series = series.slice(0, options.maxCount)

    const results: WeatherData[] = []
    for (const entry of series) {
      try {
        const values = await queryAtPosition(entry.filePath, entry.meta, position.latitude, position.longitude)
        if (Object.keys(values).length === 0) continue
        const slice: TimeSlice = { validAt: entry.meta.validAt, values }
        results.push(toWeatherData(slice, type))
      } catch (err) {
        this.log(`Query error for ${entry.filePath}: ${err}`)
      }
    }
    return results
  }

  private async scanAll(): Promise<void> {
    for (const source of this.sources) {
      await this.scanSource(source).catch(err =>
        this.log(`Scan error for source "${source.name}": ${err}`)
      )
    }
  }

  private async scanSource(source: SourceConfig): Promise<void> {
    const gribDir  = source.directory
    const cacheDir = source.cacheDirectory ?? gribDir

    // List GRIB files
    let gribFiles: string[]
    try {
      gribFiles = fs.readdirSync(gribDir)
        .filter(f => GRIB_EXTENSIONS.has(path.extname(f).toLowerCase()))
        .map(f => path.join(gribDir, f))
    } catch {
      this.log(`Cannot read directory for source "${source.name}": ${gribDir}`)
      return
    }

    // Trigger ingest for any GRIB file that doesn't have a .gribcache yet
    const ingestPromises = gribFiles.map(gribPath =>
      ingestGrib(gribPath, cacheDir, this.eccodesImage, this.log).catch(err =>
        this.log(`Ingest failed for ${path.basename(gribPath)}: ${err}`)
      )
    )
    await Promise.all(ingestPromises)

    // Re-read cache directory and build index
    let cacheFiles: string[]
    try {
      cacheFiles = fs.readdirSync(cacheDir)
        .filter(f => f.endsWith('.gribcache'))
        .map(f => path.join(cacheDir, f))
    } catch {
      this.log(`Cannot read cache directory for source "${source.name}": ${cacheDir}`)
      return
    }

    const entries: CacheEntry[] = []
    for (const filePath of cacheFiles) {
      try {
        const meta = await readCacheHeader(filePath)
        entries.push({ filePath, meta })
      } catch (err) {
        this.log(`Cannot read cache header ${path.basename(filePath)}: ${err}`)
      }
    }

    // Sort ascending by validity time
    entries.sort((a, b) => a.meta.validAt.getTime() - b.meta.validAt.getTime())

    this.index.set(source.name, entries)
    this.log(
      `Source "${source.name}": ${entries.length} cache file(s) indexed`
    )
  }
}
