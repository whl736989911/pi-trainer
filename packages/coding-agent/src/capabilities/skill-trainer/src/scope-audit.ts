import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface SkillSelfContainmentReport {
	valid: boolean;
	entryDocument: string;
	checkedDocuments: string[];
	reachableDocuments: string[];
	violations: string[];
	warnings: string[];
}

export async function validateCompiledSkillSelfContainment(root: string): Promise<SkillSelfContainmentReport> {
	const violations: string[] = [];
	const warnings: string[] = [];
	const rootPath = await realpath(root);
	const documents = await listMarkdownFiles(rootPath);
	const documentSet = new Set(documents);
	if (!documentSet.has("SKILL.md")) violations.push("缺少技能入口 SKILL.md");
	if (!documentSet.has("STEPS.md")) violations.push("缺少执行入口 STEPS.md");
	const linksByDocument = new Map<string, string[]>();
	for (const document of documents) {
		const content = await readFile(resolve(rootPath, document), "utf8");
		const links: string[] = [];
		for (const target of markdownLinks(content)) {
			const local = localLinkTarget(target);
			if (local === undefined) {
				if (/^(?:https?:|mailto:)/i.test(target)) warnings.push(`${document} 包含外部参考链接：${target}`);
				continue;
			}
			if (isAbsolute(local) || /^[a-z]:[\\/]/i.test(local)) {
				violations.push(`${document} 引用了绝对路径：${target}`);
				continue;
			}
			const candidate = resolve(rootPath, dirname(document), local);
			if (!(candidate === rootPath || candidate.startsWith(`${rootPath}${sep}`))) {
				violations.push(`${document} 引用了技能目录之外的路径：${target}`);
				continue;
			}
			if (!existsSync(candidate)) {
				violations.push(`${document} 引用了不存在的文件：${target}`);
				continue;
			}
			const normalized = relative(rootPath, candidate).replaceAll("\\", "/");
			if (/\.md$/i.test(normalized)) links.push(normalized);
		}
		linksByDocument.set(document, links);
	}
	if (!(linksByDocument.get("SKILL.md") ?? []).includes("STEPS.md"))
		violations.push("SKILL.md 必须将 STEPS.md 声明为下一步阅读入口");
	const reachable = new Set<string>();
	const queue = documentSet.has("SKILL.md") ? ["SKILL.md"] : [];
	while (queue.length) {
		const document = queue.shift()!;
		if (reachable.has(document)) continue;
		reachable.add(document);
		for (const linked of linksByDocument.get(document) ?? []) if (!reachable.has(linked)) queue.push(linked);
	}
	for (const document of documents.filter((path) => /^(?:rules|data|formulas|decisions)\//.test(path))) {
		if (!reachable.has(document)) warnings.push(`${document} 未从 SKILL.md 的渐进式引用链到达`);
	}
	return {
		valid: violations.length === 0,
		entryDocument: "SKILL.md",
		checkedDocuments: documents,
		reachableDocuments: [...reachable],
		violations: [...new Set(violations)],
		warnings: [...new Set(warnings)],
	};
}

function markdownLinks(content: string): string[] {
	const links: string[] = [];
	const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
	for (const match of content.matchAll(pattern)) {
		const target = match[1]?.trim().replace(/^<|>$/g, "");
		if (target) links.push(target);
	}
	return links;
}

function localLinkTarget(target: string): string | undefined {
	if (/^(?:https?:|mailto:)/i.test(target) || target.startsWith("#")) return undefined;
	const withoutAnchor = target.split("#", 1)[0]?.trim();
	if (!withoutAnchor) return undefined;
	try {
		return decodeURIComponent(withoutAnchor);
	} catch {
		return withoutAnchor;
	}
}

async function listMarkdownFiles(root: string, directory = root): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listMarkdownFiles(root, path)));
		else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(relative(root, path).replaceAll("\\", "/"));
	}
	return files.sort();
}
