import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { GatewayConfig } from "./types.ts";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function defaultDataDir(): string {
	return process.platform === "win32"
		? resolve(process.env.LOCALAPPDATA || homedir(), "pi-lark")
		: resolve(process.env.XDG_DATA_HOME || resolve(homedir(), ".local/share"), "pi-lark");
}

export async function saveStoredConfig(dataDir: string, config: Partial<GatewayConfig>): Promise<void> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const key = await loadOrCreateKey(dataDir);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
	const path = resolve(dataDir, "config.enc");
	await writeFile(path, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
	if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function loadStoredConfig(dataDir: string): Promise<Partial<GatewayConfig>> {
	const path = resolve(dataDir, "config.enc");
	if (!existsSync(path)) return {};
	const key = await loadOrCreateKey(dataDir);
	const payload = await readFile(path);
	if (payload.length < IV_BYTES + TAG_BYTES) throw new Error(`Invalid encrypted config: ${path}`);
	const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, IV_BYTES));
	decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
	return JSON.parse(
		Buffer.concat([decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8"),
	);
}

async function loadOrCreateKey(dataDir: string): Promise<Buffer> {
	const keyPath = resolve(dataDir, "config.key");
	if (existsSync(keyPath)) {
		const key = await readFile(keyPath);
		if (key.length === 32) return key;
		throw new Error(`Invalid config encryption key: ${keyPath}`);
	}
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const key = randomBytes(32);
	await writeFile(keyPath, key, { mode: 0o600 });
	if (process.platform !== "win32") await chmod(keyPath, 0o600);
	return key;
}
