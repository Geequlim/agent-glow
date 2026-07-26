---
title: Headless beta 使用与验收
description: AgentGlow 配置、systemd 用户服务、日志和硬件恢复操作
order: 3
---

# Headless beta 使用与验收

AgentGlow 的 headless 版本由 daemon、CLI、YAML 配置和 systemd 用户服务组成。
daemon 不要求 asusd 先启动：硬件服务不可用时仍会创建 Unix Socket、接受事件和保留
当前逻辑状态；asusd 出现后会自动重新发现设备、应用持久设备配置并提交当前状态。
没有活动租约时的 `idle` 表示系统默认状态：daemon 恢复接管前保存的完整硬件快照，
不会应用可配置颜色或动画。

## 配置

默认配置位于 `$XDG_CONFIG_HOME/agent-glow/config.yaml`；未设置
`XDG_CONFIG_HOME` 时使用 `~/.config/agent-glow/config.yaml`。首次启动自动创建
`0700` 配置目录和 `0600` 配置文件。

```bash
agent-glow config show
agent-glow config validate ./candidate.yaml
agent-glow config apply ./candidate.yaml
```

`config apply` 提交完整 v1 配置。daemon 会先校验 TypeBox 契约和已连接设备注册项，
再准备临时文件、暂停渲染、应用运行态并原子替换正式文件。任一步失败都会保留旧文件、
旧设备配置和旧灯效。示例见 `configs/config.example.yaml`。

## systemd 用户服务

发行包把 unit 安装到 `/usr/lib/systemd/user/agent-glow.service`，但不会自动启用或
启动。CLI 的下列命令等价于用参数数组调用 `systemctl --user`，不经过 shell：

```bash
agent-glow service status
agent-glow service enable
agent-glow service start
agent-glow service restart
agent-glow service stop
agent-glow service disable
```

开发检出可显式安装本地 unit。安装只复制 unit 并执行用户级 `daemon-reload`，不会
enable 或 start。该 unit 显式选择当前生产 `asusd` backend；普通自动测试仍显式
使用 fake backend：

```bash
yarn tiny service/install
agent-glow service enable
agent-glow service start
```

移除指令不区分服务来源：只要 `agent-glow.service` 存在，就会先停止并禁用它，再删除
用户目录中的开发 unit 和开发 Desktop Entry，最后 mask 同名服务。即使系统仍安装着正式
unit，移除后也不能被 `start` 再次启动；重新执行开发安装指令时才会解除 mask：

```bash
yarn tiny service/remove
```

以上 AgentGlow 服务操作都不需要 sudo。

## 日志与故障恢复

daemon 只向 stdout/stderr 写日志，由用户级 journald 收集：

```bash
yarn tiny service/start
```

该指令强制重启当前可用且未被移除的 `agent-glow.service`，立即打印 `FragmentPath`、
`ExecStart` 和 `MainPID`，然后使用 systemd invocation 过滤持续显示这一次启动产生的
全部日志，不混入历史进程记录。服务已被移除或系统中没有 unit 时，启动会直接失败。

每次启动的第一行会同时打印 daemon bundle 和 Node runtime 的绝对路径。开发版路径位于
项目检出目录，正式安装版路径位于 `/usr/lib/agent-glow/`，可以据此直接确认当前服务来源：

```text
[agent-glow] service source entry=/usr/lib/agent-glow/apps/daemon/dist/index.cjs runtime=/usr/lib/agent-glow/runtime/bin/node
```

可重点检查以下记录：

- `backend unavailable`：asusd 尚未出现或已断开，Socket 与逻辑状态仍保留。
- `backend refreshed`：服务恢复后完成设备发现、配置重放和当前视觉帧提交。
- `restored snapshots`：正常停止时恢复 daemon 启动前的设备完整状态。
- `daemon shutdown timed out`：停止超过 5 秒总预算，daemon 强制关闭 backend；
  unit 的 `TimeoutStopSec=7s` 提供最终边界。

## 当前机器的 P5 人工验收

先执行开发 unit 的安装、enable、start、restart、stop、disable，并用 journald
确认启动与停止日志。随后在 Aura 与 Slash 上应用一份可辨认的配置，重启 daemon，
确认配置仍生效且停止后恢复原快照。

asusd 晚到和重启测试需要由用户在另一个终端执行系统服务操作；AgentGlow 自身不执行
sudo：

```bash
sudo systemctl stop asusd.service
sudo systemctl start asusd.service
sudo systemctl restart asusd.service
```

在 asusd 停止期间，`agent-glow status` 和 `agent-glow diagnostics` 应仍可响应，
diagnostics 的 backend health 为 `unavailable`。启动后应自动恢复为 `healthy` 并
重新列出 Aura 与 Slash。
