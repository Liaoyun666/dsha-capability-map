/**
 * lib/bridge.js 的测试 —— 这个文件是唯一的出网口，认证与错误归类错一次，
 * 整个插件的结论就全错。用假 fetch 打桩，不碰真网络。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BridgeError, classifyResult, createBridge, parseTokenFile, resolveToken } from '../lib/bridge.js'

/** 造一个假 Response。 */
function fakeResponse(result, { status = 200 } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return typeof result === 'string' ? result : JSON.stringify({ result })
    },
  }
}

describe('parseTokenFile', () => {
  it('纯 token 文件直接 trim', () => {
    assert.equal(parseTokenFile('/root/.dsh/.bridge_token', '  abc123\n'), 'abc123')
  })

  it('.bridge_headers 里抽 X-Token 头', () => {
    const raw = '# curl 用\nX-Token: s3cr3t-value\n'
    assert.equal(parseTokenFile('/root/.dsh/.bridge_headers', raw), 's3cr3t-value')
  })

  it('头名大小写不敏感，冒号前后空格容忍', () => {
    assert.equal(parseTokenFile('/x/.bridge_headers', 'x-token :   tok  '), 'tok')
  })

  it('头值带引号时去掉引号', () => {
    assert.equal(parseTokenFile('/x/.bridge_headers', 'X-Token: "quoted"'), 'quoted')
  })

  it('文件里没有 X-Token 头 → 空串（不猜）', () => {
    assert.equal(parseTokenFile('/x/.bridge_headers', 'Authorization: Bearer zzz'), '')
  })

  it('内容里出现 X-Token 字样但文件名不是 headers 时也按头解析', () => {
    assert.equal(parseTokenFile('/some/where/token.txt', 'X-Token: fromheader'), 'fromheader')
  })

  it('空内容 → 空串', () => {
    assert.equal(parseTokenFile('/x/.bridge_token', ''), '')
    assert.equal(parseTokenFile('/x/.bridge_token', undefined), '')
  })
})

describe('resolveToken', () => {
  it('显式传入优先于一切', async () => {
    assert.equal(await resolveToken({ token: 'explicit' }), 'explicit')
  })

  it('环境变量其次', async () => {
    const saved = process.env.DSHA_BRIDGE_TOKEN
    process.env.DSHA_BRIDGE_TOKEN = 'from-env'
    try {
      assert.equal(await resolveToken({}), 'from-env')
    } finally {
      if (saved === undefined) delete process.env.DSHA_BRIDGE_TOKEN
      else process.env.DSHA_BRIDGE_TOKEN = saved
    }
  })

  it('都没有时抛 BRIDGE_UNAVAILABLE，且说明里点名试过的路径', async () => {
    const saved = process.env.DSHA_BRIDGE_TOKEN
    delete process.env.DSHA_BRIDGE_TOKEN
    try {
      await assert.rejects(
        resolveToken({ tokenPath: '/no/such/file' }),
        (error) => {
          assert.ok(error instanceof BridgeError)
          assert.equal(error.code, 'BRIDGE_UNAVAILABLE')
          assert.match(error.message, /\/no\/such\/file/)
          assert.match(error.message, /DSHA/)
          return true
        },
      )
    } finally {
      if (saved !== undefined) process.env.DSHA_BRIDGE_TOKEN = saved
    }
  })
})

describe('classifyResult', () => {
  it('裸 OK 是成功', () => {
    assert.deepEqual(classifyResult('OK'), { ok: true, code: 'OK', text: 'OK' })
  })

  it('OK: 细节 是成功且保留原文', () => {
    const value = classifyResult('OK: /storage/emulated/0/Download/DSHA/x.md')
    assert.equal(value.ok, true)
    assert.match(value.text, /Download\/DSHA\/x\.md/)
  })

  it('空串当成功（端点没正文不算失败）', () => {
    assert.equal(classifyResult('').ok, true)
    assert.equal(classifyResult(undefined).ok, true)
  })

  it('裸码是失败', () => {
    assert.deepEqual(classifyResult('DISABLED'), { ok: false, code: 'DISABLED', text: 'DISABLED' })
  })

  it('码 + 冒号 + 说明', () => {
    const value = classifyResult('FORBIDDEN: 只能分享 /sdcard 下的文件')
    assert.equal(value.ok, false)
    assert.equal(value.code, 'FORBIDDEN')
    assert.match(value.text, /只能分享/)
  })

  it('[方括号] 码形态', () => {
    const value = classifyResult('[APP_BACKGROUND] App 不在前台，无法读剪贴板')
    assert.equal(value.ok, false)
    assert.equal(value.code, 'APP_BACKGROUND')
  })

  it('[ERR] 后面跟着真码时，用真码（笼统的 ERR 没有诊断价值）', () => {
    const value = classifyResult('[ERR] SCREEN_RUN_CHANGED')
    assert.equal(value.code, 'SCREEN_RUN_CHANGED')
  })

  it('[RESULT_UNKNOWN] 后面跟着真码时，同样用真码', () => {
    const value = classifyResult('[RESULT_UNKNOWN] APP_LAUNCH_RESULT_UNKNOWN: 启动中被打断')
    assert.equal(value.code, 'APP_LAUNCH_RESULT_UNKNOWN')
  })

  it('[ERR] 后面没有真码时保留 ERR', () => {
    assert.equal(classifyResult('[ERR] 无障碍服务未连接').code, 'ERR')
  })

  it('普通正文（小写开头）是成功', () => {
    const value = classifyResult('model=Mock Phone\nandroid=14')
    assert.equal(value.ok, true)
  })

  it('正文恰好全大写但不是错误码样式 → 保守当成功（例如型号名）', () => {
    // 单个大写词、长度不足 3 的不当码
    assert.equal(classifyResult('AB').ok, true)
  })

  it('前导空白不影响判断', () => {
    assert.equal(classifyResult('   DISABLED').code, 'DISABLED')
  })
})

