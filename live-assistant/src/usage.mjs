import fs from 'node:fs'
import path from 'node:path'
import { sleep } from './util.mjs'

const today = () => new Date().toLocaleDateString('sv-SE')

export const usagePath = (dataDir) => path.join(dataDir, 'usage.json')

const zero = (date = today()) => ({
  date,
  input: 0,
  output: 0,
  reasoning: 0,
  total: 0,
  calls: 0,
  lastAt: null,
  lastLatencyMs: 0,
  lastModel: '',
  lastFinishReason: '',
})

export function normalizeUsage(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, n) : 0
  }
  return {
    date: typeof value.date === 'string' && value.date ? value.date : today(),
    input: num(value.input),
    output: num(value.output),
    reasoning: num(value.reasoning),
    total: num(value.total),
    calls: num(value.calls),
    lastAt: typeof value.lastAt === 'string' ? value.lastAt : null,
    lastLatencyMs: num(value.lastLatencyMs),
    lastModel: String(value.lastModel ?? ''),
    lastFinishReason: String(value.lastFinishReason ?? ''),
  }
}

export function readUsage(file) {
  try { return normalizeUsage(JSON.parse(fs.readFileSync(file, 'utf8'))) }
  catch { return normalizeUsage({}) }
}

function pickUsage(usage, ...paths) {
  for (const keyPath of paths) {
    let value = usage
    for (const key of keyPath.split('.')) value = value?.[key]
    if (Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value)
  }
  return 0
}

/**
 * 累加一次 LLM 调用的 token 用量。
 * 同时兼容我们自己的 {input, output, reasoning, total} 和原始 API 的 usage 结构。
 */
export async function recordUsage(file, usage = {}, meta = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  let fd
  for (let i = 0; i < 500; i += 1) {
    try {
      fd = fs.openSync(lock, 'wx')
      try { fs.writeFileSync(fd, String(process.pid)) } catch {}
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // 进程崩溃可能留下锁文件；超过 10 秒就当作陈旧锁清掉。
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock)
      } catch {}
      if (i === 499) throw new Error('Token 用量文件锁超时')
      await sleep(10)
    }
  }
  try {
    const current = readUsage(file)
    const date = today()
    const base = current.date === date ? current : normalizeUsage({ date })
    const input = pickUsage(usage, 'input', 'prompt_tokens')
    const output = pickUsage(usage, 'output', 'completion_tokens')
    const reasoning = pickUsage(usage, 'reasoning', 'reasoning_tokens', 'completion_tokens_details.reasoning_tokens')
    const total = pickUsage(usage, 'total', 'total_tokens') || input + output
    const next = normalizeUsage({
      ...base,
      input: base.input + input,
      output: base.output + output,
      reasoning: base.reasoning + reasoning,
      total: base.total + total,
      calls: base.calls + 1,
      lastAt: new Date().toISOString(),
      lastLatencyMs: Number(meta.latencyMs ?? 0),
      lastModel: String(meta.model ?? ''),
      lastFinishReason: String(meta.finishReason ?? ''),
    })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n')
    fs.renameSync(temp, file)
    return next
  } finally {
    try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(lock) } catch {}
  }
}
