#!/usr/bin/env node
/**
 * 终端侧体检入口 —— 不经过 agent，直接在 DSHA 终端里按一下。
 *
 * 为什么还要 CLI：插件只在会话里可用，但「这台手机现在到底能干什么」是排查问题时
 * 最先要问的一句话，在终端里一条命令看到表，比开个会话让模型去挨个试快得多。
 * 两者共用 lib/probes.js，所以判定逻辑与状态码不会漂移。
 *
 * 用法：
 *   node tools/cli.js                    人读表格（跳过有副作用的项）
 *   node tools/cli.js --all              连有副作用的项一起验
 *   node tools/cli.js --json             机器可读
 *   node tools/cli.js --only sensor,screen
 *   node tools/cli.js --verbose          每项都写（含毫秒）
 *   node tools/cli.js --diff 旧.json 新.json
 *   node tools/cli.js --list             列出所有探测项
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createBridge } from '../lib/bridge.js'
import { PROBES, runAll } from '../lib/probes.js'
import { formatCompact, formatHuman, formatJson, nextStep, overall } from '../lib/report.js'
import { diffSnapshots, parseSnapshot } from '../lib/index.js'

const USAGE = `dsha-capability-map — 体检这台安卓手机上 agent 能用哪些设备能力

  （无参数）              人读表格；有副作用的项默认跳过
  --all                   连手电 / 震动 / 通知一起验（真的会动手机）
  --json                  输出稳定 JSON（schemaVersion 1）
  --out <文件>            把 JSON 写到文件（隐含 --json）
  --compact               一行结论式的短报告
  --only <项,...>         只查这些探测项或分组：meta device sensor screen actuator ui
  --verbose               通过的项也写出来，并带每项耗时
  --no-color              关掉颜色（默认不是终端时自动关）
  --diff <旧.json> <新.json>
                          对比两次 --json 的输出，只报变化
  --list                  列出全部探测项与所属分组
  --help                  这段说明

环境变量：DSHA_BRIDGE_URL（默认 http://127.0.0.1:3090）、DSHA_BRIDGE_TOKEN

退出码：0 全部可用（或有副作用项被跳过）/ 1 有项不可用或异常 / 2 参数或桥的问题
`

/** 极简参数解析：`--key value` 与裸 `--flag`，其余按位置参数。 */
export function parseArgs(argv) {
  const positional = []
  const flags = {}
  // 这几个一定带值，即使值以 -- 开头也要吃进来（文件路径罕见但可能）
  const VALUED = new Set(['out', 'only', 'diff', 'url'])
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      positional.push(item)
      continue
    }
    const key = item.slice(2)
    const next = argv[index + 1]
    if (VALUED.has(key) && next !== undefined) {
      flags[key] = next
      index += 1
    } else if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return { positional, flags }
}

/** 读一个 JSON 快照文件；读不到就给明确错误，不甩 ENOENT 堆栈。 */
function readSnapshotFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw Object.assign(new Error(`读不到文件：${path}`), { code: 'BAD_SNAPSHOT' })
  }
  return parseSnapshot(text)
}

/** 把探测结果集合压缩成 CLI 退出码。 */
function exitCodeOf(results) {
  return overall(results).verdict === 'ok' ? 0 : 1
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv)

  if (flags.help) {
    console.log(USAGE)
    return 0
  }

  if (flags.list) {
    console.log('探测项：')
    let group = null
    for (const probe of PROBES) {
      if (probe.group !== group) {
        group = probe.group
        console.log(`\n  [${group}]`)
      }
      const mark = probe.sideEffect ? '（有副作用，需 --all）' : ''
      console.log(`    ${probe.id.padEnd(16)} ${probe.label}${mark}`)
      console.log(`      ${probe.route}  — ${probe.note}`)
    }
    console.log('')
    return 0
  }

  if (flags.diff !== undefined) {
    const before = readSnapshotFile(String(flags.diff))
    const afterArg = positional[0]
    if (!afterArg) {
      console.error('✗ 用法：--diff 旧.json 新.json')
      return 2
    }
    const after = readSnapshotFile(afterArg)
    const changes = diffSnapshots(before, after)
    if (changes.length === 0) {
      console.log('两次体检结果完全一样，没有变化。')
      return after.verdict === 'ok' ? 0 : 1
    }
    console.log('两次体检的差异：')
    for (const line of changes) console.log(`  - ${line}`)
    return after.verdict === 'ok' ? 0 : 1
  }

  const bridge = createBridge({ baseUrl: flags.url ? String(flags.url) : undefined })
  const only =
    typeof flags.only === 'string' ? flags.only.split(',').map((item) => item.trim()).filter(Boolean) : undefined

  const results = await runAll(bridge, {
    includeSideEffects: Boolean(flags.all),
    only,
    timeoutMs: 20_000,
  })

  // 桥整个连不上时，14 行一模一样的错误对用户没有信息量 —— 说一次就够。
  // 只看真的跑过的项：被跳过的副作用项没有 code，不能拿它们的 undefined 来否定这个判断。
  const attempted = results.filter((item) => item.state !== 'skipped')
  const bridgeDown =
    attempted.length > 0 &&
    attempted.every((item) => item.code === 'BRIDGE_UNAVAILABLE' || item.code === 'BRIDGE_DOWN')
  if (bridgeDown) {
    console.error(
      [
        `✗ 连不上 DSHA 设备桥（${bridge.baseUrl}）。`,
        '  这说明当前不在 DSHA 安卓端里跑，或者 App 已经被系统回收。',
        '  把 DSHA 切回前台，确认 设置 → 设备能力 是开着的，再来一次。',
        '  这两种情况下重试都无效：不在 App 里、App 后台被冻结。',
      ].join('\n'),
    )
    return 2
  }

  const device = results.find((item) => item.id === 'device.info')

  if (flags.json || flags.out) {
    const text = formatJson(results, {
      bridge: {
        baseUrl: bridge.baseUrl,
        protocol: results.find((item) => item.id === 'bridge.version')?.detail ?? null,
      },
      device: device?.state === 'ok' ? device.detail : null,
    })
    if (flags.out) {
      writeFileSync(String(flags.out), `${text}\n`, 'utf8')
      console.log(`已写入 ${flags.out}`)
    } else {
      console.log(text)
    }
    return exitCodeOf(results)
  }

  if (flags.compact) {
    console.log(formatCompact(results))
    console.log('')
    console.log(`下一步：${nextStep(results)}`)
    return exitCodeOf(results)
  }

  console.log(
    formatHuman(results, {
      color: !flags['no-color'] && Boolean(process.stdout.isTTY),
      verbose: Boolean(flags.verbose),
      device: device?.state === 'ok' ? device.detail.split('\n')[0] : undefined,
    }),
  )
  console.log(`  下一步：${nextStep(results)}`)
  console.log('')
  return exitCodeOf(results)
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    if (error?.code === 'BAD_SNAPSHOT') {
      console.error(`✗ ${error.message}`)
      process.exitCode = 2
      return
    }
    console.error(`✗ ${error?.code || 'ERROR'}：${error?.message || String(error)}`)
    process.exitCode = 2
  },
)
