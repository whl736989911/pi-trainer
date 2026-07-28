import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { getRuntime } from "./runtime.ts";
import { currentLarkContext } from "./tool-context.ts";
import { errorResult, jsonResult } from "./tool-result.ts";

const OptionalJson = Type.Optional(Type.Record(Type.String(), Type.Unknown()));

async function request(
	path: string,
	options: { method?: string; auth?: "user" | "tenant"; query?: Record<string, unknown>; body?: unknown } = {},
) {
	const runtime = getRuntime();
	const context = currentLarkContext();
	const method = options.method ?? "GET";
	if (options.auth === "user") {
		if (!context?.senderOpenId) throw new Error("没有飞书消息发送者上下文，无法使用用户身份");
		const token = await runtime.oauth.accessToken(context.senderOpenId);
		const url = new URL(
			(runtime.config.brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn") + path,
		);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined)
				url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
		}
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		const data = (await response.json()) as any;
		if (!response.ok || (data.code !== undefined && data.code !== 0))
			throw new Error(`${data.code ?? response.status}: ${data.msg ?? response.statusText}`);
		return data.data ?? data;
	}
	const response = await (runtime.client.request as any)({
		method,
		url: path,
		params: options.query,
		data: options.body,
	});
	if (response?.code !== undefined && response.code !== 0)
		throw new Error(`${response.code}: ${response.msg ?? "Feishu API error"}`);
	return response?.data ?? response;
}

