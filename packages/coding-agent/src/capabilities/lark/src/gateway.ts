import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { LarkTransport } from "./lark-client.ts";
import type { Logger } from "./logger.ts";
import { parseInboundContent, type ResolvedInbound, resolveInboundResources } from "./media.ts";
import { OAuthManager } from "./oauth.ts";
import { setRuntime } from "./runtime.ts";
import { PiSessionRouter } from "./session-router.ts";
import { StreamingCard } from "./streaming-card.ts";
import type { GatewayConfig, Route } from "./types.ts";
import { errorText, isAbortText, writeJsonAtomic } from "./util.ts";

export class PiLarkGateway {
	private readonly config: GatewayConfig;
	private readonly log: Logger;
	private readonly transport: LarkTransport;
	private readonly sessions: PiSessionRouter;
	private readonly oauth: OAuthManager;
	private botOpenId = "";
	private readonly seen = new Map<string, number>();

	constructor(config: GatewayConfig, log: Logger) {
		this.config = config;
		this.log = log;
		this.transport = new LarkTransport(config);
		this.sessions = new PiSessionRouter(config, log);
		this.oauth = new OAuthManager(config);
		setRuntime({ config, client: this.transport.client, oauth: this.oauth });
	}

	async run(signal: AbortSignal): Promise<void> {
		await mkdir(this.config.dataDir, { recursive: true });
		await this.sessions.initialize();
		const bot = await this.transport.botIdentity();
		this.botOpenId = bot.openId;
		await writeJsonAtomic(resolve(this.config.dataDir, "status.json"), {
			state: "running",
			pid: process.pid,
			startedAt: new Date().toISOString(),
			botName: bot.name,
			botOpenId: bot.openId,
		});
		this.log.info(`Connected as ${bot.name || bot.openId}`);
		try {
			await this.transport.startWebSocket(
				{
					"im.message.receive_v1": (data) =>
						void this.handleMessage(data).catch((error) =>
							this.log.error("Inbound message failed", errorText(error)),
						),
				},
				signal,
			);
		} finally {
			await this.sessions.dispose();
			this.transport.close();
			await writeJsonAtomic(resolve(this.config.dataDir, "status.json"), {
				state: "stopped",
				pid: process.pid,
				stoppedAt: new Date().toISOString(),
			});
		}
	}

	private async handleMessage(event: any): Promise<void> {
		const message = event?.message;
		const sender = event?.sender;
		const messageId = message?.message_id as string | undefined;
		const senderOpenId = sender?.sender_id?.open_id as string | undefined;
		if (!messageId || !senderOpenId || senderOpenId === this.botOpenId) return;
		if (this.isDuplicate(messageId)) return;
		const parsed = parseInboundContent(message.message_type, message.content ?? "");
		const mentions = message.mentions ?? [];
		const mentionedBot = mentions.some((mention: any) => mention?.id?.open_id === this.botOpenId);
		for (const mention of mentions) {
			if (mention?.id?.open_id === this.botOpenId && mention.key)
				parsed.text = parsed.text.replaceAll(mention.key, "").trim();
		}
		const chatType = message.chat_type === "group" ? "group" : "p2p";
		if (!this.allowed(senderOpenId, chatType, mentionedBot)) return;
		if (!parsed.text && parsed.resources.length === 0) return;
		const route = this.route(event);
		if (isAbortText(parsed.text)) {
			const stopped = await this.sessions.abort(route.key);
			if (!stopped) await this.transport.replyText(route, "当前没有正在执行的任务。");
			return;
		}
		if (/^(授权|重新授权|auth|authorize)$/i.test(parsed.text.trim())) {
			await this.authorize(route);
			return;
		}
		if (/^(撤销授权|取消授权|logout|revoke)$/i.test(parsed.text.trim())) {
			await this.oauth.revoke(route.senderOpenId);
			await this.transport.replyText(route, "已撤销当前飞书用户的授权。");
			return;
		}
		let inbound: ResolvedInbound;
		try {
			inbound = await resolveInboundResources(
				this.transport.client,
				messageId,
				parsed,
				resolve(this.config.dataDir, "media", route.key.replace(/[^a-zA-Z0-9._-]/g, "_")),
			);
		} catch (error) {
			await this.transport.replyText(route, `读取飞书附件失败：${errorText(error)}`);
			return;
		}
		const card = new StreamingCard(this.transport.client, route, this.config.streamThrottleMs, this.log);
		try {
			await card.create();
		} catch (error) {
			this.log.warn("CardKit unavailable, reporting error as text", errorText(error));
			await this.transport.replyText(route, `无法创建流式卡片：${errorText(error)}`);
			return;
		}
		void this.sessions.enqueue(route, inbound.prompt, card, inbound.images);
	}

	private async authorize(route: Route): Promise<void> {
		try {
			const authorization = await this.oauth.begin(route.senderOpenId);
			await this.transport.replyAuthorizationCard(
				route,
				authorization.verificationUriComplete,
				authorization.userCode,
			);
			await this.oauth.complete(route.senderOpenId, authorization);
			await this.transport.replyText(route, "授权成功，现在可以使用日历、任务、云文档等用户身份工具。");
		} catch (error) {
			await this.transport.replyText(route, `授权失败：${errorText(error)}`);
		}
	}

	private route(event: any): Route {
		const message = event.message;
		const sender = event.sender;
		const threadId = message.thread_id || message.root_id || undefined;
		const chatType = message.chat_type === "group" ? "group" : "p2p";
		return {
			key: `${this.config.appId}:${message.chat_id}${threadId ? `:${threadId}` : ""}`,
			chatId: message.chat_id,
			threadId,
			messageId: message.message_id,
			senderOpenId: sender.sender_id.open_id,
			senderName: sender.sender_id.name,
			chatType,
		};
	}

	private allowed(senderOpenId: string, chatType: "p2p" | "group", mentionedBot: boolean): boolean {
		const senderAllowed = this.config.allowFrom.includes("*") || this.config.allowFrom.includes(senderOpenId);
		if (!senderAllowed) {
			this.log.warn("Rejected sender not in PI_LARK_ALLOW_FROM", senderOpenId);
			return false;
		}
		if (chatType === "p2p") return true;
		if (this.config.groupPolicy === "disabled") return false;
		return this.config.groupPolicy === "open" || mentionedBot;
	}

	private isDuplicate(messageId: string): boolean {
		const now = Date.now();
		for (const [id, time] of this.seen) if (now - time > 12 * 60 * 60 * 1000) this.seen.delete(id);
		if (this.seen.has(messageId)) return true;
		this.seen.set(messageId, now);
		return false;
	}
}
