'use strict'

// End-to-end test of the WASM ecCodes ingest path against a real (small) GFS
// GRIB2 fixture committed to the repo. This is the scenario the native_eccodes
// PR was missing coverage for: ingest via the bundled ecCodes build with no
// signalk-container anywhere in the picture.

const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { ingestGribWasm, getEccodes } = require('../dist/ingest-wasm.js')
const { readCacheHeader, queryAtPosition } = require('../dist/grib-cache.js')

const FIXTURE = path.join(__dirname, 'fixtures', 'gfs.t00z.pgrb2.1p00.sample.grb2')

// The WASM build needs memory64, available from Node 24. On older runtimes the
// module simply cannot be instantiated — the detection below is used to skip
// (not silently pass) the functional test, so coverage stays honest.
let wasmOk = false
let wasmErr = null
before(async () => {
  try {
    await getEccodes()
    wasmOk = true
  } catch (err) {
    wasmErr = err
  }
})

let cacheDir
before(() => { cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grib-ingest-')) })
after(() => { fs.rmSync(cacheDir, { recursive: true, force: true }) })

test('ingestGribWasm: converts the GFS fixture to one .gribcache per validity time', async (t) => {
  if (!wasmOk) {
    t.skip(`eccodes-wasm not loadable on this runtime (Node ${process.version}): ${wasmErr ? wasmErr.message : 'unknown'}`)
    return
  }

  const logs = []
  await ingestGribWasm(FIXTURE, cacheDir, m => logs.push(m))

  const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.gribcache'))
  assert.strictEqual(files.length, 1, 'one slice for this single-timestep fixture')
  assert.strictEqual(
    files[0],
    'gfs.t00z.pgrb2.1p00.sample.t202608251800.gribcache',
    'filename encodes the validity time (f006 → 2026-08-25T18:00Z)'
  )
  assert.ok(logs.some(l => /Written .* bytes/.test(l)), 'logs the bytes written')
})

test('ingestGribWasm: cache header matches the GFS 1° grid and run', async (t) => {
  if (!wasmOk) { t.skip(`eccodes-wasm not loadable (Node ${process.version})`); return }

  const file = path.join(cacheDir, 'gfs.t00z.pgrb2.1p00.sample.t202608251800.gribcache')
  const meta = await readCacheHeader(file)

  assert.strictEqual(meta.validAt.toISOString(), '2026-08-25T18:00:00.000Z')
  assert.strictEqual(meta.refTime.toISOString(), '2026-08-25T12:00:00.000Z')
  assert.deepStrictEqual(meta.precipAccum, [0, 6], 'GFS f006 precip window is cumulative since run start')

  // GFS 1° global: 181×360, N→S (jScansPositively=false)
  assert.strictEqual(meta.grid.nLat, 181)
  assert.strictEqual(meta.grid.nLon, 360)
  assert.strictEqual(meta.grid.latFirst, 90)
  assert.strictEqual(meta.grid.lonFirst, 0)
  assert.strictEqual(meta.grid.dLat, 1)
  assert.strictEqual(meta.grid.dLon, 1)
  assert.strictEqual(meta.grid.jScansPositively, false)

  // All eight recognized fields, canonical order, no duplicates from the two
  // tp / two tcc messages present in the source file (first-match-wins).
  assert.deepStrictEqual(
    meta.vars,
    ['temp2m', 'pressure', 'humidity', 'windU', 'windV', 'gust', 'precip', 'cloudCover']
  )
})

test('ingestGribWasm: queried values are physically plausible', async (t) => {
  if (!wasmOk) { t.skip(`eccodes-wasm not loadable (Node ${process.version})`); return }

  const file = path.join(cacheDir, 'gfs.t00z.pgrb2.1p00.sample.t202608251800.gribcache')
  const meta = await readCacheHeader(file)

  const baltic = await queryAtPosition(file, meta, 59.5, 24.8)
  assert.ok(Object.keys(baltic).length === 8, 'all fields present at a covered point')
  // 2 m temperature in Kelvin — August Baltic: roughly 280–295 K
  assert.ok(baltic.temp2m > 270 && baltic.temp2m < 300, `temp2m ${baltic.temp2m}K`)
  // MSL pressure near 1000 hPa
  assert.ok(baltic.pressure > 95000 && baltic.pressure < 105000, `pressure ${baltic.pressure}Pa`)
  // Humidity is a fraction [0,1]
  assert.ok(baltic.humidity >= 0 && baltic.humidity <= 1, `humidity ${baltic.humidity}`)
  // Cloud cover is a fraction [0,1]
  assert.ok(baltic.cloudCover >= 0 && baltic.cloudCover <= 1, `cloudCover ${baltic.cloudCover}`)
  // Precip normalised to mm/h-equivalent: non-negative, modest
  assert.ok(baltic.precip >= 0, `precip ${baltic.precip}`)
})

test('ingestGribWasm: outside the grid coverage returns no values', async (t) => {
  if (!wasmOk) { t.skip(`eccodes-wasm not loadable (Node ${process.version})`); return }

  const file = path.join(cacheDir, 'gfs.t00z.pgrb2.1p00.sample.t202608251800.gribcache')
  const meta = await readCacheHeader(file)
  // 91°N is north of the first grid row (90°N) → outside coverage
  const outside = await queryAtPosition(file, meta, 91, 0)
  assert.strictEqual(Object.keys(outside).length, 0)
})

test('ingestGribWasm: rejects a file with no recognized variables', async (t) => {
  if (!wasmOk) { t.skip(`eccodes-wasm not loadable (Node ${process.version})`); return }

  const bogus = path.join(cacheDir, 'not-grib.grb2')
  fs.writeFileSync(bogus, Buffer.from('definitely not a GRIB file'))
  await assert.rejects(
    () => ingestGribWasm(bogus, cacheDir, () => {}),
    /No GRIB messages found in file/
  )
})
