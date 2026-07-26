---
title: Node.js Runtime 发布策略
description: AgentGlow 通用 Linux 包固定携带 Node.js 24 runtime 的决策
order: 1
---

# Node.js Runtime 发布策略

状态：P0 已接受。

## 决策

AgentGlow 的通用 Linux x86_64 压缩包与 AUR 二进制包携带构建时固定的 Node.js 24 runtime，不依赖用户系统提供兼容的 Node.js。

源码开发仍要求 Node.js 24；发行版从源码打包者可以按自己的构建规则使用系统 Node.js，但必须针对该 Node ABI 重新构建 `node-gtk`。

## 依据

P0 实测环境：

```text
Node.js: 24.18.0
Node ABI: 137
node-gtk: 4.1.1
native binding: node-v137-linux-x64/node_gtk.node
```

`node-gtk` 包含与 Node ABI 绑定的原生模块。只声明“Node.js >= 24”不能保证用户系统 Node.js 与预构建模块 ABI 相同。固定 runtime 能让 daemon、CLI、Desktop 与原生绑定使用同一组已验证版本。

## 发布约束

- runtime、`node-gtk` 原生模块和 JavaScript bundle 必须来自同一次 staging 构建。
- 发布 smoke test 必须从 staging root 内的 runtime 启动 Desktop，而不是调用系统 `node`。
- GTK4、libadwaita、GObject Introspection 和 glibc 是桌面端系统依赖。
- asusd 是首发 `backend-asusd` 的系统依赖，不是 AgentGlow core 的固有依赖。
- Node.js 24 的具体 patch 版本在每次发布时固定并记录，不作为永久写死的产品协议。
- 升级 Node patch 后必须重新执行 GTK 窗口 probe 和发布包 smoke test。

这个决策只解决运行时和原生 ABI 一致性，不意味着把 GTK、libadwaita 或任何硬件 backend 的系统服务一起打包。
