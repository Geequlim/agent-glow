---
title: AgentGlow 技术规划
description: 面向 Linux 的硬件无关灯光状态引擎、配置界面与 Agent 集成方案
order: 1
---

# AgentGlow 技术规划

## 1. 项目定位

AgentGlow 是一个运行在 Linux 用户会话中的硬件无关灯光状态服务。它把 AI Agent、编辑器、脚本等外部系统产生的语义状态，转换为平滑、可配置的灯光视觉状态，再由 backend 映射到实际设备。

项目核心既不是“Codex 灯光插件”，也不是“ROG 灯光控制器”，而是同时与事件来源和具体硬件解耦的通用灯效引擎：

```text
Codex / Claude Code / OpenCode / 用户脚本
                    │
                    │ 语义事件
                    ▼
             AgentGlow daemon
        状态仲裁 / 动画 / 渐变 / 恢复
                    │
                    │ 通用设备能力与视觉命令
                    ▼
              backend contract
             ├── fake backend
             ├── backend-asusd
             │       └── Aura / Slash
             └── future backends
                     └── 外置 RGB / 其他灯具
```

Codex Hook 只是第一种事件来源，asusd 只是第一种生产设备实现。任何能执行命令或连接 Unix Socket 的程序都可以接入相同事件协议；任何满足 backend contract 的设备实现都可以消费相同视觉状态。

### 1.1 首期支持范围

首期支持：

- Linux；
- 硬件无关的事件、仲裁、动画、设备能力和 backend contract；
- 用于无硬件开发和自动测试的 fake backend；
- 首个生产实现 `backend-asusd`；
- `asusd` 已通过 D-Bus 暴露的 Aura 与 Slash 设备；
- 单区 RGB 键盘的颜色、亮度、呼吸和状态过渡；
- Slash 已有的开关、亮度和固件动画；
- Codex、Claude Code、OpenCode 适配器；
- GTK4/libadwaita 配置界面；
- systemd 用户服务；
- 通用 Linux x86_64 压缩包与 AUR 二进制包。

首个公开版本只承诺经过真实验证的 asusd 能力，不承诺所有 ROG 设备，也不承诺外置 RGB 等其他硬件。项目从第一版就采用通用能力探测；UI 只显示 backend 对具体设备实际声明的功能。

### 1.2 非目标

首期不做：

- 同时开发第二个生产 backend；
- 动态加载未经审核的第三方 backend；
- 绕过 `asusd` 直接写 `/dev/hidraw*`；
- 要求 root 运行 AgentGlow；
- 伪造逐键 RGB、Lightbar、Logo 等硬件能力；
- 复刻 Armoury Crate 的全部功能；
- 在 Hook 中实现动画或直接访问硬件；
- 为未知设备发送未经验证的原始 HID 数据包。

通用协议、core 和 Desktop 不得包含 asusd 对象路径、Aura/Slash 模式编号或 ROG 专属分支。GU405AR 的 Slash 支持仍由已验证的补丁版 `asusd` 提供；`backend-asusd` 只消费 D-Bus 接口，不把机型补丁混入 AgentGlow。

## 2. 已确认的技术决策

整体工程和发布方式参考 VoxSpell，但仅复用适合本项目的部分。

| 领域 | 决策 |
| --- | --- |
| 语言 | TypeScript |
| 运行时 | Node.js 24 |
| 包管理 | Yarn 4，node-modules linker |
| 仓库 | Yarn Workspaces monorepo |
| 构建 | Rspack，输出可直接运行的 CJS bundle |
| 命令行框架 | Commander.js，统一 daemon 与 CLI 的参数、帮助和版本行为 |
| 桌面界面 | `node-gtk` + GTK4 + libadwaita |
| UI 状态 | MobX |
| 本地协议 | Unix Socket + JSON-RPC |
| 协议类型 | TypeBox + `vscode-jsonrpc` |
| 硬件抽象 | capability-driven `LightingBackend` contract |
| asusd 实现 | `@homebridge/dbus-native` 访问 system D-Bus |
| 配置 | YAML，TypeBox 校验，原子更新 |
| 测试 | Vitest |
| 代码质量 | TypeScript、Oxlint、Oxfmt |
| 任务入口 | tiny CLI / `project.tiny` |
| 服务管理 | systemd 用户服务 |
| 日志 | stdout/stderr 进入 journald |
| 首发平台 | Arch Linux/CachyOS，随后扩展通用 Linux |

