/**
 * The hosted runner's platform checks as score rows.
 *
 * `buildEvalIterationVerdict` fails an iteration on a tool error, a pinned
 * tool error, an iteration error or a failed widget check. Each of those now
 * also writes a row, so the rows alone give the verdict the boolean gives and
 * a reader can see from them why an iteration failed.
 *
 * Roles mirror the boolean exactly: tool errors (trace and pinned) follow the
 * case's `failOnToolError`; an iteration error and a widget check always fail.
 */
import {
  ITERATION_ERROR_SCORER_ID,
  TOOL_EXECUTION_SCORER_ID,
  WIDGET_CHECK_SCORER_ID,
  iterationErrorScoreDefinition,
  iterationErrorScoreResult,
  toolExecutionScoreDefinition,
  toolExecutionScoreResult,
  widgetCheckScoreDefinition,
  widgetCheckScoreResult,
  type ResolvedScoreDefinition,
  type ScoreDefinition,
  type ScoreResult,
} from "@mcpjam/sdk/contract";
import type { PlatformGateEvidence } from "./iteration-verdict.js";

export type { PlatformGateEvidence };

export const HOSTED_PLATFORM_GATE_SCORER_IDS: ReadonlySet<string> = new Set([
  TOOL_EXECUTION_SCORER_ID,
  ITERATION_ERROR_SCORER_ID,
  WIDGET_CHECK_SCORER_ID,
]);

export function hostedPlatformGateDefinitions(args: {
  failOnToolError: boolean;
}): ScoreDefinition[] {
  return [
    toolExecutionScoreDefinition({ gating: args.failOnToolError }),
    iterationErrorScoreDefinition({ gating: true }),
    widgetCheckScoreDefinition(),
  ];
}

/** One row per platform definition the config declares. */
export function hostedPlatformGateRows(
  byId: ReadonlyMap<string, ResolvedScoreDefinition>,
  evidence: PlatformGateEvidence,
): ScoreResult[] {
  const rows: ScoreResult[] = [];
  const toolExecution = byId.get(TOOL_EXECUTION_SCORER_ID);
  if (toolExecution) {
    rows.push(
      toolExecutionScoreResult(toolExecution, {
        trace: evidence.trace,
        pinnedToolErrors: evidence.pinnedToolErrors,
      }),
    );
  }
  const iterationError = byId.get(ITERATION_ERROR_SCORER_ID);
  if (iterationError) {
    rows.push(iterationErrorScoreResult(iterationError, evidence.iterationError));
  }
  const widgetCheck = byId.get(WIDGET_CHECK_SCORER_ID);
  if (widgetCheck) {
    rows.push(widgetCheckScoreResult(widgetCheck, evidence.scriptedCheckFailures));
  }
  return rows;
}
