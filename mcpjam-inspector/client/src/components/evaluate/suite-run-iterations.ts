import { DEFAULTS } from "../evals/constants";
import type { EvalSuite } from "../evals/types";

export const MAX_RUN_ITERATIONS = 10;

const REMEMBERED_ITERATIONS_PREFIX = "mcpjam:suite-run-iterations";

export function isValidRunIterations(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_RUN_ITERATIONS
  );
}

function readRememberedIterations(suiteId: string): number | null {
  try {
    const value = Number(
      localStorage.getItem(`${REMEMBERED_ITERATIONS_PREFIX}:${suiteId}`),
    );
    return isValidRunIterations(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberIterations(suiteId: string, count: number) {
  try {
    localStorage.setItem(
      `${REMEMBERED_ITERATIONS_PREFIX}:${suiteId}`,
      String(count),
    );
  } catch {
    // Storage can be blocked; the sheet then falls back to the suite default.
  }
}

/**
 * The per-case iteration count a suite run launches with. Setup Run starts
 * from this and agent-started runs use it as-is, so both surfaces plan the
 * same run. `preferred` wins over the remembered and suite defaults; `floor`
 * defaults to the suite minimum.
 */
export function suiteRunIterations(
  suite: Pick<EvalSuite, "_id" | "minIterations" | "verdictPolicyDefaults">,
  { preferred, floor }: { preferred?: number; floor?: number } = {},
): number {
  return Math.min(
    MAX_RUN_ITERATIONS,
    Math.max(
      preferred ??
        readRememberedIterations(suite._id) ??
        suite.verdictPolicyDefaults?.repetitions ??
        DEFAULTS.RUNS_PER_TEST,
      floor ?? suite.minIterations ?? 1,
    ),
  );
}

/** An agent-requested count, or null when `requested` is not 1-10. */
export function agentRunIterations(
  suite: Parameters<typeof suiteRunIterations>[0],
  requested: unknown,
): number | null {
  if (requested === undefined) return suiteRunIterations(suite);
  if (!isValidRunIterations(requested)) return null;
  return suiteRunIterations(suite, { preferred: requested });
}