### 2.1 为什么使用 systemd 用户服务

AgentGlow 访问的是当前用户的配置、运行时目录和桌面会话，不需要系统级权限。因此服务应安装为：

```text
/usr/lib/systemd/user/agent-glow.service
```

而不是 `/usr/lib/systemd/system/` 下的系统服务。这样可以避免 root 守护进程，也能让桌面应用、CLI 和 daemon 使用同一用户身份访问 Socket。

## 3. 仓库结构

建议首期保持以下结构：

```text
agent-glow/
├── apps/
│   ├── daemon/              # 常驻服务、RPC、设备与动画编排
│   ├── desktop/             # GTK4/libadwaita 配置界面
│   └── cli/                 # Hook 与用户脚本使用的稳定命令入口
├── packages/
│   ├── protocol/            # JSON-RPC、事件、配置和能力类型
│   ├── config/              # YAML 读取、校验、迁移和原子保存
│   ├── core/                # 状态仲裁、时间线、颜色、动画与 backend contract
│   └── backend-asusd/       # asusd D-Bus 发现、能力映射与设备写入
├── integrations/
│   ├── codex/
│   ├── claude-code/
│   └── opencode/
├── configs/
│   └── config.example.yaml
├── docs/
├── packaging/
│   ├── linux/root/
│   └── aur/
├── scripts/
├── package.json
├── project.tiny
└── yarn.lock
```

首期不进一步拆分动画包、颜色包、backend SDK 或每种 Agent 的 npm 包。只有当它们出现独立版本或独立复用需求时再拆分。`protocol` 和 `core` 不得依赖 `backend-asusd`。

## 4. 运行时架构

### 4.1 组件职责

#### CLI 与 Agent 适配器

职责：

- 把各 Agent 的原始 Hook 输入转换为统一事件；
- 通过 Unix Socket 把事件提交给 daemon；
- 在 daemon 未启动或超时时快速失败，不阻塞 Agent；
- 不保存最终状态，不计算颜色，不访问 backend 或任何硬件接口。

稳定入口示例：

```bash
agent-glow event \
  --source codex \
  --session "$SESSION_ID" \
  --state working
```

对于原始 Hook JSON，提供适配入口：

```bash
agent-glow adapt codex
agent-glow adapt claude-code
agent-glow adapt opencode
```

适配命令从 stdin 读取原始事件，转换后发送给 daemon。这样 Hook 配置保持短小，Agent API 变化也只影响对应适配器。

#### Daemon

daemon 是唯一的业务核心和 backend 编排者，负责：

- 注册 backend 并聚合其设备与真实能力；
- 接收和校验事件；
- 维护每个来源、会话的状态租约；
- 执行优先级仲裁；
- 维护当前视觉状态和目标视觉状态；
- 生成渐变、呼吸和瞬态动画；
- 控制写入频率与背压；
- 管理配置、预览和恢复；
- 向 UI 推送状态和诊断通知。

#### Desktop

桌面应用是 daemon 的薄客户端，负责：

- 服务启停与开机自启；
- 展示设备和真实能力；
- 编辑状态主题；
- 实时预览；
- 管理 Agent 集成；
- 展示当前状态、活动会话和诊断信息。

桌面应用不得直接编辑配置文件，也不得访问 backend、D-Bus、HID 或其他硬件接口。所有修改通过 daemon 校验并原子提交。

#### backend contract

每个 backend 负责发现设备、声明通用能力、读取恢复快照、应用视觉目标、报告降级结果、恢复状态并关闭连接。设备 ID 必须带 backend 命名空间且跨重连稳定，不能直接暴露一次启动中的临时路径。

