import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contentHash, trainingDefinitionHash } from "./fingerprint.ts";
import type { SkillDataDraft, TrainingState } from "./types.ts";

export interface ClosureReport {
	valid: boolean;
	blockers: string[];
	warnings: string[];
}
export interface CompileResult {
	path: string;
	files: string[];
	closure: ClosureReport;
	stateHash: string;
	artifactHash: string;
}

export function validateClosure(state: TrainingState): ClosureReport {
	const blockers: string[] = [];
	const warnings: string[] = [];
	if (!state.goal) blockers.push("尚未定义技能目标、输入和输出");
	else {
		if (!state.goal.inputs.length) blockers.push("技能输入为空");
		if (!state.goal.outputs.length) blockers.push("技能输出为空");
	}
	if (!state.cases.some((item) => item.accepted === true && item.acceptanceEvidence))
		blockers.push("没有带用户确认凭证的真实案例");
	const activeSteps = state.steps.filter((item) => item.status !== "removed");
	const activeDecisions = state.decisions.filter((item) => item.status !== "removed");
	const activeData = state.data.filter((item) => !["rejected", "replaced"].includes(item.status));
	if (activeSteps.length === 0) blockers.push("没有可执行步骤");
	for (const step of activeSteps) {
		if (!step.name || !step.instruction || step.doneWhen.length === 0 || !step.onFailure)
			blockers.push(`${step.id} 缺少指令、完成条件或失败处理`);
		if (!["confirmed", "modified"].includes(step.status)) blockers.push(`${step.id} 尚未确认`);
	}
	for (const decision of activeDecisions) {
		if (!decision.question || decision.branches.length < 2) blockers.push(`${decision.id} 缺少明确问题或完整分支`);
		if (decision.branches.some((branch) => !branch.when || !branch.outcome || /视情况|合适|酌情/.test(branch.when)))
			blockers.push(`${decision.id} 包含模糊或空分支`);
		if (!["confirmed", "modified"].includes(decision.status)) blockers.push(`${decision.id} 尚未确认`);
	}
	const unresolved = activeData.filter((item) => ["model_prior", "model_candidate", "pending"].includes(item.status));
	if (unresolved.length)
		blockers.push(
			`仍有 ${unresolved.length} 项模型候选或待确认数据：${unresolved.map((item) => item.id).join(", ")}`,
		);
	for (const data of activeData) {
		if (data.type === "formula") {
			const issue = validateFormulaValue(data.value);
			if (issue) blockers.push(`${data.id} 公式定义不完整：${issue}`);
		}
		if (["user_confirmed", "source_confirmed", "user_provided", "conditional", "case_only"].includes(data.status)) {
			if (["user_confirmed", "conditional", "case_only"].includes(data.status) && !data.confirmationEvidence)
				blockers.push(`${data.id} 缺少用户确认凭证`);
			if (data.status === "conditional" && data.conditions.length === 0)
				blockers.push(`${data.id} 标记为条件数据但没有适用条件`);
			if (!data.sourceType) blockers.push(`${data.id} 缺少数据来源`);
			if (data.usedIn.length === 0) warnings.push(`${data.id} 没有被任何步骤或决策引用`);
		}
	}
	const allItems = [...activeSteps, ...activeDecisions, ...activeData, ...state.tools];
	const knownIds = new Set(allItems.map((item) => item.id));
	if (knownIds.size !== allItems.length) blockers.push("步骤、决策、数据或工具中存在重复 ID");
	const stepIds = new Set(activeSteps.map((item) => item.id));
	const toolIds = new Set(state.tools.map((item) => item.id));
	const dataById = new Map(activeData.map((item) => [item.id, item]));
	const orders = activeSteps.map((item) => item.order);
	if (new Set(orders).size !== orders.length) blockers.push("执行步骤存在重复 order");
	for (const step of activeSteps)
		for (const ref of step.toolRefs) if (!toolIds.has(ref)) blockers.push(`${step.id} 引用了不存在的工具 ${ref}`);
	for (const data of activeData)
		for (const ref of data.usedIn) if (!knownIds.has(ref)) blockers.push(`${data.id} 引用了不存在的对象 ${ref}`);
	for (const decision of activeDecisions) {
		if (!stepIds.has(decision.stepId)) blockers.push(`${decision.id} 引用了不存在的步骤 ${decision.stepId}`);
		for (const ref of decision.dataRefs) {
			if (!dataById.has(ref)) blockers.push(`${decision.id} 引用了不存在的数据 ${ref}`);
			else if (dataById.get(ref)?.status === "case_only")
				blockers.push(`${decision.id} 的正式决策引用了仅案例数据 ${ref}`);
		}
	}
	const builtInOrReplayTools = new Set(["skill_read", "skill_list", "skill_find"]);
	const unsafeBuiltIns = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
	for (const tool of state.tools.filter((item) => item.formalSkillRequired)) {
		if (!tool.version) warnings.push(`${tool.id} 未固定版本`);
		if (!tool.install || Object.keys(tool.install).length === 0) blockers.push(`${tool.id} 缺少安装命令`);
		if (tool.install && !["user_approved", "verified"].includes(tool.installApproval ?? "candidate"))
			blockers.push(`${tool.id} 安装命令尚未获得用户批准`);
		if (tool.install && !tool.installSource) blockers.push(`${tool.id} 安装命令缺少来源`);
		if (!tool.successCheck) blockers.push(`${tool.id} 缺少安装验证命令`);
		if (!tool.failureHandling) blockers.push(`${tool.id} 缺少失败处理`);
		if (!builtInOrReplayTools.has(tool.name) && !tool.inputSchemaHash)
			blockers.push(`${tool.id} 缺少输入 Schema 哈希`);
		if (unsafeBuiltIns.has(tool.name))
			blockers.push(`${tool.id} 使用了不受限内置工具 ${tool.name}；正式回放应改用受限技能工具`);
		if (!builtInOrReplayTools.has(tool.name) && !unsafeBuiltIns.has(tool.name)) {
			if (!tool.providerExtensionPath) blockers.push(`${tool.id} 缺少工具提供者扩展路径`);
			if (!["user_approved", "verified"].includes(tool.providerApproval ?? "candidate"))
				blockers.push(`${tool.id} 工具提供者扩展尚未获得用户批准`);
		}
	}
	return { valid: blockers.length === 0, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] };
}

