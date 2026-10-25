/**
 * 探测项定义 —— 每个端点一条，负责「问一次、判一次、给一句人话」。
 *
 * 三条纪律：
 *   1. **有副作用的探测默认不跑**。震动、手电、通知、弹窗、装应用，这些会打扰用户，
 *      必须显式打开 includeSideEffects 才做，且报告里标出来。
 *   2. **失败要区分「不支持」和「没授权」**。DISABLED 是用户没开开关，NO_PERMISSION 是
 *      没给系统权限，FOREGROUND_SKIP 是时机不对 —— 三种修法完全不同，混在一起报就等于没报。
 *   3. **只信端点真的返回了什么**，不根据 App 版本来猜能力。
 */

/** 判定结果的四种状态。 */
export const STATE = {
  OK: 'ok', // 真的可用，且拿到了数据
  DISABLED: 'disabled', // 能力开关没开（用户去设置里勾一下就好）
  NO_PERMISSION: 'no-permission', // 系统权限没给
  TIMING: 'timing', // 时机不对：要 App 在前台 / 要设备解锁
  BROKEN: 'broken', // 端点存在但报错（这才是真 bug）
  UNSUPPORTED: 'unsupported', // 这台设备 / 这版 App 没有这个能力
  UNKNOWN: 'unknown', // 结果不明，不能下结论
  SKIPPED: 'skipped', // 按开关跳过了（比如有副作用）
}

/** 状态 → 给人看的标签。 */
export const STATE_LABEL = {
  [STATE.OK]: '可用',
  [STATE.DISABLED]: '未开启',
  [STATE.NO_PERMISSION]: '未授权',
  [STATE.TIMING]: '时机不对',
  [STATE.BROKEN]: '异常',
  [STATE.UNSUPPORTED]: '不支持',
  [STATE.UNKNOWN]: '不确定',
  [STATE.SKIPPED]: '已跳过',
}

/**
 * 失败码 → 状态。这张表是全插件的判断中枢：DSHA 的失败码是稳定的契约，
 * 靠码分类比靠文案匹配靠谱。
 */
const CODE_STATE = new Map([
  ['DISABLED', STATE.DISABLED],
  ['CAPABILITY_NOT_AUTHORIZED', STATE.DISABLED],
  ['CAPABILITY_TARGET_CHANGED', STATE.DISABLED],
  ['NO_PERMISSION', STATE.NO_PERMISSION],
  ['FORBIDDEN', STATE.NO_PERMISSION],
  ['APP_BACKGROUND', STATE.TIMING],
  ['FOREGROUND_SKIP', STATE.TIMING],
  ['SCREEN_RUN_CHANGED', STATE.TIMING],
  ['TIMEOUT', STATE.TIMING],
  ['DISMISSED', STATE.UNKNOWN],
  ['USER_NO_ANSWER', STATE.UNKNOWN],
  ['USER_REJECTED', STATE.UNKNOWN],
  ['RESULT_UNKNOWN', STATE.UNKNOWN],
  ['INTERRUPTED', STATE.UNKNOWN],
  ['NOT_FOUND', STATE.UNSUPPORTED],
  ['NO_SERVICE', STATE.UNSUPPORTED],
  ['NO_PKG', STATE.BROKEN],
  ['NO_TEXT', STATE.BROKEN],
  ['NO_PATH', STATE.BROKEN],
  ['BAD_NAME', STATE.BROKEN],
  ['TOO_LARGE', STATE.BROKEN],
  ['BUSY', STATE.TIMING],
])

/**
 * 只读一份失败码 → 状态表（测试与外部脚本用）。
 * 给出去的是新的 Map 副本，外部改它不会污染判断中枢。
 */
export const CODE_STATE_EXPORT = new Map(CODE_STATE)

/** 把一次桥响应翻成 { state, detail, fix }。 */
export function evaluate(call) {
  if (call.ok) {
    const detail = (call.text || '').trim()
    return { state: STATE.OK, detail: detail && detail !== 'OK' ? firstLine(detail) : '返回正常' }
  }
  const code = call.code || 'ERROR'
  const state = CODE_STATE.get(code) ?? STATE.BROKEN
  const raw = (call.text || '').trim()
  return { state, code, detail: raw ? firstLine(raw) : code, fix: FIX[code] }
}

