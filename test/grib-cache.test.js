'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { readCacheHeader, queryAtPosition } = require('../dist/grib-cache.js')

// Build a synthetic .gribcache (version 2) file and return its path.
// `values` is a function (j, i, varIdx) → number (NaN allowed).
function buildCache({ version = 2, meta, values }, dir) {
  const grid = meta
  const json = Buffer.from(JSON.stringify(meta), 'utf-8')
  const nPoints = grid.nLat * grid.nLon
  const nVars = meta.vars.length
  const data = Buffer.alloc(nPoints * nVars * 4)
  for (let j = 0; j < grid.nLat; j++) {
    for (let i = 0; i < grid.nLon; i++) {
      for (let k = 0; k < nVars; k++) {
        data.writeFloatLE(values(j, i, k), ((j * grid.nLon + i) * nVars + k) * 4)
      }
    }
  }
  const header = Buffer.alloc(9)
  header.write('GRBC', 0, 'ascii')
  header.writeUInt8(version, 4)
  header.writeUInt32BE(json.length, 5)

  const filePath = path.join(dir, `test.t202606101200.gribcache`)
  fs.writeFileSync(filePath, Buffer.concat([header, json, data]))
  return filePath
}

// 3×3 grid, S→N, lat 40..42, lon 350..352 (crosses the antimeridian of the [-180,180] convention)
const META = {
  latFirst: 40, lonFirst: 350, dLat: 1, dLon: 1, nLat: 3, nLon: 3,
  jScansPositively: true,
  validAt: '2026-06-10T12:00:00Z',
  refTime: '2026-06-10T00:00:00Z',
  precipAccum: [0, 12],
  vars: ['temp2m', 'precip'],
}

// temp2m = j*10 + i ; precip = 1 everywhere
const VALUES = (j, i, k) => (k === 0 ? j * 10 + i : 1)

let tmpDir
test.before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gribcache-')) })
test.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

test('readCacheHeader parses v2 header', async () => {
  const file = buildCache({ meta: META, values: VALUES }, tmpDir)
  const meta = await readCacheHeader(file)
  assert.strictEqual(meta.validAt.toISOString(), '2026-06-10T12:00:00.000Z')
  assert.strictEqual(meta.refTime.toISOString(), '2026-06-10T00:00:00.000Z')
  assert.deepStrictEqual(meta.precipAccum, [0, 12])
  assert.deepStrictEqual(meta.vars, ['temp2m', 'precip'])
  assert.strictEqual(meta.grid.nLat, 3)
  assert.strictEqual(meta.dataStart, 9 + Buffer.from(JSON.stringify(META)).length)
})

test('readCacheHeader rejects unsupported version', async () => {
  const file = buildCache({ version: 1, meta: META, values: VALUES }, tmpDir)
  await assert.rejects(() => readCacheHeader(file), /Unsupported gribcache version/)
})

test('queryAtPosition: exact grid point', async () => {
  const file = buildCache({ meta: META, values: VALUES }, tmpDir)
  const meta = await readCacheHeader(file)
  // lat 41, lon 351 → j=1, i=1 → temp = 11
  const v = await queryAtPosition(file, meta, 41, 351)
  assert.ok(Math.abs(v.temp2m - 11) < 1e-6)
})

test('queryAtPosition: bilinear interpolation at cell centre', async () => {
  const file = buildCache({ meta: META, values: VALUES }, tmpDir)
  const meta = await readCacheHeader(file)
  // lat 40.5, lon 350.5 → corners 0, 1, 10, 11 → mean 5.5
  const v = await queryAtPosition(file, meta, 40.5, 350.5)
  assert.ok(Math.abs(v.temp2m - 5.5) < 1e-6)
})

test('queryAtPosition: longitude normalisation across ±180°', async () => {
  const file = buildCache({ meta: META, values: VALUES }, tmpDir)
  const meta = await readCacheHeader(file)
  // lon -9 ≡ 351 in the [350, 352] grid frame
  const v = await queryAtPosition(file, meta, 41, -9)
  assert.ok(Math.abs(v.temp2m - 11) < 1e-6)
})

test('queryAtPosition: outside coverage returns empty', async () => {
  const file = buildCache({ meta: META, values: VALUES }, tmpDir)
  const meta = await readCacheHeader(file)
  assert.deepStrictEqual(await queryAtPosition(file, meta, 50, 351), {})  // lat too high
  assert.deepStrictEqual(await queryAtPosition(file, meta, 39, 351), {})  // lat too low
  assert.deepStrictEqual(await queryAtPosition(file, meta, 41, 10), {})   // lon outside [350, 352]
})

test('queryAtPosition: NaN corner falls back to defined neighbour', async () => {
  // precip NaN at (0,0) only
  const file = buildCache({
    meta: META,
    values: (j, i, k) => (k === 1 && j === 0 && i === 0 ? NaN : VALUES(j, i, k)),
  }, tmpDir)
  const meta = await readCacheHeader(file)
  const v = await queryAtPosition(file, meta, 40.5, 350.5)
  assert.strictEqual(v.precip, 1)        // fallback to a defined corner
  assert.ok(Math.abs(v.temp2m - 5.5) < 1e-6)  // other vars still interpolated
})
