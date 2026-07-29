# Pi Trainer

面向真实业务知识沉淀的专用 Skill 训练 Agent。

Pi Trainer 通过自然对话提取、澄清、修正并确认业务知识，最终生成可追溯、自包含的 Skill。项目内置飞书/Lark 通信网关和 Skill Trainer，不需要再单独安装 `pi-lark` 或 `pi-skill-trainer`。

> 当前处于开发阶段。源码构建、飞书持久会话、流式卡片和训练消息归档已经验证；正式发行包、完整跨平台服务安装器和真实业务文档质量验收仍在推进。

## 核心能力

### 对话式 Skill 训练

- 从自然语言、真实案例、文件和用户修正中提取知识。
- 分离用户数据、文档数据、工具结果与模型候选。
- 记录修正前后内容、原因、影响对象和确认凭证。
- 维护输入 → 步骤 → 数据/工具 → 决策 → 输出的引用链。
- 检查来源、范围、条件、例外、缺失处理和工具依赖。

### 五类业务文档

编译后的 Skill 明确生成：

- `DATA.md`：事实、参数、术语和案例数据。
- `RULES.md`：业务规则和约束。
- `FORMULAS.md`：表达式、变量、单位、来源、精度与舍入。
- `STEPS.md`：可执行步骤、完成条件和失败处理。
- `DECISIONS.md`：判断问题、分支条件、结果和数据引用。

同时生成 `SKILL.md`、`SETUP.md`、`TOOLS.md`、案例、测试、数据快照、工具锁和验证脚本。

### 飞书/Lark 内置网关

- WebSocket 长连接，无需公网回调地址。
- 按聊天和话题维持稳定的持久 Session。
- CardKit 流式回复和工具执行状态。
- 图片、文件及富文本消息输入。
- 用户 OAuth 与 Token 加密存储。
- 飞书多维表格、日历、云盘搜索、消息和只读 OpenAPI 工具。
- 私聊白名单和群聊策略。

### 闭世界回放

正式回放只允许使用：

1. 编译后的 Skill 文档和本地数据；
2. 当前测试输入；
3. Skill 声明且 Schema 已锁定的工具结果。

回放 Session 不继承训练历史、全局知识、项目上下文、其他 Skills、Prompt 模板或自动发现的 Extensions。文件访问使用受目录边界保护的 `skill_read`、`skill_list` 和 `skill_find`，不会回退到不受限文件或 Shell 工具。

仅通过提示词要求 Agent 不读取外部内容、但仍保留访问权限的测试，会被标记为“逻辑回放”，不能证明 Skill 自包含。

## 项目状态

已验证：

- Monorepo TypeScript 检查与构建。
- Skill Trainer 内置加载及训练状态持久化。
- 五类文档编译和公式完整性检查。
- Lark 内置网关的真实消息入站、持久 Session、流式回复卡片和训练消息归档。
- 工具 Schema 稳定哈希、漂移拒绝和受限文件访问。
- Windows 计划任务运行内置 `pi lark serve`。

仍需完成：

- 使用真实业务案例验收五类文档是否合理、完整。
- 正式的 Windows/Linux 安装、升级、卸载和迁移脚本。
- Windows 与 Linux 独立测试基线。
- 外部工具受控代理和更严格的 Docker/沙箱验证。
- 可安装发行包与版本发布流程。

## 从源码运行

### 环境要求

- Node.js `>= 22.19.0`
- npm
- Git
- 至少一个可用的模型提供商账号或 API Key

### 安装与构建

```bash
git clone https://github.com/whl736989911/pi-trainer.git
cd pi-trainer
npm install --ignore-scripts
npm run hydrate:model-data
npm run build
```

启动终端 Agent：

```bash
node packages/coding-agent/dist/cli.js
```

开发期间也可以使用：

```bash
# Linux/macOS
./pi-test.sh

# Windows PowerShell
./pi-test.ps1
```

## 飞书/Lark 配置

先在飞书或 Lark 开放平台创建企业自建应用并取得 App ID 和 App Secret，然后运行：

```bash
node packages/coding-agent/dist/cli.js lark setup
```

前台启动网关：

```bash
node packages/coding-agent/dist/cli.js lark serve
```

查看状态：

```bash
node packages/coding-agent/dist/cli.js lark status
```

常用环境变量：

| 变量 | 用途 |
|---|---|
| `PI_LARK_APP_ID` | 应用 App ID |
| `PI_LARK_APP_SECRET` | 应用 App Secret |
| `PI_LARK_ALLOW_FROM` | 允许访问的用户 `open_id` 列表 |
| `PI_LARK_BRAND` | `feishu` 或 `lark` |
| `PI_LARK_GROUP_POLICY` | `disabled`、`mention` 或 `open` |
| `PI_LARK_WORKSPACE` | Agent 工作目录 |
| `PI_LARK_DATA_DIR` | 网关配置、Session 和媒体目录 |

配置以 AES-256-GCM 加密保存。不要提交数据目录、密钥、Token、Session 或飞书附件。

## Skill Trainer 使用方式

整个 Agent 都用于 Skill 训练，不存在独立的“普通聊天模式”。任务还不明确时，消息和文件进入全局训练知识库；知识必须经过确认并物化为 Skill 本地快照后，才能成为正式 Skill 的数据。

常用命令：

- `/training-start`：创建或继续训练状态。
- `/training-status`：查看目标、案例、结构和未确认项。
- `/knowledge-status`：查看跨 Session 训练知识。

训练完成前会依次执行：

1. 数据闭包检查；
2. Skill 编译；
3. 隔离 Session 回放；
4. 用户审核回放结果；
5. 边界案例测试；
6. 产物和环境验证。

Agent 不会自行确认业务文档或回放结果正确。

## 数据目录

默认目录：

- Skill 训练状态：`~/.pi/agent/skill-training/`
- 普通 Agent Session：`~/.pi/agent/sessions/`
- Lark 数据：Windows 为 `%LOCALAPPDATA%/pi-lark/`，Linux 为 `$XDG_DATA_HOME/pi-lark/` 或 `~/.local/share/pi-lark/`

迁移或备份时应同时保留训练状态、知识索引、Lark 加密配置、加密密钥和 Session 索引。不要公开这些文件。

## 开发

```bash
npm run check
npm run build:offline
npm test
```

当前 Windows 环境中的完整上游测试集包含依赖 `/bin/bash`、符号链接权限和 Unix 路径语义的测试。报告测试结果时必须区分平台限制、上游既有失败与本项目新增回归，不能只报告通过数量。

主要代码位置：

```text
packages/coding-agent/src/capabilities/
├── lark/
└── skill-trainer/
```

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。安全问题请遵循 [SECURITY.md](SECURITY.md)。

## 安全边界

Pi Trainer 是本地高权限 Agent。普通训练 Session 中启用的 Extensions 和工具可以访问当前用户能够访问的文件、进程、网络和凭证。只在可信工作区运行，并审查所有第三方资源。

闭世界回放提供的是训练验证边界，不代表最终部署平台自动获得同等隔离。需要更强的操作系统隔离时，请使用容器或专用沙箱。

## 上游与许可证

本项目基于 MIT 许可的 Pi Monorepo 定制，保留原项目许可证和历史。内部 `@earendil-works/*` 包名用于保持上游兼容，并不表示本项目由上游官网托管或发布。

项目仓库：https://github.com/whl736989911/pi-trainer

许可证：[MIT](LICENSE)
