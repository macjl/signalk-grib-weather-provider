'use strict'

// Covers the scenario the native_eccodes PR lacked: ingest through the
// manager entry point succeeds using only the in-process WASM ecCodes build,
// with no signalk-container manager registered on globalThis at all.

const { test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { ingestGrib, gribBasename, CACHE_FILE_RE } = require('../dist/ingest-manager.js')
const { getEccodes } = require('../dist/ingest-wasm.js')

const FIXTURE = path.join(__dirname, 'fixtures', 'gfs.t00z.pgrb2.1p00.sample.grb2')

let wasmOk = false
let wasmErr = null
before(async () => {
  try { await getEccodes(); wasmOk = true }
  catch (err) { wasmErr = err }
})

let cacheDir
before(() => { cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grib-mgr-')) })
after(() => { fs.rmSync(cacheDir, { recursive: true, force: true }) })

test('gribBasename strips the GRIB extension', () => {
  assert.strictEqual(gribBasename('/x/y/gfs-0p25.t00z.anl.grb2'), 'gfs-0p25.t00z.anl')
  assert.strictEqual(gribBasename('a.grib'), 'a')
})

test('CACHE_FILE_RE matches the canonical cache filename', () => {
  const m = CACHE_FILE_RE.exec('gfs.t00z.pgrb2.1p00.sample.t202608251800.gribcache')
  assert.ok(m)
  assert.strictEqual(m[1], 'gfs.t00z.pgrb2.1p00.sample')
  assert.strictEqual(m[2], '202608251800')
})

test('ingestGrib succeeds without any signalk-container manager present', async (t) => {
  if (!wasmOk) { t.skip(`eccodes-wasm not loadable (Node ${process.version})`); return }

  // Ensure no container manager is registered — this is the whole point.
  assert.strictEqual((globalThis).__signalk_containerManager, undefined)

  const logs = []
  const ok = await ingestGrib(FIXTURE, cacheDir, m => logs.push(m))
  assert.strictEqual(ok, true)

  const produced = fs.readdirSync(cacheDir).filter(f => f.endsWith('.gribcache'))
  assert.ok(produced.some(f => f.startsWith('gfs.t00z.pgrb2.1p00.sample.')))
})

test('ingestGrib returns false while a file is already being ingested', async (t) => {
  if (!wasmOk) { t.skip(`eccodes-wasm not loadable (Node ${process.version})`); return }

  // Hold a pending lock by starting a slow ingest on a large copy of the
  // fixture, then concurrently ask to ingest the same path.
  const slow = path.join(cacheDir, 'slow.grb2')
  fs.copyFileSync(FIXTURE, slow)
  let release
  const gate = new Promise(r => { release = r })
  const ingesting = ingestGrib(slow, cacheDir, () => {}).finally(release)
  // Give the event loop a tick to register the pending entry.
  await new Promise(r => setImmediate(r))
  const second = await ingestGrib(slow, cacheDir, () => {})
  assert.strictEqual(second, false, 'duplicate in-flight ingest is skipped')
  await ingesting
})

test('ingestGrib counts failures and gives up after the limit', async (t) => {
  if (!wasmOk) { t.skip(`eccodes-wasm not loadable (Node ${process.version})`); return }

  const broken = path.join(cacheDir, 'broken.grb2')
  fs.writeFileSync(broken, Buffer.from('not grib'))

  // Repeatedly attempt a file that can never convert. Each call throws until
  // the retry limit is reached; afterwards ingestGrib returns false without
  // invoking ecCodes again.
  let threw = 0
  for (let i = 0; i < 6; i++) {
    try { await ingestGrib(broken, cacheDir, () => {}) }
    catch { threw++ }
  }
  // The first 5 attempts throw; the 6th is silently skipped (limit reached).
  assert.strictEqual(threw, 5)
})
