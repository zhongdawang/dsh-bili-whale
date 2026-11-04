import fs from 'node:fs'
import path from 'node:path'

/** 中性默认值：不填配置也能跑，但默认只读（dryRun=true）、只回应 @ / 关键词。 */
export const DEFAULTS = {
  room: '',
  dryRun: true,
  dataDir: './data',
  credentialsFile: '',
  reply: {
    // owner = 只回主人；mention = 有人 @ 她；keyword = 命中关键词；all = 所有弹幕
    triggers: ['mention', 'keyword'],
    // 单号测试用：允许回复“自己账号”发的弹幕；会跳过自己刚发出去的回复，防循环。
    allowSelf: false,
    ownerMid: 0,
    aliases: [],
    ignoreUids: [],
    ignoreNames: [],
    ignorePatterns: ['^\\s*$'],
    keywordRules: [
      { match: '你好', reply: '你好呀 {name}～' },
      { match: '晚安', reply: '晚安 {name}，早点休息' },
    ],
    templateReplies: ['在呢', '收到～', '嗯嗯'],
    maxLen: 20,
    llm: {
      enabled: false,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeyEnv: 'LLM_API_KEY',
      temperature: 0.8,
      systemPrompt: '你是 B 站直播间里的一个观众。回复要短、自然、像真人聊天，不超过 20 个字；不要刷屏，不要提自己是 AI，不要复述对方的话。',
    },
  },
  throttle: {
    globalCooldownMs: 10_000,
    perUserCooldownMs: 90_000,
    dailyCap: 60,
    sameTextWindowMs: 10 * 60_000,
  },
  welcome: { enabled: false, text: '欢迎 {name} 进入直播间～' },
  gift: { enabled: false, text: '感谢 {name} 的 {gift}～' },
  entry: { enabled: true },
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v)

export function merge(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isObject(v) ? merge(isObject(base[k]) ? base[k] : {}, v) : v
  }
  return out
}

/** 读配置：--config 指定 → ./live-assistant.config.json → ./config.json。 */
export function loadConfig(file) {
  if (file && !fs.existsSync(path.resolve(file))) {
    throw new Error(`配置文件不存在：${path.resolve(file)}`)
  }
  const candidates = file
    ? [path.resolve(file)]
    : [path.resolve('live-assistant.config.json'), path.resolve('config.json')]
  let user = {}
  let used = ''
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    try {
      user = JSON.parse(fs.readFileSync(p, 'utf8'))
      used = p
      break
    } catch (e) {
      throw new Error(`配置文件不是合法 JSON：${p}\n  ${e.message}`)
    }
  }
  const config = merge(DEFAULTS, user)
  config.__file = used
  config.__dir = used ? path.dirname(used) : process.cwd()
  config.dataDir = path.resolve(config.__dir, config.dataDir || './data')
  return config
}
