import type {
  ConformanceRunOutcome,
  ConformanceSkipReason,
} from "../conformance-outcome.js";
import type { ConformanceProfileStamp } from "../conformance-profile.js";
import type { MCPServerConfig } from "../mcp-client-manager/index.js";
import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";

export const MCP_TASKS_CHECK_CATEGORIES = [
  "dispatch",
  "creation",
  "lifecycle",
] as const;

export type MCPTasksCheckCategory = (typeof MCP_TASKS_CHECK_CATEGORIES)[number];

export const MCP_TASKS_CHECK_IDS = [
  "tasks-wire-resolvable",
  "tasks-declaration-hygiene",
  "tasks-result-type-discipline",
  "tasks-undeclared-creation-refused",
  "tasks-undeclared-capability-rejected",
  "tasks-ttl-shape",
  "tasks-inline-result",
  "tasks-mcp-name-routing",
  // Scenario depth added by the conformance-gap program. New ids, and all of
  // them outside the `mcp-tasks` profile's scored set, so they report real
  // verdicts without re-grading servers that were green under the eight above.
  //
  // NOT here, deliberately: a `notifications/tasks` check. It needs a live
  // `subscriptions/listen` SSE stream, and the extension fixture never opens
  // one — shipping a probe we cannot validate against a fixture is how a
  // conformance suite acquires a flaky check. See the runner docstring.
  "tasks-invalid-task-id-rejected",
  "tasks-status-payload-shape",
  "tasks-cancel-ack-shape",
  "tasks-input-required-update-completes",
  "tasks-ttl-integer-shape",
  "tasks-undeclared-capability-names-requirements",
] as const;

export type MCPTasksCheckId = (typeof MCP_TASKS_CHECK_IDS)[number];

export type MCPTasksCheckStatus = "passed" | "failed" | "skipped";

/**
 * Why a selected check produced no verdict. Every `skipped` check carries one,
 * and the two are NOT interchangeable:
 *
 *   - `"not-applicable"` — the check cannot apply to THIS server, so there is
 *     nothing to establish: an extension-only check on a legacy connection, the
 *     `Mcp-Name` check on stdio, any task check on a connection with no tasks
 *     wire. A run may still pass with these.
 *   - `"could-not-run"` — the check DOES apply and was selected, but the run
 *     could not exercise it: no probe tool resolved, the probe tool is not
 *     listed, no task was created, the task never became readable. The run is
 *     then `incomplete`, never `passed` — "did not run" must never be read as
 *     "conformed".
 */
/** @see {@link ConformanceSkipReason} — the vocabulary is shared by every suite. */
export type MCPTasksSkipReason = ConformanceSkipReason;

/**
 * A run's verdict.
 *
 *   - `"passed"` — every selected, applicable check ran and passed.
 *   - `"failed"` — at least one check produced a violation.
 *   - `"incomplete"` — nothing failed, but at least one selected check could
 *     not be run, so the run does not establish conformance.
 */
/** @see {@link ConformanceRunOutcome} — the vocabulary is shared by every suite. */
export type MCPTasksRunOutcome = ConformanceRunOutcome;

export interface MCPTasksCheckResult {
  id: MCPTasksCheckId;
  category: MCPTasksCheckCategory;
  title: string;
  description: string;
  status: MCPTasksCheckStatus;
  /** Always set when `status` is `"skipped"`. */
  skipReason?: MCPTasksSkipReason;
  durationMs: number;
  error?: {
    message: string;
    details?: unknown;
  };
  details?: Record<string, unknown>;
  warnings?: string[];
}

export type MCPTasksConformanceConfig = MCPServerConfig & {
  checkIds?: MCPTasksCheckId[];
  /**
   * Tool used to provoke a task. Without it the runner picks the first tool
   * whose `execution.taskSupport` is `required`, then the first with
   * `optional` — 2025-11-25 metadata that the 2026-07-28 `ToolSchema` strips,
   * so auto-selection cannot work on the extension wire. When no probe tool
   * resolves, every task-dependent check reports `could-not-run` and the run
   * is `incomplete`; it never passes on skips.
   */
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  /** Upper bound on polling a created task to a terminal status. */
  pollTimeoutMs?: number;
  /**
   * Responses to submit when the probed task reports `input_required`, keyed by
   * `inputRequests` key.
   *
   * OPT-IN, for the same reason the protocol suite's fixtures are: what a task
   * is asking for is server-defined, and inventing an answer would submit
   * arbitrary content into somebody's workflow. Absent ⇒
   * `tasks-input-required-update-completes` reports a skip naming what it
   * needs, and the run stops polling as soon as the task parks on
   * `input_required` (further polls cannot advance it) rather than burning
   * `pollTimeoutMs`.
   */
  inputResponses?: Record<string, unknown>;
};

export interface NormalizedMCPTasksConformanceConfig {
  serverConfig: MCPServerConfig;
  target: string;
  timeout: number;
  pollTimeoutMs: number;
  checkIds?: MCPTasksCheckId[];
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  /** @see {@link MCPTasksConformanceConfig.inputResponses} */
  inputResponses?: Record<string, unknown>;
}

export interface MCPTasksConformanceResult {
  /**
   * True ONLY when `outcome` is `"passed"`: every selected check either ran and
   * passed or was inapplicable to this server. A check that could not run keeps
   * this false, so a skip can never add up to a green run.
   */
  passed: boolean;
  outcome: MCPTasksRunOutcome;
  /**
   * Present when `outcome` is `"incomplete"`: which checks did not run and what
   * the caller has to change to make them run.
   */
  incompleteReason?: string;
  target: string;
  checks: MCPTasksCheckResult[];
  summary: string;
  durationMs: number;
  categorySummary: Record<
    MCPTasksCheckCategory,
    {
      total: number;
      passed: number;
      failed: number;
      /** Every skip, of either reason. */
      skipped: number;
      /** The subset of `skipped` that is `"could-not-run"`. */
      couldNotRun: number;
    }
  >;
  /**
   * Which questions this run asked, and which build asked them. Same meaning
   * and same mechanism as the protocol suite's stamp, drawn from a SEPARATE
   * manifest — see `conformance-profile.ts` for why the two suites do not
   * share one.
   */
  profile?: ConformanceProfileStamp;
  discovery: {
    protocolVersion?: string;
    wire: TasksWire;
    toolCount: number;
    taskCapableToolCount: number;
    probedTool?: string;
    createdTaskId?: string;
  };
}
