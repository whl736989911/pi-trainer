import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { acquireFileLock } from "./file-lock.ts";
import { trainingDefinitionHash } from "./fingerprint.ts";
import type { TrainingState } from "./types.ts";

export class TrainingStore {
	readonly root: string;
	private readonly queues = new Map<string, Promise<void>>();

	constructor(root = process.env.PI_SKILL_TRAINER_DATA_DIR || resolve(homedir(), ".pi", "agent", "skill-training")) {
		this.root = resolve(root);
	}

	async get(piSessionId: string): Promise<TrainingState | null> {
		const primary = this.path(piSessionId);
		const legacy = this.legacyPath(piSessionId);
		const path = existsSync(primary) ? primary : existsSync(legacy) ? legacy : undefined;
		if (!path) return null;
		return this.readValidated(path, piSessionId);
	}

	async create(piSessionId: string): Promise<TrainingState> {
		return this.withLock(piSessionId, async () => {
			const existing = await this.get(piSessionId);
			if (existing) return existing;
			const state = newState(piSessionId);
			await this.saveUnlocked(state);
			return state;
		});
	}

	async update(piSessionId: string, mutate: (state: TrainingState) => void): Promise<TrainingState> {
		return this.withLock(piSessionId, async () => {
			const state = (await this.get(piSessionId)) ?? newState(piSessionId);
			const definitionBefore = trainingDefinitionHash(state);
			mutate(state);
			normalizeState(state);
			if (state.artifact && definitionBefore !== trainingDefinitionHash(state)) state.artifact.stale = true;
			state.updatedAt = new Date().toISOString();
			await this.saveUnlocked(state);
			return state;
		});
	}

	async save(state: TrainingState): Promise<void> {
		await this.withLock(state.piSessionId, async () => this.saveUnlocked(state));
	}

	private async readValidated(path: string, piSessionId: string): Promise<TrainingState> {
		try {
			const state = JSON.parse(await readFile(path, "utf8")) as TrainingState;
			validateState(state, piSessionId);
			normalizeState(state);
			return state;
		} catch (primaryError) {
			const backup = `${path}.bak`;
			if (!existsSync(backup)) throw new Error(`Training state is corrupt (${path}): ${String(primaryError)}`);
			const state = JSON.parse(await readFile(backup, "utf8")) as TrainingState;
			validateState(state, piSessionId);
			normalizeState(state);
			await this.saveUnlocked(state);
			return state;
		}
	}

	private async saveUnlocked(state: TrainingState): Promise<void> {
		validateState(state, state.piSessionId);
		const path = this.path(state.piSessionId);
		await mkdir(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		const serialized = `${JSON.stringify(state, null, 2)}\n`;
		JSON.parse(serialized);
		await writeFile(temp, serialized, { encoding: "utf8", flag: "wx" });
		try {
			if (existsSync(path)) await copyFile(path, `${path}.bak`);
			await rename(temp, path);
			const verify = JSON.parse(await readFile(path, "utf8")) as TrainingState;
			validateState(verify, state.piSessionId);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolveQueue) => {
			release = resolveQueue;
		});
		const queued = previous.then(() => current);
		this.queues.set(key, queued);
		await previous;
		let releaseFile: (() => Promise<void>) | undefined;
		try {
			releaseFile = await acquireFileLock(this.lockPath(key));
			return await operation();
		} finally {
			await releaseFile?.();
			release();
			if (this.queues.get(key) === queued) this.queues.delete(key);
		}
	}

	private lockPath(piSessionId: string): string {
		const hash = createHash("sha256").update(piSessionId).digest("hex").slice(0, 24);
		return resolve(this.root, "sessions", hash, ".state.lock");
	}

	private path(piSessionId: string): string {
		const hash = createHash("sha256").update(piSessionId).digest("hex").slice(0, 24);
		return resolve(this.root, "sessions", hash, "state.json");
	}

	private legacyPath(piSessionId: string): string {
		const safe = piSessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
		return resolve(this.root, "sessions", safe, "state.json");
	}
}

function newState(piSessionId: string): TrainingState {
	const now = new Date().toISOString();
	return {
		version: 1,
		id: randomUUID(),
		piSessionId,
		stage: "defining",
		cases: [],
		steps: [],
		decisions: [],
		data: [],
		corrections: [],
		tools: [],
		tests: [],
		createdAt: now,
		updatedAt: now,
	};
}

function normalizeState(state: TrainingState): void {
	state.cases ??= [];
	state.steps ??= [];
	state.decisions ??= [];
	state.data ??= [];
	state.corrections ??= [];
	state.tools ??= [];
	state.tests ??= [];
	for (const decision of state.decisions) {
		for (const branch of decision.branches) {
			const legacy = branch as typeof branch & { then?: string };
			if (!branch.outcome && legacy.then) branch.outcome = legacy.then;
			delete legacy.then;
		}
	}
}

function validateState(state: TrainingState, expectedSessionId: string): void {
	if (!state || typeof state !== "object") throw new Error("State must be an object");
	if (state.version !== 1) throw new Error(`Unsupported state version: ${String(state.version)}`);
	if (state.piSessionId !== expectedSessionId) throw new Error("State session ID mismatch");
	if (!state.id || !state.createdAt || !state.updatedAt) throw new Error("State metadata is incomplete");
	for (const field of ["cases", "steps", "decisions", "data", "corrections", "tools", "tests"] as const) {
		if (!Array.isArray(state[field])) throw new Error(`State field ${field} must be an array`);
	}
}