core 只根据通用能力生成视觉目标。backend 负责把目标映射为硬件操作，并返回“请求效果、实际效果、降级原因和安全提交频率”。daemon 可以编排多个 backend 和多个设备；首版发布只注册 `backend-asusd`。

#### backend-asusd

首个生产 backend 只通过 `asusd` 的 system D-Bus 接口控制硬件：

- 使用 ObjectManager 动态发现对象；
- 识别 `xyz.ljones.Aura` 与 `xyz.ljones.Slash` 接口；
- 不硬编码 `/xyz/ljones/aura/19b6_4_5` 等设备路径；
- 读取支持模式、亮度、分区等能力；
- 将统一灯效命令降级为设备实际支持的操作。

## 5. 统一事件模型

### 5.1 语义状态

首期定义：

```ts
type SemanticState =
	| 'idle'
	| 'working'
	| 'waiting_permission'
	| 'success'
	| 'error'
	| 'paused';
```

建议默认表现：

| 状态 | 默认灯效 | 生命周期 |
| --- | --- | --- |
| `idle` | 恢复并保持系统原始硬件状态 | 无活动租约时 |
| `working` | 蓝紫色缓慢呼吸 | 持续状态 |
| `waiting_permission` | 琥珀色较快呼吸 | 持续到授权或取消 |
| `success` | 绿色柔和闪现后回落 | 瞬态，默认 1.5 秒 |
| `error` | 红色双脉冲后保持低亮度 | 瞬态叠加或持续错误 |
| `paused` | 暖白低亮度静态 | 持续状态 |

主动状态的默认效果只是预设，用户可在 UI 中修改；`idle` 不提供主题配置。

### 5.2 标准事件

```ts
interface AgentGlowEvent {
	readonly version: 1;
	readonly source: string;
	readonly sessionId: string;
	readonly state: SemanticState;
	readonly phase: 'enter' | 'leave' | 'pulse';
	readonly timestamp?: string;
	readonly ttlMs?: number;
	readonly metadata?: Readonly<Record<string, string>>;
}
```

约束：

- `source + sessionId` 唯一标识一个活动来源；
- `enter` 创建或更新租约；
- `leave` 清除对应状态；
- `pulse` 创建有 TTL 的瞬态叠加；
- daemon 使用自己的单调时钟决定动画时间，不能依赖来源时间戳；
- metadata 只用于诊断和未来规则匹配，不能携带任意硬件命令。

### 5.3 多会话仲裁

daemon 为每个会话维护租约，避免多个终端互相覆盖后无法恢复。

默认优先级：

```text
error > waiting_permission > success > working > paused > idle
```

规则：

1. 持续状态和瞬态叠加分开维护；
2. 瞬态状态到期后回到当前最高优先级持续状态；
3. 同优先级由最近更新时间决定；
4. SessionEnd 或显式 `leave` 立即释放；
5. 未正常结束的租约在超时后自动回收；
6. UI 预览使用独立的高优先级短租约，关闭页面或超时后自动恢复；
7. 后续允许用户调整优先级，但首版先固定，减少配置复杂度。

## 6. 灯效与动画引擎

这是 AgentGlow 的核心。前端和 Hook 只提交目标状态，daemon 自己维护完整时间线。

### 6.1 视觉状态

```ts
interface VisualState {
	readonly color: RgbColor;
	readonly intensity: number; // 0.0 - 1.0，软件强度
	readonly hardwareBrightness: number;
	readonly effect: 'static' | 'breathe' | 'pulse' | 'firmware';
	readonly periodMs: number;
	readonly transitionMs: number;
}
```

内部至少维护：

- `currentVisualState`：设备当前已呈现的估算状态；
- `targetVisualState`：仲裁结果对应的目标；
- `transition`：起点、终点、开始时间、持续时间、缓动函数；
- `lastCommittedFrame`：最后成功提交给设备的帧；
- `pendingFrame`：等待提交的最新帧。

