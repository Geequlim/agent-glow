---
title: AgentGlow 开发路线图
description: 从空仓库逐步交付 AgentGlow 首个公开版本的实施方案
order: 2
---

# AgentGlow 开发路线图

本文把《AgentGlow 技术规划》转换为可逐步执行和验收的开发路线。技术规划负责说明“做什么、为什么这样做”，本文负责说明“先做什么、做到什么程度才能进入下一阶段”。

## 1. 实施策略

开发顺序采用纵向切片，而不是同时搭建所有应用的空壳：

```text
技术风险验证
    ↓
事件 → daemon → fake backend 的无硬件闭环
    ↓
接入首个生产 backend-asusd，完成静态灯光闭环
    ↓
补齐仲裁、动画和故障恢复
    ↓
配置与 systemd
    ↓
桌面界面
    ↓
Agent 适配器
    ↓
打包发布
```

遵循以下约束：

1. 每个阶段都必须产生一个可运行、可测试的增量。
2. fake backend 先于真实硬件，核心逻辑不能依赖 D-Bus 才能测试。
3. CLI 先于 Desktop，先证明协议和 daemon，再为稳定能力制作界面。
4. Codex 适配器先单独跑通，再复用模式实现 Claude Code 和 OpenCode。
5. 从 P2 固化硬件无关 backend contract，但不提前实现第二个生产 backend、插件 SDK 或逐键 RGB。
6. 当前阶段验收未通过时，不并行扩张下一阶段功能范围。

## 2. 版本与里程碑

| 里程碑 | 可交付结果 | 是否需要真实硬件 |
| --- | --- | --- |
| P0 风险验证 | 关键依赖和外部接口有可运行探针，技术决策冻结 | 是 |
| P1 工程基础 | monorepo、质量门禁和构建链可用 | 否 |
| P2 无硬件闭环 | CLI 事件可经 daemon 驱动 fake backend | 否 |
| P3 首个生产 backend | backend-asusd 的 Aura/Slash 可发现、静态控制并恢复 | 是 |
| P4 动画与可靠性 | 多会话仲裁、平滑动画、背压和重连可用 | 是 |
| P5 配置与服务 | YAML 配置、RPC 更新、systemd 用户服务可用 | 是 |
| P6 Desktop | 用户可通过 GTK 界面配置、预览和诊断 | 是 |
| P7 Agent 集成 | Codex、Claude Code、OpenCode 可稳定接入 | 部分 |
| P8 发布候选 | tar.zst 和 AUR 包通过安装、升级、卸载测试 | 是 |

P0–P3 构成第一个“开发者可用版本”；P4–P5 构成 headless beta；P6–P8 构成首个公开版本。

## 3. P0：验证高风险前提

目标：在搭建完整工程前验证最可能推翻技术方案的外部条件。

### 3.1 任务

- [ ] 确定许可证：MPL-2.0 或 Apache-2.0，并记录选择理由。
- [x] 记录开发机的 Node.js、Yarn、GTK4、libadwaita、GObject Introspection、asusd 版本。
- [x] 用最小 TypeScript/JavaScript 探针验证 `@homebridge/dbus-native` 能连接 system D-Bus。
- [x] 枚举 asusd ObjectManager 对象，保存经过脱敏的 Aura/Slash 接口、属性和方法样本。
- [x] 验证一次 Aura 状态读取、静态颜色写入和原状态恢复。
- [x] 验证一次 Slash 状态读取、支持操作写入和原状态恢复。
- [x] 用最小 `node-gtk` 程序在 Node.js 24 下打开 GTK4/libadwaita 窗口。
- [ ] 核对 Codex、Claude Code、OpenCode 当前真实可用的 Hook 事件、输入格式、超时行为和配置位置。
- [x] 决定发布包是携带固定 Node.js runtime，还是依赖系统 Node.js；记录 ABI 与包体积取舍。

探针代码放入 `scripts/probes/`，它们只用于开发验证，不进入 daemon 生产代码。

