import zlib from 'node:zlib'

/** 弹幕 WebSocket 协议：16 字节头 + body。 */
export function encodePacket(op, body = '') {
  const payload = new TextEncoder().encode(String(body))
  const buffer = new Uint8Array(16 + payload.length)
  const view = new DataView(buffer.buffer)
  view.setUint32(0, 16 + payload.length)
  view.setUint16(4, 16)
  view.setUint16(6, 1)
  view.setUint32(8, op)
  view.setUint32(12, 1)
  buffer.set(payload, 16)
  return buffer
}

/** 把一帧（可能压缩、可能嵌套）拆成 `{op, ver, body}` 列表。 */
export function parsePackets(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const out = []
  let offset = 0
  while (offset + 16 <= buffer.length) {
    const total = buffer.readUInt32BE(offset)
    if (total < 16 || offset + total > buffer.length) break
    const headerLen = buffer.readUInt16BE(offset + 4)
    const ver = buffer.readUInt16BE(offset + 6)
    const op = buffer.readUInt32BE(offset + 8)
    const body = buffer.subarray(offset + headerLen, offset + total)
    let nested = null
    if (ver === 3) {
      try { nested = zlib.brotliDecompressSync(body) } catch {}
    } else if (ver === 2) {
      try { nested = zlib.inflateSync(body) } catch {}
    }
    if (nested) out.push(...parsePackets(nested))
    else out.push({ op, ver, body })
    offset += total
  }
  return out
}

/**
 * 连上弹幕服务器。Node 22+ 自带全局 WebSocket。
 * @returns {{close: () => void}}
 */
export function connectDanmaku({ url, token, uid, roomId, buvid, onOpen, onFrame, onClose, onError, heartbeatMs = 30_000 }) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('当前 Node 没有全局 WebSocket；请用 Node 22+（或用 22 及以上运行）')
  }
  const ws = new WebSocket(url)
  try { ws.binaryType = 'arraybuffer' } catch {}
  let heartbeat = null

  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null } }

  ws.addEventListener('open', () => {
    const auth = { uid: Number(uid) || 0, roomid: Number(roomId), protover: 3, platform: 'web', type: 2, key: token }
    if (buvid) auth.buvid = buvid
    try { ws.send(encodePacket(7, JSON.stringify(auth))) } catch (e) { onError?.(e) }
    heartbeat = setInterval(() => {
      try { ws.send(encodePacket(2, '[object Object]')) } catch {}
    }, heartbeatMs)
    onOpen?.()
  })

  ws.addEventListener('message', async (event) => {
    try {
      const data = event.data instanceof ArrayBuffer ? event.data : await event.data?.arrayBuffer?.()
      if (data) for (const packet of parsePackets(Buffer.from(data))) onFrame?.(packet)
    } catch (e) { onError?.(e) }
  })

  ws.addEventListener('error', (e) => onError?.(e))
  ws.addEventListener('close', (e) => {
    stopHeartbeat()
    onClose?.(e)
  })

  return {
    close: () => {
      stopHeartbeat()
      try { ws.close() } catch {}
    },
  }
}
