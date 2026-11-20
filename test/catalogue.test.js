'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { Readable } = require('node:stream')
const { CatalogueClient } = require('../dist/catalogue')
const { GribStore } = require('../dist/grib-store')
const ingestManager = require('../dist/ingest-manager')

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-catalogue-'))
  const records = new Map(), content = new Map(), requests = []
  const registry = (globalThis[Symbol.for('macjl.forecast-datasets.catalogues.v1')] ??= new Map())
  t.after(() => { registry.delete(root); fs.rmSync(root, { recursive: true, force: true }) })
  let corrupt = false, failAsset = null
  const service = {
    contractVersion: '0.1',
    datasets(query) {
      requests.push({ route: '/datasets', query: new URLSearchParams(query).toString() })
      const offset = Number(query.offset), limit = Number(query.limit)
      return Object.fromEntries([...records.values()].slice(offset, offset + limit).map(r => [r.id, { version: r.version }]))
    },
    dataset(id, version) {
      requests.push({ route: `/datasets/${id}/versions/${version}` })
      return records.get(id)
    },
    readAsset(id, version, asset) {
      const route = `/plugins/signalk-forecast-dataset-provider/datasets/${id}/versions/${version}/assets/${asset}`
      requests.push({ route })
      if (asset === failAsset) throw new Error('Asset unavailable')
      const bytes = content.get(route)
      return Readable.from([corrupt ? Buffer.alloc(bytes.length, 99) : bytes])
    },
  }
  registry.set(root, service)
  const options = { localScope: root, directory: path.join(root, 'assets'), cacheRoot: path.join(root, 'decoded') }
  const client = () => new CatalogueClient(options, () => {})
  const add = (source = 'gfs-0p25', run = '2026-10-21T00:00:00Z', bytes = [Buffer.from('GRIB-one'), Buffer.from('GRIB-two')], id = randomUUID()) => {
    const version = createHash('sha256').update(Buffer.concat(bytes)).digest('hex')
    const record = { id, version, producer: 'signalk-grib-downloader', format: 'grib2', kind: 'forecast', state: 'complete', run, createdAt: run, requested: { source }, assets: bytes.map((b, i) => ({ id: `part-${i}`, size: b.length, sha256: createHash('sha256').update(b).digest('hex'), href: `/plugins/signalk-forecast-dataset-provider/datasets/${id}/versions/${version}/assets/part-${i}` })) }
    records.set(id, record)
    record.assets.forEach((a, i) => content.set(a.href, bytes[i]))
    return record
  }
  return { root, records, options, requests, add, client, signal: new AbortController().signal,
    unavailable: value => { if (value) registry.delete(root); else registry.set(root, service) },
    corrupt: value => { corrupt = value }, fail: value => { failAsset = value } }
}

test('discovers unverified multi-asset forecasts, streams hashes and reuses the immutable local copy', async t => {
  const f = await fixture(t), dataset = f.add()
  const first = await f.client().refresh(f.signal)
  assert.deepEqual(first.errors, [])
  assert.equal(first.sources[0].name, 'gfs-0p25')
  assert.equal(first.sources[0].datasetId, dataset.id)
  assert.equal(first.sources[0].files.length, 2)
  assert.deepEqual(fs.readFileSync(first.sources[0].files[0]), Buffer.from('GRIB-one'))
  const downloads = () => f.requests.filter(r => /\/assets\/part/.test(r.route)).length
  assert.equal(downloads(), 2)
  await f.client().refresh(f.signal)
  assert.equal(downloads(), 2, 'restart verifies/reuses originals without downloading again')
  assert.ok(f.requests.filter(r => /\/datasets$/.test(r.route)).every(r => !r.query.includes('verified=true')))
})

test('failed or corrupt transfer leaves the last complete snapshot and resumes only missing assets', async t => {
  const f = await fixture(t)
  const old = f.add()
  const previous = await f.client().refresh(f.signal)
  const next = f.add('gfs-0p25', '2026-10-21T06:00:00Z')
  f.fail('part-1')
  const failed = await f.client().refresh(f.signal)
  assert.equal(failed.sources[0].datasetId, old.id)
  assert.equal(failed.errors.length, 1)
  assert.ok(fs.existsSync(previous.sources[0].files[0]))
  f.fail(null)
  const recovered = await f.client().refresh(f.signal)
  assert.equal(recovered.sources[0].datasetId, next.id)
  assert.equal(f.requests.filter(r => r.route === next.assets[0].href).length, 1)
  assert.equal(fs.existsSync(previous.sources[0].files[0]), false)
})

