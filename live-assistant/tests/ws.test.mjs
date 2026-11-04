import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { encodePacket, parsePackets } from '../src/ws.mjs'

const header = (total, ver, op) => {
  const buf = Buffer.alloc(16)
  buf.writeUInt32BE(total, 0)
  buf.writeUInt16BE(16, 4)
  buf.writeUInt16BE(ver, 6)
  buf.writeUInt32BE(op, 8)
  buf.writeUInt32BE(1, 12)
  return buf
}

test('普通包编解码往返', () => {
  const packet = encodePacket(5, '{"cmd":"DANMU_MSG"}')
  const out = parsePackets(Buffer.from(packet))
  assert.equal(out.length, 1)
  assert.equal(out[0].op, 5)
  assert.equal(out[0].body.toString('utf8'), '{"cmd":"DANMU_MSG"}')
})

test('zlib 压缩的嵌套包能解开', () => {
  const inner = Buffer.from(encodePacket(5, '{"cmd":"DANMU_MSG","info":[]}'))
  const compressed = zlib.deflateSync(inner)
  const frame = Buffer.concat([header(16 + compressed.length, 2, 5), compressed])
  const out = parsePackets(frame)
  assert.equal(out.length, 1)
  assert.equal(out[0].op, 5)
  assert.match(out[0].body.toString('utf8'), /DANMU_MSG/)
})

test('brotli 压缩的嵌套包能解开', () => {
  const inner = Buffer.from(encodePacket(5, '{"cmd":"INTERACT_WORD"}'))
  const compressed = zlib.brotliCompressSync(inner)
  const frame = Buffer.concat([header(16 + compressed.length, 3, 5), compressed])
  const out = parsePackets(frame)
  assert.equal(out.length, 1)
  assert.match(out[0].body.toString('utf8'), /INTERACT_WORD/)
})

test('半截包直接忽略，不抛异常', () => {
  const frame = Buffer.alloc(10)
  assert.deepEqual(parsePackets(frame), [])
})
