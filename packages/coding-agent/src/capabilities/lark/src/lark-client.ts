import * as Lark from "@larksuiteoapi/node-sdk";
import type { GatewayConfig, Route } from "./types.ts";

export type LarkSdkClient = InstanceType<typeof Lark.Client>;

export class LarkTransport {
	readonly client: LarkSdkClient;
	private readonly config: GatewayConfig;
	private ws?: InstanceType<typeof Lark.WSClient>;
	private readonly domain: Lark.Domain;

	constructor(config: GatewayConfig) {
		this.config = config;
		this.domain = config.brand === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
		this.client = new Lark.Client({
			appId: config.appId,
			appSecret: config.appSecret,
			appType: Lark.AppType.SelfBuild,
			domain: this.domain,
		});
	}

	async botIdentity(): Promise<{ openId: string; name?: string }> {
		const response = (await this.client.request({
			method: "POST",
			url: "/open-apis/bot/v1/openclaw_bot/ping",
			data: { needBotInfo: true },
		})) as any;
		if (response?.code !== 0 || !response?.data?.pingBotInfo?.botID) {
			throw new Error(`Cannot resolve bot identity: ${response?.msg || response?.code || "unknown response"}`);
		}
		return { openId: response.data.pingBotInfo.botID, name: response.data.pingBotInfo.botName };
	}

	async applicationInfo(): Promise<{
		ownerOpenId?: string;
		creatorOpenId?: string;
		scopes: Array<{ scope: string; tokenTypes?: string[] }>;
	}> {
		const response = (await this.client.request({
			method: "GET",
			url: `/open-apis/application/v6/applications/${this.config.appId}`,
			params: { lang: "zh_cn" },
		})) as any;
		if (response?.code !== 0)
			throw new Error(`${response?.code ?? "unknown"}: ${response?.msg ?? "无法查询应用信息"}`);
		const app = response?.data?.app ?? response?.app ?? response?.data;
		const rawScopes = app?.scopes ?? app?.online_version?.scopes ?? [];
		const owner = app?.owner;
		const ownerType = owner?.owner_type ?? owner?.type;
		const creatorOpenId = app?.creator_id as string | undefined;
		const ownerOpenId = (ownerType === 2 && owner?.owner_id ? owner.owner_id : (creatorOpenId ?? owner?.owner_id)) as
			| string
			| undefined;
		return {
			ownerOpenId,
			creatorOpenId,
			scopes: rawScopes
				.filter((item: any) => typeof item?.scope === "string")
				.map((item: any) => ({
					scope: item.scope as string,
					tokenTypes: item.token_types as string[] | undefined,
				})),
		};
	}

	async grantedScopes(tokenType?: "user" | "tenant"): Promise<string[]> {
		const info = await this.applicationInfo();
		return info.scopes
			.filter((item) => !tokenType || !Array.isArray(item.tokenTypes) || item.tokenTypes.includes(tokenType))
			.map((item) => item.scope);
	}

	startWebSocket(handlers: Record<string, (data: any) => unknown>, signal: AbortSignal): Promise<void> {
		const dispatcher = new Lark.EventDispatcher({});
		dispatcher.register(handlers as any);
		this.ws = new Lark.WSClient({
			appId: this.config.appId,
			appSecret: this.config.appSecret,
			domain: this.domain,
			loggerLevel: Lark.LoggerLevel.info,
		});
		const ws = this.ws as any;
		const original = ws.handleEventData.bind(ws);
		ws.handleEventData = (data: any) => {
			const messageType = data.headers?.find?.((header: any) => header.key === "type")?.value;
			if (messageType === "card") {
				data = {
					...data,
					headers: data.headers.map((header: any) =>
						header.key === "type" ? { ...header, value: "event" } : header,
					),
				};
			}
			return original(data);
		};
		void ws.start({ eventDispatcher: dispatcher });
		return new Promise((resolve) => {
			if (signal.aborted) {
				this.close();
				resolve();
				return;
			}
			signal.addEventListener(
				"abort",
				() => {
					this.close();
					resolve();
				},
				{ once: true },
			);
		});
	}

	close(): void {
		try {
			(this.ws as any)?.close({ force: true });
		} catch {
			/* already closed */
		}
		this.ws = undefined;
	}

	async replyText(route: Route, text: string): Promise<void> {
		await (this.client.im.message.reply as any)({
			path: { message_id: route.messageId },
			data: {
				msg_type: "post",
				content: JSON.stringify({ zh_cn: { content: [[{ tag: "md", text }]] } }),
				reply_in_thread: Boolean(route.threadId),
			},
		});
	}

	async replyAuthorizationCard(route: Route, url: string, userCode: string): Promise<void> {
		const card = {
			schema: "2.0",
			config: { wide_screen_mode: true },
			header: { title: { tag: "plain_text", content: "飞书用户授权" }, template: "blue" },
			body: {
				elements: [
					{
						tag: "markdown",
						content: `点击下方按钮完成授权。验证码：**${userCode}**\n\n授权只绑定当前消息发送者，Token 不会暴露给模型。`,
					},
					{ tag: "button", text: { tag: "plain_text", content: "打开授权页面" }, type: "primary", url },
				],
			},
		};
		await (this.client.im.message.reply as any)({
			path: { message_id: route.messageId },
			data: { msg_type: "interactive", content: JSON.stringify(card), reply_in_thread: Boolean(route.threadId) },
		});
	}
}
