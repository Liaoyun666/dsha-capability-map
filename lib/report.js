/**
 * 报告排版。三种消费者，三种格式：
 *   - 人（终端 / 手机屏幕上读）   → formatHuman
 *   - 模型（塞进上下文）          → formatCompact
 *   - 机器（CI、脚本）            → formatJson
 */

import { STATE, STATE_LABEL, summarize } from './probes.js'

/** 分组顺序与标题 —— 固定顺序比「按字母排」好读得多。 */
const GROUPS = [
  ['meta', '元信息'],
  ['device', '设备与应用'],
  ['sensor', '传感器与位置'],
  ['screen', '读屏（无障碍）'],
  ['actuator', '硬件动作'],
  ['ui', '提示通道'],
]

/** 每种状态在终端里的颜色。 */
const STATE_COLOR = {
  [STATE.OK]: '\u001b[32m',
  [STATE.DISABLED]: '\u001b[33m',
  [STATE.NO_PERMISSION]: '\u001b[33m',
  [STATE.TIMING]: '\u001b[36m',
  [STATE.BROKEN]: '\u001b[31m',
  [STATE.UNSUPPORTED]: '\u001b[90m',
  [STATE.UNKNOWN]: '\u001b[35m',
  [STATE.SKIPPED]: '\u001b[90m',
}
const RESET = '\u001b[0m'

/** 要不要上色：NO_COLOR 优先，其次 FORCE_COLOR，最后看是不是 TTY。 */
export function useColor(env = process.env, isTTY = process.stdout?.isTTY) {
  if (env.NO_COLOR) return false
  // FORCE_COLOR=0 是「明确要求关掉」，不能当成没设过而退回 isTTY
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0'
  return Boolean(isTTY)
}

/** 整体结论：只要有一项 BROKEN 就是「有问题」，否则看有没有被关掉的能力。 */
export function overall(results) {
  const counts = summarize(results)
  if ((counts[STATE.BROKEN] ?? 0) > 0) {
    return {
      verdict: 'broken',
      headline: `有 ${counts[STATE.BROKEN]} 项真的调不动`,
      advice: '这些不是开关问题，是桥或 App 侧出了问题：先看下面的「异常」那几行。',
    }
  }
  const blocked = (counts[STATE.DISABLED] ?? 0) + (counts[STATE.NO_PERMISSION] ?? 0)
  if (blocked > 0) {
    return {
      verdict: 'partial',
      headline: `${counts[STATE.OK] ?? 0} 项可用，${blocked} 项等你授权或开开关`,
      advice: '去 DSHA → 设置 → 设备能力 里勾上想要的那几项，然后重跑一次体检。',
    }
  }
  const skipped = counts[STATE.SKIPPED] ?? 0
  return {
    verdict: 'ok',
    headline: skipped > 0 ? `全部可用（${skipped} 项有副作用，已跳过）` : '全部可用',
    advice: skipped > 0 ? '想把有副作用的那几项也验一遍，加 includeSideEffects=true。' : '这台手机上 agent 能碰的东西都在。',
  }
}

