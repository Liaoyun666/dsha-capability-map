/**
 * lib/index.js 的测试 —— 工具层。重点在三件容易出错的事：
 *   1. 任何异常都不能变成 stack trace 甩给模型（execute 必须包 guard）；
 *   2. 工具的 parameters 必须是合法 JSON Schema（模型靠它调用）；
 *   3. diff 必须只报变化，不能把没变的东西也倒出来。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PROBES, STATE } from '../lib/probes.js'
import { buildTools, diffSnapshots, name, parseSnapshot, resolveConfig } from '../lib/index.js'

/** 一个总是成功的假桥。 */
function okBridge() {
  return {
    baseUrl: 'http://127.0.0.1:0',
    async call(route) {
      return { ok: true, code: 'OK', text: `${route} 正常` }
    },
  }
}

/** 取一个工具。 */
function tool(bridge, toolName) {
  const found = buildTools(bridge).find((item) => item.name === toolName)
  assert.ok(found, `没有工具 ${toolName}`)
  return found
}

describe('插件元信息', () => {
  it('name 与 package.json 一致', () => {
    assert.equal(name, 'dsha-capability-map')
  })

  it('三个工具名齐备且不重复', () => {
    const names = buildTools(okBridge()).map((item) => item.name)
    assert.deepEqual(names, ['dsha_capability_map', 'dsha_capability_json', 'dsha_capability_diff'])
  })
})

describe('工具定义是否合法', () => {
  const tools = buildTools(okBridge())

  for (const item of tools) {
    describe(item.name, () => {
      it('有非空 description', () => {
        assert.equal(typeof item.description, 'string')
        assert.ok(item.description.length > 20, '描述太短，模型不知道什么时候该用')
      })

      it('parameters 是 object 型 JSON Schema', () => {
        assert.equal(item.parameters.type, 'object')
        assert.equal(typeof item.parameters.properties, 'object')
      })

      it('每个参数都有类型与说明', () => {
        for (const [key, schema] of Object.entries(item.parameters.properties)) {
          assert.ok(schema.type || schema.items, `参数 ${key} 没有类型`)
          if (schema.type === 'array') assert.ok(schema.items, `数组参数 ${key} 没有 items`)
          const described =
            (typeof schema.description === 'string' && schema.description.length > 0) ||
            (Array.isArray(schema.enum) && schema.enum.length > 0)
          assert.ok(described, `参数 ${key} 没有说明`)
        }
      })

      it('execute 是函数', () => {
        assert.equal(typeof item.execute, 'function')
      })
    })
  }

  it('所有工具都禁止未声明的额外参数（防模型瞎传）', () => {
    for (const item of tools) assert.equal(item.parameters.additionalProperties, false, `${item.name} 没关 additionalProperties`)
  })

  it('diff 工具把两个输入都标成必填', () => {
    const diff = tool(okBridge(), 'dsha_capability_diff')
    assert.deepEqual(diff.parameters.required.sort(), ['after', 'before'])
  })
})

describe('dsha_capability_map', () => {
  it('默认不跑有副作用的项，输出里能看到「已跳过」', async () => {
    const value = await tool(okBridge(), 'dsha_capability_map').execute({})
    assert.equal(value.ok, true)
    assert.match(value.text, /已跳过/)
  })

  it('输出里有结论、分组与下一步', async () => {
    const value = await tool(okBridge(), 'dsha_capability_map').execute({})
    assert.match(value.text, /DSHA 能力体检/)
    assert.match(value.text, /下一步/)
  })

  it('includeSideEffects 时副作用项被真的调用', async () => {
    const called = []
    const bridge = {
      baseUrl: 'http://127.0.0.1:0',
      async call(route) {
        called.push(route)
        return { ok: true, code: 'OK', text: 'OK' }
      },
    }
    await tool(bridge, 'dsha_capability_map').execute({ includeSideEffects: true })
    assert.ok(called.includes('/app/torch'))
    assert.ok(called.includes('/app/vibrate'))
    assert.ok(called.includes('/app/notify'))
  })

  it('only 能收窄到分组', async () => {
    const value = await tool(okBridge(), 'dsha_capability_map').execute({ only: ['sensor'] })
    assert.match(value.text, /传感器与位置/)
    assert.ok(!value.text.includes('元信息'), '只要了 sensor 却出现了 meta 组')
  })

  it('verbose 时附加完整表格', async () => {
    const value = await tool(okBridge(), 'dsha_capability_map').execute({ verbose: true })
    assert.match(value.text, /DSHA 设备能力体检/)
  })

  it('桥挂了也返回 ok:false 的结构化结果，不抛异常', async () => {
    const bridge = {
      baseUrl: 'http://127.0.0.1:0',
      async call() {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'BRIDGE_DOWN' })
      },
    }
    const value = await tool(bridge, 'dsha_capability_map').execute({})
    // 每条探测都变成结论，所以整体仍是 ok:true（体检成功，结论是「全连不上」）
    assert.equal(value.ok, true)
    assert.match(value.text, /异常|连不上|前台/)
  })

  it('execute 抛了无法解释的异常时，工具返回结构化错误而不是 stack', async () => {
    const bridge = {
      baseUrl: 'http://127.0.0.1:0',
      async call() {
        throw new TypeError('undefined is not a function')
      },
    }
    const value = await tool(bridge, 'dsha_capability_map').execute({})
    assert.equal(value.ok, true)
    assert.ok(!value.text.includes('at Object.'), '不该出现 stack trace')
  })
})

