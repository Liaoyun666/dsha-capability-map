/**
 * lib/report.js 的测试 —— 排版看起来是小事，但「表没对齐」「结论和明细矛盾」
 * 会直接让人不信任这份报告，所以也钉住。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { STATE } from '../lib/probes.js'
import { formatCompact, formatHuman, formatJson, nextStep, overall, useColor } from '../lib/report.js'

/** 造一条探测结果。 */
function row(id, state, extra = {}) {
  return {
    id,
    label: extra.label ?? id,
    group: extra.group ?? 'meta',
    route: `/app/${id}`,
    sideEffect: Boolean(extra.sideEffect),
    state,
    code: extra.code,
    detail: extra.detail ?? `${id} 的说明`,
    fix: extra.fix,
    ms: extra.ms ?? 12,
    tolerated: false,
  }
}

describe('overall：整体结论', () => {
  it('全可用 → ok', () => {
    const summary = overall([row('a', STATE.OK), row('b', STATE.OK)])
    assert.equal(summary.verdict, 'ok')
    assert.equal(summary.headline, '全部可用')
  })

  it('只有副作用项被跳过时仍是 ok，并说明跳了几项', () => {
    const summary = overall([row('a', STATE.OK), row('b', STATE.SKIPPED, { sideEffect: true })])
    assert.equal(summary.verdict, 'ok')
    assert.match(summary.headline, /1 项有副作用/)
  })

  it('有未开启 / 未授权 → partial，并让用户去授权页', () => {
    const summary = overall([row('a', STATE.OK), row('b', STATE.DISABLED)])
    assert.equal(summary.verdict, 'partial')
    assert.match(summary.headline, /1 项/)
    assert.match(summary.advice, /设备能力/)
  })

  it('有异常 → broken 优先于 partial（真坏了比没开开关严重）', () => {
    const summary = overall([row('a', STATE.DISABLED), row('b', STATE.BROKEN)])
    assert.equal(summary.verdict, 'broken')
    assert.match(summary.headline, /1 项/)
  })

  it('「时机不对」不影响结论（不是用户要处理的事）', () => {
    const summary = overall([row('a', STATE.OK), row('b', STATE.TIMING)])
    assert.equal(summary.verdict, 'ok')
  })

  it('不确定也不影响结论（诚实地说不知道，而不是报错）', () => {
    assert.equal(overall([row('a', STATE.UNKNOWN)]).verdict, 'ok')
  })

  it('空结果不抛异常', () => {
    assert.equal(overall([]).verdict, 'ok')
  })
})

describe('formatHuman', () => {
  const rows = [
    row('bridge.version', STATE.OK, { group: 'meta', label: '桥版本', detail: 'DSHA 0.2.1-rc.2' }),
    row('device.info', STATE.OK, { group: 'meta', label: '设备信息', detail: 'model=Mock' }),
    row('sensor.light', STATE.DISABLED, { group: 'sensor', label: '环境光', code: 'DISABLED', fix: '去开开关' }),
    row('torch', STATE.SKIPPED, { group: 'actuator', label: '手电', sideEffect: true, detail: '有副作用，默认不跑' }),
  ]

  it('有标题与结论', () => {
    const text = formatHuman(rows)
    assert.match(text, /DSHA 设备能力体检/)
    assert.match(text, /结论/)
  })

  it('只列有内容的分组（空组不留空行）', () => {
    const text = formatHuman(rows)
    assert.match(text, /元信息/)
    assert.match(text, /传感器与位置/)
    assert.ok(!text.includes('读屏（无障碍）'), '没有读屏项时不该出现这个分组标题')
  })

  it('默认只写没通过的项：通过的项不出现明细', () => {
    const text = formatHuman(rows)
    assert.ok(!text.includes('DSHA 0.2.1-rc.2'), '默认不该展开通过项的明细')
  })

  it('verbose 时所有项都带明细与耗时', () => {
    const text = formatHuman(rows, { verbose: true })
    assert.match(text, /DSHA 0\.2\.1-rc\.2/)
    assert.match(text, /12ms/)
  })

  it('末尾列出「要处理的」，带错误码与修法', () => {
    const text = formatHuman(rows)
    assert.match(text, /要处理的/)
    assert.match(text, /错误码 DISABLED/)
    assert.match(text, /去开开关/)
  })

  it('跳过的项不算「要处理的」（用户没让它跑，不是问题）', () => {
    const text = formatHuman(rows)
    const section = text.split('要处理的')[1] ?? ''
    assert.ok(!section.includes('手电'), '手电只是被跳过，不该出现在要处理清单里')
  })

  it('color=false 时绝对不含 ANSI 转义', () => {
    assert.ok(!formatHuman(rows, { color: false }).includes('\u001b['))
  })

  it('color=true 时带转义（终端里才有颜色）', () => {
    assert.ok(formatHuman(rows, { color: true }).includes('\u001b['))
  })

  it('中文标签对齐：状态列之后标签起点在同一列（中文按 2 列宽算）', () => {
    const text = formatHuman(rows, { color: false })
    const body = text
      .split('\n')
      .filter((line) => /^    /.test(line) && /可用|未开启|已跳过/.test(line))
    assert.ok(body.length >= 3, `应至少 3 行，实际 ${body.length}`)
    // 按显示宽度算（CJK 占 2 列），否则「可用」和「已跳过」会被误判成不对齐
    const width = (value) => {
      let total = 0
      for (const char of value) total += /[\u4e00-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1
      return total
    }
    const starts = body.map((line) => {
      const match = /^    (?:可用|未开启|已跳过)\s+/.exec(line)
      return match ? width(match[0]) : -1
    })
    assert.ok(starts.every((value) => value > 0), `有行没匹配上：${JSON.stringify(starts)}`)
    assert.equal(new Set(starts).size, 1, `标签起点不一致：${JSON.stringify(starts)}`)
  })

  it('device 选项会出现在标题行', () => {
    assert.match(formatHuman(rows, { device: 'Pixel 8' }), /Pixel 8/)
  })
})

describe('formatCompact', () => {
  const rows = [
    row('a', STATE.OK, { group: 'meta', label: '桥版本' }),
    row('b', STATE.DISABLED, { group: 'sensor', label: '环境光', code: 'DISABLED', fix: '去开开关' }),
    row('c', STATE.SKIPPED, { group: 'actuator', label: '手电', sideEffect: true }),
  ]

  it('第一行就是结论与计数', () => {
    const text = formatCompact(rows)
    assert.match(text.split('\n')[0], /DSHA 能力体检/)
    assert.match(text.split('\n')[0], /可用 1/)
  })

  it('每个分组一行，用「标签=状态」的形式', () => {
    const text = formatCompact(rows)
    assert.match(text, /元信息：桥版本=可用/)
    assert.match(text, /传感器与位置：环境光=未开启/)
  })

  it('列出需要用户处理的事项，带 fix 而不是 detail', () => {
    const text = formatCompact(rows)
    assert.match(text, /需要用户处理/)
    assert.match(text, /去开开关/)
  })

  it('超过 8 项时截断并提示用 verbose 看全部', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      row(`x${index}`, STATE.DISABLED, { code: 'DISABLED', fix: '去开' }),
    )
    const text = formatCompact(many)
    assert.match(text, /还有 4 项/)
  })

  it('全好时不说「需要用户处理」', () => {
    const text = formatCompact([row('a', STATE.OK)])
    assert.ok(!text.includes('需要用户处理'))
  })
})

