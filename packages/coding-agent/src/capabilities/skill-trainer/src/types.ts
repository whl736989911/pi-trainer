export type TrainingStage = "defining" | "running" | "reviewing" | "systematizing";
export type DraftStatus = "candidate" | "confirmed" | "modified" | "removed";
export type DataStatus =
	| "model_prior"
	| "model_candidate"
	| "user_provided"
	| "source_confirmed"
	| "user_confirmed"
	| "conditional"
	| "case_only"
	| "pending"
	| "rejected"
	| "replaced";

export interface TrainingGoal {
	skillName: string;
	skillKey?: string;
	problem: string;
	inputs: string[];
	outputs: string[];
	roughProcess: string[];
}

export interface TrainingCase {
	id: string;
	name: string;
	input: unknown;
	result?: unknown;
	accepted?: boolean;
	notes?: string;
	acceptanceEvidence?: ConfirmationEvidence;
	createdAt: string;
	updatedAt: string;
}

export interface SkillStepDraft {
	id: string;
	order: number;
	name: string;
	goal: string;
	inputs: string[];
	instruction: string;
	toolRefs: string[];
	outputs: string[];
	doneWhen: string[];
	onFailure: string;
	status: DraftStatus;
}

export interface DecisionBranch {
	when: string;
	outcome: string;
}
export interface SkillDecisionDraft {
	id: string;
	stepId: string;
	question: string;
	branches: DecisionBranch[];
	dataRefs: string[];
	status: DraftStatus;
}

export interface SkillDataDraft {
	id: string;
	topic: string;
	type: "fact" | "parameter" | "rule" | "formula" | "term" | "example" | "constraint";
	name: string;
	value: unknown;
	unit?: string;
	status: DataStatus;
	sourceType: string;
	sourceDetail?: string;
	scope?: string;
	conditions: string[];
	exceptions: string[];
	onMissing?: string;
	usedIn: string[];
	confirmationEvidence?: ConfirmationEvidence;
}

export interface CorrectionRecord {
	id: string;
	targetType: "result" | "step" | "decision" | "data" | "tool" | "output";
	targetId?: string;
	oldValue?: unknown;
	newValue?: unknown;
	reasonType: string;
	reason: string;
	affected: string[];
	confirmedByUser: boolean;
	createdAt: string;
}

export interface ToolRecord {
	id: string;
	name: string;
	version?: string;
	provider?: string;
	providerExtensionPath?: string;
	providerApproval?: "candidate" | "user_approved" | "verified" | "rejected";
	inputSchemaHash?: string;
	purpose?: string;
	stepId?: string;
	inputSummary?: string;
	outputSummary?: string;
	affected?: string[];
	formalSkillRequired?: boolean;
	install?: Record<string, string>;
	installApproval?: "candidate" | "user_approved" | "verified" | "rejected";
	installSource?: string;
	successCheck?: string;
	failureHandling?: string;
	createdAt: string;
}

export interface ConfirmationEvidence {
	source: "user_message";
	piSessionId: string;
	entryId?: string;
	confirmedAt: string;
}

export interface TrainingTest {
	id: string;
	type: "replay" | "boundary";
	name: string;
	input: unknown;
	expectedChecks: string[];
	actualResult?: string;
	activeTools?: string[];
	accessLog?: Array<{ timestamp: string; tool: string; path: string; allowed: boolean; error?: string }>;
	status:
		| "draft"
		| "queued"
		| "running"
		| "pending_user_review"
		| "passed"
		| "failed"
		| "cancelled"
		| "timed_out"
		| "error"
		| "stale";
	userComment?: string;
	reviewEvidence?: ConfirmationEvidence;
	createdAt: string;
	updatedAt: string;
}

export interface CompiledArtifact {
	path: string;
	compiledAt: string;
	files: string[];
	closureValid: boolean;
	blockers: string[];
	stateHash?: string;
	artifactHash?: string;
	stale?: boolean;
}

export interface TrainingState {
	version: 1;
	id: string;
	piSessionId: string;
	stage: TrainingStage;
	goal?: TrainingGoal;
	cases: TrainingCase[];
	steps: SkillStepDraft[];
	decisions: SkillDecisionDraft[];
	data: SkillDataDraft[];
	corrections: CorrectionRecord[];
	tools: ToolRecord[];
	tests: TrainingTest[];
	artifact?: CompiledArtifact;
	createdAt: string;
	updatedAt: string;
}
