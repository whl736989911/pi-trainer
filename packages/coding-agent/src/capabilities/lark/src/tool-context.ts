import { AsyncLocalStorage } from "node:async_hooks";
import type { Route } from "./types.ts";

interface ContextGlobals {
	[key: symbol]: AsyncLocalStorage<Route> | undefined;
}

const key = Symbol.for("@earendil-works/pi-trainer/lark-tool-context");
const globals = globalThis as unknown as ContextGlobals;
const existingStorage = globals[key];
const storage = existingStorage ?? new AsyncLocalStorage<Route>();
if (!existingStorage) globals[key] = storage;

export function runWithLarkContext<T>(route: Route, callback: () => T): T {
	return storage.run(route, callback);
}

export function currentLarkContext(): Route | undefined {
	return storage.getStore();
}
