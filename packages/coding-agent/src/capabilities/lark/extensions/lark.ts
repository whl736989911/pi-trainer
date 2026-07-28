import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { defaultDataDir } from "../src/config-store.ts";
import { registerFeishuTools } from "../src/tools.ts";

export default function larkExtension(pi: ExtensionAPI): void {
	registerFeishuTools(pi);
	pi.registerCommand("lark-setup", {
		description: "Show the built-in Lark setup command",
		handler: async (_args, ctx) => {
			ctx.ui.notify("请在本地交互终端运行：pi lark setup", "info");
		},
	});
	pi.registerCommand("lark-status", {
		description: "Show the built-in Lark gateway status",
		handler: async (_args, ctx) => {
			const dataDir = process.env.PI_LARK_DATA_DIR || defaultDataDir();
			const statusPath = resolve(dataDir, "status.json");
			if (!existsSync(statusPath)) {
				ctx.ui.notify("Lark gateway is not running or has not written status yet", "warning");
				return;
			}
			try {
				const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
				ctx.ui.notify(
					`Lark: ${status.state}; pid=${status.pid}; since=${status.startedAt ?? status.stoppedAt}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Cannot read Lark status: ${String(error)}`, "error");
			}
		},
	});
}
