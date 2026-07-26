# AgentGlow

面向 Linux ROG 灯光设备的常驻灯效引擎、配置界面与 Agent 集成。

项目目前处于工程基础建设阶段。详细设计与实施顺序见：

- [技术规划](docs/technical-plan.md)
- [开发路线图](docs/development-roadmap.md)

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
```

一次执行全部检查：

```bash
yarn tiny check
```

如果系统中没有 `yarn` 命令，可以直接使用项目携带的版本：

```bash
node .yarn/releases/yarn-4.17.1.cjs tiny check
```