/** 每个码该让用户怎么修。写死在文案里，避免模型自由发挥。 */
const FIX = {
  DISABLED: 'DSHA → 设置 → 设备能力，勾选这一项。重试无效，必须先开开关。',
  CAPABILITY_NOT_AUTHORIZED: 'DSHA → 设置 → 设备能力授权，允许这一项。重试无效，授权是用户点的，不是重试出来的。',
  CAPABILITY_TARGET_CHANGED: '授权对象变了（换了设备或通道）：回到设备能力授权页重新授权一次，重试无效。',
  NO_PERMISSION: '去 Android 系统设置里给 DSHA 授这个权限，或者让用户拒绝过就再也别自动试。',
  FORBIDDEN: '目标路径或对象在保护名单里（凭据区、系统目录），换一个范围。',
  APP_BACKGROUND: '把 DSHA 切回前台再试一次；这是 Android 的系统限制，不是 bug。',
  FOREGROUND_SKIP: 'App 正在前台，通知会被跳过（正常行为，说明这条路通了）。',
  SCREEN_RUN_CHANGED: '屏幕状态变了：重新截图拿新的 observationId 再来。',
  TIMEOUT: '超时了：可能是用户没操作弹窗。确认后再试，不要连着重试。',
  NOT_FOUND: '这台设备上没有这个对象（应用没装 / 路径不存在）。',
  NO_SERVICE: '系统服务拿不到，通常是设备侧限制。',
  NO_PKG: '没给包名 —— 调用方的参数写错了。',
  NO_TEXT: '没给正文 —— 调用方的参数写错了。',
  NO_PATH: '没给路径 —— 调用方的参数写错了。',
  BAD_NAME: '文件名不合法（不能带路径分隔符或 ..）。',
  TOO_LARGE: '超过 64MiB 上限，分成几份导出。',
  BUSY: '正忙，等手上的动作结束再来。',
  DISMISSED: '弹窗被关掉了、没选：这是用户的选择，不是故障。想再问就重新问一次，不要自动重弹。',
  USER_NO_ANSWER: '用户没回答（超时或没点）：先别追问，把能做的做完再问一次。',
  USER_REJECTED: '用户明确拒绝了：不要重复请求同一个权限或动作，换个办法或者直接说明做不了。',
  RESULT_UNKNOWN: '结果不明：先核对真实状态，不要自动重放。',
  INTERRUPTED: '被打断了：先核对状态再决定是否重来。',
}

