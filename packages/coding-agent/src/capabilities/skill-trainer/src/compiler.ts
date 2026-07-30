import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contentHash, trainingDefinitionHash } from "./fingerprint.ts";
import { validateCompiledSkillSelfContainment } from "./scope-audit.ts";
import type { SkillDataDraft, SkillDecisionDraft, SkillStepDraft, ToolRecord, TrainingState } from "./types.ts";

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

interface DocumentPlan {
	dataPaths: Map<string, string>;
	decisionPaths: Map<string, string>;
}

const REPLAY_FILE_TOOLS = ["skill_read", "skill_list", "skill_find"];

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
	const finalStepOrder = Math.max(...activeSteps.map((item) => item.order), 0);
	for (const step of activeSteps) {
		if (!step.name || !step.instruction || step.doneWhen.length === 0 || !step.onFailure)
			blockers.push(`${step.id} 缺少指令、完成条件或失败处理`);
		if (!["confirmed", "modified"].includes(step.status)) blockers.push(`${step.id} 尚未确认`);
		if (step.outputExample !== undefined && step.order !== finalStepOrder)
			blockers.push(`${step.id} 不是最终交付步骤，不能包含输出示例`);
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
		if (data.type === "example" && data.usedIn.length > 0)
			blockers.push(`${data.id} 是训练案例或示例，不能作为正式技能依赖`);
		if (["user_confirmed", "source_confirmed", "user_provided", "conditional", "case_only"].includes(data.status)) {
			if (["user_confirmed", "conditional", "case_only"].includes(data.status) && !data.confirmationEvidence)
				blockers.push(`${data.id} 缺少用户确认凭证`);
			if (data.status === "conditional" && data.conditions.length === 0)
				blockers.push(`${data.id} 标记为条件数据但没有适用条件`);
			if (!data.sourceType) blockers.push(`${data.id} 缺少数据来源`);
			if (data.usedIn.length === 0 && data.type !== "example") warnings.push(`${data.id} 没有被任何步骤或决策引用`);
		}
	}
	const allItems = [...activeSteps, ...activeDecisions, ...activeData, ...state.tools];
	const knownIds = new Set(allItems.map((item) => item.id));
	if (knownIds.size !== allItems.length) blockers.push("步骤、决策、数据或工具中存在重复 ID");
	const toolNames = state.tools.map((item) => item.name);
	if (new Set(toolNames).size !== toolNames.length) blockers.push("工具名称必须唯一，步骤将按名称引用工具");
	const stepIds = new Set(activeSteps.map((item) => item.id));
	const toolIds = new Set(state.tools.map((item) => item.id));
	const dataById = new Map(activeData.map((item) => [item.id, item]));
	const orders = activeSteps.map((item) => item.order);
	if (new Set(orders).size !== orders.length) blockers.push("执行步骤存在重复 order");
	for (const step of activeSteps)
		for (const ref of step.toolRefs)
			if (!toolIds.has(ref) && !toolNames.includes(ref)) blockers.push(`${step.id} 引用了不存在的工具 ${ref}`);
	for (const data of activeData)
		for (const ref of data.usedIn) if (!knownIds.has(ref)) blockers.push(`${data.id} 引用了不存在的对象 ${ref}`);
	for (const decision of activeDecisions) {
		if (!stepIds.has(decision.stepId)) blockers.push(`${decision.id} 引用了不存在的步骤 ${decision.stepId}`);
		for (const ref of decision.dataRefs) {
			if (!dataById.has(ref)) blockers.push(`${decision.id} 引用了不存在的数据 ${ref}`);
			else if (dataById.get(ref)?.status === "case_only" || dataById.get(ref)?.type === "example")
				blockers.push(`${decision.id} 的正式决策引用了案例数据 ${ref}`);
		}
	}
	const builtInOrReplayTools = new Set(REPLAY_FILE_TOOLS);
	const unsafeBuiltIns = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
	for (const tool of state.tools.filter((item) => item.formalSkillRequired)) {
		if (!tool.version) warnings.push(`${tool.name} 未记录推荐版本`);
		if (!tool.install || Object.keys(tool.install).length === 0) blockers.push(`${tool.name} 缺少安装命令`);
		if (tool.install && !["user_approved", "verified"].includes(tool.installApproval ?? "candidate"))
			blockers.push(`${tool.name} 安装命令尚未获得用户批准`);
		if (tool.install && !tool.installSource) blockers.push(`${tool.name} 安装命令缺少来源`);
		if (!tool.successCheck) blockers.push(`${tool.name} 缺少安装验证命令`);
		if (!tool.failureHandling) blockers.push(`${tool.name} 缺少失败处理`);
		if (!builtInOrReplayTools.has(tool.name) && !tool.inputSchemaHash)
			blockers.push(`${tool.name} 缺少输入 Schema 哈希`);
		if (unsafeBuiltIns.has(tool.name)) blockers.push(`${tool.name} 使用了不受限内置工具；正式回放应改用受限技能工具`);
		if (!builtInOrReplayTools.has(tool.name) && !unsafeBuiltIns.has(tool.name)) {
			if (!tool.providerExtensionPath) blockers.push(`${tool.name} 缺少工具提供者扩展路径`);
			if (!["user_approved", "verified"].includes(tool.providerApproval ?? "candidate"))
				blockers.push(`${tool.name} 工具提供者扩展尚未获得用户批准`);
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
	const plan = createDocumentPlan(state);
	const files = new Map<string, string>();
	files.set("SKILL.md", skillMd(state, closure, plan));
	files.set("STEPS.md", stepsMd(state, plan));
	files.set("TOOLS.md", toolsMd(state));
	files.set("SETUP.md", setupMd(state));
	for (const item of runtimeData(state)) {
		const path = plan.dataPaths.get(item.id);
		if (!path) continue;
		files.set(path, item.type === "formula" ? formulaMd(item, state, plan) : dataMd(item, state, plan));
	}
	for (const decision of activeDecisions(state)) {
		const path = plan.decisionPaths.get(decision.id);
		if (path) files.set(path, decisionMd(decision, state, plan));
	}
	files.set("scripts/setup.ps1", setupPs1(state));
	files.set("scripts/setup.sh", setupSh(state));
	files.set("scripts/validate.ps1", validatePs1(state));
	files.set("scripts/validate.sh", validateSh(state));
	files.set(
		"tools.lock.json",
		`${JSON.stringify(
			{
				version: 1,
				versionPolicy: "recommended-version-with-compatible-alternatives",
				tools: state.tools
					.filter((tool) => tool.formalSkillRequired)
					.map((tool) => ({
						name: tool.name,
						recommendedVersion: tool.version,
						provider: tool.provider,
						providerExtensionPath: tool.providerExtensionPath,
						providerApproval: tool.providerApproval,
						inputSchemaHash: tool.inputSchemaHash,
						required: true,
						install: tool.install,
						successCheck: tool.successCheck,
					})),
			},
			null,
			2,
		)}\n`,
	);
	const stateHash = trainingDefinitionHash(state);
	const artifactHash = contentHash([...files.entries()].map(([path, content]) => `${path}\0${content}`).join("\0"));
	files.set(
		"manifest.json",
		`${JSON.stringify({ version: 2, skillKey: key, stateHash, artifactHash, closure, generatedAt: new Date().toISOString(), files: [...files.keys(), "manifest.json"] }, null, 2)}\n`,
	);
	await rm(staging, { recursive: true, force: true });
	try {
		for (const [relative, content] of files) await atomicWrite(resolve(staging, relative), content);
		const selfContainment = await validateCompiledSkillSelfContainment(staging);
		if (!selfContainment.valid) throw new Error(`技能自包含检查失败：\n- ${selfContainment.violations.join("\n- ")}`);
		await replaceDirectory(staging, target);
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return { path: target, files: [...files.keys()], closure, stateHash, artifactHash };
}

function createDocumentPlan(state: TrainingState): DocumentPlan {
	const usedPaths = new Set<string>();
	const dataPaths = new Map<string, string>();
	for (const item of runtimeData(state)) {
		const directory =
			item.type === "formula" ? "formulas" : ["rule", "constraint"].includes(item.type) ? "rules" : "data";
		const prefix = directory === "rules" ? `${stepFilePrefix(item, state)}-` : "";
		dataPaths.set(item.id, uniquePath(`${directory}/${prefix}${sanitize(item.name)}.md`, usedPaths));
	}
	const decisionPaths = new Map<string, string>();
	for (const decision of activeDecisions(state)) {
		const step = state.steps.find((item) => item.id === decision.stepId && item.status !== "removed");
		const prefix = step ? `step${String(step.order).padStart(2, "0")}` : "shared";
		decisionPaths.set(decision.id, uniquePath(`decisions/${prefix}-${sanitize(decision.question)}.md`, usedPaths));
	}
	return { dataPaths, decisionPaths };
}

function skillMd(state: TrainingState, closure: ClosureReport, plan: DocumentPlan): string {
	const goal = state.goal;
	const name = sanitize(goal?.skillKey || goal?.skillName || "skill");
	const description = (goal?.problem || `执行 ${goal?.skillName ?? "技能"}`).slice(0, 1024);
	const allowedTools = [
		...REPLAY_FILE_TOOLS,
		...state.tools.filter((tool) => tool.formalSkillRequired).map((tool) => tool.name),
	]
		.filter((value, index, items) => items.indexOf(value) === index)
		.join(" ");
	const businessFiles = [
		...runtimeData(state).map((item) => ({
			path: plan.dataPaths.get(item.id)!,
			description: documentDescription(item),
		})),
		...activeDecisions(state).map((item) => ({
			path: plan.decisionPaths.get(item.id)!,
			description: `决策：${item.question}`,
		})),
	].sort((a, b) => a.path.localeCompare(b.path));
	const structure = [
		"- `SKILL.md`：技能入口，说明功能、输入、输出、文件结构和阅读顺序。",
		"- `STEPS.md`：执行入口，按顺序描述步骤，并在具体操作中引用所需文档。",
		"- `TOOLS.md`：统一记录工具名称、推荐版本、输入输出、验证和失败处理。",
		"- `SETUP.md`：环境准备和工具安装说明。",
		...businessFiles.map((item) => `- \`${item.path}\`：${item.description}`),
		"- `scripts/setup.ps1`：Windows 环境安装脚本。",
		"- `scripts/setup.sh`：Linux/macOS 环境安装脚本。",
		"- `scripts/validate.ps1`：Windows 工具能力验证脚本。",
		"- `scripts/validate.sh`：Linux/macOS 工具能力验证脚本。",
		"- `tools.lock.json`：工具身份、推荐版本和输入 Schema 记录。",
		"- `manifest.json`：编译产物清单和完整性哈希。",
	].join("\n");
	return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nallowed-tools: ${allowedTools}\n---\n\n# ${goal?.skillName ?? "未命名技能"}\n\n## 技能功能\n${goal?.problem ?? ""}\n\n## 输入\n${list(goal?.inputs ?? [])}\n\n## 输出\n${list(goal?.outputs ?? [])}\n\n## 文件结构与内容\n${structure}\n\n## 阅读顺序\n下一步只读取 [STEPS.md](STEPS.md)。执行到具体步骤时，再读取该步骤操作中直接引用的规则、数据表、公式、决策和工具文档。不要预先加载全部业务文档。\n\n## 执行边界\n1. 只能使用当前任务输入、技能目录内文档和脚本，以及声明工具在本次任务中返回的结果。\n2. 不得使用模型先验、行业常识、训练对话或历史案例补充业务数据。\n3. 缺少必需数据时，按照被引用文档的缺失处理执行；不得为了完成输出而猜测。\n4. 训练案例和回放记录不属于正式技能内容。\n\n## 数据闭包状态\n- 编译时有效：${closure.valid ? "是" : "否（草稿）"}\n- 阻塞项：${closure.blockers.length}\n- 警告：${closure.warnings.length}\n`;
}

function stepsMd(state: TrainingState, plan: DocumentPlan): string {
	const steps = activeSteps(state);
	const finalOrder = Math.max(...steps.map((item) => item.order), 0);
	return `# 执行步骤\n\n按顺序执行。进入某一步后，只读取该步骤“操作”中直接引用的文档。\n\n${steps
		.map((step) => stepMd(step, state, plan, step.order === finalOrder))
		.join("\n")}`;
}

function stepMd(step: SkillStepDraft, state: TrainingState, plan: DocumentPlan, isFinal: boolean): string {
	const operations = [step.instruction];
	for (const decision of activeDecisions(state).filter((item) => item.stepId === step.id))
		operations.push(`使用 [${decision.question}](${plan.decisionPaths.get(decision.id)}) 处理本步骤的判断和分支。`);
	for (const ref of step.toolRefs) {
		const tool = state.tools.find((item) => item.id === ref || item.name === ref);
		if (tool) operations.push(`使用 [${tool.name}](TOOLS.md#${toolAnchor(tool.name)}) 执行本步骤所需的工具操作。`);
	}
	for (const item of runtimeData(state).filter((data) => data.usedIn.includes(step.id))) {
		const path = plan.dataPaths.get(item.id);
		if (!path) continue;
		if (["rule", "constraint"].includes(item.type)) operations.push(`根据 [${item.name}](${path}) 执行。`);
		else if (item.type === "formula") operations.push(`按照 [${item.name}](${path}) 计算。`);
		else operations.push(`读取 [${item.name}](${path})。`);
	}
	const outputExample =
		isFinal && step.outputExample !== undefined
			? `\n### 最终交付示例\n${formatBlock(step.outputExample)}\n\n该示例只说明最终交付形式，不得作为业务规则或数据来源。\n`
			: "";
	return `<a id="step-${String(step.order).padStart(2, "0")}"></a>\n## Step ${String(step.order).padStart(2, "0")}：${step.name}\n\n### 目标\n${step.goal}\n\n### 输入\n${list(step.inputs)}\n\n### 操作\n${operations.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n### 输出\n${list(step.outputs)}\n${outputExample}\n### 完成条件\n${list(step.doneWhen)}\n\n### 失败处理\n${step.onFailure}\n`;
}

function setupMd(state: TrainingState): string {
	const required = state.tools.filter((item) => item.formalSkillRequired);
	return `# 环境与依赖安装\n\n工具版本均为推荐版本，不要求实际版本完全一致；实际工具必须通过记录的能力验证。Schema 或关键行为不兼容时停止执行。\n\n## 执行顺序\n1. 检查操作系统和运行时。\n2. 检查 TOOLS.md 中的工具及推荐版本。\n3. 按需运行安装命令。\n4. 执行验证命令，全部成功后才能执行任务。\n5. 安装或验证失败时按 TOOLS.md 处理，不得使用未记录替代工具。\n\n## 必需工具\n${required.map((tool) => `### ${tool.name}\n- 推荐版本：${tool.version ?? "未记录"}\n- 版本策略：允许使用通过能力验证的兼容版本\n- Windows：${tool.install?.windows ?? tool.install?.command ?? "未定义"}\n- Linux：${tool.install?.linux ?? tool.install?.command ?? "未定义"}\n- 验证：\`${tool.successCheck ?? "未定义"}\``).join("\n\n") || "无外部工具。"}\n\n## 自动安装脚本\n- Windows：\`scripts/setup.ps1\`\n- Linux：\`scripts/setup.sh\`\n- 安装后验证：\`scripts/validate.ps1\` 或 \`scripts/validate.sh\`\n`;
}

function toolsMd(state: TrainingState): string {
	return `# 工具与依赖\n\n步骤按工具名称引用本文件。版本为推荐版本，其他版本通过能力验证后也可使用。\n\n${state.tools.map(toolSection).join("\n") || "未记录工具。"}`;
}

function toolSection(tool: ToolRecord): string {
	return `<a id="${toolAnchor(tool.name)}"></a>\n## ${tool.name}\n\n- 用途：${tool.purpose ?? ""}\n- 推荐版本：${tool.version ?? "未记录"}\n- 版本策略：允许使用通过能力验证的兼容版本\n- 正式技能必需：${tool.formalSkillRequired ? "是" : "否"}\n- 输入：${tool.inputSummary ?? ""}\n- 输出：${tool.outputSummary ?? ""}\n- 安装来源：${tool.installSource ?? ""}\n- 安装：${format(tool.install ?? {})}\n- 能力验证：\`${tool.successCheck ?? ""}\`\n- 输入 Schema 哈希：${tool.inputSchemaHash ?? "未记录"}\n- 失败处理：${tool.failureHandling ?? ""}\n`;
}

function dataMd(item: SkillDataDraft, state: TrainingState, plan: DocumentPlan): string {
	const title = ["rule", "constraint"].includes(item.type) ? "规则" : "数据表";
	return `# ${item.name}\n\n## ${title}内容\n${formatBlock(item.value)}\n\n## 使用约束\n- 单位：${item.unit ?? "无"}\n- 来源：${item.sourceType}${item.sourceDetail ? `；${item.sourceDetail}` : ""}\n- 适用范围：${item.scope ?? "未限定"}\n- 条件：${item.conditions.join("；") || "无"}\n- 例外：${item.exceptions.join("；") || "无"}\n- 缺失处理：${item.onMissing ?? "报告缺失并停止相关步骤"}\n- 使用位置：${usageLinks(item.usedIn, state, plan)}\n`;
}

function formulaMd(item: SkillDataDraft, state: TrainingState, plan: DocumentPlan): string {
	const formula = formulaValue(item.value);
	if (!formula) return dataMd(item, state, plan);
	return `# ${item.name}\n\n## 表达式\n\`${formula.expression}\`\n\n## 变量\n${formula.variables.map((variable) => `- \`${variable.symbol}\`：${variable.meaning}；单位：${variable.unit}；来源：${variable.source}`).join("\n")}\n\n## 计算约束\n- 结果单位：${formula.resultUnit}\n- 精度：${formula.precision}\n- 舍入：${formula.rounding}\n- 来源：${item.sourceType}${item.sourceDetail ? `；${item.sourceDetail}` : ""}\n- 适用范围：${item.scope ?? "未限定"}\n- 条件：${item.conditions.join("；") || "无"}\n- 例外：${item.exceptions.join("；") || "无"}\n- 缺失处理：${item.onMissing ?? "报告缺失并停止相关步骤"}\n- 使用位置：${usageLinks(item.usedIn, state, plan)}\n`;
}