### 3.2 产物

- `docs/decisions/` 下的许可证、runtime 和外部接口决策记录。
- `docs/hardware/asusd-capabilities.md`，描述实测接口与设备能力。
- 脱敏后的 D-Bus 与 Hook fixtures，供后续自动测试使用。
- 能打开窗口的 GTK 探针和能读写后恢复设备的 asusd 探针。

### 3.3 验收门槛

- GTK 探针能在目标系统启动和退出。
- D-Bus 探针不硬编码对象路径即可找到目标设备。
- 所有硬件写入验证都能恢复测试前状态。
- 每个 Agent 只承诺已确认存在的生命周期事件；无法观测的状态明确记录降级方案。
- 若任一核心依赖在 Node.js 24 下不可用，先更新技术决策，不进入 P1。

## 4. P1：建立最小工程基础

目标：得到稳定、可重复的开发基线，但不急于创建 Desktop 或集成适配器空壳。

### 4.1 任务

- [x] 初始化 Node.js 24、Yarn 4、node-modules linker 和 Workspaces。
- [x] 创建当前有运行价值的 `packages/protocol`、`packages/core`、`apps/daemon`、`apps/cli`。
- [x] 建立依赖边界检查：protocol/core 不得依赖生产 backend。
- [x] 配置共享 TypeScript 规则和 workspace 引用。
- [x] 配置 Vitest、Oxlint、Oxfmt。
- [x] 配置 Rspack，将 daemon 和 CLI 输出为可直接运行的 CJS bundle。
- [x] 使用 Commander.js 统一 daemon 与 CLI 的命令行入口。
- [x] 建立 `project.tiny` 的 `build`、`test`、`typecheck`、`lint`、`format`、`smoke` 入口。
- [ ] 确定许可证并添加许可证文件。

### 4.2 验收门槛

在全新检出中，以下命令全部通过：

```bash
yarn install --immutable
yarn tiny typecheck
yarn tiny lint
yarn tiny test
yarn tiny build
yarn tiny smoke
```

`smoke` 至少验证 CLI 和 daemon bundle 可由 Node.js 24 加载。此阶段不要求连接 D-Bus。

MVP 阶段只维护上述本地门禁，不投入 CI、贡献流程或尚无调用方的 workspace。`packages/config`
在需要用户配置时创建，`packages/backend-asusd` 在 P3 接入首个真实 backend 时创建。

## 5. P2：打通无硬件的端到端闭环

目标：不依赖 GTK、systemd 或真实设备，证明事件模型、RPC、仲裁入口和设备抽象能够协作。

### 5.1 协议与配置

- [x] 在 `packages/protocol` 定义协议版本、语义状态、标准事件、设备能力和 MVP RPC schema。
- [x] 为所有外部输入设置长度、数量、消息大小和并发上限。
- [ ] 第一条无硬件闭环完成后，再按实际需求建立 `packages/config`；原子落盘延后到 P5。
- [x] 为 schema 添加合法、边界和未知字段测试。

首批 RPC 只实现：

- `initialize`
- `daemon.getStatus`
- `device.list`
- `event.emit`
- `event.clear`

`state.listActive`、`diagnostics.get` 和 Desktop RPC 在首个 MVP 闭环后按实际调用需求添加。

### 5.2 核心与 fake backend

- [x] 定义硬件无关的最小 `LightingBackend` 接口：backend 健康状态、发现、通用能力、读取快照、应用视觉状态、降级结果、恢复、关闭。
- [x] 设备 ID 使用 backend 命名空间，不能等于临时 D-Bus 对象路径。
- [x] 实现内存 fake backend，记录提交历史。
- [x] 实现持续租约、`enter`、`leave`、`pulse`、TTL 和固定优先级仲裁。
- [x] 使用可注入的 monotonic clock，测试中使用虚拟时钟。
- [x] 此阶段只输出静态目标视觉状态，不实现逐帧动画。

