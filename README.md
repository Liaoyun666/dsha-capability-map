# dsha-capability-map

> 一条命令问清：**这台安卓手机上，agent 到底能用哪些能力？**

[DSHA](https://github.com/DSH-APP/DSHA)（DeepSeek​ Harness 安卓端）把通知、震动、剪贴板、读屏、
传感器、定位、手电这些只有 Android 能做的事，通过本地桥（`127.0.0.1:3090`）暴露给容器里的 agent。

问题是：**能调，不代表现在能用。**

同一个端点，真实世界里会以完全不同的四种方式失败，而四种的修法完全不一样：

| 你看到的 | 真实原因 | 该做什么 | 重试有用吗 |
| --- | --- | --- | --- |
| `DISABLED` | 用户在设置里没打开这个能力 | 去 DSHA → 设置 → 设备能力勾选 | ❌ 重试一万次也没用 |
| `NO_PERMISSION` | Android 系统权限没给 | 去系统设置授权 | ❌ |
| `FOREGROUND_SKIP` / `APP_BACKGROUND` | 时机不对（App 在后台 / 在前台） | 把 DSHA 切到前台或后台 | ✅ 换时机有用 |
| `[ERR] 无障碍服务未连接` | 真的坏了 | 排查 App 侧问题 | 🤷 可能有用 |

模型分不清这四种，就会**对着一个没开的开关虔诚地重试**，烧掉几千 token 再回一句「抱歉我没能
帮你发通知」。用户看到的是失败，实际只是没勾一个勾。

本插件把「这台设备此刻的能力边界」做成一张**横向可比的实测表**，并且把「重试无效」这句话
写死进结论里。

---

## 装

```bash
dsha-plugin install Liaoyun666/dsha-capability-map
```

或者：

```bash
dsh plugin add Liaoyun666/dsha-capability-map
```

装完新开一个会话即可。零运行时依赖，安卓 arm64 容器里不需要编译任何东西。

> 装到桌面端也不会崩：三个工具会如实返回「读不到桥凭据，本插件只在 DSHA 里有意义」。

---

## 三个工具

### `dsha_capability_map` — 体检

跑 14 项探测，给出一张分组表 + 一句下一步。

```
DSHA 能力体检 · Pixel 8

结论  11 项可用，2 项等你授权或开开关
      去 DSHA → 设置 → 设备能力 里勾上想要的那几项，然后重跑一次体检。

元信息
  可用    桥版本
  可用    设备信息
  可用    插件加载状态

传感器与位置
  未开启  环境光
           DISABLED
           → DSHA → 设置 → 设备能力，勾选这一项。重试无效，必须先开开关。
  未授权  定位
           NO_PERMISSION
           → 去 Android 系统设置里给 DSHA 授这个权限…
  可用    传感器清单

要处理的
  · 环境光（/app/sensor）：DISABLED
    错误码 DISABLED
    DSHA → 设置 → 设备能力，勾选这一项。重试无效，必须先开开关。
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `includeSideEffects` | `false` | 手电 / 震动 / 通知 / 弹提示会不会真的动手机。**默认不跑** |
| `only` | 全部 | 只查这些探测项或分组：`meta` `device` `sensor` `screen` `actuator` `ui` |
| `verbose` | `false` | 连通过的项也写明细，并带每项耗时 |

### `dsha_capability_json` — 存档

同样的 14 项，稳定结构的 JSON（`schemaVersion: 1`），适合写进报告、交给脚本、或者留着以后对比。

```json
{
  "schemaVersion": 1,
  "checkedAt": "2026-10-25T11:20:00.000Z",
  "device": "model=Pixel 8\nandroid=14\nbattery=76%",
  "bridge": { "baseUrl": "http://127.0.0.1:3090", "protocol": "DSHA 0.2.1-rc.2 (build 190)" },
  "verdict": "partial",
  "headline": "11 项可用，2 项等你授权或开开关",
  "counts": { "ok": 11, "disabled": 1, "no-permission": 1 },
  "probes": [
    { "id": "sensor.light", "label": "环境光", "group": "sensor", "route": "/app/sensor",
      "state": "disabled", "code": "DISABLED", "detail": "DISABLED",
      "fix": "DSHA → 设置 → 设备能力…", "sideEffect": false, "ms": 18 }
  ]
}
```

### `dsha_capability_diff` — 只看变了什么

换手机、升级 DSHA、刚去设置里勾了几个开关之后想知道「到底哪变了」：

```
两次体检的差异：
  - 「环境光」disabled → ok
  - 「定位」no-permission → ok
  - 设备：model=Pixel 6 → model=Pixel 8
```

---

## 14 项探测

分组只是排版用的，`--only` 可以按分组收窄。

| 分组 | 探测项 | 端点 | 副作用 |
| --- | --- | --- | --- |
| meta | 桥版本 | `/app/version` | |
| meta | 设备信息 | `/app/device` | |
| meta | 插件加载状态 | `/app/plugins` | |
| device | 应用清单（取 3 条） | `/app/apps` | |
| device | 读设备文件（列 Download） | `/app/readfile` | |
| device | 读剪贴板 | `/app/clip` | ⏱ 需前台 |
| sensor | 传感器清单 | `/app/sensors` | |
| sensor | 环境光 | `/app/sensor?name=light` | |
| sensor | 定位（`fresh=0`） | `/app/location` | |
| screen | 读屏（无障碍节点树） | `/app/ui/dump` | |
| actuator | 手电（**只关不开**） | `/app/torch?on=0` | ⚠️ |
| actuator | 震动（1 毫秒） | `/app/vibrate?ms=1` | ⚠️ |
| ui | App 内提示 | `/app/toast` | ⚠️ |
| ui | 通知栏 | `/app/notify` | ⚠️ ⏱ 前台会被跳过 |

⚠️ 的四项默认**不跑**：一个体检插件不该在用户没允许的时候点亮手电、震动手机、弹通知。
要验就显式 `includeSideEffects: true`（CLI 是 `--all`）。

手电那条永远只发 `on=0`：就算用户本来开着灯，体检也不会把它开着不管。

---

## 命令行的同一个东西

插件只在会话里可用，但「这台手机现在能干什么」是排查时最先要问的一句话。终端里：

```bash
node tools/cli.js                 # 人读表格
node tools/cli.js --all           # 连手电/震动/通知一起验
node tools/cli.js --json          # 机器可读
node tools/cli.js --out snap.json # 存档
node tools/cli.js --only sensor   # 只看传感器
node tools/cli.js --list          # 列出 14 项
node tools/cli.js --diff old.json new.json
```

退出码：`0` 全部可用（或有副作用项被跳过）/ `1` 有项不可用或异常 / `2` 参数或桥的问题。
CI 里可以直接用退出码当门禁。

判定逻辑、状态码、文案全部与工具层共用 `lib/probes.js`，不会漂移。

---

## 设计上刻意做的几件事

**1. 分清「没开」和「坏了」。**
`DISABLED` 与 `[ERR]` 都叫失败，但前者是用户去点一下，后者要排查。混在一起报等于没报。
状态表用错误码映射，不靠文案匹配 —— 文案会改，错误码是契约。

**2. 有副作用的探测默认不跑。**
体检不该有副作用。手电、震动、通知这四项必须显式打开；跑的时候报告里会标出来。

**3. 「重试无效」写死在结论里。**
模型看到 `DISABLED` 的第一反应是重试。所以 fix 文案里直接写「重试无效，必须先开开关」。
这不是修辞 —— 是省掉一轮无效重试。

**4. 桥连不上时只说一次。**
14 项全连不上，说 14 遍「连不上」是噪音。CLI 检测到整批都是 `BRIDGE_DOWN` 就收敛成一句话，
并告诉用户「不在 App 里 / App 被回收」这两种情况下重试都没用。

**5. 不确定就说不知道。**
`DISMISSED`、`USER_NO_ANSWER`、`RESULT_UNKNOWN` 归到「不确定」，不硬说是成功或失败。
把「不知道」说成「成功」比报错更糟。

**6. 串行发请求。**
桥是 App 进程里的单服务，并发只会互相挤，还会让 App 弹一堆东西。一次一个。

**7. 零运行时依赖。**
安卓容器是 Linux arm64/glibc。任何带原生模块的依赖（sharp、better-sqlite3、node-pty…）
在那儿装不上，装不上就是插件崩。只用 Node 内建 `fetch` / `fs`。

---

## 开发

```bash
npm test                    # 165 个测试，零依赖，不需要手机
npm run check               # 校验插件包契约（补丁文件 / 入口 / files / 依赖）
node tools/mock-bridge.js 3091 healthy   # 起个假桥，手工试
node tools/mock-bridge.js 3091 mixed     # 每类故障各来一条
node tools/mock-bridge.js 3091 offline   # 桥半死
```

假桥按 DSHA 的真实响应格式回话（`{"result": "..."}`），覆盖 `OK`、`OK: 细节`、
`[ERR] CODE` 三种形态 —— 这三种形态是本插件最容易写错的地方，所以必须有测试钉住。

环境变量：`DSHA_BRIDGE_URL`（默认 `http://127.0.0.1:3090`）、`DSHA_BRIDGE_TOKEN`
（缺省读 `/root/.dsh/.bridge_token` 或 `/root/.dsh/.bridge_headers`）。

### 想加一项探测

在 `lib/probes.js` 的 `PROBES` 里加一条（`id` / `label` / `group` / `route` / `params` /
`sideEffect` / `note`），在 `CODE_STATE` 里补上新端点可能返回的失败码，然后跑 `npm test`。
测试会检查字段齐备、副作用标注、顺序稳定 —— 少一个字段就跑不过。

---

## 相关

- [DSHA](https://github.com/DSH-APP/DSHA) —— DeepSeek​ Harness 安卓端
- [dsha-native-tools](https://github.com/Liaoyun666/dsha-native-tools) —— 姊妹插件：16 个设备能力**工具**（本插件负责诊断，它负责干活）
- [dsh-android-portability](https://github.com/Liaoyun666/dsh-android-portability) —— 姊妹插件：静态体检**插件本身**能不能在安卓 arm64 上跑

## License

MIT
