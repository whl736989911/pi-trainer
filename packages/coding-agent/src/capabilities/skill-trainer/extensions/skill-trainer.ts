import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { registerAdvancedTrainingTools } from "../src/advanced-tools.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { registerAutomaticKnowledgeCapture, registerKnowledgeTools } from "../src/knowledge-tools.ts";
import { TRAINING_SYSTEM_PROMPT } from "../src/prompt.ts";
import { isFormalReplay } from "../src/replay-context.ts";
import { TrainingStore } from "../src/store.ts";
import { registerTrainingTools } from "../src/tools.ts";

export default function skillTrainerExtension(pi: ExtensionAPI) {
	const store = new TrainingStore();
	const knowledge = new KnowledgeStore(store.root);
	registerTrainingTools(pi, store);
	registerAdvancedTrainingTools(pi, store);
	registerKnowledgeTools(pi, knowledge, store);
	registerAutomaticKnowledgeCapture(pi, knowledge);

	pi.on("before_agent_start", async (event) => {
		if (isFormalReplay()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${TRAINING_SYSTEM_PROMPT}` };
	});

	pi.registerCommand("training-start", {
		description: "Create or resume the skill-training state for this Pi session",
		handler: async (_args, ctx) => {
			const state = await store.create(ctx.sessionManager.getSessionId());
			ctx.ui.notify(`技能训练已就绪：${state.id}（阶段：${state.stage}）`, "info");
		},
	});

	pi.registerCommand("knowledge-status", {
		description: "Show the size and processing state of the global training knowledge base",
		handler: async (_args, ctx) => {
			const items = await knowledge.list();
			const pending = items.filter((item) => ["unprocessed", "candidate"].includes(item.status)).length;
			const linked = items.filter((item) => ["linked_to_skill", "materialized"].includes(item.status)).length;
			ctx.ui.notify(`全局训练知识：${items.length} 项；待整理 ${pending}；已关联/物化 ${linked}`, "info");
		},
	});

	pi.registerCommand("training-status", {
		description: "Show current skill-training state and unresolved model priors",
		handler: async (_args, ctx) => {
			const state = await store.get(ctx.sessionManager.getSessionId());
			if (!state) {
				ctx.ui.notify(
					"当前 Pi Session 尚未创建技能训练状态，请运行 /training-start 或直接描述要训练的任务。",
					"warning",
				);
				return;
			}
			const priors = state.data.filter((item) =>
				["model_prior", "model_candidate", "pending"].includes(item.status),
			);
			const knowledgeItems = await knowledge.list();
			const pendingKnowledge = knowledgeItems.filter((item) =>
				["unprocessed", "candidate"].includes(item.status),
			).length;
			ctx.ui.notify(
				`训练阶段：${state.stage}；案例 ${state.cases.length}；步骤 ${state.steps.length}；决策 ${state.decisions.length}；数据 ${state.data.length}；待确认候选 ${priors.length}；全局知识 ${knowledgeItems.length}（待整理 ${pendingKnowledge}）`,
				"info",
			);
		},
	});
}
