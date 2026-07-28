import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../../../core/extensions/types.ts";

export interface ReplayAccessLog {
	timestamp: string;
	tool: string;
	path: string;
	allowed: boolean;
	error?: string;
}

export function createReplayFileTools(
	skillRoot: string,
	inputRoot: string,
	accessLog: ReplayAccessLog[],
): ToolDefinition[] {
	const rootsPromise = Promise.all([realpath(skillRoot), realpath(inputRoot)]);
	const resolveAllowed = async (requested: string): Promise<string> => {
		const roots = await rootsPromise;
		const candidates = requested.startsWith("input/")
			? [resolve(roots[1], requested.slice(6))]
			: requested.startsWith("skill/")
				? [resolve(roots[0], requested.slice(6))]
				: [resolve(roots[0], requested), resolve(roots[1], requested)];
		for (const candidate of candidates) {
			try {
				const actual = await realpath(candidate);
				if (roots.some((root) => actual === root || actual.startsWith(`${root}${sep}`))) return actual;
			} catch {
				/* try the next allowed root */
			}
		}
		throw new Error(`Path is outside replay skill/input roots or does not exist: ${requested}`);
	};
	const logged = async <T>(tool: string, path: string, operation: () => Promise<T>): Promise<T> => {
		try {
			const value = await operation();
			accessLog.push({ timestamp: new Date().toISOString(), tool, path, allowed: true });
			return value;
		} catch (error) {
			accessLog.push({
				timestamp: new Date().toISOString(),
				tool,
				path,
				allowed: false,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	};

	const skillRead = defineTool({
		name: "skill_read",
		label: "Read Replay File",
		description: "Read a UTF-8 file only from the compiled skill or current replay input directories.",
		parameters: Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
		}),
		async execute(_id, params) {
			try {
				const text = await logged("skill_read", params.path, async () => {
					const path = await resolveAllowed(params.path);
					const info = await stat(path);
					if (!info.isFile()) throw new Error("Path is not a file");
					if (info.size > 10 * 1024 * 1024) throw new Error("File exceeds 10 MiB replay limit");
					const lines = (await readFile(path, "utf8")).split(/\r?\n/);
					return lines
						.slice((params.offset ?? 1) - 1, (params.offset ?? 1) - 1 + (params.limit ?? 500))
						.join("\n");
				});
				return { content: [{ type: "text" as const, text }], details: {} };
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	});

	const skillList = defineTool({
		name: "skill_list",
		label: "List Replay Directory",
		description: "List a directory only inside the compiled skill or current replay input directories.",
		parameters: Type.Object({ path: Type.Optional(Type.String()) }),
		async execute(_id, params) {
			const requested = params.path ?? "skill/";
			try {
				const items = await logged("skill_list", requested, async () => {
					const path = await resolveAllowed(requested);
					const entries = await readdir(path, { withFileTypes: true });
					return entries.map((entry) => `${entry.isDirectory() ? "d" : "f"}\t${entry.name}`).join("\n");
				});
				return { content: [{ type: "text" as const, text: items }], details: {} };
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	});

	const skillFind = defineTool({
		name: "skill_find",
		label: "Find Replay Files",
		description: "Find files by case-insensitive name substring only inside replay roots.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1 }),
			root: Type.Optional(Type.Union([Type.Literal("skill"), Type.Literal("input")])),
		}),
		async execute(_id, params) {
			const rootName = params.root ?? "skill";
			try {
				const found = await logged("skill_find", `${rootName}:${params.query}`, async () => {
					const roots = await rootsPromise;
					const root = rootName === "skill" ? roots[0] : roots[1];
					const output: string[] = [];
					await walk(root, root, params.query.toLocaleLowerCase(), output, 500);
					return output.join("\n");
				});
				return { content: [{ type: "text" as const, text: found }], details: {} };
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	});
	return [skillRead, skillList, skillFind];
}

async function walk(root: string, directory: string, query: string, output: string[], limit: number): Promise<void> {
	if (output.length >= limit) return;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (output.length >= limit) return;
		const path = resolve(directory, entry.name);
		const actual = await realpath(path);
		if (!(actual === root || actual.startsWith(`${root}${sep}`))) continue;
		if (entry.isDirectory()) await walk(root, actual, query, output, limit);
		else if (entry.isFile() && entry.name.toLocaleLowerCase().includes(query))
			output.push(relative(root, actual).replaceAll("\\", "/"));
	}
}
