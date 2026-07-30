import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createAgentSession } from "../../../core/sdk.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { structureHash } from "./fingerprint.ts";
import { createReplayFileTools, type ReplayAccessLog } from "./replay-file-tools.ts";
import { createReplayResources } from "./replay-resource-loader.ts";
import { type SkillSelfContainmentReport, validateCompiledSkillSelfContainment } from "./scope-audit.ts";
import type { ReplayScopeAudit } from "./types.ts";

const REPLAY_FILE_TOOLS = ["skill_read", "skill_list", "skill_find"];
const ROOT_DOC_FILES = ["SKILL.md", "STEPS.md", "TOOLS.md", "SETUP.md", "manifest.json", "tools.lock.json"];
const BUSINESS_DOCUMENT_DIRECTORIES = ["rules", "data", "formulas", "decisions"];

export interface ReplayResult {
	text: string;
	activeTools: string[];
	accessLog: ReplayAccessLog[];
	scopeAudit: ReplayScopeAudit;
}

export async function runReplay(
	artifactPath: string,
	input: unknown,
	declaredTools: string[] = [],
	signal?: AbortSignal,
	timeoutMs = 300_000,
	providerExtensionPaths: string[] = [],
): Promise<ReplayResult> {
	const selfContainment = await validateCompiledSkillSelfContainment(artifactPath);
	if (!selfContainment.valid)
		throw new Error(`Compiled skill is not self-contained: ${selfContainment.violations.join("; ")}`);
	const entryDocument = await loadEntryDocument(artifactPath);
	const resources = await createReplayResources(artifactPath, providerExtensionPaths);
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let text = "";
	const accessLog: ReplayAccessLog[] = [];
	let unsubscribe: (() => void) | undefined;
	try {
		const declared = [...new Set([...REPLAY_FILE_TOOLS, ...declaredTools])];
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
		const prompt = `# COMPILED SKILL ENTRY DOCUMENT\n${entryDocument}\n\n# TEST INPUT\n${format(input)}\n\nExecute the compiled skill using progressive disclosure. Start with SKILL.md, then use skill_read to read STEPS.md, and only read documents directly referenced by the current operation. Cite the document names used and report missing data instead of guessing. At the very end, append this machine-readable declaration with the actual compiled document paths and declared tools whose returned content you used:\n<!-- SKILL_SCOPE_USAGE\n{"documents":["SKILL.md","STEPS.md"],"tools":[],"outsideSkillContent":[]}\n-->\nDo not list a document or tool unless you actually used its content. If you used any fact or content outside the current input, compiled skill, or declared tool results, list it in outsideSkillContent.`;
		await promptWithDeadline(session, prompt, signal, timeoutMs);
		const parsed = parseScopeUsage(text);
		const scopeAudit = auditReplayScope(artifactPath, parsed.usage, accessLog, declaredTools, selfContainment);
		return { text: parsed.text, activeTools: [...activeToolNames], accessLog, scopeAudit };
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
	const docs = await loadAllDocs(artifactPath);
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

async function loadEntryDocument(root: string): Promise<string> {
	try {
		return `## FILE: SKILL.md\n${await readFile(resolve(root, "SKILL.md"), "utf8")}`;
	} catch {
		throw new Error("Compiled skill contains no readable SKILL.md entry document");
	}
}

async function loadAllDocs(root: string): Promise<string> {
	const relativeFiles = [...ROOT_DOC_FILES];
	for (const directory of BUSINESS_DOCUMENT_DIRECTORIES)
		relativeFiles.push(...(await listMarkdownFiles(resolve(root, directory))).map((file) => `${directory}/${file}`));
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

interface ScopeUsage {
	documents: string[];
	tools: string[];
	outsideSkillContent: string[];
}

function parseScopeUsage(text: string): { text: string; usage?: ScopeUsage } {
	const pattern = /<!--\s*SKILL_SCOPE_USAGE\s*([\s\S]*?)-->/i;
	const match = text.match(pattern);
	if (!match?.[1]) return { text: text.trim() };
	try {
		const parsed: unknown = JSON.parse(match[1].trim());
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return { text: text.replace(pattern, "").trim() };
		const record = parsed as Record<string, unknown>;
		if (![record.documents, record.tools, record.outsideSkillContent].every(isStringArray))
			return { text: text.replace(pattern, "").trim() };
		return {
			text: text.replace(pattern, "").trim(),
			usage: {
				documents: record.documents as string[],
				tools: record.tools as string[],
				outsideSkillContent: record.outsideSkillContent as string[],
			},
		};
	} catch {
		return { text: text.replace(pattern, "").trim() };
	}
}

function auditReplayScope(
	artifactPath: string,
	usage: ScopeUsage | undefined,
	accessLog: ReplayAccessLog[],
	declaredTools: string[],
	selfContainment: SkillSelfContainmentReport,
): ReplayScopeAudit {
	const violations: string[] = [];
	if (!usage) violations.push("回放结果缺少有效的 SKILL_SCOPE_USAGE 声明");
	const reportedDocuments = [...new Set(usage?.documents ?? [])];
	const reportedTools = [...new Set(usage?.tools ?? [])];
	const outsideSkillContent = [...new Set(usage?.outsideSkillContent ?? [])];
	if (outsideSkillContent.length)
		violations.push(`回放声明使用了技能范围之外的内容：${outsideSkillContent.join("；")}`);
	for (const entry of accessLog.filter((item) => !item.allowed))
		violations.push(`受限访问失败或越界：${entry.tool} ${entry.path}${entry.error ? ` (${entry.error})` : ""}`);
	const actualDocuments = new Set(
		accessLog
			.filter((item) => item.allowed && item.tool === "skill_read")
			.map((item) => normalizeSkillDocumentPath(artifactPath, item.path))
			.filter((path): path is string => path !== undefined),
	);
	for (const document of reportedDocuments) {
		const normalized = normalizeSkillDocumentPath(artifactPath, document);
		if (!normalized) {
			violations.push(`来源声明包含技能目录之外或不存在的文档：${document}`);
			continue;
		}
		if (normalized !== "SKILL.md" && !actualDocuments.has(normalized))
			violations.push(`来源声明中的文档未通过 skill_read 实际读取：${normalized}`);
	}
	for (const document of actualDocuments)
		if (!reportedDocuments.some((item) => normalizeSkillDocumentPath(artifactPath, item) === document))
			violations.push(`实际读取的文档未在来源声明中列出：${document}`);
	if (!actualDocuments.has("STEPS.md")) violations.push("回放未按渐进式入口读取 STEPS.md");
	const actualTools = new Set(
		accessLog.filter((item) => item.allowed && !item.tool.startsWith("skill_")).map((item) => item.tool),
	);
	for (const tool of actualTools) {
		if (!declaredTools.includes(tool)) violations.push(`调用了未声明工具：${tool}`);
		if (!reportedTools.includes(tool)) violations.push(`实际调用的工具未在来源声明中列出：${tool}`);
	}
	for (const tool of reportedTools) {
		if (!declaredTools.includes(tool)) violations.push(`来源声明包含未声明工具：${tool}`);
		else if (!actualTools.has(tool)) violations.push(`来源声明中的工具未实际调用：${tool}`);
	}
	return {
		valid: violations.length === 0,
		selfContainment,
		reportedDocuments,
		reportedTools,
		outsideSkillContent,
		violations: [...new Set(violations)],
	};
}

function normalizeSkillDocumentPath(artifactPath: string, requested: string): string | undefined {
	if (!requested || requested.startsWith("input/") || isAbsolute(requested) || /^[a-z]:[\\/]/i.test(requested))
		return undefined;
	const normalizedRequest = requested.startsWith("skill/") ? requested.slice(6) : requested;
	const candidate = resolve(artifactPath, normalizedRequest);
	const root = resolve(artifactPath);
	if (!(candidate === root || candidate.startsWith(`${root}${sep}`)) || !existsSync(candidate)) return undefined;
	const path = relative(root, candidate).replaceAll("\\", "/");
	return /\.md$/i.test(path) ? path : undefined;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
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
