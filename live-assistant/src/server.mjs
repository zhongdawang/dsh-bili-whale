import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { DEFAULTS, merge, loadConfig } from './config.mjs'
import { loadCredentials } from './credentials.mjs'
import { BiliLiveApi } from './api.mjs'
import { explainDecision } from './assistant.mjs'
import { generateReply } from './llm.mjs'
import { loadEnvFile, readJson } from './util.mjs'

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(SRC_DIR)
const PUBLIC = path.join(ROOT, 'public')
const CLI = path.join(SRC_DIR, 'cli.mjs')
const TRIGGERS = ['owner', 'mention', 'keyword', 'all']

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
}

const toInt = (v, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}
const toText = (v, fallback = '') => (typeof v === 'string' ? v : fallback)
const toBool = (v, fallback = false) => (typeof v === 'boolean' ? v : fallback)
const toList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 200) : [])
const toLines = (v) => toList(v).filter((x) => x.length <= 500)

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('请求体太大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function parseEnvFile(file) {
  const out = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return out
}

function upsertEnv(file, key, value) {
  let lines = []
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch {}
  let found = false
  lines = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (match && match[1] === key) { found = true; return `${key}=${value}` }
    return line
  })
  if (!found) lines.push(`${key}=${value}`)
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
}

export function startUiServer({ port = 7788, host = '127.0.0.1', configFile = path.join(ROOT, 'config.json') } = {}) {
  const envFile = path.join(ROOT, '.env')
  loadEnvFile(envFile)
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, '{}\n')

  const logs = []
  const clients = new Set()
  let child = null
  let childDryRun = null
  let startedAt = null

  const broadcast = (payload) => {
    const line = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of clients) {
      try { res.write(line) } catch { clients.delete(res) }
    }
  }
  const addLog = (line) => {
    const text = String(line ?? '').replace(/\r$/, '')
    if (!text) return
    logs.push(text)
    if (logs.length > 500) logs.shift()
    broadcast({ type: 'log', line: text })
  }

  const rawConfig = () => {
    try { return JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch { return {} }
  }
  const merged = () => merge(DEFAULTS, rawConfig())
  const resolvedDataDir = () => {
    const cfg = merged()
    return path.resolve(path.dirname(configFile), cfg.dataDir || './data')
  }
  const readCount = () => readJson(path.join(resolvedDataDir(), 'state.json'), { date: '', count: 0 })

  const credentialPath = () => {
    const cfg = merged()
    return cfg.credentialsFile
      ? path.resolve(path.dirname(configFile), cfg.credentialsFile)
      : path.join(os.homedir(), '.bili-ai', 'credentials.json')
  }

  const secretState = () => {
    const cfg = merged()
    const file = credentialPath()
    const cred = loadCredentials({ file, required: false })
    const env = parseEnvFile(envFile)
    const keyEnv = cfg.reply?.llm?.apiKeyEnv || 'LLM_API_KEY'
    return {
      credentialsPath: file,
      hasSessdata: !!cred.sessdata,
      hasJct: !!cred.bili_jct,
      hasBuvid: !!cred.buvid3,
      llmKeyEnv: keyEnv,
      hasLlmKey: !!(process.env[keyEnv] || env[keyEnv]),
    }
  }

  const status = () => {
    const count = readCount()
    return {
      running: !!child,
      pid: child?.pid ?? null,
      dryRun: childDryRun,
      startedAt,
      count,
    }
  }

  const broadcastStatus = () => broadcast({ type: 'status', status: status() })

  function normalizeConfig(input) {
    const raw = rawConfig()
    const out = { ...raw }
    if (input.room !== undefined) out.room = toText(input.room).trim().slice(0, 40)
    if (input.dryRun !== undefined) out.dryRun = toBool(input.dryRun, true)

    const rBase = merge(DEFAULTS.reply, raw.reply ?? {})
    const rIn = input.reply ?? {}
    const r = { ...(raw.reply ?? {}) }
    if (rIn.triggers !== undefined) r.triggers = toList(rIn.triggers).filter((t) => TRIGGERS.includes(t))
    if (rIn.ownerMid !== undefined) r.ownerMid = toInt(rIn.ownerMid, rBase.ownerMid)
    if (rIn.aliases !== undefined) r.aliases = toList(rIn.aliases)
    if (rIn.ignoreUids !== undefined) r.ignoreUids = toList(rIn.ignoreUids).map(Number).filter(Number.isFinite)
    if (rIn.ignoreNames !== undefined) r.ignoreNames = toList(rIn.ignoreNames)
    if (rIn.ignorePatterns !== undefined) r.ignorePatterns = toLines(rIn.ignorePatterns)
    if (rIn.templateReplies !== undefined) r.templateReplies = toList(rIn.templateReplies)
    if (rIn.maxLen !== undefined) r.maxLen = toInt(rIn.maxLen, rBase.maxLen, 1, 100)
    if (rIn.keywordRules !== undefined) {
      r.keywordRules = (Array.isArray(rIn.keywordRules) ? rIn.keywordRules : [])
        .slice(0, 200)
        .map((rule) => ({ match: toText(rule?.match).slice(0, 200), reply: toText(rule?.reply).slice(0, 200) }))
        .filter((rule) => rule.match)
    }
    if (rIn.llm !== undefined) {
      const llmBase = merge(DEFAULTS.reply.llm, raw.reply?.llm ?? {})
      const lIn = rIn.llm ?? {}
      r.llm = {
        ...(raw.reply?.llm ?? {}),
        enabled: toBool(lIn.enabled, llmBase.enabled),
        baseUrl: toText(lIn.baseUrl, llmBase.baseUrl).trim().slice(0, 300),
        model: toText(lIn.model, llmBase.model).trim().slice(0, 120),
        apiKeyEnv: toText(lIn.apiKeyEnv, llmBase.apiKeyEnv).trim().slice(0, 80) || 'LLM_API_KEY',
        temperature: Math.min(2, Math.max(0, Number(lIn.temperature ?? llmBase.temperature) || 0)),
        systemPrompt: toText(lIn.systemPrompt, llmBase.systemPrompt).slice(0, 4000),
      }
    }
    out.reply = r

    const tIn = input.throttle ?? {}
    const tBase = merge(DEFAULTS.throttle, raw.throttle ?? {})
    out.throttle = {
      ...(raw.throttle ?? {}),
      globalCooldownMs: toInt(tIn.globalCooldownMs, tBase.globalCooldownMs, 1000, 600_000),
      perUserCooldownMs: toInt(tIn.perUserCooldownMs, tBase.perUserCooldownMs, 0, 86_400_000),
      dailyCap: toInt(tIn.dailyCap, tBase.dailyCap, 0, 10_000),
      sameTextWindowMs: toInt(tIn.sameTextWindowMs, tBase.sameTextWindowMs, 0, 86_400_000),
    }

    for (const key of ['welcome', 'gift']) {
      if (input[key] !== undefined) {
        const base = merge(DEFAULTS[key], raw[key] ?? {})
        out[key] = {
          ...(raw[key] ?? {}),
          enabled: toBool(input[key].enabled, base.enabled),
          text: toText(input[key].text, base.text).slice(0, 300),
        }
      }
    }
    if (input.entry !== undefined) {
      out.entry = { ...(raw.entry ?? {}), enabled: toBool(input.entry.enabled, true) }
    }
    return out
  }

  function writeConfig(next) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    const temp = `${configFile}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(temp, configFile)
  }

  const state = () => ({
    ...status(),
    config: merged(),
    secrets: secretState(),
  })

  async function testConnection() {
    const cfg = loadConfig(configFile)
    if (!cfg.room) throw new Error('先填房间号')
    const cred = loadCredentials({ file: credentialPath(), required: false })
    const api = new BiliLiveApi(cred)
    const info = await api.resolveRoom(cfg.room)
    let account = null
    try { account = await api.nav() } catch (e) { account = { error: e.message } }
    let dm = null
    try {
      const data = await api.dmConfig(info.room_id)
      dm = { colors: data?.group?.length ?? 0, modes: data?.mode?.length ?? 0 }
    } catch (e) { dm = { error: e.message } }
    return {
      room: {
        roomId: info.room_id,
        shortId: info.short_id,
        title: info.title,
        uid: info.uid,
        live: info.live_status === 1,
        online: info.online,
      },
      account,
      canWrite: !!cred.bili_jct && Number(account?.mid ?? 0) > 0,
      dm,
    }
  }

  async function saveSecrets(input) {
    const file = credentialPath()
    let current = {}
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const next = { ...current }
    let changed = false
    for (const key of ['sessdata', 'bili_jct', 'buvid3']) {
      const value = toText(input[key]).trim()
      if (value) { next[key] = value; changed = true }
    }
    if (changed) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      try { fs.chmodSync(file, 0o600) } catch {}
    }

    const cfg = merged()
    const keyEnv = cfg.reply?.llm?.apiKeyEnv || 'LLM_API_KEY'
    const llmKey = toText(input.llmApiKey).trim()
    if (llmKey) {
      upsertEnv(envFile, keyEnv, llmKey)
      process.env[keyEnv] = llmKey
    }
    return secretState()
  }

  async function startAssistant(dryRun, verbose = false) {
    if (child) throw new Error('已经在运行了')
    const cfg = loadConfig(configFile)
    if (!cfg.room) throw new Error('先填房间号')
    if (!dryRun) {
      const cred = loadCredentials({ file: credentialPath(), required: false })
      if (!cred.sessdata || !cred.bili_jct) throw new Error('真实发送需要 SESSDATA + bili_jct')
    }
    const args = [CLI, 'start', '--config', configFile]
    if (!dryRun) args.push('--go')
    if (verbose) args.push('--verbose')
    child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    childDryRun = dryRun
    startedAt = Date.now()
    addLog(`— 启动${dryRun ? '（dry-run）' : '（真实发送）'} pid=${child.pid} —`)
    readline.createInterface({ input: child.stdout }).on('line', (line) => addLog(line))
    readline.createInterface({ input: child.stderr }).on('line', (line) => addLog(`[err] ${line}`))
    child.on('error', (e) => addLog(`[err] 启动失败：${e.message}`))
    child.on('exit', (code, signal) => {
      addLog(`— 已停止（code=${code ?? '-'} signal=${signal ?? '-'}）—`)
      child = null
      childDryRun = null
      startedAt = null
      broadcastStatus()
    })
    broadcastStatus()
    return status()
  }

  function stopAssistant() {
    if (!child) return status()
    addLog('— 正在停止… —')
    try { child.kill('SIGTERM') } catch {}
    const pid = child.pid
    setTimeout(() => {
      // 进程已经退出时 child 会被置空；这里只处理还活着的。
      if (child && child.pid === pid) { try { child.kill('SIGKILL') } catch {} }
    }, 3000)
    return status()
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`)
    const pathname = url.pathname

    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname]
      try {
        const body = fs.readFileSync(path.join(PUBLIC, file))
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
        res.end(body)
      } catch {
        json(res, 404, { error: '静态文件不存在' })
      }
      return
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      json(res, 200, state())
      return
    }

    if (req.method === 'GET' && pathname === '/api/logs/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      clients.add(res)
      res.write(`data: ${JSON.stringify({ type: 'history', lines: logs })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'status', status: status() })}\n\n`)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15_000)
      req.on('close', () => { clearInterval(ping); clients.delete(res) })
      return
    }

    if (req.method !== 'POST' || !pathname.startsWith('/api/')) {
      json(res, 404, { error: 'not found' })
      return
    }

    // 简单同源检查：防止别的网站借浏览器打本地接口。
    const origin = req.headers.origin
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      json(res, 403, { error: 'origin 不允许' })
      return
    }

    let body
    try { body = await readBody(req) } catch (e) { json(res, 400, { error: e.message }); return }

    try {
      if (pathname === '/api/config') {
        writeConfig(normalizeConfig(body))
        json(res, 200, { ok: true, config: merged() })
        return
      }
      if (pathname === '/api/secrets') {
        json(res, 200, { ok: true, secrets: await saveSecrets(body) })
        return
      }
      if (pathname === '/api/test') {
        json(res, 200, { ok: true, ...(await testConnection()) })
        return
      }
      if (pathname === '/api/test/llm') {
        const cfg = loadConfig(configFile)
        const reply = await generateReply({
          event: { uname: '测试观众', text: '你好，随便聊一句' },
          config: cfg.reply.llm,
        })
        json(res, 200, { ok: true, reply })
        return
      }
      if (pathname === '/api/simulate') {
        const cfg = loadConfig(configFile)
        const event = {
          kind: 'danmaku',
          uid: Number(body.uid ?? 123456),
          uname: String(body.name ?? '测试观众'),
          text: String(body.text ?? ''),
          roomId: cfg.room,
        }
        json(res, 200, { ok: true, ...explainDecision(event, cfg) })
        return
      }
      if (pathname === '/api/start') {
        json(res, 200, { ok: true, status: await startAssistant(body.dryRun !== false, body.verbose === true) })
        return
      }
      if (pathname === '/api/stop') {
        json(res, 200, { ok: true, status: stopAssistant() })
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (e) {
      json(res, 500, { error: e.message })
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try { json(res, 500, { error: e.message }) } catch {}
    })
  })

  server.on('error', (e) => {
    console.error(`控制台启动失败：${e.message}`)
    if (e.code === 'EADDRINUSE') console.error(`  端口 ${port} 被占用了，换一个：--port 7789`)
    process.exitCode = 1
  })

  server.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
    addLog(`控制台已启动：${url}`)
    console.log(`\n  直播间弹幕助手 · 控制台\n  ${url}\n  配置文件：${configFile}\n  凭据文件：${credentialPath()}\n`)
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.log('  ⚠ 当前监听的不是 127.0.0.1，同网段的人可能访问到控制台；建议只在本机使用。\n')
    }
  })

  const shutdown = () => {
    stopAssistant()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return server
}
