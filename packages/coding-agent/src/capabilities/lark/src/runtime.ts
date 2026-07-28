import type { LarkSdkClient } from "./lark-client.ts";
import type { OAuthManager } from "./oauth.ts";
import type { GatewayConfig } from "./types.ts";

interface Runtime {
	config: GatewayConfig;
	client: LarkSdkClient;
	oauth: OAuthManager;
}

interface RuntimeGlobals {
	[key: symbol]: Runtime | undefined;
}

const key = Symbol.for("@earendil-works/pi-trainer/lark-runtime");
const globals = globalThis as unknown as RuntimeGlobals;

export function setRuntime(value: Runtime): void {
	globals[key] = value;
}

export function getRuntime(): Runtime {
	const runtime = globals[key];
	if (!runtime) throw new Error("Lark gateway runtime is not initialized; Feishu tools require `pi lark serve`");
	return runtime;
}
