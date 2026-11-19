/**
 * Code evaluators as the inspector runs them. Hand-mirrored from the
 * backend's `convex/lib/codeEvaluators.ts`.
 */
export type CodeEvaluatorDefinition = {
  id: string;
  label: string;
  source: string;
  role: "required" | "advisory";
  basedOn?: { id: string; version: number };
};

/** One evaluator's outcome on one trial. `logs` is what the code printed. */
export type CodeEvaluatorRunResult =
  | {
      status: "scored";
      pass: boolean;
      score?: number;
      reason: string;
      logs?: string;
    }
  | { status: "error"; reason: string; logs?: string };

/**
 * Persisted on `metadata.codeEvaluatorResults`, in suite order.
 * `sourceDigest` names the exact source the trial ran.
 */
export type CodeEvaluatorOutcome = {
  id: string;
  label: string;
  role: "required" | "advisory";
  sourceDigest: string;
} & CodeEvaluatorRunResult;

/** Runs prepared JavaScript against one trial's run data. */
export interface CodeEvaluatorRunner {
  readonly kind: "e2b" | "local";
  run(args: { module: string; runJson: string }): Promise<CodeEvaluatorRunResult>;
  close(): Promise<void>;
}

/** Parses a stored or posted list; anything malformed is dropped. */
export function parseCodeEvaluators(raw: unknown): CodeEvaluatorDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const e = item as Record<string, unknown>;
    if (
      typeof e.id !== "string" ||
      typeof e.label !== "string" ||
      typeof e.source !== "string" ||
      (e.role !== "required" && e.role !== "advisory")
    ) {
      return [];
    }
    return [{ id: e.id, label: e.label, source: e.source, role: e.role }];
  });
}
