// Read-only integration checks inside the selected sandbox. No tokens logged.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash, createHmac } = require('node:crypto')
assert.equal(process.env.SIGNALK_CONTAINER_ID, 'signalk-sandbox')
const root = '/home/node/.signalk', name = 'signalk-grib-weather-provider', base = 'http://127.0.0.1:3000'
const security = JSON.parse(fs.readFileSync(path.join(root, 'security.json')))
const admin = security.users.find(u => u.type === 'admin')
const secret = security.secretKey || fs.readFileSync(path.join(root, 'security-secret.key'), 'utf8').trim()
const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
const p = Buffer.from(JSON.stringify({ id: admin.username, exp: Math.floor(Date.now()/1000) + 300 })).toString('base64url')
const adminHeaders = { Authorization: `Bearer ${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}` }
const data = path.join(root, 'plugin-config-data', name)
const token = fs.readFileSync(path.join(data, 'catalogue-token'), 'utf8').trim()
const headers = { Authorization: `Bearer ${token}` }
const get = async (route, auth = headers) => {
  const r = await fetch(base + route, { headers: auth })
  assert.equal(r.status, 200, route)
  return r.json()
}
async function main() {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'))).version, '0.7.0-beta.1')
  let status
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      status = await get(`/plugins/${name}/status`, adminHeaders)
      if (status.sources.some(s => s.slices > 0) && !status.errors.length) break
      const response = await fetch(base + `/plugins/${name}/refresh`, { method: 'POST', headers: adminHeaders })
      assert.equal(response.status, 202)
    } catch (error) { if (attempt === 39) throw error }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.equal(status.inputMode, 'catalogue')
  assert.deepEqual(status.errors, [])
  const source = status.sources.find(s => s.name === 'gfs-0p25')
  assert.ok(source && source.slices > 0)
  assert.ok(!JSON.stringify(status).includes(token))
  const provider = name + ':gfs-0p25'
  const providers = await get('/signalk/v2/api/weather/_providers', adminHeaders)
  assert.ok(providers[provider], 'Preserve existing selectable provider ID')
  const record = await get('/signalk/v2/api/resources/forecastDatasets/' + source.datasetId)
  assert.equal(record.version, source.version)
  const mirror = JSON.parse(fs.readFileSync(path.join(data, 'catalogue-assets/mirror.json')))
  const dataset = mirror.datasets.find(d => d.id === source.datasetId)
  assert.ok(dataset)
  let total = 0
  for (const asset of dataset.assets) {
    const local = path.join(data, 'catalogue-assets', dataset.id, dataset.version, `${dataset.id}-${dataset.version}-${createHash('sha256').update(asset.id).digest('hex')}.grib2`)
    const bytes = fs.readFileSync(local)
    assert.equal(bytes.length, asset.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
    total += bytes.length
  }
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'local-packages/grib-weather-forecast-backup.json')))
  const beforeConfig = JSON.parse(fs.readFileSync(path.join(marker.backup, 'weather-config.json')))
  const afterConfig = JSON.parse(fs.readFileSync(path.join(root, 'plugin-config-data', name + '.json')))
  const expected = structuredClone(beforeConfig)
  delete expected.configuration.inputMode
  delete expected.configuration.rootDirectory
  assert.deepEqual(afterConfig, expected)
  const baseline = JSON.parse(fs.readFileSync(path.join(marker.backup, 'weather-baseline.json')))
  const forecasts = await get(baseline.route, adminHeaders)
  assert.deepEqual(forecasts, baseline.forecasts, 'Weather API data must match the previously decoded shared-directory forecast')
  assert.ok(forecasts.length && Number.isFinite(forecasts[0].wind.speedTrue) && Number.isFinite(forecasts[0].outside.temperature))
  const hashes = JSON.parse(fs.readFileSync(path.join(marker.backup, 'plugin-config-hashes.json')))
  let preserved = 0
  for (const [file, hash] of Object.entries(hashes)) {
    if (file === name + '.json') continue
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, 'plugin-config-data', file))).digest('hex'), hash, file)
    preserved++
  }
  const principal = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).device
  assert.equal(security.devices.find(d => d.clientId === principal).permissions, 'readonly')
  assert.equal(fs.statSync(path.join(data, 'catalogue-token')).mode & 0o777, 0o600)
  const denied = await fetch(base + '/plugins/signalk-forecast-dataset-provider/publications', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })
  assert.ok([401,403].includes(denied.status), 'Consumer token must not publish')
  console.log(JSON.stringify({ result: 'PASS', mode: status.inputMode, source: source.name, datasetId: source.datasetId, version: source.version, assets: dataset.assets.length, bytes: total, slices: source.slices, forecastSamples: forecasts.length, forecastsMatchBaseline: true, otherConfigurationsPreserved: preserved, permission: 'readonly', errors: status.errors }))
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
