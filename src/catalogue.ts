// Read-only client for Forecast Dataset Provider's experimental contract 0.1.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SourceConfig } from './types'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
// Retain the cache identity used by existing local installations.
export const LOCAL_CATALOGUE_CACHE_KEY = 'http://127.0.0.1:3000'
export const WAITING_FOR_LOCAL_CATALOGUE = 'Waiting for Forecast Dataset Provider with local catalogue support'

interface LocalCatalogueReader {
  contractVersion: string
  datasets(query: Record<string, string>): unknown
  dataset(id: string, version: string): unknown
  readAsset(id: string, version: string, asset: string, signal: AbortSignal): Readable
}

const localKey = Symbol.for('macjl.forecast-datasets.catalogues.v1')
function findLocalCatalogue(scope: string): LocalCatalogueReader | undefined {
  const service = (globalThis as typeof globalThis & { [localKey]?: Map<string, LocalCatalogueReader> })[localKey]?.get(scope)
  // Older versions can accept local publications but do not expose discovery.
  return typeof service?.datasets === 'function' ? service : undefined
}

interface Asset { id: string; size: number; sha256: string }
interface Dataset {
  id: string; version: string; producer: string; format: string; state: string; kind: string
  run?: string; createdAt: string; requested?: { source?: string }; assets: Asset[]
}
interface Mirror { endpoint: string; datasets: Dataset[] }
export interface CatalogueOptions { directory: string; cacheRoot: string; localScope: string; maxAssetMB?: number; maxCatalogueCacheMB?: number }

