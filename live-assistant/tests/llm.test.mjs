import test from 'node:test'
import assert from 'node:assert/strict'
import { generateReply } from '../src/llm.mjs'

const base = {
  baseUrl: 'https://example.com',
  model: 'test-model',
  apiKeyEnv: 'TEST_KEY',
  maxTokens: 80,
  systemPrompt: 'test',
}

test('推理模型空正文 + finish_reason=length 时自动翻倍重试', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    if (calls.length === 1) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) }
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '你超棒的' }, finish_reason: 'stop' }] }) }
  }
  const reply = await generateReply({
    event: { uname: '中帝', text: '夸夸我' },
    config: base,
    apiKey: 'k',
    fetchImpl,
  })
  assert.equal(reply, '你超棒的')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].max_tokens, 80)
  assert.equal(calls[1].max_tokens, 160)
})

test('空正文且不是 length 时直接报错，不返回空串', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
  })
  await assert.rejects(
    () => generateReply({ event: { uname: '中帝', text: '夸夸我' }, config: base, apiKey: 'k', fetchImpl }),
    /空内容/,
  )
})

test('正常回复直接返回', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '中帝今天也很帅' }, finish_reason: 'stop' }] }),
  })
  const reply = await generateReply({ event: { uname: '中帝', text: '夸夸我' }, config: base, apiKey: 'k', fetchImpl })
  assert.equal(reply, '中帝今天也很帅')
})
