import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compileSkill, validateClosure } from "../src/capabilities/skill-trainer/src/compiler.ts";
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
				name: "基础报价",
				input: { quantity: 2 },
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
				name: "计算报价",
				goal: "生成报价",
				inputs: ["数量"],
				instruction: "使用 FORMULA-001 计算报价",
				toolRefs: [],
				outputs: ["报价"],
				doneWhen: ["报价已生成"],
				onFailure: "报告缺失数据",
				status: "confirmed",
			},
		],
		decisions: [],
		data: [
			{
				id: "DATA-001",
				topic: "pricing",
				type: "parameter",
				name: "单价",
				value: 10,
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
				id: "FORMULA-001",
				topic: "pricing",
				type: "formula",
				name: "报价公式",
				value: {
					expression: "price = quantity * unitPrice",
					variables: [
						{ symbol: "quantity", meaning: "数量", unit: "item", source: "task input" },
						{ symbol: "unitPrice", meaning: "单价", unit: "CNY/item", source: "DATA-001" },
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
		tools: [],
		tests: [],
	};
}

describe("built-in skill trainer compiler", () => {
	test("emits separate data, rules, formulas, steps, and decisions documents", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "pi-trainer-compiler-"));
		roots.push(root);
		const result = await compileSkill(fixture(), root);
		for (const file of ["DATA.md", "RULES.md", "FORMULAS.md", "STEPS.md", "DECISIONS.md"]) {
			expect(existsSync(resolve(result.path, file))).toBe(true);
		}
		const formulas = await readFile(resolve(result.path, "FORMULAS.md"), "utf8");
		expect(formulas).toContain("price = quantity * unitPrice");
		expect(formulas).toContain("DATA-001");
	});

	test("blocks incomplete formula definitions", () => {
		const state = fixture();
		state.data[1].value = { expression: "price = quantity * unitPrice" };
		const closure = validateClosure(state);
		expect(closure.valid).toBe(false);
		expect(closure.blockers).toContain("FORMULA-001 公式定义不完整：缺少 resultUnit");
	});
});