当目标变化时，从“当前插值位置”开始新过渡，而不是从旧目标重新开始。连续拖动 UI 颜色选择器时也能保持平滑。

### 6.2 平滑过渡

状态切换默认使用 300 毫秒交叉渐变，范围可配置为 0–2000 毫秒。

颜色插值不能直接在 8 位 sRGB 数值上做线性运算。建议流程：

1. sRGB 转换到 linear RGB；
2. 使用缓动后的进度插值颜色和软件强度；
3. 转回 sRGB；
4. 量化为设备需要的整数通道。

默认缓动使用 `easeInOutSine`。这样暗部变化更自然，也能减少颜色在低亮度下突然跳变。

### 6.3 呼吸效果

软件呼吸使用连续相位：

```text
intensity(t) = min + (max - min) × (1 - cos(2πt / period)) / 2
```

建议默认值：

- 周期：2200 ms；
- 最低软件强度：0.08；
- 最高软件强度：1.0；
- 硬件亮度保持固定档位；
- 平滑度主要由 RGB 强度实现。

许多设备的硬件亮度是离散档位，例如首个 backend 中 Aura 报告 0–3。逐帧切换硬件亮度会产生明显台阶，因此通用渲染器输出连续的软件强度，backend 在呼吸期间保持硬件亮度不变，只改变颜色光强。

当设备原生支持 `Breathe` 且用户选择“硬件效果”时，可直接使用固件动画，降低写入频率。需要精确颜色、渐变或跨状态衔接时，使用软件渲染的静态帧。

### 6.4 写入频率和背压

首版软件动画默认 10 Hz，可在 5–20 Hz 安全范围内配置。不是所有设备都适合高频写入，因此最终上限由各 backend 声明的设备能力和稳定性策略共同决定。

渲染循环必须：

- 使用 monotonic clock，不累计 `setInterval` 漂移；
- 永远只保留最新待提交帧；
- backend 写入未完成时不并发写入同一设备；
- 写入变慢时丢弃过期帧，而不是排队追赶；
- 相同量化帧不重复提交；
- 连续失败后暂停该设备动画并报告降级状态；
- daemon 退出时停止调度器，再执行恢复。

### 6.5 能力降级

统一主题按设备能力映射，Aura 和 Slash 只是首个 backend 的实例：

| 目标效果 | 单区 RGB（如 Aura） | 固件效果设备（如 Slash） | 无 RGB，仅亮度 |
| --- | --- | --- | --- |
| 静态色 | 静态颜色 | 选择最接近的固件样式或仅开关 | 固定亮度 |
| 呼吸 | 固件 Breathe 或软件 RGB 帧 | 固件 Pulse/Flow 等最接近效果 | 亮度脉冲，若安全 |
| 渐变 | 软件 RGB 帧 | 使用 Slash 已支持动画 | 不支持，回退静态 |
| 成功脉冲 | 软件短动画 | 临时动画后恢复 | 短亮度变化 |

如果能力不足，backend 返回明确的降级说明，UI 展示实际效果，而不是假装完整支持。

## 7. 设备所有权与恢复

灯光可能同时被厂商控制中心、快捷键或其他程序控制。首版采用清晰的所有权策略：

- AgentGlow 启用时，由 daemon 统一管理被选中的设备；
- daemon 启动后先读取并保存可恢复的设备状态；
- 无 Agent 活动时显示用户配置的基础主题；
- daemon 停止、禁用设备或发生致命错误时，尽力恢复启动前状态；
- 如果状态无法完整读取，则恢复到用户配置的安全基础主题；
- UI 展示 backend 提供的所有权提示。对于 asusd 设备，AgentGlow 启用期间在 ROG Control Center 修改同一设备可能被下一帧覆盖。

不做两个控制器同时写同一设备的“自动融合”。

## 8. Daemon RPC

Socket 路径：

```text
$XDG_RUNTIME_DIR/agent-glow/daemon.sock
```

