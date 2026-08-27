import * as fs from 'fs'
import { CacheFileMeta, GridMeta } from './types'

const MAGIC = Buffer.from('GRBC')
const VERSION = 2

// Files whose data section fits under this size are buffered whole in RAM;
// anything larger (whole-globe 0.25° slices, ~30 MB) is served through a
// pooled open file handle instead, so a single huge slice cannot blow the
// byte budget.
const MAX_BUFFERED_FILE_BYTES = 8 * 1024 * 1024
// Cap on pooled open file handles — stays well under typical fd limits.
const MAX_OPEN_HANDLES = 96
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// P1: module-level slice caches, keyed by file path.
//
// Small slice files are read once into a Float32Array (byte-budgeted LRU) and
// all subsequent point queries are pure in-memory math. Oversized files keep
// an open FileHandle in a smaller LRU so even their cold path stops paying
// open/close per query. Invalidation is driven by the store's scan cycle via
// evictStaleCache(): new GRIB runs land under new file names, so a cached
// path whose file has disappeared is simply dead.
// ---------------------------------------------------------------------------

interface BufferEntry {
  floats: Float32Array  // data section: row-major points, var-interleaved float32
  bytes: number
}

interface HandleEntry {
  fh: fs.promises.FileHandle
}

let maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES
// Insertion order doubles as LRU order — access re-inserts at the end.
const buffers = new Map<string, BufferEntry>()
const handles = new Map<string, HandleEntry>()
let bufferBytes = 0

// In-flight primes, deduplicated per path so concurrent point requests
// (the weather map fires ~15 in parallel) read each slice file only once.
const priming = new Map<string, Promise<'buffered' | 'handle' | 'none'>>()

// Set the RAM budget for buffered slices (from plugin settings / tests).
export function configureGribCache(options: { maxBufferBytes?: number }): void {
  if (options.maxBufferBytes === undefined) return
  maxBufferBytes = options.maxBufferBytes
  evictToBudget(0)
}

// Snapshot for tests and debug logging.
export function gribCacheStats(): { buffers: number; bufferedBytes: number; handles: number } {
  return { buffers: buffers.size, bufferedBytes: bufferBytes, handles: handles.size }
}

// Drop every cached buffer and close every pooled handle (plugin stop, tests).
export function clearGribCache(): void {
  buffers.clear()
  bufferBytes = 0
  for (const { fh } of handles.values()) fh.close().catch(() => {})
  handles.clear()
  priming.clear()
}

// Drop cached entries whose backing file no longer exists — the store's scan
// purges stale cache files after every ingest cycle. Returns evicted count.
export function evictStaleCache(): number {
  let evicted = 0
  for (const p of [...buffers.keys()]) {
    if (!fs.existsSync(p)) {
      bufferBytes -= buffers.get(p)!.bytes
      buffers.delete(p)
      evicted++
    }
  }
  for (const p of [...handles.keys()]) {
    if (!fs.existsSync(p)) {
      const { fh } = handles.get(p)!
      handles.delete(p)
      fh.close().catch(() => {})
      evicted++
    }
  }
  return evicted
}

// Evict least-recently-used buffers until `needed` bytes fit the budget.
function evictToBudget(needed: number): void {
  while (bufferBytes + needed > maxBufferBytes && buffers.size > 0) {
    const oldest = buffers.keys().next().value as string
    bufferBytes -= buffers.get(oldest)!.bytes
    buffers.delete(oldest)
  }
}

function touchBuffer(filePath: string): BufferEntry | undefined {
  const entry = buffers.get(filePath)
  if (entry) {
    buffers.delete(filePath)
    buffers.set(filePath, entry)
  }
  return entry
}

