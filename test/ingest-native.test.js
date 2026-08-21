'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { exec } = require('child_process')
const { promisify } = require('util')

const execAsync = promisify(exec)

const { hasNativeEcCodes } = require('../dist/ingest-native.js')
const { checkNativeEcCodes, gribBasename, CACHE_FILE_RE } = require('../dist/ingest-manager.js')

let nativeAvailable = false

test.before(async () => {
  // Check if native ecCodes is actually available
  try {
    await execAsync('python3 -c "import eccodes"')
    nativeAvailable = true
  } catch {
    nativeAvailable = false
  }
})

test('hasNativeEcCodes detects Python + eccodes', async () => {
  const log = []
  const result = await hasNativeEcCodes((msg) => log.push(msg))

  if (nativeAvailable) {
    assert.strictEqual(result, true, 'should return true when eccodes is available')
  } else {
    assert.strictEqual(result, false, 'should return false when eccodes is not available')
  }

  // Should log something either way
  assert.ok(log.length > 0, 'should log check results')
})

test('hasNativeEcCodes logs useful information', async () => {
  const log = []
  await hasNativeEcCodes((msg) => log.push(msg))

  const logStr = log.join('\n')

  if (nativeAvailable) {
    assert.ok(logStr.includes('Python found'), 'should log Python availability')
    assert.ok(logStr.includes('ecCodes found'), 'should log ecCodes availability')
  } else {
    assert.ok(logStr.includes('Native ecCodes not available'), 'should log unavailability')
  }
})

test('checkNativeEcCodes caches result', async () => {
  const log1 = []
  const result1 = await checkNativeEcCodes((msg) => log1.push(msg))
  const log1Length = log1.length

  // Second call - should use cached result
  const log2 = []
  const result2 = await checkNativeEcCodes((msg) => log2.push(msg))
  const log2Length = log2.length

  // Results should be identical
  assert.strictEqual(result1, result2, 'cached result should match first call')

  // Second call should not add new log entries (uses cache)
  assert.strictEqual(log2Length, 0, 'second call should not log (uses cache)')
})

test('gribBasename extracts basename correctly', () => {
  assert.strictEqual(gribBasename('/path/to/file.grb2'), 'file')
  assert.strictEqual(gribBasename('/path/to/file.grib2'), 'file')
  assert.strictEqual(gribBasename('/path/to/file.grb'), 'file')
  assert.strictEqual(gribBasename('/path/to/file.grib'), 'file')
  assert.strictEqual(gribBasename('/path/to/file.t202401010000.grib2'), 'file.t202401010000')
  assert.strictEqual(gribBasename('/path/to/gfs.t12z.pgrbf00.2p5deg.grib2'), 'gfs.t12z.pgrbf00.2p5deg')
})

test('CACHE_FILE_RE matches expected pattern', () => {
  assert.match('file.t202401010000.gribcache', CACHE_FILE_RE)
  assert.match('gfs.t12z.pgrbf00.t202401011200.gribcache', CACHE_FILE_RE)
  assert.match('long.name.t202401011200.gribcache', CACHE_FILE_RE)
  assert.doesNotMatch('file.gribcache', CACHE_FILE_RE)
  assert.doesNotMatch('file.t20240101.gribcache', CACHE_FILE_RE)
  assert.doesNotMatch('file.t202401010000.grib', CACHE_FILE_RE)
})

test('CACHE_FILE_RE captures basename and timestamp', () => {
  const match1 = 'file.t202401010000.gribcache'.match(CACHE_FILE_RE)
  assert.ok(match1, 'should match valid cache filename')
  assert.strictEqual(match1[1], 'file', 'should capture basename')
  assert.strictEqual(match1[2], '202401010000', 'should capture timestamp')

  const match2 = 'gfs.t12z.pgrbf00.t202401011200.gribcache'.match(CACHE_FILE_RE)
  assert.ok(match2, 'should match cache with dots in basename')
  assert.strictEqual(match2[1], 'gfs.t12z.pgrbf00', 'should capture full basename')
  assert.strictEqual(match2[2], '202401011200', 'should capture timestamp')
})