慢写入和失败注入在开始验证背压与错误隔离时添加，不阻塞首个 MVP 闭环。

### 5.3 Daemon 与 CLI

- [x] 创建安全的 Unix Socket 目录和 Socket。
- [x] 拒绝覆盖被普通文件、目录或符号链接占用的 Socket 路径。
- [x] daemon 接收并校验 JSON-RPC，调用 core，再把结果提交给 fake backend。
- [x] CLI 实现 `status`、`devices`、`event` 和 `clear`。
- [x] CLI 在 daemon 不可用或超时时快速失败，默认预算不超过 200 ms。
- [x] 处理 SIGINT/SIGTERM，停止接收请求、关闭 backend、清理自己创建的 Socket。

### 5.4 验收场景

自动化集成测试必须证明：

1. daemon 启动后 Socket 目录权限为 `0700`，Socket 权限为 `0600`。
2. `working enter` 使 fake backend 收到 working 的静态视觉状态。
3. `waiting_permission enter/leave` 能覆盖并恢复 working。
4. `success pulse` 到期后恢复当前持续状态。
5. 两个 session 同时存在时，清理一个不会错误清理另一个。
6. 非法事件、超大消息和未知字段被拒绝，daemon 仍保持可用。
7. daemon 不存在时，CLI 在超时预算内退出。

完成这些场景后，得到第一个真正的纵向切片：

```text
CLI → Unix Socket → JSON-RPC → 租约仲裁 → fake backend
```

## 6. P3：接入首个生产 backend-asusd

目标：在不改变 protocol/core 的前提下注册 backend-asusd，完成安全的静态灯光控制，并证明 backend 可替换。

### 6.1 任务

- [x] 通过 system D-Bus ObjectManager 动态发现 Aura 与 Slash。
- [x] 将 D-Bus 对象映射为 backend-qualified 稳定设备 ID 和通用能力，不暴露易变化的对象路径给上层。
- [x] 实现 Aura `LedModeData` 完整快照。
- [x] 实现 Aura 单区静态颜色；开关和硬件亮度按实际需求延后。
- [x] 把 Slash 映射为独立设备，并声明 `power`、`brightness` 和
  `firmware_effect` 通用能力。
- [x] 实现 Slash 的完整状态快照与恢复：`Enabled`、`Brightness`、
  `Interval`、`Mode`。
- [x] 从 Slash 已确认动画中选择与语义直接相关的最小子集，不在通用协议中暴露
  ROG 模式编号，也不为测试轮播全部枚举。
- [x] 用正常六状态硬件冒烟测试验证语义映射、亮度、间隔和完整恢复。
- [x] 实现能力降级结果，让 CLI 和 diagnostics 能看到“请求效果”和“实际效果”。
- [x] 允许设备实现通过 TypeBox 通用描述注册运行时配置项，并由 daemon 统一校验；
  Slash 首批注册六种语义状态的动画、亮度和间隔。
- [x] daemon 启动时保存快照，正常停止时恢复。
- [x] 一个设备失败时隔离错误，不停止其他设备。
- [x] 保留 fake backend。
- [x] 用同一组 daemon 合约测试分别运行 fake backend 与 backend-asusd fixture。

### 6.2 验收门槛

- 不硬编码 GU405AR 的对象路径即可发现 Aura 和 Slash。
- protocol、core、通用 RPC 和 profile schema 中没有 asusd、Aura 或 Slash 类型。
- `idle → working → idle` 可以通过 CLI 驱动真实设备。
- Slash 不支持颜色时返回明确降级信息。
- Slash 能随语义状态切换已验证的固件动画、间隔和亮度，而不是只切换开关。
- daemon 正常退出后恢复启动前状态；无法恢复时应用并记录安全基础主题。
- 硬件测试必须通过 `AGENT_GLOW_HARDWARE_TEST=1` 显式启用。

P3 已完成，并统一标记内部开发版本 `0.1.0-dev`，用于日常真实设备试用。