async function getOrCreateHandle(filePath: string): Promise<fs.promises.FileHandle> {
  const existing = handles.get(filePath)
  if (existing) {
    handles.delete(filePath)
    handles.set(filePath, existing)  // refresh LRU position
    return existing.fh
  }
  while (handles.size >= MAX_OPEN_HANDLES) {
    const oldest = handles.keys().next().value as string
    const { fh } = handles.get(oldest)!
    handles.delete(oldest)
    fh.close().catch(() => {})
  }
  const fh = await fs.promises.open(filePath, 'r')
  handles.set(filePath, { fh })
  return fh
}

// P4: `fs.promises.read` may return fewer bytes than requested (truncated or
// mid-write file). Never serve a partial read silently.
async function readExact(fh: fs.promises.FileHandle, buf: Buffer, position: number): Promise<void> {
  const { bytesRead } = await fh.read(buf, 0, buf.length, position)
  if (bytesRead !== buf.length) {
    throw new Error(`Short read (${bytesRead}/${buf.length} bytes)`)
  }
}

// Ensure a cache entry exists for the slice: buffered whole if small, open
// handle if oversized, 'none' if the file is missing or incomplete.
function primeCache(filePath: string, meta: CacheFileMeta): Promise<'buffered' | 'handle' | 'none'> {
  let p = priming.get(filePath)
  if (!p) {
    p = doPrime(filePath, meta).finally(() => priming.delete(filePath))
    priming.set(filePath, p)
  }
  return p
}

async function doPrime(filePath: string, meta: CacheFileMeta): Promise<'buffered' | 'handle' | 'none'> {
  const dataSize = meta.grid.nLat * meta.grid.nLon * meta.nVars * 4

  // Buffer path: read the whole data section once, then zero syscalls.
  if (dataSize <= MAX_BUFFERED_FILE_BYTES && dataSize <= maxBufferBytes) {
    const floats = new Float32Array(dataSize / 4)
    try {
      const fh = await fs.promises.open(filePath, 'r')
      try {
        await readExact(fh, Buffer.from(floats.buffer, floats.byteOffset, dataSize), meta.dataStart)
      } finally {
        await fh.close()
      }
      buffers.delete(filePath)
      evictToBudget(dataSize)
      buffers.set(filePath, { floats, bytes: dataSize })
      bufferBytes += dataSize
      return 'buffered'
    } catch { /* short read / vanished file — fall through to the handle path */ }
  }

  // Handle path: oversized slices. Require a complete file on disk.
  try {
    const st = await fs.promises.stat(filePath)
    if (st.size >= meta.dataStart + dataSize) {
      await getOrCreateHandle(filePath)
      return 'handle'
    }
  } catch { /* file gone */ }
  return 'none'
}

// Parse the binary header of a .gribcache file. Does not load data.
export async function readCacheHeader(filePath: string): Promise<CacheFileMeta> {
  const fh = await fs.promises.open(filePath, 'r')
  try {
    const prefix = Buffer.allocUnsafe(9)  // magic(4) + version(1) + jsonLen(4)
    await readExact(fh, prefix, 0)

    if (!prefix.subarray(0, 4).equals(MAGIC)) {
      throw new Error(`Not a gribcache file: ${filePath}`)
    }
    if (prefix[4] !== VERSION) {
      throw new Error(`Unsupported gribcache version ${prefix[4]}: ${filePath}`)
    }

    const jsonLen = prefix.readUInt32BE(5)
    const jsonBuf = Buffer.allocUnsafe(jsonLen)
    await readExact(fh, jsonBuf, 9)
    const m = JSON.parse(jsonBuf.toString('utf-8'))

    const grid: GridMeta = {
      latFirst: m.latFirst,
      lonFirst: m.lonFirst,
      dLat:     m.dLat,
      dLon:     m.dLon,
      nLat:     m.nLat,
      nLon:     m.nLon,
      jScansPositively: m.jScansPositively,
    }
    return {
      validAt:     new Date(m.validAt),
      refTime:     m.refTime ? new Date(m.refTime) : null,
      precipAccum: Array.isArray(m.precipAccum) ? [m.precipAccum[0], m.precipAccum[1]] : null,
      grid,
      vars:        m.vars as string[],
      nVars:       m.vars.length,
      dataStart:   9 + jsonLen,
    }
  } finally {
    await fh.close()
  }
}