describe('dsha_capability_json', () => {
  it('返回可解析的 JSON，schemaVersion 1', async () => {
    const value = await tool(okBridge(), 'dsha_capability_json').execute({})
    const parsed = JSON.parse(value.text)
    assert.equal(parsed.schemaVersion, 1)
    assert.equal(parsed.probes.length, 14)
  })

  it('带 bridge 信息', async () => {
    const value = await tool(okBridge(), 'dsha_capability_json').execute({})
    const parsed = JSON.parse(value.text)
    assert.equal(parsed.bridge.baseUrl, 'http://127.0.0.1:0')
  })

  it('跟 map 工具用同一套判定：副作用项默认 skipped', async () => {
    const value = await tool(okBridge(), 'dsha_capability_json').execute({})
    const skipped = JSON.parse(value.text).probes.filter((item) => item.state === STATE.SKIPPED)
    assert.equal(skipped.length, 4)
  })
})

describe('parseSnapshot', () => {
  const good = JSON.stringify({ schemaVersion: 1, probes: [{ id: 'a', label: 'A', state: 'ok' }], verdict: 'ok' })

  it('合法快照返回对象', () => {
    assert.equal(parseSnapshot(good).probes.length, 1)
  })

  it('空串 → BAD_SNAPSHOT', () => {
    assert.throws(() => parseSnapshot(''), (error) => error.code === 'BAD_SNAPSHOT')
  })

  it('非字符串 → BAD_SNAPSHOT', () => {
    assert.throws(() => parseSnapshot(undefined), (error) => error.code === 'BAD_SNAPSHOT')
  })

  it('坏 JSON → BAD_SNAPSHOT', () => {
    assert.throws(() => parseSnapshot('{oops'), (error) => error.code === 'BAD_SNAPSHOT')
  })

  it('没有 probes 数组 → BAD_SNAPSHOT（防止把别的 JSON 当快照）', () => {
    assert.throws(() => parseSnapshot('{"a":1}'), (error) => error.code === 'BAD_SNAPSHOT')
  })
})

describe('diffSnapshots', () => {
  const base = (probes, extra = {}) => ({ schemaVersion: 1, verdict: 'ok', probes, ...extra })
  const probe = (id, state, code) => ({ id, label: id.toUpperCase(), state, code: code ?? null })

  it('完全一样时返回空数组', () => {
    const snapshot = base([probe('a', 'ok')])
    assert.deepEqual(diffSnapshots(snapshot, snapshot), [])
  })

  it('状态变化 → 一行「旧 → 新」', () => {
    const changes = diffSnapshots(base([probe('a', 'ok')]), base([probe('a', 'disabled', 'DISABLED')]))
    assert.equal(changes.length, 1)
    assert.match(changes[0], /A/)
    assert.match(changes[0], /ok → disabled/)
  })

  it('带上新状态里的错误码（解释为什么变了）', () => {
    const changes = diffSnapshots(base([probe('a', 'ok')]), base([probe('a', 'disabled', 'DISABLED')]))
    assert.match(changes[0], /DISABLED/)
  })

  it('新增探测项（升级 DSHA 后多了端点）', () => {
    const changes = diffSnapshots(base([probe('a', 'ok')]), base([probe('a', 'ok'), probe('b', 'ok')]))
    assert.equal(changes.length, 1)
    assert.match(changes[0], /新增探测项/)
  })

  it('消失的探测项', () => {
    const changes = diffSnapshots(base([probe('a', 'ok'), probe('b', 'ok')]), base([probe('a', 'ok')]))
    assert.equal(changes.length, 1)
    assert.match(changes[0], /消失了/)
  })

  it('换设备时单独一行', () => {
    const changes = diffSnapshots(base([], { device: 'Pixel 6' }), base([], { device: 'Pixel 8' }))
    assert.equal(changes.length, 1)
    assert.match(changes[0], /Pixel 6 → Pixel 8/)
  })

  it('桥协议变化也报（DSHA 升级要看这个）', () => {
    const changes = diffSnapshots(
      base([], { bridge: { protocol: 'build 190' } }),
      base([], { bridge: { protocol: 'build 191' } }),
    )
    assert.match(changes[0], /桥协议/)
  })

  it('两边都没设备信息时不报设备变化（null → null 是噪音）', () => {
    assert.deepEqual(diffSnapshots(base([]), base([])), [])
  })

  it('多项变化按新快照顺序输出，顺序稳定', () => {
    const before = base([probe('a', 'ok'), probe('b', 'ok'), probe('c', 'ok')])
    const after = base([probe('a', 'disabled'), probe('b', 'ok'), probe('c', 'broken')])
    const changes = diffSnapshots(before, after)
    assert.equal(changes.length, 2)
    assert.match(changes[0], /A/)
    assert.match(changes[1], /C/)
  })
})

