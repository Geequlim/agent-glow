---
title: Agent 生命周期能力矩阵
description: Codex、Claude Code 与 OpenCode 当前可观测生命周期及 AgentGlow 映射约束
order: 1
---

# Agent 生命周期能力矩阵

核对日期：2026-07-26。

## 1. 验证来源

- Codex：本机 `codex-cli 0.145.0` 与 [OpenAI Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)
- Claude Code：[官方 Hooks Reference](https://code.claude.com/docs/en/hooks)
- OpenCode：本机 `1.18.5` 与 [官方 Plugins 文档](https://opencode.ai/docs/plugins/)

本机没有安装 Claude Code，因此 Claude Code 目前只有官方契约结论，没有本机 payload fixture。

## 2. 能力对比

| 语义 | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| 会话开始 | `SessionStart` | `SessionStart` | `session.created` |
| 用户提交 | `UserPromptSubmit` | `UserPromptSubmit` | `message.updated`，需进一步筛选角色 |
| 工具开始/结束 | `PreToolUse` / `PostToolUse` | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `tool.execute.before` / `tool.execute.after` |
| 请求授权 | `PermissionRequest` | `PermissionRequest` | `permission.asked` |
| 授权结果 | 没有独立“用户已回答”事件 | `PermissionDenied`，允许后进入工具事件 | `permission.replied` |
| 正常停止 | `Stop` | `Stop` | `session.idle` |
| 失败 | 没有通用 turn failure Hook | `StopFailure`、`PostToolUseFailure` | `session.error` |
| 会话结束 | `SessionEnd` | `SessionEnd` | `session.deleted` |

## 3. 推荐映射

### Codex

- `UserPromptSubmit` → `working enter`
- `PermissionRequest` → `waiting_permission pulse`，使用短 TTL
- `PostToolUse` → 清理同 session 的 permission pulse，保持或恢复 `working`
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

- `session.created` / 用户消息 → `working enter`
- `permission.asked` → `waiting_permission enter`
- `permission.replied` → `waiting_permission leave`
- `session.idle` → `success pulse` 并释放 `working`
- `session.error` → `error pulse`
- `session.deleted` → 清理整个 session

插件只负责转换事件并调用稳定 CLI/RPC，不引用 daemon 内部实现。

## 4. 共同约束

- 适配器只使用官方稳定字段，不解析 transcript 作为主协议。
- 所有 Hook/插件调用必须在 daemon 不可用时快速失败。
- session ID 必须来自来源事件；缺失时使用短 TTL，不创建永久租约。
- 不根据自然语言输出猜测 `success` 或 `error`。
- 三类来源分别维护 schema 和 fixtures，不伪造统一的上游 Hook 格式。
