const dayOf = (value = Date.now()) => new Date(value).toLocaleDateString('sv-SE')

const parseHM = (text) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) return null
  return hours * 60 + minutes
}

/** "02:00-08:00" 或 "02:00-08:00,12:00-13:30"；支持跨午夜。 */
export function parseQuietHours(spec) {
  return String(spec ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [startText, endText] = part.split('-')
      const start = parseHM(startText)
      const end = parseHM(endText)
      if (start == null || end == null) return null
      return { start, end }
    })
    .filter(Boolean)
}

export function inQuietHours(spec, now = new Date()) {
  const ranges = parseQuietHours(spec)
  if (!ranges.length) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  return ranges.some(({ start, end }) => (
    start === end ? false : start < end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end
  ))
}

export const emptyWarmupState = (now = Date.now()) => ({
  date: dayOf(now),
  times: [],
  lastAt: 0,
  consecutive: 0,
  lastTexts: [],
})

export function normalizeWarmupState(raw, now = Date.now()) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const today = dayOf(now)
  const times = (Array.isArray(value.times) ? value.times : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0 && now - n < 24 * 60 * 60_000)
    .slice(-500)
  const lastTexts = (Array.isArray(value.lastTexts) ? value.lastTexts : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(-50)
  return {
    date: today,
    times,
    lastAt: Number.isFinite(Number(value.lastAt)) ? Number(value.lastAt) : 0,
    // 跨天就重置连续次数；同一天重启则保留，避免重启后马上刷热场。
    consecutive: value.date === today && Number.isFinite(Number(value.consecutive)) ? Number(value.consecutive) : 0,
    lastTexts,
  }
}

/**
 * 自动热场是否该发。
 * @returns {{allowed:boolean, reason:string}}
 */
export function warmupDecision({ now = Date.now(), cfg = {}, state = emptyWarmupState(now), lastActivityAt = now, live = true, online = 0 } = {}) {
  if (!cfg.enabled) return { allowed: false, reason: '热场未开启' }
  if (!live) return { allowed: false, reason: '直播间未开播' }
  if (Number(online ?? 0) < Number(cfg.minOnline ?? 1)) return { allowed: false, reason: `在线人数低于 ${cfg.minOnline ?? 1}` }
  if (now - Number(lastActivityAt ?? 0) < Number(cfg.idleSec ?? 300) * 1000) {
    const left = Math.ceil((Number(cfg.idleSec ?? 300) * 1000 - (now - Number(lastActivityAt ?? 0))) / 1000)
    return { allowed: false, reason: `还没安静够（还差 ${left} 秒）` }
  }
  if (now - Number(state.lastAt ?? 0) < Number(cfg.minIntervalSec ?? 600) * 1000) {
    const left = Math.ceil((Number(cfg.minIntervalSec ?? 600) * 1000 - (now - Number(state.lastAt ?? 0))) / 1000)
    return { allowed: false, reason: `距上次热场太近（还差 ${left} 秒）` }
  }
  if (inQuietHours(cfg.quietHours, new Date(now))) return { allowed: false, reason: `安静时段 ${cfg.quietHours}` }

  const times = Array.isArray(state.times) ? state.times.map(Number).filter(Number.isFinite) : []
  const hourCount = times.filter((t) => now - t < 60 * 60_000).length
  if (hourCount >= Number(cfg.maxPerHour ?? 4)) return { allowed: false, reason: `本小时已达到 ${cfg.maxPerHour ?? 4} 条` }
  const dayCount = times.filter((t) => dayOf(t) === dayOf(now)).length
  if (dayCount >= Number(cfg.maxPerDay ?? 20)) return { allowed: false, reason: `今天已达到 ${cfg.maxPerDay ?? 20} 条` }

  const maxConsecutive = Number(cfg.maxConsecutive ?? 2)
  if (maxConsecutive > 0 && Number(state.consecutive ?? 0) >= maxConsecutive
    && now - Number(state.lastAt ?? 0) < Number(cfg.longCooldownSec ?? 1800) * 1000) {
    const left = Math.ceil((Number(cfg.longCooldownSec ?? 1800) * 1000 - (now - Number(state.lastAt ?? 0))) / 1000)
    return { allowed: false, reason: `连续 ${state.consecutive} 次没人接话，长冷却还差 ${left} 秒` }
  }
  return { allowed: true, reason: '可以热场' }
}

export function pickWarmupTopic(topics = [], lastTexts = [], random = Math.random) {
  const all = (Array.isArray(topics) ? topics : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  if (!all.length) return ''
  const recent = new Set((Array.isArray(lastTexts) ? lastTexts : []).map((x) => String(x).trim()))
  const fresh = all.filter((topic) => !recent.has(topic))
  const pool = fresh.length ? fresh : all
  return pool[Math.floor(random() * pool.length) % pool.length]
}

export function markActivity(state, now = Date.now()) {
  return { ...state, date: dayOf(now), consecutive: 0 }
}

export function markWarmup(state, text, now = Date.now()) {
  return {
    ...state,
    date: dayOf(now),
    times: [...state.times, now].slice(-500),
    lastAt: now,
    consecutive: Number(state.consecutive ?? 0) + 1,
    lastTexts: [...state.lastTexts, String(text ?? '').trim()].filter(Boolean).slice(-50),
  }
}
