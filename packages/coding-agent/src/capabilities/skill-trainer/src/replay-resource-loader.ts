import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DefaultResourceLoader, type ResourceLoader } from "../../../core/resource-loader.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";

export interface ReplayResources {
	resourceLoader: ResourceLoader;
	settingsManager: SettingsManager;
	temporaryRoot: string;
	inputRoot: string;
	dispose(): Promise<void>;
}

/**
 * Build a replay-only resource graph without touching the outer Pi runtime.
 * pi-lark and pi-skill-trainer remain loaded in the controller session; this
 * loader is used only by the nested, in-memory replay session.
 */
export async function createReplayResources(
	artifactPath: string,
	allowedExtensionPaths: string[] = [],
): Promise<ReplayResources> {
	const temporaryRoot = await mkdtemp(resolve(tmpdir(), "pi-skill-replay-"));
	const emptyAgentDir = resolve(temporaryRoot, "agent");
	const inputRoot = resolve(temporaryRoot, "input");
	await Promise.all([mkdir(emptyAgentDir, { recursive: true }), mkdir(inputRoot, { recursive: true })]);

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 2 },
	});

	const resourceLoader = new DefaultResourceLoader({
		cwd: artifactPath,
		agentDir: emptyAgentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [...new Set(allowedExtensionPaths)],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => formalReplaySystemPrompt(),
		appendSystemPromptOverride: () => [],
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
		promptsOverride: () => ({ prompts: [], diagnostics: [] }),
		agentsFilesOverride: () => ({ agentsFiles: [] }),
	});
	await resourceLoader.reload();

	assertIsolatedResources(resourceLoader, allowedExtensionPaths.length);
	return {
		resourceLoader,
		settingsManager,
		temporaryRoot,
		inputRoot,
		async dispose() {
			await rm(temporaryRoot, { recursive: true, force: true });
		},
	};
}

export async function verifyReplayResourceIsolation(artifactPath: string): Promise<Record<string, number | boolean>> {
	const resources = await createReplayResources(artifactPath);
	try {
		return {
			extensions: resources.resourceLoader.getExtensions().extensions.length,
			skills: resources.resourceLoader.getSkills().skills.length,
			prompts: resources.resourceLoader.getPrompts().prompts.length,
			contextFiles: resources.resourceLoader.getAgentsFiles().agentsFiles.length,
			appendSystemPrompts: resources.resourceLoader.getAppendSystemPrompt().length,
			hasIsolatedSystemPrompt: resources.resourceLoader.getSystemPrompt() === formalReplaySystemPrompt(),
		};
	} finally {
		await resources.dispose();
	}
}

export function formalReplaySystemPrompt(): string {
	return `You are validating a compiled skill in a fresh training replay session.

Use only:
1. the compiled SKILL.md entry document supplied in the current prompt;
2. compiled documents read on demand with the restricted skill file tools;
3. the current test input;
4. results returned by tools explicitly declared by the compiled skill.

Follow progressive disclosure: read STEPS.md after SKILL.md, then read only the documents directly referenced by the current operation. Do not use training conversation history, global knowledge, context files, other skills, prompt templates, or model-derived business facts. If required business data is absent, follow the compiled missing-data rule or report the missing data. Do not guess. Every business rule, formula, parameter, and decisive fact used in the result must cite its compiled document name.`;
}

function assertIsolatedResources(loader: ResourceLoader, allowedExtensionCount: number): void {
	const failures: string[] = [];
	const extensions = loader.getExtensions();
	if (extensions.errors.length)
		failures.push(`extension errors: ${extensions.errors.map((item) => item.path).join(", ")}`);
	if (extensions.extensions.length > allowedExtensionCount) failures.push("undeclared extensions");
	if (loader.getSkills().skills.length) failures.push("skills");
	if (loader.getPrompts().prompts.length) failures.push("prompt templates");
	if (loader.getAgentsFiles().agentsFiles.length) failures.push("context files");
	if (loader.getAppendSystemPrompt().length) failures.push("append system prompts");
	if (failures.length) throw new Error(`Replay ResourceLoader isolation failed: ${failures.join(", ")}`);
}
