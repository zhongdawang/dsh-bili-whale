import path from 'node:path'
import { connectDanmaku } from './ws.mjs'
import { decide, pickTemplate, finalizeReply } from './reply.mjs'
import { generateReply } from './llm.mjs'
import { log, readJson, writeJson } from './util.mjs'

const today = () => new Date().toLocaleDateString('sv-SE')

function parseDanmaku(obj) {
  const info = obj.info ?? []
  return {
    kind: 'danmaku',
    text: String(info[1] ?? ''),
    uid: Number(info[2]?.[0] ?? 0),
    uname: String(info[2]?.[1] ?? ''),
    admin: !!info[2]?.[2],
    dmid: String(info[0]?.[5] ?? obj?.data?.msg_id ?? `${info[9]?.ct ?? Date.now()}-${info[2]?.[0] ?? 0}-${info[1] ?? ''}`),
    at: Number(info[9]?.ct ?? 0),
    raw: obj,
  }
}

function parseInteract(obj) {
  const data = obj.data ?? {}
  return {
    kind: 'interact',
    text: '',
    uid: Number(data.uid ?? 0),
    uname: String(data.uname ?? ''),
    type: Number(data.msg_type ?? 0), // 1 进入 / 2 关注 / 3 分享
    dmid: `interact-${data.uid}-${data.timestamp ?? Date.now()}`,
    raw: obj,
  }
}

function parseGift(obj) {
  const data = obj.data ?? {}
  return {
    kind: 'gift',
    text: '',
    uid: Number(data.uid ?? 0),
    uname: String(data.uname ?? ''),
    gift: String(data.giftName ?? ''),
    num: Number(data.num ?? 1),
    dmid: `gift-${data.uid}-${data.timestamp ?? Date.now()}-${data.giftName ?? ''}`,
    raw: obj,
  }
}

function waitOrStop(ms, isStopped) {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (isStopped() || Date.now() - started >= ms) {
        clearInterval(timer)
        resolve()
      }
    }, 250)
  })
}

/**
 * 启动直播间助手。
 * @returns {Promise<void>} 直到 stop() 被调用。
 */
