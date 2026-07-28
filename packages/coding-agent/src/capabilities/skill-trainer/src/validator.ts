import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { validateClosure } from "./compiler.ts";
import { trainingDefinitionHash } from "./fingerprint.ts";
import { verifyReplayResourceIsolation } from "./replay-resource-loader.ts";
import type { TrainingState } from "./types.ts";

export interface ValidationReport {
	closure: ReturnType<typeof validateClosure>;
	artifactFiles: { valid: boolean; missing: string[] };
	replayResources?: Record<string, number | boolean>;
	cleanEnvironment?: { valid: boolean; engine: string; output: string };
}

const REQUIRED_FILES = [
	"SKILL.md",
	"SETUP.md",
	"TOOLS.md",
	"DATA.md",
	"RULES.md",
	"FORMULAS.md",
	"STEPS.md",
	"DECISIONS.md",
	"EXAMPLES.md",
	"TESTS.md",
	"scripts/setup.sh",
	"scripts/validate.sh",
];

export async function validateSkill(state: TrainingState, cleanEnvironment: boolean): Promise<ValidationReport> {
	const closure = validateClosure(state);
	const artifactPath = state.artifact?.path;
	if (state.artifact && (state.artifact.stale || state.artifact.stateHash !== trainingDefinitionHash(state))) {
		throw new Error("编译产物已过期，请重新编译当前训练状态");
	}
	const missing = artifactPath
		? REQUIRED_FILES.filter((file) => !existsSync(resolve(artifactPath, file)))
		: [...REQUIRED_FILES];
	const report: ValidationReport = { closure, artifactFiles: { valid: missing.length === 0, missing } };
	if (artifactPath && missing.length === 0) report.replayResources = await verifyReplayResourceIsolation(artifactPath);
	if (cleanEnvironment) {
		if (!artifactPath || missing.length) throw new Error("必须先成功编译技能，才能执行干净环境验证");
		report.cleanEnvironment = await runSandbox(artifactPath);
	}
	return report;
}

async function runSandbox(artifactPath: string): Promise<{ valid: boolean; engine: string; output: string }> {
	const custom = process.env.PI_SKILL_TRAINER_SANDBOX_COMMAND;
	if (custom) {
		const command = custom.replaceAll("{skill}", artifactPath);
		const result = await run(
			process.platform === "win32" ? "cmd.exe" : "bash",
			process.platform === "win32" ? ["/c", command] : ["-lc", command],
		);
		return { valid: result.code === 0, engine: "custom", output: result.output };
	}
	const probe = await run("docker", ["--version"]).catch(() => ({ code: 127, output: "Docker is not installed" }));
	if (probe.code !== 0)
		throw new Error(
			"没有可用的干净环境执行器。请安装 Docker，或设置 PI_SKILL_TRAINER_SANDBOX_COMMAND（用 {skill} 表示技能目录）",
		);
	const mount = `${artifactPath}:/skill`;
	const result = await run("docker", [
		"run",
		"--rm",
		"-v",
		mount,
		"-w",
		"/skill",
		"node:22-bookworm",
		"bash",
		"-lc",
		"chmod +x scripts/setup.sh scripts/validate.sh && scripts/setup.sh && scripts/validate.sh",
	]);
	return { valid: result.code === 0, engine: "docker:node:22-bookworm", output: result.output };
}

function run(command: string, args: string[]): Promise<{ code: number; output: string }> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { windowsHide: true });
		let output = "";
		child.stdout?.on("data", (data) => {
			output += String(data);
		});
		child.stderr?.on("data", (data) => {
			output += String(data);
		});
		child.once("error", reject);
		child.once("exit", (code) => resolveRun({ code: code ?? 1, output: output.slice(-20000) }));
	});
}
