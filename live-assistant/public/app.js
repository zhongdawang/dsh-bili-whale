const $ = (id) => document.getElementById(id)
let lastConfig = null
let toastTimer = null

const PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  openai: { baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  custom: null,
}

function inferProvider(baseUrl) {
  const value = String(baseUrl ?? '').toLowerCase()
  if (value.includes('deepseek')) return 'deepseek'
  if (value.includes('openai')) return 'openai'
  return 'custom'
}

function setModelOptions(models = [], reset = false) {
  const datalist = $('modelOptions')
  const existing = reset ? [] : [...datalist.options].map((option) => option.value)
  const all = [...new Set([...existing, ...models.filter(Boolean)])]
  datalist.textContent = ''
  for (const model of all) {
    const option = document.createElement('option')
    option.value = model
    datalist.appendChild(option)
  }
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = {}
  try { data = await response.json() } catch {}
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function toast(message, isError = false) {
  const el = $('toast')
  el.textContent = message
  el.classList.toggle('error', isError)
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200)
}

const csv = (id) => $(id).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
const lines = (id) => $(id).value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
const num = (id, fallback) => {
  const raw = $(id).value.trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function fill(config) {
  lastConfig = config
  $('room').value = config.room ?? ''
  $('roomLabel').textContent = config.room ? `房间 ${config.room}` : '未设置房间'

  const triggers = new Set(config.reply?.triggers ?? [])
  document.querySelectorAll('[data-trigger]').forEach((el) => { el.checked = triggers.has(el.dataset.trigger) })

  $('allowSelf').checked = !!config.reply?.allowSelf
  $('ownerMid').value = config.reply?.ownerMid || ''
  $('aliases').value = (config.reply?.aliases ?? []).join(', ')
  $('ignoreUids').value = (config.reply?.ignoreUids ?? []).join(', ')
  $('ignoreNames').value = (config.reply?.ignoreNames ?? []).join(', ')
  $('ignorePatterns').value = (config.reply?.ignorePatterns ?? []).join('\n')
  $('keywordRules').value = JSON.stringify(config.reply?.keywordRules ?? [], null, 2)
  $('templateReplies').value = (config.reply?.templateReplies ?? []).join(', ')
  $('maxLen').value = config.reply?.maxLen ?? 20

  $('llmEnabled').checked = !!config.reply?.llm?.enabled
  $('llmBaseUrl').value = config.reply?.llm?.baseUrl ?? ''
  $('llmModel').value = config.reply?.llm?.model ?? ''
  $('llmKeyEnv').value = config.reply?.llm?.apiKeyEnv ?? 'LLM_API_KEY'
  $('llmTemperature').value = config.reply?.llm?.temperature ?? 0.8
  $('llmPrompt').value = config.reply?.llm?.systemPrompt ?? ''

  const provider = inferProvider(config.reply?.llm?.baseUrl)
  $('llmProvider').value = provider
  setModelOptions(PROVIDERS[provider]?.models ?? [])

  $('globalCooldown').value = config.throttle?.globalCooldownMs ?? 10000
  $('perUserCooldown').value = config.throttle?.perUserCooldownMs ?? 120000
  $('dailyCap').value = config.throttle?.dailyCap ?? 120
  $('sameTextWindow').value = config.throttle?.sameTextWindowMs ?? 600000

  $('welcomeEnabled').checked = !!config.welcome?.enabled
  $('welcomeText').value = config.welcome?.text ?? ''
  $('giftEnabled').checked = !!config.gift?.enabled
  $('giftText').value = config.gift?.text ?? ''
  $('entryEnabled').checked = config.entry?.enabled !== false
}

function collectConfig() {
  let rules
  try { rules = JSON.parse($('keywordRules').value || '[]') }
  catch (e) { throw new Error(`关键词规则不是合法 JSON：${e.message}`) }
  if (!Array.isArray(rules)) throw new Error('关键词规则必须是 JSON 数组')

  return {
    room: $('room').value.trim(),
    reply: {
      triggers: [...document.querySelectorAll('[data-trigger]:checked')].map((el) => el.dataset.trigger),
      allowSelf: $('allowSelf').checked,
      ownerMid: num('ownerMid', 0),
      aliases: csv('aliases'),
      ignoreUids: csv('ignoreUids'),
      ignoreNames: csv('ignoreNames'),
      ignorePatterns: lines('ignorePatterns'),
      keywordRules: rules,
      templateReplies: csv('templateReplies'),
      maxLen: num('maxLen', 20),
      llm: {
        enabled: $('llmEnabled').checked,
        baseUrl: $('llmBaseUrl').value.trim(),
        model: $('llmModel').value.trim(),
        apiKeyEnv: $('llmKeyEnv').value.trim() || 'LLM_API_KEY',
        temperature: num('llmTemperature', 0.8),
        systemPrompt: $('llmPrompt').value,
      },
    },
    throttle: {
      globalCooldownMs: num('globalCooldown', 10000),
      perUserCooldownMs: num('perUserCooldown', 120000),
      dailyCap: num('dailyCap', 120),
      sameTextWindowMs: num('sameTextWindow', 600000),
    },
    welcome: { enabled: $('welcomeEnabled').checked, text: $('welcomeText').value },
    gift: { enabled: $('giftEnabled').checked, text: $('giftText').value },
    entry: { enabled: $('entryEnabled').checked },
  }
}

function renderStatus(status) {
  if (!status) return
  const badge = $('statusBadge')
  badge.className = 'badge ' + (status.running ? (status.dryRun ? 'dry' : 'live') : 'off')
  badge.textContent = status.running ? (status.dryRun ? 'dry-run 运行中' : '真实发送中') : '已停止'
  const count = status.count ?? {}
  $('statusMeta').textContent = `${count.count ?? 0} 条 / ${count.date || '-'} · pid ${status.pid ?? '-'}`
  $('btnStartDry').disabled = !!status.running
  $('btnStartGo').disabled = !!status.running
  $('btnStop').disabled = !status.running
}

function renderSecrets(secrets) {
  if (!secrets) return
  $('credPath').textContent = `凭据文件：${secrets.credentialsPath}`
  const badges = $('secretBadges')
  badges.textContent = ''
  const items = [
    ['SESSDATA', secrets.hasSessdata],
    ['bili_jct', secrets.hasJct],
    ['buvid3', secrets.hasBuvid],
    [secrets.llmKeyEnv || 'LLM_API_KEY', secrets.hasLlmKey],
  ]
  for (const [label, ok] of items) {
    const tag = document.createElement('span')
    tag.className = 'tag ' + (ok ? 'ok' : 'no')
    tag.textContent = `${ok ? '✓' : '✗'} ${label}`
    badges.appendChild(tag)
  }
}

async function load() {
  const data = await api('/api/state')
  fill(data.config)
  renderStatus(data)
  renderSecrets(data.secrets)
}

async function saveConfig(silent = false) {
  const config = collectConfig()
  if (!config.reply.triggers.length) throw new Error('至少选一个互动方式')
  const data = await api('/api/config', 'POST', config)
  lastConfig = data.config
  $('roomLabel').textContent = data.config.room ? `房间 ${data.config.room}` : '未设置房间'
  if (!silent) {
    fill(data.config)
    toast('配置已保存')
  }
  return data.config
}

async function start(dryRun) {
  if (!dryRun && !confirm('真实发送会用你的账号往直播间发弹幕，确定启动？')) return
  await saveConfig(true)
  const data = await api('/api/start', 'POST', { dryRun, verbose: $('verbose').checked })
  renderStatus(data.status)
  toast(dryRun ? '已启动 dry-run（只看不发）' : '已启动真实发送')
}

async function stop() {
  const data = await api('/api/stop', 'POST', {})
  renderStatus(data.status)
  toast('正在停止…')
}

async function testConnection() {
  await saveConfig(true)
  const data = await api('/api/test', 'POST', {})
  const room = data.room ?? {}
  const account = data.account ?? {}
  $('testResult').textContent = [
    `房间：${room.roomId ?? '?'}（短号 ${room.shortId ?? '-'}）「${room.title ?? ''}」`,
    `直播：${room.live ? '直播中' : '未开播'}   在线：${room.online ?? '-'}   主播 uid：${room.uid ?? '-'}`,
    `账号：${account.uname || '(未登录)'} (mid ${account.mid ?? 0})   ${data.canWrite ? '可以发弹幕 ✓' : '只读（检查 SESSDATA / bili_jct）'}`,
    data.dm?.error ? `弹幕配置：${data.dm.error}` : `弹幕配置：可用颜色 ${data.dm?.colors ?? '-'} 种`,
  ].join('\n')
  toast('连接测试完成')
}

async function saveSecrets() {
  const body = {}
  for (const key of ['sessdata', 'bili_jct', 'buvid3']) {
    const value = $(key === 'bili_jct' ? 'biliJct' : key).value.trim()
    if (value) body[key] = value
  }
  const llmApiKey = $('llmKey').value.trim()
  if (llmApiKey) body.llmApiKey = llmApiKey
  if (!Object.keys(body).length) { toast('没有填新的密钥', true); return }
  const data = await api('/api/secrets', 'POST', body)
  renderSecrets(data.secrets)
  for (const id of ['sessdata', 'biliJct', 'buvid3', 'llmKey']) $(id).value = ''
  toast('密钥已保存')
}

async function testLlm() {
  $('llmResult').textContent = '测试中…'
  try {
    await saveConfig(true)
    const data = await api('/api/test/llm', 'POST', {})
    $('llmResult').textContent = `回复：${data.reply}`
  } catch (e) {
    $('llmResult').textContent = `失败：${e.message}`
  }
}

async function fetchModels() {
  $('modelsResult').textContent = '获取中…'
  try {
    if ($('llmKey').value.trim()) await saveSecrets()
    await saveConfig(true)
    const data = await api('/api/models', 'POST', {})
    setModelOptions(data.models)
    if (!$('llmModel').value.trim() && data.models.length) $('llmModel').value = data.models[0]
    $('modelsResult').textContent = data.models.length
      ? `拿到 ${data.models.length} 个模型，点模型框选择`
      : '接口没返回模型，手动填即可'
  } catch (e) {
    $('modelsResult').textContent = `失败：${e.message}`
  }
}

let qrId = null
let qrTimer = null
let qrClosed = false

function renderQr(url) {
  try {
    const qr = qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    $('qrImg').src = qr.createDataURL(6, 8)
  } catch (e) {
    $('qrStatus').textContent = `二维码渲染失败：${e.message}`
  }
}

async function pollQr() {
  if (!qrId || qrClosed) return
  try {
    const data = await api(`/api/auth/qr/poll?id=${encodeURIComponent(qrId)}`)
    if (data.status === 'success') {
      $('qrStatus').textContent = data.account
        ? `登录成功：${data.account.uname} (mid ${data.account.mid})`
        : '登录成功'
      if (data.secrets) renderSecrets(data.secrets)
      for (const id of ['sessdata', 'biliJct', 'buvid3']) $(id).value = ''
      toast('扫码登录成功')
      setTimeout(() => { if (!qrClosed) $('qrModal').classList.add('hidden') }, 1600)
      return
    }
    const labels = {
      waiting: '等待扫码…',
      scanned: '已扫码，请在手机上确认…',
      expired: '二维码已过期，点“重新生成”',
      cancelled: '已取消',
      error: `失败：${data.error || '请重试'}`,
    }
    $('qrStatus').textContent = labels[data.status] ?? data.status
    if (['expired', 'error', 'cancelled'].includes(data.status)) return
    qrTimer = setTimeout(pollQr, 2000)
  } catch (e) {
    $('qrStatus').textContent = `轮询失败：${e.message}`
    qrTimer = setTimeout(pollQr, 3000)
  }
}

async function startQrFlow() {
  clearTimeout(qrTimer)
  qrTimer = null
  if (qrId) { try { await api('/api/auth/qr/cancel', 'POST', { id: qrId }) } catch {} }
  qrId = null
  $('qrImg').removeAttribute('src')
  $('qrStatus').textContent = '生成中…'
  try {
    const data = await api('/api/auth/qr/start', 'POST', {})
    qrId = data.id
    renderQr(data.qrUrl)
    $('qrStatus').textContent = '等待扫码…'
    pollQr()
  } catch (e) {
    $('qrStatus').textContent = `生成失败：${e.message}`
  }
}

async function openQrModal() {
  qrClosed = false
  $('qrModal').classList.remove('hidden')
  await startQrFlow()
}

function closeQrModal() {
  qrClosed = true
  clearTimeout(qrTimer)
  if (qrId) api('/api/auth/qr/cancel', 'POST', { id: qrId }).catch(() => {})
  qrId = null
  $('qrModal').classList.add('hidden')
}

function applyProvider() {
  const preset = PROVIDERS[$('llmProvider').value]
  if (!preset) return
  $('llmBaseUrl').value = preset.baseUrl
  $('llmModel').value = preset.models[0]
  setModelOptions(preset.models, true)
}

async function simulate() {
  await saveConfig(true)
  const data = await api('/api/simulate', 'POST', {
    text: $('simText').value,
    name: $('simName').value || '测试观众',
  })
  $('simResult').textContent = JSON.stringify(data, null, 2)
}

function bindLogs() {
  const logs = $('logs')
  let atBottom = true
  const append = (line) => {
    logs.textContent += (logs.textContent ? '\n' : '') + line
    if (atBottom) logs.scrollTop = logs.scrollHeight
  }
  logs.addEventListener('scroll', () => {
    atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 30
  })
  $('btnClear').onclick = () => { logs.textContent = '' }

  const source = new EventSource('/api/logs/stream')
  source.onmessage = (event) => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (message.type === 'history') {
      logs.textContent = ''
      for (const line of message.lines ?? []) append(line)
    } else if (message.type === 'log') {
      append(message.line)
    } else if (message.type === 'status') {
      renderStatus(message.status)
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  bindLogs()
  $('btnStartDry').onclick = () => start(true).catch((e) => toast(e.message, true))
  $('btnStartGo').onclick = () => start(false).catch((e) => toast(e.message, true))
  $('btnStop').onclick = () => stop().catch((e) => toast(e.message, true))
  $('btnSave').onclick = () => saveConfig(false).catch((e) => toast(e.message, true))
  $('btnTest').onclick = () => testConnection().catch((e) => { $('testResult').textContent = `✗ ${e.message}` })
  $('btnSaveSecrets').onclick = () => saveSecrets().catch((e) => toast(e.message, true))
  $('btnTestLlm').onclick = () => testLlm()
  $('btnModels').onclick = () => fetchModels()
  $('llmProvider').onchange = () => applyProvider()
  $('btnQrLogin').onclick = () => openQrModal().catch((e) => toast(e.message, true))
  $('btnQrRefresh').onclick = () => startQrFlow()
  $('btnQrClose').onclick = () => closeQrModal()
  $('qrModal').onclick = (event) => { if (event.target === $('qrModal')) closeQrModal() }
  $('btnSim').onclick = () => simulate().catch((e) => { $('simResult').textContent = `✗ ${e.message}` })

  try { await load() }
  catch (e) { toast(`加载失败：${e.message}`, true) }
})
