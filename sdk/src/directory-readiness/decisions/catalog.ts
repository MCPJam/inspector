/**
 * The judgement questions a run may put to MCPJam's decision model, mirrored
 * from the backend's catalog, which holds the prompts: ids, verdicts and the
 * inputs each reads, never question text. Pure data. Safe from the browser.
 */

export type DirectoryDecisionDirectory = "claude" | "openai";
type Need = "required" | "optional";

export interface DirectoryDecisionQuestion {
  id: string;
  /** The runs that may ask it. */
  directories: readonly DirectoryDecisionDirectory[];
  /** Every verdict the model may give, the violation first. */
  verdicts: readonly string[];
  violation: string;
  /** What a candidate carries beyond `key`, `field` and `text`. */
  inputs: Readonly<{ tool?: Need; references?: Need; annotations?: Need }>;
  /** What a violation is, and its fix, for a finding's remediation. */
  problem: string;
  fix: string;
}

const QUESTIONS = [
  {
    id: "claude.decision.cross-tool-direction",
    directories: ["claude"],
    verdicts: ["direction", "reference", "unsure"],
    violation: "direction",
    inputs: { tool: "required", references: "required" },
    problem: "a direction to call another tool",
    fix: "Rewrite each as a fact about its own tool. A sentence that only names another tool can stay.",
  },
  {
    id: "openai.decision.fair-play",
    directories: ["openai"],
    verdicts: ["steers", "fair", "unsure"],
    violation: "steers",
    inputs: { tool: "optional" },
    problem: "text that steers the choice of plugin or compares it with others",
    fix: "Say what the plugin does without telling the model to prefer it or comparing it with alternatives.",
  },
  {
    id: "openai.decision.secret-seeking",
    directories: ["openai"],
    verdicts: ["seeks", "clean", "unsure"],
    violation: "seeks",
    inputs: { tool: "optional" },
    problem: "a request for a secret or for protected context",
    fix: "Remove the request. Sign-in, not tool text, supplies credentials.",
  },
  {
    id: "both.decision.annotation-matches-behaviour",
    directories: ["claude", "openai"],
    verdicts: ["mismatch", "matches", "unsure"],
    violation: "mismatch",
    inputs: { tool: "required", annotations: "required" },
    problem: "a description that contradicts its tool's annotations",
    fix: "Change the annotations or the description so they agree.",
  },
] as const satisfies readonly DirectoryDecisionQuestion[];

export type DirectoryDecisionQuestionId = (typeof QUESTIONS)[number]["id"];

export const DIRECTORY_DECISION_QUESTIONS: readonly (DirectoryDecisionQuestion & {
  id: DirectoryDecisionQuestionId;
})[] = QUESTIONS;

/** The verdict every question has for text that settles nothing. */
export const DIRECTORY_DECISION_UNSURE = "unsure";

/** The backend's bounds; it refuses a request outside them rather than cut it. */
export const DIRECTORY_DECISION_LIMITS = Object.freeze({
  maxQuestionsPerRun: 24,
  maxKeyChars: 200,
  maxNameChars: 200,
  maxFieldChars: 300,
  maxTextChars: 2_000,
  maxReferences: 10,
  maxQuoteChars: 400,
});

export function directoryDecisionQuestion(id: string) {
  return DIRECTORY_DECISION_QUESTIONS.find((question) => question.id === id);
}

/** The four MCP hints; a candidate carries the ones its tool declares. */
export interface DirectoryDecisionAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

const HINT = /^(?:readOnly|destructive|idempotent|openWorld)Hint$/;

/** The boolean hints among a tool's annotations; `undefined` without one. */
export function decisionHints(
  annotations: unknown
): DirectoryDecisionAnnotations | undefined {
  const hints: Record<string, boolean> = {};
  for (const [hint, value] of Object.entries(Object(annotations))) {
    if (HINT.test(hint) && typeof value === "boolean") hints[hint] = value;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

/** Model-readable text a rule picked: `text` exactly as `field` holds it. */
export interface DirectoryDecisionCandidate {
  /** Joins the answer back to it (`candidateKey`). */
  key: string;
  field: string;
  text: string;
  tool?: string;
  /** Other tools the text names. */
  references?: string[];
  annotations?: DirectoryDecisionAnnotations;
}

/** One entry of the request's `items`. */
export interface DirectoryDecisionItem {
  questionId: DirectoryDecisionQuestionId;
  candidate: DirectoryDecisionCandidate;
}

/** One answer as the backend returns it. */
export interface DirectoryDecisionAnswer {
  questionId: string;
  candidateKey: string;
  verdict: string;
  /** What the verdict rests on, as the model copied it. */
  quote: string;
  /** From 0 to 1. */
  confidence: number;
}
