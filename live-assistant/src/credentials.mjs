import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const clean = (v) => String(v ?? '').replace(/^["'\s]+|["'\s]+$/g, '')

/**
 * 凭据查找顺序：
 *   1. --credentials 指定的文件
 *   2. 环境变量 BILI_SESSDATA / BILI_JCT / BILI_BUVID3
 *   3. ~/.bili-ai/credentials.json（和原项目共用）
 *   4. ./credentials.json
 * 只读接口没有凭据也能跑；发弹幕必须有 SESSDATA + bili_jct。
 */
export function loadCredentials({ file, required = false } = {}) {
  let raw = {}
  const candidates = file
    ? [path.resolve(file)]
    : [path.join(os.homedir(), '.bili-ai', 'credentials.json'), path.resolve('credentials.json')]
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    try { raw = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {
      throw new Error(`凭据文件不是合法 JSON：${p}\n  ${e.message}`)
    }
    break
  }

  const cred = {
    sessdata: clean(process.env.BILI_SESSDATA ?? raw.sessdata),
    bili_jct: clean(process.env.BILI_JCT ?? raw.bili_jct),
    buvid3: clean(process.env.BILI_BUVID3 ?? raw.buvid3),
  }
  const missing = []
  if (!cred.sessdata) missing.push('SESSDATA')
  if (!cred.bili_jct) missing.push('bili_jct')
  if (required && missing.length) {
    throw new Error(
      `缺少凭据：${missing.join(' / ')}\n` +
      '  放到 ~/.bili-ai/credentials.json（和原项目同一份），或设环境变量，或 --credentials <文件>。\n' +
      '  SESSDATA 是 HttpOnly，必须从浏览器 F12 → Application → Cookies 手动复制。',
    )
  }
  return cred
}

export function hasWriteCredentials(cred) {
  return !!(cred?.sessdata && cred?.bili_jct)
}
