import type { LarkSdkClient } from "./lark-client.ts";
import type { Logger } from "./logger.ts";
import type { Route } from "./types.ts";

const ELEMENT_ID = "pi_streaming_content";

interface ToolStep {
	name: string;
	status: "running" | "success" | "error";
}

export class StreamingCard {
	private readonly client: LarkSdkClient;
	private readonly route: Route;
	private readonly throttleMs: number;
	private readonly log: Logger;
	private cardId = "";
	private messageId = "";
	private sequence = 0;
	private answer = "";
	private timer?: NodeJS.Timeout;
	private flushing?: Promise<void>;
	private dirty = false;
	private completed = false;
	private toolSteps: ToolStep[] = [];
	private readonly startedAt = Date.now();

	constructor(client: LarkSdkClient, route: Route, throttleMs: number, log: Logger) {
		this.client = client;
		this.route = route;
		this.throttleMs = throttleMs;
		this.log = log;
	}

	async create(): Promise<void> {
		const response = await (this.client.cardkit.v1.card.create as any)({
			data: { type: "card_json", data: JSON.stringify(this.streamingCard("思考中…")) },
		});
		this.assertOk(response, "card.create");
		this.cardId = response?.data?.card_id ?? response?.card_id ?? "";
		if (!this.cardId) throw new Error("CardKit did not return card_id");
		const sent = await (this.client.im.message.reply as any)({
			path: { message_id: this.route.messageId },
			data: {
				msg_type: "interactive",
				content: JSON.stringify({ type: "card", data: { card_id: this.cardId } }),
				reply_in_thread: Boolean(this.route.threadId),
			},
		});
		this.assertOk(sent, "im.message.reply");
		this.messageId = sent?.data?.message_id ?? "";
	}

	append(delta: string): void {
		if (this.completed || !delta) return;
		this.answer += delta;
		this.schedule();
	}

	toolStart(name: string): void {
		this.toolSteps.push({ name, status: "running" });
		this.schedule();
	}

	toolEnd(name: string, isError: boolean): void {
		const step = [...this.toolSteps].reverse().find((item) => item.name === name && item.status === "running");
		if (step) step.status = isError ? "error" : "success";
		this.schedule();
	}

	async finish(error?: unknown, aborted = false): Promise<void> {
		if (this.completed) return;
		this.completed = true;
		if (this.timer) clearTimeout(this.timer);
		await this.waitForFlush();
		const text =
			this.answer.trim() || (aborted ? "已停止。" : error ? `处理失败：${this.errorMessage(error)}` : "处理完成。");
		try {
			const response = await (this.client.cardkit.v1.card.update as any)({
				path: { card_id: this.cardId },
				data: {
					card: { type: "card_json", data: JSON.stringify(this.finalCard(text, Boolean(error), aborted)) },
					sequence: ++this.sequence,
				},
			});
			this.assertOk(response, "card.update");
			const settings = await (this.client.cardkit.v1.card.settings as any)({
				path: { card_id: this.cardId },
				data: { settings: JSON.stringify({ streaming_mode: false }), sequence: ++this.sequence },
			});
			this.assertOk(settings, "card.settings");
		} catch (cardError) {
			this.log.error("Failed to finalize streaming card", this.errorMessage(cardError));
			throw cardError;
		}
	}

	private schedule(): void {
		this.dirty = true;
		if (this.timer || this.completed) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, this.throttleMs);
	}

	private async flush(): Promise<void> {
		if (!this.dirty || this.completed || !this.cardId) return;
		if (this.flushing) {
			this.schedule();
			return;
		}
		this.dirty = false;
		const content = this.currentContent();
		this.flushing = (async () => {
			const response = await (this.client.cardkit.v1.cardElement.content as any)({
				path: { card_id: this.cardId, element_id: ELEMENT_ID },
				data: { content, sequence: ++this.sequence },
			});
			this.assertOk(response, "cardElement.content");
		})();
		try {
			await this.flushing;
		} catch (error) {
			this.log.warn("Streaming card update failed", this.errorMessage(error));
		} finally {
			this.flushing = undefined;
			if (this.dirty) this.schedule();
		}
	}

	private async waitForFlush(): Promise<void> {
		if (this.flushing) await this.flushing.catch(() => undefined);
	}

	private currentContent(): string {
		const running = this.toolSteps.filter((step) => step.status === "running");
		const status = running.length
			? `🛠️ 正在执行：${running.map((step) => step.name).join("、")}\n\n`
			: this.answer
				? ""
				: "思考中…\n\n";
		return `${status}${this.answer}`.trimEnd();
	}

	private streamingCard(initial: string): object {
		return {
			schema: "2.0",
			config: { streaming_mode: true, locales: ["zh_cn", "en_us"], summary: { content: "Pi 正在处理…" } },
			body: { elements: [{ tag: "markdown", content: initial, element_id: ELEMENT_ID }] },
		};
	}

	private finalCard(text: string, isError: boolean, aborted: boolean): object {
		const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
		const status = isError ? "处理失败" : aborted ? "已停止" : "已完成";
		const tools = this.toolSteps.length
			? [
					{
						tag: "collapsible_panel",
						expanded: false,
						header: { title: { tag: "plain_text", content: `🛠️ 工具执行 · ${this.toolSteps.length} 步` } },
						elements: this.toolSteps.map((step) => ({
							tag: "markdown",
							content: `${step.status === "success" ? "✅" : step.status === "error" ? "❌" : "⏹️"} ${step.name}`,
						})),
					},
				]
			: [];
		return {
			schema: "2.0",
			config: {
				streaming_mode: false,
				wide_screen_mode: true,
				summary: { content: text.replace(/[*_`#>]/g, "").slice(0, 120) },
			},
			body: {
				elements: [
					...tools,
					{ tag: "markdown", content: text },
					{ tag: "markdown", content: `${status} · ${elapsed}s`, text_size: "notation" },
				],
			},
		};
	}

	private assertOk(response: any, api: string): void {
		if (response?.code && response.code !== 0) throw new Error(`${api}: ${response.code} ${response.msg ?? ""}`);
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
