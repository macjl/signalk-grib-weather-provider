import * as path from 'path'
import * as fs from 'fs'
import { createEccodes, Eccodes } from '@meri-imperiumi/eccodes-wasm'
import { GridMeta } from './types'

// One entry per recognized GRIB message: (shortName, typeOfLevel, level) →
// (cache field, scale). First matching definition per (validity time, field)
// wins — keep in sync with eccodes-container/grib2cache.py.
const PARAM_DEFS: [string, string, number, string, number][] = [
  ['2t',    'heightAboveGround', 2,  'temp2m',    1.0],
  ['prmsl', 'meanSea',           0,  'pressure',  1.0],
  ['sst',   'surface',           0,  'waterTemp', 1.0],
  ['t',     'surface',           0,  'waterTemp', 1.0],
  ['2r',    'heightAboveGround', 2,  'humidity',  0.01],
  ['r',     'heightAboveGround', 2,  'humidity',  0.01],
  ['10u',   'heightAboveGround', 10, 'windU',     1.0],
  ['u',     'heightAboveGround', 10, 'windU',     1.0],
  ['10v',   'heightAboveGround', 10, 'windV',     1.0],
  ['v',     'heightAboveGround', 10, 'windV',     1.0],
  ['gust',  'surface',           0,  'gust',      1.0],
  ['gust',  'heightAboveGround', 10, 'gust',      1.0],
  ['max_i10fg', 'heightAboveGround', 10, 'gust',  1.0],   // AROME / ICON
  ['tp',    'surface',           0,  'precip',    0.001],
  ['tcc',   'entireAtmosphere',  0,  'cloudCover', 0.01],
  ['tcc',   'atmosphere',        0,  'cloudCover', 0.01],  // GFS via NOMADS filter
  ['CLCT',  'surface',           0,  'cloudCover', 0.01],  // ICON
]

// Output field order (canonical)
const FIELD_ORDER = ['temp2m', 'pressure', 'waterTemp', 'humidity', 'windU', 'windV', 'gust', 'precip', 'cloudCover']

const LOOKUP = new Map<string, { field: string; scale: number }>()
for (const [sn, tol, lev, field, scale] of PARAM_DEFS) {
  const key = `${sn}|${tol}|${lev}`
  if (!LOOKUP.has(key)) LOOKUP.set(key, { field, scale })
}

interface SliceData {
  fields: Map<string, { scale: number; values: Float32Array }>
  precipAccum: [number, number] | null
}

// Shared WASM ecCodes instance — created once per process. The WASM module
// (and its ~40 MB heap) is too expensive to instantiate per ingest job.
let eccodesPromise: Promise<Eccodes> | null = null

// Loads (and caches) the WASM ecCodes instance. The promise rejects if the
// WASM build cannot run on this platform (e.g. Node.js < 24 lacks memory64).
export function getEccodes(): Promise<Eccodes> {
  if (!eccodesPromise) {
    eccodesPromise = createEccodes()
  }
  return eccodesPromise
}

// Drop the cached instance so the next getEccodes() retries — used after
// a failed ingest where the instance may be in an unusable state.
export function resetEccodes(): void {
  eccodesPromise = null
}

// Locate the message boundaries of a GRIB file: each message starts with the
// 'GRIB' magic and carries its own total length (GRIB1: octets 5-7, GRIB2:
// octets 9-16). Returns byte ranges; stops at the first invalid boundary.
export function splitGribMessages(buf: Buffer): { offset: number; length: number }[] {
  const messages: { offset: number; length: number }[] = []
  let offset = 0
  while (offset + 16 <= buf.length && buf.subarray(offset, offset + 4).toString('ascii') === 'GRIB') {
    const edition = buf[offset + 7]
    let length: number
    if (edition === 1) {
      length = buf.readUIntBE(offset + 4, 3)
    } else if (edition === 2) {
      length = Number(buf.readBigUInt64BE(offset + 8))
      if (!Number.isSafeInteger(length)) break
    } else {
      break
    }
    if (length <= 0 || offset + length > buf.length) break
    messages.push({ offset, length })
    offset += length
  }
  return messages
}

