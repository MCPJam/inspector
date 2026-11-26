import type {
  ConformanceRunOutcome,
  ConformanceSkipReason,
} from "../conformance-outcome.js";
import type { ConformanceProfileStamp } from "../conformance-profile.js";
import type { MCPServerConfig } from "../mcp-client-manager/index.js";
import type {
  MCPPassedAdvice,
  MCPReadinessWarning,
} from "../mcp-conformance/types.js";
import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";

// `dispatch` held only the two checks in {@link REMOVED_MCP_TASKS_CHECK_IDS}.
export const MCP_TASKS_CHECK_CATEGORIES = ["creation", "lifecycle"] as const;

export type MCPTasksCheckCategory = (typeof MCP_TASKS_CHECK_CATEGORIES)[number];

export const MCP_TASKS_CHECK_IDS = [
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
  "tasks-update-ack-shape",
  "tasks-ttl-integer-shape",
  "tasks-undeclared-capability-names-requirements",
] as const;

export type MCPTasksCheckId = (typeof MCP_TASKS_CHECK_IDS)[number];

/** Checks whose setup includes a tool call or a task created by one. */
export const MCP_TASKS_TOOL_CHECK_IDS = [
  "tasks-result-type-discipline",
  "tasks-undeclared-creation-refused",
  "tasks-undeclared-capability-rejected",
  "tasks-ttl-shape",
  "tasks-inline-result",
  "tasks-mcp-name-routing",
  "tasks-status-payload-shape",
  "tasks-cancel-ack-shape",
  "tasks-update-ack-shape",
  "tasks-ttl-integer-shape",
  "tasks-undeclared-capability-names-requirements",
] as const satisfies readonly MCPTasksCheckId[];
export type MCPTasksToolCheckId = (typeof MCP_TASKS_TOOL_CHECK_IDS)[number];
export function isTasksToolCheck(id: string): id is MCPTasksToolCheckId {
  return MCP_TASKS_TOOL_CHECK_IDS.some((check) => check === id);
}
export function taskCheckUsesInput(id: string): boolean {
  return [
    "tasks-ttl-shape",
    "tasks-inline-result",
    "tasks-status-payload-shape",
    "tasks-ttl-integer-shape",
    "tasks-update-ack-shape",
  ].includes(id);
}
export interface MCPTasksToolSetup {
  inputResponses?: Record<string, unknown>;
  toolName: string;
  toolArguments?: Record<string, unknown>;
}
export type MCPTasksCheckOverrides = Partial<
  Record<MCPTasksToolCheckId, MCPTasksToolSetup>
>;
export interface MCPTasksRunOptions {
  protocolVersion?: import("../mcp-client-manager/mcp-protocol-version.js").McpProtocolVersion;
  checkIds?: MCPTasksCheckId[];
  readinessIds?: MCPTasksReadinessId[];
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  inputResponses?: Record<string, unknown>;
  checkOverrides?: MCPTasksCheckOverrides;
}

/**
 * Tasks check ids an older SDK accepted under another name, each with its
 * current name. Kept so configs and `--check-id` values written for that SDK
 * still run instead of failing as unknown.
 */
export const RENAMED_MCP_TASKS_CHECK_IDS = {
  "tasks-input-required-update-completes": "tasks-update-ack-shape",
} as const satisfies Record<string, MCPTasksCheckId>;

export type RenamedMCPTasksCheckId = keyof typeof RENAMED_MCP_TASKS_CHECK_IDS;

/**
 * Tasks check ids an older SDK accepted that were removed with nothing in
 * their place, each with the reason. Kept so a config or `--check-id` list
 * written for that SDK still runs its other checks instead of failing as
 * unknown. Both graded MCPJam's own client, so a server could not fail them
 * on their own logic; their rules are now client tests in CI
 * (`sdk/tests/tasks-client-rules.*.test.ts`).
 *
 * - `tasks-wire-resolvable` passed whenever a protocol version was
 *   negotiated, which every successful connection has, and `resolveTasksWire`
 *   returns exactly one wire by construction. It passed on a server with no
 *   tasks at all.
 * - `tasks-declaration-hygiene` read only the requests MCPJam sent (whether
 *   `params.task` and the tasks extension declaration went on the right
 *   wire). Its rules (2025-11-25 tasks, Tool-Level Negotiation; ext-tasks,
 *   Capability Negotiation) bind the client.
 */
export const REMOVED_MCP_TASKS_CHECK_IDS = {
  "tasks-wire-resolvable":
    "It graded MCPJam's own client: it passed whenever a protocol version was negotiated, even on a server with no tasks. The wire resolution it covered is now a client test in CI.",
  "tasks-declaration-hygiene":
    "It graded MCPJam's own client: it read only the requests MCPJam sent, so a server could not fail it. The rule (send params.task only on the 2025-11-25 wire, the tasks extension declaration only on the 2026-07-28 wire) is now a client test in CI.",
} as const satisfies Record<string, string>;

