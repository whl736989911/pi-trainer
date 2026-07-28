import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GatewayConfig } from "./types.ts";

interface StoredToken {
	appId: string;
	userOpenId: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	refreshExpiresAt: number;
	scope: string;
}

export interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresIn: number;
	interval: number;
}

export class OAuthManager {
	private readonly config: GatewayConfig;
	private readonly tokenDir: string;
	private readonly keyPath: string;
	private readonly refreshLocks = new Map<string, Promise<string>>();

	constructor(config: GatewayConfig) {
		this.config = config;
		this.tokenDir = resolve(config.dataDir, "credentials");
		this.keyPath = resolve(this.tokenDir, "master.key");
	}

	async begin(_userOpenId: string): Promise<DeviceAuthorization> {
		if (this.config.oauthScopes.length === 0) {
			throw new Error("PI_LARK_OAUTH_SCOPES is empty; configure the user scopes enabled for the Feishu app");
		}
		const endpoint = `${this.accountsBase()}/oauth/v1/device_authorization`;
		const scope = [...new Set([...this.config.oauthScopes, "offline_access"])].join(" ");
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Basic ${Buffer.from(`${this.config.appId}:${this.config.appSecret}`).toString("base64")}`,
			},
			body: new URLSearchParams({ client_id: this.config.appId, scope }),
		});
		const data = (await response.json()) as any;
		if (!response.ok || data.error)
			throw new Error(data.error_description || data.error || `HTTP ${response.status}`);
		return {
			deviceCode: data.device_code,
			userCode: data.user_code,
			verificationUri: data.verification_uri,
			verificationUriComplete: data.verification_uri_complete || data.verification_uri,
			expiresIn: data.expires_in || 240,
			interval: data.interval || 5,
		};
	}

	async complete(
		userOpenId: string,
		authorization: DeviceAuthorization,
		signal?: AbortSignal,
	): Promise<{ userOpenId: string }> {
		const deadline = Date.now() + authorization.expiresIn * 1000;
		let interval = authorization.interval;
		while (Date.now() < deadline) {
			await sleep(interval * 1000, signal);
			const response = await fetch(`${this.openBase()}/open-apis/authen/v2/oauth/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: authorization.deviceCode,
					client_id: this.config.appId,
					client_secret: this.config.appSecret,
				}),
				signal,
			});
			const data = (await response.json()) as any;
			if (data.access_token) {
				const actualUserOpenId = await this.resolveIdentity(data.access_token, userOpenId || undefined);
				const now = Date.now();
				await this.save({
					appId: this.config.appId,
					userOpenId: actualUserOpenId,
					accessToken: data.access_token,
					refreshToken: data.refresh_token || "",
					expiresAt: now + (data.expires_in || 7200) * 1000,
					refreshExpiresAt: now + (data.refresh_token_expires_in || data.expires_in || 7200) * 1000,
					scope: data.scope || "",
				});
				return { userOpenId: actualUserOpenId };
			}
			if (data.error === "authorization_pending") continue;
			if (data.error === "slow_down") {
				interval = Math.min(60, interval + 5);
				continue;
			}
			throw new Error(data.error_description || data.error || data.msg || "OAuth authorization failed");
		}
		throw new Error("授权超时，请重新发起");
	}

	async accessToken(userOpenId: string): Promise<string> {
		const stored = await this.load(userOpenId);
		if (!stored) throw new Error("当前飞书用户尚未授权，请发送“授权”完成授权");
		if (Date.now() < stored.expiresAt - 5 * 60 * 1000) return stored.accessToken;
		if (!stored.refreshToken || Date.now() >= stored.refreshExpiresAt) {
			await this.revoke(userOpenId);
			throw new Error("飞书用户授权已过期，请重新发送“授权”");
		}
		const existing = this.refreshLocks.get(userOpenId);
		if (existing) return existing;
		const refreshing = this.refresh(userOpenId, stored).finally(() => this.refreshLocks.delete(userOpenId));
		this.refreshLocks.set(userOpenId, refreshing);
		return refreshing;
	}

	async revoke(userOpenId: string): Promise<void> {
		try {
			await unlink(this.tokenPath(userOpenId));
		} catch {
			/* missing */
		}
	}

	private async refresh(userOpenId: string, stored: StoredToken): Promise<string> {
		const response = await fetch(`${this.openBase()}/open-apis/authen/v2/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: stored.refreshToken,
				client_id: this.config.appId,
				client_secret: this.config.appSecret,
			}),
		});
		const data = (await response.json()) as any;
		if (!data.access_token) {
			await this.revoke(userOpenId);
			throw new Error(data.error_description || data.error || data.msg || "刷新飞书授权失败");
		}
		const now = Date.now();
		const updated: StoredToken = {
			...stored,
			accessToken: data.access_token,
			refreshToken: data.refresh_token || stored.refreshToken,
			expiresAt: now + (data.expires_in || 7200) * 1000,
			refreshExpiresAt: data.refresh_token_expires_in
				? now + data.refresh_token_expires_in * 1000
				: stored.refreshExpiresAt,
			scope: data.scope || stored.scope,
		};
		await this.save(updated);
		return updated.accessToken;
	}

	private async resolveIdentity(accessToken: string, expectedOpenId?: string): Promise<string> {
		const response = await fetch(`${this.openBase()}/open-apis/authen/v1/user_info`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		const data = (await response.json()) as any;
		const actualOpenId = data.data?.open_id as string | undefined;
		if (data.code !== 0 || !actualOpenId) throw new Error(data.msg || "无法获取授权用户身份");
		if (expectedOpenId && actualOpenId !== expectedOpenId) {
			throw new Error("完成授权的飞书用户与当前消息发送者不一致");
		}
		return actualOpenId;
	}

	private async load(userOpenId: string): Promise<StoredToken | null> {
		try {
			const key = await this.masterKey();
			const encrypted = await readFile(this.tokenPath(userOpenId));
			if (encrypted.length < 28) return null;
			const iv = encrypted.subarray(0, 12);
			const tag = encrypted.subarray(12, 28);
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAuthTag(tag);
			return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString("utf8"));
		} catch {
			return null;
		}
	}

	private async save(token: StoredToken): Promise<void> {
		const key = await this.masterKey();
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const encrypted = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
		await writeFile(this.tokenPath(token.userOpenId), Buffer.concat([iv, cipher.getAuthTag(), encrypted]), {
			mode: 0o600,
		});
		if (process.platform !== "win32") await chmod(this.tokenPath(token.userOpenId), 0o600);
	}

	private async masterKey(): Promise<Buffer> {
		await mkdir(this.tokenDir, { recursive: true, mode: 0o700 });
		if (existsSync(this.keyPath)) {
			const key = await readFile(this.keyPath);
			if (key.length === 32) return key;
		}
		const key = randomBytes(32);
		await writeFile(this.keyPath, key, { mode: 0o600 });
		if (process.platform !== "win32") await chmod(this.keyPath, 0o600);
		return key;
	}

	private tokenPath(userOpenId: string): string {
		const name = `${this.config.appId}_${userOpenId}`.replace(/[^a-zA-Z0-9._-]/g, "_");
		return resolve(this.tokenDir, `${name}.enc`);
	}
	private openBase(): string {
		return this.config.brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
	}
	private accountsBase(): string {
		return this.config.brand === "lark" ? "https://accounts.larksuite.com" : "https://accounts.feishu.cn";
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolveSleep, reject) => {
		const timer = setTimeout(resolveSleep, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			},
			{ once: true },
		);
	});
}