function megabytes(value: number): number {
  const bytes = Math.floor(value * 1_000_000)
  if (!Number.isFinite(value) || !Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Catalogue MB limits must be positive numbers within the supported byte range')
  return bytes
}

export class CatalogueClient {
  private verified = new Set<string>()
  private maxAssetBytes: number
  private maxCacheBytes: number

  constructor(private options: CatalogueOptions, private log: (message: string) => void) {
    this.maxAssetBytes = megabytes(options.maxAssetMB ?? 2000)
    this.maxCacheBytes = megabytes(options.maxCatalogueCacheMB ?? 8000)
  }

  get connection(): 'local' | 'waiting' {
    return findLocalCatalogue(this.options.localScope) ? 'local' : 'waiting'
  }

  private manifest(): string { return path.join(this.options.directory, 'mirror.json') }
  private folder(dataset: Dataset): string { return path.join(this.options.directory, dataset.id, dataset.version) }
  private assetFile(dataset: Dataset, asset: Asset): string {
    // Names include content version and asset identity; decoded caches never alias a replacement run.
    return path.join(this.folder(dataset), `${dataset.id}-${dataset.version}-${createHash('sha256').update(asset.id).digest('hex')}.grib2`)
  }
  private sourceName(dataset: Dataset): string {
    const source = dataset.requested?.source
    return dataset.producer === 'signalk-grib-downloader' && typeof source === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(source)
      ? source : `dataset-${dataset.id}`
  }
  private validate(dataset: Dataset): void {
    if (!UUID.test(dataset.id) || !HASH.test(dataset.version) || dataset.format !== 'grib2' || dataset.state !== 'complete' || dataset.kind !== 'forecast' || !Number.isFinite(Date.parse(dataset.createdAt)) || !Array.isArray(dataset.assets) || !dataset.assets.length || dataset.assets.length > 1024) throw new Error('Invalid GRIB dataset detail')
    const ids = new Set<string>()
    for (const asset of dataset.assets) {
      if (typeof asset.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(asset.id) || ids.has(asset.id) || !HASH.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > this.maxAssetBytes) throw new Error('Invalid or oversized catalogue asset')
      ids.add(asset.id)
    }
  }
  private sources(datasets: Dataset[]): SourceConfig[] {
    return datasets.map(dataset => ({
      name: this.sourceName(dataset),
      cacheDirectory: path.join(this.options.cacheRoot, this.sourceName(dataset)),
      files: dataset.assets.map(a => this.assetFile(dataset, a)),
      datasetId: dataset.id, version: dataset.version,
    }))
  }
  private async validFile(dataset: Dataset, asset: Asset, signal: AbortSignal): Promise<boolean> {
    const file = this.assetFile(dataset, asset)
    try {
      const stat = await fs.promises.lstat(file)
      if (!stat.isFile() || stat.size !== asset.size) { this.verified.delete(file); return false }
      if (this.verified.has(file)) return true
      const hash = createHash('sha256')
      for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk)
      if (hash.digest('hex') !== asset.sha256) return false
      this.verified.add(file)
      return true
    } catch (error) {
      signal.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return false
    }
  }
  private async download(dataset: Dataset, asset: Asset, signal: AbortSignal, local: LocalCatalogueReader): Promise<void> {
    if (await this.validFile(dataset, asset, signal)) return
    const file = this.assetFile(dataset, asset), part = file + '.part'
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const content = local.readAsset(dataset.id, dataset.version, asset.id, signal)
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > asset.size) return callback(new Error('Catalogue asset exceeds its declared size'))
      hash.update(chunk); callback(null, chunk)
    } })
    try {
      await pipeline(content, meter, fs.createWriteStream(part, { mode: 0o600 }), { signal })
      if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('Catalogue asset length or SHA-256 mismatch')
      await fs.promises.rename(part, file)
      this.verified.add(file)
      this.log(`Catalogue: received ${asset.id} (${size} bytes)`)
    } finally { await fs.promises.rm(part, { force: true }) }
  }

  async refresh(signal: AbortSignal): Promise<{ sources: SourceConfig[]; errors: string[] }> {
    try {
      const local = findLocalCatalogue(this.options.localScope)
      if (!local) throw new Error(WAITING_FOR_LOCAL_CATALOGUE)
      if (local.contractVersion !== '0.1') throw new Error('Forecast catalogue contract 0.1 is required')
      const candidates: Dataset[] = [], seen = new Set<string>()
      for (let offset = 0; ; offset += 100) {
        signal.throwIfAborted()
        if (offset >= 10000) throw new Error('Catalogue discovery limit exceeded')
        const filters = { format: 'grib2', kind: 'forecast', state: 'complete', limit: '100', offset: String(offset) }
        const page = local.datasets(filters)
        if (!page || Array.isArray(page) || typeof page !== 'object') throw new Error('Invalid catalogue listing')
        const entries = Object.entries(page) as [string, { version: string }][]
        for (const [id, summary] of entries) {
          if (!UUID.test(id) || !HASH.test(summary.version) || seen.has(id)) throw new Error('Catalogue changed during pagination; retry discovery')
          seen.add(id)
          const detail = local.dataset(id, summary.version) as Dataset
          this.validate(detail)
          if (detail.id !== id || detail.version !== summary.version) throw new Error('Catalogue detail identity mismatch')
          candidates.push(detail)
        }
        if (entries.length < 100) break
      }
      const selected = new Map<string, Dataset>()
      const newer = (a: Dataset, b: Dataset): boolean => {
        const run = (d: Dataset) => { const n = Date.parse(d.run ?? ''); return Number.isFinite(n) ? n : -Infinity }
        if (run(a) !== run(b)) return run(a) > run(b)
        if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) > Date.parse(b.createdAt)
        return a.id > b.id
      }
      for (const dataset of candidates) {
        const name = this.sourceName(dataset), previous = selected.get(name)
        if (!previous || newer(dataset, previous)) selected.set(name, dataset)
      }
      const datasets = [...selected.values()].sort((a,b) => this.sourceName(a).localeCompare(this.sourceName(b)))
      let total = 0
      for (const dataset of datasets) for (const asset of dataset.assets) total += asset.size
      if (!Number.isSafeInteger(total) || total > this.maxCacheBytes) throw new Error('Selected catalogue assets exceed the local cache byte limit')
      for (const dataset of datasets) for (const asset of dataset.assets) { signal.throwIfAborted(); await this.download(dataset, asset, signal, local) }
      signal.throwIfAborted()
      await fs.promises.mkdir(this.options.directory, { recursive: true })
      const manifest: Mirror = { endpoint: LOCAL_CATALOGUE_CACHE_KEY, datasets }
      await fs.promises.writeFile(this.manifest() + '.tmp', JSON.stringify(manifest), { mode: 0o600 })
      await fs.promises.rename(this.manifest() + '.tmp', this.manifest())
      // Only a complete successful discovery authorizes removal of old private copies.
      const keep = new Set(datasets.map(d => this.folder(d)))
      for (const id of await fs.promises.readdir(this.options.directory)) {
        if (!UUID.test(id)) continue
        const directory = path.join(this.options.directory, id)
        for (const version of await fs.promises.readdir(directory)) {
          const full = path.join(directory, version)
          if (HASH.test(version) && !keep.has(full)) {
            await fs.promises.rm(full, { recursive: true, force: true })
            for (const cached of this.verified) if (cached.startsWith(full + path.sep)) this.verified.delete(cached)
          }
        }
      }
      return { sources: this.sources(datasets), errors: [] }
    } catch (error) {
      signal.throwIfAborted()
      this.log(String(error))
      // Persisted original content supports restart during a catalogue outage.
      let mirror: Mirror
      try { mirror = JSON.parse(await fs.promises.readFile(this.manifest(), 'utf8')) as Mirror } catch { throw error }
      if (mirror.endpoint !== LOCAL_CATALOGUE_CACHE_KEY) throw new Error('Cached catalogue belongs to another server')
      for (const dataset of mirror.datasets) {
        this.validate(dataset)
        for (const asset of dataset.assets) if (!(await this.validFile(dataset, asset, signal))) throw new Error('Cached catalogue asset is missing or damaged')
      }
      return { sources: this.sources(mirror.datasets), errors: [`Catalogue unavailable; using last verified local copy: ${String(error)}`] }
    }
  }
}
