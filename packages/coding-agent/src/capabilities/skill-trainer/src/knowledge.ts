import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { acquireFileLock } from "./file-lock.ts";

export type KnowledgeStatus =
	| "unprocessed"
	| "organized"
	| "candidate"
	| "confirmed"
	| "linked_to_skill"
	| "materialized"
	| "rejected"
	| "deleted";
export interface KnowledgeItem {
	id: string;
	contentType: "user_message" | "assistant_message" | "tool_result" | "file" | "image" | "note";
	rawContent?: string;
	blobRef?: string;
	contentHash: string;
	summary?: string;
	topics: string[];
	tags: string[];
	sourceSessionId: string;
	sourceMessageId?: string;
	sourceDetail?: string;
	possibleSkills: string[];
	scope?: string;
	status: KnowledgeStatus;
	confirmationEvidence?: { piSessionId: string; entryId?: string; confirmedAt: string };
	linkedSkills: Array<{ skillKey: string; dataId?: string; linkedAt: string }>;
	createdAt: string;
	updatedAt: string;
}

export class KnowledgeStore {
	readonly root: string;
	private queue: Promise<void> = Promise.resolve();

	constructor(root: string) {
		this.root = root;
	}

	async list(filter?: { status?: KnowledgeStatus; topic?: string; skill?: string }): Promise<KnowledgeItem[]> {
		const items = await this.readIndex();
		return items
			.filter((item) => !filter?.status || item.status === filter.status)
			.filter((item) => !filter?.topic || item.topics.includes(filter.topic))
			.filter(
				(item) =>
					!filter?.skill ||
					item.possibleSkills.includes(filter.skill) ||
					item.linkedSkills.some((link) => link.skillKey === filter.skill),
			);
	}

	async get(id: string): Promise<KnowledgeItem | undefined> {
		return (await this.list()).find((item) => item.id === id);
	}

	async readContent(item: KnowledgeItem): Promise<string> {
		if (item.rawContent !== undefined) return item.rawContent;
		if (!item.blobRef) return "";
		const path = resolve(this.root, "knowledge", item.blobRef);
		if (!path.startsWith(resolve(this.root, "knowledge"))) throw new Error("Invalid knowledge blob path");
		return readFile(path, "utf8");
	}

	async search(query: string, limit = 20): Promise<KnowledgeItem[]> {
		const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
		const scored = (await this.list())
			.filter((item) => item.status !== "deleted")
			.map((item) => {
				const haystack = [item.rawContent, item.summary, ...item.topics, ...item.tags, ...item.possibleSkills]
					.filter(Boolean)
					.join(" ")
					.toLocaleLowerCase();
				return { item, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
			});
		return scored
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
			.slice(0, limit)
			.map((entry) => entry.item);
	}

	async add(
		input: Omit<KnowledgeItem, "id" | "contentHash" | "linkedSkills" | "createdAt" | "updatedAt"> & { id?: string },
	): Promise<KnowledgeItem> {
		return this.lock(async () => {
			const items = await this.readIndex();
			const rawPayload = input.rawContent ?? "";
			const hash = createHash("sha256")
				.update(`${input.contentType}\0${rawPayload}\0${input.blobRef ?? ""}`)
				.digest("hex");
			const duplicate = items.find(
				(item) =>
					item.contentHash === hash && item.sourceSessionId === input.sourceSessionId && item.status !== "deleted",
			);
			if (duplicate) return duplicate;
			const now = new Date().toISOString();
			let rawContent = input.rawContent;
			let blobRef = input.blobRef;
			if (rawPayload.length > 64 * 1024) {
				const blobPath = resolve(this.root, "knowledge", "blobs", `${hash}.txt`);
				await mkdir(resolve(this.root, "knowledge", "blobs"), { recursive: true });
				if (!existsSync(blobPath)) await writeFile(blobPath, rawPayload, "utf8");
				rawContent = undefined;
				blobRef = `blobs/${hash}.txt`;
			}
			const item: KnowledgeItem = {
				...input,
				rawContent,
				blobRef,
				id: input.id || `KNOWLEDGE-${randomUUID()}`,
				contentHash: hash,
				linkedSkills: [],
				createdAt: now,
				updatedAt: now,
			};
			items.push(item);
			await this.writeIndex(items);
			return item;
		});
	}

	async update(
		id: string,
		patch: Partial<Omit<KnowledgeItem, "id" | "contentHash" | "createdAt">>,
	): Promise<KnowledgeItem> {
		return this.lock(async () => {
			const items = await this.readIndex();
			const item = items.find((entry) => entry.id === id);
			if (!item) throw new Error(`Unknown knowledge item: ${id}`);
			Object.assign(item, patch, {
				id: item.id,
				contentHash: item.contentHash,
				createdAt: item.createdAt,
				updatedAt: new Date().toISOString(),
			});
			await this.writeIndex(items);
			return item;
		});
	}

	async link(id: string, skillKey: string, dataId?: string): Promise<KnowledgeItem> {
		const items = await this.list();
		const item = items.find((entry) => entry.id === id);
		if (!item) throw new Error(`Unknown knowledge item: ${id}`);
		const links = item.linkedSkills.filter((link) => link.skillKey !== skillKey || link.dataId !== dataId);
		links.push({ skillKey, dataId, linkedAt: new Date().toISOString() });
		return this.update(id, { linkedSkills: links, status: dataId ? "materialized" : "linked_to_skill" });
	}

	private async readIndex(): Promise<KnowledgeItem[]> {
		const path = resolve(this.root, "knowledge", "index.json");
		if (!existsSync(path)) return [];
		try {
			const value = JSON.parse(await readFile(path, "utf8"));
			if (!Array.isArray(value)) throw new Error("Knowledge index is not an array");
			return value as KnowledgeItem[];
		} catch (error) {
			const backup = `${path}.bak`;
			if (!existsSync(backup)) throw new Error(`Knowledge index is corrupt: ${String(error)}`);
			const value = JSON.parse(await readFile(backup, "utf8"));
			if (!Array.isArray(value)) throw new Error("Knowledge index backup is corrupt");
			return value as KnowledgeItem[];
		}
	}

	private async writeIndex(items: KnowledgeItem[]): Promise<void> {
		const path = resolve(this.root, "knowledge", "index.json");
		await mkdir(resolve(this.root, "knowledge"), { recursive: true });
		const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(items, null, 2)}\n`, "utf8");
		if (existsSync(path)) await copyFile(path, `${path}.bak`);
		await rename(temp, path);
		const verify = JSON.parse(await readFile(path, "utf8"));
		if (!Array.isArray(verify)) throw new Error("Knowledge index verification failed");
	}

	private async lock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.queue;
		let release!: () => void;
		const current = new Promise<void>((resolveQueue) => {
			release = resolveQueue;
		});
		this.queue = previous.then(() => current);
		await previous;
		let releaseFile: (() => Promise<void>) | undefined;
		try {
			releaseFile = await acquireFileLock(resolve(this.root, "knowledge", ".index.lock"));
			return await operation();
		} finally {
			await releaseFile?.();
			release();
		}
	}
}