## 7. P4：动画、仲裁与故障恢复

目标：把静态控制升级为长时间运行仍有界、平滑和可恢复的灯效引擎。

### 7.1 建议实现顺序

按以下五个可独立验收的小阶段推进，不并行铺开：

1. **P4-A：确定性动画数学**
   - [x] 已完成。
   - 实现 linear RGB 与 sRGB 转换、量化、缓动函数和可注入单调时钟。
   - 用虚拟时钟证明呼吸周期连续、强度不越界、测试不依赖真实等待。
2. **P4-B：有界设备提交器**
   - [x] 已完成。
   - 每台设备只允许一个进行中的写入，并且等待区只保留最新目标。
   - 增加量化帧去重；用慢 fake backend 证明没有并发写入和无界队列。
3. **P4-C：语义过渡与瞬态**
   - [x] 已完成。
   - 从目标改变瞬间的当前插值位置开始交叉渐变。
   - 实现连续相位呼吸、success 单脉冲和 error 双脉冲。
   - 验证高优先级瞬态结束后恢复当前最高优先级持续状态。
4. **P4-D：生命周期与故障恢复**
   - [x] 已完成。
   - 回收 stale session；为连续失败增加有界退避和去重日志。
   - 监听 asusd D-Bus 名称所有者变化，重新发现设备并恢复当前逻辑目标。
   - 处理睡眠、唤醒和 daemon 停止恢复。
5. **P4-E：真实硬件验收**
   - [ ] 待执行。
   - 先跑 10 分钟 Aura 软件呼吸，再验证快速重定向和完整状态序列。
   - 手动重启 asusd 验证重新发现；最后验证两个真实 CLI session 的仲裁。

每个阶段都先完成 fake/fixture 自动测试，再执行必要的真实硬件测试；P4 不增加 CI。

### 7.2 自动验收

使用虚拟时钟和 fake backend 验证：

- [x] 过渡起点等于目标改变瞬间的当前插值值。
- [x] 呼吸曲线在周期边界连续，强度不越界。
- [x] 相同量化帧不重复提交。
- [x] 写入慢于 10 Hz 时，没有无界队列，也没有同设备并发写入。
- [x] 瞬态结束后恢复当时最高优先级的持续状态。
- [x] stale session 超时后被回收。
- [x] 单设备连续失败不影响其他设备，重试不会刷屏。

### 7.3 硬件验收

- 10 Hz 软件呼吸连续运行 10 分钟，无 D-Bus 请求堆积。
- 快速连续改变目标颜色时无明显跳变。
- `working → waiting_permission → working → success → idle` 连续平滑。
- 重启 asusd 后 daemon 能重新发现设备并恢复当前逻辑目标。
- 两个真实 CLI session 的优先级和清理行为正确。

## 8. P5：持久配置与 systemd 用户服务

目标：让 headless 版本具备可长期使用、重启后保持配置和由用户服务管理的能力。

### 8.1 配置

- [ ] 实现 XDG 配置路径、首次默认配置和示例配置。
- [ ] 实现临时文件写入、同步、原子替换。
- [ ] 实现 `config.get`、`config.validate`、`config.update`。
- [ ] 配置更新失败时保留旧文件、旧内存配置和旧视觉状态。
- [ ] 应用成功配置时从当前视觉状态平滑切换。
- [ ] 为 schema 版本保留显式迁移入口，但 v1 不实现猜测性的迁移。

### 8.2 服务

- [ ] 添加 systemd 用户 unit。
- [ ] CLI 添加服务状态、启动、停止、启用和禁用命令。
- [ ] 正确处理 asusd 尚未启动或晚于 daemon 出现的情况。
- [ ] 为退出恢复设置严格超时。
- [ ] 日志只写 stdout/stderr，确认可通过 journald 查询。

### 8.3 验收门槛