export async function compileSkill(state: TrainingState, root: string, allowDraft = false): Promise<CompileResult> {
	const closure = validateClosure(state);
	if (!closure.valid && !allowDraft) throw new Error(`技能数据闭包检查失败：\n- ${closure.blockers.join("\n- ")}`);
	const key = sanitize(state.goal?.skillKey || state.goal?.skillName || state.id);
	const target = resolve(root, key);
	const staging = resolve(root, `.tmp-${key}-${randomUUID()}`);
	const files = new Map<string, string>();
	files.set("SKILL.md", skillMd(state, closure));
	files.set("SETUP.md", setupMd(state));
	files.set("TOOLS.md", toolsMd(state));
	files.set(
		"DATA.md",
		catalogMd(
			"数据文档",
			state.data.filter((item) => ["fact", "parameter", "term", "example"].includes(item.type)),
		),
	);
	files.set(
		"RULES.md",
		catalogMd(
			"规则文档",
			state.data.filter((item) => ["rule", "constraint"].includes(item.type)),
		),
	);
	files.set("FORMULAS.md", formulasMd(state));
	files.set("STEPS.md", stepsMd(state));
	files.set("DECISIONS.md", decisionsMd(state));
	files.set("EXAMPLES.md", examplesMd(state));
	files.set("TESTS.md", testsMd(state));
	for (const [topic, items] of groupBy(
		state.data.filter((item) => !["rejected", "replaced", "case_only"].includes(item.status)),
		(item) => item.topic || "general",
	)) {
		files.set(`data/${sanitize(topic)}.md`, dataMd(topic, items));
	}
	files.set("scripts/setup.ps1", setupPs1(state));
	files.set("scripts/setup.sh", setupSh(state));
	files.set("scripts/validate.ps1", validatePs1(state));
	files.set("scripts/validate.sh", validateSh(state));
	files.set(
		"tools.lock.json",
		`${JSON.stringify({ version: 1, tools: state.tools.filter((tool) => tool.formalSkillRequired).map((tool) => ({ name: tool.name, version: tool.version, provider: tool.provider, providerExtensionPath: tool.providerExtensionPath, providerApproval: tool.providerApproval, inputSchemaHash: tool.inputSchemaHash, required: true, install: tool.install, successCheck: tool.successCheck })) }, null, 2)}\n`,
	);
	const stateHash = trainingDefinitionHash(state);
	const artifactHash = contentHash([...files.entries()].map(([path, content]) => `${path}\0${content}`).join("\0"));
	files.set(
		"manifest.json",
		`${JSON.stringify({ version: 1, skillKey: key, stateHash, artifactHash, closure, generatedAt: new Date().toISOString(), files: [...files.keys(), "manifest.json"] }, null, 2)}\n`,
	);
	await rm(staging, { recursive: true, force: true });
	try {
		for (const [relative, content] of files) await atomicWrite(resolve(staging, relative), content);
		await replaceDirectory(staging, target);
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return { path: target, files: [...files.keys()], closure, stateHash, artifactHash };
}

function skillMd(state: TrainingState, closure: ClosureReport): string {
	const goal = state.goal;
	const name = sanitize(goal?.skillKey || goal?.skillName || "skill");
	const description = (goal?.problem || `执行 ${goal?.skillName ?? "技能"}`).slice(0, 1024);
	const allowedTools = state.tools
		.filter((tool) => tool.formalSkillRequired)
		.map((tool) => tool.name)
		.join(" ");
	return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}${allowedTools ? `\nallowed-tools: ${allowedTools}` : ""}\n---\n\n# ${goal?.skillName ?? "未命名技能"}\n\n## 目标\n${goal?.problem ?? ""}\n\n## 输入\n${list(goal?.inputs ?? [])}\n\n## 输出\n${list(goal?.outputs ?? [])}\n\n## 执行合同\n1. 首次运行先阅读并执行 SETUP.md。\n2. 执行前阅读 DATA.md、RULES.md 和 FORMULAS.md，再严格按照 STEPS.md 执行，并按 DECISIONS.md 处理分支和异常。\n3. 只能使用当前任务输入、上述五类文档、data/*.md 以及 TOOLS.md 规定工具的本次结果。\n4. 不得使用模型先验、行业常识或训练对话补充业务数据。\n5. 所需数据缺失时，按照文档请求补充、标记缺失或停止对应步骤。\n6. 不得为了产生完整输出而编造事实、数值、公式或规则。\n\n## 数据闭包状态\n- 编译时有效：${closure.valid ? "是" : "否（草稿）"}\n- 阻塞项：${closure.blockers.length}\n- 警告：${closure.warnings.length}\n`;
}

