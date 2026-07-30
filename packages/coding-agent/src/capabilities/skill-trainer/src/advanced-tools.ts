import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { compileSkill, validateClosure } from "./compiler.ts";
import { proposeBoundaryCases, runReplay } from "./replay.ts";
import { errorResult, jsonResult } from "./result.ts";
import { listResponse, mutationResponse, summarizeItem, type ResponseDetail } from "./response-summary.ts";
import type { TrainingStore } from "./store.ts";
import { validateSkill } from "./validator.ts";

export function registerAdvancedTrainingTools(pi: ExtensionAPI, store: TrainingStore): void {
	pi.registerTool({
		name: "training_compile",
		label: "Compile Trained Skill",
		description:
			"执行数据闭包检查，并将训练状态编译为渐进式披露的自包含技能目录（步骤路由、按内容拆分的业务文档、工具依赖和安装/验证脚本）。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("closure"), Type.Literal("compile")]),
			allow_draft: Type.Optional(Type.Boolean({ description: "仅用于预览。正式编译必须为 false。" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const p = params as any;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				const state = await store.create(sessionId);
				if (p.action === "closure") return jsonResult(validateClosure(state));
				const result = await compileSkill(state, resolve(store.root, "artifacts"), p.allow_draft === true);
				await store.update(sessionId, (draft) => {
					draft.artifact = {
						path: result.path,
						compiledAt: new Date().toISOString(),
						files: result.files,
						closureValid: result.closure.valid,
						blockers: result.closure.blockers,
						stateHash: result.stateHash,
						artifactHash: result.artifactHash,
						stale: false,
					};
				});
				return jsonResult(result);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "training_test",
		label: "Isolated Skill Replay",
		description:
			"在隔离的全新 Pi Session 中执行新案例；正式回放只能使用编译文档、任务输入和文档工具结果。用户负责最终判断正确性。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("run"), Type.Literal("review")]),
			test_id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			input: Type.Optional(Type.Unknown()),
			expected_checks: Type.Optional(Type.Array(Type.String())),
			passed: Type.Optional(Type.Boolean()),
			comment: Type.Optional(Type.String()),
			confirmed_by_user: Type.Optional(Type.Boolean()),
			detail: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")])),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const p = params as any;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				let state = await store.create(sessionId);
				if (p.action === "list") return jsonResult(listResponse(state.tests, p.detail as ResponseDetail, "test"));
				if (p.action === "add") {
					if (!p.name || p.input === undefined) throw new Error("name and input are required");
					state = await store.update(sessionId, (draft) => {
						const now = new Date().toISOString();
						draft.tests.push({
							id: p.test_id || nextTestId(draft.tests),
							type: "replay",
							name: p.name,
							input: p.input,
							expectedChecks: p.expected_checks ?? [],
							status: "draft",
							createdAt: now,
							updatedAt: now,
						});
					});
					return jsonResult(mutationResponse(state, p.action, "test", state.tests.at(-1)));
				}
				const test = state.tests.find((item) => item.id === p.test_id);
				if (!test) throw new Error(`Unknown test: ${p.test_id}`);
				if (p.action === "review") {
					if (p.confirmed_by_user !== true || typeof p.passed !== "boolean")
						throw new Error("review requires passed and confirmed_by_user=true");
					const reviewed = await store.update(sessionId, (draft) => {
						const item = draft.tests.find((entry) => entry.id === p.test_id)!;
						item.status = p.passed ? "passed" : "failed";
						item.userComment = p.comment;
						item.reviewEvidence = {
							source: "user_message",
							piSessionId: sessionId,
							entryId: (ctx.sessionManager as any).getLeafEntry?.()?.id,
							confirmedAt: new Date().toISOString(),
						};
						item.updatedAt = new Date().toISOString();
					});
					return jsonResult(mutationResponse(reviewed, p.action, "test", reviewed.tests.find((item) => item.id === p.test_id)));
				}
				if (!state.artifact?.path || !state.artifact.closureValid || state.artifact.stale)
					throw new Error("必须先通过数据闭包检查并正式编译当前版本技能");
				await store.update(sessionId, (draft) => {
					const item = draft.tests.find((entry) => entry.id === p.test_id)!;
					item.status = "running";
					item.updatedAt = new Date().toISOString();
				});
				const replay = await runReplay(
					state.artifact.path,
					test.input,
					declaredToolNames(state),
					signal,
					300_000,
					declaredProviderExtensionPaths(state),
				);
				const updated = await store.update(sessionId, (draft) => {
					const item = draft.tests.find((entry) => entry.id === p.test_id)!;
					item.actualResult = replay.text;
					item.activeTools = replay.activeTools;
					item.accessLog = replay.accessLog;
					item.scopeAudit = replay.scopeAudit;
					item.status = replay.scopeAudit.valid ? "pending_user_review" : "error";
					if (!replay.scopeAudit.valid)
						item.userComment = `技能使用范围检查失败：${replay.scopeAudit.violations.join("；")}`;
					item.updatedAt = new Date().toISOString();
				});
				const completed = updated.tests.find((item) => item.id === p.test_id);
				return jsonResult({ ...summarizeItem(completed, "test"), actualResult: completed?.actualResult, scopeAudit: completed?.scopeAudit });
			} catch (error) {
				await markTestError(store, sessionId, p.test_id, error);
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "training_boundary_test",
		label: "Boundary Case Training",
		description:
			"根据已编译技能自动提出边界案例并在隔离 Session 中运行。Agent 不能自行确认结果正确，运行后状态必须等待用户审核。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("propose"), Type.Literal("run")]),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
			test_id: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const p = params as any;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				let state = await store.create(sessionId);
				if (!state.artifact?.path || !state.artifact.closureValid || state.artifact.stale)
					throw new Error("必须先通过数据闭包检查并正式编译当前版本技能");
				if (p.action === "propose") {
					const proposals = await proposeBoundaryCases(state.artifact.path, p.count ?? 6);
					state = await store.update(sessionId, (draft) => {
						for (const proposal of proposals) {
							const now = new Date().toISOString();
							draft.tests.push({
								id: nextTestId(draft.tests),
								type: "boundary",
								name: proposal.name,
								input: proposal.input,
								expectedChecks: proposal.expectedChecks,
								status: "draft",
								createdAt: now,
								updatedAt: now,
							});
						}
					});
					return jsonResult(state.tests.filter((item) => item.type === "boundary").slice(-proposals.length));
				}
				const test = state.tests.find((item) => item.id === p.test_id && item.type === "boundary");
				if (!test) throw new Error(`Unknown boundary test: ${p.test_id}`);
				await store.update(sessionId, (draft) => {
					const item = draft.tests.find((entry) => entry.id === p.test_id)!;
					item.status = "running";
					item.updatedAt = new Date().toISOString();
				});
				const replay = await runReplay(
					state.artifact.path,
					test.input,
					declaredToolNames(state),
					signal,
					300_000,
					declaredProviderExtensionPaths(state),
				);
				state = await store.update(sessionId, (draft) => {
					const item = draft.tests.find((entry) => entry.id === p.test_id)!;
					item.actualResult = replay.text;
					item.activeTools = replay.activeTools;
					item.accessLog = replay.accessLog;
					item.scopeAudit = replay.scopeAudit;
					item.status = replay.scopeAudit.valid ? "pending_user_review" : "error";
					if (!replay.scopeAudit.valid)
						item.userComment = `技能使用范围检查失败：${replay.scopeAudit.violations.join("；")}`;
					item.updatedAt = new Date().toISOString();
				});
				const completed = state.tests.find((item) => item.id === p.test_id);
				return jsonResult({ ...summarizeItem(completed, "test"), actualResult: completed?.actualResult, scopeAudit: completed?.scopeAudit });
			} catch (error) {
				await markTestError(store, sessionId, p.test_id, error);
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "training_validate",
		label: "Skill Closure and Clean Environment Validation",
		description: "检查数据闭包、产物完整性，并可在 Docker 或自定义沙箱中从零运行安装及验证脚本。",
		parameters: Type.Object({ clean_environment: Type.Optional(Type.Boolean({ default: false })) }),
		async execute(_id, params, _signal, _update, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				return jsonResult(
					await validateSkill(await store.create(sessionId), (params as any).clean_environment === true),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

async function markTestError(
	store: TrainingStore,
	sessionId: string,
	testId: string | undefined,
	error: unknown,
): Promise<void> {
	if (!testId) return;
	await store
		.update(sessionId, (state) => {
			const test = state.tests.find((item) => item.id === testId);
			if (!test) return;
			const message = error instanceof Error ? error.message : String(error);
			test.status = /cancel/i.test(message) ? "cancelled" : /timed out/i.test(message) ? "timed_out" : "error";
			test.userComment = message;
			test.updatedAt = new Date().toISOString();
		})
		.catch(() => undefined);
}

function declaredToolNames(state: { tools: Array<{ name: string; formalSkillRequired?: boolean }> }): string[] {
	return state.tools.filter((tool) => tool.formalSkillRequired).map((tool) => tool.name);
}
function declaredProviderExtensionPaths(state: {
	tools: Array<{ formalSkillRequired?: boolean; providerExtensionPath?: string; providerApproval?: string }>;
}): string[] {
	return [
		...new Set(
			state.tools
				.filter(
					(tool) =>
						tool.formalSkillRequired &&
						tool.providerExtensionPath &&
						["user_approved", "verified"].includes(tool.providerApproval ?? ""),
				)
				.map((tool) => tool.providerExtensionPath!),
		),
	];
}

function nextTestId(tests: Array<{ id: string }>): string {
	const max = tests.reduce((value, item) => Math.max(value, Number(item.id.match(/^TEST-(\d+)$/)?.[1] ?? 0)), 0);
	return `TEST-${String(max + 1).padStart(3, "0")}`;
}
