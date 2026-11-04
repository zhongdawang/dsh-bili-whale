import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 轻量参数解析：`--key value` 或 `--flag`。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  const values = new Map()
  const flags = new Set()
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) flags.add(key)
    else { values.set(key, next); i += 1 }
  }
  return { command, values, flags }
}

export function expandHome(file) {
  if (!file) return file
  if (file === '~') return os.homedir()
  if (file.startsWith('~/') || file.startsWith('~\\')) return path.join(os.homedir(), file.slice(2))
  return file
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(temp, file)
}

export function truncate(text, max) {
  const chars = [...String(text ?? '')]
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('')
}

/** 弹幕里不能有换行；顺便去掉包裹的引号。 */
export function cleanReply(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .trim()
}

export function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

export function log(...args) {
  console.log(`[${stamp()}]`, ...args)
}
