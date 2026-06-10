'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const { toWeatherData } = require('../dist/weather-mapper.js')

const AT = new Date('2026-06-10T12:00:00Z')

test('wind U/V → speed and meteorological FROM direction', () => {
  // v = -5 (blowing southward) → wind FROM north (direction 0)
  let d = toWeatherData({ validAt: AT, values: { windU: 0, windV: -5 } }, 'point')
  assert.ok(Math.abs(d.wind.speedTrue - 5) < 1e-9)
  assert.ok(Math.abs(d.wind.directionTrue - 0) < 1e-9)

  // u = -5 (blowing westward) → wind FROM east (π/2)
  d = toWeatherData({ validAt: AT, values: { windU: -5, windV: 0 } }, 'point')
  assert.ok(Math.abs(d.wind.directionTrue - Math.PI / 2) < 1e-9)

  // u = 3, v = 4 → speed 5
  d = toWeatherData({ validAt: AT, values: { windU: 3, windV: 4 } }, 'point')
  assert.ok(Math.abs(d.wind.speedTrue - 5) < 1e-9)
})

test('gust is attached only with wind components', () => {
  const d = toWeatherData({ validAt: AT, values: { windU: 1, windV: 1, gust: 9 } }, 'point')
  assert.strictEqual(d.wind.gust, 9)

  const noWind = toWeatherData({ validAt: AT, values: { gust: 9 } }, 'point')
  assert.strictEqual(noWind.wind, undefined)
})

test('outside fields are mapped and date/type set', () => {
  const d = toWeatherData({
    validAt: AT,
    values: { temp2m: 290, pressure: 101300, humidity: 0.8, cloudCover: 0.5, precip: 0.002 },
  }, 'point')
  assert.strictEqual(d.date, '2026-06-10T12:00:00.000Z')
  assert.strictEqual(d.type, 'point')
  assert.strictEqual(d.outside.temperature, 290)
  assert.strictEqual(d.outside.pressure, 101300)
  assert.strictEqual(d.outside.relativeHumidity, 0.8)
  assert.strictEqual(d.outside.cloudCover, 0.5)
  assert.strictEqual(d.outside.precipitationVolume, 0.002)
})

test('empty values produce a bare WeatherData', () => {
  const d = toWeatherData({ validAt: AT, values: {} }, 'point')
  assert.strictEqual(d.wind, undefined)
  assert.strictEqual(d.outside, undefined)
})
