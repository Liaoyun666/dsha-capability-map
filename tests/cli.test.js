/**
 * tools/cli.js 的端到端测试：起真的 mock 桥、真的子进程，验证退出码与输出形态。
 *
 * 为什么不用 mock 函数打桩：CLI 的价值全在「退出码对不对、JSON 干不干净」上，
 * 这些只有真跑一遍才看得见（尤其 process.exitCode 与管道里的颜色）。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startMockBridge } from '../tools/mock-bridge.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'tools', 'cli.js')

/** 跑一次 CLI，返回 { code, stdout, stderr }。非 0 退出码不当异常。 */
function run(args, env = {}) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, NO_COLOR: '1', ...env }, timeout: 30_000 },
      (error, stdout, stderr) => {
        done({ code: error?.code ?? 0, stdout, stderr })
      },
    )
  })
}

describe('cli --help / --list', () => {
  it('--help 打用法并以 0 退出', async () => {
    const { code, stdout } = await run(['--help'])
    assert.equal(code, 0)
    assert.match(stdout, /dsha-capability-map/)
    assert.match(stdout, /--json/)
  })

  it('--list 列出 14 项，标出哪几项有副作用', async () => {
    const { code, stdout } = await run(['--list'])
    assert.equal(code, 0)
    const lines = stdout.split('\n').filter((line) => /^\s{4}\w/.test(line))
    assert.equal(lines.length, 14, `应列出 14 项，实际 ${lines.length}`)
    assert.equal((stdout.match(/有副作用，需 --all/g) ?? []).length, 4)
  })

  it('--list 不碰网络（没桥也能跑）', async () => {
    const { code } = await run(['--list'], { DSHA_BRIDGE_URL: 'http://127.0.0.1:1' })
    assert.equal(code, 0)
  })
})

