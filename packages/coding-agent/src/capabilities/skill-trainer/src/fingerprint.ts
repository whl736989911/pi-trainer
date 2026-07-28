import { createHash } from "node:crypto";
import type { TrainingState } from "./types.ts";

export function trainingDefinitionHash(state: TrainingState): string {
	return createHash("sha256")
		.update(
			stableJson({
				goal: state.goal,
				cases: state.cases,
				steps: state.steps,
				decisions: state.decisions,
				data: state.data,
				tools: state.tools,
			}),
		)
		.digest("hex");
}

export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function structureHash(value: unknown): string {
	return contentHash(stableJson(value));
}

export function stableJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}
function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, sortValue(item)]),
		);
	return value;
}
