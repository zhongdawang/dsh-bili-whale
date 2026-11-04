/**
 * 可选 LLM 回复：任何 OpenAI 兼容接口都能用（DeepSeek / OpenAI / 本地 vLLM…）。
 * 配置里只放 baseUrl + model + 环境变量名，密钥永远不进仓库。
 *
 * 注意：deepseek-flash / deepseek-reasoner 这类推理模型会先消耗 reasoning tokens。
 * max_tokens 太小（比如 80）时正文会是空的，所以这里默认 512，并在空回复时自动翻倍重试。
 */
export async function generateReply({ event, config, apiKey, recent = [], fetchImpl = fetch }) {
  const llm = config ?? {}
  const key = apiKey ?? (llm.apiKeyEnv ? process.env[llm.apiKeyEnv] : '')
  if (!key) throw new Error(`没有 LLM 密钥：请设置环境变量 ${llm.apiKeyEnv || 'LLM_API_KEY'}`)
  const base = String(llm.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const url = `${base}/chat/completions`
  const contextLimit = Math.max(0, Math.min(20, Number(llm.contextMessages ?? 0) || 0))
  const context = contextLimit > 0
    ? (recent ?? []).slice(-contextLimit).map((m) => ({ role: 'user', content: `观众「${m.uname}」说：${m.text}` }))
    : []
  const messages = [
    { role: 'system', content: String(llm.systemPrompt ?? '') },
    ...context,
    { role: 'user', content: `观众「${event.uname}」说：${event.text}\n只输出你要发的这一条弹幕，不要解释。` },
  ]
  let maxTokens = Math.min(4096, Math.max(64, Number(llm.maxTokens ?? 512) || 512))

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
    return response.json()
  }

  let data = await request()
  let content = String(data?.choices?.[0]?.message?.content ?? '').trim()

  // 推理模型把预算全花在 reasoning 上时，正文为空；翻倍再试一次。
  if (!content && data?.choices?.[0]?.finish_reason === 'length' && maxTokens < 2048) {
    maxTokens = Math.min(2048, maxTokens * 2)
    data = await request()
    content = String(data?.choices?.[0]?.message?.content ?? '').trim()
  }
  if (!content) throw new Error('模型返回了空内容（推理模型可能 max_tokens 太小），请调大“最大 tokens”')
  return content
}
