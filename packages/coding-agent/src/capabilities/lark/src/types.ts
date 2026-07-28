export type LarkBrand = "feishu" | "lark";

export interface GatewayConfig {
	appId: string;
	appSecret: string;
	brand: LarkBrand;
	workspace: string;
	dataDir: string;
	agentDir?: string;
	allowFrom: string[];
	groupPolicy: "disabled" | "mention" | "open";
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	streamThrottleMs: number;
	oauthScopes: string[];
}

export interface Route {
	key: string;
	chatId: string;
	threadId?: string;
	messageId: string;
	senderOpenId: string;
	senderName?: string;
	chatType: "p2p" | "group";
}

export interface SessionRecord {
	sessionFile: string;
	updatedAt: string;
}

export interface SessionIndex {
	version: 1;
	routes: Record<string, SessionRecord>;
}