export function registerFeishuTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "feishu_bitable_records",
		label: "Feishu Bitable Records",
		description: "以当前飞书用户身份查询或修改多维表格记录。写入前先 list_fields 确认字段结构。",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("list_fields"),
				Type.Literal("create"),
				Type.Literal("update"),
				Type.Literal("delete"),
				Type.Literal("batch_create"),
				Type.Literal("batch_update"),
				Type.Literal("batch_delete"),
			]),
			app_token: Type.String(),
			table_id: Type.String(),
			record_id: Type.Optional(Type.String()),
			fields: OptionalJson,
			records: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 500 })),
			record_ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
			filter: OptionalJson,
			sort: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
			page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			page_token: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const p = params as any;
			const base = `/open-apis/bitable/v1/apps/${encodeURIComponent(p.app_token)}/tables/${encodeURIComponent(p.table_id)}`;
			try {
				let data: unknown;
				if (p.action === "list_fields")
					data = await request(`${base}/fields`, {
						auth: "user",
						query: { page_size: p.page_size, page_token: p.page_token },
					});
				else if (p.action === "list")
					data = await request(`${base}/records`, {
						auth: "user",
						query: { page_size: p.page_size, page_token: p.page_token, filter: p.filter, sort: p.sort },
					});
				else if (p.action === "create")
					data = await request(`${base}/records`, { method: "POST", auth: "user", body: { fields: p.fields } });
				else if (p.action === "update")
					data = await request(`${base}/records/${encodeURIComponent(required(p.record_id, "record_id"))}`, {
						method: "PUT",
						auth: "user",
						body: { fields: p.fields },
					});
				else if (p.action === "delete")
					data = await request(`${base}/records/${encodeURIComponent(required(p.record_id, "record_id"))}`, {
						method: "DELETE",
						auth: "user",
					});
				else if (p.action === "batch_delete")
					data = await request(`${base}/records/batch_delete`, {
						method: "POST",
						auth: "user",
						body: { records: p.record_ids },
					});
				else
					data = await request(`${base}/records/batch_${p.action === "batch_create" ? "create" : "update"}`, {
						method: "POST",
						auth: "user",
						body: { records: p.records },
					});
				return jsonResult(data);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "feishu_calendar_event",
		label: "Feishu Calendar Events",
		description: "以当前飞书用户身份查询、创建、更新或删除日程。时间使用 RFC3339 或秒级时间戳。",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("get"),
				Type.Literal("create"),
				Type.Literal("patch"),
				Type.Literal("delete"),
			]),
			calendar_id: Type.Optional(Type.String({ description: "不填时使用主日历" })),
			event_id: Type.Optional(Type.String()),
			summary: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			start_time: Type.Optional(Type.String()),
			end_time: Type.Optional(Type.String()),
			attendees: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
			page_size: Type.Optional(Type.Integer({ maximum: 100 })),
		}),
		async execute(_id, params) {
			const p = params as any;
			try {
				let calendarId = p.calendar_id;
				if (!calendarId) {
					const primary = (await request("/open-apis/calendar/v4/calendars/primary", {
						method: "POST",
						auth: "user",
						body: {},
					})) as any;
					calendarId = primary?.calendars?.[0]?.calendar?.calendar_id ?? primary?.calendars?.[0]?.calendar_id;
					if (!calendarId) throw new Error("无法解析当前用户主日历");
				}
				const base = `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`;
				let data: unknown;
				if (p.action === "list") data = await request(base, { auth: "user", query: { page_size: p.page_size } });
				else if (p.action === "get")
					data = await request(`${base}/${encodeURIComponent(required(p.event_id, "event_id"))}`, {
						auth: "user",
					});
				else if (p.action === "delete")
					data = await request(`${base}/${encodeURIComponent(required(p.event_id, "event_id"))}`, {
						method: "DELETE",
						auth: "user",
					});
				else {
					const body = {
						summary: p.summary,
						description: p.description,
						start_time: p.start_time ? { timestamp: toTimestamp(p.start_time) } : undefined,
						end_time: p.end_time ? { timestamp: toTimestamp(p.end_time) } : undefined,
						attendees: p.attendees,
					};
					data =
						p.action === "create"
							? await request(base, { method: "POST", auth: "user", body })
							: await request(`${base}/${encodeURIComponent(required(p.event_id, "event_id"))}`, {
									method: "PATCH",
									auth: "user",
									body,
								});
				}
				return jsonResult(data);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "feishu_drive_search",
		label: "Feishu Drive Search",
		description: "以当前飞书用户身份搜索云文档、电子表格、多维表格和 Wiki。",
		parameters: Type.Object({
			query: Type.String(),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			doc_types: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params) {
			const p = params as any;
			try {
				return jsonResult(
					await request("/open-apis/suite/docs-api/search/object", {
						method: "POST",
						auth: "user",
						body: { search_key: p.query, count: p.count ?? 20, offset: p.offset ?? 0, docs_types: p.doc_types },
					}),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "feishu_message",
		label: "Feishu Message",
		description: "发送飞书消息，或读取当前有权限访问的会话历史。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("send"), Type.Literal("history")]),
			receive_id: Type.Optional(Type.String()),
			receive_id_type: Type.Optional(Type.Union([Type.Literal("chat_id"), Type.Literal("open_id")])),
			text: Type.Optional(Type.String()),
			container_id: Type.Optional(Type.String()),
			page_size: Type.Optional(Type.Integer({ maximum: 50 })),
		}),
		async execute(_id, params) {
			const p = params as any;
			try {
				if (p.action === "send") {
					const context = currentLarkContext();
					const receiveId = p.receive_id || context?.chatId;
					if (!receiveId) throw new Error("receive_id 缺失且当前没有飞书会话上下文");
					return jsonResult(
						await request("/open-apis/im/v1/messages", {
							method: "POST",
							query: {
								receive_id_type: p.receive_id_type ?? (receiveId.startsWith("oc_") ? "chat_id" : "open_id"),
							},
							body: {
								receive_id: receiveId,
								msg_type: "text",
								content: JSON.stringify({ text: required(p.text, "text") }),
							},
						}),
					);
				}
				return jsonResult(
					await request("/open-apis/im/v1/messages", {
						auth: "user",
						query: {
							container_id_type: "chat",
							container_id: required(p.container_id || currentLarkContext()?.chatId, "container_id"),
							page_size: p.page_size ?? 20,
							sort_type: "ByCreateTimeDesc",
						},
					}),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "feishu_read_openapi",
		label: "Feishu Read OpenAPI",
		description:
			"只读调用飞书 OpenAPI，用于尚未提供专用工具的文档、Wiki、云盘、任务、表格、日历或消息查询。仅允许 GET。",
		parameters: Type.Object({
			path: Type.String({ description: "必须以 /open-apis/ 开头的只读 API 路径" }),
			query: OptionalJson,
			auth: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("tenant")], { default: "user" })),
		}),
		async execute(_id, params) {
			const p = params as any;
			try {
				if (
					!/^\/open-apis\/(docx|drive|wiki|sheets|bitable|calendar|task|im|contact|search|suite)\//.test(p.path)
				) {
					throw new Error("该 API 路径不在允许的只读范围内");
				}
				return jsonResult(await request(p.path, { auth: p.auth ?? "user", query: p.query }));
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

function required<T>(value: T | undefined | null, name: string): T {
	if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
	return value;
}

function toTimestamp(value: string): string {
	if (/^\d{10}$/.test(value)) return value;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error(`Invalid time: ${value}`);
	return String(Math.floor(timestamp / 1000));
}
