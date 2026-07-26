---
title: Agent 生命周期能力矩阵
description: Codex、Claude Code、OpenCode 与 ZCode 当前可观测生命周期及 AgentGlow 映射约束
order: 1
---

# Agent 生命周期能力矩阵

核对日期：2026-07-26。

本页记录四个 Agent 的能力调研。当前产品实现 Codex、OpenCode 和 ZCode；Claude Code
不进入当前路线图、界面或验收门槛。

## 1. 验证来源

- Codex：本机 `codex-cli 0.145.0` 与 [OpenAI Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)
- Claude Code：[官方 Hooks Reference](https://code.claude.com/docs/en/hooks)
- OpenCode：本机 `1.18.5` 与 [官方 Plugins 文档](https://opencode.ai/docs/plugins/)
- ZCode：本机 `3.4.2` 内置 Hook 配置指南、运行时 schema 与[官方插件文档](https://zcode.z.ai/cn/docs/plugin)

本机没有安装 Claude Code，因此 Claude Code 目前只有官方契约结论，没有本机 payload fixture。

## 2. 能力对比

| 语义          | Codex                        | Claude Code                                         | OpenCode                                     | ZCode                                         |
| ------------- | ---------------------------- | --------------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| 会话开始      | `SessionStart`               | `SessionStart`                                      | `session.created`                            | `SessionStart`                                |
| 开始处理      | `UserPromptSubmit`           | `UserPromptSubmit`                                  | `session.status` 的 `busy`                   | `UserPromptSubmit`                            |
| 工具开始/结束 | `PreToolUse` / `PostToolUse` | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `tool.execute.before` / `tool.execute.after` | `PreToolUse` / `PostToolUse`                  |
| 请求授权      | `PermissionRequest`          | `PermissionRequest`                                 | `permission.asked`                           | `PermissionRequest`                           |
| 授权结果      | 没有独立“用户已回答”事件     | `PermissionDenied`，允许后进入工具事件              | `permission.replied`                         | 没有独立事件，允许后进入工具事件              |
| 正常停止      | `Stop`                       | `Stop`                                              | `session.idle`                               | `Stop`                                        |
| 失败          | 没有通用 turn failure Hook   | `StopFailure`、`PostToolUseFailure`                 | `session.error`                              | `PostToolUseFailure`，没有通用 turn failure   |
| 会话结束      | `SessionEnd`                 | `SessionEnd`                                        | `session.deleted`                            | 没有独立事件                                  |

## 3. 推荐映射

### Codex

- `UserPromptSubmit` → `working enter`
- `PermissionRequest` → `waiting_permission pulse`，使用短 TTL
- `PreToolUse` → 清理同 session 的 permission pulse，进入 `tool_use`
- `PostToolUse` → 释放 `tool_use`，恢复 `working`
- `Stop` → `success pulse` 并释放 `working`
- `SessionEnd` → 清理整个 session

Codex 当前 Hook 没有独立的 permission resolved/denied 事件，因此不能把 `PermissionRequest` 直接映射为无限期持续租约。短 TTL 是保守降级；后续如果 app-server 提供稳定、可安装的授权通知，再单独评估更精确的适配器。

`Stop` 代表 agent 完成一次响应，不等同于业务任务一定成功。因此默认只能表示“本轮正常结束”，不应根据最终文本猜测成功或失败。

### Claude Code

- `UserPromptSubmit` → `working enter`
- `PermissionRequest` → `waiting_permission enter`
- `PostToolUse` 或 `PermissionDenied` → `waiting_permission leave`
- `Stop` → `success pulse` 并释放 `working`
- `PostToolUseFailure` / `StopFailure` → `error pulse`
- `SessionEnd` → 清理整个 session

Claude Code 的授权结果和失败事件更完整，但仍需真实 fixture 验证字段与版本差异。

### OpenCode

OpenCode 应采用 TypeScript plugin，而不是 stdin command Hook：

- `session.status: busy` → `working enter`
- `permission.asked` → `waiting_permission enter`
- `permission.replied` → `waiting_permission leave`
- `tool.execute.before` → 清理同 session 的授权状态，进入 `tool_use`
- `tool.execute.after` → 释放 `tool_use`，恢复 `working`
- 顶层会话的 `session.status: idle` / `session.idle` → `success pulse` 并释放 `working`
- 子 Agent 的 idle → 只释放自身 `working`，不播放全局完成
- `session.error` → `error pulse`
- `session.deleted` → 清理整个 session

插件只负责转换事件并调用稳定 CLI/RPC，不引用 daemon 内部实现。
不能把 `message.updated` 当作任务开始：它是消息内容更新通知，在子 Agent 和会话收尾
期间可能重复或与 idle 交错，容易在完成后重新创建陈旧的 working 租约。

### ZCode

- `SessionStart` → 清理同 session 的残留租约
- `UserPromptSubmit` → `working enter`
- `PermissionRequest` → `waiting_permission pulse`，使用短 TTL
- `PreToolUse` → 清理授权提示并进入 `tool_use`
- `PostToolUse` → 释放 `tool_use`
- `PostToolUseFailure` → `error pulse` 并释放 `tool_use`
- `Stop` → `success pulse` 并释放 `working`

ZCode 配置型 Hook 位于 `~/.zcode/cli/config.json` 的 `hooks.events`，必须设置
`hooks.enabled: true`。它的 stdin payload 使用 `hook_event_name` 和 `session_id`，
因此与 Codex 共用解析核心，但保留独立来源和独立安装 schema。涉及多个租约变化的
Hook 使用一次 `event.transition` 原子提交，避免真实硬件响应超过客户端等待时间时只
完成一半清理。

## 4. 当前实现

- Codex 通过 `agent-glow adapt codex` 读取官方 Hook stdin payload；daemon 不可用、
  payload 非法或缺少 session ID 时静默返回，不阻塞 Codex。
- Desktop 将 AgentGlow handler 合并到 `~/.codex/hooks.json`，保留其他 handler；
  升级和移除通过 AgentGlow 标记识别旧命令。
- OpenCode 通过 `~/.config/opencode/plugins/agent-glow.js` 全局插件接入，直接使用
  200 ms 有界 Unix Socket RPC。
- ZCode 通过 `agent-glow adapt zcode` 读取原生 Hook stdin payload，并由 Desktop
  合并到 `~/.zcode/cli/config.json`。
- 三种接入都必须先在 Desktop 查看目标文件和 diff，再明确确认；写入前会重新核对
  文件内容，避免覆盖确认期间发生的外部修改。
- OpenCode 目标文件若已存在但不是 AgentGlow 生成，安装器拒绝覆盖或删除。

## 5. 共同约束

- 适配器只使用官方稳定字段，不解析 transcript 作为主协议。
- 所有 Hook/插件调用必须在 daemon 不可用时快速失败。
- session ID 必须来自来源事件；缺失时使用短 TTL，不创建永久租约。
- 不根据自然语言输出猜测 `success` 或 `error`。
- 各类来源分别维护 schema 和 fixtures，不伪造统一的上游 Hook 格式。
