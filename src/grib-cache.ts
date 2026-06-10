import * as fs from 'fs'
import { CacheFileMeta, GridMeta } from './types'

const MAGIC = Buffer.from('GRBC')
const VERSION = 2

// Parse the binary header of a .gribcache file. Does not load data.
export async function readCacheHeader(filePath: string): Promise<CacheFileMeta> {
  const fh = await fs.promises.open(filePath, 'r')
  try {
    const prefix = Buffer.allocUnsafe(9)  // magic(4) + version(1) + jsonLen(4)
    await fh.read(prefix, 0, 9, 0)

    if (!prefix.subarray(0, 4).equals(MAGIC)) {
      throw new Error(`Not a gribcache file: ${filePath}`)
    }
    if (prefix[4] !== VERSION) {
      throw new Error(`Unsupported gribcache version ${prefix[4]}: ${filePath}`)
    }

    const jsonLen = prefix.readUInt32BE(5)
    const jsonBuf = Buffer.allocUnsafe(jsonLen)
    await fh.read(jsonBuf, 0, jsonLen, 9)
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

// Read values for all variables at grid indices (j, i) using an already-open file handle.
// Clamped to grid bounds.
async function readPoint(
  fh: fs.promises.FileHandle,
  meta: CacheFileMeta,
  j: number,
  i: number
): Promise<Record<string, number>> {
  const { nLat, nLon } = meta.grid
  const jc = Math.max(0, Math.min(nLat - 1, j))
  const ic = Math.max(0, Math.min(nLon - 1, i))

  const byteOffset = meta.dataStart + (jc * nLon + ic) * meta.nVars * 4
  const buf = Buffer.allocUnsafe(meta.nVars * 4)
  await fh.read(buf, 0, meta.nVars * 4, byteOffset)

  const floats = new Float32Array(buf.buffer, buf.byteOffset, meta.nVars)
  const result: Record<string, number> = {}
  for (let k = 0; k < meta.nVars; k++) {
    const v = floats[k]
    if (!isNaN(v)) result[meta.vars[k]] = v
  }
  return result
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

// Read 4 surrounding grid points and return bilinearly interpolated values.
// Opens the file once, issues 4 parallel reads, closes.
export async function queryAtPosition(
  filePath: string,
  meta: CacheFileMeta,
  lat: number,
  lon: number
): Promise<Record<string, number>> {
  const c = cornerIndices(lat, lon, meta)
  if (!c) return {}  // position outside grid coverage

  const fh = await fs.promises.open(filePath, 'r')
  try {
    const [sw, se, nw, ne] = await Promise.all([
      readPoint(fh, meta, c.jSouth, c.iWest),
      readPoint(fh, meta, c.jSouth, c.iEast),
      readPoint(fh, meta, c.jNorth, c.iWest),
      readPoint(fh, meta, c.jNorth, c.iEast),
    ])

    const dLat = c.latNorth - c.latSouth
    const dLon = c.lonEast  - c.lonWest
    const dy = dLat > 0 ? (lat - c.latSouth)    / dLat : 0
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
  } finally {
    await fh.close()
  }
}
