# AgentGlow

面向 Linux 的硬件无关灯光状态引擎、配置界面与 Agent 集成。首个生产 backend 通过 `asusd` 支持 ROG Aura 与 Slash，后续可以接入外置 RGB 灯等其他设备。

项目目前已完成 P6 Desktop、P7 Codex/OpenCode/ZCode 接入，以及 P8 的 Linux/AUR
打包发布工具；正式发布前仍需完成干净环境安装和硬件验收。详细设计、当前进度与实施顺序见：

- [技术规划](docs/technical-plan.md)
- [开发路线图](docs/development-roadmap.md)
- [桌面应用产品规划](docs/desktop-product-plan.md)
- [硬件抽象决策](docs/decisions/hardware-abstraction.md)
- [P0 外部依赖验证](docs/p0-validation.md)

## 开发环境

- Node.js 24
- Yarn 4

项目已固定并随仓库携带 Yarn 4.17.1。首次安装不依赖系统全局 Yarn：

```bash
node .yarn/releases/yarn-4.17.1.cjs install --immutable
```

## 质量检查

```bash
yarn tiny typecheck
yarn tiny lint
yarn tiny format/check
yarn tiny test
yarn tiny build
yarn tiny smoke
```

一次执行全部检查：

```bash
yarn tiny check
```

如果系统中没有 `yarn` 命令，可以直接使用项目携带的版本：

```bash
node .yarn/releases/yarn-4.17.1.cjs tiny check
```

## 启动完整桌面应用

```bash
yarn tiny desktop
```

该命令会构建 daemon、CLI 和 Desktop，刷新开发用 systemd 用户 unit；已经运行的
服务会重启，未运行的服务不会被擅自启用。随后打开 GTK4/libadwaita 桌面窗口。

窗口提供概览与单一服务开关、自动生效的灯光样式、独立实时预览、注册驱动的设备
配置、Codex/OpenCode/ZCode 接入、合并在概览中的诊断能力和关于页。Agent 外部配置只有在展示目标文件和 diff
并由用户确认后才会写入。

## P1 可构建入口（历史基线）

P1 建立了两个 Node.js 入口：

- `apps/daemon`：常驻状态与灯光服务。
- `apps/cli`：状态、配置、诊断、服务与 Agent 适配命令。

两个入口的命令行参数、帮助与版本输出统一由 Commander.js 管理。

构建产物分别位于 `apps/daemon/dist/index.cjs` 和
`apps/cli/dist/index.cjs`。

## P2 无硬件闭环

项目保留 Unix Socket、JSON-RPC、租约仲裁和内存 fake backend 的无硬件闭环，
供自动测试和无硬件开发使用。
构建后，在一个终端启动 daemon：

```bash
node apps/daemon/dist/index.cjs
```

在另一个终端查看和切换状态：

```bash
node apps/cli/dist/index.cjs status
node apps/cli/dist/index.cjs devices
node apps/cli/dist/index.cjs event \
  --source manual \
  --session demo \
  --state working \
  --phase enter
node apps/cli/dist/index.cjs clear --source manual --session demo
```

在 fake backend 模式下，这条链路不访问真实硬件。

## Aura 实机 MVP

真实 Aura backend 必须显式选择并解锁：

```bash
AGENT_GLOW_HARDWARE_TEST=1 \
AGENT_GLOW_BACKEND=asusd \
node apps/daemon/dist/index.cjs
```

启动时 daemon 会保存 Aura 与 Slash 的完整状态，随后 `status`、`devices`、
`event` 和 `clear` 命令无需硬件专用参数即可使用。正常收到 `SIGINT` 或 `SIGTERM`
时，daemon 会恢复启动前的硬件状态。

当前 Aura 实现支持单区颜色和软件呼吸，Slash 实现支持开关、原生亮度、动画间隔
以及已验证的 16 种固件动画。

依次展示当前六种语义状态的实机冒烟测试：

```bash
yarn tiny smoke/hardware/aura
```

