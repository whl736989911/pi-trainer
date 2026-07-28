import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { defaultDataDir, loadStoredConfig, saveStoredConfig } from "./config-store.ts";
import { LarkTransport } from "./lark-client.ts";
import type { GatewayConfig, LarkBrand } from "./types.ts";

export async function runSetup(): Promise<void> {
	if (!process.stdin.isTTY) throw new Error("setup requires an interactive terminal");
	const rl = createInterface({ input, output });
	try {
		output.write("\nPi Trainer Lark/Feishu setup\n============================\n\n");
		const dataDir = resolve(process.env.PI_LARK_DATA_DIR || defaultDataDir());
		const previous = await loadStoredConfig(dataDir).catch((): Partial<GatewayConfig> => ({}));
		const brandAnswer = await ask(rl, "平台 (feishu/lark)", String(previous.brand || "feishu"));
		const brand: LarkBrand = brandAnswer.toLowerCase() === "lark" ? "lark" : "feishu";
		const appId = await ask(rl, "App ID", previous.appId || "");
		let appSecret = await secretQuestion(rl, previous.appSecret ? "App Secret（回车保留现有值）" : "App Secret");
		if (!appSecret) appSecret = previous.appSecret || "";
		if (!appId || !appSecret) {
			const url = brand === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app";
			output.write(`\n需要先创建企业自建应用：${url}\n`);
			openBrowser(url);
			throw new Error("创建应用并取得 App ID/App Secret 后重新运行 `pi lark setup`");
		}
		const workspace = resolve(await ask(rl, "Pi 工作目录", previous.workspace || process.cwd()));
		const agentDirInput = await ask(rl, "Pi 配置目录（留空使用默认 ~/.pi/agent）", previous.agentDir || "");
		const groupAnswer = await ask(rl, "群聊策略 (disabled/mention/open)", previous.groupPolicy || "mention");
		const groupPolicy = (
			["disabled", "mention", "open"].includes(groupAnswer) ? groupAnswer : "mention"
		) as GatewayConfig["groupPolicy"];
		const config: GatewayConfig = {
			appId,
			appSecret,
			brand,
			workspace,
			dataDir,
			agentDir: agentDirInput || undefined,
			allowFrom: [],
			groupPolicy,
			thinkingLevel: previous.thinkingLevel,
			streamThrottleMs: previous.streamThrottleMs || 700,
			oauthScopes: [],
		};
		output.write("\n正在验证并绑定机器人…\n");
		const transport = new LarkTransport(config);
		const bot = await transport.botIdentity();
		output.write(`✓ 已连接机器人：${bot.name || bot.openId} (${bot.openId})\n`);
		const appInfo = await transport.applicationInfo().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`无法读取应用创建者和权限：${message}`);
		});
		const ownerOpenId = appInfo.ownerOpenId || appInfo.creatorOpenId;
		if (!ownerOpenId) throw new Error("应用信息中没有创建者/App Owner open_id，无法建立默认白名单");
		config.allowFrom = [ownerOpenId];
		config.oauthScopes = appInfo.scopes
			.filter((item) => !Array.isArray(item.tokenTypes) || item.tokenTypes.includes("user"))
			.map((item) => item.scope);
		await saveStoredConfig(dataDir, config);
		output.write(`✓ 已将应用创建者设为所有者：${ownerOpenId}\n`);
		output.write(`✓ 加密配置已保存：${resolve(dataDir, "config.enc")}\n`);
		output.write("\n配置完成。运行 `pi lark serve` 启动网关。\n\n");
	} finally {
		rl.close();
	}
}

async function ask(rl: ReturnType<typeof createInterface>, label: string, defaultValue: string): Promise<string> {
	const suffix = defaultValue ? ` [${defaultValue}]` : "";
	const answer = (await rl.question(`${label}${suffix}: `)).trim();
	return answer || defaultValue;
}

async function secretQuestion(rl: ReturnType<typeof createInterface>, label: string): Promise<string> {
	return (await rl.question(`${label}: `)).trim();
}

function openBrowser(url: string): void {
	try {
		if (process.platform === "win32")
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
		else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
	} catch {
		// The URL is printed above when launching a browser is unavailable.
	}
}
