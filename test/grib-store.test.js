'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { GribStore } = require('../dist/grib-store.js')
const { EXTRACTOR_REVISION } = require('../dist/ingest-manager.js')
const { gribCacheStats, clearGribCache } = require('../dist/grib-cache.js')

// 3×3 grid, S→N, lat 40..42, lon 350..352 (≈ -10..-8 — crosses the
// antimeridian of the [-180,180] convention)
const GRID = {
  latFirst: 40, lonFirst: 350, dLat: 1, dLon: 1, nLat: 3, nLon: 3,
  jScansPositively: true,
}
const stamp = d => d.toISOString().replace(/\D/g, '').slice(0, 12)
const catalogues = new Map()

// Write one synthetic .gribcache slice into cacheDir.
// values: (j, i, varIdx) → number (NaN allowed)
function writeSlice(cacheDir, basename, slice) {
  const meta = {
    ...GRID,
    validAt: slice.validAt,
    refTime: slice.refTime ?? null,
    precipAccum: slice.precipAccum ?? null,
    vars: slice.vars,
  }
  const json = Buffer.from(JSON.stringify(meta), 'utf-8')
  const nPoints = GRID.nLat * GRID.nLon
  const nVars = slice.vars.length
  const data = Buffer.alloc(nPoints * nVars * 4)
  for (let j = 0; j < GRID.nLat; j++) {
    for (let i = 0; i < GRID.nLon; i++) {
      for (let k = 0; k < nVars; k++) {
        data.writeFloatLE(slice.values(j, i, k), ((j * GRID.nLon + i) * nVars + k) * 4)
      }
    }
  }
  const header = Buffer.alloc(9)
  header.write('GRBC', 0, 'ascii')
  header.writeUInt8(2, 4)
  header.writeUInt32BE(json.length, 5)
  const filePath = path.join(cacheDir, `${basename}.t${stamp(new Date(slice.validAt))}.gribcache`)
  fs.writeFileSync(filePath, Buffer.concat([header, json, data]))
  const slices = fs.readdirSync(cacheDir).filter(file => file.startsWith(`${basename}.t`) && file.endsWith('.gribcache'))
  fs.writeFileSync(path.join(cacheDir, `.${basename}.complete`), JSON.stringify(slices))
  return filePath
}

// Supply an explicit catalogue acquisition and completed decoded slices.
function makeSource(root, cacheRoot, name, basename, slices) {
  fs.mkdirSync(path.join(root, name), { recursive: true })
  fs.writeFileSync(path.join(root, name, `${basename}.grib2`), Buffer.alloc(0))
  const sourceCacheDir = path.join(cacheRoot, name)
  const cacheDir = path.join(sourceCacheDir, EXTRACTOR_REVISION)
  fs.mkdirSync(cacheDir, { recursive: true })
  for (const slice of slices) writeSlice(cacheDir, basename, slice)
  const sources = catalogues.get(root) ?? []
  sources.push({ name, files: [path.join(root, name, `${basename}.grib2`)], cacheDirectory: sourceCacheDir,
    datasetId: '00000000-0000-4000-8000-000000000001', version: 'a'.repeat(64) })
  catalogues.set(root, sources)
  return cacheDir
}

const newStore = (root, cacheRoot) =>
  new GribStore(cacheRoot, () => {}, undefined, {
    sliceCacheSizeMB: 1,
    sourceProvider: async () => ({ sources: catalogues.get(root) ?? [], errors: [] }),
  })

const POS = { latitude: 41, longitude: -9 }  // ≡ (41, 351) in the grid frame

let tmp
test.before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gribstore-')) })
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

test('forecasts: interpolation, wind mapping and per-hour precip chain', async () => {
  clearGribCache()
  const root = fs.mkdtempSync(path.join(tmp, 'root-'))
  const cacheRoot = fs.mkdtempSync(path.join(tmp, 'cache-'))
  const vars = ['temp2m', 'windU', 'windV', 'gust', 'precip', 'waterTemp']
  const mk = (validAt, precipAccum, precipRaw) => ({
    validAt,
    refTime: '2026-06-10T00:00:00Z',
    precipAccum,
    vars,
    // temp2m = j*10+i ; wind (3,4) → speed 5 ; gust 9 ; precip raw ; water 288 K
    values: (j, i, k) => (k === 0 ? j * 10 + i : k === 1 ? 3 : k === 2 ? 4 : k === 3 ? 9 : k === 4 ? precipRaw : 288),
  })
  const cacheDir = makeSource(root, cacheRoot, 'gfs', 'run', [
    mk('2026-06-10T06:00:00Z', [0, 6], 0.6),
    mk('2026-06-10T12:00:00Z', [0, 12], 1.8),
    mk('2026-06-10T18:00:00Z', [0, 18], 3.6),
  ])

  const store = newStore(root, cacheRoot)
  try {
    await store.start(120)
    const forecasts = await store.getForecastsForSource('gfs', POS, 'point', { startDate: '2026-06-10' })

    assert.deepStrictEqual(forecasts.map(f => f.date), [
      '2026-06-10T06:00:00.000Z', '2026-06-10T12:00:00.000Z', '2026-06-10T18:00:00.000Z',
    ])

    for (const f of forecasts) {
      assert.ok(Math.abs(f.outside.temperature - 11) < 1e-6)  // j=1, i=1
      assert.ok(Math.abs(f.wind.speedTrue - 5) < 1e-6)
      assert.strictEqual(f.wind.gust, 9)
      assert.strictEqual(f.water.temperature, 288)
    }
    // Precip normalised to volume per hour: 0.6/6, (1.8-0.6)/6, (3.6-1.8)/6
    // (tolerance covers float32 storage rounding of the raw values)
    assert.ok(Math.abs(forecasts[0].outside.precipitationVolume - 0.1) < 1e-6)
    assert.ok(Math.abs(forecasts[1].outside.precipitationVolume - 0.2) < 1e-6)
    assert.ok(Math.abs(forecasts[2].outside.precipitationVolume - 0.3) < 1e-6)

    // Window filtering
    const two = await store.getForecastsForSource('gfs', POS, 'point', { startDate: '2026-06-10', maxCount: 2 })
    assert.strictEqual(two.length, 2)
    const afternoon = await store.getForecastsForSource('gfs', POS, 'point', { startDate: '2026-06-10T07:00:00Z' })
    assert.deepStrictEqual(afternoon.map(f => f.date), ['2026-06-10T12:00:00.000Z', '2026-06-10T18:00:00.000Z'])

    // GRIB slices cannot answer aggregated 'daily' requests
    assert.deepStrictEqual(await store.getForecastsForSource('gfs', POS, 'daily', {}), [])

    // Queries served via the slice buffers
    assert.strictEqual(gribCacheStats().buffers, 3)
  } finally {
    await store.stop()
  }
})

