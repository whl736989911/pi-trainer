import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}

export function textFromMessageContent(content: string): string {
	try {
		const parsed = JSON.parse(content) as { text?: string };
		return parsed.text?.trim() ?? "";
	} catch {
		return "";
	}
}

export function isAbortText(text: string): boolean {
	return /^(stop|abort|cancel|停止|停下|中止|取消|别继续了|不要继续)[!！。\s]*$/i.test(text.trim());
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
