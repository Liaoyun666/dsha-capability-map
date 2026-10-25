/**
 * 假桥：按 DSHA 真实响应格式（`{"result":"..."}`）回话的最小 HTTP 服务。
 *
 * 两件事必须能演示，否则测试就是摆设：
 *   1. 每个状态都真出现过一次 —— DISABLED / NO_PERMISSION / FOREGROUND_SKIP / BROKEN；
 *   2. 成功响应两种形态都覆盖 —— 裸 `OK` 与 `OK: 细节`。
 *
 * 用法：node tools/mock-bridge.js [port] [profile]
 *   profile = healthy（默认，全部可用）
 *           = mixed（手电 DISABLED、定位 NO_PERMISSION、通知 FOREGROUND_SKIP、读屏异常）
 *           = offline（所有端点 503，模拟桥半死）
 */

import { createServer } from 'node:http'

/** 健康档：全部可用。 */
const HEALTHY = {
  '/app/version': 'DSHA 0.2.1-rc.2 (build 190) / mock',
  '/app/device':
    'model=Mock Phone\nandroid=14\nbattery=76%\nnetwork=wifi\nscreen=1080x2400\nstorage=64G (31G free)\nmemory=8G (3.2G free)',
  '/app/plugins': 'loaded=dsha-native-tools,dsha-capability-map\nfailed=\npending=',
  '/app/apps': 'com.tencent.mm\t微信 uid=10123\ncom.example.demo\t演示 uid=10124',
  '/app/readfile': 'Download/\nDCIM/\nDocuments/',
  '/app/clip': 'OK: 剪贴板里有 12 个字',
  '/app/sensors': 'light\naccel\ngyro\npressure',
  '/app/sensor': 'light=123.4 lux',
  '/app/location': 'lat=31.2304 lon=121.4737 acc=12m',
  '/app/ui/dump': '<hierarchy><node text="设置" bounds="[0,0][1080,200]"/></hierarchy>',
  '/app/torch': 'OK',
  '/app/vibrate': 'OK',
  '/app/toast': 'OK',
  '/app/notify': 'OK',
}

/** 混合档：每种失败形态各来一条。 */
const MIXED = {
  ...HEALTHY,
  '/app/torch': 'DISABLED',
  '/app/location': 'NO_PERMISSION',
  '/app/notify': 'FOREGROUND_SKIP',
  // 时机不对，且这一项没有 tolerate —— 必须真的报成「时机不对」，不能被降级
  '/app/ui/dump': '[ERR] SCREEN_RUN_CHANGED',
  // 真异常：码是笼统的 ERR（真桥在无障碍服务没连上时就这样）
  '/app/sensors': '[ERR] 无障碍服务未连接',
  '/app/sensor': 'DISABLED',
}

/** 每种「失败码」在真桥里都是 200 + result 文本（不是 HTTP 错误）。 */
const PROFILES = { healthy: HEALTHY, mixed: MIXED }

export function startMockBridge(port = 0, profile = 'healthy') {
  if (profile !== 'offline' && !PROFILES[profile]) {
    throw new Error(`未知 profile：${profile}（可选 healthy / mixed / offline）`)
  }
  const table = PROFILES[profile] ?? {}

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const send = (result, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
      response.end(JSON.stringify({ result }))
    }
    if (request.headers['x-token'] !== 'dev') return send('UNAUTHORIZED', 401)
    if (url.pathname === '/health') return send(profile === 'offline' ? 'DOWN' : 'OK')
    if (profile === 'offline') return send('BRIDGE_ERROR', 503)
    const canned = table[url.pathname]
    if (canned !== undefined) return send(canned)
    return send('NOT_FOUND', 404)
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

// 直接运行就把桥挂起来，方便手工 curl 试探
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const wanted = Number(process.argv[2] || 3091)
  const profile = process.argv[3] || 'healthy'
  const { port } = await startMockBridge(wanted, profile)
  console.log(`mock bridge on http://127.0.0.1:${port} (token: dev, profile: ${profile})`)
}