function setupMd(state: TrainingState): string {
	const required = state.tools.filter((item) => item.formalSkillRequired);
	return `# 环境与依赖安装\n\n## 执行顺序\n1. 检查操作系统和运行时。\n2. 检查下列工具版本。\n3. 运行对应安装命令。\n4. 执行验证命令，全部成功后才能执行任务。\n5. 安装或验证失败时按 TOOLS.md 停止或恢复，不得使用未记录替代工具。\n\n## 必需工具\n${required.map((tool) => `### ${tool.id} ${tool.name}\n- 版本：${tool.version ?? "未固定"}\n- Windows：${tool.install?.windows ?? "未定义"}\n- Linux：${tool.install?.linux ?? "未定义"}\n- 验证：\`${tool.successCheck ?? "未定义"}\``).join("\n\n") || "无外部工具。"}\n\n## 自动安装脚本\n- Windows：\`scripts/setup.ps1\`\n- Linux：\`scripts/setup.sh\`\n- 安装后验证：\`scripts/validate.ps1\`\n`;
}

function toolsMd(state: TrainingState): string {
	return `# 工具与依赖\n\n${state.tools.map((tool) => `## ${tool.id}：${tool.name}\n- 用途：${tool.purpose ?? ""}\n- 版本：${tool.version ?? "未固定"}\n- 正式技能必需：${tool.formalSkillRequired ? "是" : "否"}\n- 使用步骤：${tool.stepId ?? ""}\n- 输入：${tool.inputSummary ?? ""}\n- 输出：${tool.outputSummary ?? ""}\n- 安装：${JSON.stringify(tool.install ?? {})}\n- 验证：\`${tool.successCheck ?? ""}\`\n- 失败处理：${tool.failureHandling ?? ""}\n`).join("\n") || "未记录工具。"}`;
}
function stepsMd(state: TrainingState): string {
	return `# 执行步骤\n\n${state.steps
		.filter((item) => item.status !== "removed")
		.sort((a, b) => a.order - b.order)
		.map(
			(s) =>
				`## ${s.id}：${s.name}\n- 目标：${s.goal}\n- 输入：${s.inputs.join("；")}\n- 动作：${s.instruction}\n- 工具：${s.toolRefs.join("、") || "无"}\n- 输出：${s.outputs.join("；")}\n- 完成条件：${s.doneWhen.join("；")}\n- 失败处理：${s.onFailure}\n`,
		)
		.join("\n")}`;
}
function decisionsMd(state: TrainingState): string {
	return `# 决策与异常\n\n${state.decisions
		.filter((item) => item.status !== "removed")
		.map(
			(d) =>
				`## ${d.id}：${d.question}\n- 所属步骤：${d.stepId}\n${d.branches.map((b) => `- 如果 ${b.when}，则 ${b.outcome}`).join("\n")}\n- 数据引用：${d.dataRefs.join("、") || "无"}\n`,
		)
		.join("\n")}`;
}
function catalogMd(title: string, items: SkillDataDraft[]): string {
	const sections = items
		.filter((item) => !["rejected", "replaced", "case_only"].includes(item.status))
		.map((item) => dataSection(item));
	return `# ${title}\n\n${sections.join("\n") || "当前技能没有此类已确认内容。"}`;
}

