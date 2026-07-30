import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compileSkill, validateClosure } from "../src/capabilities/skill-trainer/src/compiler.ts";
import { validateCompiledSkillSelfContainment } from "../src/capabilities/skill-trainer/src/scope-audit.ts";
import type { TrainingState } from "../src/capabilities/skill-trainer/src/types.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixture(): TrainingState {
	const now = new Date().toISOString();
	return {
		version: 1,
		id: "training",
		piSessionId: "session",
		stage: "systematizing",
		createdAt: now,
		updatedAt: now,
		goal: {
			skillName: "报价技能",
			skillKey: "pricing-skill",
			problem: "根据数量生成报价",
			inputs: ["数量"],
			outputs: ["报价"],
			roughProcess: ["计算报价"],
		},
		cases: [
			{
				id: "CASE-001",
				name: "基础报价案例不应进入正式技能",
				input: { quantity: 2, caseMarker: "TRAINING-CASE-MARKER" },
				result: { price: 20 },
				accepted: true,
				acceptanceEvidence: { source: "user_message", piSessionId: "session", entryId: "entry", confirmedAt: now },
				createdAt: now,
				updatedAt: now,
			},
		],
		steps: [
			{
				id: "STEP-001",
				order: 1,
				name: "计算并交付报价",
				goal: "生成报价",
				inputs: ["数量"],
				instruction: "校验数量并计算最终报价。",
				toolRefs: ["TOOL-001"],
				outputs: ["报价"],
				outputExample: { currency: "CNY", amount: "20.00" },
				doneWhen: ["报价已生成"],
				onFailure: "报告缺失数据",
				status: "confirmed",
			},
		],
		decisions: [
			{
				id: "DECISION-001",
				stepId: "STEP-001",
				question: "数量是否有效",
				branches: [
					{ when: "数量大于零", outcome: "继续计算" },
					{ when: "数量小于或等于零", outcome: "停止并报告输入错误" },
				],
				dataRefs: ["RULE-001"],
				status: "confirmed",
			},
		],
		data: [
			{
				id: "DATA-001",
				topic: "pricing",
				type: "parameter",
				name: "单价表",
				value: { standard: 10 },
				unit: "CNY/item",
				status: "source_confirmed",
				sourceType: "document",
				sourceDetail: "fixture",
				conditions: [],
				exceptions: [],
				onMissing: "停止计算",
				usedIn: ["STEP-001"],
			},
			{
				id: "RULE-001",
				topic: "pricing",
				type: "rule",
				name: "最低数量规则",
				value: "数量必须大于零",
				status: "source_confirmed",
				sourceType: "document",
				sourceDetail: "fixture",
				conditions: [],
				exceptions: [],
				onMissing: "停止计算",
				usedIn: ["STEP-001", "DECISION-001"],
			},
			{
				id: "FORMULA-001",
				topic: "pricing",
				type: "formula",
				name: "报价公式",
				value: {
					expression: "price = quantity * unitPrice",
					variables: [
						{ symbol: "quantity", meaning: "数量", unit: "item", source: "task input" },
						{ symbol: "unitPrice", meaning: "单价", unit: "CNY/item", source: "单价表" },
					],
					resultUnit: "CNY",
					precision: "2 decimal places",
					rounding: "half up",
				},
				status: "source_confirmed",
				sourceType: "document",
				sourceDetail: "fixture",
				conditions: [],
				exceptions: [],
				onMissing: "停止计算",
				usedIn: ["STEP-001"],
			},
		],
		corrections: [],
		tools: [
			{
				id: "TOOL-001",
				name: "报价计算器",
				version: "2.1.0",
				purpose: "执行报价计算",
				inputSummary: "数量与单价",
				outputSummary: "报价",
				formalSkillRequired: false,
				failureHandling: "停止并报告",
				createdAt: now,
			},
		],
		tests: [],
	};
}

describe("built-in skill trainer compiler", () => {
	test("emits a progressively disclosed skill with content-specific documents", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "pi-trainer-compiler-"));
		roots.push(root);
		const result = await compileSkill(fixture(), root);
		const expectedFiles = [
			"SKILL.md",
			"STEPS.md",
			"TOOLS.md",
			"data/单价表.md",
			"rules/step01-最低数量规则.md",
			"formulas/报价公式.md",
			"decisions/step01-数量是否有效.md",
		];
		for (const file of expectedFiles) expect(existsSync(resolve(result.path, file)), file).toBe(true);
		for (const removed of ["DATA.md", "RULES.md", "FORMULAS.md", "DECISIONS.md", "EXAMPLES.md", "TESTS.md"])
			expect(existsSync(resolve(result.path, removed)), removed).toBe(false);

		const skill = await readFile(resolve(result.path, "SKILL.md"), "utf8");
		expect(skill).toContain("下一步只读取 [STEPS.md](STEPS.md)");
		expect(skill).toContain("`rules/step01-最低数量规则.md`");
		expect(skill).not.toContain("TRAINING-CASE-MARKER");

		const steps = await readFile(resolve(result.path, "STEPS.md"), "utf8");
		expect(steps).toContain("使用 [数量是否有效](decisions/step01-数量是否有效.md)");
		expect(steps).toContain("使用 [报价计算器](TOOLS.md#tool-报价计算器)");
		expect(steps).toContain("根据 [最低数量规则](rules/step01-最低数量规则.md)");
		expect(steps).toContain("读取 [单价表](data/单价表.md)");
		expect(steps).toContain("按照 [报价公式](formulas/报价公式.md)");
		expect(steps).toContain("### 最终交付示例");
		expect(steps).not.toContain("TRAINING-CASE-MARKER");

		const tools = await readFile(resolve(result.path, "TOOLS.md"), "utf8");
		expect(tools).toContain("## 报价计算器");
		expect(tools).toContain("推荐版本：2.1.0");
		expect(tools).toContain("允许使用通过能力验证的兼容版本");
		expect(tools).not.toContain("TOOL-001");

		const selfContainment = await validateCompiledSkillSelfContainment(result.path);
		expect(selfContainment.valid).toBe(true);
		expect(selfContainment.reachableDocuments).toContain("STEPS.md");
	});

	test("detects document references that leave the compiled skill", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "pi-trainer-scope-"));
		roots.push(root);
		const result = await compileSkill(fixture(), root);
		await writeFile(resolve(result.path, "STEPS.md"), "# 执行步骤\n\n读取 [外部规则](../../outside.md)。\n", "utf8");
		const report = await validateCompiledSkillSelfContainment(result.path);
		expect(report.valid).toBe(false);
		expect(report.violations.some((item) => item.includes("技能目录之外"))).toBe(true);
	});

	test("blocks incomplete formula definitions", () => {
		const state = fixture();
		state.data[2].value = { expression: "price = quantity * unitPrice" };
		const closure = validateClosure(state);
		expect(closure.valid).toBe(false);
		expect(closure.blockers).toContain("FORMULA-001 公式定义不完整：缺少 resultUnit");
	});

	test("allows an output example only on the final delivery step", () => {
		const state = fixture();
		state.steps.push({
			id: "STEP-002",
			order: 2,
			name: "发送结果",
			goal: "发送报价",
			inputs: ["报价"],
			instruction: "发送最终报价。",
			toolRefs: [],
			outputs: ["交付结果"],
			doneWhen: ["用户收到结果"],
			onFailure: "报告发送失败",
			status: "confirmed",
		});
		const closure = validateClosure(state);
		expect(closure.valid).toBe(false);
		expect(closure.blockers).toContain("STEP-001 不是最终交付步骤，不能包含输出示例");
	});
});
