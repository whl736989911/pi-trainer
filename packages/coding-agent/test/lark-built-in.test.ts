import { afterEach, describe, expect, test, vi } from "vitest";
import { handleLarkCommand } from "../src/capabilities/lark/src/cli.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const originalWrite = process.stdout.write;

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.restoreAllMocks();
});

describe("built-in Lark capability", () => {
	test("registers Lark and Skill Trainer as built-in extensions", () => {
		expect(builtInExtensions.map((extension) => extension.name)).toEqual(
			expect.arrayContaining(["lark", "skill-trainer"]),
		);
	});

	test("handles the pi lark help command before generic argument parsing", async () => {
		let output = "";
		process.stdout.write = ((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write;
		await expect(handleLarkCommand(["lark", "help"])).resolves.toBe(true);
		expect(output).toContain("pi lark");
		expect(output).toContain("serve");
	});
});
