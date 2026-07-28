import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { LarkSdkClient } from "./lark-client.ts";

export interface PromptImage {
	type: "image";
	source: { type: "base64"; mediaType: string; data: string };
}

export interface ParsedInbound {
	text: string;
	resources: Array<{ type: "image" | "file"; key: string; name?: string }>;
}

export interface ResolvedInbound {
	prompt: string;
	images: PromptImage[];
}

export function parseInboundContent(messageType: string, raw: string): ParsedInbound {
	let value: any;
	try {
		value = JSON.parse(raw);
	} catch {
		return { text: "", resources: [] };
	}
	if (messageType === "text") return { text: String(value?.text ?? "").trim(), resources: [] };
	if (messageType === "image" && value?.image_key) {
		return { text: "请分析这张图片。", resources: [{ type: "image", key: value.image_key }] };
	}
	if (["file", "audio", "media"].includes(messageType) && value?.file_key) {
		return {
			text:
				messageType === "audio"
					? "收到一段音频。"
					: messageType === "media"
						? "收到一个视频。"
						: "请查看这个文件。",
			resources: [{ type: "file", key: value.file_key, name: value.file_name }],
		};
	}
	if (messageType === "post") return parsePost(value);
	return { text: `[收到暂不支持的飞书消息类型：${messageType}]`, resources: [] };
}

function parsePost(value: any): ParsedInbound {
	const body = value?.zh_cn ?? value?.en_us ?? value?.ja_jp ?? value;
	const lines: string[] = body?.title ? [`# ${body.title}`] : [];
	const resources: ParsedInbound["resources"] = [];
	for (const row of body?.content ?? []) {
		let line = "";
		for (const item of row ?? []) {
			if (item.tag === "text") line += item.text ?? "";
			else if (item.tag === "a") line += `[${item.text ?? item.href}](${item.href})`;
			else if (item.tag === "at") line += `@${item.user_name ?? item.user_id ?? "user"}`;
			else if (item.tag === "img" && item.image_key) {
				resources.push({ type: "image", key: item.image_key });
				line += " [图片] ";
			} else if (item.tag === "media" && item.file_key) {
				resources.push({ type: "file", key: item.file_key });
				line += " [文件] ";
			}
		}
		if (line.trim()) lines.push(line.trim());
	}
	return { text: lines.join("\n").trim() || "请查看这条富文本消息。", resources };
}

export async function resolveInboundResources(
	client: LarkSdkClient,
	messageId: string,
	parsed: ParsedInbound,
	mediaDir: string,
	maxBytes = 30 * 1024 * 1024,
): Promise<ResolvedInbound> {
	const images: PromptImage[] = [];
	const fileLines: string[] = [];
	await mkdir(mediaDir, { recursive: true });
	for (const resource of parsed.resources) {
		const response = await (client.im.messageResource.get as any)({
			path: { message_id: messageId, file_key: resource.key },
			params: { type: resource.type === "image" ? "image" : "file" },
		});
		const { buffer, contentType, fileName } = await responseBuffer(response);
		if (buffer.length > maxBytes) throw new Error(`飞书附件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
		if (resource.type === "image") {
			images.push({
				type: "image",
				source: {
					type: "base64",
					mediaType: contentType || detectImageType(buffer),
					data: buffer.toString("base64"),
				},
			});
		} else {
			const safeName = sanitizeFileName(resource.name || fileName || `${resource.key}.bin`);
			const path = resolve(mediaDir, `${Date.now()}-${safeName}`);
			await writeFile(path, buffer);
			fileLines.push(`[飞书附件已保存：${path}]`);
		}
	}
	return { prompt: [parsed.text, ...fileLines].filter(Boolean).join("\n\n"), images };
}

async function responseBuffer(response: any): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
	const contentType = response?.headers?.["content-type"] ?? response?.contentType;
	const disposition = response?.headers?.["content-disposition"] ?? response?.headers?.["Content-Disposition"];
	const fileName = typeof disposition === "string" ? decodeFileName(disposition) : undefined;
	if (Buffer.isBuffer(response)) return { buffer: response, contentType, fileName };
	if (response instanceof ArrayBuffer) return { buffer: Buffer.from(response), contentType, fileName };
	if (Buffer.isBuffer(response?.data)) return { buffer: response.data, contentType, fileName };
	if (response?.data instanceof ArrayBuffer) return { buffer: Buffer.from(response.data), contentType, fileName };
	const stream =
		typeof response?.getReadableStream === "function" ? await response.getReadableStream() : response?.data;
	if (stream && (typeof stream[Symbol.asyncIterator] === "function" || stream instanceof Readable)) {
		const chunks: Buffer[] = [];
		for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		return { buffer: Buffer.concat(chunks), contentType, fileName };
	}
	throw new Error("无法读取飞书附件响应");
}

function detectImageType(buffer: Buffer): string {
	if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
	if (buffer.subarray(0, 6).toString("ascii").startsWith("GIF")) return "image/gif";
	if (buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return "image/jpeg";
}

function sanitizeFileName(name: string): string {
	return (
		name
			.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
			.replace(/^\.+/, "_")
			.slice(0, 180) || "attachment.bin"
	);
}

function decodeFileName(disposition: string): string | undefined {
	const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
	if (!match) return undefined;
	try {
		return decodeURIComponent(match[1].trim());
	} catch {
		return match[1].trim();
	}
}
