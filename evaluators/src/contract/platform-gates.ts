/**
 * Score rows for the checks the platform applies to every iteration.
 *
 * A tool error or a runner failure decides pass/fail just like an assertion
 * does, so it gets a row like an assertion does. The verdict is then
 * `scoresPassed(rows)` everywhere — locally, on upload, and in the backend's
 * check — and a reader can see why an iteration failed from its rows alone.
 *
 * Each definition is declared on EVERY iteration and passes when nothing went
 * wrong. The backend rejects a case whose evaluation config differs between
 * iterations of one run, so a row that only appeared on failures would turn a
 * flaky tool into a rejected run.
 */
import type { EvalTraceInput } from "../eval-reporting-types.js";
import { extractToolErrors } from "../eval-tool-execution.js";
import type { ToolErrorRecord } from "../predicates/types.js";
import { canonicalDigest } from "./canonical.js";
import { finalizeScoreResult } from "./derive.js";
import { authoredRequiredRole } from "./policy-spelling.js";
import type {
  ResolvedScoreDefinition,
  ScoreDefinition,
  ScoreResult,
} from "./types.js";

export const TOOL_EXECUTION_SCORER_ID = "platform:toolExecution";
export const ITERATION_ERROR_SCORER_ID = "platform:iterationError";
export const WIDGET_CHECK_SCORER_ID = "platform:widgetCheck";

const PLATFORM_GATE_VERSION = "1";
/** Names listed in a row's rationale; the rest are counted. */
const MAX_NAMED_FAILURES = 5;

function platformGateDefinition(args: {
  scorerId: string;
  label: string;
  gating: boolean;
}): ScoreDefinition {
  return {
    scorerId: args.scorerId,
    idSource: "platform",
    scorerVersion: PLATFORM_GATE_VERSION,
    implementationHash: canonicalDigest({
      scorerId: args.scorerId,
      version: PLATFORM_GATE_VERSION,
    }),
    label: args.label,
    deterministic: true,
    passThreshold: 1,
    role: args.gating ? authoredRequiredRole() : "advisory",
  };
}

/**
 * Any tool call that failed: one the model made (trace) or a pinned one.
 * Advisory when the run sets `failOnToolError: false`, so a recovered error
 * stays visible without failing the iteration.
 */
export function toolExecutionScoreDefinition(options: {
  gating: boolean;
}): ScoreDefinition {
  return platformGateDefinition({
    scorerId: TOOL_EXECUTION_SCORER_ID,
    label: "tool calls succeeded",
    gating: options.gating,
  });
}

/** The runner stopped the iteration before it finished. */
export function iterationErrorScoreDefinition(options: {
  gating: boolean;
}): ScoreDefinition {
  return platformGateDefinition({
    scorerId: ITERATION_ERROR_SCORER_ID,
    label: "iteration completed",
    gating: options.gating,
  });
}

/**
 * Scripted widget interactions and DOM assertions. Always gating: the
 * assertion is the test, so no flag turns it off.
 */
export function widgetCheckScoreDefinition(): ScoreDefinition {
  return platformGateDefinition({
    scorerId: WIDGET_CHECK_SCORER_ID,
    label: "widget checks passed",
    gating: true,
  });
}

function describeFailures(
  failures: ReadonlyArray<{ toolName?: string; pinned: boolean }>,
): string {
  const named = failures.slice(0, MAX_NAMED_FAILURES).map((failure) => {
    const name = failure.toolName ?? "unnamed tool";
    return failure.pinned ? `${name} (pinned)` : name;
  });
  const more = failures.length - named.length;
  return (
    `${failures.length} tool call${failures.length === 1 ? "" : "s"} failed: ` +
    named.join(", ") +
    (more > 0 ? `, and ${more} more` : "")
  );
}

/**
 * One record per failed call. A trace can report the same call as both an
 * errored span and a failing tool result; records without an id are distinct
 * attempts and all kept.
 */
function oncePerCall(
  records: ReadonlyArray<ToolErrorRecord>,
): ToolErrorRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (record.toolCallId === undefined) return true;
    if (seen.has(record.toolCallId)) return false;
    seen.add(record.toolCallId);
    return true;
  });
}

/**
 * Fails when the trace or the pinned calls hold a failed tool call. Uses the
 * same detection as the `failOnToolError` gate (`extractToolErrors`), so the
 * row and the gate cannot disagree about what a tool error is.
 */
export function toolExecutionScoreResult(
  definition: ResolvedScoreDefinition,
  input: {
    trace: EvalTraceInput | undefined;
    pinnedToolErrors?: ReadonlyArray<ToolErrorRecord>;
  },
): ScoreResult {
  const failures = [
    ...oncePerCall(extractToolErrors(input.trace)).map((record) => ({
      toolName: record.toolName,
      pinned: false,
    })),
    ...oncePerCall(input.pinnedToolErrors ?? []).map((record) => ({
      toolName: record.toolName,
      pinned: true,
    })),
  ];
  return finalizeScoreResult(definition, {
    kind: "scored",
    value: failures.length === 0 ? 1 : 0,
    rationale:
      failures.length === 0
        ? "no tool call failed"
        : describeFailures(failures),
  });
}

/** Fails when the runner reported an error that stopped the iteration. */
export function iterationErrorScoreResult(
  definition: ResolvedScoreDefinition,
  error: string | null | undefined,
): ScoreResult {
  const failed = typeof error === "string" && error.trim().length > 0;
  return finalizeScoreResult(definition, {
    kind: "scored",
    value: failed ? 0 : 1,
    rationale: failed ? error : "the iteration completed",
  });
}

/** Fails when a widget check failed or its widget never rendered. */
export function widgetCheckScoreResult(
  definition: ResolvedScoreDefinition,
  failures: ReadonlyArray<{ toolName: string; reason: string }>,
): ScoreResult {
  const named = failures
    .slice(0, MAX_NAMED_FAILURES)
    .map((failure) => `${failure.toolName}: ${failure.reason}`);
  const more = failures.length - named.length;
  return finalizeScoreResult(definition, {
    kind: "scored",
    value: failures.length === 0 ? 1 : 0,
    rationale:
      failures.length === 0
        ? "every widget check passed"
        : named.join("; ") + (more > 0 ? `; and ${more} more` : ""),
  });
}