test('checksum mismatch and oversized declarations never become a complete snapshot', async t => {
  const f = await fixture(t), dataset = f.add()
  f.corrupt(true)
  await assert.rejects(f.client().refresh(f.signal))
  assert.equal(fs.existsSync(path.join(f.options.directory, 'mirror.json')), false)
  f.corrupt(false)
  dataset.assets[0].size = 2 ** 32
  await assert.rejects(f.client().refresh(f.signal))
  assert.equal(fs.existsSync(path.join(f.options.directory, 'mirror.json')), false)
})

test('catalogue outage after restart uses verified originals; authoritative deletion removes the source', async t => {
  const f = await fixture(t)
  f.add()
  const before = await f.client().refresh(f.signal)
  f.unavailable(true)
  const outage = await f.client().refresh(f.signal)
  assert.equal(outage.sources[0].datasetId, before.sources[0].datasetId)
  assert.equal(outage.errors.length, 1)
  f.unavailable(false); f.records.clear()
  const removed = await f.client().refresh(f.signal)
  assert.deepEqual(removed.sources, [])
  assert.equal(fs.existsSync(before.sources[0].files[0]), false)
})

test('discovery paginates and selects the newest acquisition per downloader source', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 101; i++) f.add('gfs-0p25', '2026-10-20T00:00:00Z')
  const latest = f.add('gfs-0p25', '2026-10-21T00:00:00Z')
  const result = await f.client().refresh(f.signal)
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].datasetId, latest.id)
  assert.ok(f.requests.some(r => r.query?.includes('offset=100')))
  assert.equal(f.requests.filter(r => /\/assets\/part/.test(r.route)).length, 2)
})

test('real catalogue GRIB decodes into Weather API forecasts and survives an offline restart', { skip: Number(process.versions.node.split('.')[0]) < 24 }, async t => {
  const f = await fixture(t)
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/gfs.t00z.pgrb2.1p00.850.grb2'))
  f.add('gfs-0p25', '2026-10-21T00:00:00Z', [bytes])
  let summary
  const snapshotFile = path.join(f.options.cacheRoot, '.index.json')
  const createStore = () => {
    const client = f.client()
    return new GribStore(f.options.cacheRoot, () => {}, s => { summary = s }, { sourceProvider: signal => client.refresh(signal), snapshotFile })
  }
  let store = createStore()
  t.after(() => store.stop())
  await store.start(120)
  assert.equal(summary.errors.length, 0)
  assert.ok(summary.sources[0].slices > 0)
  let forecasts = await store.getForecastsForSource('gfs-0p25', { latitude: -35, longitude: 165 }, 'point', { startDate: '2020-01-01', maxCount: 1 })
  assert.equal(forecasts.length, 1)
  assert.ok(Number.isFinite(forecasts[0].outside.temperature))
  await store.stop()
  f.unavailable(true)
  store = createStore()
  try {
    await store.start(120)
    assert.equal(summary.errors.length, 1)
    forecasts = await store.getForecastsForSource('gfs-0p25', { latitude: -35, longitude: 165 }, 'point', { startDate: '2020-01-01', maxCount: 1 })
    assert.equal(forecasts.length, 1)
    const previousId = summary.sources[0].datasetId
    f.unavailable(false)
    f.add('gfs-0p25', '2026-10-22T00:00:00Z', [Buffer.from('invalid GRIB data')])
    await store.scanAll()
    assert.ok(summary.errors.length > 0)
    assert.equal(summary.sources[0].datasetId, previousId, 'a failed decode must retain the old dataset reference')
    forecasts = await store.getForecastsForSource('gfs-0p25', { latitude: -35, longitude: 165 }, 'point', { startDate: '2020-01-01', maxCount: 1 })
    assert.equal(forecasts.length, 1, 'no partial replacement of the working forecast index')
    await store.stop()
    store = createStore()
    await store.start(120)
    forecasts = await store.getForecastsForSource('gfs-0p25', { latitude: -35, longitude: 165 }, 'point', { startDate: '2020-01-01', maxCount: 1 })
    assert.equal(forecasts.length, 1, 'working decoded forecasts survive restart after a failed replacement')
    f.records.clear()
    await store.scanAll()
    assert.deepEqual(summary.sources, [])
    assert.deepEqual(await store.getForecastsForSource('gfs-0p25', { latitude: -35, longitude: 165 }, 'point'), [])
  } finally { await store.stop() }
})

