import { resolve } from "node:path";
import { defaultDataDir, loadStoredConfig } from "./config-store.ts";
import type { GatewayConfig, LarkBrand } from "./types.ts";

function listValue(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export async function loadConfig(): Promise<GatewayConfig> {
	const dataDir = resolve(process.env.PI_LARK_DATA_DIR || defaultDataDir());
	const stored = await loadStoredConfig(dataDir);
	const appId = process.env.PI_LARK_APP_ID?.trim() || stored.appId || "";
	const appSecret = process.env.PI_LARK_APP_SECRET?.trim() || stored.appSecret || "";
	if (!appId) throw new Error("Missing PI_LARK_APP_ID. Run: pi-lark setup");
	if (!appSecret) throw new Error("Missing PI_LARK_APP_SECRET. Run: pi-lark setup");
	const brand = (process.env.PI_LARK_BRAND || stored.brand || "feishu") as LarkBrand;
	if (brand !== "feishu" && brand !== "lark") throw new Error("PI_LARK_BRAND must be feishu or lark");
	const groupPolicy = (process.env.PI_LARK_GROUP_POLICY ||
		stored.groupPolicy ||
		"mention") as GatewayConfig["groupPolicy"];
	if (!(["disabled", "mention", "open"] as const).includes(groupPolicy)) {
		throw new Error("PI_LARK_GROUP_POLICY must be disabled, mention, or open");
	}
	const allowFrom =
		process.env.PI_LARK_ALLOW_FROM !== undefined ? listValue(process.env.PI_LARK_ALLOW_FROM) : stored.allowFrom || [];
	const oauthScopes =
		process.env.PI_LARK_OAUTH_SCOPES !== undefined
			? listValue(process.env.PI_LARK_OAUTH_SCOPES)
			: stored.oauthScopes || [];
	return {
		appId,
		appSecret,
		brand,
		workspace: resolve(process.env.PI_LARK_WORKSPACE || stored.workspace || process.cwd()),
		dataDir,
		agentDir: process.env.PI_CODING_AGENT_DIR?.trim() || stored.agentDir || undefined,
		allowFrom,
		groupPolicy,
		thinkingLevel: (process.env.PI_LARK_THINKING_LEVEL as GatewayConfig["thinkingLevel"]) || stored.thinkingLevel,
		streamThrottleMs: Math.max(250, Number(process.env.PI_LARK_STREAM_THROTTLE_MS || stored.streamThrottleMs || 700)),
		oauthScopes,
	};
}