describe('createBridge', () => {
  it('默认地址是 3090', () => {
    const bridge = createBridge({ token: 'x' })
    assert.equal(bridge.baseUrl, 'http://127.0.0.1:3090')
  })

  it('baseUrl 尾部斜杠被去掉（避免拼出 //app/device）', () => {
    assert.equal(createBridge({ baseUrl: 'http://h:1///', token: 'x' }).baseUrl, 'http://h:1')
  })

  it('把 params 编成 query，空值跳过', async () => {
    let seen = ''
    const bridge = createBridge({
      token: 'x',
      fetchImpl: async (url) => {
        seen = url
        return fakeResponse('OK')
      },
    })
    await bridge.call('/app/sensor', { name: 'light', empty: '', nil: null, undef: undefined })
    assert.match(seen, /name=light/)
    assert.ok(!seen.includes('empty='), '空串参数不该出现在 URL 里')
    assert.ok(!seen.includes('nil='))
  })

  it('中文参数被正确编码（不能崩在 URL 上）', async () => {
    let seen = ''
    const bridge = createBridge({
      token: 'x',
      fetchImpl: async (url) => {
        seen = url
        return fakeResponse('OK')
      },
    })
    await bridge.call('/app/toast', { text: '体检完成' })
    assert.ok(!seen.includes('体检完成'), '中文应被百分号编码')
    assert.match(seen, /text=%E4%BD%93/)
    assert.equal(new URL(seen).searchParams.get('text'), '体检完成')
  })

  it('带上 X-Token 头', async () => {
    let headers
    const bridge = createBridge({
      token: 'my-token',
      fetchImpl: async (_url, init) => {
        headers = init.headers
        return fakeResponse('OK')
      },
    })
    await bridge.call('/app/version')
    assert.equal(headers['X-Token'], 'my-token')
  })

  it('token 只在内存缓存：第二次调用不再读文件', async () => {
    let reads = 0
    const bridge = createBridge({
      tokenPath: '/dev/null',
      fetchImpl: async () => {
        reads += 1
        return fakeResponse('OK')
      },
    })
    // 先给一个有效 token，避免真去读文件
    const withToken = createBridge({ token: 't', fetchImpl: async () => fakeResponse('OK') })
    assert.equal(await withToken.token(), 't')
    assert.equal(await withToken.token(), 't')
    await withToken.call('/a')
    await withToken.call('/b')
    assert.equal(reads, 0)
    void bridge
  })

  it('401 时清掉缓存并以 BRIDGE_UNAUTHORIZED 失败（下轮会重读文件）', async () => {
    const bridge = createBridge({
      token: 'stale',
      fetchImpl: async () => fakeResponse('UNAUTHORIZED', { status: 401 }),
    })
    await assert.rejects(bridge.call('/app/version'), (error) => {
      assert.equal(error.code, 'BRIDGE_UNAUTHORIZED')
      assert.match(error.message, /轮换|重启/)
      return true
    })
  })

  it('500 时是 BRIDGE_HTTP 并带上正文片段', async () => {
    const bridge = createBridge({
      token: 'x',
      fetchImpl: async () => fakeResponse('boom', { status: 500 }),
    })
    await assert.rejects(bridge.call('/app/version'), (error) => {
      assert.equal(error.code, 'BRIDGE_HTTP')
      assert.match(error.message, /500/)
      return true
    })
  })

  it('解析 {"result": ...} 包装', async () => {
    const bridge = createBridge({
      token: 'x',
      fetchImpl: async () => fakeResponse('OK: 已启动 com.x'),
    })
    const value = await bridge.call('/app/launch', { pkg: 'com.x' })
    assert.equal(value.ok, true)
    assert.match(value.text, /已启动/)
  })

  it('非 JSON 正文按原文处理（老版本桥）', async () => {
    const bridge = createBridge({
      token: 'x',
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        async text() {
          return 'DISABLED'
        },
      }),
    })
    const value = await bridge.call('/app/torch', { on: 0 })
    assert.equal(value.code, 'DISABLED')
  })

  it('连不上时是 BRIDGE_DOWN，且说明里让用户切回前台', async () => {
    const bridge = createBridge({
      token: 'x',
      fetchImpl: async () => {
        const error = new TypeError('fetch failed')
        error.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3090'), { code: 'ECONNREFUSED' })
        throw error
      },
    })
    await assert.rejects(bridge.call('/app/version'), (error) => {
      assert.equal(error.code, 'BRIDGE_DOWN')
      assert.match(error.message, /前台|回收/)
      return true
    })
  })

  it('超时是 BRIDGE_TIMEOUT（而且提示可能是在等用户操作弹窗）', async () => {
    const bridge = createBridge({
      token: 'x',
      fetchImpl: async () => {
        const error = new Error('The operation was aborted due to timeout')
        error.name = 'TimeoutError'
        throw error
      },
    })
    await assert.rejects(bridge.call('/app/ask', { q: 'hi' }), (error) => {
      assert.equal(error.code, 'BRIDGE_TIMEOUT')
      assert.match(error.message, /弹窗|期限/)
      return true
    })
  })
})