test('unknown producers retain independent dataset provider identities', async t => {
  const f = await fixture(t)
  const first = f.add(), second = f.add()
  second.producer = 'another-receiver'
  const result = await f.client().refresh(f.signal)
  assert.equal(result.sources.length, 2)
  assert.ok(result.sources.some(s => s.name === 'gfs-0p25' && s.datasetId === first.id))
  assert.ok(result.sources.some(s => s.name === `dataset-${second.id}`))
})

test('retired local settings cannot bypass catalogue discovery', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  const makePlugin = require('../dist/index')
  const oldRoot = path.join(f.root, 'old-shared-gribs')
  fs.mkdirSync(path.join(oldRoot, 'legacy-source'), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 'legacy-source', 'run.grib2'), 'not a catalogue asset')
  const registered = []
  let settled, failed
  const ready = new Promise((resolve, reject) => { settled = resolve; failed = reject })
  const plugin = makePlugin({
    getDataDirPath: () => path.join(f.root, 'weather'), debug: () => {},
    weatherApi: { register: name => registered.push(name), unRegister: () => {} },
    setPluginStatus: message => { if (message === 'no GRIB forecasts in catalogue') settled() },
    setPluginError: message => failed(new Error(message)),
  })
  t.after(() => plugin.stop())
  const schema = plugin.schema()
  assert.equal(schema.properties.inputMode, undefined)
  assert.equal(schema.properties.rootDirectory, undefined)
  assert.equal(schema.properties.catalogueUrl, undefined)
  assert.equal(schema.properties.catalogueTokenFile, undefined)
  plugin.start({ inputMode: 'local', rootDirectory: oldRoot, catalogueUrl: 'https://former-catalogue.example', catalogueTokenFile: '/old/token' })
  await ready
  assert.deepEqual(registered, [])
  assert.ok(f.requests.some(r => r.route.endsWith('/datasets')))
  assert.ok(fs.existsSync(path.join(oldRoot, 'legacy-source', 'run.grib2')))
})

test('default connection waits for the local catalogue and refreshes without HTTP or a token', { timeout: 12000, skip: Number(process.versions.node.split('.')[0]) < 24 }, async t => {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-local-catalogue-'))
  const root = path.join(scope, 'weather-plugin')
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/gfs.t00z.pgrb2.1p00.850.grb2'))
  const id = randomUUID()
  const version = createHash('sha256').update('test-version').digest('hex')
  const dataset = {
    id, version, producer: 'signalk-grib-downloader', format: 'grib2', kind: 'forecast', state: 'complete',
    createdAt: '2026-10-21T00:00:00Z', requested: { source: 'gfs-0p25' },
    assets: [{ id: 'forecast', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), href: `/plugins/signalk-forecast-dataset-provider/datasets/${id}/versions/${version}/assets/forecast` }],
  }
  const key = Symbol.for('macjl.forecast-datasets.catalogues.v1')
  const services = (globalThis[key] ??= new Map())
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected HTTP request') })
  const routes = new Map()
  let markWaiting, markReady, fail, weather
  const waiting = new Promise(resolve => { markWaiting = resolve })
  const ready = new Promise(resolve => { markReady = resolve })
  const plugin = require('../dist/index')({
    getDataDirPath: () => root, debug: () => {},
    setPluginStatus: message => {
      if (message.startsWith('Waiting for Forecast Dataset Provider')) markWaiting()
      if (message.startsWith('gfs-0p25:') && !message.includes('error')) markReady()
    },
    setPluginError: message => { fail = message; markWaiting(); markReady() },
    weatherApi: { register: (_id, provider) => { weather = provider }, unRegister: () => {} },
  })
  t.after(async () => {
    await plugin.stop()
    services.delete(scope)
    fs.rmSync(scope, { recursive: true, force: true })
  })
  plugin.registerWithRouter({ get: (route, fn) => routes.set(route, fn), post: () => {} })
  const status = () => {
    let result
    routes.get('/status')(null, { json: value => { result = value } })
    return result
  }
  plugin.start({})
  await waiting
  assert.equal(fail, undefined)
  assert.equal(status().catalogueTransport, 'waiting')
  services.set(scope, {
    contractVersion: '0.1',
    datasets: filters => {
      assert.deepEqual(filters, { format: 'grib2', kind: 'forecast', state: 'complete', limit: '100', offset: '0' })
      return { [dataset.id]: { version: dataset.version } }
    },
    dataset: (id, version) => { assert.equal(id, dataset.id); assert.equal(version, dataset.version); return dataset },
    readAsset: (id, version, asset) => {
      assert.equal(id, dataset.id)
      assert.equal(version, dataset.version)
      assert.equal(asset, dataset.assets[0].id)
      return Readable.from([bytes])
    },
  })
  await ready
  assert.equal(fail, undefined)
  assert.equal(status().catalogueTransport, 'local')
  assert.equal(status().catalogueAccess, undefined)
  assert.equal(status().sources[0].datasetId, dataset.id)
  const forecasts = await weather.methods.getForecasts({ latitude: -35, longitude: 165 }, 'point', { startDate: '2020-01-01', maxCount: 1 })
  assert.equal(forecasts.length, 1)
  assert.ok(Number.isFinite(forecasts[0].outside.temperature))
  assert.equal(network.mock.callCount(), 0)
  assert.equal(fs.existsSync(path.join(root, 'catalogue-token')), false)
  services.delete(scope)
  assert.equal(status().catalogueTransport, 'waiting')
})

