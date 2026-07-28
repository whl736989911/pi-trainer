export interface Logger {
	info(message: string, details?: unknown): void;
	warn(message: string, details?: unknown): void;
	error(message: string, details?: unknown): void;
}

function emit(level: string, message: string, details?: unknown): void {
	const suffix = details === undefined ? "" : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
	process.stdout.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`);
}

export const logger: Logger = {
	info: (message, details) => emit("info", message, details),
	warn: (message, details) => emit("warn", message, details),
	error: (message, details) => emit("error", message, details),
};