/** 取第一行，太长的截断。 */
function firstLine(text) {
  const line = String(text).split(/\r?\n/).find((item) => item.trim().length > 0) ?? ''
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

/**
 * 全部探测项。
 *
 * sideEffect=true 的默认不跑：它们会点亮手电、震动手机、弹通知、弹窗、启动应用。
 * 一个体检插件绝不该在用户没允许的时候动这些东西。
 */
export const PROBES = [
  {
    id: 'bridge.version',
    label: '桥版本',
    group: 'meta',
    route: '/app/version',
    sideEffect: false,
    note: '桥协议与 App 版本（判断新端点是否存在用）',
  },
  {
    id: 'device.info',
    label: '设备信息',
    group: 'meta',
    route: '/app/device',
    sideEffect: false,
    note: '机型、系统、电量、网络、存储、内存',
  },
  {
    id: 'plugins.status',
    label: '插件加载状态',
    group: 'meta',
    route: '/app/plugins',
    sideEffect: false,
    note: 'App 记录的上次启动加载结果',
  },
  {
    id: 'apps.list',
    label: '应用清单',
    group: 'device',
    route: '/app/apps',
    params: { limit: 3 },
    sideEffect: false,
    note: '已安装应用列表（只取 3 条试通）',
  },
  {
    id: 'storage.read',
    label: '读设备文件',
    group: 'device',
    route: '/app/readfile',
    params: { path: '/sdcard/Download' },
    sideEffect: false,
    note: '列 Download 目录（受 Android 权限限制）',
  },
  {
    id: 'clipboard.read',
    label: '读剪贴板',
    group: 'device',
    route: '/app/clip',
    sideEffect: false,
    tolerate: [STATE.TIMING],
    note: '系统限制：只有 App 在前台时才能读，后台失败属于正常',
  },
  {
    id: 'sensors.list',
    label: '传感器清单',
    group: 'sensor',
    route: '/app/sensors',
    sideEffect: false,
    note: '看一眼设备有哪些传感器（不需要开关）',
  },
  {
    id: 'sensor.light',
    label: '环境光',
    group: 'sensor',
    route: '/app/sensor',
    params: { name: 'light' },
    sideEffect: false,
    note: '读一次 lux',
  },
  {
    id: 'location',
    label: '定位',
    group: 'sensor',
    route: '/app/location',
    params: { fresh: 0 },
    sideEffect: false,
    note: '取最后一次已知位置（fresh=1 要等数秒）',
  },
  {
    id: 'ui.dump',
    label: '读屏',
    group: 'screen',
    route: '/app/ui/dump',
    sideEffect: false,
    note: '无障碍节点树（要开无障碍服务）',
  },
  {
    id: 'torch',
    label: '手电',
    group: 'actuator',
    route: '/app/torch',
    params: { on: 0 },
    sideEffect: true,
    note: '会真的开关手电 —— 所以只关不开',
  },
  {
    id: 'vibrate',
    label: '震动',
    group: 'actuator',
    route: '/app/vibrate',
    params: { ms: 1 },
    sideEffect: true,
    note: '会真的震一下（1 毫秒，尽量轻）',
  },
  {
    id: 'toast',
    label: 'App 内提示',
    group: 'ui',
    route: '/app/toast',
    params: { text: '能力体检：提示通道正常' },
    sideEffect: true,
    note: '会在 App 里弹一条提示',
  },
  {
    id: 'notify',
    label: '通知栏',
    group: 'ui',
    route: '/app/notify',
    params: { title: '能力体检', text: '通知通道正常' },
    sideEffect: true,
    tolerate: [STATE.TIMING],
    note: '发一条通知（App 在前台时会被跳过，属正常）',
  },
]

/** 按 id 查探测项。 */
export function probeById(id) {
  return PROBES.find((item) => item.id === id)
}

/**
 * 跑一条探测。不抛异常 —— 网络层的失败也是结论（桥挂了本身就是最重要的发现）。
 * @param {{ call: Function }} bridge
 * @param {object} probe
 * @param {{ timeoutMs?: number }} [options]
 */
export async function runProbe(bridge, probe, options = {}) {
  const startedAt = Date.now()
  try {
    const call = await bridge.call(probe.route, probe.params ?? {}, { timeoutMs: options.timeoutMs })
    const verdict = evaluate(call)
    // 有些端点「失败」是正常的（前台限制），标成 tolerate 后降级成 ok-but
    const tolerated = Array.isArray(probe.tolerate) && probe.tolerate.includes(verdict.state)
    return {
      id: probe.id,
      label: probe.label,
      group: probe.group,
      route: probe.route,
      sideEffect: Boolean(probe.sideEffect),
      note: probe.note,
      state: tolerated ? STATE.OK : verdict.state,
      tolerated,
      code: verdict.code,
      detail: verdict.detail,
      fix: tolerated ? '这个端点在当前时机下失败是正常的；需要时把 DSHA 切到前台再试。' : verdict.fix,
      ms: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      id: probe.id,
      label: probe.label,
      group: probe.group,
      route: probe.route,
      sideEffect: Boolean(probe.sideEffect),
      note: probe.note,
      state: error?.code === 'BRIDGE_UNAVAILABLE' || error?.code === 'BRIDGE_DOWN' ? STATE.BROKEN : STATE.UNKNOWN,
      code: error?.code || 'ERROR',
      detail: error?.message || String(error),
      fix:
        error?.code === 'BRIDGE_UNAVAILABLE' || error?.code === 'BRIDGE_DOWN'
          ? '连不上 DSHA 设备桥：把 App 切回前台，确认设置里的设备能力是开着的。'
          : undefined,
      ms: Date.now() - startedAt,
    }
  }
}

/**
 * 跑一批探测。串行 —— 桥是单进程的小服务，并发只会互相挤，还会让 App 弹一堆东西。
 * @param {{ call: Function }} bridge
 * @param {{ includeSideEffects?: boolean, only?: string[], timeoutMs?: number }} [options]
 */
export async function runAll(bridge, options = {}) {
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : null
  const targets = PROBES.filter((probe) => (only ? only.has(probe.id) || only.has(probe.group) : true))

  const results = []
  for (const probe of targets) {
    if (probe.sideEffect && !options.includeSideEffects) {
      results.push({
        id: probe.id,
        label: probe.label,
        group: probe.group,
        route: probe.route,
        sideEffect: true,
        note: probe.note,
        state: STATE.SKIPPED,
        detail: '有副作用，默认不跑',
        fix: '确认要做的话加 includeSideEffects=true。',
        ms: 0,
      })
      continue
    }
    results.push(await runProbe(bridge, probe, options))
  }
  return results
}

/** 统计各状态数量。 */
export function summarize(results) {
  const counts = {}
  for (const item of results) counts[item.state] = (counts[item.state] ?? 0) + 1
  return counts
}