test('same original asset name with changed content replaces warm decoded caches and survives restart', { skip: Number(process.versions.node.split('.')[0]) < 24 }, async t => {
  const f = await fixture(t)
  const first = f.add('gfs-0p25', '2026-10-21T00:00:00Z', [fs.readFileSync(path.join(__dirname, 'fixtures/gfs.t00z.pgrb2.1p00.850.grb2'))])
  const snapshotFile = path.join(f.options.cacheRoot, '.index.json')
  let summary
  const createStore = () => {
    const client = f.client()
    return new GribStore(f.options.cacheRoot, () => {}, s => { summary = s }, { sourceProvider: signal => client.refresh(signal), snapshotFile })
  }
  let store = createStore()
  t.after(() => store.stop())
  const query = position => store.getForecastsForSource('gfs-0p25', position, 'point', { startDate: '2020-01-01', maxCount: 1 })
  await store.start(120)
  const tasman = { latitude: -35, longitude: 165 }, paris = { latitude: 49, longitude: 2 }
  assert.equal((await query(tasman)).length, 1, 'prime the old slice buffer')
  assert.deepEqual(await query(paris), [], 'the first acquisition covers only the Tasman area')
  const decodedDir = path.join(f.options.cacheRoot, 'gfs-0p25', ingestManager.EXTRACTOR_REVISION)
  const oldSlices = fs.readdirSync(decodedDir).filter(f => f.endsWith('.gribcache'))
  const replacement = f.add('gfs-0p25', first.run, [fs.readFileSync(path.join(__dirname, 'fixtures/gfs.t00z.pgrb2.1p00.sample.grb2'))], first.id)
  assert.equal(replacement.assets[0].id, first.assets[0].id, 'the producer keeps the same asset name')
  assert.notEqual(replacement.version, first.version)
  await store.refresh()
  assert.deepEqual(summary.errors, [])
  assert.equal(summary.sources[0].version, replacement.version)
  const updated = await query(paris)
  assert.equal(updated.length, 1, 'the replacement global grid now serves the new area')
  assert.ok(oldSlices.every(file => !fs.existsSync(path.join(decodedDir, file))))
  const currentSlices = fs.readdirSync(decodedDir).filter(f => f.endsWith('.gribcache'))
  await store.refresh()
  assert.deepEqual(fs.readdirSync(decodedDir).filter(f => f.endsWith('.gribcache')), currentSlices)
  await store.stop()
  f.unavailable(true)
  store = createStore()
  await store.start(120)
  assert.deepEqual(await query(paris), updated, 'the new acquisition remains active on an offline restart')
})

