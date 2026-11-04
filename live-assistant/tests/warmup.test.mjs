import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyWarmupState, inQuietHours, markActivity, markWarmup, normalizeWarmupState,
  parseQuietHours, pickWarmupTopic, warmupDecision,
} from '../src/warmup.mjs'

const cfg = {
  enabled: true,
  idleSec: 300,
  minIntervalSec: 600,
  maxPerHour: 4,
  maxPerDay: 20,
  maxConsecutive: 2,
  longCooldownSec: 1800,
  quietHours: '',
  minOnline: 1,
}

const state = (now) => ({ ...emptyWarmupState(now), lastAt: now - 700_000 })

test('安静时间不够不热场', () => {
  const now = Date.now()
  const result = warmupDecision({ now, cfg, state: state(now), lastActivityAt: now - 100_000, live: true, online: 10 })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /还没安静够/)
})

test('满足条件允许热场', () => {
  const now = Date.now()
  const result = warmupDecision({ now, cfg, state: state(now), lastActivityAt: now - 301_000, live: true, online: 10 })
  assert.equal(result.allowed, true)
})

test('未开播 / 在线人数太低不热场', () => {
  const now = Date.now()
  assert.match(warmupDecision({ now, cfg, state: state(now), lastActivityAt: now - 301_000, live: false, online: 10 }).reason, /未开播/)
  assert.match(warmupDecision({ now, cfg, state: state(now), lastActivityAt: now - 301_000, live: true, online: 0 }).reason, /在线人数/)
})

test('每小时 / 每天上限', () => {
  const now = Date.now()
  const hourly = { ...state(now), times: [now - 1, now - 2, now - 3, now - 4] }
  assert.match(warmupDecision({ now, cfg, state: hourly, lastActivityAt: now - 301_000, live: true, online: 10 }).reason, /本小时/)
  const daily = { ...state(now), times: Array.from({ length: 20 }, (_, i) => now - i * 1000) }
  assert.match(warmupDecision({
    now, cfg: { ...cfg, maxPerHour: 100 }, state: daily, lastActivityAt: now - 301_000, live: true, online: 10,
  }).reason, /今天/)
})

test('连续没人接话后进入长冷却', () => {
  const now = Date.now()
  const hot = { ...state(now), consecutive: 2, lastAt: now - 700_000 }
  assert.match(warmupDecision({ now, cfg, state: hot, lastActivityAt: now - 301_000, live: true, online: 10 }).reason, /长冷却/)
  const cooled = { ...hot, lastAt: now - 1801_000 }
  assert.equal(warmupDecision({ now, cfg, state: cooled, lastActivityAt: now - 301_000, live: true, online: 10 }).allowed, true)
})

test('安静时段', () => {
  const now = new Date(2026, 10, 5, 3, 0, 0).getTime()
  const result = warmupDecision({
    now, cfg: { ...cfg, quietHours: '02:00-08:00' }, state: state(now), lastActivityAt: now - 301_000, live: true, online: 10,
  })
  assert.match(result.reason, /安静时段/)
})

test('安静时段解析：普通 / 跨午夜 / 多段', () => {
  assert.equal(parseQuietHours('02:00-08:00').length, 1)
  assert.equal(inQuietHours('02:00-08:00', new Date(2026, 10, 5, 3, 0)), true)
  assert.equal(inQuietHours('02:00-08:00', new Date(2026, 10, 5, 12, 0)), false)
  assert.equal(inQuietHours('23:00-01:00', new Date(2026, 10, 5, 23, 30)), true)
  assert.equal(inQuietHours('23:00-01:00', new Date(2026, 10, 5, 0, 30)), true)
  assert.equal(inQuietHours('23:00-01:00', new Date(2026, 10, 5, 12, 0)), false)
  assert.equal(inQuietHours('02:00-08:00,12:00-13:00', new Date(2026, 10, 5, 12, 30)), true)
})

test('话题轮换会避开最近用过的', () => {
  assert.equal(pickWarmupTopic(['a', 'b', 'c'], ['a', 'b'], () => 0), 'c')
  assert.equal(pickWarmupTopic(['a', 'b', 'c'], ['a', 'b', 'c'], () => 0), 'a')
  assert.equal(pickWarmupTopic([], ['a']), '')
})

test('markWarmup / markActivity / normalize 状态', () => {
  const now = Date.now()
  let s = emptyWarmupState(now)
  s = markWarmup(s, '你好', now)
  assert.equal(s.consecutive, 1)
  assert.deepEqual(s.lastTexts, ['你好'])
  assert.equal(s.times.length, 1)
  s = markActivity(s, now)
  assert.equal(s.consecutive, 0)
  const normalized = normalizeWarmupState({ ...s, times: [now - 25 * 3600_000, now] }, now)
  assert.equal(normalized.times.length, 1)
})
