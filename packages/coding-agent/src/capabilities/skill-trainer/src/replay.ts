import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSession } from "../../../core/sdk.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { structureHash } from "./fingerprint.ts";
import { createReplayFileTools, type ReplayAccessLog } from "./replay-file-tools.ts";
import { createReplayResources } from "./replay-resource-loader.ts";

const ROOT_DOC_FILES = [
	"SKILL.md",
	"SETUP.md",
	"TOOLS.md",
	"DATA.md",
	"RULES.md",
	"FORMULAS.md",
	"STEPS.md",
	"DECISIONS.md",
	"EXAMPLES.md",
	"TESTS.md",
	"manifest.json",
	"tools.lock.json",
];

export interface ReplayResult {
	text: string;
	activeTools: string[];
	accessLog: ReplayAccessLog[];
}

export async function runReplay(
	artifactPath: string,
	input: unknown,
	declaredTools: string[] = [],
	signal?: AbortSignal,
	timeoutMs = 300_000,
	providerExtensionPaths: string[] = [],
): Promise<ReplayResult> {
	const docs = await loadDocs(artifactPath);
	const resources = await createReplayResources(artifactPath, providerExtensionPaths);
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let text = "";
	const accessLog: ReplayAccessLog[] = [];
	let unsubscribe: (() => void) | undefined;
	try {
		const declared = [...new Set(declaredTools)];
		const replayFileTools = createReplayFileTools(artifactPath, resources.inputRoot, accessLog).filter((tool) =>
			declared.includes(tool.name),
		);
		({ session } = await createAgentSession({
			cwd: artifactPath,
			resourceLoader: resources.resourceLoader,
			settingsManager: resources.settingsManager,
			sessionManager: SessionManager.inMemory(artifactPath),
			tools: declared,
			customTools: replayFileTools,
		}));
		const activeToolNames = new Set(session.agent.state.tools.map((tool) => tool.name));
		const activeToolsByName = new Map(session.agent.state.tools.map((tool) => [tool.name, tool]));
		const missingTools = declaredTools.filter((name) => !activeToolNames.has(name));
		if (missingTools.length)
			throw new Error(`Compiled skill tools are unavailable in isolated replay: ${missingTools.join(", ")}`);
		await verifyToolSchemas(artifactPath, activeToolsByName);
		unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
				text += event.assistantMessageEvent.delta;
			if (event.type === "tool_execution_start" && !event.toolName.startsWith("skill_")) {
				accessLog.push({
					timestamp: new Date().toISOString(),
					tool: event.toolName,
					path: JSON.stringify(event.args),
					allowed: true,
				});
			}
		});
		const prompt = `# COMPILED SKILL DOCUMENTS\n${docs}\n\n# TEST INPUT\n${format(input)}\n\nExecute the compiled skill. Explicitly cite compiled data/document identifiers and report missing data instead of guessing.`;
		await promptWithDeadline(session, prompt, signal, timeoutMs);
		return { text: text.trim(), activeTools: [...activeToolNames], accessLog };
	} finally {
		unsubscribe?.();
		session?.dispose();
		await resources.dispose();
	}
}

export async function proposeBoundaryCases(
	artifactPath: string,
	count: number,
): Promise<Array<{ name: string; input: unknown; expectedChecks: string[] }>> {
	const docs = await loadDocs(artifactPath);
	const resources = await createReplayResources(artifactPath);
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let text = "";
	let unsubscribe: (() => void) | undefined;
	try {
		({ session } = await createAgentSession({
			cwd: artifactPath,
			resourceLoader: resources.resourceLoader,
			settingsManager: resources.settingsManager,
			sessionManager: SessionManager.inMemory(artifactPath),
			noTools: "all",
		}));
		unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
				text += event.assistantMessageEvent.delta;
		});
		const prompt = `# COMPILED SKILL DOCUMENTS\n${docs}\n\nPropose ${count} high-value boundary cases covering thresholds, missing inputs, conflicts, invalid units, malformed files, tool failure, overlapping rules, and no matching rule where applicable. Do not invent the correct business result. expectedChecks must only describe behavior verifiable from the compiled documents or requiring user confirmation. Return ONLY a JSON array with objects: {"name":string,"input":any,"expectedChecks":string[]}.`;
		await session.prompt(prompt, { source: "interactive", expandPromptTemplates: false });
		const parsed = parseJsonArray(text);
		return parsed.slice(0, count).map((item: any) => ({
			name: String(item.name),
			input: item.input,
			expectedChecks: Array.isArray(item.expectedChecks) ? item.expectedChecks.map(String) : [],
		}));
	} finally {
		unsubscribe?.();
		session?.dispose();
		await resources.dispose();
	}
}

async function loadDocs(root: string): Promise<string> {
	const relativeFiles = [
		...ROOT_DOC_FILES,
		...(await listMarkdownFiles(resolve(root, "data"))).map((file) => `data/${file}`),
	];
	const chunks: string[] = [];
	for (const name of relativeFiles) {
		try {
			chunks.push(`\n## FILE: ${name}\n${await readFile(resolve(root, name), "utf8")}`);
		} catch {
			/* optional generated document */
		}
	}
	if (!chunks.length) throw new Error("Compiled skill contains no readable documents");
	return chunks.join("\n");
}

async function listMarkdownFiles(directory: string, prefix = ""): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...(await listMarkdownFiles(resolve(directory, entry.name), relative)));
		else if (entry.isFile() && /\.(md|json|ya?ml)$/i.test(entry.name)) files.push(relative);
	}
	return files.sort();
}

export async function verifyToolSchemas(artifactPath: string, activeTools: Map<string, any>): Promise<void> {
	let lock: any;
	try {
		lock = JSON.parse(await readFile(resolve(artifactPath, "tools.lock.json"), "utf8"));
	} catch {
		return;
	}
	for (const item of lock.tools ?? []) {
		if (!item.inputSchemaHash) continue;
		const tool = activeTools.get(item.name);
		if (!tool) throw new Error(`Locked tool is unavailable: ${item.name}`);
		const actual = structureHash(tool.parameters);
		if (actual !== item.inputSchemaHash) throw new Error(`Tool schema changed since compilation: ${item.name}`);
	}
}

async function promptWithDeadline(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	prompt: string,
	signal?: AbortSignal,
	timeoutMs = 300_000,
): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	const abort = () => {
		void session.abort();
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		await Promise.race([
			session.prompt(prompt, { source: "interactive", expandPromptTemplates: false }),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					void session.abort();
					reject(new Error(`Replay timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
			...(signal
				? [
						new Promise<never>((_, reject) =>
							signal.addEventListener("abort", () => reject(new Error("Replay cancelled")), { once: true }),
						),
					]
				: []),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

function format(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function parseJsonArray(text: string): any[] {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
	const start = fenced.indexOf("[");
	const end = fenced.lastIndexOf("]");
	if (start < 0 || end < start) throw new Error("Boundary proposer did not return a JSON array");
	const value = JSON.parse(fenced.slice(start, end + 1));
	if (!Array.isArray(value)) throw new Error("Boundary proposal is not an array");
	return value;
}
