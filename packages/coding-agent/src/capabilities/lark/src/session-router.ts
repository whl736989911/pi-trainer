import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentDir } from "../../../config.ts";
import { ModelRuntime } from "../../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../../core/resource-loader.ts";
import { createAgentSession } from "../../../core/sdk.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { builtInExtensions } from "../../../extensions/index.ts";
import type { Logger } from "./logger.ts";
import type { PromptImage } from "./media.ts";
import type { StreamingCard } from "./streaming-card.ts";
import { runWithLarkContext } from "./tool-context.ts";
import type { GatewayConfig, Route, SessionIndex } from "./types.ts";
import { writeJsonAtomic } from "./util.ts";

export class PiSessionRouter {
	private readonly config: GatewayConfig;
	private readonly log: Logger;
	private readonly indexPath: string;
	private readonly sessionsDir: string;
	private index: SessionIndex = { version: 1, routes: {} };
	private modelRuntime?: ModelRuntime;
	private readonly queues = new Map<string, Promise<void>>();
	private readonly active = new Map<string, { abort: () => Promise<void>; card: StreamingCard }>();

	constructor(config: GatewayConfig, log: Logger) {
		this.config = config;
		this.log = log;
		this.indexPath = resolve(config.dataDir, "sessions.json");
		this.sessionsDir = resolve(config.dataDir, "sessions");
	}

	async initialize(): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true });
		if (existsSync(this.indexPath)) {
			try {
				this.index = JSON.parse(await readFile(this.indexPath, "utf8")) as SessionIndex;
			} catch (error) {
				this.log.warn("Ignoring invalid session index", String(error));
			}
		}
		this.modelRuntime = await ModelRuntime.create(
			this.config.agentDir
				? {
						authPath: resolve(this.config.agentDir, "auth.json"),
						modelsPath: resolve(this.config.agentDir, "models.json"),
					}
				: undefined,
		);
	}

	enqueue(route: Route, prompt: string, card: StreamingCard, images: PromptImage[] = []): Promise<void> {
		const previous = this.queues.get(route.key) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(() => this.run(route, prompt, card, images));
		this.queues.set(route.key, current);
		void current.finally(() => {
			if (this.queues.get(route.key) === current) this.queues.delete(route.key);
		});
		return current;
	}

	async abort(routeKey: string): Promise<boolean> {
		const active = this.active.get(routeKey);
		if (!active) return false;
		await active.abort();
		await active.card.finish(undefined, true).catch(() => undefined);
		return true;
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.active.values()].map((item) => item.abort().catch(() => undefined)));
	}

	private async run(route: Route, prompt: string, card: StreamingCard, images: PromptImage[]): Promise<void> {
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const record = this.index.routes[route.key];
			const manager =
				record?.sessionFile && existsSync(record.sessionFile)
					? SessionManager.open(record.sessionFile, this.sessionsDir, this.config.workspace)
					: SessionManager.create(this.config.workspace, this.sessionsDir);
			const agentDir = this.config.agentDir ?? getAgentDir();
			const settingsManager = SettingsManager.create(this.config.workspace, agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd: this.config.workspace,
				agentDir,
				settingsManager,
				extensionFactories: builtInExtensions,
			});
			await resourceLoader.reload();
			const result = await createAgentSession({
				cwd: this.config.workspace,
				agentDir,
				modelRuntime: this.modelRuntime,
				sessionManager: manager,
				settingsManager,
				resourceLoader,
				thinkingLevel: this.config.thinkingLevel,
			});
			session = result.session;
			this.active.set(route.key, { abort: () => session!.abort(), card });
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					card.append(event.assistantMessageEvent.delta);
				} else if (event.type === "tool_execution_start") {
					card.toolStart(event.toolName);
				} else if (event.type === "tool_execution_end") {
					card.toolEnd(event.toolName, event.isError);
				}
			});
			try {
				const decorated = [
					`[Feishu context: sender=${route.senderName || route.senderOpenId}, sender_open_id=${route.senderOpenId}, chat_id=${route.chatId}${route.threadId ? `, thread_id=${route.threadId}` : ""}]`,
					prompt,
				].join("\n\n");
				await runWithLarkContext(route, () =>
					session!.prompt(decorated, { source: "interactive", images: images as any }),
				);
				const sessionFile = session.sessionFile;
				if (sessionFile) {
					this.index.routes[route.key] = { sessionFile, updatedAt: new Date().toISOString() };
					await writeJsonAtomic(this.indexPath, this.index);
				}
				await card.finish();
			} finally {
				unsubscribe();
			}
		} catch (error) {
			this.log.error("Pi session failed", error instanceof Error ? error.stack : String(error));
			await card.finish(error).catch(() => undefined);
		} finally {
			this.active.delete(route.key);
			session?.dispose();
		}
	}
}
