import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { defaultDataDir } from "./config-store.ts";
import { PiLarkGateway } from "./gateway.ts";
import { logger } from "./logger.ts";
import { runSetup } from "./setup.ts";
import { errorText } from "./util.ts";

const HELP = `pi lark\n\nCommands:\n  setup    Configure Feishu/Lark credentials and owner access\n  serve    Run the gateway in the foreground\n  status   Show the last gateway status\n\nEnvironment overrides:\n  PI_LARK_APP_ID\n  PI_LARK_APP_SECRET\n  PI_LARK_ALLOW_FROM=ou_xxx[,ou_yyy]\n\nOptional:\n  PI_LARK_BRAND=feishu|lark\n  PI_LARK_GROUP_POLICY=disabled|mention|open\n  PI_LARK_WORKSPACE=/path/to/workspace\n  PI_LARK_DATA_DIR=/path/to/data\n  PI_LARK_STREAM_THROTTLE_MS=700\n`;

export async function handleLarkCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "lark") return false;
	const command = args[1] ?? "help";
	if (["--help", "-h", "help"].includes(command)) {
		process.stdout.write(HELP);
		return true;
	}
	if (command === "setup") {
		await runSetup();
		return true;
	}
	if (command === "status") {
		await printStatus();
		return true;
	}
	if (command !== "serve") throw new Error(`Unknown lark command: ${command}`);
	await serve();
	return true;
}

async function serve(): Promise<void> {
	const config = await loadConfig();
	if (config.allowFrom.length === 0) {
		throw new Error(
			"PI_LARK_ALLOW_FROM is required. Use explicit open_id values; use * only if you accept the risk.",
		);
	}
	const controller = new AbortController();
	const stop = (signal: string) => {
		logger.info(`Received ${signal}, shutting down`);
		controller.abort();
	};
	process.once("SIGINT", () => stop("SIGINT"));
	process.once("SIGTERM", () => stop("SIGTERM"));
	const gateway = new PiLarkGateway(config, logger);
	await gateway.run(controller.signal);
}

async function printStatus(): Promise<void> {
	const dataDir = resolve(process.env.PI_LARK_DATA_DIR || defaultDataDir());
	const statusPath = resolve(dataDir, "status.json");
	if (!existsSync(statusPath)) {
		process.stdout.write("pi lark: not configured or no gateway status has been written\n");
		return;
	}
	try {
		process.stdout.write(`${await readFile(statusPath, "utf8")}\n`);
	} catch (error) {
		throw new Error(`Cannot read ${statusPath}: ${errorText(error)}`);
	}
}
