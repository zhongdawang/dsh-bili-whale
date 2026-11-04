import test from 'node:test'
import assert from 'node:assert/strict'
import { generateReply, generateWarmup } from '../src/llm.mjs'

const base = {
  baseUrl: 'https://example.com',
  model: 'test-model',
  apiKeyEnv: 'TEST_KEY',
  maxTokens: 80,
  systemPrompt: 'test',
}

const response = (content, { finish = 'stop', usage } = {}) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content }, finish_reason: finish }], usage }),
})

test('推理模型空正文 + finish_reason=length 时自动翻倍重试，并累计 usage', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body))
    if (calls.length === 1) {
      return response('', {
        finish: 'length',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    }
    return response('你超棒的', {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 7,
        total_tokens: 17,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    })
  }
  const result = await generateReply({
    event: { uname: '中帝', text: '夸夸我' },
    config: base,
    apiKey: 'k',
    fetchImpl,
  })
  assert.equal(result.text, '你超棒的')
  assert.equal(result.requests, 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].max_tokens, 80)
  assert.equal(calls[1].max_tokens, 160)
  assert.deepEqual(result.usage, { input: 20, output: 12, reasoning: 3, total: 32 })
  assert.ok(result.latencyMs >= 0)
})

test('空正文且不是 length 时直接报错，不返回空串', async () => {
  const fetchImpl = async () => response('', { finish: 'stop' })
  await assert.rejects(
    () => generateReply({ event: { uname: '中帝', text: '夸夸我' }, config: base, apiKey: 'k', fetchImpl }),
    /空内容/,
  )
})

test('contextMessages=0 时不再携带上一段对话', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = JSON.parse(options.body)
    return response('好')
  }
  await generateReply({
    event: { uname: '中帝', text: '现在几点了' },
    config: { ...base, contextMessages: 0 },
    apiKey: 'k',
    recent: [{ uname: '中帝', text: '改编一下静夜思' }],
    fetchImpl,
  })
  const userMessages = request.messages.filter((message) => message.role === 'user')
  assert.equal(userMessages.length, 1)
  assert.match(userMessages[0].content, /现在几点了/)
  assert.equal(userMessages.some((message) => message.content.includes('静夜思')), false)
})

test('contextMessages=2 时带最近两条', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = JSON.parse(options.body)
    return response('好')
  }
  await generateReply({
    event: { uname: '中帝', text: '第三句' },
    config: { ...base, contextMessages: 2 },
    apiKey: 'k',
    recent: [
      { uname: '中帝', text: '第一句' },
      { uname: '中帝', text: '第二句' },
      { uname: '中帝', text: '第三句' },
      { uname: '中帝', text: '第四句' },
    ],
    fetchImpl,
  })
  const userMessages = request.messages.filter((message) => message.role === 'user')
  assert.equal(userMessages.length, 3) // 两条上下文 + 当前这条
  assert.match(userMessages[0].content, /第三句/)
  assert.match(userMessages[1].content, /第四句/)
  assert.match(userMessages[2].content, /第三句/)
})

test('人设会拼到系统提示词前面', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = JSON.parse(options.body)
    return response('好')
  }
  await generateReply({
    event: { uname: '中帝', text: '你好' },
    config: { ...base, systemPrompt: '系统规则' },
    apiKey: 'k',
    persona: '你是直播间的小助理',
    fetchImpl,
  })
  const system = request.messages.find((message) => message.role === 'system')
  assert.match(system.content, /你是直播间的小助理/)
  assert.match(system.content, /系统规则/)
  assert.ok(system.content.indexOf('你是直播间的小助理') < system.content.indexOf('系统规则'))
})

test('热场生成会带上人设、房间和话题库', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = JSON.parse(options.body)
    return response('刚开播吗？今天播到几点')
  }
  const result = await generateWarmup({
    config: { ...base, systemPrompt: '系统规则' },
    apiKey: 'k',
    persona: '人设甲',
    topics: ['话题A', '话题B'],
    recent: [{ uname: '中帝', text: '刚才那句话' }],
    room: { title: '测试直播间', uname: '主播' },
    fetchImpl,
  })
  assert.equal(result.text, '刚开播吗？今天播到几点')
  const system = request.messages.find((message) => message.role === 'system')
  const user = request.messages.find((message) => message.role === 'user')
  assert.match(system.content, /人设甲/)
  assert.match(system.content, /热场/)
  assert.match(user.content, /测试直播间/)
  assert.match(user.content, /话题A/)
  assert.match(user.content, /刚才那句话/)
})

test('正常回复直接返回文本', async () => {
  const fetchImpl = async () => response('中帝今天也很帅')
  const result = await generateReply({ event: { uname: '中帝', text: '夸夸我' }, config: base, apiKey: 'k', fetchImpl })
  assert.equal(result.text, '中帝今天也很帅')
})