目录权限 `0700`，Socket 权限 `0600`。若路径被非 Socket 节点占用，daemon 必须拒绝删除或覆盖。

首期 RPC：

| 方法 | 用途 |
| --- | --- |
| `initialize` | 协商协议版本和客户端能力 |
| `daemon.getStatus` | 服务、配置、设备和动画状态 |
| `device.list` | 列出设备及真实能力 |
| `device.config.get` | 获取设备实现注册的配置描述与当前运行时值 |
| `device.config.update` | 校验并更新设备运行时配置 |
| `event.emit` | 提交标准语义事件 |
| `event.clear` | 清理来源或会话租约 |
| `state.listActive` | 查看当前活动租约与仲裁结果 |
| `profile.list` | 获取状态主题 |
| `config.get` | 读取当前配置 |
| `config.validate` | 验证但不保存 |
| `config.update` | 原子保存并平滑应用 |
| `preview.start` | 创建有 TTL 的预览租约 |
| `preview.update` | 更新预览目标，不重置当前插值 |
| `preview.stop` | 停止预览并平滑恢复 |
| `diagnostics.get` | 获取 backend、降级和错误摘要 |

通知：

- `daemon.statusChanged`
- `device.changed`
- `state.changed`
- `visual.changed`，需要限流；
- `config.changed`
- `preview.expired`

所有外部输入使用 TypeBox schema 做运行时验证，并对消息大小、metadata 数量、字符串长度和 RPC 并发数设上限。

## 9. 配置模型

默认路径：

```text
$XDG_CONFIG_HOME/agent-glow/config.yaml
```

配置示意：

```yaml
version: 1

daemon:
  frameRate: 10
  staleSessionTimeoutMs: 300000

rendering:
  colorSpace: linear-rgb
  restoreOnExit: true
  transitionMs: 300

profiles:
  working:
    color: "#5865F2"
    effect: breathe
    hardwareIntensity: 0.7
    minimumIntensity: 0.08
    maximumIntensity: 1
    periodMs: 2200
  waiting_permission:
    color: "#FF9F1C"
    effect: breathe
    hardwareIntensity: 1
    minimumIntensity: 0.15
    maximumIntensity: 1
    periodMs: 900
  success:
    color: "#35C759"
    effect: pulse
    hardwareIntensity: 0.9
    minimumIntensity: 0.15
    maximumIntensity: 1
    durationMs: 900
    pulseCount: 1
  error:
    color: "#FF3B30"
    effect: pulse
    hardwareIntensity: 1
    minimumIntensity: 0.15
    maximumIntensity: 1
    durationMs: 1000
    pulseCount: 2
  paused:
    color: "#FFF4D6"
    effect: static
    hardwareIntensity: 0.3
    intensity: 0.25

devices:
  "backend:stable-device-id":
    states.working.brightness: 128
```

仓库中的 `configs/config.example.yaml` 是由同一 TypeBox schema 持续验证的完整默认示例。
`devices` 下的键来自 backend 声明的稳定设备 ID，值来自该设备运行时注册的通用配置项；
顶层 schema 不包含任何具体硬件类型。

配置管理要求：

- daemon 是唯一写入者；
- 更新前完整校验；
- 写入临时文件、同步并原子替换；
- schema 带版本；
- 不认识的新字段默认报错，避免拼写错误静默失效；
- 配置应用失败时保留旧配置和旧运行态；
- 密钥不属于本项目配置。

## 10. 配置界面

界面采用 GTK4/libadwaita，首版页面：

### 10.1 概览

- daemon 运行状态；
- systemd 启用状态；
- 当前语义状态和来源；
- 当前颜色、效果和降级结果；
- 发现的 backend、设备和真实能力；
- 最近错误。

### 10.2 状态主题

- 为每个主动语义状态选择颜色；
- 选择 Static、Breathe、Pulse 或设备原生效果；
- 设置周期、强度范围和过渡时间；
- 实时预览；
- 恢复默认值。

颜色选择器更新时只发送新的预览目标。daemon 从当前渲染位置平滑过渡，UI 不发送逐帧颜色。

