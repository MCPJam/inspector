/**
 * One recorded iteration, projected to the row a reader can act on.
 *
 * Lives here rather than in `shared/actionable-insights/` because it reads
 * `EvalIteration` and the run's client identity, which are Evaluate's types;
 * the shared list component takes the projected rows and knows none of that.
 */
import type { EvalIteration } from "../evals/types";
import { computeIterationResult } from "../evals/pass-criteria";
import {
  type AffectedIterationRow,
  unloadedRow,
} from "@/components/shared/actionable-insights/affected-iterations-list";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { iterationReasoningEffort } from "../evals/run-metrics";
import { reasoningEffortLabel } from "@/components/effort/effort-control";

/** The iteration's model with the effort it ran at ("gpt-5.4-nano · High"). */
function modelWithEffort(iteration: EvalIteration): string | null {
  const model = iteration.testCaseSnapshot?.model ?? null;
  const effort = iterationReasoningEffort(iteration);
  return model && effort
    ? `${model} · ${reasoningEffortLabel(effort as ModelReasoningEffort)}`
    : model;
}

export function affectedRowFor(
  iteration: EvalIteration,
  clientLabel?: string | null,
): AffectedIterationRow {
  return {
    iterationId: iteration._id,
    caseTitle: iteration.testCaseSnapshot?.title ?? "Untitled case",
    iterationNumber: iteration.iterationNumber ?? null,
    client: clientLabel ?? null,
    model: modelWithEffort(iteration),
    result: computeIterationResult(iteration),
    canOpen: Boolean(iteration.testCaseId),
  };
}

/**
 * The lookup the findings block hands down, keyed by iteration id.
 *
 * An id the page has not loaded is NOT dropped by the consumer — it renders
 * as an unloaded row, so a finding's own count and its list agree.
 */
export function affectedRowsById(
  iterations: readonly EvalIteration[],
  clientLabel?: string | null,
  chains?: ReadonlyMap<string, EvalRunDecisionChain>,
  diagnostics: readonly EvalRunDecisionDiagnostic[] = [],
): Record<string, AffectedIterationRow> {
  // The run diagnostic is authoritative, as in the case report; the separate
  // chain read is page-capped and can miss an iteration it describes.
  const fromDiagnostics = new Map(
    diagnostics.map((row) => [row.iterationId, row.chain]),
  );
  const rows: Record<string, AffectedIterationRow> = {};
  for (const iteration of iterations) {
    rows[iteration._id] = {
      ...affectedRowFor(iteration, clientLabel),
      chain: fromDiagnostics.get(iteration._id) ?? chains?.get(iteration._id),
    };
  }
  // A diagnostic for an iteration whose metadata did not load still carries
  // its verified stage, so the rubric can read it by id.
  for (const [id, chain] of fromDiagnostics) {
    rows[id] ??= { ...unloadedRow(id), chain };
  }
  return rows;
}

/** Non-passing first, then by recorded iteration number. Stable for equal rows. */
export function sortAffectedRows(
  rows: readonly AffectedIterationRow[],
): AffectedIterationRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.result === "passed") - Number(b.result === "passed") ||
      (a.iterationNumber ?? Number.MAX_SAFE_INTEGER) -
        (b.iterationNumber ?? Number.MAX_SAFE_INTEGER),
  );
}