- systemd 用户服务可启用、启动、停止、重启，但安装包不会擅自为用户启用。
- daemon 或 asusd 的不同启动顺序不影响最终设备发现。
- 配置保存中模拟失败不会损坏旧配置。
- 重启 daemon 后配置和基础主题保持一致。
- 完成 P5 后发布 headless beta，至少进行一周日常使用观察；期间重点记录崩溃、恢复失败、写入频率和日志量。

## 9. P6：实现 Desktop 薄客户端

目标：只为已经稳定的 daemon 能力提供 GTK4/libadwaita 界面，不在 UI 复制业务逻辑。

### 9.1 实现顺序

1. 创建 `apps/desktop`，完成连接状态、断线重连和只读概览。
2. 实现设备页和 diagnostics 展示。
3. 实现状态主题编辑、客户端表单校验和 daemon 端最终校验。
4. 实现 `preview.start/update/stop` 与 TTL 自动恢复。
5. 实现配置提交、失败提示和恢复默认值。
6. 实现 systemd 服务状态和显式启停。
7. 最后实现集成页的检测和安装预览；真正写入外部 Hook 配置放到 P7。

MobX store 只保存 UI 与 RPC 状态。颜色插值、租约、配置落盘、D-Bus 和服务真相仍属于 daemon。

### 9.2 验收门槛

- 断开 Desktop 不会影响 daemon 和现有灯效。
- Desktop 不直接访问 D-Bus、不直接编辑 YAML。
- 快速拖动颜色选择器只更新预览目标，不从 UI 发送逐帧动画。
- Desktop 崩溃或断开后，预览租约到期并恢复原状态。
- daemon 拒绝配置时，界面保留用户输入并显示具体字段错误。
- UI 不按 Aura/Slash 写死页面；只根据每台设备声明的通用能力展示控制项。

## 10. P7：逐个接入 Agent

目标：先建立一个经过真实使用验证的适配模式，再扩展到其他 Agent。

### 10.1 Codex

- [ ] 用 P0 保存的真实 fixtures 实现原始输入解析和事件映射。
- [ ] session ID 缺失时采用明确的降级策略，不生成永久租约。
- [ ] 适配命令只依赖 protocol 和 CLI 发送层。
- [ ] 安装前展示目标文件、旧内容和 diff，用户确认后才写入。
- [ ] 支持检测、安装、升级和移除。
- [ ] 进行多会话、授权、成功、失败和异常终止的真实试用。

Codex 连续稳定使用后，再把安装和 fixture 测试模式复用于 Claude Code 与 OpenCode。

### 10.2 Claude Code 与 OpenCode

- [ ] 分别维护原始 schema、映射、fixtures 和安装模板。
- [ ] 不为了统一而抹平三者真实生命周期差异。
- [ ] 对不可观测状态在 UI 和文档中展示降级说明。
- [ ] 验证三个来源同时活动时仍使用相同的 daemon 仲裁规则。

### 10.3 验收门槛

- Hook 在 daemon 未启动时快速失败且不阻塞 Agent。
- Agent 正常结束能释放持续租约。
- Agent 异常退出产生的陈旧租约能按 TTL 回收。
- 安装与移除操作可重复执行，不重复插入配置、不破坏无关用户配置。
- 每个适配器的 fixtures 覆盖其支持的全部真实事件类型。

## 11. P8：打包、发布候选与公开发布

目标：证明用户从安装到卸载的完整路径，而不只是证明源码环境可运行。

### 11.1 任务

- [ ] 生成 Linux staging root、可执行入口、systemd unit、desktop entry、图标和许可证。
- [ ] 固定并验证 Node.js runtime 与 `node-gtk` ABI。
- [ ] 生成可复现的 x86_64 `tar.zst` 和 SHA-256。
- [ ] 编写 `agent-glow-bin` 的 `PKGBUILD` 与 `.SRCINFO`。
- [ ] 建立版本一致性、干净工作区、测试、构建、smoke 和标签门禁。
- [ ] 在干净环境执行安装、首次启动、升级、停止、卸载和残留检查。
- [ ] 完成 GU405AR 十项硬件验收。
- [ ] 编写支持矩阵、已知限制、故障排查和恢复说明。

