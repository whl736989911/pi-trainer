import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import type { KnowledgeStatus, KnowledgeStore } from "./knowledge.ts";
import { errorResult, jsonResult } from "./result.ts";
import type { TrainingStore } from "./store.ts";

const Status = Type.Union([
	Type.Literal("unprocessed"),
	Type.Literal("organized"),
	Type.Literal("candidate"),
	Type.Literal("confirmed"),
	Type.Literal("linked_to_skill"),
	Type.Literal("materialized"),
	Type.Literal("rejected"),
	Type.Literal("deleted"),
]);

export function registerKnowledgeTools(pi: ExtensionAPI, knowledge: KnowledgeStore, training: TrainingStore): void {
	pi.registerTool({
		name: "training_knowledge",
		label: "Training Knowledge",
		description:
			"保存、检索、整理和关联跨 Session 的训练知识。全局知识只能用于训练，正式技能必须物化为技能目录内数据。",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("search"),
				Type.Literal("add"),
				Type.Literal("update"),
				Type.Literal("link"),
				Type.Literal("materialize"),
				Type.Literal("delete"),
			]),
			knowledge_id: Type.Optional(Type.String()),
			query: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			content_type: Type.Optional(
				Type.Union([
					Type.Literal("user_message"),
					Type.Literal("assistant_message"),
					Type.Literal("tool_result"),
					Type.Literal("file"),
					Type.Literal("image"),
					Type.Literal("note"),
				]),
			),
			raw_content: Type.Optional(Type.String()),
			summary: Type.Optional(Type.String()),
			topics: Type.Optional(Type.Array(Type.String())),
			tags: Type.Optional(Type.Array(Type.String())),
			possible_skills: Type.Optional(Type.Array(Type.String())),
			scope: Type.Optional(Type.String()),
			status: Type.Optional(Status),
			confirmed_by_user: Type.Optional(Type.Boolean()),
			skill_key: Type.Optional(Type.String()),
			data_id: Type.Optional(Type.String()),
			source_detail: Type.Optional(Type.String()),
			data_name: Type.Optional(Type.String()),
			data_topic: Type.Optional(Type.String()),
			data_type: Type.Optional(
				Type.Union([
					Type.Literal("fact"),
					Type.Literal("parameter"),
					Type.Literal("rule"),
					Type.Literal("formula"),
					Type.Literal("term"),
					Type.Literal("example"),
					Type.Literal("constraint"),
				]),
			),
			data_value: Type.Optional(Type.Unknown()),
			unit: Type.Optional(Type.String()),
			conditions: Type.Optional(Type.Array(Type.String())),
			exceptions: Type.Optional(Type.Array(Type.String())),
			on_missing: Type.Optional(Type.String()),
			used_in: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const p = params as any;
			try {
				if (p.action === "list")
					return jsonResult(await knowledge.list({ status: p.status, topic: p.topics?.[0], skill: p.skill_key }));
				if (p.action === "search") {
					if (!p.query) throw new Error("query is required");
					return jsonResult(await knowledge.search(p.query, p.limit ?? 20));
				}
				if (p.action === "add") {
					if (!p.content_type || !p.raw_content) throw new Error("content_type and raw_content are required");
					return jsonResult(
						await knowledge.add({
							contentType: p.content_type,
							rawContent: p.raw_content,
							summary: p.summary,
							topics: p.topics ?? [],
							tags: p.tags ?? [],
							sourceSessionId: ctx.sessionManager.getSessionId(),
							sourceDetail: p.source_detail,
							possibleSkills: p.possible_skills ?? [],
							scope: p.scope,
							status: p.status ?? "unprocessed",
						}),
					);
				}
				if (!p.knowledge_id) throw new Error("knowledge_id is required");
				if (p.action === "link") {
					if (!p.skill_key) throw new Error("skill_key is required");
					return jsonResult(await knowledge.link(p.knowledge_id, p.skill_key, p.data_id));
				}
				if (p.action === "materialize") {
					const source = await knowledge.get(p.knowledge_id);
					if (!source) throw new Error(`Unknown knowledge item: ${p.knowledge_id}`);
					if (source.status !== "confirmed")
						throw new Error("Knowledge must be user-confirmed before materialization");
					if (!p.data_name || p.data_value === undefined || !p.used_in?.length)
						throw new Error("data_name, data_value and used_in are required");
					const state = await training.update(ctx.sessionManager.getSessionId(), (draft) => {
						const next =
							draft.data.reduce(
								(max, item) => Math.max(max, Number(item.id.match(/^DATA-(\d+)$/)?.[1] ?? 0)),
								0,
							) + 1;
						p.data_id = p.data_id || `DATA-${String(next).padStart(3, "0")}`;
						if (draft.data.some((item) => item.id === p.data_id))
							throw new Error(`Duplicate data ID: ${p.data_id}`);
						draft.data.push({
							id: p.data_id,
							topic: p.data_topic ?? source.topics[0] ?? "general",
							type: p.data_type ?? "fact",
							name: p.data_name,
							value: p.data_value,
							unit: p.unit,
							status: "source_confirmed",
							sourceType: "global_knowledge_snapshot",
							sourceDetail: `${source.id}@${source.contentHash}`,
							scope: p.scope ?? source.scope,
							conditions: p.conditions ?? [],
							exceptions: p.exceptions ?? [],
							onMissing: p.on_missing ?? "报告缺失并停止相关步骤",
							usedIn: p.used_in,
						});
					});
					await knowledge.link(source.id, state.goal?.skillKey ?? state.id, p.data_id);
					return jsonResult({
						data: state.data.find((item) => item.id === p.data_id),
						sourceKnowledgeId: source.id,
						sourceHash: source.contentHash,
					});
				}
				if (p.action === "delete") return jsonResult(await knowledge.update(p.knowledge_id, { status: "deleted" }));
				if (p.status === "confirmed" && p.confirmed_by_user !== true)
					throw new Error("status=confirmed requires confirmed_by_user=true");
				return jsonResult(
					await knowledge.update(
						p.knowledge_id,
						compact({
							summary: p.summary,
							topics: p.topics,
							tags: p.tags,
							possibleSkills: p.possible_skills,
							scope: p.scope,
							status: p.status as KnowledgeStatus | undefined,
							sourceDetail: p.source_detail,
							confirmationEvidence:
								p.confirmed_by_user === true
									? {
											piSessionId: ctx.sessionManager.getSessionId(),
											entryId: (ctx.sessionManager as any).getLeafEntry?.()?.id,
											confirmedAt: new Date().toISOString(),
										}
									: undefined,
						}),
					),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

export function registerAutomaticKnowledgeCapture(pi: ExtensionAPI, knowledge: KnowledgeStore): void {
	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();
		if (text)
			await knowledge.add({
				contentType: "user_message",
				rawContent: text,
				topics: [],
				tags: [],
				sourceSessionId: ctx.sessionManager.getSessionId(),
				sourceDetail: `Pi ${event.source} input`,
				possibleSkills: [],
				status: "unprocessed",
			});
		for (const image of event.images ?? []) {
			await knowledge.add({
				contentType: "image",
				rawContent: JSON.stringify(image),
				topics: [],
				tags: ["image"],
				sourceSessionId: ctx.sessionManager.getSessionId(),
				sourceDetail: `Pi ${event.source} image`,
				possibleSkills: [],
				status: "unprocessed",
			});
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName.startsWith("training_")) return;
		const text = event.content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text)
			.join("\n");
		if (!text.trim()) return;
		const path = typeof (event.input as any)?.path === "string" ? (event.input as any).path : undefined;
		await knowledge.add({
			contentType: event.toolName === "read" ? "file" : "tool_result",
			rawContent: text,
			topics: [],
			tags: [event.toolName],
			sourceSessionId: ctx.sessionManager.getSessionId(),
			sourceDetail: path ? `${event.toolName}:${path}` : `tool:${event.toolName}`,
			possibleSkills: [],
			status: "unprocessed",
		});
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as any;
		if (message.role !== "assistant") return;
		const text = Array.isArray(message.content)
			? message.content
					.filter((part: any) => part.type === "text")
					.map((part: any) => part.text)
					.join("\n")
			: String(message.content ?? "");
		if (!text.trim()) return;
		await knowledge.add({
			contentType: "assistant_message",
			rawContent: text,
			topics: [],
			tags: [],
			sourceSessionId: ctx.sessionManager.getSessionId(),
			sourceDetail: "Pi assistant message",
			possibleSkills: [],
			status: "unprocessed",
		});
	});
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