test('extractor upgrades rebuild unchanged originals offline, retry failures and retire warm old paths', { skip: Number(process.versions.node.split('.')[0]) < 24 }, async t => {
  const f = await fixture(t)
  f.add('gfs-0p25', '2026-10-21T00:00:00Z', [fs.readFileSync(path.join(__dirname, 'fixtures/gfs.t00z.pgrb2.1p00.850.grb2'))])
  const originalRevision = ingestManager.EXTRACTOR_REVISION
  const originalIngest = ingestManager.ingestGrib
  const snapshotFile = path.join(f.options.cacheRoot, '.index.json')
  let store, summary, calls = 0, fail = false
  t.after(async () => {
    if (store) await store.stop()
    ingestManager.EXTRACTOR_REVISION = originalRevision
    ingestManager.ingestGrib = originalIngest
  })
  const createStore = () => {
    const client = f.client()
    return new GribStore(f.options.cacheRoot, () => {}, s => { summary = s }, { sourceProvider: signal => client.refresh(signal), snapshotFile })
  }
  const query = () => store.getForecastsForSource('gfs-0p25', { latitude: -35, longitude: 165 }, 'point', { startDate: '2020-01-01', maxCount: 1 })
  ingestManager.EXTRACTOR_REVISION = 'extractor-v0'
  store = createStore()
  await store.start(120)
  const expected = await query() // Warm old buffers before changing extractor.
  assert.equal(expected.length, 1)
  const oldDirectory = path.join(f.options.cacheRoot, 'gfs-0p25', 'extractor-v0')
  ingestManager.EXTRACTOR_REVISION = originalRevision
  ingestManager.ingestGrib = async (...args) => {
    calls++
    if (fail) throw new Error('new extractor temporarily unavailable')
    return originalIngest(...args)
  }
  f.unavailable(true)
  fail = true
  await store.refresh()
  assert.equal(calls, 1)
  assert.deepEqual(await query(), expected, 'a failed rebuild keeps the previous working index')
  assert.ok(fs.existsSync(oldDirectory))
  await store.stop()
  // Restart must reject the old-revision snapshot and rebuild using the local
  // original mirror even while the catalogue is unavailable.
  fail = false
  store = createStore()
  await store.start(120)
  assert.equal(calls, 2)
  assert.equal(summary.sources[0].slices > 0, true)
  assert.deepEqual(await query(), expected)
  assert.equal(fs.existsSync(oldDirectory), false)
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile)).extractorRevision, originalRevision)
  await store.refresh()
  assert.equal(calls, 2, 'the current extractor reuses its completed cache')
  assert.equal(f.requests.filter(r => r.route.includes('/assets/')).length, 1, 'no re-download for an extractor upgrade')
})

test('selected snapshot MB limit is enforced before downloading assets', async t => {
  const f = await fixture(t)
  f.add()
  const client = new CatalogueClient({ ...f.options, maxCatalogueCacheMB: 0.000001 }, () => {})
  await assert.rejects(client.refresh(f.signal), /byte limit/)
  assert.equal(f.requests.filter(r => /\/assets\/part/.test(r.route)).length, 0)
})

test('scans do not overlap and stopping aborts discovery without publishing callbacks', async () => {
  let started, calls = 0, callbacks = 0
  const ready = new Promise(resolve => { started = resolve })
  const store = new GribStore('/unused', () => {}, () => { callbacks++ }, {
    sourceProvider: signal => new Promise((_resolve, reject) => {
      calls++; started()
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const starting = store.start(120)
  await ready
  const concurrent = store.refresh()
  await store.stop()
  await Promise.all([starting, concurrent])
  assert.equal(calls, 1)
  assert.equal(callbacks, 0)
})

test('asset limits use decimal MB: one million bytes fit in 1 MB, the next byte is rejected', async t => {
  for (const size of [1_000_000, 1_000_001]) {
    const f = await fixture(t)
    const bytes = Buffer.alloc(size, 1); bytes.write('GRIB')
    f.add('gfs-0p25', '2026-10-21T00:00:00Z', [bytes])
    const client = new CatalogueClient({ ...f.options, maxAssetMB: 1 }, () => {})
    if (size === 1_000_000) {
      const result = await client.refresh(f.signal)
      assert.deepEqual(result.errors, [])
      assert.equal(fs.statSync(result.sources[0].files[0]).size, size)
    } else {
      await assert.rejects(client.refresh(f.signal), /oversized catalogue asset/)
      assert.equal(f.requests.filter(r => /\/assets\/part/.test(r.route)).length, 0)
    }
  }
})

test('invalid MB limits fail before any catalogue request', async t => {
  const f = await fixture(t)
  for (const key of ['maxAssetMB', 'maxCatalogueCacheMB']) {
    for (const value of [0, -1, NaN, Infinity, '2', 0.0000001, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => new CatalogueClient({ ...f.options, [key]: value }, () => {}), /MB limits/)
    }
  }
  assert.equal(f.requests.length, 0)
})

test('retired byte settings are ignored and new defaults permit an ordinary acquisition', async t => {
  const f = await fixture(t); f.add()
  const client = new CatalogueClient({ ...f.options, maxAssetBytes: 1, maxCatalogueCacheBytes: 1, maxCacheBytes: 1 }, () => {})
  const result = await client.refresh(f.signal)
  assert.deepEqual(result.errors, [])
  assert.equal(result.sources[0].files.length, 2)
})