测试依次展示 `idle`、`paused`、`working`、`tool_use`、`waiting_permission`、`success` 和
`error`，每种状态停留约 5 秒。daemon 会为每次实际提交输出 state、效果、
颜色、强度、backend 和设备数；`working` 使用约 2.2 秒的软件呼吸周期，
`waiting_permission` 使用约 0.9 秒的软件呼吸周期。呼吸亮度通过缩放 RGB 输出，
不依赖设备提供细粒度硬件亮度。测试结束后恢复启动前的完整 Aura 状态。这个明确命名的硬件
任务会自动设置写入解锁变量；直接运行底层脚本仍然需要环境变量和确认参数双重解锁。

## 运行时设备配置与诊断

backend 可以通过通用 TypeBox schema 为每个设备注册布尔、整数和选择配置项。
Slash 会为六种语义状态分别注册动画、亮度和间隔。先通过 `devices` 获取设备 ID：

```bash
node apps/cli/dist/index.cjs device-config asusd:slash-<device-key>
node apps/cli/dist/index.cjs device-config-set \
  asusd:slash-<device-key> \
  states.working.effect \
  spectrum
node apps/cli/dist/index.cjs device-config-set \
  asusd:slash-<device-key> \
  states.working.brightness \
  160
node apps/cli/dist/index.cjs diagnostics
```

更新会立即重新应用当前语义状态并进入统一的 P5 配置事务。`diagnostics` 会展示
backend 健康状态、每个设备最近请求与实际应用的视觉状态、设备效果细节和降级原因。
配置通过 TypeBox 校验并原子保存。

## P4 动画与故障恢复

daemon 使用单调时钟驱动 10 Hz 动画，颜色过渡在线性 RGB 中计算。每台设备最多
只有一个写入进行中，等待区只保留最新量化帧；失败会以 250 ms 到 5 秒的有界指数
退避重试。`success` 使用单脉冲，`error` 使用双脉冲，状态切换过程中收到新目标时
会从当前可见帧继续过渡。

没有显式 TTL 的持续租约会在 5 分钟无更新后作为 stale session 回收。asusd 服务
重启后 backend 会重新发现设备并恢复当前逻辑目标；系统睡眠前恢复硬件快照，唤醒后
重新捕获快照并应用当前状态。

只查看测试计划、不写硬件：

```bash
yarn tiny smoke/hardware
```

## P0 探针

```bash
yarn tiny probe
yarn tiny probe/asusd
yarn tiny probe/gtk
```

硬件写入与恢复探针默认只显示计划：

```bash
yarn tiny probe/hardware/aura
yarn tiny probe/hardware/slash
```

真实写入必须按 [P0 外部依赖验证](docs/p0-validation.md) 显式解锁。

## 打包与发布

发布流程与 VoxSpell 保持一致。统一修改根包和所有 workspace 的版本号：

```bash
yarn tiny version
# 或非交互执行
node scripts/update-version.mts 0.1.0
```

只构建 Linux x86_64 二进制归档，不执行外部发布：

```bash
yarn tiny linux/build
```

基于同一归档构建本地 pacman 包和 AUR 元数据：

```bash
yarn tiny aur/build
sudo pacman -U dist/release/agent-glow-bin-0.1.1-1-x86_64.pkg.tar.zst
```

pacman 包统一输出到 `dist/release/` 根目录，文件名由版本、`pkgrel` 和架构唯一确定。
同一版本重复构建会覆盖同一路径，不会在其他目录留下另一个同名安装包。

发布 GitHub Release，或继续发布 AUR：

```bash
yarn tiny linux
yarn tiny aur
```

外部发布要求工作区干净、`v<version>` 指向当前提交且已推送到 `origin`，并且
GitHub CLI 已登录。发布流程不依赖 CI。产物写入 `dist/release/`；Linux 归档携带
固定 Node.js 24 runtime 和匹配 ABI 的 node-gtk，系统仍需提供 GTK4、libadwaita、
GObject Introspection 和 Cairo。`asusctl` 是 AUR 可选依赖，由运行时能力发现决定
是否启用 asusd 硬件后端。

## 作者与许可

作者：Geequlim

AgentGlow 与 VoxSpell 一致，采用
[PolyForm Noncommercial License 1.0.0](LICENSE)，允许非商业用途，禁止商业使用。
必需版权声明见 [NOTICE](NOTICE)。
