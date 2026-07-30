import type { TrainingState } from "./types.ts";

export type ResponseDetail = "summary" | "full";

export function stateResponse(state: TrainingState | null | undefined, detail: ResponseDetail = "summary"): unknown {
	if (!state || detail === "full") return state;
	return summarizeState(state);
}

export function listResponse(items: any[], detail: ResponseDetail = "summary", kind?: string): unknown[] {
	return detail === "full" ? items : items.map((item) => summarizeItem(item, kind));
}

export function mutationResponse(
	state: TrainingState,
	action: string,
	kind: string,
	item?: unknown,
): Record<string, unknown> {
	return {
		ok: true,
		action,
		kind,
		item: item === undefined ? undefined : summarizeItem(item, kind),
		state: summarizeState(state),
	};
}

export function summarizeState(state: TrainingState): Record<string, unknown> {
	const unresolvedData = state.data.filter((item) =>
		["model_prior", "model_candidate", "pending"].includes(item.status),
	);
	return {
		id: state.id,
		stage: state.stage,
		goal: state.goal
			? {
					skillName: state.goal.skillName,
					skillKey: state.goal.skillKey,
					problem: state.goal.problem,
					inputs: state.goal.inputs,
					outputs: state.goal.outputs,
				}
			: undefined,
		counts: {
			cases: state.cases.length,
			steps: state.steps.length,
			decisions: state.decisions.length,
			data: state.data.length,
			unresolvedData: unresolvedData.length,
			corrections: state.corrections.length,
			tools: state.tools.length,
			tests: state.tests.length,
		},
		unresolvedDataIds: unresolvedData.map((item) => item.id),
		artifact: state.artifact
			? {
					path: state.artifact.path,
					closureValid: state.artifact.closureValid,
					stale: state.artifact.stale,
					artifactHash: state.artifact.artifactHash,
					blockerCount: state.artifact.blockers.length,
				}
			: undefined,
		updatedAt: state.updatedAt,
	};
}

export function summarizeItem(item: any, kind?: string): Record<string, unknown> {
	if (!item || typeof item !== "object") return { value: item };
	const base: Record<string, unknown> = { id: item.id };
	if (item.name !== undefined) base.name = item.name;
	if (item.status !== undefined) base.status = item.status;
	switch (kind) {
		case "case":
			return { ...base, accepted: item.accepted, hasInput: item.input !== undefined, hasResult: item.result !== undefined, notes: item.notes, updatedAt: item.updatedAt };
		case "step":
			return { ...base, order: item.order, goal: item.goal, toolRefs: item.toolRefs, outputs: item.outputs };
		case "decision":
			return { ...base, stepId: item.stepId, question: item.question, branchCount: item.branches?.length ?? 0, dataRefs: item.dataRefs };
		case "data":
			return { ...base, topic: item.topic, type: item.type, sourceType: item.sourceType, usedIn: item.usedIn, hasValue: item.value !== undefined };
		case "correction":
			return { ...base, targetType: item.targetType, targetId: item.targetId, reasonType: item.reasonType, reason: item.reason, affected: item.affected, confirmedByUser: item.confirmedByUser };
		case "tool":
			return { ...base, version: item.version, provider: item.provider, formalSkillRequired: item.formalSkillRequired, providerApproval: item.providerApproval, installApproval: item.installApproval };
		case "test":
			return { ...base, type: item.type, expectedCheckCount: item.expectedChecks?.length ?? 0, hasActualResult: item.actualResult !== undefined, activeTools: item.activeTools, updatedAt: item.updatedAt };
		default:
			return base;
	}
}
