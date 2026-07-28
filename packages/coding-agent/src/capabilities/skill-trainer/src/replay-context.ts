import { AsyncLocalStorage } from "node:async_hooks";

const key = Symbol.for("@local/pi-skill-trainer/replay-context");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
const existing = globals[key];
const storage = existing instanceof AsyncLocalStorage ? existing : new AsyncLocalStorage<boolean>();
if (!existing) globals[key] = storage;
export function runAsFormalReplay<T>(callback: () => T): T {
	return storage.run(true, callback);
}
export function isFormalReplay(): boolean {
	return storage.getStore() === true;
}