export async function startAssistant({ config, api, dryRun = true, verbose = false, stopSignal }) {
  const stateFile = path.join(config.dataDir, 'state.json')
  const state = readJson(stateFile, { date: today(), count: 0 }) ?? { date: today(), count: 0 }
  const seen = new Set()
  const lastUser = new Map()
  const lastText = new Map()
  const selfSent = new Map()   // 自己刚发出去的回复 → 时间，用来忽略回声
  const recent = []
  let lastGlobal = 0
  let replying = false

  const roomInfo = await api.resolveRoom(config.room)
  const roomId = roomInfo.room_id
  let self = { mid: 0, uname: '' }
  try { self = await api.nav() } catch (e) { log(`匿名模式（nav 读取失败）：${e.message}`) }
  if (self.uname && !(config.reply.aliases ?? []).includes(self.uname)) config.reply.aliases.push(self.uname)

  const canWrite = !!api.bili_jct && self.mid > 0
  if (!canWrite && !dryRun) {
    log('⚠ 没有可用的登录态（缺 bili_jct 或 nav mid=0），发不出去；已切回 dry-run')
    dryRun = true
  }

  log(`房间 ${roomId}「${roomInfo.title}」 短号=${roomInfo.short_id ?? '-'} 主播uid=${roomInfo.uid}`)
  log(`身份：${self.uname || '(匿名)'} (mid ${self.mid || 0}) · 触发=${config.reply.triggers.join('/')} · ${dryRun ? 'dry-run（只看不发）' : '真实发送'}`)
  log(`限速：全局 ${config.throttle.globalCooldownMs}ms · 同用户 ${config.throttle.perUserCooldownMs}ms · 每天 ${config.throttle.dailyCap} 条`)
  if (config.reply.llm?.enabled) {
    const keyEnv = config.reply.llm.apiKeyEnv || 'LLM_API_KEY'
    if (!process.env[keyEnv]) log(`⚠ 开了 LLM 但没找到 ${keyEnv}，会退回模板回复（在控制台“凭据 / 密钥”里填）`)
  }

  function passedThrottle(event, replyText) {
    const now = Date.now()
    if (now - lastGlobal < config.throttle.globalCooldownMs) return '全局冷却'
    if (now - (lastUser.get(event.uid) ?? 0) < config.throttle.perUserCooldownMs) return '同用户冷却'
    if (state.date !== today()) { state.date = today(); state.count = 0 }
    if (state.count >= config.throttle.dailyCap) return '今日上限'
    const key = `${event.uid}|${replyText}`
    if (now - (lastText.get(key) ?? 0) < config.throttle.sameTextWindowMs) return '重复内容'
    return null
  }

  async function deliver(event, text, reason) {
    let reply = finalizeReply(text, config.reply.maxLen)
    if (!reply) {
      const llm = config.reply.llm
      const keyEnv = llm?.apiKeyEnv || 'LLM_API_KEY'
      if (llm?.enabled && process.env[keyEnv]) {
        try { reply = finalizeReply(await generateReply({ event, config: llm, recent }), config.reply.maxLen) } catch (e) {
          log(`LLM 失败：${e.message}`)
        }
      }
      if (!reply) reply = finalizeReply(pickTemplate(config.reply, event), config.reply.maxLen)
    }
    if (!reply) return false

    const blocked = passedThrottle(event, reply)
    if (blocked) { log(`跳过（${blocked}）：${event.uname} → ${reply}`); return false }

    const now = Date.now()
    lastGlobal = now
    lastUser.set(event.uid, now)
    lastText.set(`${event.uid}|${reply}`, now)

    if (dryRun) {
      log(`[dry:${reason}] 回复 ${event.uname}：${reply}`)
      return true
    }
    // 先记下来：B 站会把这条回复回传，onDanmaku 看到同样文字就跳过。
    selfSent.set(reply, Date.now())
    const result = await api.sendDanmaku({ roomId, msg: reply, replyMid: event.uid, replyName: event.uname })
    if (result.code === 0) {
      state.date = today()
      state.count += 1
      writeJson(stateFile, state)
      log(`[${reason}] ✓ 回复 ${event.uname}：${reply}`)
    } else {
      log(`[${reason}] ✗ 发送失败 code=${result.code} ${result.message || ''}`)
    }
    return result.code === 0
  }

  async function onDanmaku(event) {
    if (!event.text || seen.has(event.dmid)) return
    seen.add(event.dmid)
    if (seen.size > 5000) seen.delete(seen.values().next().value)

    // 单号模式：自己发的测试弹幕也会被 B 站回传；但自己刚发出去的回复要忽略，防自问自答循环。
    if (config.reply.allowSelf && self.mid && event.uid === self.mid) {
      const now = Date.now()
      for (const [text, at] of selfSent) if (now - at > 10 * 60_000) selfSent.delete(text)
      if (selfSent.has(event.text.trim())) {
        if (verbose) log('  ↳ 收到自己的回声，已忽略（不是重复发送）')
        return
      }
    }

    if (verbose) log(`  ${event.uname}(${event.uid}): ${event.text}`)
    recent.push({ uname: event.uname, text: event.text })
    if (recent.length > 10) recent.shift()

    if (replying) return
    const decision = decide(event, config.reply, { selfMid: self.mid, selfName: self.uname })
    if (!decision) return
    replying = true
    try { await deliver(event, decision.text, decision.reason) }
    finally { replying = false }
  }

  async function onInteract(event) {
    if (!config.welcome?.enabled || event.type !== 1) return
    if (self.mid && event.uid === self.mid) return
    if (replying) return
    replying = true
    try { await deliver(event, config.welcome.text, 'welcome') }
    finally { replying = false }
  }

  async function onGift(event) {
    if (!config.gift?.enabled) return
    if (self.mid && event.uid === self.mid) return
    if (replying) return
    replying = true
    try { await deliver(event, config.gift.text, 'gift') }
    finally { replying = false }
  }

  let socket = null
  let stopped = false
  const isStopped = () => stopped || !!stopSignal?.aborted
  // Ctrl-C 时主动关 socket，否则会一直挂在“已连接”状态退不出去。
  const onAbort = () => { stopped = true; try { socket?.close() } catch {} }
  stopSignal?.addEventListener?.('abort', onAbort, { once: true })

  async function handleFrame(packet) {
    if (packet.op === 8) {
      try {
        const body = JSON.parse(packet.body.toString('utf8'))
        if (body.code !== 0) log(`认证失败 code=${body.code}（继续尝试收包）`)
      } catch {}
      return
    }
    if (packet.op !== 5) return
    let obj
    try { obj = JSON.parse(packet.body.toString('utf8')) } catch { return }
    const cmd = String(obj.cmd ?? '')
    if (cmd.startsWith('DANMU_MSG')) await onDanmaku(parseDanmaku(obj))
    else if (cmd.startsWith('INTERACT_WORD')) await onInteract(parseInteract(obj))
    else if (cmd.startsWith('SEND_GIFT')) await onGift(parseGift(obj))
  }

  let attempt = 0
  while (!isStopped()) {
    try {
      const info = await api.danmuInfo(roomId)
      const host = info?.host_list?.[0]
      if (!host || !info?.token) throw new Error('拿不到弹幕服务器 / token')
      const url = `wss://${host.host}:${host.wss_port}/sub`
      log(`连接 ${url}`)
      await new Promise((resolve) => {
        socket = connectDanmaku({
          url, token: info.token, uid: self.mid, roomId, buvid: api.buvid3,
          onOpen: () => {
            attempt = 0
            log('已进入直播间（开始收弹幕）')
            if (config.entry?.enabled) {
              api.entry(roomId).then((r) => {
                if (r?.body?.code !== 0) log(`进房动作返回 code=${r?.body?.code}（不影响收弹幕）`)
              }).catch((e) => log(`进房动作失败（忽略）：${e.message}`))
            }
          },
          onFrame: (packet) => { handleFrame(packet).catch((e) => log(`处理弹幕失败：${e.message}`)) },
          onError: (e) => log(`WS 错误：${e?.message ?? e?.type ?? 'unknown'}`),
          onClose: () => { socket = null; resolve() },
        })
      })
    } catch (e) {
      log(`连接失败：${e.message}`)
    }
    if (isStopped()) break
    const wait = Math.min(60_000, 3_000 * 2 ** Math.min(attempt, 4))
    attempt += 1
    log(`${Math.round(wait / 1000)} 秒后重连…`)
    await waitOrStop(wait, isStopped)
  }

  try { socket?.close() } catch {}
  stopSignal?.removeEventListener?.('abort', onAbort)
  log('已停止')
}

/** 供 CLI 的 simulate 用：不联网，只跑一遍规则。 */
export function explainDecision(event, config, self = { mid: 0, uname: '' }) {
  const decision = decide(event, config.reply, { selfMid: self.mid, selfName: self.uname })
  if (!decision) return { matched: false, reason: '没有命中任何触发条件 / 被过滤' }
  const text = decision.text || (config.reply.llm?.enabled ? '(需要 LLM 生成)' : pickTemplate(config.reply, event))
  return { matched: true, reason: decision.reason, text: finalizeReply(text, config.reply.maxLen) }
}
