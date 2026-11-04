import crypto from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const LIVE_ORIGIN = 'https://live.bilibili.com'
// B站 WBI 的固定混淆表（2024 起未变）。
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]

export class BiliLiveApi {
  constructor({ sessdata = '', bili_jct = '', buvid3 = '', ua = UA } = {}) {
    this.sessdata = sessdata
    this.bili_jct = bili_jct
    this.buvid3 = buvid3
    this.ua = ua
    this.cookie = [
      sessdata ? `SESSDATA=${sessdata}` : '',
      bili_jct ? `bili_jct=${bili_jct}` : '',
      buvid3 ? `buvid3=${buvid3}` : '',
    ].filter(Boolean).join('; ')
    this.wbiCache = null
    this.self = null
  }

  headers(room) {
    return {
      'user-agent': this.ua,
      referer: `${LIVE_ORIGIN}/${room ?? ''}`,
      origin: LIVE_ORIGIN,
      ...(this.cookie ? { cookie: this.cookie } : {}),
    }
  }

  async request(url, { room, ...options } = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { ...this.headers(room), ...(options.headers ?? {}) },
      signal: options.signal ?? AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = { code: -1, message: text.slice(0, 200) } }
    return { status: response.status, body }
  }

  async getJson(url, options = {}) {
    const { status, body } = await this.request(url, options)
    if (body.code !== 0) {
      const error = new Error(`B站接口错误 code=${body.code} ${body.message ?? body.msg ?? ''}`.trim())
      error.code = body.code
      error.status = status
      error.body = body
      throw error
    }
    return body.data
  }

  /** 短号 / 真实房间号都能查。 */
  async resolveRoom(room) {
    let body
    try {
      body = await this.getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(room)}`)
    } catch (first) {
      try {
        body = await this.getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?short_id=${encodeURIComponent(room)}`)
      } catch {
        throw first
      }
    }
    return body
  }

  async nav() {
    // 未登录时 nav 会返回 code=-101，但 data 里仍有 wbi_img / mid=0；这里不抛错。
    const { body } = await this.request('https://api.bilibili.com/x/web-interface/nav')
    const data = body?.data ?? {}
    this.self = { mid: Number(data?.mid ?? 0), uname: String(data?.uname ?? '') }
    this.navRaw = data
    return this.self
  }

  /** 当前账号在这个房间能不能发弹幕 / 可用颜色。 */
  async dmConfig(roomId) {
    return this.getJson(`https://api.live.bilibili.com/xlive/web-room/v1/dM/GetDMConfigByGroup?room_id=${encodeURIComponent(roomId)}`)
  }

  async wbiKeys() {
    if (this.wbiCache && this.wbiCache.expiresAt > Date.now()) return this.wbiCache
    const { body } = await this.request('https://api.bilibili.com/x/web-interface/nav')
    const nav = body?.data ?? {}
    this.self = { mid: Number(nav?.mid ?? 0), uname: String(nav?.uname ?? '') }
    const img = nav?.wbi_img?.img_url ?? ''
    const sub = nav?.wbi_img?.sub_url ?? ''
    if (!img || !sub) throw new Error(`拿不到 WBI 签名材料（nav code=${body?.code ?? '?'}）`)
    const keyOf = (url) => url.slice(url.lastIndexOf('/') + 1, url.lastIndexOf('.'))
    this.wbiCache = { raw: keyOf(img) + keyOf(sub), expiresAt: Date.now() + 6 * 60 * 60_000 }
    return this.wbiCache
  }

  async wbiSign(params) {
    const { raw } = await this.wbiKeys()
    const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
    const query = Object.keys(params).sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]).replace(/[!'()*]/g, ''))}`)
      .join('&')
    const wRid = crypto.createHash('md5').update(query + mixin).digest('hex')
    return `${query}&w_rid=${wRid}`
  }

  async danmuInfo(roomId) {
    const query = await this.wbiSign({ id: roomId, type: 0, wts: Math.round(Date.now() / 1000) })
    return this.getJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`)
  }

  async history(roomId, { limit = 10 } = {}) {
    const data = await this.getJson(`https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${encodeURIComponent(roomId)}&room_type=0`)
    return (data?.room ?? []).slice(-limit)
  }

  /** 发送一条弹幕；--reply-* 可选，把这条变成回复 / @某人。 */
  async sendDanmaku({ roomId, msg, replyMid, replyName, replyDmid }) {
    if (!this.bili_jct) throw new Error('缺少 bili_jct，不能发弹幕')
    if (!msg || !String(msg).trim()) throw new Error('弹幕内容不能为空')
    const form = new URLSearchParams({
      csrf: this.bili_jct,
      csrf_token: this.bili_jct,
      roomid: String(roomId),
      msg: String(msg),
      rnd: String(Math.round(Date.now() / 1000)),
      fontsize: '25',
      color: '16777215',
      mode: '1',
      bubble: '0',
      room_type: '0',
      jumpfrom: '0',
      statistics: JSON.stringify({ appId: 100, platform: 5 }),
    })
    if (replyDmid) form.set('replay_dmid', String(replyDmid))
    if (replyMid) {
      form.set('reply_mid', String(replyMid))
      if (replyName) form.set('reply_uname', String(replyName))
    }
    const { status, body } = await this.request('https://api.live.bilibili.com/msg/send', {
      room: roomId,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    return { status, code: Number(body.code), message: body.message ?? body.msg ?? '', raw: body }
  }

  /** 进房动作：让直播间记录一次“有人进入”（失败不影响收弹幕）。 */
  async entry(roomId) {
    const form = new URLSearchParams({
      room_id: String(roomId),
      platform: 'web',
      ...(this.bili_jct ? { csrf: this.bili_jct } : {}),
    })
    return this.request('https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction', {
      room: roomId,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
  }
}

export const DANMAKU_HINTS = {
  0: '发送成功',
  '-101': '账号未登录（SESSDATA 失效）',
  '-111': 'csrf 校验失败（bili_jct 和 SESSDATA 不是同一个号）',
  '-400': '请求错误 / 缺参数',
  1003212: '超出长度限制',
  10031: '发送频率过快',
  12015: '账号被限制发言',
  12051: '被风控，先去网页端验证',
}