test('rescan drops removed slices and evicts their cache buffers', async () => {
  clearGribCache()
  const root = fs.mkdtempSync(path.join(tmp, 'root-'))
  const cacheRoot = fs.mkdtempSync(path.join(tmp, 'cache-'))
  const vars = ['temp2m']
  const slice = validAt => ({
    validAt, refTime: '2026-06-10T00:00:00Z', precipAccum: null, vars,
    values: (j, i) => j * 10 + i,
  })
  const cacheDir = makeSource(root, cacheRoot, 'gfs', 'a', [slice('2026-06-10T06:00:00Z')])
  writeSlice(cacheDir, 'b', slice('2026-06-10T12:00:00Z'))
  fs.writeFileSync(path.join(root, 'gfs', 'b.grib2'), Buffer.alloc(0))
  catalogues.get(root)[0].files.push(path.join(root, 'gfs', 'b.grib2'))

  const store = newStore(root, cacheRoot)
  try {
    await store.start(120)
    let forecasts = await store.getForecastsForSource('gfs', POS, 'point', { startDate: '2026-06-10' })
    assert.strictEqual(forecasts.length, 2)
    assert.strictEqual(gribCacheStats().buffers, 2)
    // The authoritative acquisition no longer includes asset a.
    catalogues.get(root)[0].files = [path.join(root, 'gfs', 'b.grib2')]
    await store.refresh()
    forecasts = await store.getForecastsForSource('gfs', POS, 'point', { startDate: '2026-06-10' })
    assert.deepStrictEqual(forecasts.map(f => f.date), ['2026-06-10T12:00:00.000Z'])
    assert.strictEqual(gribCacheStats().buffers, 1, "stale 'a' buffer evicted by the scan")
    assert.strictEqual(fs.existsSync(path.join(cacheDir, 'a.t202606100600.gribcache')), false)
    assert.strictEqual(fs.existsSync(path.join(cacheDir, '.a.complete')), false)
  } finally {
    await store.stop()
  }
})

test('perf smoketest: warm pass is syscall-free and identical to cold', async () => {
  clearGribCache()
  const root = fs.mkdtempSync(path.join(tmp, 'root-'))
  const cacheRoot = fs.mkdtempSync(path.join(tmp, 'cache-'))

  // 20 slices × 3 vars, one GRIB placeholder basename
  const t0 = Date.UTC(2026, 5, 10)
  const slices = []
  for (let i = 0; i < 20; i++) {
    slices.push({
      validAt: new Date(t0 + i * 3 * 3600_000).toISOString(),
      refTime: '2026-06-10T00:00:00Z',
      precipAccum: null,
      vars: ['temp2m', 'windU', 'windV'],
      values: (j, i, k) => (k === 0 ? j * 10 + i : k === 1 ? 3 : 4),
    })
  }
  makeSource(root, cacheRoot, 'perf', 'run', slices)

  const store = newStore(root, cacheRoot)
  try {
    await store.start(120)

    const positions = []
    for (let p = 0; p < 30; p++) {
      positions.push({ latitude: 40.1 + (p % 10) * 0.18, longitude: -9.9 + Math.floor(p / 10) * 0.4 })
    }

    const cold = []
    for (const p of positions) {
      cold.push(await store.getForecastsForSource('perf', p, 'point', { startDate: '2026-06-10' }))
    }
    const warm = []
    const unexpectedIo = () => { assert.fail('warm point queries must not access the filesystem') }
    const methods = ['open', 'readFile', 'stat', 'lstat', 'access']
    const originals = methods.map(method => fs.promises[method])
    const syncMethods = ['openSync', 'readSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync']
    const syncOriginals = syncMethods.map(method => fs[method])
    try {
      methods.forEach(method => { fs.promises[method] = unexpectedIo })
      syncMethods.forEach(method => { fs[method] = unexpectedIo })
      for (const p of positions) {
        warm.push(await store.getForecastsForSource('perf', p, 'point', { startDate: '2026-06-10' }))
      }
    } finally {
      methods.forEach((method, i) => { fs.promises[method] = originals[i] })
      syncMethods.forEach((method, i) => { fs[method] = syncOriginals[i] })
    }

    // Correctness is the strict part: every result full-timeline, warm ≡ cold
    assert.strictEqual(cold.length, 30)
    for (let i = 0; i < 30; i++) {
      assert.strictEqual(cold[i].length, 20)
      assert.deepStrictEqual(warm[i], cold[i])
    }
    assert.strictEqual(gribCacheStats().buffers, 20, 'all slices buffered after the cold pass')

  } finally {
    await store.stop()
  }
})
