import larkExtension from "../capabilities/lark/extensions/lark.ts";
import skillTrainerExtension from "../capabilities/skill-trainer/extensions/skill-trainer.ts";
import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "lark", factory: larkExtension, hidden: true },
	{ name: "skill-trainer", factory: skillTrainerExtension, hidden: true },
];
