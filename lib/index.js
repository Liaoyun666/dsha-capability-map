/**
 * 插件入口：把「这台手机到底能干什么」变成一个工具。
 *
 * 为什么不复用 dsha-native-tools 的那些工具去挨个试？
 * 因为那些工具是为了「干活」设计的 —— 它们会在失败时返回一句错误就结束，
 * 而体检需要的是**横向可比的一张表**：哪些能用、哪些是开关没开、哪些是真坏了。
 * 用干活工具拼体检，模型得自己从 12 条互不相干的错误里归纳，很容易漏。
 */

import { createBridge } from './bridge.js'
import { PROBES, STATE, runAll, summarize } from './probes.js'
import { formatCompact, formatHuman, formatJson, nextStep, overall } from './report.js'

/** 插件名（与 package.json 一致）。 */
export const name = 'dsha-capability-map'

/** 依赖的服务。只要 tools。 */
export const inject = ['tools']

/** 配置。 */
export const Config = {
  baseUrl: { type: 'string', default: 'http://127.0.0.1:3090' },
  timeoutMs: { type: 'number', default: 15_000 },
}

/** 单次探测超时下限：桥本身在手机上，20 秒已经很宽松。 */
const PROBE_TIMEOUT_MS = 20_000

/** 把配置解析成桥的构造参数。 */
export function resolveConfig(rawConfig = {}) {
  return {
    baseUrl: typeof rawConfig.baseUrl === 'string' && rawConfig.baseUrl ? rawConfig.baseUrl : 'http://127.0.0.1:3090',
    timeoutMs: Number(rawConfig.timeoutMs) > 0 ? Number(rawConfig.timeoutMs) : 15_000,
  }
}

/** 包住一次执行 —— 任何异常都变成结构化结果，绝不把 stack 甩给模型。 */
function guard(executor) {
  return async (...args) => {
    try {
      return await executor(...args)
    } catch (error) {
      return {
        ok: false,
        code: error?.code || 'ERROR',
        text: [
          `能力体检本身失败了：${error?.message || String(error)}`,
          error?.code === 'BRIDGE_UNAVAILABLE' || error?.code === 'BRIDGE_DOWN'
            ? '这说明当前不在 DSHA 安卓端里跑，或者 App 已经在后台被系统回收了。'
            : '这不是某台设备的结论，而是体检没跑起来。',
        ].join('\n'),
      }
    }
  }
}

/**
 * 造工具定义。导出出来是为了测试能直接注入假桥。
 * @param {{ call: Function, baseUrl?: string }} bridge
 */
