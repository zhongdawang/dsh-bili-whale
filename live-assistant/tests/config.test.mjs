import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, merge } from '../src/config.mjs'

test('merge 保留默认值并覆盖用户值', () => {
  const merged = merge(DEFAULTS, { room: '123', reply: { triggers: ['all'], maxLen: 30 } })
  assert.equal(merged.room, '123')
  assert.deepEqual(merged.reply.triggers, ['all'])
  assert.equal(merged.reply.maxLen, 30)
  assert.ok(Array.isArray(merged.reply.keywordRules))
  assert.equal(merged.throttle.dailyCap, DEFAULTS.throttle.dailyCap)
})

test('默认是 dryRun（不会误发）', () => {
  assert.equal(DEFAULTS.dryRun, true)
  assert.equal(DEFAULTS.reply.llm.enabled, false)
})
