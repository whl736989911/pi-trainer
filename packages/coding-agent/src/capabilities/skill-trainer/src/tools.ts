import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { structureHash } from "./fingerprint.ts";
import { errorResult, jsonResult } from "./result.ts";
import { listResponse, mutationResponse, stateResponse, type ResponseDetail } from "./response-summary.ts";
import type { TrainingStore } from "./store.ts";
import type { TrainingState } from "./types.ts";

const StringArray = Type.Array(Type.String());
const OptionalStringArray = Type.Optional(StringArray);
const OptionalResponseDetail = Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")]));

export function registerTrainingTools(pi: ExtensionAPI, store: TrainingStore): void {
	pi.registerTool({
		name: "training_session",
		label: "Training Session",
		description: "创建、读取或更新当前 Pi Session 对应的技能训练状态。开始训练或回答训练状态前调用。",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("get"),
				Type.Literal("create"),
				Type.Literal("set_goal"),
				Type.Literal("set_stage"),
			]),
			skill_name: Type.Optional(Type.String()),
			skill_key: Type.Optional(Type.String()),
			problem: Type.Optional(Type.String()),
			inputs: OptionalStringArray,
			outputs: OptionalStringArray,
			rough_process: OptionalStringArray,
			detail: OptionalResponseDetail,
			stage: Type.Optional(
				Type.Union([
					Type.Literal("defining"),
					Type.Literal("running"),
					Type.Literal("reviewing"),
					Type.Literal("systematizing"),
				]),
			),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const p = params as any;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				if (p.action === "get") return jsonResult(stateResponse(await store.get(sessionId), p.detail as ResponseDetail));
				if (p.action === "create") return jsonResult(stateResponse(await store.create(sessionId), p.detail as ResponseDetail));
				const updated = await store.update(sessionId, (state) => {
					if (p.action === "set_stage") {
						if (!p.stage) throw new Error("stage is required");
						state.stage = p.stage;
					} else {
						if (!p.skill_name || !p.problem) throw new Error("skill_name and problem are required");
						state.goal = {
							skillName: p.skill_name,
							skillKey: p.skill_key,
							problem: p.problem,
							inputs: p.inputs ?? [],
							outputs: p.outputs ?? [],
							roughProcess: p.rough_process ?? [],
						};
						state.stage = "running";
					}
				});
				return jsonResult(mutationResponse(updated, p.action, "session"));
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "training_case",
		label: "Training Case",
		description: "记录真实训练案例、案例结果和用户是否认可输入输出对应关系。认可案例不等于确认其使用的数据。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update")]),
			case_id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			input: Type.Optional(Type.Unknown()),
			result: Type.Optional(Type.Unknown()),
			accepted: Type.Optional(Type.Boolean()),
			notes: Type.Optional(Type.String()),
			confirmed_by_user: Type.Optional(Type.Boolean()),
			detail: OptionalResponseDetail,
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const p = params as any;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				const state = await store.create(sessionId);
				if (p.action === "list") return jsonResult(listResponse(state.cases, p.detail as ResponseDetail, "case"));
				let changedId = p.case_id as string | undefined;
				const updated = await store.update(sessionId, (draft) => {
						const now = new Date().toISOString();
						if (p.action === "add") {
							if (!p.name || p.input === undefined) throw new Error("name and input are required");
							if (p.accepted === true && p.confirmed_by_user !== true)
								throw new Error("accepted=true requires confirmed_by_user=true");
							const id = p.case_id || nextId(draft, "CASE");
							changedId = id;
							if (draft.cases.some((entry) => entry.id === id)) throw new Error(`Duplicate case ID: ${id}`);
							draft.cases.push({
								id,
								name: p.name,
								input: p.input,
								result: p.result,
								accepted: p.accepted,
								notes: p.notes,
								acceptanceEvidence: p.accepted === true ? confirmationEvidence(ctx) : undefined,
								createdAt: now,
								updatedAt: now,
							});
						} else {
							const item = draft.cases.find((entry) => entry.id === p.case_id);
							if (!item) throw new Error(`Unknown case: ${p.case_id}`);
							if (p.name !== undefined) item.name = p.name;
							if (p.input !== undefined) item.input = p.input;
							if (p.result !== undefined) item.result = p.result;
							if (p.accepted !== undefined) {
								if (p.accepted === true && p.confirmed_by_user !== true)
									throw new Error("accepted=true requires confirmed_by_user=true");
								item.accepted = p.accepted;
								item.acceptanceEvidence = p.accepted === true ? confirmationEvidence(ctx) : undefined;
							}
							if (p.notes !== undefined) item.notes = p.notes;
							item.updatedAt = now;
						}
					});
				return jsonResult(mutationResponse(updated, p.action, "case", updated.cases.find((item) => item.id === changedId)));
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "training_structure",
		label: "Training Structure",
		description:
			"查询或修改技能训练中的步骤、决策和数据草稿。用户修改结果后必须同步更新对应结构。公式数据的 value 必须包含 expression、variables[{symbol,meaning,unit,source}]、resultUnit、precision、rounding。",
		parameters: Type.Object({
			entity: Type.Union([Type.Literal("step"), Type.Literal("decision"), Type.Literal("data")]),
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("add"),
				Type.Literal("update"),
				Type.Literal("remove"),
			]),
			id: Type.Optional(Type.String()),
			value: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			detail: OptionalResponseDetail,
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const p = params as any;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				const state = await store.create(sessionId);
				const collection = collectionFor(state, p.entity);
				if (p.action === "list") return jsonResult(listResponse(collection, p.detail as ResponseDetail, p.entity));
				if (!p.id && p.action !== "add") throw new Error("id is required");
				let changedId = p.id as string | undefined;
				const updated = await store.update(sessionId, (draft) => {
						const target = collectionFor(draft, p.entity) as any[];
						if (p.action === "add") {
							if (!p.value) throw new Error("value is required");
							const prefix = p.entity === "step" ? "STEP" : p.entity === "decision" ? "DECISION" : "DATA";
							const id = p.id || nextId(draft, prefix);
							changedId = id;
							if (target.some((item) => item.id === id)) throw new Error(`Duplicate ${p.entity} ID: ${id}`);
							target.push(normalizeEntity(p.entity, { ...p.value, id }, target.length));
							return;
						}
						const index = target.findIndex((item) => item.id === p.id);
						if (index < 0) throw new Error(`Unknown ${p.entity}: ${p.id}`);
						if (p.action === "remove") target[index].status = p.entity === "data" ? "rejected" : "removed";
						else
							target[index] = normalizeEntity(
								p.entity,
								{ ...target[index], ...(p.value ?? {}), id: p.id },
								index,
							);
					});
				const changed = collectionFor(updated, p.entity).find((item) => item.id === changedId);
				return jsonResult(mutationResponse(updated, p.action, p.entity, changed));
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "training_correction",
		label: "Training Correction",
		description: "记录用户修正、修正原因和受影响对象。不能只保存新答案。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("add")]),
			target_type: Type.Optional(
				Type.Union([
					Type.Literal("result"),
					Type.Literal("step"),
					Type.Literal("decision"),
					Type.Literal("data"),
					Type.Literal("tool"),
					Type.Literal("output"),
				]),
			),
			target_id: Type.Optional(Type.String()),
			old_value: Type.Optional(Type.Unknown()),
			new_value: Type.Optional(Type.Unknown()),
			reason_type: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
			affected: OptionalStringArray,
			confirmed_by_user: Type.Optional(Type.Boolean()),
			detail: OptionalResponseDetail,
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const p = params as any;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				const state = await store.create(sessionId);
				if (p.action === "list") return jsonResult(listResponse(state.corrections, p.detail as ResponseDetail, "correction"));
				if (!p.target_type || !p.reason_type || !p.reason)
					throw new Error("target_type, reason_type and reason are required");
				let changedId: string | undefined;
				const updated = await store.update(sessionId, (draft) => {
						changedId = nextId(draft, "CORRECTION");
						draft.corrections.push({
							id: changedId,
							targetType: p.target_type,
							targetId: p.target_id,
							oldValue: p.old_value,
							newValue: p.new_value,
							reasonType: p.reason_type,
							reason: p.reason,
							affected: p.affected ?? [],
							confirmedByUser: p.confirmed_by_user === true,
							createdAt: new Date().toISOString(),
						});
					});
				return jsonResult(mutationResponse(updated, p.action, "correction", updated.corrections.find((item) => item.id === changedId)));
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "training_prior",
		label: "Training Prior Review",
		description: "列出模型先验/候选数据，或记录用户对候选数据的确认、限定、替换和拒绝。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("summary"), Type.Literal("review")]),
			data_id: Type.Optional(Type.String()),
			confirmed_by_user: Type.Optional(Type.Boolean()),
			status: Type.Optional(
				Type.Union([
					Type.Literal("model_prior"),
					Type.Literal("model_candidate"),
					Type.Literal("user_provided"),
					Type.Literal("source_confirmed"),
					Type.Literal("user_confirmed"),
					Type.Literal("conditional"),
					Type.Literal("case_only"),
					Type.Literal("pending"),
					Type.Literal("rejected"),
					Type.Literal("replaced"),
				]),
			),
			value: Type.Optional(Type.Unknown()),
			source_detail: Type.Optional(Type.String()),
			scope: Type.Optional(Type.String()),
			conditions: OptionalStringArray,
			exceptions: OptionalStringArray,
			on_missing: Type.Optional(Type.String()),
			detail: OptionalResponseDetail,
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const p = params as any;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				const state = await store.create(sessionId);
				const priors = state.data.filter(
					(item) =>
						item.status === "model_prior" || item.status === "model_candidate" || item.status === "pending",
				);
				if (p.action === "list") return jsonResult(listResponse(priors, p.detail as ResponseDetail, "data"));
				if (p.action === "summary")
					return jsonResult({
						totalData: state.data.length,
						unresolvedPriors: priors.length,
						items: priors.map((item) => ({
							id: item.id,
							name: item.name,
							value: item.value,
							usedIn: item.usedIn,
						})),
					});
				const updated = await store.update(sessionId, (draft) => {
						const item = draft.data.find((entry) => entry.id === p.data_id);
						if (!item) throw new Error(`Unknown data item: ${p.data_id}`);
						if (!p.status) throw new Error("status is required");
						if (
							["user_confirmed", "conditional", "case_only", "rejected", "replaced"].includes(p.status) &&
							p.confirmed_by_user !== true
						)
							throw new Error(`${p.status} requires confirmed_by_user=true`);
						item.status = p.status;
						if (p.confirmed_by_user === true) item.confirmationEvidence = confirmationEvidence(ctx);
						if (p.value !== undefined) item.value = p.value;
						if (p.source_detail !== undefined) item.sourceDetail = p.source_detail;
						if (p.scope !== undefined) item.scope = p.scope;
						if (p.conditions !== undefined) item.conditions = p.conditions;
						if (p.exceptions !== undefined) item.exceptions = p.exceptions;
						if (p.on_missing !== undefined) item.onMissing = p.on_missing;
					});
				return jsonResult(mutationResponse(updated, p.action, "data", updated.data.find((item) => item.id === p.data_id)));
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "training_tool_record",
		label: "Training Tool Record",
		description: "记录训练中使用的工具、依赖、安装、验证和失败处理，以及该工具是否属于正式技能。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("update")]),
			tool_id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			version: Type.Optional(Type.String()),
			provider: Type.Optional(Type.String()),
			provider_extension_path: Type.Optional(Type.String()),
			provider_approval: Type.Optional(
				Type.Union([
					Type.Literal("candidate"),
					Type.Literal("user_approved"),
					Type.Literal("verified"),
					Type.Literal("rejected"),
				]),
			),
			input_schema_hash: Type.Optional(Type.String()),
			purpose: Type.Optional(Type.String()),
			step_id: Type.Optional(Type.String()),
			input_summary: Type.Optional(Type.String()),
			output_summary: Type.Optional(Type.String()),
			affected: OptionalStringArray,
			formal_skill_required: Type.Optional(Type.Boolean()),
			install: Type.Optional(Type.Record(Type.String(), Type.String())),
			install_approval: Type.Optional(
				Type.Union([
					Type.Literal("candidate"),
					Type.Literal("user_approved"),
					Type.Literal("verified"),
					Type.Literal("rejected"),
				]),
			),
			install_source: Type.Optional(Type.String()),
			success_check: Type.Optional(Type.String()),
			failure_handling: Type.Optional(Type.String()),
			detail: OptionalResponseDetail,
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const p = params as any;
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				const state = await store.create(sessionId);
				if (p.action === "list") return jsonResult(listResponse(state.tools, p.detail as ResponseDetail, "tool"));
				const discovered = p.name ? pi.getAllTools().find((tool) => tool.name === p.name) : undefined;
				const discoveredPath = discovered?.sourceInfo?.path;
				const schemaHash = p.input_schema_hash ?? (discovered ? structureHash(discovered.parameters) : undefined);
				let changedId = p.tool_id as string | undefined;
				const updated = await store.update(sessionId, (draft) => {
						if (p.action === "add") {
							if (!p.name) throw new Error("name is required");
							const id = p.tool_id || nextId(draft, "TOOL");
							changedId = id;
							if (draft.tools.some((entry) => entry.id === id)) throw new Error(`Duplicate tool ID: ${id}`);
							draft.tools.push({
								id,
								name: p.name,
								version: p.version,
								provider: p.provider,
								providerExtensionPath: p.provider_extension_path ?? discoveredPath,
								providerApproval:
									p.provider_approval ??
									((p.provider_extension_path ?? discoveredPath) ? "candidate" : undefined),
								inputSchemaHash: schemaHash,
								purpose: p.purpose,
								stepId: p.step_id,
								inputSummary: p.input_summary,
								outputSummary: p.output_summary,
								affected: p.affected,
								formalSkillRequired: p.formal_skill_required,
								install: p.install,
								installApproval: p.install_approval ?? (p.install ? "candidate" : undefined),
								installSource: p.install_source,
								successCheck: p.success_check,
								failureHandling: p.failure_handling,
								createdAt: new Date().toISOString(),
							});
						} else {
							const item = draft.tools.find((entry) => entry.id === p.tool_id);
							if (!item) throw new Error(`Unknown tool: ${p.tool_id}`);
							Object.assign(
								item,
								compact({
									name: p.name,
									version: p.version,
									provider: p.provider,
									providerExtensionPath: p.provider_extension_path ?? discoveredPath,
									providerApproval: p.provider_approval,
									inputSchemaHash: schemaHash,
									purpose: p.purpose,
									stepId: p.step_id,
									inputSummary: p.input_summary,
									outputSummary: p.output_summary,
									affected: p.affected,
									formalSkillRequired: p.formal_skill_required,
									install: p.install,
									installApproval: p.install_approval,
									installSource: p.install_source,
									successCheck: p.success_check,
									failureHandling: p.failure_handling,
								}),
							);
						}
					});
				return jsonResult(mutationResponse(updated, p.action, "tool", updated.tools.find((item) => item.id === changedId)));
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