### 10.3 设备

- 启用或禁用某个设备；
- 展示 backend 返回的颜色、亮度、分区和固件效果能力；
- 调整固定硬件亮度；
- 查看某个主题在该设备上的实际降级方式；
- 执行短时设备测试。

### 10.4 集成

- Codex、Claude Code、OpenCode 的检测状态；
- 生成或安装 Hook 配置；
- 展示将要修改的文件和 diff；
- 一键移除；
- 提供通用 CLI 示例。

集成安装属于显式外部配置变更，UI 必须先展示目标和内容，再由用户确认。

### 10.5 诊断

- daemon、Node.js、backend 版本；backend-asusd 额外展示 asusd 版本；
- backend 设备和能力摘要；backend-asusd 额外展示脱敏 D-Bus 摘要；
- 活动租约；
- 最近降级与写入错误；
- 导出脱敏诊断文本；
- 打开 journald 查看命令。

## 11. Agent 集成

每个适配器只完成“原始生命周期事件 → 标准语义事件”的映射。

### 11.1 Codex

目标映射以 Codex 实际支持的 Hook 事件为准。规划中的典型映射：

| 生命周期 | AgentGlow |
| --- | --- |
| 用户提交任务 | `working enter` |
| 请求授权 | `waiting_permission enter` |
| 授权完成 | `waiting_permission leave`，恢复 `working` |
| 任务成功结束 | `success pulse`，然后释放 `working` |
| 任务失败 | `error pulse` |
| 会话结束 | 清理会话全部租约 |

如果某个 Codex 版本没有对应 Hook，不在适配器中猜测，而是降级到现有事件。

### 11.2 Claude Code 与 OpenCode

采用同一模型，各自在 `integrations/` 中维护：

- 原始事件解析；
- session ID 提取；
- 状态映射；
- 安装模板；
- fixture 测试。

适配器不得依赖项目内部 daemon 类，只依赖 `@agent-glow/protocol` 和 CLI 发送接口。

## 12. systemd 服务

建议 unit：

```ini
[Unit]
Description=AgentGlow lighting state daemon
After=graphical-session.target
PartOf=graphical-session.target
StartLimitIntervalSec=30s
StartLimitBurst=5

[Service]
Type=simple
ExecStart=/usr/bin/agent-glow-daemon
Restart=on-failure
RestartSec=2s

[Install]
WantedBy=graphical-session.target
```

注意：

- `asusd.service` 是系统服务，不能依赖用户 unit 的 `After=` 跨 systemd manager 排序；daemon 必须处理 D-Bus 尚未就绪和服务重启；
- 首次从桌面应用启用时执行 `systemctl --user enable --now agent-glow.service`；
- 禁用时停止 daemon，并尽力恢复设备状态；
- 发布包安装 unit，但不应在包安装脚本中擅自为所有用户启用；
- daemon 处理 SIGTERM/SIGINT，停止动画、清理 Socket、恢复设备后退出；
- 恢复过程有严格超时，不能阻塞 systemd 停止。

## 13. 可靠性和安全

### 13.1 Backend 恢复

- 每个 backend 独立报告健康状态、重连和设备变化；
- 某个 backend 不可用时保留逻辑目标，不影响其他 backend；
- backend 恢复后重新发现设备和能力，从当前逻辑时间计算一帧；

backend-asusd 还必须：

- 监听 `asusd` 名称所有者变化；
- `asusd` 消失时暂停提交并保留目标状态；
- 重新出现后重新发现对象和能力；
- 设备路径变化时不依赖旧 proxy；
- 恢复连接后从当前逻辑时间重新计算一帧，不补发历史帧。

### 13.2 失败隔离

- 一个设备或 backend 失败不停止其他设备与 backend；
- backend-asusd 内 Aura 软件动画失败时可降级到固件静态或 Breathe；
- backend-asusd 内 Slash 失败时不影响键盘；
- 连续失败使用指数退避，并在 UI 中显示；
- 未捕获异常触发有界退出，由 systemd 重启；
- 禁止无限高速重试和日志刷屏。