function formulasMd(state: TrainingState): string {
	const sections = state.data
		.filter((item) => item.type === "formula" && !["rejected", "replaced", "case_only"].includes(item.status))
		.map((item) => {
			const formula = formulaValue(item.value);
			if (!formula) return dataSection(item);
			const variables = formula.variables
				.map(
					(variable) =>
						`  - \`${variable.symbol}\`：${variable.meaning}；单位：${variable.unit}；来源：${variable.source}`,
				)
				.join("\n");
			return `## ${item.id}：${item.name}\n- 表达式：\`${formula.expression}\`\n- 变量：\n${variables}\n- 结果单位：${formula.resultUnit}\n- 精度：${formula.precision}\n- 舍入：${formula.rounding}\n- 来源：${item.sourceType}${item.sourceDetail ? `；${item.sourceDetail}` : ""}\n- 适用范围：${item.scope ?? "未限定"}\n- 条件：${item.conditions.join("；") || "无"}\n- 例外：${item.exceptions.join("；") || "无"}\n- 缺失处理：${item.onMissing ?? "报告缺失并停止相关步骤"}\n- 使用位置：${item.usedIn.join("、") || "无"}\n`;
		});
	return `# 公式文档\n\n${sections.join("\n") || "当前技能没有公式。"}`;
}

function dataSection(item: SkillDataDraft): string {
	return `## ${item.id}：${item.name}\n- 类型：${item.type}\n- 值：${format(item.value)}${item.unit ? ` ${item.unit}` : ""}\n- 来源：${item.sourceType}${item.sourceDetail ? `；${item.sourceDetail}` : ""}\n- 适用范围：${item.scope ?? "未限定"}\n- 条件：${item.conditions.join("；") || "无"}\n- 例外：${item.exceptions.join("；") || "无"}\n- 缺失处理：${item.onMissing ?? "报告缺失并停止相关步骤"}\n- 使用位置：${item.usedIn.join("、") || "无"}\n`;
}

