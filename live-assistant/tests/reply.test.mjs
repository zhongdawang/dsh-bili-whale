import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, finalizeReply, matches, findRule, render } from '../src/reply.mjs'

const base = {
  triggers: ['mention', 'keyword'],
  ownerMid: 9001,
  aliases: ['小鱼'],
  ignoreUids: [666],
  ignoreNames: ['机器人'],
  ignorePatterns: ['^\\s*$', '^关注'],
  keywordRules: [
    { match: '你好', reply: '你好呀 {name}～' },
    { match: '/^(在吗|在不在)[?？]?$/', reply: '在的 {name}' },
  ],
  templateReplies: ['在呢'],
  maxLen: 20,
}

const ev = (text, extra = {}) => ({ uid: 1, uname: '阿伟', text, dmid: 'x', ...extra })

test('字符串关键词命中并渲染模板', () => {
  const d = decide(ev('你好呀主播'), base)
  assert.equal(d.reason, 'keyword')
  assert.equal(d.text, '你好呀 阿伟～')
})

test('正则关键词命中', () => {
  const d = decide(ev('在吗？'), base)
  assert.equal(d.reason, 'keyword')
  assert.equal(d.text, '在的 阿伟')
})

test('@ 她能触发，但文字交给后续生成', () => {
  const d = decide(ev('小鱼在吗'), base)
  assert.equal(d.reason, 'mention')
  assert.equal(d.text, '')
})

test('owner 触发需要显式开启', () => {
  assert.equal(decide(ev('说句话', { uid: 9001, uname: '主人' }), base), null)
  const d = decide(ev('说句话', { uid: 9001, uname: '主人' }), { ...base, triggers: ['owner'] })
  assert.equal(d.reason, 'owner')
})

test('all 模式回所有人（自己除外）', () => {
  const cfg = { ...base, triggers: ['all'] }
  assert.equal(decide(ev('随便说点'), cfg).reason, 'all')
  assert.equal(decide(ev('随便说点', { uid: 42 }), cfg, { selfMid: 42 }), null)
})

test('忽略名单 / 忽略正则生效', () => {
  assert.equal(decide(ev('你好', { uid: 666 }), base), null)
  assert.equal(decide(ev('你好', { uname: '抽奖机器人' }), base), null)
  assert.equal(decide(ev('关注主播不迷路'), { ...base, triggers: ['all'] }), null)
  assert.equal(decide(ev('   '), { ...base, triggers: ['all'] }), null)
})

test('没有命中触发条件就不回', () => {
  assert.equal(decide(ev('今天天气不错'), base), null)
})

test('matches 同时支持字符串和正则', () => {
  assert.equal(matches('你好', '你好呀'), true)
  assert.equal(matches('/^晚安$/', '晚安'), true)
  assert.equal(matches('/^晚安$/', '晚安呀'), false)
})

test('findRule 取第一条命中的规则', () => {
  const rule = findRule([{ match: 'a', reply: '1' }, { match: 'ab', reply: '2' }], 'abc')
  assert.equal(rule.reply, '1')
})

test('render 支持 name / text / room / gift', () => {
  assert.equal(render('{name}:{text}@{room} {gift}', { uname: 'A', text: 'B', roomId: 6 }, { gift: '辣条' }), 'A:B@6 辣条')
})

test('finalizeReply 去换行、去引号、按字符截断', () => {
  assert.equal(finalizeReply('\n “你好呀”\n', 20), '你好呀')
  assert.equal(finalizeReply('一二三四五六', 4), '一二三四')
})