### 13.3 输入边界

- Socket 仅当前用户可访问；
- Hook 命令默认 200 毫秒内完成，连接失败不阻塞 Agent；
- 不执行 metadata 中的命令；
- 配置中的颜色、周期、频率和亮度均限制范围；
- 不允许 RPC 客户端绕过 backend 发送原始 D-Bus、HID、网络或厂商命令。

## 14. 测试策略

### 14.1 单元测试

`packages/core` 使用虚拟时钟测试：

- 状态优先级和同优先级决策；
- 租约超时和 SessionEnd 清理；
- 瞬态叠加结束后的恢复；
- 从当前插值位置重定向目标；
- linear RGB 转换和量化；
- 呼吸曲线的边界、周期和连续性；
- 帧去重、丢帧和背压；
- 能力降级。

### 14.2 集成测试

- Unix Socket 权限和陈旧 Socket 清理；
- JSON-RPC schema、超时和消息限制；
- 通用 fake backend 下的完整事件到帧流程；
- backend-asusd 的 fixture 驱动能力映射测试；
- 配置原子更新和失败回滚；
- UI 断开后预览租约自动过期；
- systemd 客户端命令构造。

### 14.3 硬件测试

真实硬件测试必须显式启用，不进入普通 CI：

```bash
AGENT_GLOW_HARDWARE_TEST=1 yarn tiny test/hardware
```

GU405AR 首轮验收：

1. 发现单区 Aura 和 Slash；
2. Aura 静态颜色可切换；
3. 10 Hz 软件呼吸运行 10 分钟无 D-Bus 堆积；
4. 快速拖动颜色选择器无明显突跳；
5. `working → waiting_permission → working → success → idle` 连续平滑；
6. 同时运行两个会话时仲裁正确；
7. 重启 `asusd` 后自动恢复；
8. 停止 AgentGlow 后恢复基础主题或启动前状态；
9. 键盘、Slash、睡眠唤醒无异常；
10. journald 无高频错误刷屏。

## 15. 构建与发布

发布流程参考 VoxSpell：

### 15.1 开发命令

`project.tiny` 提供：

```text
yarn tiny dev
yarn tiny dev/desktop
yarn tiny build
yarn tiny test
yarn tiny typecheck
yarn tiny lint
yarn tiny format
yarn tiny smoke
yarn tiny test/hardware
```

### 15.2 构建产物

Rspack 输出：

```text
apps/daemon/dist/index.cjs
apps/desktop/dist/index.cjs
apps/cli/dist/index.cjs
```

Linux staging root：

```text
/usr/bin/agent-glow
/usr/bin/agent-glow-daemon
/usr/lib/agent-glow/desktop/index.cjs
/usr/lib/agent-glow/daemon/index.cjs
/usr/lib/agent-glow/cli/index.cjs
/usr/lib/systemd/user/agent-glow.service
/usr/share/applications/agent-glow.desktop
/usr/share/icons/hicolor/...
/usr/share/licenses/agent-glow/...
```

可像 VoxSpell 一样随二进制包携带固定 Node.js 24 runtime，保证 `node-gtk` ABI 与发布环境一致。GTK4、libadwaita 和 GObject Introspection 是桌面端运行依赖；`asusctl`/`asusd` 是首发 `backend-asusd` 的运行依赖，不是 AgentGlow 核心协议的固有依赖。

### 15.3 发布门禁

发布脚本要求：

1. 所有 workspace 版本一致；
2. 工作区干净；
3. `vX.Y.Z` 标签指向当前提交且已推送；
4. typecheck、lint、format check、test、smoke 全部通过；
5. 构建可复现的 `tar.zst`；
6. 生成 SHA-256；
7. 发布 GitHub Release；
8. 从同一资产生成 AUR `PKGBUILD` 和 `.SRCINFO`；
9. 验证来源后更新 `agent-glow-bin`。