export type RemovedMCPTasksCheckId = keyof typeof REMOVED_MCP_TASKS_CHECK_IDS;

/**
 * The category an older SDK accepted that went away with its checks: every
 * check in it is in {@link REMOVED_MCP_TASKS_CHECK_IDS}.
 */
export const REMOVED_MCP_TASKS_CHECK_CATEGORIES = {
  dispatch:
    "Its two checks (tasks-wire-resolvable, tasks-declaration-hygiene) graded MCPJam's own client and were removed; their rules are client tests in CI.",
} as const satisfies Record<string, string>;

/**
 * The Tasks suite's advice channel: the extension's SHOULDs, typed with their
 * spec strength like the protocol suite's readiness warnings. Informational
 * until advice has a grading rubric.
 */
export const MCP_TASKS_READINESS_IDS = [
  "tasks-readiness-failed-status-message",
  "tasks-readiness-unknown-task-id-mutations",
] as const;

export type MCPTasksReadinessId = (typeof MCP_TASKS_READINESS_IDS)[number];

export interface MCPTasksReadinessWarning extends Omit<
  MCPReadinessWarning,
  "id"
> {
  id: MCPTasksReadinessId;
  /**
   * The check that produced this advice. Advice from a check the profile does
   * not score yet costs no points, like a pending check's warnings.
   */
  checkId: MCPTasksCheckId;
}

/**
 * Picked advice the run could not judge, and why. Kept apart from `readiness`
 * so it never reads as a shortfall: a SHOULD about failed
 * tasks says nothing when the task did not fail.
 */
export interface MCPTasksUncheckedAdvice {
  id: MCPTasksReadinessId;
  title: string;
  reason: string;
}

/** Advice the run checked and the server already meets. */
export interface MCPTasksPassedAdvice extends Omit<MCPPassedAdvice, "id"> {
  id: MCPTasksReadinessId;
}

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
  /** Cancel active requests and polling, then close the owned connection. */
  signal?: AbortSignal;
  /**
   * @internal set by a host that counts the run itself (the CLI, the
   * Inspector) and by `runConformance` for its inner run. See
   * `captureConformanceRun`.
   */
  __suppressTelemetry?: boolean;
  /**
   * Run only these checks. A renamed id
   * ({@link RENAMED_MCP_TASKS_CHECK_IDS}) runs the check under its new name. A
   * removed id ({@link REMOVED_MCP_TASKS_CHECK_IDS}) is dropped: nothing runs
   * in its place.
   */
  checkIds?: (
    MCPTasksCheckId | RenamedMCPTasksCheckId | RemovedMCPTasksCheckId
  )[];
  /**
   * Report only this advice. Absent ⇒ all of it; empty ⇒ none. The advice
   * comes from checks that already run, so leaving it out sends nothing less.
   */
  readinessIds?: MCPTasksReadinessId[];
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
  checkOverrides?: MCPTasksCheckOverrides;
  /** Upper bound on polling a created task to a terminal status. */
  pollTimeoutMs?: number;
  /**
   * Responses to submit when the probed task reports `input_required`, keyed by
   * `inputRequests` key.
   *
   * OPT-IN, for the same reason the protocol suite's fixtures are: what a task
   * is asking for is server-defined, and inventing an answer would submit
   * arbitrary content into somebody's workflow. Absent ⇒
   * `tasks-update-ack-shape` is not applicable and names what it needs, and
   * the run stops polling as soon as the task parks on
   * `input_required` (further polls cannot advance it) rather than burning
   * `pollTimeoutMs`.
   */
  inputResponses?: Record<string, unknown>;
};

export interface NormalizedMCPTasksConformanceConfig {
  signal?: AbortSignal;
  serverConfig: MCPServerConfig;
  target: string;
  timeout: number;
  pollTimeoutMs: number;
  checkIds?: MCPTasksCheckId[];
  /** @see {@link MCPTasksConformanceConfig.readinessIds} */
  readinessIds?: MCPTasksReadinessId[];
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  checkOverrides?: MCPTasksCheckOverrides;
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
  /** SHOULD/MAY advice, beside the verdict. Absent when there is none. */
  readiness?: MCPTasksReadinessWarning[];
  /** Picked advice this run could not judge. Absent when there is none. */
  uncheckedAdvice?: MCPTasksUncheckedAdvice[];
  /** Advice the run checked and found nothing to change. Absent when none. */
  passedAdvice?: MCPTasksPassedAdvice[];
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