function collectionFor(state: TrainingState, entity: string): any[] {
	if (entity === "step") return state.steps;
	if (entity === "decision") return state.decisions;
	if (entity === "data") return state.data;
	throw new Error(`Unknown entity: ${entity}`);
}

function nextId(state: TrainingState, prefix: string): string {
	const pools: any[][] = [state.cases, state.steps, state.decisions, state.data, state.corrections, state.tools];
	let max = 0;
	for (const item of pools.flat()) {
		const match = String(item.id).match(new RegExp(`^${prefix}-(\\d+)$`, "i"));
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

function normalizeEntity(entity: string, value: any, index: number): any {
	if (!value.id || typeof value.id !== "string") throw new Error(`${entity} id must be a non-empty string`);
	if (entity === "step") {
		const status = value.status ?? "candidate";
		if (!["candidate", "confirmed", "modified", "removed"].includes(status))
			throw new Error(`Invalid step status: ${status}`);
		return {
			id: value.id,
			order: integer(value.order ?? index + 1, "step.order"),
			name: text(value.name ?? "未命名步骤", "step.name"),
			goal: text(value.goal ?? "", "step.goal"),
			inputs: strings(value.inputs ?? [], "step.inputs"),
			instruction: text(value.instruction ?? "", "step.instruction"),
			toolRefs: strings(value.tool_refs ?? value.toolRefs ?? [], "step.toolRefs"),
			outputs: strings(value.outputs ?? [], "step.outputs"),
			outputExample: value.output_example ?? value.outputExample,
			doneWhen: strings(value.done_when ?? value.doneWhen ?? [], "step.doneWhen"),
			onFailure: text(value.on_failure ?? value.onFailure ?? "", "step.onFailure"),
			status,
		};
	}
	if (entity === "decision") {
		const status = value.status ?? "candidate";
		if (!["candidate", "confirmed", "modified", "removed"].includes(status))
			throw new Error(`Invalid decision status: ${status}`);
		if (!Array.isArray(value.branches ?? [])) throw new Error("decision.branches must be an array");
		const branches = (value.branches ?? []).map((branch: any) => ({
			when: text(branch?.when, "branch.when"),
			outcome: text(branch?.outcome ?? branch?.then, "branch.outcome"),
		}));
		return {
			id: value.id,
			stepId: text(value.step_id ?? value.stepId ?? "", "decision.stepId"),
			question: text(value.question ?? "", "decision.question"),
			branches,
			dataRefs: strings(value.data_refs ?? value.dataRefs ?? [], "decision.dataRefs"),
			status,
		};
	}
	const status = value.status ?? "model_candidate";
	const statuses = [
		"model_prior",
		"model_candidate",
		"user_provided",
		"source_confirmed",
		"user_confirmed",
		"conditional",
		"case_only",
		"pending",
		"rejected",
		"replaced",
	];
	const types = ["fact", "parameter", "rule", "formula", "term", "example", "constraint"];
	if (!statuses.includes(status)) throw new Error(`Invalid data status: ${status}`);
	if (!types.includes(value.type ?? "fact")) throw new Error(`Invalid data type: ${value.type}`);
	return {
		id: value.id,
		topic: text(value.topic ?? "general", "data.topic"),
		type: value.type ?? "fact",
		name: text(value.name ?? "未命名数据", "data.name"),
		value: value.value,
		unit: value.unit,
		status,
		sourceType: text(value.source_type ?? value.sourceType ?? "model_candidate", "data.sourceType"),
		sourceDetail: value.source_detail ?? value.sourceDetail,
		scope: value.scope,
		conditions: strings(value.conditions ?? [], "data.conditions"),
		exceptions: strings(value.exceptions ?? [], "data.exceptions"),
		onMissing: value.on_missing ?? value.onMissing,
		usedIn: strings(value.used_in ?? value.usedIn ?? [], "data.usedIn"),
	};
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}
function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		throw new Error(`${field} must be a string array`);
	return value;
}
function integer(value: unknown, field: string): number {
	if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
	return value as number;
}

function confirmationEvidence(ctx: any) {
	return {
		source: "user_message" as const,
		piSessionId: ctx.sessionManager.getSessionId(),
		entryId: ctx.sessionManager.getLeafEntry?.()?.id,
		confirmedAt: new Date().toISOString(),
	};
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