describe('formatJson', () => {
  const rows = [
    row('a', STATE.OK, { label: '桥版本', detail: 'v1' }),
    row('b', STATE.DISABLED, { label: '环境光', code: 'DISABLED', fix: '去开' }),
  ]

  it('是合法 JSON 且带 schemaVersion 1', () => {
    const parsed = JSON.parse(formatJson(rows))
    assert.equal(parsed.schemaVersion, 1)
  })

  it('结构稳定：字段一个不少', () => {
    const parsed = JSON.parse(formatJson(rows))
    for (const field of ['checkedAt', 'device', 'bridge', 'verdict', 'headline', 'counts', 'probes']) {
      assert.ok(field in parsed, `缺字段 ${field}`)
    }
    assert.equal(parsed.probes.length, 2)
    for (const probe of parsed.probes) {
      for (const field of ['id', 'label', 'group', 'route', 'state', 'code', 'detail', 'fix', 'sideEffect', 'ms']) {
        assert.ok(field in probe, `probe 缺字段 ${field}`)
      }
    }
  })

  it('可选字段缺省时是 null 而不是 undefined（JSON 里不能消失）', () => {
    const parsed = JSON.parse(formatJson([row('a', STATE.OK)]))
    assert.equal(parsed.probes[0].code, null)
    assert.equal(parsed.probes[0].fix, null)
  })

  it('checkedAt 是 ISO 时间，可被 Date 解析', () => {
    const parsed = JSON.parse(formatJson(rows))
    assert.ok(!Number.isNaN(Date.parse(parsed.checkedAt)))
  })

  it('options 能带进设备与桥信息', () => {
    const parsed = JSON.parse(formatJson(rows, { device: 'Pixel 8', bridge: { baseUrl: 'http://x' } }))
    assert.equal(parsed.device, 'Pixel 8')
    assert.equal(parsed.bridge.baseUrl, 'http://x')
  })

  it('没有中文以外的乱码：能 JSON.parse 且文案完整', () => {
    const parsed = JSON.parse(formatJson(rows))
    assert.equal(parsed.probes[1].fix, '去开')
  })
})

describe('nextStep：给模型的一句话', () => {
  it('有未开启的项时点名让它去开，并写死「重试无效」', () => {
    const text = nextStep([row('a', STATE.DISABLED, { label: '手电' })])
    assert.match(text, /手电/)
    assert.match(text, /重试无效/)
  })

  it('未授权时指向系统设置', () => {
    const text = nextStep([row('a', STATE.NO_PERMISSION, { label: '定位' })])
    assert.match(text, /定位/)
    assert.match(text, /系统设置/)
  })

  it('异常时建议切前台，并说明可能是 App 侧问题', () => {
    const text = nextStep([row('a', STATE.BROKEN, { label: '读屏' })])
    assert.match(text, /读屏/)
    assert.match(text, /前台/)
  })

  it('全好时说明可以直接干活', () => {
    assert.match(nextStep([row('a', STATE.OK)]), /都能用/)
  })

  it('未开启优先于异常（先让用户去开开关，别去排查 bug）', () => {
    const text = nextStep([row('a', STATE.BROKEN, { label: 'x' }), row('b', STATE.DISABLED, { label: '手电' })])
    assert.match(text, /手电/)
  })

  it('空结果也有一句话，不会返回空串', () => {
    assert.ok(nextStep([]).length > 0)
  })
})

describe('useColor', () => {
  it('NO_COLOR 优先，哪怕在 TTY 里也关', () => {
    assert.equal(useColor({ NO_COLOR: '1' }, true), false)
  })

  it('FORCE_COLOR=1 在没有 TTY 时也开', () => {
    assert.equal(useColor({ FORCE_COLOR: '1' }, false), true)
  })

  it('FORCE_COLOR=0 关', () => {
    assert.equal(useColor({ FORCE_COLOR: '0' }, true), false)
  })

  it('什么都没有时看 isTTY', () => {
    assert.equal(useColor({}, true), true)
    assert.equal(useColor({}, false), false)
  })
})