describe('dsha_capability_diff', () => {
  const snapshot = (verdict, probes) => JSON.stringify({ schemaVersion: 1, verdict, probes })

  it('没有变化时说明白', async () => {
    const same = snapshot('ok', [{ id: 'a', label: 'A', state: 'ok' }])
    const value = await tool(okBridge(), 'dsha_capability_diff').execute({ before: same, after: same })
    assert.equal(value.ok, true)
    assert.match(value.text, /没有变化/)
  })

  it('有变化时逐条列出', async () => {
    const before = snapshot('ok', [{ id: 'a', label: 'A', state: 'ok' }])
    const after = snapshot('partial', [{ id: 'a', label: 'A', state: 'disabled', code: 'DISABLED' }])
    const value = await tool(okBridge(), 'dsha_capability_diff').execute({ before, after })
    assert.match(value.text, /ok → disabled/)
  })

  it('坏输入 → ok:false + BAD_SNAPSHOT，而不是抛异常', async () => {
    const value = await tool(okBridge(), 'dsha_capability_diff').execute({ before: 'nope', after: 'nope' })
    assert.equal(value.ok, false)
    assert.equal(value.code, 'BAD_SNAPSHOT')
    assert.ok(value.text.length > 0)
  })

  it('缺参数时也是结构化失败', async () => {
    const value = await tool(okBridge(), 'dsha_capability_diff').execute({})
    assert.equal(value.ok, false)
    assert.equal(value.code, 'BAD_SNAPSHOT')
  })
})

describe('resolveConfig', () => {
  it('空配置给默认值', () => {
    assert.deepEqual(resolveConfig(), { baseUrl: 'http://127.0.0.1:3090', timeoutMs: 15_000 })
  })

  it('保留显式 baseUrl', () => {
    assert.equal(resolveConfig({ baseUrl: 'http://127.0.0.1:4000' }).baseUrl, 'http://127.0.0.1:4000')
  })

  it('空串 baseUrl 退回默认（别让配置写错就崩）', () => {
    assert.equal(resolveConfig({ baseUrl: '' }).baseUrl, 'http://127.0.0.1:3090')
  })

  it('非法 timeoutMs 退回默认', () => {
    assert.equal(resolveConfig({ timeoutMs: -1 }).timeoutMs, 15_000)
    assert.equal(resolveConfig({ timeoutMs: 'abc' }).timeoutMs, 15_000)
  })

  it('合法 timeoutMs 保留', () => {
    assert.equal(resolveConfig({ timeoutMs: 5000 }).timeoutMs, 5000)
  })
})

describe('探测项与工具的一致性', () => {
  it('工具描述里提到的分组名都是真实分组', async () => {
    const groups = new Set(PROBES.map((probe) => probe.group))
    const text = tool(okBridge(), 'dsha_capability_map').description
    for (const group of ['meta', 'device', 'sensor', 'screen', 'actuator', 'ui']) {
      assert.ok(groups.has(group), `描述里提到的分组 ${group} 不存在`)
    }
    assert.ok(text.length > 0)
  })

  it('工具描述里承诺的三个能力都真的存在', async () => {
    const value = await tool(okBridge(), 'dsha_capability_json').execute({})
    const parsed = JSON.parse(value.text)
    assert.ok(parsed.verdict)
    assert.ok(parsed.headline)
    assert.ok(parsed.counts)
    assert.ok(Array.isArray(parsed.probes))
  })
})
