# Pi Trainer Coding Agent

`packages/coding-agent` 是 Pi Trainer 的主 CLI 与 Agent 运行时。它保留上游 Pi 的终端、SDK、模型、Session 和扩展能力，并内置本项目的两项核心 Capability：

- `capabilities/skill-trainer`：对话式 Skill 训练、知识归档、闭包检查、五类文档编译和隔离回放。
- `capabilities/lark`：飞书/Lark WebSocket 网关、持久 Session、流式卡片、OAuth 和飞书工具。

完整产品说明见仓库根目录的 [README.md](../../README.md)。

## 构建

在仓库根目录运行：

```bash
npm install --ignore-scripts
npm run hydrate:model-data
npm run build
```

只构建当前包：

```bash
npm --prefix packages/coding-agent run build
```

## 运行

```bash
node packages/coding-agent/dist/cli.js
```

当前 CLI 命令名仍为 `pi`，以保持与上游配置、Session、扩展和脚本兼容。

### 飞书/Lark

```bash
node packages/coding-agent/dist/cli.js lark setup
node packages/coding-agent/dist/cli.js lark serve
node packages/coding-agent/dist/cli.js lark status
```

### Skill Trainer

Skill Trainer 是隐藏的内置 Extension，会在终端和 Lark Session 中自动加载。常用交互命令：

- `/training-start`
- `/training-status`
- `/knowledge-status`

## 内置训练工具

基础训练状态：

- `training_session`
- `training_case`
- `training_structure`
- `training_correction`
- `training_prior`
- `training_tool_record`
- `training_knowledge`

编译与验证：

- `training_compile`
- `training_test`
- `training_boundary_test`
- `training_validate`

## 编译产物

Skill Trainer 将已确认训练状态编译为自包含目录，核心文档包括：

- `DATA.md`
- `RULES.md`
- `FORMULAS.md`
- `STEPS.md`
- `DECISIONS.md`

并包含 `SKILL.md`、依赖说明、工具锁、案例、测试、主题数据和安装/验证脚本。

## 正式回放边界

正式回放不会继承：

- 训练 Session 历史；
- 全局知识库；
- `AGENTS.md` 或其他上下文文件；
- 自动发现的 Extensions、Skills、Prompt 模板和设置；
- 不受限的 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。

文件访问使用 `skill_read`、`skill_list` 和 `skill_find`，并执行真实路径边界检查。外部工具必须在编译时记录稳定 Schema 哈希，回放时发生 Schema 漂移会停止执行。

## 常用 Agent 功能

Pi Trainer 仍保留上游终端 Agent 能力：

- 交互、print、JSON 和 RPC 模式；
- 多模型提供商与 `/login`、`/model`；
- Session 恢复、分支、压缩和导出；
- TypeScript Extensions、Skills、Prompt 模板与主题；
- `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`；
- SDK `createAgentSession()` 与自定义 `ResourceLoader`。

详细技术文档位于 [`docs/`](docs/)。这些文档中的部分内容继承自上游，若与本 README 或根 README 冲突，以本项目文档和实现为准。

## 配置与数据

默认 Agent 配置目录：`~/.pi/agent/`

主要文件：

- `settings.json`：运行设置；
- `auth.json`：模型凭据；
- `sessions/`：普通 Session；
- `skill-training/`：训练状态和知识库。

Lark 数据目录独立保存，默认位于 `%LOCALAPPDATA%/pi-lark/` 或 `$XDG_DATA_HOME/pi-lark/`。

不要将凭据、加密密钥、Session、训练知识或用户附件提交到 Git。

## 开发检查

```bash
npm run check
npm --prefix packages/coding-agent test
npm --prefix packages/coding-agent run build
```

Windows 和 Linux 的完整测试结果必须分别记录。不能把缺少 `/bin/bash`、Windows 符号链接权限或路径语义差异误报为新增功能通过或失败。

## 许可证与兼容性

本包保留 `@earendil-works/pi-coding-agent` 名称，以减少对上游内部依赖、配置和生态兼容性的破坏。Pi Trainer 的产品仓库为：

https://github.com/whl736989911/pi-trainer

许可证：[MIT](../../LICENSE)