// Read values for all variables at grid indices (j, i) from a buffered
// slice. Clamped to grid bounds.
function valuesAt(floats: Float32Array, meta: CacheFileMeta, j: number, i: number): Record<string, number> {
  const { nLat, nLon } = meta.grid
  const jc = Math.max(0, Math.min(nLat - 1, j))
  const ic = Math.max(0, Math.min(nLon - 1, i))

  const base = (jc * nLon + ic) * meta.nVars
  const result: Record<string, number> = {}
  for (let k = 0; k < meta.nVars; k++) {
    const v = floats[base + k]
    if (!isNaN(v)) result[meta.vars[k]] = v
  }
  return result
}

// P2: read the two horizontally adjacent points (i, i+1) of row j in one
// read — the columns are contiguous in the row-major var-interleaved layout.
async function readRowPair(
  fh: fs.promises.FileHandle,
  meta: CacheFileMeta,
  j: number,
  iWest: number
): Promise<[Record<string, number>, Record<string, number>]> {
  const nVars = meta.nVars
  const floats = new Float32Array(nVars * 2)
  const offset = meta.dataStart + (j * meta.grid.nLon + iWest) * nVars * 4
  await readExact(fh, Buffer.from(floats.buffer, floats.byteOffset, nVars * 8), offset)

  const west: Record<string, number> = {}
  const east: Record<string, number> = {}
  for (let k = 0; k < nVars; k++) {
    const w = floats[k]
    if (!isNaN(w)) west[meta.vars[k]] = w
    const e = floats[nVars + k]
    if (!isNaN(e)) east[meta.vars[k]] = e
  }
  return [west, east]
}

// Compute the 4 surrounding grid cell corner indices and coordinates for (lat, lon).
// Returns null if the point lies outside the grid coverage area.
function cornerIndices(lat: number, lon: number, meta: CacheFileMeta) {
  const { latFirst, lonFirst, dLat, dLon, nLat, nLon, jScansPositively } = meta.grid

  // Latitude bounds check
  const latMin = jScansPositively ? latFirst : latFirst - (nLat - 1) * dLat
  const latMax = jScansPositively ? latFirst + (nLat - 1) * dLat : latFirst
  if (lat < latMin || lat > latMax) return null

  // Normalise lon to [lonFirst, lonFirst+360)
  let normLon = lon
  while (normLon < lonFirst) normLon += 360
  while (normLon >= lonFirst + 360) normLon -= 360

  // Longitude bounds check
  const lonMax = lonFirst + (nLon - 1) * dLon
  if (normLon < lonFirst || normLon > lonMax) return null

  let jSouth: number, jNorth: number, latSouth: number, latNorth: number

  if (!jScansPositively) {
    // N→S grid (GFS): j=0 is northernmost, lat decreases with j
    const jN = Math.floor((latFirst - lat) / dLat)
    jNorth = Math.max(0, Math.min(nLat - 2, jN))
    jSouth = jNorth + 1
    latNorth = latFirst - jNorth * dLat
    latSouth = latFirst - jSouth * dLat
  } else {
    // S→N grid: j=0 is southernmost
    const jS = Math.floor((lat - latFirst) / dLat)
    jSouth = Math.max(0, Math.min(nLat - 2, jS))
    jNorth = jSouth + 1
    latSouth = latFirst + jSouth * dLat
    latNorth = latFirst + jNorth * dLat
  }

  const iW = Math.floor((normLon - lonFirst) / dLon)
  const iWest = Math.max(0, Math.min(nLon - 2, iW))
  const iEast = iWest + 1
  const lonWest = lonFirst + iWest * dLon
  const lonEast = lonFirst + iEast * dLon

  return { jSouth, jNorth, iWest, iEast, latSouth, latNorth, lonWest, lonEast, normLon }
}

