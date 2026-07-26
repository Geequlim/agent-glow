---
title: 硬件无关架构
description: AgentGlow 核心与具体灯光硬件之间的 backend 边界
order: 1
---

# 硬件无关架构

状态：已接受。

## 决策

AgentGlow 是硬件无关的语义灯光编排引擎，不是 ROG 专用控制器。

Aura 键盘和 Slash 灯带是首个生产 backend `backend-asusd` 提供的设备实现。未来的外置 RGB 灯、其他厂商设备或网络灯具通过新的 backend 接入，不改变 Agent 事件模型、状态仲裁、动画时间线和 UI 的通用配置语义。

首个公开版本仍只承诺经过验证的 asusd 设备。硬件无关是架构边界，不等于首版同时开发多个生产 backend。

## 分层

```text
Agent / 编辑器 / 用户脚本
            │
            │ 语义事件
            ▼
      protocol + core
   租约 / 仲裁 / 动画 / 视觉目标
            │
            │ 通用设备能力与视觉命令
            ▼
       backend contract
        ├── fake backend
        ├── backend-asusd
        └── future backends
                │
                ▼
      Aura / Slash / 外置 RGB / 其他灯具
```

依赖方向只能向下：

- `protocol` 和 `core` 不得 import `backend-asusd`。
- 通用 RPC、配置 profile 和动画类型不得出现 D-Bus 接口名、asusd 对象路径、Aura/Slash 模式编号。
- backend 可以依赖通用能力与视觉类型，并负责把它们映射为本地硬件命令。
- Desktop 只通过 daemon 获取通用设备与能力；backend 专属诊断信息作为带命名空间的只读 metadata 展示。

## 通用 backend 职责

最终 TypeScript API 在 P2 通过 fake backend 测试确定。概念上每个 backend 必须提供：

- 唯一 backend ID 和健康状态；
- 动态发现设备；
- 设备稳定 ID、显示名称和能力集合；
- 读取可恢复快照；
- 应用通用视觉目标；
- 返回实际应用结果、降级说明和推荐最大提交频率；
- 恢复设备状态；
- 处理重连、设备增删和关闭。

通用设备能力至少描述：

- 是否支持 RGB 颜色；
- 色彩分区或像素数量；
- 亮度范围与步进；
- 静态、软件帧或固件效果能力；
- 可用固件效果的 backend-qualified ID；
- 安全提交频率；
- 快照和恢复完整度；
- 当前可用性与降级原因。

core 根据通用能力生成目标；backend 负责实际映射。backend 不能把未经声明的能力伪装成通用能力。

## 标识和配置

设备 ID 必须带 backend 命名空间，例如：

```text
asusd:aura:<stable-device-key>
asusd:slash:<stable-device-key>
future-rgb:<stable-device-key>
```

稳定 key 由 backend 生成，不能直接等于一次启动中的临时 D-Bus 对象路径。

通用主题按语义状态定义。backend 专属选项放在 `backends.<backend-id>` 命名空间中，不能污染通用 profile：

```yaml
profiles:
  working:
    color: "#5865F2"
    effect: breathe

backends:
  asusd:
    enabled: true
    aura:
      hardwareBrightness: 2
    slash:
      brightness: 128
```

设备实现可以向 daemon 注册自身支持的配置项。注册协议使用 TypeBox 定义
`boolean`、`integer` 和 `select` 三种最小字段类型，字段包含稳定 key、展示名称、
分组、默认值及约束。daemon 负责按注册 schema 校验更新，backend 只负责保存当前
运行时值并应用到设备。字段值属于具体设备实例，不要求不同硬件具有相同 key。

例如 Slash 可以动态注册每个语义状态的动画、亮度和间隔；通用协议只看到由设备
提供的 select 选项及其 opaque value，不包含 ROG 模式编号或编译期厂商枚举。
配置持久化、迁移和原子保存仍由 P5 的通用配置层负责。

## 首版边界

首版实现：

- fake backend，用于核心测试和无硬件开发；
- backend-asusd，用于 Aura 和 Slash；
- daemon 内支持 backend registry 和多个设备，但发布时只注册 asusd。

首版不实现：

- 动态下载或执行第三方 backend；
- backend 插件 SDK；
- OpenRGB、WLED 或其他具体外置灯协议；
- 跨多设备的空间像素布局。

新增第二个生产 backend 前，应先确认现有通用能力模型能够表达它；若不能，扩展通用模型，而不是在 core 中加入厂商分支。
