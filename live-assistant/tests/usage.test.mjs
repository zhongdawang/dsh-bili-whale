import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readUsage, recordUsage, normalizeUsage } from '../src/usage.mjs'

const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-usage-'))
  return path.join(dir, 'usage.json')
}

test('累计多次调用的 token 用量', async () => {
  const file = tempFile()
  await recordUsage(file, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, { latencyMs: 100, model: 'm1' })
  await recordUsage(file, { input: 2, output: 3, reasoning: 1, total: 6 }, { latencyMs: 80, model: 'm2', finishReason: 'stop' })
  const usage = readUsage(file)
  assert.equal(usage.input, 12)
  assert.equal(usage.output, 8)
  assert.equal(usage.reasoning, 1)
  assert.equal(usage.total, 21)
  assert.equal(usage.calls, 2)
  assert.equal(usage.lastLatencyMs, 80)
  assert.equal(usage.lastModel, 'm2')
  assert.equal(usage.lastFinishReason, 'stop')
})

test('跨天第一次记录会清零', async () => {
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    date: '2000-01-01', input: 100, output: 200, reasoning: 50, total: 300, calls: 9,
    lastAt: '2000-01-01T00:00:00.000Z', lastLatencyMs: 1, lastModel: 'old', lastFinishReason: 'stop',
  }))
  await recordUsage(file, { input: 1, output: 2, total: 3 }, { latencyMs: 10, model: 'new' })
  const usage = readUsage(file)
  assert.equal(usage.input, 1)
  assert.equal(usage.output, 2)
  assert.equal(usage.total, 3)
  assert.equal(usage.calls, 1)
  assert.equal(usage.lastModel, 'new')
})

test('normalizeUsage 容忍坏数据', () => {
  const usage = normalizeUsage({ input: 'x', output: -1, total: null })
  assert.equal(usage.input, 0)
  assert.equal(usage.output, 0)
  assert.equal(usage.total, 0)
  assert.equal(usage.calls, 0)
})
