'use strict'

// Pure-logic tests for GRIB message boundary splitting. These do not load the
// WASM ecCodes module — they run anywhere the rest of the suite does.

const { test } = require('node:test')
const assert = require('node:assert')
const { splitGribMessages } = require('../dist/ingest-wasm.js')

// Build a synthetic GRIB message with the given edition and a writable
// total-length field, so the splitter can walk it.
function gribMessage(edition, totalLength) {
  const buf = Buffer.alloc(totalLength)
  buf.write('GRIB', 0, 'ascii')
  if (edition === 1) {
    buf.writeUIntBE(totalLength, 4, 3)
    buf[7] = 1
  } else {
    buf[6] = 0   // discipline
    buf[7] = 2   // edition
    buf.writeBigUInt64BE(BigInt(totalLength), 8)
  }
  return buf
}

test('splitGribMessages: single GRIB2 message', () => {
  const buf = gribMessage(2, 200)
  const msgs = splitGribMessages(buf)
  assert.strictEqual(msgs.length, 1)
  assert.strictEqual(msgs[0].offset, 0)
  assert.strictEqual(msgs[0].length, 200)
})

test('splitGribMessages: single GRIB1 message', () => {
  const buf = gribMessage(1, 150)
  const msgs = splitGribMessages(buf)
  assert.strictEqual(msgs.length, 1)
  assert.deepStrictEqual(msgs[0], { offset: 0, length: 150 })
})

test('splitGribMessages: multiple messages back to back', () => {
  const a = gribMessage(2, 64)
  const b = gribMessage(2, 80)
  const c = gribMessage(1, 48)
  const buf = Buffer.concat([a, b, c])
  const msgs = splitGribMessages(buf)
  assert.strictEqual(msgs.length, 3)
  assert.deepStrictEqual(msgs, [
    { offset: 0, length: 64 },
    { offset: 64, length: 80 },
    { offset: 144, length: 48 },
  ])
})

test('splitGribMessages: stops at trailing garbage', () => {
  const a = gribMessage(2, 64)
  const tail = Buffer.from('not a grib message at all')
  const buf = Buffer.concat([a, tail])
  const msgs = splitGribMessages(buf)
  assert.strictEqual(msgs.length, 1)
})

test('splitGribMessages: empty buffer yields nothing', () => {
  assert.strictEqual(splitGribMessages(Buffer.alloc(0)).length, 0)
})

test('splitGribMessages: rejects unknown edition', () => {
  const buf = Buffer.alloc(64)
  buf.write('GRIB', 0, 'ascii')
  buf[7] = 9
  assert.strictEqual(splitGribMessages(buf).length, 0)
})

test('splitGribMessages: rejects a length that overruns the buffer', () => {
  const buf = gribMessage(2, 1000)   // claims 1000 bytes but only 16 allocated-ish
  const truncated = buf.subarray(0, 20)
  assert.strictEqual(splitGribMessages(truncated).length, 0)
})