/** 人读的长报告。 */
export function formatHuman(results, options = {}) {
  const color = options.color ?? false
  const paint = (state, text) => (color ? `${STATE_COLOR[state] ?? ''}${text}${RESET}` : text)
  const summary = overall(results)
  const lines = []

  lines.push('')
  lines.push(`  DSHA 设备能力体检${options.device ? ` · ${options.device}` : ''}`)
  lines.push('')
  lines.push(`  结论  ${summary.headline}`)
  lines.push(`        ${summary.advice}`)
  lines.push('')

  // 状态列全局统一宽度：分组之间也要对齐，不然从上往下扫会错位
  const stateWidth = Math.max(
    1,
    ...results.map((item) => displayWidth(STATE_LABEL[item.state] ?? item.state)),
  )

  for (const [group, title] of GROUPS) {
    const items = results.filter((item) => item.group === group)
    if (items.length === 0) continue
    // 标签列按本组最长的标签对齐（跨组不必对齐，组之间本来就有标题隔开）
    const labelWidth = Math.max(...items.map((item) => displayWidth(item.label)))
    lines.push(`  ${title}`)
    for (const item of items) {
      const label = STATE_LABEL[item.state] ?? item.state
      const padded = padDisplay(label, stateWidth)
      const name = options.verbose ? padDisplay(item.label, labelWidth) : item.label
      const timing = options.verbose ? ` ${String(item.ms).padStart(4)}ms` : ''
      lines.push(`    ${paint(item.state, padded)}  ${name}${timing}`)
      if (item.state !== STATE.OK || options.verbose) {
        lines.push(`           ${dim(item.detail, color)}`)
        if (item.fix && item.state !== STATE.OK) lines.push(`           ${dim(`→ ${item.fix}`, color)}`)
      }
    }
    lines.push('')
  }

  const problems = results.filter((item) => item.state !== STATE.OK && item.state !== STATE.SKIPPED)
  if (problems.length > 0) {
    lines.push('  要处理的')
    for (const item of problems) {
      lines.push(`    · ${item.label}（${item.route}）：${item.detail}`)
      if (item.code) lines.push(`      错误码 ${item.code}`)
      if (item.fix) lines.push(`      ${item.fix}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** 模型读的短报告：一行结论 + 每组一行。 */
export function formatCompact(results, options = {}) {
  const summary = overall(results)
  const counts = summarize(results)
  const parts = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([state, value]) => `${STATE_LABEL[state] ?? state} ${value}`)
    .join(' · ')

  const lines = [`DSHA 能力体检：${summary.headline}（${parts}）`]
  for (const [group, title] of GROUPS) {
    const items = results.filter((item) => item.group === group)
    if (items.length === 0) continue
    const cells = items.map((item) => `${item.label}=${STATE_LABEL[item.state] ?? item.state}`)
    lines.push(`${title}：${cells.join('，')}`)
  }
  const problems = results.filter((item) => item.state !== STATE.OK && item.state !== STATE.SKIPPED)
  if (problems.length > 0) {
    lines.push('')
    lines.push('需要用户处理：')
    for (const item of problems.slice(0, 8)) {
      lines.push(`- ${item.label}（${item.code ?? item.state}）：${item.fix ?? item.detail}`)
    }
    if (problems.length > 8) lines.push(`- …还有 ${problems.length - 8} 项，用 verbose 看全部`)
  }
  if (summary.verdict !== 'ok') lines.push(summary.advice)
  return lines.join('\n')
}

/** 稳定结构的 JSON：给脚本与 CI 用。 */
export function formatJson(results, options = {}) {
  const summary = overall(results)
  return JSON.stringify(
    {
      schemaVersion: 1,
      checkedAt: options.checkedAt ?? new Date().toISOString(),
      device: options.device ?? null,
      bridge: options.bridge ?? null,
      verdict: summary.verdict,
      headline: summary.headline,
      counts: summarize(results),
      probes: results.map((item) => ({
        id: item.id,
        label: item.label,
        group: item.group,
        route: item.route,
        state: item.state,
        code: item.code ?? null,
        detail: item.detail,
        fix: item.fix ?? null,
        sideEffect: item.sideEffect,
        tolerated: item.tolerated ?? false,
        ms: item.ms,
      })),
    },
    null,
    2,
  )
}

/** 这个字符串在等宽终端里占几列：CJK 与全角符号按 2 列算。 */
export function displayWidth(text) {
  let total = 0
  for (const char of String(text ?? '')) total += /[\u4e00-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1
  return total
}

/** 按显示宽度补空格到 targetWidth 列（不是按字符数 —— 中文是双宽）。 */
export function padDisplay(text, targetWidth) {
  return String(text ?? '') + ' '.repeat(Math.max(0, targetWidth - displayWidth(text)))
}

function dim(text, color) {
  return color ? `\u001b[90m${text}${RESET}` : text
}
/**
 * 按状态给出「下一步该干什么」的一句话 —— 工具返回给模型时用，
 * 模型不用自己从状态码猜。「重试无效」这种话必须写死，否则模型会一直重试。
 */
export function nextStep(results) {
  const summary = overall(results)
  const disabled = results.filter((item) => item.state === STATE.DISABLED)
  if (disabled.length > 0) {
    const names = disabled.map((item) => item.label).slice(0, 4).join('、')
    return `让用户去 DSHA → 设置 → 设备能力 里勾上：${names}。**重试无效**，开关不会自己打开。`
  }
  const noPermission = results.filter((item) => item.state === STATE.NO_PERMISSION)
  if (noPermission.length > 0) {
    const names = noPermission.map((item) => item.label).slice(0, 4).join('、')
    return `让用户去 Android 系统设置给 DSHA 授权：${names}。没授权之前换别的办法，别反复试。`
  }
  const broken = results.filter((item) => item.state === STATE.BROKEN)
  if (broken.length > 0) {
    return `有 ${broken.length} 项异常（${broken.map((item) => item.label).join('、')}）：把 DSHA 切回前台后重跑一次；还不行就是 App 侧问题，如实告诉用户。`
  }
  if (summary.verdict === 'ok') return '这台手机上这些能力都能用，可以直接用对应的工具干活。'
  return '按上面每项的说明处理。'
}