type Corners = NonNullable<ReturnType<typeof cornerIndices>>

// Bilinearly interpolate the 4 corner value records for (lat, lon).
function interpolate(
  c: Corners,
  lat: number,
  sw: Record<string, number>,
  se: Record<string, number>,
  nw: Record<string, number>,
  ne: Record<string, number>
): Record<string, number> {
  const dLat = c.latNorth - c.latSouth
  const dLon = c.lonEast  - c.lonWest
  const dy = dLat > 0 ? (lat - c.latSouth)      / dLat : 0
  const dx = dLon > 0 ? (c.normLon - c.lonWest) / dLon : 0

  const allKeys = new Set([
    ...Object.keys(sw), ...Object.keys(se),
    ...Object.keys(nw), ...Object.keys(ne),
  ])

  const result: Record<string, number> = {}
  for (const key of allKeys) {
    const vSW = sw[key], vSE = se[key], vNW = nw[key], vNE = ne[key]
    if (vSW !== undefined && vSE !== undefined && vNW !== undefined && vNE !== undefined) {
      result[key] =
        (1 - dx) * (1 - dy) * vSW +
        dx       * (1 - dy) * vSE +
        (1 - dx) * dy       * vNW +
        dx       * dy       * vNE
    } else {
      const fallback = vSW ?? vSE ?? vNW ?? vNE
      if (fallback !== undefined) result[key] = fallback
    }
  }
  return result
}

// P3: synchronous fast path — answers from the slice buffer with zero
// syscalls and zero awaits. Returns null when the slice is not buffered
// (the caller then falls back to the async queryAtPosition, which primes).
// A buffered slice queried outside its coverage returns {} (not null).
export function queryAtPositionSync(
  filePath: string,
  meta: CacheFileMeta,
  lat: number,
  lon: number
): Record<string, number> | null {
  const entry = touchBuffer(filePath)
  if (!entry) return null

  const c = cornerIndices(lat, lon, meta)
  if (!c) return {}  // position outside grid coverage

  return interpolate(
    c, lat,
    valuesAt(entry.floats, meta, c.jSouth, c.iWest),
    valuesAt(entry.floats, meta, c.jSouth, c.iEast),
    valuesAt(entry.floats, meta, c.jNorth, c.iWest),
    valuesAt(entry.floats, meta, c.jNorth, c.iEast)
  )
}

// Read 4 surrounding grid points and return bilinearly interpolated values.
// Buffered slices (the common case after the first query of a run) resolve
// synchronously; otherwise the slice is primed — buffered if small, served
// through a pooled open handle if oversized — and the cold path reads the
// two adjacent corner pairs with one read per row (P2).
export async function queryAtPosition(
  filePath: string,
  meta: CacheFileMeta,
  lat: number,
  lon: number
): Promise<Record<string, number>> {
  const sync = queryAtPositionSync(filePath, meta, lat, lon)
  if (sync !== null) return sync

  const c = cornerIndices(lat, lon, meta)
  if (!c) return {}  // outside coverage — nothing to prime

  const mode = await primeCache(filePath, meta)
  if (mode === 'buffered') {
    const warm = queryAtPositionSync(filePath, meta, lat, lon)
    if (warm !== null) return warm
  }

  // Oversized ('handle') or unprimable ('none') file: query through an open
  // handle (pooled when possible) with the short-read guard in force.
  const pooled = mode === 'handle' ? handles.get(filePath) : undefined
  const fh = pooled?.fh ?? await fs.promises.open(filePath, 'r')
  try {
    const [[sw, se], [nw, ne]] = await Promise.all([
      readRowPair(fh, meta, c.jSouth, c.iWest),
      readRowPair(fh, meta, c.jNorth, c.iWest),
    ])
    return interpolate(c, lat, sw, se, nw, ne)
  } finally {
    if (!pooled) await fh.close()
  }
}
