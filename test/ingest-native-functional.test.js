'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { exec } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const os = require('os')
const path = require('path')

const execAsync = promisify(exec)

// Detect if eccodes is available for conditional skipping
let hasEccodes = false
try {
  // Note: we can't use await at top level, so we check synchronously
  // This is a best-effort check
  const { spawnSync } = require('child_process')
  const result = spawnSync('python3', ['-c', 'import eccodes'], { stdio: 'pipe' })
  hasEccodes = result.status === 0
} catch {
  hasEccodes = false
}

const { ingestGribNative } = require('../dist/ingest-native.js')

let tmpDir

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grib-native-'))
})

test.after(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('ingestGribNative throws for invalid input', async () => {
  const log = []
  const gribPath = '/nonexistent/file.grb2'

  await assert.rejects(
    async () => await ingestGribNative(gribPath, tmpDir, (msg) => log.push(msg)),
    /Python process exited/,
    'should throw for invalid GRIB file'
  )
})

test('ingestGribNative creates cache directory', async () => {
  const log = []
  const cacheDir = path.join(tmpDir, 'cache-test')

  // Test with invalid input - should still create the directory
  await assert.rejects(
    async () => await ingestGribNative('/nonexistent.grib2', cacheDir, (msg) => log.push(msg)),
    /Python process exited/,
    'should throw for nonexistent GRIB file'
  )

  // Directory should still be created
  assert.ok(fs.existsSync(cacheDir), 'should create cache directory')
})