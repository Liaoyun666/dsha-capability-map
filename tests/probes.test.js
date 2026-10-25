/**
 * lib/probes.js 的单元测试 —— 这是全插件的判断中枢，必须每一项都钉住。
 *
 * 测试全部用假桥（不碰网络），所以能在任何机器上跑，不需要真的手机。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CODE_STATE_EXPORT,
  PROBES,
  STATE,
  STATE_LABEL,
  evaluate,
  probeById,
  runAll,
  runProbe,
  summarize,
} from '../lib/probes.js'

/**
 * 造一个假桥：`table` 是 端点 → 响应文本 的映射，键里可以带 `?` 断言参数。
 * 值可以是字符串（直接当 result 文本），也可以是函数。
 */
function fakeBridge(table) {
  const calls = []
  return {
    baseUrl: 'http://127.0.0.1:0',
    calls,
    async call(route, params = {}) {
      const key = `${route}${params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : ''}`
      calls.push({ route, params, key })
      const hit = table[route]
      if (hit === undefined) return { ok: false, code: 'NOT_FOUND', text: 'NOT_FOUND' }
      if (typeof hit === 'function') return hit(params)
      if (hit instanceof Error) throw hit
      return { ok: !/^[[A-Z]/.test(hit) || /^OK\b/.test(hit), code: /^OK\b/.test(hit) ? 'OK' : 'X', text: hit }
    },
  }
}

describe('STATE 与标签', () => {
  it('八种状态都有中文标签，一个不漏', () => {
    const states = Object.values(STATE)
    assert.equal(states.length, 8)
    for (const state of states) {
      assert.equal(typeof STATE_LABEL[state], 'string', `${state} 没有标签`)
      assert.ok(STATE_LABEL[state].length > 0)
    }
  })

  it('状态值本身是稳定的小写短语（写进 JSON 后会进存档，不能随便改）', () => {
    assert.deepEqual(Object.values(STATE).sort(), [
      'broken',
      'disabled',
      'no-permission',
      'ok',
      'skipped',
      'timing',
      'unknown',
      'unsupported',
    ])
  })
})

describe('evaluate：把一次桥响应翻成状态', () => {
  it('裸 OK 是可用，且 detail 不显示一个干巴巴的 OK', () => {
    const verdict = evaluate({ ok: true, code: 'OK', text: 'OK' })
    assert.equal(verdict.state, STATE.OK)
    assert.equal(verdict.detail, '返回正常')
  })

  it('OK: 细节 是可用，detail 保留细节（去掉 OK: 前缀由渲染层做）', () => {
    const verdict = evaluate({ ok: true, code: 'OK', text: 'OK: /storage/emulated/0/Download/DSHA/report.md' })
    assert.equal(verdict.state, STATE.OK)
    assert.match(verdict.detail, /Download\/DSHA/)
  })

  it('成功但有正文时取第一行（多行正文不能把表格撑歪）', () => {
    const verdict = evaluate({ ok: true, code: 'OK', text: 'model=Mock\nandroid=14\nbattery=76' })
    assert.equal(verdict.state, STATE.OK)
    assert.equal(verdict.detail, 'model=Mock')
  })

  it('超长正文截断到 160 字以内', () => {
    const verdict = evaluate({ ok: true, code: 'OK', text: 'x'.repeat(500) })
    assert.ok(verdict.detail.length <= 160, `实际 ${verdict.detail.length}`)
    assert.ok(verdict.detail.endsWith('…'))
  })

  for (const [code, expected] of [
    ['DISABLED', STATE.DISABLED],
    ['CAPABILITY_NOT_AUTHORIZED', STATE.DISABLED],
    ['CAPABILITY_TARGET_CHANGED', STATE.DISABLED],
    ['NO_PERMISSION', STATE.NO_PERMISSION],
    ['FORBIDDEN', STATE.NO_PERMISSION],
    ['APP_BACKGROUND', STATE.TIMING],
    ['FOREGROUND_SKIP', STATE.TIMING],
    ['SCREEN_RUN_CHANGED', STATE.TIMING],
    ['TIMEOUT', STATE.TIMING],
    ['BUSY', STATE.TIMING],
    ['NOT_FOUND', STATE.UNSUPPORTED],
    ['NO_SERVICE', STATE.UNSUPPORTED],
    ['NO_PKG', STATE.BROKEN],
    ['NO_TEXT', STATE.BROKEN],
    ['NO_PATH', STATE.BROKEN],
    ['BAD_NAME', STATE.BROKEN],
    ['TOO_LARGE', STATE.BROKEN],
    ['DISMISSED', STATE.UNKNOWN],
    ['USER_NO_ANSWER', STATE.UNKNOWN],
    ['USER_REJECTED', STATE.UNKNOWN],
    ['RESULT_UNKNOWN', STATE.UNKNOWN],
    ['INTERRUPTED', STATE.UNKNOWN],
  ]) {
    it(`${code} → ${expected}`, () => {
      const verdict = evaluate({ ok: false, code, text: `${code}: 说明` })
      assert.equal(verdict.state, expected)
      assert.equal(verdict.code, code)
      assert.ok(verdict.fix, `${code} 应该带一条「怎么修」`)
    })
  }

  it('没见过的码按「异常」处理（保守：宁可报坏也别瞒着）', () => {
    const verdict = evaluate({ ok: false, code: 'SOMETHING_NEW', text: 'SOMETHING_NEW: 未知' })
    assert.equal(verdict.state, STATE.BROKEN)
    assert.equal(verdict.fix, undefined)
  })

  it('每种能力开关类失败都提示「重试无效」，避免模型死循环', () => {
    for (const code of ['DISABLED', 'CAPABILITY_NOT_AUTHORIZED', 'CAPABILITY_TARGET_CHANGED']) {
      assert.match(evaluate({ ok: false, code }).fix, /重试无效|必须先开开关|重新授权/)
    }
  })

  it('失败但没正文时 detail 退化成错误码，不会是空白', () => {
    const verdict = evaluate({ ok: false, code: 'DISABLED', text: '' })
    assert.equal(verdict.detail, 'DISABLED')
  })
})

describe('PROBES 表', () => {
  it('14 项，id 唯一', () => {
    assert.equal(PROBES.length, 14)
    const ids = PROBES.map((probe) => probe.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  it('每项都齐备字段：id/label/group/route/sideEffect/note', () => {
    for (const probe of PROBES) {
      for (const field of ['id', 'label', 'group', 'route', 'note']) {
        assert.equal(typeof probe[field], 'string', `${probe.id}.${field}`)
        assert.ok(probe[field].length > 0)
      }
      assert.equal(typeof probe.sideEffect, 'boolean')
      assert.match(probe.route, /^\/app\//)
    }
  })

  it('分组只出现在已知的六组里', () => {
    const groups = new Set(PROBES.map((probe) => probe.group))
    assert.deepEqual([...groups].sort(), ['actuator', 'device', 'meta', 'screen', 'sensor', 'ui'])
  })

  it('会打扰用户的四项都标了 sideEffect（否则默认就会动手机）', () => {
    const sideEffects = PROBES.filter((probe) => probe.sideEffect).map((probe) => probe.id)
    assert.deepEqual(sideEffects.sort(), ['notify', 'toast', 'torch', 'vibrate'])
  })

  it('手电只关不开（spark 一个体检不该点亮用户的手电）', () => {
    const torch = probeById('torch')
    assert.equal(String(torch.params.on), '0')
  })

  it('震动尽量轻：1 毫秒', () => {
    assert.equal(probeById('vibrate').params.ms, 1)
  })

  it('定位用 fresh=0（要立刻返回，不能等卫星）', () => {
    assert.equal(String(probeById('location').params.fresh), '0')
  })

  it('tolerate 只标在「失败属正常」的端点上', () => {
    const tolerated = PROBES.filter((probe) => Array.isArray(probe.tolerate)).map((probe) => probe.id)
    assert.deepEqual(tolerated.sort(), ['clipboard.read', 'notify'])
    for (const id of tolerated) {
      const probe = probeById(id)
      for (const state of probe.tolerate) assert.ok(Object.values(STATE).includes(state))
    }
  })

  it('probeById 找得到，找不到返回 undefined 而不是抛', () => {
    assert.equal(probeById('device.info').label, '设备信息')
    assert.equal(probeById('nope'), undefined)
  })

  it('CODE_STATE_EXPORT 与表一致（给测试与外部脚本查码用）', () => {
    assert.equal(CODE_STATE_EXPORT.get('DISABLED'), STATE.DISABLED)
    assert.equal(CODE_STATE_EXPORT.get('NOT_FOUND'), STATE.UNSUPPORTED)
  })
})

describe('runProbe', () => {
  it('可用时返回 ok 与耗时', async () => {
    const bridge = fakeBridge({ '/app/device': () => ({ ok: true, code: 'OK', text: 'model=Mock' }) })
    const result = await runProbe(bridge, probeById('device.info'))
    assert.equal(result.state, STATE.OK)
    assert.equal(result.detail, 'model=Mock')
    assert.equal(typeof result.ms, 'number')
    assert.equal(result.sideEffect, false)
  })

  it('失败时带上 code 与 fix', async () => {
    const bridge = fakeBridge({ '/app/device': () => ({ ok: false, code: 'DISABLED', text: 'DISABLED' }) })
    const result = await runProbe(bridge, probeById('device.info'))
    assert.equal(result.state, STATE.DISABLED)
    assert.equal(result.code, 'DISABLED')
    assert.match(result.fix, /设备能力/)
  })

  it('桥抛异常也变成结论，不往外抛（体检脚本不能因为一项就崩）', async () => {
    const bridge = {
      baseUrl: 'http://127.0.0.1:0',
      async call() {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'BRIDGE_DOWN' })
      },
    }
    const result = await runProbe(bridge, probeById('device.info'))
    assert.equal(result.state, STATE.BROKEN)
    assert.equal(result.code, 'BRIDGE_DOWN')
    assert.match(result.fix, /切回前台|前台/)
  })

  it('不认识的异常归为「不确定」而不是「异常」（分不清就别乱下结论）', async () => {
    const bridge = {
      baseUrl: 'http://127.0.0.1:0',
      async call() {
        throw new Error('boom')
      },
    }
    const result = await runProbe(bridge, probeById('device.info'))
    assert.equal(result.state, STATE.UNKNOWN)
    assert.equal(result.code, 'ERROR')
  })

  it('tolerate 命中时降级成「可用」并标注 tolerated', async () => {
    const bridge = fakeBridge({
      '/app/clip': () => ({ ok: false, code: 'APP_BACKGROUND', text: '[APP_BACKGROUND] 只有前台能读' }),
    })
    const result = await runProbe(bridge, probeById('clipboard.read'))
    assert.equal(result.state, STATE.OK)
    assert.equal(result.tolerated, true)
    assert.equal(result.code, 'APP_BACKGROUND')
    assert.match(result.fix, /前台/)
  })

  it('tolerate 不包含的状态仍然照实报（不能顺手把真错误也吞掉）', async () => {
    const bridge = fakeBridge({
      '/app/clip': () => ({ ok: false, code: 'BRIDGE_HTTP', text: '设备桥返回 HTTP 500' }),
    })
    const result = await runProbe(bridge, probeById('clipboard.read'))
    assert.equal(result.state, STATE.BROKEN)
    assert.equal(result.tolerated, false)
  })

  it('把探测项的 params 原样传给桥', async () => {
    const bridge = fakeBridge({ '/app/sensor': () => ({ ok: true, code: 'OK', text: 'light=1 lux' }) })
    await runProbe(bridge, probeById('sensor.light'))
    assert.deepEqual(bridge.calls[0].params, { name: 'light' })
  })
})

describe('runAll', () => {
  const healthy = Object.fromEntries(
    PROBES.map((probe) => [probe.route, () => ({ ok: true, code: 'OK', text: `${probe.label}正常` })]),
  )

  it('默认跳过有副作用的项，且把它们标成 skipped', async () => {
    const bridge = fakeBridge(healthy)
    const results = await runAll(bridge)
    assert.equal(results.length, 14)
    const skipped = results.filter((item) => item.state === STATE.SKIPPED)
    assert.deepEqual(skipped.map((item) => item.id).sort(), ['notify', 'toast', 'torch', 'vibrate'])
    // 跳过的不该真的去调桥
    assert.equal(bridge.calls.length, 10)
  })

  it('打开 includeSideEffects 后 14 项全跑', async () => {
    const bridge = fakeBridge(healthy)
    const results = await runAll(bridge, { includeSideEffects: true })
    assert.equal(results.length, 14)
    assert.equal(bridge.calls.length, 14)
    assert.equal(results.filter((item) => item.state === STATE.SKIPPED).length, 0)
  })

  it('only 可以按 id 选', async () => {
    const bridge = fakeBridge(healthy)
    const results = await runAll(bridge, { only: ['device.info', 'location'] })
    assert.deepEqual(results.map((item) => item.id).sort(), ['device.info', 'location'])
  })

  it('only 可以按分组选', async () => {
    const bridge = fakeBridge(healthy)
    const results = await runAll(bridge, { only: ['sensor'] })
    assert.deepEqual(results.map((item) => item.id).sort(), ['location', 'sensor.light', 'sensors.list'])
  })

  it('only 里有不认识的项时不报错，只是选不到', async () => {
    const bridge = fakeBridge(healthy)
    const results = await runAll(bridge, { only: ['nope'] })
    assert.deepEqual(results, [])
  })

  it('串行执行（桥是单进程小服务，并发会互相挤）', async () => {
    // 用一个「同时最多 1 个在跑」的计数器证明没有并发
    let live = 0
    let peak = 0
    const bridge = {
      baseUrl: 'http://127.0.0.1:0',
      async call(route) {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((done) => setTimeout(done, 1))
        live -= 1
        return { ok: true, code: 'OK', text: route }
      },
    }
    await runAll(bridge, { only: ['meta'] })
    assert.equal(peak, 1)
  })

  it('按表里的顺序返回（报告分组依赖这个顺序）', async () => {
    const bridge = fakeBridge(healthy)
    const results = await runAll(bridge, { only: ['meta'] })
    assert.deepEqual(results.map((item) => item.id), ['bridge.version', 'device.info', 'plugins.status'])
  })
})

describe('summarize', () => {
  it('统计各状态数量，没有的状态不出现', () => {
    const counts = summarize([
      { state: STATE.OK },
      { state: STATE.OK },
      { state: STATE.SKIPPED },
      { state: STATE.DISABLED },
    ])
    assert.deepEqual(counts, { ok: 2, skipped: 1, disabled: 1 })
  })

  it('空数组给空对象', () => {
    assert.deepEqual(summarize([]), {})
  })
})
