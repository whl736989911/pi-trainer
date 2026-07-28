export function jsonResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

export function errorResult(error: unknown) {
	return jsonResult({ error: error instanceof Error ? error.message : String(error) });
}