function dataMd(topic: string, items: SkillDataDraft[]): string {
	return `# ${topic}\n\n${items.map((item) => dataSection(item)).join("\n")}`;
}
function examplesMd(state: TrainingState): string {
	return `# 已确认案例\n\n${state.cases.map((c) => `## ${c.id}：${c.name}\n- 输入：${format(c.input)}\n- 结果：${format(c.result)}\n- 用户认可：${c.accepted ? "是" : "否/未确认"}\n- 说明：${c.notes ?? ""}\n`).join("\n")}`;
}
function testsMd(state: TrainingState): string {
	return `# 回放与边界测试\n\n${state.tests.map((t) => `## ${t.id}：${t.name}\n- 类型：${t.type}\n- 输入：${format(t.input)}\n- 检查：${t.expectedChecks.join("；")}\n- 状态：${t.status}\n- 实际结果：${t.actualResult ?? ""}\n- 用户意见：${t.userComment ?? ""}\n`).join("\n") || "尚无测试。"}`;
}
function setupPs1(state: TrainingState): string {
	return `$ErrorActionPreference = 'Stop'\n${state.tools
		.filter((t) => t.formalSkillRequired && t.install?.windows)
		.map((t) => `# ${t.id} ${t.name}\n${t.install!.windows}`)
		.join("\n")}\nWrite-Host 'Installation commands completed. Run validate.ps1.'\n`;
}
function setupSh(state: TrainingState): string {
	return `#!/usr/bin/env bash\nset -euo pipefail\n${state.tools
		.filter((t) => t.formalSkillRequired && t.install?.linux)
		.map((t) => `# ${t.id} ${t.name}\n${t.install!.linux}`)
		.join("\n")}\necho 'Installation commands completed. Run validation.'\n`;
}
function validatePs1(state: TrainingState): string {
	return `$ErrorActionPreference = 'Stop'\n${state.tools
		.filter((t) => t.formalSkillRequired && t.successCheck)
		.map(
			(t) =>
				`# ${t.id} ${t.name}\n& { ${t.successCheck} }\nif ($LASTEXITCODE -ne 0) { throw '${t.id} validation failed' }`,
		)
		.join("\n")}\nWrite-Host 'All documented tool checks passed.'\n`;
}
function validateSh(state: TrainingState): string {
	return `#!/usr/bin/env bash\nset -euo pipefail\n${state.tools
		.filter((t) => t.formalSkillRequired && t.successCheck)
		.map((t) => `# ${t.id} ${t.name}\n${t.successCheck}`)
		.join("\n")}\necho 'All documented tool checks passed.'\n`;
}
interface FormulaVariable {
	symbol: string;
	meaning: string;
	unit: string;
	source: string;
}

interface FormulaValue {
	expression: string;
	variables: FormulaVariable[];
	resultUnit: string;
	precision: string;
	rounding: string;
}

function validateFormulaValue(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "值必须是结构化公式对象";
	const formula = value as Record<string, unknown>;
	for (const field of ["expression", "resultUnit", "precision", "rounding"] as const) {
		if (typeof formula[field] !== "string" || !formula[field].trim()) return `缺少 ${field}`;
	}
	if (!Array.isArray(formula.variables) || formula.variables.length === 0) return "缺少 variables";
	for (const variable of formula.variables) {
		if (!variable || typeof variable !== "object" || Array.isArray(variable)) return "variables 包含无效项";
		const item = variable as Record<string, unknown>;
		for (const field of ["symbol", "meaning", "unit", "source"] as const) {
			if (typeof item[field] !== "string" || !item[field].trim()) return `变量缺少 ${field}`;
		}
	}
	return undefined;
}

function formulaValue(value: unknown): FormulaValue | undefined {
	if (validateFormulaValue(value)) return undefined;
	return value as FormulaValue;
}

function list(items: string[]): string {
	return items.length ? items.map((x) => `- ${x}`).join("\n") : "- 未定义";
}
function format(value: unknown): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : `\`${JSON.stringify(value)}\``;
}
function sanitize(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fff._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "skill"
	);
}
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		const list = out.get(k) ?? [];
		list.push(item);
		out.set(k, list);
	}
	return out;
}
async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temp, `${content.trim()}\n`, "utf8");
	await rename(temp, path);
}
async function replaceDirectory(staging: string, target: string): Promise<void> {
	const backup = `${target}.backup-${randomUUID()}`;
	await mkdir(dirname(target), { recursive: true });
	let movedOld = false;
	try {
		if (existsSync(target)) {
			await rename(target, backup);
			movedOld = true;
		}
		await rename(staging, target);
		if (movedOld) await rm(backup, { recursive: true, force: true });
	} catch (error) {
		if (!existsSync(target) && movedOld && existsSync(backup)) await rename(backup, target).catch(() => undefined);
		throw error;
	}
}