// Format eccodes dataDate (YYYYMMDD) + dataTime (HHMM or HMM) keys as ISO.
function ecDateToISO(date: number, time: number): string {
  const d = String(date)
  const t = String(time).padStart(4, '0')
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2)}:00Z`
}

// Encode one .gribcache slice (version 2) — see grib2cache.py for the format.
function encodeSlice(
  grid: GridMeta,
  refTime: string | null,
  validAt: string,
  slice: SliceData
): Buffer {
  const fieldsPresent = FIELD_ORDER.filter(f => slice.fields.has(f))
  if (fieldsPresent.length === 0) throw new Error('No recognized fields in slice')

  const meta = {
    ...grid,
    validAt,
    refTime,
    vars: fieldsPresent,
    precipAccum: slice.precipAccum,
  }
  const metaJson = Buffer.from(JSON.stringify(meta), 'utf-8')

  const nPoints = grid.nLat * grid.nLon
  const data = Buffer.alloc(nPoints * fieldsPresent.length * 4)
  for (let p = 0; p < nPoints; p++) {
    for (let v = 0; v < fieldsPresent.length; v++) {
      const { scale, values } = slice.fields.get(fieldsPresent[v])!
      data.writeFloatLE(values[p] * scale, (p * fieldsPresent.length + v) * 4)
    }
  }

  const header = Buffer.alloc(9)
  header.write('GRBC', 0, 'ascii')
  header.writeUInt8(2, 4)
  header.writeUInt32BE(metaJson.length, 5)
  return Buffer.concat([header, metaJson, data])
}

// Ingest a GRIB file using the WASM ecCodes build: produces one .gribcache
// per validity time in cacheDir. Port of `grib2cache.py` — the output format
// is byte-identical, so caches are interchangeable between backends.
export async function ingestGribWasm(
  gribPath: string,
  cacheDir: string,
  log: (m: string) => void
): Promise<void> {
  const eccodes = await getEccodes()

  // The WASM build exposes no multi-message file iterator: feed it one
  // message at a time via the in-memory filesystem. Reusing one path keeps
  // the WASM heap bounded regardless of the number of messages.
  const MEMFS_GRIB = '/msg.grib'

  let grid: GridMeta | null = null
  let refTime: string | null = null
  const slices = new Map<string, SliceData>()

  const buf = await fs.promises.readFile(gribPath)
  const messages = splitGribMessages(buf)
  if (messages.length === 0) throw new Error('No GRIB messages found in file')

  for (const { offset, length } of messages) {
    eccodes.writeFile(MEMFS_GRIB, new Uint8Array(buf.subarray(offset, offset + length)))
    const handle = eccodes.openGrib(MEMFS_GRIB)
    try {
      const sn = handle.getString('shortName')
      const tol = handle.getString('typeOfLevel')
      const lev = handle.getLong('level')
      const match = LOOKUP.get(`${sn}|${tol}|${lev}`)
      if (!match) continue

      const nLat = handle.getLong('Nj')
      const nLon = handle.getLong('Ni')
      if (grid === null) {
        grid = {
          latFirst: handle.getDouble('latitudeOfFirstGridPointInDegrees'),
          lonFirst: handle.getDouble('longitudeOfFirstGridPointInDegrees'),
          dLat:     handle.getDouble('jDirectionIncrementInDegrees'),
          dLon:     handle.getDouble('iDirectionIncrementInDegrees'),
          nLat,
          nLon,
          jScansPositively: handle.getLong('jScansPositively') !== 0,
        }
      } else if (nLat !== grid.nLat || nLon !== grid.nLon) {
        // All slices must share the same grid — skip mismatching messages
        log(`Skipping ${sn}/${tol}/${lev}: grid mismatch`)
        continue
      }

      if (refTime === null) {
        refTime = ecDateToISO(handle.getLong('dataDate'), handle.getLong('dataTime'))
      }
      const validAt = ecDateToISO(handle.getLong('validityDate'), handle.getLong('validityTime'))

      let slice = slices.get(validAt)
      if (!slice) {
        slice = { fields: new Map(), precipAccum: null }
        slices.set(validAt, slice)
      }
      if (slice.fields.has(match.field)) continue  // already have a higher-priority source

      if (match.field === 'precip') {
        try {
          slice.precipAccum = [handle.getLong('startStep'), handle.getLong('endStep')]
        } catch { /* accumulation window not available */ }
      }

      // Convert to float32 immediately — halves the memory held while the
      // rest of the (possibly multi-timestep) file is read.
      slice.fields.set(match.field, { scale: match.scale, values: Float32Array.from(handle.getDoubleArray('values')) })
    } finally {
      handle.delete()  // WASM memory has no garbage collector
    }
  }

  if (grid === null || slices.size === 0) {
    throw new Error('No recognized variables found in GRIB file')
  }

  await fs.promises.mkdir(cacheDir, { recursive: true })
  const basename = path.basename(gribPath, path.extname(gribPath))

  let written = 0
  for (const validAt of [...slices.keys()].sort()) {
    const slice = slices.get(validAt)!
    const data = encodeSlice(grid, refTime, validAt, slice)
    const stamp = validAt.replace(/[-:T]/g, '').slice(0, 12)
    const outPath = path.join(cacheDir, `${basename}.t${stamp}.gribcache`)
    // Atomic write: a scan must never observe a half-written cache file —
    // the slice cache could buffer it (short reads are guarded, but a
    // complete-looking truncated file is worse: it would serve zeros).
    const tmpPath = `${outPath}.tmp`
    await fs.promises.writeFile(tmpPath, data)
    await fs.promises.rename(tmpPath, outPath)
    log(`Written ${data.length.toLocaleString('en-US')} bytes → ${outPath}`)
    written++
  }
  if (written === 0) throw new Error('No slices written')
}
