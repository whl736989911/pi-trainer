# 为 Pi Trainer 贡献

感谢你参与 Pi Trainer。

本项目的目标是构建一个专用 Skill 训练 Agent：通过自然对话整理业务知识，生成合理、完整、可追溯的数据、规则、公式、步骤和决策文档，并通过飞书/Lark 或终端持续使用。

## 开发原则

1. **文档质量优先。** 基础设施必须服务于真实业务知识的提取、确认、编译和验证。
2. **保持薄 Fork。** Lark 和 Skill Trainer 对用户是内置能力，内部仍应保持独立模块边界。
3. **避免无必要的核心修改。** 优先使用 SDK、内置 Extensions、ResourceLoader 和 Session 事件。
4. **保持数据可追溯。** 模型候选、用户数据、文档数据和工具结果必须可区分。
5. **不伪造验证。** Agent 不能自行确认业务文档、模型回放或边界案例正确。
6. **保持闭世界回放。** 正式回放不能访问训练历史、全局知识或未声明工具。
7. **保护兼容性。** 修改上游核心行为时必须说明 Windows、Linux、现有配置、Session 和扩展兼容性影响。

详细编码规则见 [AGENTS.md](AGENTS.md)。

## 代码结构

核心定制代码位于：

```text
packages/coding-agent/src/capabilities/
├── lark/
└── skill-trainer/
```

除非第一等产品行为确实需要，不要把 Capability 逻辑散落到 Pi core、TUI 或模型提供商代码中。

## 提交 Issue

请包含：

- 问题或需求的简短说明；
- 为什么它影响 Pi Trainer；
- 最小复现步骤或真实训练案例；
- 操作系统、Node.js 版本和相关配置；
- 期望结果与实际结果；
- 已删除凭据和个人数据的日志。

安全问题不要提交公开 Issue，请按照 [SECURITY.md](SECURITY.md) 私下报告。

## 提交 Pull Request

提交前：

```bash
npm install --ignore-scripts
npm run hydrate:model-data
npm run check
npm run build:offline
```

按修改范围运行相关测试。涉及 Lark 或 Skill Trainer 时，至少运行：

```bash
cd packages/coding-agent
npx vitest --run test/lark-built-in.test.ts test/skill-trainer-compiler.test.ts
```

Pull Request 应说明：

- 修改目标；
- 设计和取舍；
- 影响的步骤、决策、数据、工具或 Session；
- 执行过的命令和结果；
- 未通过测试及其分类；
- 数据迁移、回滚和安全影响。

## 测试结果规则

请分别记录 Windows 和 Linux 结果。完整上游测试集可能包含平台特定假设，例如：

- `/bin/bash`；
- Unix 符号链接权限；
- Unix 路径格式；
- 文件权限错误码差异。

不能只写“测试通过”或“测试失败”。必须区分：

- 本项目新增回归；
- 上游既有失败；
- 环境或权限限制；
- 未执行测试。

## 训练相关修改

修改 Skill Trainer 时，应验证：

- 用户修正是否更新底层结构，而不是只修改最终文本；
- 模型先验是否单独记录并等待确认；
- 数据是否包含来源、范围、条件、例外和缺失处理；
- 编译产物是否遵循 `SKILL.md → STEPS.md → 当前操作引用文档` 的渐进式披露结构；
- 正式回放是否只加载 Skill、本次输入和声明工具；
- 回放和边界测试是否等待用户审核。

## Lark 相关修改

修改 Lark Capability 时，应验证：

- 白名单和群聊策略；
- WebSocket 重连与进程退出；
- 持久 Session 路由；
- CardKit 流式更新；
- OAuth Token 和配置加密；
- 图片、文件和富文本输入边界；
- Windows/Linux 服务行为；
- 日志中不包含 App Secret、Token 或用户文件内容。

## 提交规范

使用简洁的 Conventional Commit 风格，例如：

```text
feat(skill-trainer): add formula closure validation
fix(lark): preserve route session after restart
docs: rewrite Pi Trainer setup guide
test(replay): reject undeclared tools
```

不要在没有必要时重写上游历史或大范围格式化无关文件。

## 许可证

提交代码即表示你有权在本项目 MIT 许可证下提供该贡献。保留上游许可证、版权声明和必要归属。
