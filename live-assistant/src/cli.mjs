#!/usr/bin/env node
import { loadConfig } from './config.mjs'
import { loadCredentials, hasWriteCredentials } from './credentials.mjs'
import { BiliLiveApi, DANMAKU_HINTS } from './api.mjs'
import { startAssistant, explainDecision } from './assistant.mjs'
import { parseArgs, log, loadEnvFile } from './util.mjs'

const HELP = `直播间弹幕助手（独立版，不依赖 DSH）

用法：
  node src/cli.mjs pre      --room <房间号>
  node src/cli.mjs start    [--room <房间号>] [--config <文件>] [--go] [--dry] [--verbose] [--seconds N]
  node src/cli.mjs send     --room <房间号> --msg "内容" (--dry | --go) [--reply-mid <uid> --reply-name <昵称>]
  node src/cli.mjs history  --room <房间号> [--limit 10]
  node src/cli.mjs simulate --text "你好" [--name 观众] [--uid 123] [--config <文件>]

安全约定：
  · start 默认 dry-run（只打印，不发）；要真发必须加 --go
  · send 必须显式给 --dry 或 --go
  · 凭据读 ~/.bili-ai/credentials.json 或 BILI_SESSDATA / BILI_JCT 环境变量
  · Node 22+（收弹幕用全局 WebSocket）
`

function requireRoom(values, config) {
  const room = String(values.get('room') ?? config?.room ?? '').trim()
  if (!room) throw new Error('需要 --room <房间号>（或配置文件里的 room）')
  return room
}

function makeApi(values, config) {
  const cred = loadCredentials({
    file: values.get('credentials') ?? config?.credentialsFile ?? '',
    required: false,
  })
  return { api: new BiliLiveApi(cred), cred }
}

async function main() {
  loadEnvFile()
  const { command, values, flags } = parseArgs()
  if (!command || command === 'help' || flags.has('help')) {
    console.log(HELP)
    process.exit(command ? 0 : 2)
  }

  if (command === 'pre') {
    const config = loadConfig(values.get('config'))
    const room = requireRoom(values, config)
    const { api, cred } = makeApi(values, config)
    const info = await api.resolveRoom(room)
    console.log(`房间：${info.room_id}（短号 ${info.short_id ?? '-'}）`)
    console.log(`标题：${info.title}`)
    console.log(`主播：uid=${info.uid}  直播中=${info.live_status === 1}  在线=${info.online ?? '-'}  关注=${info.attention ?? '-'}`)
    try {
      const self = await api.nav()
      const state = !hasWriteCredentials(cred) ? '只读（缺 SESSDATA/bili_jct）'
        : self.mid > 0 ? '可发弹幕' : '只读（登录态无效，检查 SESSDATA/bili_jct）'
      console.log(`账号：${self.uname || '(未登录)'} (mid ${self.mid || 0}) · ${state}`)
    } catch {}
    try {
      const dm = await api.dmConfig(info.room_id)
      console.log(`弹幕配置：code=${dm ? 0 : '?'} 可用颜色=${dm?.group?.length ?? '-'} 默认模式=${dm?.mode?.[0]?.mode ?? '-'}`)
    } catch (e) {
      console.log(`弹幕配置读取失败（不影响发送）：${e.message}`)
    }
    return
  }

  if (command === 'send') {
    const config = loadConfig(values.get('config'))
    const room = requireRoom(values, config)
    const msg = String(values.get('msg') ?? '').trim()
    if (!msg) throw new Error('缺少 --msg')
    const dry = flags.has('dry')
    const go = flags.has('go')
    if (dry === go) throw new Error('必须且只能给一个 --dry 或 --go')
    const cred = loadCredentials({
      file: values.get('credentials') ?? config.credentialsFile ?? '',
      required: !dry,
    })
    const api = new BiliLiveApi(cred)
    const info = await api.resolveRoom(room)
    console.log(`房间：${info.room_id}「${info.title}」`)
    console.log(`弹幕：${msg}（${[...msg].length} 字）`)
    if (dry) { console.log('[dry] 未发送'); return }
    const result = await api.sendDanmaku({
      roomId: info.room_id,
      msg,
      replyMid: values.get('reply-mid'),
      replyName: values.get('reply-name'),
      replyDmid: values.get('reply-dmid'),
    })
    console.log(`HTTP ${result.status}  code=${result.code} ${result.message}`)
    const hint = DANMAKU_HINTS[result.code]
    if (hint) console.log(`→ ${hint}`)
    process.exit(result.code === 0 ? 0 : 4)
  }

  if (command === 'history') {
    const config = loadConfig(values.get('config'))
    const room = requireRoom(values, config)
    const { api } = makeApi(values, config)
    const info = await api.resolveRoom(room)
    const rows = await api.history(info.room_id, { limit: Number(values.get('limit') ?? 10) })
    for (const row of rows) console.log(`[${row.timeline ?? ''}] uid=${row.uid} ${row.nickname}: ${row.text}`)
    return
  }

  if (command === 'start') {
    const config = loadConfig(values.get('config'))
    config.room = requireRoom(values, config)
    if (flags.has('verbose')) config.verbose = true
    const { api } = makeApi(values, config)
    const dryRun = flags.has('go') ? false : flags.has('dry') ? true : config.dryRun !== false
    if (!hasWriteCredentials({ sessdata: api.sessdata, bili_jct: api.bili_jct }) && !dryRun) {
      log('⚠ 缺少凭据，不能真实发送；已改为 dry-run')
    }
    const controller = new AbortController()
    const stop = () => {
      controller.abort()
      // WS 的 close 事件偶尔不回调；给一个兜底，别让 Ctrl-C 退不出去。
      setTimeout(() => process.exit(0), 1500)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    const seconds = Number(values.get('seconds') ?? 0)
    if (seconds > 0) setTimeout(stop, seconds * 1000)
    await startAssistant({
      config,
      api,
      dryRun: dryRun || !hasWriteCredentials({ sessdata: api.sessdata, bili_jct: api.bili_jct }),
      verbose: !!config.verbose,
      stopSignal: controller.signal,
    })
    process.exit(0)
  }

  if (command === 'simulate') {
    const config = loadConfig(values.get('config'))
    const event = {
      kind: 'danmaku',
      uid: Number(values.get('uid') ?? 123456),
      uname: String(values.get('name') ?? '测试观众'),
      text: String(values.get('text') ?? '你好'),
      dmid: 'simulate',
      roomId: config.room,
    }
    const result = explainDecision(event, config)
    console.log(JSON.stringify({ event, ...result }, null, 2))
    return
  }

  console.error(`未知命令：${command}\n`)
  console.log(HELP)
  process.exit(2)
}

main().catch((e) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
