---
title: GU405AR asusd 能力
description: 通过 ObjectManager 实测的 Aura 与 Slash D-Bus 能力
order: 1
---

# GU405AR asusd 能力

本页记录 2026-07-26 在 GU405AR 补丁版 asusd 6.3.9 上的实测结果。它是开发 fixture，不代表所有 ROG 设备。

## 1. 服务与对象

```text
D-Bus name: xyz.ljones.Asusd
ObjectManager path: /
lighting object: /xyz/ljones/aura/19b6_4_5
```

关键发现：同一个动态对象同时实现 `xyz.ljones.Aura` 和 `xyz.ljones.Slash`。对象路径属于实现细节，AgentGlow 只能按接口发现能力。

## 2. Aura

| 属性                  | 签名               | 实测值或范围                     |
| --------------------- | ------------------ | -------------------------------- |
| `DeviceType`          | `u`                | `0`                              |
| `Brightness`          | `u`                | `3`                              |
| `SupportedBrightness` | `au`               | `0, 1, 2, 3`                     |
| `LedMode`             | `u`                | `0`                              |
| `SupportedBasicModes` | `au`               | `0`                              |
| `SupportedBasicZones` | `au`               | 空                               |
| `SupportedPowerZones` | `au`               | `1`                              |
| `LedModeData`         | `(uu(yyy)(yyy)ss)` | 模式、区域、两组 RGB、速度、方向 |
| `LedPower`            | `(a(ubbbb))`       | 单个 power zone                  |

当前设备只确认了单区静态颜色。`SupportedBasicModes` 没有报告 Breathe，因此软件呼吸是首版可靠路径。

写入验证使用 `LedModeData` 将第一组 RGB 临时设为 `(64, 0, 64)`，等待 500 ms 后恢复完整原始 struct。写入值和恢复值均通过 `Properties.Get` 回读确认。

## 3. Slash

| 属性                 | 签名 | 实测值                  |
| -------------------- | ---- | ----------------------- |
| `Enabled`            | `b`  | `false`                 |
| `Brightness`         | `y`  | `64`                    |
| `Interval`           | `y`  | `1`                     |
| `Mode`               | `u`  | `50`（Hazard / `0x32`） |
| `ShowOnBattery`      | `b`  | `false`                 |
| `ShowOnBoot`         | `b`  | `false`                 |
| `ShowOnLidClosed`    | `b`  | `false`                 |
| `ShowOnShutdown`     | `b`  | `false`                 |
| `ShowOnSleep`        | `b`  | `false`                 |
| `ShowBatteryWarning` | `b`  | `false`                 |

Slash 还暴露 `DeviceState() -> (byyu)` 方法。D-Bus 接口本身没有报告合法 `Mode`
列表，但当前安装的 `asusctl 6.3.10` 提供了与 ROG Control Center 相同的固件动画枚举：

```text
Static, Bounce, Slash, Loading, BitStream, Transmission, Flow, Flux,
Phantom, Spectrum, Hazard, Interfacing, Ramp, GameOver, Start, Buzzer
```

因此 AgentGlow 应利用这些固件动画，而不是把 Slash 降级为只有开关和亮度的设备。
枚举名称和数值转换属于 `backend-asusd` 的版本适配细节；通用协议只表达
`firmware_effect` 能力和稳定的通用效果意图，不暴露 ROG 模式编号。

首个语义映射依据动画含义选择少量模式，不逐个轮播全部枚举：

| 语义状态             | Slash 模式 | 亮度     | 选择依据                     |
| -------------------- | ---------- | -------- | ---------------------------- |
| `idle`               | 不设置     | 系统原值 | 恢复接管前保存的完整硬件快照 |
| `paused`             | Bounce     | 20%      | 低亮度往返表达仍在等待       |
| `working`            | Loading    | 60%      | 进度条式动画表达处理中       |
| `tool_use`           | BitStream  | 90%      | 高频数据流表达工具正在执行   |
| `waiting_permission` | Buzzer     | 100%     | 通知式动画要求用户注意       |
| `success`            | Slash      | 90%      | 明确、快速的品牌式扫光       |
| `error`              | Hazard     | 100%     | 警示闪烁表达异常             |

亮度使用 Slash 原生的 `0–255` 连续值；`Interval` 使用 `0–5`，控制基础动画
重复之间的间隔。

GU405AR 补丁版已把 `Mode` getter 与 setter 统一为 `SlashMode` 的 `u` 签名，
AgentGlow 可以通过标准 `Properties.Get/Set` 读取、切换并恢复模式，不需要绕过
asusd 抢占 USB 设备。

2026-07-26 的真实主动状态测试已确认 `Enabled`、`Brightness`、`Interval` 和
`Mode` 均可写入。测试结束后的回读为 `false / 64 / 1 / 50`，与测试前完全一致。

## 4. AgentGlow Aura MVP 验证

2026-07-26 已通过构建后的 daemon 与 CLI 完成真实闭环：

```text
动态发现 Aura
→ 保存完整 LedModeData
→ 应用 idle 静态色
→ CLI working enter
→ CLI clear 回到 idle
→ SIGTERM
→ 恢复启动前完整 LedModeData
```

CLI 看到的设备 ID 为 backend-qualified opaque ID，例如
`asusd:aura-d338d228c031`，不会暴露 D-Bus 对象路径。退出后的只读回读确认
`LedModeData` 已恢复为测试前的完整值。

## 5. AgentGlow Slash MVP 验证

`yarn tiny smoke/hardware/slash` 已通过构建后的 daemon 与 CLI 完成真实闭环：

```text
Phantom → Bounce → Loading → Buzzer → Slash → Hazard
→ SIGTERM
→ 恢复 Enabled / Brightness / Interval / Mode
```

六种状态各展示 5 秒，日志逐项输出模式、亮度和间隔；除 Slash 不支持颜色的预期
能力降级外，没有 D-Bus 错误，退出码为 0。

## 6. P4 长时间运行与恢复验证

`yarn tiny smoke/hardware/p4` 在 Aura 上执行 10 分钟、10 Hz 的 working 呼吸。
2026-07-26 的正式验收完成 20 次 diagnostics 采样，所有采样均满足：

```text
backend.health = healthy
device.status = ok
delivery.consecutiveFailures = 0
delivery.retryScheduled = false
delivery.pending = false
```

同一次验收还完成 75 ms 快速重定向、完整语义序列和两个 CLI session 的优先级
恢复。执行 `sudo systemctl restart asusd.service` 后，daemon 观察到服务消失，
暂停提交，并在服务恢复后重新发现 Aura、捕获新快照和恢复 working 逻辑目标。重启
窗口只有一次预期的 `NoReply`，没有进入第二次退避。

P4 后再次运行 Slash 主动状态冒烟测试，五种固件动画均切换成功，进入 idle 及退出时
`Enabled`、`Brightness`、`Interval` 和 `Mode` 完整恢复。

## 7. 归一化 fixture

实测属性保存在：

```text
scripts/probes/fixtures/asusd-gu405ar.json
```

fixture 只包含设备路径、接口、属性签名和值，不包含用户身份、总线唯一连接名或其他硬件配置。
