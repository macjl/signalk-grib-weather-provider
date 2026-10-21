'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createHash, randomUUID } = require('node:crypto')
const { CatalogueClient } = require('../dist/catalogue')
const { GribStore } = require('../dist/grib-store')

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-catalogue-'))
  const tokenFile = path.join(root, 'token')
  fs.writeFileSync(tokenFile, 'readonly-test-token', { mode: 0o600 })
  const records = new Map(), content = new Map(), requests = []
  let unavailable = false, corrupt = false, failAsset = null, paginated = false, redirect = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local'), route = url.pathname
    requests.push({ route, query: url.search, auth: req.headers.authorization })
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (unavailable) return json(503, {})
    if (req.headers.authorization !== 'Bearer readonly-test-token') return json(401, {})
    if (route.endsWith('/status')) return json(200, { contractVersion: '0.1' })
    if (route.endsWith('/datasets')) {
      const selected = [...records.values()]
      if (paginated && url.searchParams.get('offset') === '0') {
        return json(200, Object.fromEntries(selected.slice(0, 100).map(r => [r.id, { version: r.version }])))
      }
      const offset = Number(url.searchParams.get('offset'))
      return json(200, Object.fromEntries(selected.slice(offset, offset + 100).map(r => [r.id, { version: r.version }])))
    }
    if (content.has(route)) {
      if (route.endsWith('/' + failAsset)) return json(503, {})
      if (redirect) { res.writeHead(302, { Location: 'http://127.0.0.1:1/credential-target' }); return res.end() }
      const bytes = content.get(route)
      res.writeHead(200, { 'Content-Length': bytes.length })
      return res.end(corrupt ? Buffer.alloc(bytes.length, 99) : bytes)
    }
    const id = route.split('/')[4]
    if (records.has(id)) return json(200, records.get(id))
    json(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) })
  const options = { url: `http://127.0.0.1:${server.address().port}`, tokenFile, directory: path.join(root, 'assets'), cacheRoot: path.join(root, 'decoded') }
  const client = () => new CatalogueClient(options, () => {})
  const add = (source = 'gfs-0p25', run = '2026-10-21T00:00:00Z', bytes = [Buffer.from('GRIB-one'), Buffer.from('GRIB-two')]) => {
    const id = randomUUID(), version = createHash('sha256').update(Buffer.concat(bytes)).digest('hex')
    const record = { id, version, producer: 'signalk-grib-downloader', format: 'grib2', kind: 'forecast', state: 'complete', run, createdAt: run, requested: { source }, assets: bytes.map((b, i) => ({ id: `part-${i}`, size: b.length, sha256: createHash('sha256').update(b).digest('hex'), href: `/plugins/signalk-forecast-dataset-provider/datasets/${id}/versions/${version}/assets/part-${i}` })) }
    records.set(id, record)
    record.assets.forEach((a, i) => content.set(a.href, bytes[i]))
    return record
  }
  return { root, records, options, requests, add, client, signal: new AbortController().signal,
    unavailable: v => { unavailable = v }, corrupt: v => { corrupt = v }, fail: v => { failAsset = v }, paginate: () => { paginated = true }, redirect: () => { redirect = true } }
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
  assert.ok(f.requests.every(r => r.auth === 'Bearer readonly-test-token'))
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

test('unsafe asset links and redirects are rejected before forwarding credentials', async t => {
  const f = await fixture(t), dataset = f.add()
  const original = dataset.assets[0].href
  dataset.assets[0].href = 'https://example.org/steal'
  await assert.rejects(f.client().refresh(f.signal))
  assert.equal(f.requests.filter(r => /\/assets\/part/.test(r.route)).length, 0)
  dataset.assets[0].href = original; f.redirect()
  await assert.rejects(f.client().refresh(f.signal))
  assert.equal(fs.existsSync(path.join(f.options.directory, 'mirror.json')), false)
})

test('discovery paginates and selects the newest acquisition per downloader source', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 101; i++) f.add('gfs-0p25', '2026-10-20T00:00:00Z')
  const latest = f.add('gfs-0p25', '2026-10-21T00:00:00Z')
  f.paginate()
  const result = await f.client().refresh(f.signal)
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].datasetId, latest.id)
  assert.ok(f.requests.some(r => r.query.includes('offset=100')))
  assert.equal(f.requests.filter(r => /\/assets\/part/.test(r.route)).length, 2)
})

test('catalogue limits and endpoints are validated', () => {
  const options = { directory: '/tmp', cacheRoot: '/tmp', tokenFile: '' }
  for (const url of ['http://remote.test', 'https://user:password@remote.test', 'https://remote.test?token=x']) assert.throws(() => new CatalogueClient({ ...options, url }, () => {}))
  assert.throws(() => new CatalogueClient({ ...options, url: 'http://127.0.0.1:3000', maxAssetBytes: -1 }, () => {}))
})

test('real catalogue GRIB decodes into Weather API forecasts and survives an offline restart', { skip: Number(process.versions.node.split('.')[0]) < 24 }, async t => {
  const f = await fixture(t)
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/gfs.t00z.pgrb2.1p00.850.grb2'))
  f.add('gfs-0p25', '2026-10-21T00:00:00Z', [bytes])
  let summary
  const snapshotFile = path.join(f.options.cacheRoot, '.index.json')
  const createStore = () => {
    const client = f.client()
    return new GribStore('/deliberately-missing-shared-gribs', f.options.cacheRoot, () => {}, s => { summary = s }, { sourceProvider: signal => client.refresh(signal), snapshotFile })
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

test('selected snapshot byte limit is enforced before downloading assets', async t => {
  const f = await fixture(t)
  f.add()
  const client = new CatalogueClient({ ...f.options, maxCacheBytes: 1 }, () => {})
  await assert.rejects(client.refresh(f.signal), /byte limit/)
  assert.equal(f.requests.filter(r => /\/assets\/part/.test(r.route)).length, 0)
})

test('scans do not overlap and stopping aborts discovery without publishing callbacks', async () => {
  let started, calls = 0, callbacks = 0
  const ready = new Promise(resolve => { started = resolve })
  const store = new GribStore('/unused', '/unused', () => {}, () => { callbacks++ }, {
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