### 11.2 发布顺序

1. `0.1.0-rc.1`：只给开发机和少量明确设备测试。
2. 修复阻断问题；新增问题必须带回归测试或可重复硬件步骤。
3. `0.1.0`：发布 GitHub Release 和 AUR 二进制包。
4. 发布后观察崩溃、asusd 重连、恢复失败和安装问题，再决定后续设备范围。

### 11.3 首版发布门槛

除技术规划中的“首版完成标准”外，还必须满足：

- 在源码开发环境和发布包环境分别完成 smoke test。
- 自动测试不依赖真实硬件，硬件测试必须显式启用。
- 没有 root daemon、直接 HID 写入或硬编码设备对象路径。
- 安装、升级和卸载不会隐式修改用户 Agent 配置。
- 停止或卸载前有明确的设备恢复行为。

## 12. 任务切分规则

每个开发任务应控制在一个可独立评审的目标内，描述必须包含：

```text
目标：要产生什么用户可见或架构可见结果
范围：本任务会修改哪些 workspace
非目标：明确不顺手实现什么
依赖：必须先完成的任务或外部条件
验证：自动命令和必要的人工/硬件步骤
```

建议单个变更满足：

- 只跨越完成该纵向切片所必需的 workspace。
- 新行为先有 fake/fixture 测试，再接真实外部系统。
- 硬件行为同时提供无硬件测试替身。
- 公开 schema、配置和 CLI 变更在同一变更中更新文档。
- 发现新需求时进入 backlog，不扩张当前任务的验收范围。

## 13. 首批可直接创建的任务

按依赖顺序，项目启动时先创建以下任务：

1. **P0-01：冻结许可证选择**
   产物：许可证文件和决策记录。
2. **P0-02：采集 asusd D-Bus 能力**
   产物：只读枚举探针、脱敏 fixture 和能力文档。
3. **P0-03：验证安全硬件读写与恢复**
   依赖 P0-02；产物：显式运行的硬件探针和恢复记录。
4. **P0-04：验证 Node.js 24 + GTK4/libadwaita**
   产物：最小窗口探针和运行环境记录。
5. **P0-05：核对三个 Agent 的真实 Hook 契约**
   产物：事件矩阵、脱敏 fixtures 和降级说明。
6. **P0-06：决定发布 runtime 策略**
   依赖 P0-04；产物：runtime/ABI 决策记录。
7. **P1-01：初始化 Yarn monorepo 与 TypeScript**。
8. **P1-02：建立 test/typecheck/lint/format/build/smoke 门禁**。
9. **P2-01：定义协议 v1 与外部输入限制**。
10. **P2-02：实现 fake backend 和最小 backend 接口**。
11. **P2-03：实现租约与静态状态仲裁**。
12. **P2-04：实现安全 Unix Socket JSON-RPC daemon**。
13. **P2-05：实现 CLI 并完成无硬件端到端测试**。

这些任务完成前，不创建 Desktop 页面、Agent 安装器或发布脚本。

## 14. 项目进度判定

项目状态只按验收结果判断，不按“代码完成百分比”判断：

| 状态 | 定义 |
| --- | --- |
| 未开始 | 依赖未满足或没有可运行产物 |
| 进行中 | 已有实现，但阶段验收尚未全部通过 |
| 已完成 | 自动验证、必要硬件验证和文档均完成 |
| 阻塞 | 外部接口、硬件或关键依赖无法满足已确认方案 |

每个阶段结束时记录：

- 通过的自动测试和硬件场景；
- 未解决但不阻断下一阶段的问题；
- 新发现的外部约束；
- 是否需要修改技术规划；
- 下一阶段第一个最小任务。

这样可以确保项目从空仓库开始，每一步都有真实可运行成果，并且任何阶段出现技术风险时，都能在投入 Desktop、三套适配器和发布工程之前及时调整。
