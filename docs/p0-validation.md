---
title: P0 外部依赖验证
description: AgentGlow 在 GU405AR 开发机上的技术前提、验证结果与剩余决策
order: 3
---

# P0 外部依赖验证

验证日期：2026-07-26。

本轮 P0 验证的是首个生产实现 `backend-asusd` 的外部前提，不代表 AgentGlow core 依赖 ROG 或 D-Bus。硬件无关边界见 [硬件无关架构](decisions/hardware-abstraction.md) 决策。

## 1. 当前结论

| 项目 | 状态 | 结论 |
| --- | --- | --- |
| Node.js 24 | 通过 | v24.18.0，Node ABI 137 |
| Yarn 4 | 通过 | 仓库固定 v4.17.1 |
| system D-Bus | 通过 | 普通用户可连接 `xyz.ljones.Asusd` |
| asusd ObjectManager | 通过 | 根路径 `/` 实现 `GetManagedObjects` |
| Aura 发现与读取 | 通过 | 动态对象上暴露 `xyz.ljones.Aura` |
| Slash 发现与读取 | 通过 | 与 Aura 位于同一动态对象上 |
| Aura 写入与恢复 | 通过 | 临时写入静态色后完整恢复并回读确认 |
| Slash 写入与恢复 | 通过 | 临时切换开关后恢复并回读确认 |
| node-gtk ABI | 通过 | node-gtk 4.1.1 在 Node ABI 137 下构建和加载 |
| GTK 窗口 | 通过 | GTK4/libadwaita 窗口成功显示并自动关闭 |
| Codex Hook 契约 | 通过 | 本机 v0.145.0，官方生命周期文档已核对 |
| OpenCode 插件契约 | 通过 | 本机 v1.18.5，官方事件列表已核对 |
| Claude Code Hook 契约 | 部分通过 | 官方文档已核对，本机尚未安装，缺真实 fixture |
| 发布 runtime 策略 | 已决定 | 通用二进制包携带固定 Node.js 24 runtime |
| 许可证 | 待决定 | 需要在 MPL-2.0、Apache-2.0 或其他许可中明确选择 |

## 2. 本机环境

```text
Kernel: Linux 7.1.4-1-cachyos x86_64
Node.js: 24.18.0
Node ABI: 137
Yarn: 4.17.1
asusctl package: 6.3.10-1
asusd D-Bus Version: 6.3.9
GTK: 4.22.4
libadwaita: 1.9.2
GObject Introspection: 1.86.0
Codex CLI: 0.145.0
OpenCode: 1.18.5
Claude Code: not installed
```

开发机使用 GU405AR 补丁版 asusd：

```text
systemd service: asusd.service
executable: /usr/local/libexec/asusd-gu405ar
D-Bus name: xyz.ljones.Asusd
```

系统包版本和实际 daemon 版本不同，诊断信息必须读取 D-Bus 的 `xyz.ljones.Platform.Version`，不能只读取发行版包版本。

## 3. 可重复探针

查看环境：

```bash
yarn tiny probe
```

只读发现 Aura 与 Slash：

```bash
yarn tiny probe/asusd
```

验证 GTK typelib 和原生 ABI：

```bash
yarn tiny probe/gtk
yarn tiny probe/gtk/window
```

硬件探针默认只输出计划并退出，不会写入设备：

```bash
yarn tiny probe/hardware/aura
yarn tiny probe/hardware/slash
```

真实写入需要环境变量和参数双重确认：

```bash
AGENT_GLOW_HARDWARE_TEST=1 node scripts/probes/asusd-write-restore.mts \
  --target=aura-color \
  --confirm-write

AGENT_GLOW_HARDWARE_TEST=1 node scripts/probes/asusd-write-restore.mts \
  --target=slash-enabled \
  --confirm-write
```

两个探针都会先保存完整属性值，在 `finally` 中恢复，并回读验证恢复结果。

## 4. 对实现的约束

- backend 必须调用 ObjectManager，按接口名发现功能。
- 不能根据对象路径中是否包含 `aura` 或 `slash` 判断设备能力。
- 同一个 D-Bus 对象可能同时实现 Aura 与 Slash。
- 当前 Aura 只报告单个 basic mode，不能承诺固件呼吸模式。
- 当前 Aura 不报告 basic zone，首版应按单区设备处理。
- Slash 没有“支持模式列表”属性，模式编号需要单独验证后才能映射为用户可见名称。
- daemon 应同时展示 asusd D-Bus 版本和发行版包版本，便于识别补丁版不一致。
- `node-gtk` 是 Node ABI 绑定，发布包不能随意使用用户机器上的任意 Node.js 24 小版本。

## 5. P0 剩余项

1. 确定仓库许可证并替换当前 `UNLICENSED`。
2. 安装或取得 Claude Code 可执行文件后，采集本机真实 Hook fixture。
3. 在 P7 实现前，为 Codex 与 OpenCode 采集真实事件 payload；当前只完成官方契约验证。
4. 对 Slash 各个 `Mode` 编号做显式人工硬件验证，形成“编号 → 固件效果”表。

这些剩余项不阻塞 P1/P2 的无硬件核心开发；许可证必须在复制外部代码或首次公开发布前完成，真实 Hook fixtures 必须在对应适配器实现前完成。