首版只发布 Linux x86_64。

### 15.4 许可证

建议使用 MPL-2.0：

- 与 `asusctl` 社区生态相容；
- 允许商业和非商业使用；
- 修改已有 MPL 文件时保持修改开放；
- 不强制整个应用采用同一许可证。

若项目不复制 `asusctl` 源码，只使用公开 D-Bus 接口，也可以改用 Apache-2.0。仓库初始化阶段需正式确定，避免后续文件来源不清。

## 16. 分阶段实施

### M0：工程骨架

- 初始化 Node.js 24 + Yarn 4 monorepo；
- 建立 protocol、core、backend-asusd、daemon、CLI、desktop；
- 用 fake backend 固化硬件无关的 `LightingBackend` contract；
- 接入 TypeScript、Vitest、Oxlint、Oxfmt、Rspack、tiny；

验收：空 daemon 能通过安全 Unix Socket 响应 `initialize` 和 `getStatus`。

### M1：首个生产 backend 与手动控制

- 注册通用 backend registry；
- 实现 backend-asusd 并连接 system D-Bus；
- 动态发现 Aura/Slash；
- 读取并展示能力；
- CLI 设置语义状态；
- 静态颜色、开关、亮度和安全恢复。

验收：protocol/core 不包含 asusd 类型；替换 fake backend 或 backend-asusd 都能完成 `idle ↔ working`，且 asusd 实现不硬编码 GU405AR 路径。

### M2：动画引擎

- 虚拟时钟；
- linear RGB 插值；
- 呼吸、脉冲、交叉渐变；
- 写入背压和设备隔离；
- fake backend 完整测试。

验收：快速改变目标颜色仍连续，慢写入时队列长度始终有界。

### M3：配置界面

- 概览、状态主题、设备和诊断页；
- daemon systemd 管理；
- 预览租约；
- 配置校验、原子更新和回滚。

验收：UI 不直接写硬件或配置文件，关闭预览后自动恢复。

### M4：Agent 适配

- Codex 适配器与安装流程；
- Claude Code 适配器；
- OpenCode 适配器；
- 通用 CLI 文档和 fixtures。

验收：三个来源可以同时工作，异常退出不会永久占用状态。

### M5：发布

- Linux staging；
- systemd unit；
- desktop entry 与图标；
- 固定 Node runtime；
- GitHub Release 和 AUR；
- 安装、升级、卸载与回滚测试。

## 17. 首版完成标准

首个公开版本必须同时满足：

- daemon 以普通用户身份由 systemd 管理；
- protocol、core、配置 profile 和通用 RPC 不包含 asusd、Aura、Slash 或 ROG 专属类型；
- fake backend 和 backend-asusd 实现同一 backend contract；
- Hook 与配置界面均不直接控制硬件；
- Aura 单区 RGB 能平滑显示静态、呼吸、授权、成功和错误效果；
- Slash 至少能按主题控制开关、亮度和已支持样式；
- 所有颜色切换由 daemon 过渡，无明显突跳；
- 多会话仲裁、超时回收和瞬态恢复经过自动测试；
- `asusd` 重启、AgentGlow 重启、桌面退出均能恢复；
- 不向未知设备发送原始 HID 数据；
- AUR 安装后无需手工复制文件即可运行；
- 文档明确列出设备实际能力与已知限制。

## 18. 后续演进

完成首版后再评估：

- 按应用、仓库或 Agent 类型选择不同主题；
- 系统托盘快速开关；
- 屏幕锁定、通知、构建、测试等通用事件源；
- 插件 SDK 和 npm 类型包；
- 更丰富的 Slash 场景编排；
- 逐键 RGB 布局和空间动画；
- Wayland 桌面状态集成；
- 外置 RGB、网络灯具和其他厂商的 backend。

新 backend 应实现同一能力接口，不改变 Agent 事件模型和 UI 配置语义。AgentGlow 从第一版就是通用本地状态灯效服务；backend-asusd 只是第一个经过真实设备验证的实现。