function decisionMd(decision: SkillDecisionDraft, state: TrainingState, plan: DocumentPlan): string {
	const step = state.steps.find((item) => item.id === decision.stepId && item.status !== "removed");
	const dataLinks = decision.dataRefs
		.map((ref) => {
			const item = state.data.find((data) => data.id === ref);
			const path = plan.dataPaths.get(ref);
			return item && path ? `[${item.name}](../${path})` : undefined;
		})
		.filter((value): value is string => value !== undefined);
	return `# ${decision.question}\n\n## 所属步骤\n${step ? `[Step ${String(step.order).padStart(2, "0")}：${step.name}](../STEPS.md#step-${String(step.order).padStart(2, "0")})` : "未关联"}\n\n## 判断分支\n${decision.branches.map((branch, index) => `${index + 1}. 当 ${branch.when}：${branch.outcome}`).join("\n")}\n\n## 判断依据\n${dataLinks.length ? dataLinks.map((link) => `- ${link}`).join("\n") : "- 无额外业务文档"}\n`;
}

function usageLinks(refs: string[], state: TrainingState, plan: DocumentPlan): string {
	const links = refs.flatMap((ref) => {
		const step = state.steps.find((item) => item.id === ref && item.status !== "removed");
		if (step)
			return [
				`[Step ${String(step.order).padStart(2, "0")}：${step.name}](../STEPS.md#step-${String(step.order).padStart(2, "0")})`,
			];
		const decision = state.decisions.find((item) => item.id === ref && item.status !== "removed");
		const decisionPath = decision ? plan.decisionPaths.get(decision.id) : undefined;
		return decision && decisionPath ? [`[${decision.question}](../${decisionPath})`] : [];
	});
	return links.join("、") || "无";
}

function setupPs1(state: TrainingState): string {
	return `$ErrorActionPreference = 'Stop'\n${state.tools
		.filter((tool) => tool.formalSkillRequired && (tool.install?.windows || tool.install?.command))
		.map(
			(tool) =>
				`# ${tool.name}（推荐版本：${tool.version ?? "未记录"}）\n${tool.install?.windows ?? tool.install?.command}`,
		)
		.join("\n")}\nWrite-Host 'Installation commands completed. Run validate.ps1.'\n`;
}
function setupSh(state: TrainingState): string {
	return `#!/usr/bin/env bash\nset -euo pipefail\n${state.tools
		.filter((tool) => tool.formalSkillRequired && (tool.install?.linux || tool.install?.command))
		.map(
			(tool) =>
				`# ${tool.name} (recommended version: ${tool.version ?? "not recorded"})\n${tool.install?.linux ?? tool.install?.command}`,
		)
		.join("\n")}\necho 'Installation commands completed. Run validation.'\n`;
}
function validatePs1(state: TrainingState): string {
	return `$ErrorActionPreference = 'Stop'\n${state.tools
		.filter((tool) => tool.formalSkillRequired && tool.successCheck)
		.map(
			(tool) =>
				`# ${tool.name}\n& { ${tool.successCheck} }\nif ($LASTEXITCODE -ne 0) { throw '${escapeSingleQuote(tool.name)} validation failed' }`,
		)
		.join("\n")}\nWrite-Host 'All documented tool checks passed.'\n`;
}
function validateSh(state: TrainingState): string {
	return `#!/usr/bin/env bash\nset -euo pipefail\n${state.tools
		.filter((tool) => tool.formalSkillRequired && tool.successCheck)
		.map((tool) => `# ${tool.name}\n${tool.successCheck}`)
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
function runtimeData(state: TrainingState): SkillDataDraft[] {
	return state.data.filter(
		(item) => !["rejected", "replaced", "case_only"].includes(item.status) && item.type !== "example",
	);
}
function activeSteps(state: TrainingState): SkillStepDraft[] {
	return state.steps.filter((item) => item.status !== "removed").sort((a, b) => a.order - b.order);
}
function activeDecisions(state: TrainingState): SkillDecisionDraft[] {
	return state.decisions.filter((item) => item.status !== "removed");
}
function stepFilePrefix(item: SkillDataDraft, state: TrainingState): string {
	const decisionStepIds = state.decisions
		.filter(
			(decision) =>
				decision.status !== "removed" && (item.usedIn.includes(decision.id) || decision.dataRefs.includes(item.id)),
		)
		.map((decision) => decision.stepId);
	const orders = [
		...new Set(
			[...item.usedIn, ...decisionStepIds]
				.map((ref) => state.steps.find((step) => step.id === ref && step.status !== "removed")?.order)
				.filter((order): order is number => order !== undefined),
		),
	].sort((a, b) => a - b);
	return orders.length === 1 ? `step${String(orders[0]).padStart(2, "0")}` : "shared";
}
function documentDescription(item: SkillDataDraft): string {
	if (item.type === "formula") return `公式：${item.name}`;
	if (["rule", "constraint"].includes(item.type)) return `规则：${item.name}`;
	return `数据表：${item.name}`;
}
function uniquePath(path: string, used: Set<string>): string {
	if (!used.has(path)) {
		used.add(path);
		return path;
	}
	const extensionIndex = path.lastIndexOf(".");
	const base = extensionIndex >= 0 ? path.slice(0, extensionIndex) : path;
	const extension = extensionIndex >= 0 ? path.slice(extensionIndex) : "";
	let suffix = 2;
	while (used.has(`${base}-${suffix}${extension}`)) suffix += 1;
	const unique = `${base}-${suffix}${extension}`;
	used.add(unique);
	return unique;
}
function list(items: string[]): string {
	return items.length ? items.map((item) => `- ${item}`).join("\n") : "- 未定义";
}
function format(value: unknown): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : `\`${JSON.stringify(value)}\``;
}
function formatBlock(value: unknown): string {
	if (typeof value === "string") return value;
	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
function sanitize(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fff._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "document"
	);
}
function toolAnchor(name: string): string {
	return `tool-${sanitize(name)}`;
}
function escapeSingleQuote(value: string): string {
	return value.replaceAll("'", "''");
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
