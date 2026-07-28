import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function acquireFileLock(
	path: string,
	options: { timeoutMs?: number; staleMs?: number; signal?: AbortSignal } = {},
): Promise<() => Promise<void>> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const staleMs = options.staleMs ?? 60_000;
	const started = Date.now();
	await mkdir(dirname(path), { recursive: true });
	for (;;) {
		options.signal?.throwIfAborted();
		try {
			const handle = await open(path, "wx");
			const token = randomUUID();
			await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				await handle.close().catch(() => undefined);
				try {
					const current = JSON.parse(await readFile(path, "utf8"));
					if (current.token === token) await rm(path, { force: true });
				} catch {
					/* lock was already removed or replaced */
				}
			};
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			if (await isStale(path, staleMs)) {
				await rm(path, { force: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() - started >= timeoutMs) {
				let owner = "unknown";
				try {
					owner = await readFile(path, "utf8");
				} catch {
					/* ignored */
				}
				throw new Error(`Timed out acquiring state lock ${path}; owner=${owner}`);
			}
			await delay(20 + Math.floor(Math.random() * 30), undefined, { signal: options.signal });
		}
	}
}

async function isStale(path: string, staleMs: number): Promise<boolean> {
	try {
		return Date.now() - (await stat(path)).mtimeMs > staleMs;
	} catch {
		return false;
	}
}
