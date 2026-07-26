# AgentGlow

面向 Linux 的硬件无关灯光状态引擎、配置界面与 Agent 集成。首个生产 backend 通过 `asusd` 支持 ROG Aura 与 Slash，后续可以接入外置 RGB 灯等其他设备。

项目目前处于工程基础建设阶段。详细设计与实施顺序见：

- [技术规划](docs/technical-plan.md)
- [开发路线图](docs/development-roadmap.md)
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

## P1 可构建入口

P1 提供两个最小 Node.js 入口：

- `apps/daemon`：常驻进程骨架，支持 `--help`、`--version`、`SIGINT` 与 `SIGTERM`。
- `apps/cli`：命令行骨架，支持 `--help` 与 `--version`。

两个入口的命令行参数、帮助与版本输出统一由 Commander.js 管理。

构建产物分别位于 `apps/daemon/dist/index.cjs` 和
`apps/cli/dist/index.cjs`。这一阶段只建立进程边界与构建、测试链路，
尚未接入 Socket/RPC、状态引擎或任何硬件 backend。

## P2 最小闭环

当前 daemon 使用 Unix Socket、JSON-RPC、租约仲裁和内存 fake backend 跑通无硬件闭环。
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

这条链路目前只提交静态视觉状态到 fake backend，不访问真实硬件。

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

测试依次展示 `idle`、`paused`、`working`、`waiting_permission`、`success` 和
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

更新会立即重新应用当前语义状态。`diagnostics` 会展示 backend 健康状态、每个设备
最近请求与实际应用的视觉状态、设备效果细节和降级原因。这一阶段的设备配置只保存在
daemon 内存中；P5 再负责配置文件持久化、迁移和原子保存。

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
