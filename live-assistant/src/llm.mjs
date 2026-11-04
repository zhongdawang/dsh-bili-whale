/**
 * 可选 LLM 回复：任何 OpenAI 兼容接口都能用（DeepSeek / OpenAI / 本地 vLLM…）。
 * 配置里只放 baseUrl + model + 环境变量名，密钥永远不进仓库。
 */
export async function generateReply({ event, config, apiKey, recent = [], fetchImpl = fetch }) {
  const llm = config ?? {}
  const key = apiKey ?? (llm.apiKeyEnv ? process.env[llm.apiKeyEnv] : '')
  if (!key) throw new Error(`没有 LLM 密钥：请设置环境变量 ${llm.apiKeyEnv || 'LLM_API_KEY'}`)
  const base = String(llm.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const url = `${base}/chat/completions`
  const context = (recent ?? []).slice(-6).map((m) => ({ role: 'user', content: `观众「${m.uname}」说：${m.text}` }))
  const messages = [
    { role: 'system', content: String(llm.systemPrompt ?? '') },
    ...context,
    { role: 'user', content: `观众「${event.uname}」说：${event.text}\n只输出你要发的这一条弹幕，不要解释。` },
  ]
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: llm.model ?? 'deepseek-chat',
      messages,
      temperature: Number(llm.temperature ?? 0.8),
      max_tokens: 80,
      stream: false,
    }),
    signal: AbortSignal.timeout(Number(llm.timeoutMs ?? 20_000)),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`LLM HTTP ${response.status}：${body.slice(0, 160)}`)
  }
  const data = await response.json()
  return String(data?.choices?.[0]?.message?.content ?? '')
}
