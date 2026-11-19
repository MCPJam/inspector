/**
 * Code evaluators as the suite settings edit them. Hand-mirrored from the
 * backend's `convex/lib/codeEvaluators.ts`.
 */
export type CodeEvaluator = {
  id: string;
  label: string;
  /** TypeScript exporting `evaluate(run)`; erasable types only. */
  source: string;
  role: "required" | "advisory";
  /** Started from a library starter. */
  basedOn?: { id: string; version: number };
};

export const MAX_CODE_EVALUATORS = 5;
export const MAX_CODE_EVALUATOR_SOURCE_CHARS = 20_000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Mirrors the backend's write-time checks, so a save is not refused later. */
export function codeEvaluatorProblem(
  evaluator: CodeEvaluator,
  others: readonly CodeEvaluator[],
): string | undefined {
  if (!evaluator.label.trim()) return "Give the evaluator a name.";
  if (!ID_PATTERN.test(evaluator.id)) {
    return "Use lowercase letters, digits and dashes for the id.";
  }
  if (others.some((o) => o.id === evaluator.id)) {
    return "Another code evaluator has this id.";
  }
  if (!evaluator.source.trim()) return "Write the evaluator's code.";
  if (evaluator.source.length > MAX_CODE_EVALUATOR_SOURCE_CHARS) {
    return `Keep the code under ${MAX_CODE_EVALUATOR_SOURCE_CHARS.toLocaleString()} characters.`;
  }
  if (!/\bevaluate\b/.test(evaluator.source)) {
    return "Export a function named evaluate.";
  }
  return undefined;
}

/** A lowercase id from a name, unique among `taken`. */
export function codeEvaluatorIdFor(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "code";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** The starters a new evaluator can begin from, opened as editable copies. */
export const CODE_EVALUATOR_STARTERS: ReadonlyArray<{
  id: string;
  version: number;
  label: string;
  role: CodeEvaluator["role"];
  source: string;
}> = [
  {
    id: "answer-cites-a-result",
    version: 1,
    label: "Answer cites a tool result",
    role: "advisory",
    source: `// run.toolResults: each tool result; run.finalAssistantMessage: the answer.
type Run = {
  finalAssistantMessage?: string;
  toolResults?: Array<{ toolName: string; text?: string; structuredContent?: unknown }>;
};

export function evaluate(run: Run) {
  const answer = run.finalAssistantMessage ?? "";
  // Numbers that appear in any tool result.
  const numbers = new Set<string>();
  for (const result of run.toolResults ?? []) {
    const text = result.text ?? JSON.stringify(result.structuredContent ?? "");
    for (const match of text.matchAll(/-?\\d+(\\.\\d+)?/g)) numbers.add(match[0]);
  }
  const cited = [...numbers].filter((n) => answer.includes(n));
  return cited.length > 0
    ? { pass: true, reason: \`The answer cites \${cited.slice(0, 3).join(", ")} from the tool results.\` }
    : { pass: false, reason: "The answer cites no number from the tool results." };
}
`,
  },
  {
    id: "no-empty-tool-results",
    version: 1,
    label: "No empty tool results",
    role: "required",
    source: `type Run = {
  toolResults?: Array<{ toolName: string; isError?: boolean; text?: string; structuredContent?: unknown }>;
};

export function evaluate(run: Run) {
  const empty = (run.toolResults ?? []).filter(
    (r) => !r.isError && !r.text?.trim() && r.structuredContent === undefined,
  );
  return empty.length === 0
    ? { pass: true, reason: "Every tool result had content." }
    : { pass: false, reason: \`\${empty.length} tool result(s) came back empty: \${empty.map((r) => r.toolName).join(", ")}.\` };
}
`,
  },
];
