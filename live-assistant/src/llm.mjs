/**
 * 可选 LLM 回复：任何 OpenAI 兼容接口都能用（DeepSeek / OpenAI / 本地 vLLM…）。
 * 配置里只放 baseUrl + model + 环境变量名，密钥永远不进仓库。
 *
 * 注意：deepseek-flash / deepseek-reasoner 这类推理模型会先消耗 reasoning tokens。
 * max_tokens 太小（比如 80）时正文会是空的，所以这里默认 512，并在空回复时自动翻倍重试。
 */

const usageNumber = (usage, ...paths) => {
  for (const keyPath of paths) {
    let value = usage
    for (const key of keyPath.split('.')) value = value?.[key]
    if (Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value)
  }
  return 0
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return
  const input = usageNumber(usage, 'input', 'prompt_tokens')
  const output = usageNumber(usage, 'output', 'completion_tokens')
  const reasoning = usageNumber(usage, 'reasoning', 'reasoning_tokens', 'completion_tokens_details.reasoning_tokens')
  const sum = usageNumber(usage, 'total', 'total_tokens') || input + output
  total.input += input
  total.output += output
  total.reasoning += reasoning
  total.total += sum
}

async function chat({ messages, llm, key, fetchImpl }) {
  const base = String(llm.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const url = `${base}/chat/completions`
  let maxTokens = Math.min(4096, Math.max(64, Number(llm.maxTokens ?? 512) || 512))
  const total = { input: 0, output: 0, reasoning: 0, total: 0 }
  const startedAt = Date.now()
  let requests = 0
  let finishReason = ''

  async function request() {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llm.model ?? 'deepseek-chat',
        messages,
        temperature: Number(llm.temperature ?? 0.8),
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(Number(llm.timeoutMs ?? 30_000)),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`LLM HTTP ${response.status}：${body.slice(0, 160)}`)
    }
    const data = await response.json()
    requests += 1
    addUsage(total, data?.usage)
    finishReason = String(data?.choices?.[0]?.finish_reason ?? '')
    return data
  }

  let data = await request()
  let content = String(data?.choices?.[0]?.message?.content ?? '').trim()

  // 推理模型把预算全花在 reasoning 上时，正文为空；翻倍再试一次。
  if (!content && finishReason === 'length' && maxTokens < 2048) {
    maxTokens = Math.min(2048, maxTokens * 2)
    data = await request()
    content = String(data?.choices?.[0]?.message?.content ?? '').trim()
  }
  if (!content) throw new Error('模型返回了空内容（推理模型可能 max_tokens 太小），请调大“最大 tokens”')

  return {
    text: content,
    usage: total,
    model: String(llm.model ?? ''),
    latencyMs: Date.now() - startedAt,
    requests,
    finishReason,
  }
}

/**
 * 生成一条弹幕回复。
 * @returns {Promise<{text:string, usage:object, model:string, latencyMs:number, requests:number, finishReason:string}>}
 */
export async function generateReply({ event, config, apiKey, recent = [], persona = '', fetchImpl = fetch }) {
  const llm = config ?? {}
  const key = apiKey ?? (llm.apiKeyEnv ? process.env[llm.apiKeyEnv] : '')
  if (!key) throw new Error(`没有 LLM 密钥：请设置环境变量 ${llm.apiKeyEnv || 'LLM_API_KEY'}`)

  const contextLimit = Math.max(0, Math.min(20, Number(llm.contextMessages ?? 0) || 0))
  const context = contextLimit > 0
    ? (recent ?? []).slice(-contextLimit).map((m) => ({ role: 'user', content: `观众「${m.uname}」说：${m.text}` }))
    : []
  const system = [String(persona ?? '').trim(), String(llm.systemPrompt ?? '').trim()].filter(Boolean).join('\n\n')
  const messages = [
    { role: 'system', content: system },
    ...context,
    { role: 'user', content: `观众「${event.uname}」说：${event.text}\n只输出你要发的这一条弹幕，不要解释。` },
  ]
  return chat({ messages, llm, key, fetchImpl })
}

/**
 * 生成一条主动热场弹幕。
 * @returns {Promise<{text:string, usage:object, model:string, latencyMs:number, requests:number, finishReason:string}>}
 */
export async function generateWarmup({ config, apiKey, persona = '', topics = [], recent = [], room = {}, fetchImpl = fetch }) {
  const llm = config ?? {}
  const key = apiKey ?? (llm.apiKeyEnv ? process.env[llm.apiKeyEnv] : '')
  if (!key) throw new Error(`没有 LLM 密钥：请设置环境变量 ${llm.apiKeyEnv || 'LLM_API_KEY'}`)

  const topicText = (topics ?? []).slice(0, 20).map((topic, index) => `${index + 1}. ${topic}`).join('\n') || '（没有预设话题，自己找一个轻话题）'
  const recentText = (recent ?? []).slice(-8).map((m) => `${m.uname}: ${m.text}`).join('\n') || '（最近没有弹幕）'
  const now = new Date()
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const system = [
    String(persona ?? '').trim(),
    String(llm.systemPrompt ?? '').trim(),
    '现在直播间很安静，没人发弹幕。你要主动发一条热场弹幕，轻轻把话题带起来。',
    '只输出这一条弹幕：口语化、像观众随口聊天；不要提自己是 AI；不要刷屏；不要连续追问；不超过 40 个字。',
  ].filter(Boolean).join('\n\n')
  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        `房间标题：${room.title || '未知'}`,
        `主播：${room.uname || '主播'}`,
        `现在：${clock}`,
        '',
        '最近弹幕：',
        recentText,
        '',
        '可选话题（挑一个方向，不要照抄）：',
        topicText,
        '',
        '写一条热场弹幕。',
      ].join('\n'),
    },
  ]
  return chat({ messages, llm, key, fetchImpl })
}