describe('CLI 打真桥', () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> }} */
  let bridge
  let env

  before(async () => {
    bridge = await startMockBridge(0, 'healthy')
    env = { DSHA_BRIDGE_URL: bridge.baseUrl, DSHA_BRIDGE_TOKEN: 'dev' }
  })
  after(async () => {
    await bridge.close()
  })

  it('healthy 档：表格有结论，退出码 0', async () => {
    const { code, stdout } = await run([], env)
    assert.equal(code, 0, stdout)
    assert.match(stdout, /DSHA 设备能力体检/)
    assert.match(stdout, /全部可用/)
  })

  it('表格不含 ANSI 转义（管道里不该有颜色）', async () => {
    const { stdout } = await run([], env)
    assert.ok(!stdout.includes('\u001b['), '输出里出现了颜色转义')
  })

  it('JSON 输出可解析、结构稳定', async () => {
    const { code, stdout } = await run(['--json'], env)
    assert.equal(code, 0)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.schemaVersion, 1)
    assert.equal(parsed.probes.length, 14)
    assert.equal(parsed.verdict, 'ok')
  })

  it('--compact 给一行结论', async () => {
    const { code, stdout } = await run(['--compact'], env)
    assert.equal(code, 0)
    assert.match(stdout.split('\n')[0], /DSHA 能力体检/)
  })

  it('--only sensor 只查传感器组', async () => {
    const { stdout } = await run(['--json', '--only', 'sensor'], env)
    const parsed = JSON.parse(stdout)
    assert.deepEqual(parsed.probes.map((item) => item.group), ['sensor', 'sensor', 'sensor'])
  })

  it('--all 会真的跑副作用项', async () => {
    const { stdout } = await run(['--json', '--all'], env)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.probes.filter((item) => item.state === 'skipped').length, 0)
  })

  it('--out 写文件并打一行提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'capmap-'))
    const target = join(dir, 'snap.json')
    try {
      const { code, stdout } = await run(['--json', '--out', target], env)
      assert.equal(code, 0)
      assert.match(stdout, /已写入/)
      const parsed = JSON.parse(await readFile(target, 'utf8'))
      assert.equal(parsed.schemaVersion, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('CLI 打混合故障档', () => {
  let bridge
  let env

  before(async () => {
    bridge = await startMockBridge(0, 'mixed')
    env = { DSHA_BRIDGE_URL: bridge.baseUrl, DSHA_BRIDGE_TOKEN: 'dev' }
  })
  after(async () => {
    await bridge.close()
  })

  it('有项不可用时退出码 1（CI 靠这个判断）', async () => {
    const { code } = await run([], env)
    assert.equal(code, 1)
  })

  it('把四种不同的失败说成四种不同的话', async () => {
    const { stdout } = await run(['--verbose'], env)
    assert.match(stdout, /未开启/) // 手电 DISABLED
    assert.match(stdout, /未授权/) // 定位 NO_PERMISSION
    assert.match(stdout, /时机不对/) // 通知 FOREGROUND_SKIP
    assert.match(stdout, /异常/) // 读屏 [ERR]
  })

  it('「要处理的」里点名具体项', async () => {
    const { stdout } = await run([], env)
    assert.match(stdout, /要处理的/)
    assert.match(stdout, /手电|定位|读屏/)
  })

  it('下一步指向设备能力页（不是让模型重试）', async () => {
    const { stdout } = await run(['--compact'], env)
    assert.match(stdout, /设备能力|系统设置/)
  })
})

describe('CLI 打不通的桥', () => {
  it('连不上时给一句人话并以 2 退出，不打 14 行重复错误', async () => {
    const { code, stdout, stderr } = await run([], { DSHA_BRIDGE_URL: 'http://127.0.0.1:1', DSHA_BRIDGE_TOKEN: 'x' })
    assert.equal(code, 2)
    assert.match(stderr, /连不上 DSHA 设备桥/)
    assert.ok(!stdout.includes('连不上'), '不该同时往 stdout 也打一份')
    const repeats = (stderr.match(/连不上 DSHA 设备桥/g) ?? []).length
    assert.equal(repeats, 1, `错误应只说一次，实际 ${repeats} 次`)
  })

  it('没凭据时也说清楚是「不在 DSHA 里」', async () => {
    const { code, stderr } = await run([], {
      DSHA_BRIDGE_URL: 'http://127.0.0.1:1',
      DSHA_BRIDGE_TOKEN: 'x',
      HOME: join(tmpdir(), 'no-such-home'),
    })
    assert.equal(code, 2)
    assert.ok(stderr.length > 0)
  })
})

describe('CLI --diff', () => {
  it('两份相同快照 → 无变化', async () => {
    const snapshot = JSON.stringify({
      schemaVersion: 1,
      verdict: 'ok',
      device: null,
      bridge: null,
      counts: { ok: 1 },
      probes: [{ id: 'a', label: 'A', group: 'meta', route: '/app/a', state: 'ok', code: null, detail: 'x', fix: null, sideEffect: false, ms: 1 }],
    })
    const dir = await mkdtemp(join(tmpdir(), 'capmap-diff-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      const left = join(dir, 'a.json')
      const right = join(dir, 'b.json')
      await writeFile(left, snapshot, 'utf8')
      await writeFile(right, snapshot, 'utf8')
      const { code, stdout } = await run(['--diff', left, right])
      assert.equal(code, 0)
      assert.match(stdout, /没有变化/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('文件不存在时以 2 退出并说明读不到', async () => {
    const { code, stderr } = await run(['--diff', '/no/such/a.json', '/no/such/b.json'])
    assert.equal(code, 2)
    assert.match(stderr, /读不到文件/)
  })

  it('不是快照的 JSON 给出明确错误', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'capmap-bad-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      const left = join(dir, 'a.json')
      const right = join(dir, 'b.json')
      await writeFile(left, '{"a":1}', 'utf8')
      await writeFile(right, '{"a":1}', 'utf8')
      const { code, stderr } = await run(['--diff', left, right])
      assert.equal(code, 2)
      assert.match(stderr, /probes/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
