import { cleanReply, truncate } from './util.mjs'

/** 关键词支持普通字符串（包含匹配）和 `/正则/flags`。 */
export function matches(pattern, text) {
  const source = String(pattern ?? '')
  const regex = /^\/(.*)\/([a-z]*)$/.exec(source)
  if (regex) {
    try { return new RegExp(regex[1], regex[2]).test(text) } catch { return false }
  }
  return text.includes(source)
}

export function findRule(rules, text) {
  for (const rule of rules ?? []) {
    if (!rule || typeof rule !== 'object') continue
    if (matches(rule.match, text)) return rule
  }
  return null
}

export function render(template, event, extra = {}) {
  return String(template ?? '')
    .replaceAll('{name}', String(event.uname ?? ''))
    .replaceAll('{text}', String(event.text ?? ''))
    .replaceAll('{room}', String(event.roomId ?? ''))
    .replaceAll('{gift}', String(extra.gift ?? ''))
}

let templateCursor = 0
/** 模板回复：轮着用，避免每次都是同一句。 */
export function pickTemplate(config, event, random = Math.random) {
  const list = (config?.templateReplies ?? []).filter(Boolean)
  if (!list.length) return ''
  if (list.length === 1) return render(list[0], event)
  // 大部分时候轮换；偶尔随机，避免太机械。
  const index = random() < 0.5 ? templateCursor++ % list.length : Math.floor(random() * list.length)
  return render(list[index], event)
}

export function compileIgnore(config) {
  const patterns = (config?.ignorePatterns ?? []).map((p) => {
    try { return new RegExp(String(p)) } catch { return null }
  }).filter(Boolean)
  return (text) => patterns.some((re) => re.test(text))
}

/**
 * 判断一条弹幕该不该回。
 * 返回 null = 不回；否则 `{ reason, text, rule }`，text 为空表示需要 LLM/模板再生成。
 */
export function decide(event, replyConfig, { selfMid = 0, selfName = '' } = {}) {
  const text = String(event?.text ?? '').trim()
  if (!text) return null
  if (selfMid && Number(event.uid) === Number(selfMid) && !replyConfig.allowSelf) return null
  if ((replyConfig.ignoreUids ?? []).map(Number).includes(Number(event.uid))) return null
  if ((replyConfig.ignoreNames ?? []).some((name) => name && String(event.uname ?? '').includes(name))) return null
  if (compileIgnore(replyConfig)(text)) return null

  const triggers = new Set(replyConfig.triggers ?? [])
  const aliases = [...(replyConfig.aliases ?? []), selfName].filter(Boolean)
  const isOwner = !!replyConfig.ownerMid && Number(event.uid) === Number(replyConfig.ownerMid)
  const isMention = aliases.some((alias) => text.includes(alias))
  const rule = findRule(replyConfig.keywordRules, text)

  let reason = ''
  if (triggers.has('owner') && isOwner) reason = 'owner'
  else if (triggers.has('keyword') && rule) reason = 'keyword'
  else if (triggers.has('mention') && isMention) reason = 'mention'
  else if (triggers.has('all')) reason = 'all'
  if (!reason) return null

  const textOut = rule?.reply ? render(rule.reply, event) : ''
  return { reason, text: textOut, rule, isOwner, isMention, mentionName: isMention ? aliases.find((a) => text.includes(a)) : '' }
}

/** 最终发出去之前统一清洗 + 截断（B站普通账号弹幕上限很短）。 */
export function finalizeReply(text, maxLen = 20) {
  return truncate(cleanReply(text), Math.max(1, Number(maxLen) || 20))
}