export function buildTools(bridge) {
  return [
    {
      name: 'dsha_capability_map',
      description:
        '体检这台安卓手机上 agent 到底能用哪些设备能力（通知、震动、剪贴板、读屏、传感器、定位、手电…），' +
        '每一项给出「可用 / 未开启 / 未授权 / 时机不对 / 异常」，并说明下一步该让用户做什么。' +
        '**先跑这个再决定用哪个设备工具**——不然你会在没开的开关上反复试。' +
        '有副作用的项（手电、震动、通知）默认跳过，需要显式打开。',
      parameters: {
        type: 'object',
        properties: {
          includeSideEffects: {
            type: 'boolean',
            description: '把会打扰用户的探测也跑一遍（真的会震一下、弹提示、发通知）。默认 false。',
          },
          only: {
            type: 'array',
            items: { type: 'string' },
            description: '只查这些探测项或分组（meta/device/sensor/screen/actuator/ui）。不填=全部。',
          },
          verbose: { type: 'boolean', description: '把每一行都写出来（默认只写没通过的）。' },
        },
        additionalProperties: false,
      },
      execute: guard(async (args = {}) => {
        const results = await runAll(bridge, {
          includeSideEffects: Boolean(args.includeSideEffects),
          only: Array.isArray(args.only) ? args.only : undefined,
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        const device = results.find((item) => item.id === 'device.info')
        return {
          ok: true,
          text: [
            formatCompact(results),
            '',
            `下一步：${nextStep(results)}`,
            '',
            args.verbose ? formatHuman(results, { verbose: true, color: false }) : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }),
    },
    {
      name: 'dsha_capability_json',
      description:
        '同 dsha_capability_map，但返回稳定结构的 JSON（schemaVersion 1），适合把体检结果存档、写进报告、' +
        '或交给脚本判断。字段：verdict / headline / counts / probes[]。',
      parameters: {
        type: 'object',
        properties: {
          includeSideEffects: { type: 'boolean', description: '是否连有副作用的项一起查。默认 false。' },
        },
        additionalProperties: false,
      },
      execute: guard(async (args = {}) => {
        const results = await runAll(bridge, {
          includeSideEffects: Boolean(args.includeSideEffects),
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        const device = results.find((item) => item.id === 'device.info')
        return {
          ok: true,
          text: formatJson(results, {
            bridge: { baseUrl: bridge.baseUrl, protocol: results.find((item) => item.id === 'bridge.version')?.detail },
            device: device?.state === STATE.OK ? device.detail : null,
          }),
        }
      }),
    },
    {
      name: 'dsha_capability_diff',
      description:
        '对比两次体检结果，只报「变了什么」。换手机、升级 DSHA、改完授权设置后想知道哪里不一样时用。' +
        '输入是两次 dsha_capability_json 的输出（JSON 字符串）。',
      parameters: {
        type: 'object',
        properties: {
          before: { type: 'string', description: '上一次的 JSON 输出' },
          after: { type: 'string', description: '这一次的 JSON 输出' },
        },
        required: ['before', 'after'],
        additionalProperties: false,
      },
      execute: guard(async (args = {}) => {
        const before = parseSnapshot(args.before)
        const after = parseSnapshot(args.after)
        const changes = diffSnapshots(before, after)
        if (changes.length === 0) return { ok: true, text: '两次体检结果完全一样，没有变化。' }
        return {
          ok: true,
          text: ['两次体检的差异：', ...changes.map((line) => `- ${line}`)].join('\n'),
        }
      }),
    },
  ]
}

/** 解析一次体检的 JSON 快照；坏输入给出明确错误。 */
export function parseSnapshot(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw Object.assign(new Error('快照是空的'), { code: 'BAD_SNAPSHOT' })
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('快照不是合法 JSON'), { code: 'BAD_SNAPSHOT' })
  }
  if (!parsed || !Array.isArray(parsed.probes)) {
    throw Object.assign(new Error('快照里没有 probes 数组 —— 这不是 dsha_capability_json 的输出'), {
      code: 'BAD_SNAPSHOT',
    })
  }
  return parsed
}

/** 对比两份快照，返回人话的差异列表。 */
export function diffSnapshots(before, after) {
  const left = new Map(before.probes.map((item) => [item.id, item]))
  const right = new Map(after.probes.map((item) => [item.id, item]))
  const lines = []

  for (const [id, item] of right) {
    const old = left.get(id)
    if (!old) {
      lines.push(`新增探测项「${item.label}」：${item.state}`)
      continue
    }
    if (old.state !== item.state) {
      lines.push(`「${item.label}」${old.state} → ${item.state}${item.code ? `（${item.code}）` : ''}`)
    }
  }
  for (const [id, item] of left) {
    if (!right.has(id)) lines.push(`消失了「${item.label}」（旧状态 ${item.state}）`)
  }
  if (before.device !== after.device && (before.device || after.device)) {
    lines.push(`设备：${before.device ?? '未知'} → ${after.device ?? '未知'}`)
  }
  if (before.bridge?.protocol !== after.bridge?.protocol && (before.bridge || after.bridge)) {
    lines.push(`桥协议：${before.bridge?.protocol ?? '未知'} → ${after.bridge?.protocol ?? '未知'}`)
  }
  return lines
}

/**
 * 挂载。
 * @param {{ tools?: { register: Function }, logger?: any, effect?: Function }} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const bridge = createBridge(config)

  // 不在 DSHA 里跑时不该炸：插件能被装到任何 DSH 上，只是工具会返回「连不上桥」。
  bridge.token().catch((error) => {
    ctx.logger?.warn?.(`[${name}] 暂时连不上 DSHA 设备桥（${error?.code || 'BRIDGE_UNAVAILABLE'}）：工具会如实报告，不影响加载。`)
  })

  for (const tool of buildTools(bridge)) {
    ctx.effect?.(() => ctx.tools.register(tool), `${name}: ${tool.name}`)
  }
}

export { PROBES, STATE, summarize, overall }
