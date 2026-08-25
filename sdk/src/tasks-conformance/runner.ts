/**
 * MCP Tasks conformance runner.
 *
 * Mirrors `apps-conformance/` in shape, but the subject is the *wire*: which
 * tasks wire the connection resolves to, whether the client-side declaration
 * hygiene holds for that wire, and whether the server honours the parts of the
 * contract a debugger can observe from the outside (result-type discipline,
 * `-32021` on an undeclared capability, inline results, TTL shapes, and
 * `Mcp-Name` routing for HTTP transports).
 *
 * Every check is derived from a single connection and, where a task is needed,
 * a single provoked task, so running the suite costs one server session.
 */

import { z } from "zod";
import type { MCPClientManager } from "../mcp-client-manager/MCPClientManager.js";
import type {
  ListToolsResult,
  RpcLogEvent,
} from "../mcp-client-manager/index.js";
import {
  MCP_ERROR_CODES,
  PRE_RENUMBER_DRAFT_ERROR_CODES,
} from "../mcp-client-manager/mcp-error-codes.js";
import { MCP_TASKS_EXTENSION_ID } from "../mcp-client-manager/tasks-dispatch.js";
import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";
import { CLIENT_CAPABILITIES_META_KEY } from "../mcp-client-manager/tasks-ext.js";
import { ensureTasksExtensionEraGateShadow } from "../mcp-client-manager/tasks-ext-era-gate.js";
import { TASK_CREATED_META_KEY } from "../mcp-client-manager/transport-utils.js";
import { deepJsonSafe } from "../json-safe.js";
import { withEphemeralClient } from "../operations.js";
import {
  buildOutcomeSummary,
  decideConformanceOutcome,
  isUnrunCheck,
} from "../conformance-outcome.js";
import {
  buildConformanceProfileStamp,
  conformanceProfile,
  partitionByProfile,
} from "../conformance-profile.js";
import {
  MCP_TASKS_CHECK_IDS,
  MCP_TASKS_CHECK_CATEGORIES,
  type MCPTasksCheckId,
  type MCPTasksCheckResult,
  type MCPTasksConformanceConfig,
  type MCPTasksConformanceResult,
  type MCPTasksRunOutcome,
  type NormalizedMCPTasksConformanceConfig,
} from "./types.js";
import { normalizeMCPTasksConformanceConfig } from "./validation.js";

// Exported so `tests/conformance-catalog.test.ts` can assert the browser-safe
// catalog still matches these canonical strings.
export const CHECK_METADATA: Record<
  MCPTasksCheckId,
  Pick<MCPTasksCheckResult, "id" | "category" | "title" | "description">
> = {
  "tasks-wire-resolvable": {
    id: "tasks-wire-resolvable",
    category: "dispatch",
    title: "Tasks Wire Resolvable",
    description:
      "The negotiated protocol version and advertised capabilities resolve to exactly one tasks wire, and the server does not advertise capabilities for the other era.",
  },
  "tasks-declaration-hygiene": {
    id: "tasks-declaration-hygiene",
    category: "dispatch",
    title: "Per-Version Declaration Hygiene",
    description:
      "Outgoing requests carry `params.task` only on the legacy wire and the tasks extension declaration only on the extension wire; a connection with no tasks wire sends neither.",
  },
  "tasks-result-type-discipline": {
    id: "tasks-result-type-discipline",
    category: "creation",
    title: "Result Type Discipline",
    description:
      'A task-eligible tools/call returns either a normal tool result or a flat CreateTaskResult with resultType "task" and a server-generated taskId.',
  },
  "tasks-undeclared-creation-refused": {
    id: "tasks-undeclared-creation-refused",
    category: "creation",
    title: "Undeclared Task Creation Refused",
    description:
      "On the extension wire, a tools/call that did not carry the extension declaration must not come back as a CreateTaskResult: the server either answers normally or rejects with -32021.",
  },
  "tasks-undeclared-capability-rejected": {
    id: "tasks-undeclared-capability-rejected",
    category: "lifecycle",
    title: "Undeclared Capability Rejected",
    description:
      "tasks/get, tasks/update, tasks/cancel and a task-filtered subscriptions/listen sent WITHOUT the extension declaration must each be rejected with -32021 (Missing Required Client Capability).",
  },
  "tasks-ttl-shape": {
    id: "tasks-ttl-shape",
    category: "lifecycle",
    title: "TTL And Poll Interval Shapes",
    description:
      "Task TTL and poll interval use the era-native shapes: `ttlMs: number|null` / `pollIntervalMs` on the extension, `ttl` / `pollInterval` on the legacy wire.",
  },
  "tasks-inline-result": {
    id: "tasks-inline-result",
    category: "lifecycle",
    title: "Completed Task Carries Its Result",
    description:
      "A completed task exposes its result the era-native way: inline on the extension's tasks/get, via tasks/result on the legacy wire.",
  },
  "tasks-mcp-name-routing": {
    id: "tasks-mcp-name-routing",
    category: "lifecycle",
    title: "Mcp-Name Task Routing",
    description:
      "Over HTTP, tasks/get is sent with Mcp-Name set to the task id (captured off the fetch seam) and accepted by the server.",
  },
  "tasks-invalid-task-id-rejected": {
    id: "tasks-invalid-task-id-rejected",
    category: "lifecycle",
    title: "Invalid Task Id Rejected",
    description:
      "tasks/get for a task id the server never issued is rejected with -32602 (Invalid params); the same rejection on tasks/update and tasks/cancel is a SHOULD and only warns.",
  },
  "tasks-status-payload-shape": {
    id: "tasks-status-payload-shape",
    category: "lifecycle",
    title: "Status Payload Shape",
    description:
      "Each observed task status carries the payload its status requires: `result` on completed, `error` on failed, `inputRequests` on input_required.",
  },
  "tasks-cancel-ack-shape": {
    id: "tasks-cancel-ack-shape",
    category: "lifecycle",
    title: "Cancel Acknowledged With An Empty Result",
    description:
      "tasks/cancel is acknowledged with an empty result rather than a task state, and the task's observable status is allowed to remain non-terminal afterwards.",
  },
  "tasks-input-required-update-completes": {
    id: "tasks-input-required-update-completes",
    category: "lifecycle",
    title: "Input Required Round Trip Completes",
    description:
      "A task that reports input_required advances past it once tasks/update supplies the requested inputResponses, and reaches a terminal status.",
  },
  "tasks-ttl-integer-shape": {
    id: "tasks-ttl-integer-shape",
    category: "lifecycle",
    title: "TTL And Poll Interval Are Integers",
    description:
      "ttlMs and pollIntervalMs are integer milliseconds, as the extension's Task interface states.",
  },
  "tasks-undeclared-capability-names-requirements": {
    id: "tasks-undeclared-capability-names-requirements",
    category: "lifecycle",
    title: "Undeclared Capability Error Names What Is Missing",
    description:
      "A -32021 rejection carries error.data.requiredCapabilities naming the capability the client failed to declare.",
  },
};

type MCPListedTool = NonNullable<ListToolsResult["tools"]>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `error.data.requiredCapabilities` off a JSON-RPC error, if it named any.
 *
 * The core schema REQUIRES this member on a `MissingRequiredClientCapabilityError`
 * — without it, a client that receives the rejection has been told it is
 * missing something and not told what, which makes the error unactionable.
 */
function readRequiredCapabilities(error: unknown): unknown {
  const data = (error as { data?: unknown } | null)?.data;
  return isRecord(data) ? data.requiredCapabilities : undefined;
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

function passed(
  id: MCPTasksCheckId,
  durationMs: number,
  details?: Record<string, unknown>,
  warnings?: string[]
): MCPTasksCheckResult {
  return {
    ...CHECK_METADATA[id],
    status: "passed",
    durationMs,
    ...(details ? { details } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

function failed(
  id: MCPTasksCheckId,
  durationMs: number,
  message: string,
  details?: Record<string, unknown>,
  rawError?: unknown
): MCPTasksCheckResult {
  return {
    ...CHECK_METADATA[id],
    status: "failed",
    durationMs,
    error: {
      message,
      // Raw thrown values are often class instances (e.g. MCPAuthError), and
      // the persistence layer rejects those wholesale — one live instance in
      // `errorDetails` used to destroy the entire finished report at the
      // Convex write. Reports carry plain JSON data only.
      ...(rawError === undefined ? {} : { details: deepJsonSafe(rawError) }),
    },
    ...(details ? { details } : {}),
  };
}

/**
 * A check that cannot apply to THIS server: an extension-only requirement on a
 * legacy connection, an HTTP-only requirement over stdio, a task check on a
 * connection with no tasks wire. Nothing is left unverified, so this does not
 * hold the run back.
 */
function notApplicable(
  id: MCPTasksCheckId,
  message: string,
  details?: Record<string, unknown>
): MCPTasksCheckResult {
  return {
    ...CHECK_METADATA[id],
    status: "skipped",
    skipReason: "not-applicable",
    durationMs: 0,
    error: { message },
    ...(details ? { details } : {}),
  };
}

/**
 * A check that DOES apply here but the run could not exercise — no probe tool,
 * a probe tool the server does not list, no task to inspect. The requirement
 * was not tested, so the run is `incomplete`: this must never be summed into a
 * passing verdict, which is exactly the bug where six task-dependent checks
 * silently skipped and the suite still reported success.
 */
function couldNotRun(
  id: MCPTasksCheckId,
  message: string,
  details?: Record<string, unknown>
): MCPTasksCheckResult {
  return {
    ...CHECK_METADATA[id],
    status: "skipped",
    skipReason: "could-not-run",
    durationMs: 0,
    error: { message },
    ...(details ? { details } : {}),
  };
}

/** Selected, applicable, and never exercised. */
const isUnrun = isUnrunCheck;

function summarizeChecks(checks: MCPTasksCheckResult[]) {
  return Object.fromEntries(
    MCP_TASKS_CHECK_CATEGORIES.map((category) => {
      const inCategory = checks.filter((check) => check.category === category);
      return [
        category,
        {
          total: inCategory.length,
          passed: inCategory.filter((c) => c.status === "passed").length,
          failed: inCategory.filter((c) => c.status === "failed").length,
          skipped: inCategory.filter((c) => c.status === "skipped").length,
          couldNotRun: inCategory.filter(isUnrun).length,
        },
      ];
    })
  ) as MCPTasksConformanceResult["categorySummary"];
}

const buildSummary = buildOutcomeSummary;

/**
 * The run's verdict, plus the reason when it is `incomplete`.
 *
 * `passed` requires that every SELECTED check actually produced a verdict —
 * either it ran, or it was inapplicable to this server. A check that could not
 * run is neither a violation nor a pass, and collapsing it into "not failed"
 * is what let a two-of-eight run report success.
 */
export function decideOutcome(checks: MCPTasksCheckResult[]): {
  outcome: MCPTasksRunOutcome;
  incompleteReason?: string;
} {
  return decideConformanceOutcome(checks);
}

/** `execution.taskSupport` on a listed tool (legacy 2025-11-25 metadata). */
export function toolTaskSupport(tool: MCPListedTool): string | undefined {
  const execution = (tool as { execution?: unknown }).execution;
  if (!isRecord(execution)) return undefined;
  return typeof execution.taskSupport === "string"
    ? execution.taskSupport
    : undefined;
}

/** Picks the tool most likely to produce a task without side effects. */
export function pickProbeTool(
  tools: MCPListedTool[],
  requestedName?: string
): MCPListedTool | undefined {
  if (requestedName) {
    return tools.find((tool) => tool.name === requestedName);
  }
  return (
    tools.find((tool) => toolTaskSupport(tool) === "required") ??
    tools.find((tool) => toolTaskSupport(tool) === "optional")
  );
}

/** How many listed tool names a resolution message names before eliding. */
const NAMED_TOOLS_LIMIT = 10;

function describeListedTools(tools: MCPListedTool[]): string {
  if (tools.length === 0) return "the server lists no tools at all";
  const named = tools.slice(0, NAMED_TOOLS_LIMIT).map((tool) => tool.name);
  const rest = tools.length - named.length;
  return `listed tools: ${named.join(", ")}${
    rest > 0 ? `, +${rest} more` : ""
  }`;
}

/**
 * The outcome of choosing a tool to provoke a task with.
 *
 * The FAILURE half is the point. `pickProbeTool` alone cannot say why it came
 * back empty, and the caller treated "no tool" as a skip — so on the extension
 * wire, where `execution.taskSupport` is stripped by the 2026 `ToolSchema` and
 * auto-selection can therefore NEVER succeed, six task-dependent checks skipped
 * and the run still reported `passed: true`. A resolution carries both a
 * user-actionable reason and whether that reason leaves work untested
 * (`blocking`) or is simply inapplicable (no tasks wire at all).
 */
export interface ProbeToolResolution {
  tool?: MCPListedTool;
  /** Why no tool resolved, in terms the caller can act on. */
  reason?: string;
  /** True when the missing tool leaves applicable checks unexercised. */
  blocking?: boolean;
}

/**
 * Resolves the probe tool, or explains — actionably — why it could not.
 *
 * An explicit `requestedName` that the server does not list is a resolution
 * FAILURE, not a silent miss: a typo would otherwise skip every task-dependent
 * check while the run still read as conformant.
 */
export function resolveProbeTool(
  wire: TasksWire,
  tools: MCPListedTool[],
  requestedName?: string
): ProbeToolResolution {
  if (wire === "none") {
    return {
      reason:
        "connection resolves to no tasks wire, so there is no task behavior to probe",
      blocking: false,
    };
  }

  const tool = pickProbeTool(tools, requestedName);
  if (tool) return { tool };

  if (requestedName) {
    return {
      reason: `the requested probe tool ${JSON.stringify(
        requestedName
      )} is not listed by this server, so no task could be provoked (${describeListedTools(
        tools
      )}); pass --tool-name (SDK: toolName) with a tool the server lists`,
      blocking: true,
    };
  }

  return {
    reason:
      wire === "extension"
        ? `no probe tool could be selected automatically: tools are chosen by \`execution.taskSupport\`, which the 2026-07-28 ToolSchema strips, so a tasks-extension server cannot advertise which tool creates a task. Pass --tool-name (SDK: toolName) naming a task-creating tool (${describeListedTools(
            tools
          )})`
        : `no listed tool advertises \`execution.taskSupport\`, so no task could be provoked (${describeListedTools(
            tools
          )}); pass --tool-name (SDK: toolName) naming a task-creating tool`,
    blocking: true,
  };
}

/**
 * Declaration hygiene over captured outbound JSON-RPC.
 *
 * This is the cross-version blast-radius guard restated as a conformance
 * check: `params.task` belongs to the legacy wire only, the extension
 * declaration to the extension wire only, and `wire: "none"` must produce
 * neither.
 */
export function findDeclarationViolations(
  wire: TasksWire,
  sent: unknown[]
): string[] {
  const violations: string[] = [];

  for (const message of sent) {
    if (!isRecord(message)) continue;
    const method = typeof message.method === "string" ? message.method : "";
    if (!method) continue;
    const params = isRecord(message.params) ? message.params : undefined;
    if (!params) continue;

    const hasTaskParam = params.task !== undefined;
    const meta = isRecord(params._meta) ? params._meta : undefined;
    const declared = isRecord(meta?.[CLIENT_CAPABILITIES_META_KEY])
      ? (meta[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown>)
      : undefined;
    const extensions = isRecord(declared?.extensions)
      ? (declared.extensions as Record<string, unknown>)
      : undefined;
    const declaresTasks =
      extensions !== undefined && MCP_TASKS_EXTENSION_ID in extensions;

    if (hasTaskParam && wire !== "legacy") {
      violations.push(
        `${method} sent params.task on the "${wire}" wire (legacy-only field)`
      );
    }
    if (declaresTasks && wire !== "extension") {
      violations.push(
        `${method} declared ${MCP_TASKS_EXTENSION_ID} on the "${wire}" wire (extension-only declaration)`
      );
    }
  }

  return violations;
}

/** A shape verdict: violations FAIL the check; warnings pass with a note. */
export interface ShapeVerdict {
  violations: string[];
  warnings: string[];
}

/**
 * Validates a `CreateTaskResult`-shaped payload (flat, `resultType: "task"`).
 *
 * Extra fields the spec does not define (e.g. a redundant nested `task`
 * object) are WARNINGS, not violations — the spec does not forbid additional
 * fields, so an otherwise-valid result must not fail conformance for them.
 *
 * `resultType` is REQUIRED here, present or absent (tasks.md:102): "Servers
 * MUST set `resultType` to `"task"` when returning a `CreateTaskResult` so
 * that clients can distinguish it from a standard result." The MUST states
 * its own purpose and that purpose is the whole mechanism — `CreateTaskResult
 * = Result & Task` is flat, so the discriminator is the ONLY signal. A server
 * that omits it does not deviate cosmetically: this SDK's task detection is
 * keyed on `resultType === "task"` end to end (`rewriteTaskResultMessage` at
 * the transport seam, then `isCreateTaskExtResult`), so the response is taken
 * for an ordinary `CallToolResult`, the task is never tracked, and the work
 * runs to completion with no handle. Omission and a wrong value are both
 * violations.
 *
 * The extension's machine-readable schema never declares the field (`Task`
 * sets `additionalProperties: false`), which is an argument about the OTHER
 * direction only: we must not reject a payload for CARRYING `resultType`.
 * Nothing in that silence licenses a server to omit it.
 */
export function validateCreateTaskShape(result: unknown): ShapeVerdict {
  const violations: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(result)) {
    return { violations: ["task creation result must be an object"], warnings };
  }
  if (result.resultType !== "task") {
    violations.push(
      result.resultType === undefined
        ? 'task creation result carries no resultType "task" discriminator, the only signal that distinguishes it from a standard result; a client reads it as an ordinary tool result and never tracks the task'
        : `task creation result must carry resultType "task" (got ${JSON.stringify(
            result.resultType
          )})`
    );
  }
  if (typeof result.taskId !== "string" || result.taskId.length === 0) {
    violations.push(
      "task creation result must carry a server-generated taskId"
    );
  }
  if (isRecord(result.task)) {
    warnings.push(
      "extension task creation result carries a redundant nested `task` object; the spec defines the flat top-level fields only (extra fields are allowed, so this is not a failure)"
    );
  }
  return { violations, warnings };
}

/**
 * Validates the era-native TTL / poll-interval shapes on a task payload.
 * Wrong types on the era-native fields are violations; the mere PRESENCE of
 * the other era's field is a warning (extra fields are not forbidden).
 */
export function validateTaskTtlShape(
  wire: TasksWire,
  task: unknown
): ShapeVerdict {
  if (!isRecord(task)) {
    return { violations: ["task payload must be an object"], warnings: [] };
  }
  const violations: string[] = [];
  const warnings: string[] = [];

  if (wire === "extension") {
    const ttlMs = task.ttlMs;
    if (!(ttlMs === null || typeof ttlMs === "number")) {
      violations.push(
        `extension task ttlMs must be a number or null (got ${JSON.stringify(
          ttlMs
        )})`
      );
    }
    if (
      task.pollIntervalMs !== undefined &&
      typeof task.pollIntervalMs !== "number"
    ) {
      violations.push("extension task pollIntervalMs must be a number");
    }
    if (task.ttl !== undefined) {
      warnings.push(
        "extension task also carries a legacy `ttl` field; clients read `ttlMs` (extra fields are allowed, so this is not a failure)"
      );
    }
  } else {
    if (task.ttl !== undefined && typeof task.ttl !== "number") {
      violations.push("legacy task ttl must be a number when present");
    }
    if (
      task.pollInterval !== undefined &&
      typeof task.pollInterval !== "number"
    ) {
      violations.push("legacy task pollInterval must be a number");
    }
    if (task.ttlMs !== undefined) {
      warnings.push(
        "legacy task also carries an extension `ttlMs` field; clients read `ttl` (extra fields are allowed, so this is not a failure)"
      );
    }
  }

  return { violations, warnings };
}

/**
 * The status-specific payload each task status is required to carry:
 *
 *   "3. If the status is `completed`, the server MUST return a Task object
 *       with status `completed` and a `result` field …
 *    5. If the status is `failed`, the server MUST return a Task object with
 *       status `failed` and the error that occurred during execution."
 *
 * and, for `input_required`, an `inputRequests` field that "MUST contain all
 * outstanding requests … that need to be fulfilled before the task can
 * proceed".
 *
 * Distinct from `tasks-inline-result`, which asks whether a COMPLETED task
 * exposes its result the era-native way. This asks the same question of every
 * status, and a server can satisfy one without the other: a task that parks on
 * `input_required` with no `inputRequests` is unanswerable and the completed
 * path never runs.
 *
 * `cancelled` and `working` require nothing beyond the base fields, so they are
 * absent here rather than given an empty rule — a rule that asserts nothing
 * reads as coverage it does not provide.
 */
/**
 * The extension requires `tasks/update` and `tasks/cancel` to be acknowledged
 * with an EMPTY result — `UpdateTaskResult` and `CancelTaskResult` are both
 * `Result` plus `resultType: "complete"`, with `resultType` REQUIRED.
 *
 * One validator for both, because they state the identical rule and had drifted
 * apart: the cancel path treated an ABSENT `resultType` as acceptable when the
 * schema marks it required, and the update path never looked at `resultType` at
 * all and read a non-object acknowledgement as an empty one — so a server
 * answering `tasks/update` with a bare string passed the check that exists to
 * confirm it acknowledged properly.
 *
 * `_meta` is an envelope member present on every result, so it is not "content".
 * Anything else IS content, and the extension tells the client to re-poll for
 * the new state rather than read it out of the acknowledgement.
 */
export function validateCompletionAck(
  ack: unknown,
  method: string,
  /**
   * The acknowledgement AS IT ARRIVED, read off the rpc log rather than from
   * the client's return value. `resultType` is a wire-only member the v2 client
   * consumes on the way through, so the decoded `ack` cannot answer whether the
   * server sent it — only this can. Absent when the frame could not be
   * correlated, and then the member is reported as advice rather than judged.
   */
  rawAck?: Record<string, unknown>,
): ShapeVerdict {
  // A non-object is not an empty result, it is not a result at all. This was
  // the hole: the update path read `isRecord(ack) ? keys : []` and an ack of
  // `"ok"` produced an empty extras list, i.e. a PASS from the check whose job
  // is to confirm the server acknowledged properly.
  if (!isRecord(ack)) {
    return {
      violations: [
        `${method} did not return a result object (got ${
          ack === null ? "null" : typeof ack
        })`,
      ],
      warnings: [],
    };
  }
  const violations: string[] = [];
  const warnings: string[] = [];
  const extras = Object.keys(ack).filter(
    (key) => key !== "resultType" && key !== "_meta"
  );
  if (extras.length > 0) {
    violations.push(
      `the acknowledgement carried ${JSON.stringify(
        extras
      )}; the extension requires an empty result and the client re-polls for the new status`
    );
  }
  // `resultType` is judged from the RAW frame when there is one. This used to
  // defer to `wire-schema-valid` on the grounds that it grades these frames
  // against `UpdateTaskResult` / `CancelTaskResult`, which mark the member
  // required — but it never sees them: the Tasks suite runs its own runner,
  // and that runner installs no `WireObservationRecorder` and runs no wire
  // check. So the requirement had no verdict in any suite, and a missing
  // required member read as a pass.
  //
  // It cannot be judged from the decoded `ack` either — the v2 client consumes
  // `resultType` on the way through, so a conforming server's ack arrives here
  // without it. Reading the rpc log is the same move `tasks-status-payload-shape`
  // already makes, and for the same reason.
  const observed = rawAck ?? (ack as Record<string, unknown>);
  const canJudgeResultType = rawAck !== undefined;
  const resultTypeName =
    method === "tasks/cancel" ? "CancelTaskResult" : "UpdateTaskResult";

  if (observed.resultType === undefined) {
    const message = `the acknowledgement omits resultType "complete"; the extension's ${resultTypeName} marks it required`;
    if (canJudgeResultType) {
      violations.push(message);
    } else {
      warnings.push(
        `${message} (read from the decoded result, which cannot prove what was on the wire)`
      );
    }
  } else if (observed.resultType !== "complete") {
    // Present but WRONG is a different fact from absent: a client
    // discriminates on this member, so a wrong value actively misdirects it.
    violations.push(
      `the acknowledgement carried resultType ${JSON.stringify(
        ack.resultType
      )} rather than "complete"`
    );
  }
  return { violations, warnings };
}

/**
 * The extension's `TaskStatus`, verbatim: an `anyOf` of five string constants.
 * A closed set, so anything outside it is a violation rather than a forward
 * -compatible unknown.
 */
const TASK_STATUSES = new Set([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

export function validateTaskStatusPayload(task: unknown): ShapeVerdict {
  if (!isRecord(task)) {
    return { violations: ["task payload must be an object"], warnings: [] };
  }
  const violations: string[] = [];
  const warnings: string[] = [];

  // `Task.status` is REQUIRED and a closed enum of five values in the
  // extension's schema. Reading it through `String(...)` accepted anything:
  // `undefined` became the string "undefined", `42` became "42", and both fell
  // through the switch's `default` to a silent pass — as did a plausible-looking
  // typo like "complete" or "in_progress". A client discriminates on this field,
  // so a status it cannot recognise is not a cosmetic problem.
  if (typeof task.status !== "string") {
    return {
      violations: [
        task.status === undefined
          ? "a task must carry the required `status` field"
          : `a task's \`status\` must be a string, got ${typeof task.status}`,
      ],
      warnings: [],
    };
  }
  const status = task.status;
  if (!TASK_STATUSES.has(status)) {
    violations.push(
      `a task's \`status\` must be one of ${[...TASK_STATUSES].join(", ")}; got ${JSON.stringify(status)}`,
    );
  }

  switch (status) {
    case "completed":
      if (task.result === undefined) {
        violations.push(
          "a completed task must carry the `result` field with the final result of the request"
        );
      }
      break;
    case "failed":
      if (!isRecord(task.error)) {
        violations.push(
          "a failed task must carry the `error` field with the JSON-RPC error that occurred"
        );
      } else if (typeof task.error.code !== "number") {
        violations.push("a failed task's `error` must carry a numeric code");
      }
      if (task.statusMessage === undefined) {
        // "SHOULD include a `statusMessage` field with diagnostic information"
        warnings.push(
          "a failed task carries no `statusMessage`; the extension recommends one so a human can see why"
        );
      }
      break;
    case "input_required":
      if (!isRecord(task.inputRequests)) {
        violations.push(
          "an input_required task must carry `inputRequests` naming what the client has to answer; without it the task can never proceed"
        );
      } else if (Object.keys(task.inputRequests).length === 0) {
        violations.push(
          "an input_required task carries an empty `inputRequests`; it must contain all outstanding requests"
        );
      }
      break;
    default:
      break;
  }

  return { violations, warnings };
}

/**
 * The extension's `Task` interface states both durations in INTEGER
 * milliseconds ("Time-to-live duration from creation in integer milliseconds",
 * "Suggested polling interval in integer milliseconds"). `schema.json` renders
 * them as plain `number`, which is why this is separate from
 * {@link validateTaskTtlShape} — that check asserts the era-native FIELD, and
 * widening it would re-grade servers already judged by it.
 *
 * A NEGATIVE `ttlMs` warns rather than fails: the spec never states a lower
 * bound, and `null` (not a negative number) is how it spells "unlimited", so a
 * negative value is nonsensical without being forbidden.
 */
export function validateTaskTtlIntegerShape(
  wire: TasksWire,
  task: unknown
): ShapeVerdict {
  if (!isRecord(task)) {
    return { violations: ["task payload must be an object"], warnings: [] };
  }
  const violations: string[] = [];
  const warnings: string[] = [];

  const fields =
    wire === "extension"
      ? ([
          ["ttlMs", task.ttlMs],
          ["pollIntervalMs", task.pollIntervalMs],
        ] as const)
      : ([
          ["ttl", task.ttl],
          ["pollInterval", task.pollInterval],
        ] as const);

  for (const [name, value] of fields) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "number") {
      // The era-native TYPE is the other check's subject; here a non-number is
      // reported for completeness rather than double-counted as a new defect.
      warnings.push(`${name} is not a number, so its integer shape was not judged`);
      continue;
    }
    if (!Number.isInteger(value)) {
      violations.push(`${name} is ${value}, which is not an integer`);
      continue;
    }
    if (value < 0) {
      warnings.push(
        `${name} is ${value}; the extension states no lower bound, but it spells "unlimited" as null rather than as a negative number`
      );
    }
  }

  return { violations, warnings };
}

/**
 * Runs `fn` with `globalThis.fetch` instrumented so the headers the transport
 * actually put on the wire can be asserted. The SDK builds its task-routing
 * fetch wrapper inside the transport, so this global seam is the only place a
 * caller can observe the finished request.
 */
async function captureTaskRequestHeaders(
  fn: () => Promise<unknown>
): Promise<{ headers?: Record<string, string>; error?: unknown }> {
  const original = globalThis.fetch;
  let headers: Record<string, string> | undefined;

  globalThis.fetch = (async (input: any, init?: any) => {
    const seen: Record<string, string> = {};
    new Request(input, init).headers.forEach((value, key) => {
      seen[key.toLowerCase()] = value;
    });
    if (seen["mcp-name"] !== undefined || seen["mcp-method"] !== undefined) {
      headers = seen;
    }
    return original(input, init);
  }) as typeof globalThis.fetch;

  try {
    await fn();
    return headers === undefined ? {} : { headers };
  } catch (error) {
    return headers === undefined ? { error } : { headers, error };
  } finally {
    globalThis.fetch = original;
  }
}

// "canceled" (single-l) is not a spec status on either wire; a server
// emitting it fails status validation rather than being silently accepted.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Consecutive `input_required` observations before polling accepts that a task
 * is PARKED on its gate rather than passing through it. Three is enough to tell
 * the two apart at any poll interval a server suggests, and still stops an
 * unanswerable task after a handful of requests instead of at `pollTimeoutMs`.
 */
const PARKED_INPUT_REQUIRED_POLLS = 3;

/** Missing Required Client Capability — the only conformant answer here. */
const MISSING_REQUIRED_CLIENT_CAPABILITY =
  MCP_ERROR_CODES.MissingRequiredClientCapability;
/**
 * The pre-renumber draft spelling of the same code. Named so a server still
 * emitting it is told which draft it is running, rather than being reported as
 * an anonymous wrong code.
 */
const OBSOLETE_MISSING_REQUIRED_CLIENT_CAPABILITY =
  PRE_RENUMBER_DRAFT_ERROR_CODES.MissingRequiredClientCapability;
/** Method not found: the server does not implement the method at all. */
const METHOD_NOT_FOUND = -32601;
/**
 * The extension's answer for an unknown or invalid `taskId`. Read from the
 * central table rather than re-spelled: the tasks runner already shipped one
 * hard-coded error literal that disagreed with it (`-32003` for
 * MissingRequiredClientCapability), and that bug rejected conforming servers.
 */
const INVALID_PARAMS = MCP_ERROR_CODES.InvalidParams;
/** The client gave up waiting — the server never refused the request. */
const REQUEST_TIMEOUT = -32001;

/**
 * Cap on the undeclared `subscriptions/listen` probe. A conforming server
 * refuses it immediately with `-32021`; one that wrongly accepts opens a
 * long-lived stream, so the probe — not the server — decides when to stop.
 */
const LISTEN_PROBE_TIMEOUT_MS = 5_000;

/** What a server did with a request that carried no extension declaration. */
export type UndeclaredProbeOutcome =
  /** Rejected with -32021: the required behavior. */
  | "rejected"
  /** The server served the request. */
  | "answered"
  /** Rejected, but with some other error code. */
  | "wrong-code"
  /** No answer arrived before the probe's own deadline. */
  | "no-response"
  /**
   * The request never reached the server at all — it died locally (upstream's
   * outbound era gate, a missing result schema) or the transport failed before
   * a JSON-RPC response existed. NOT a verdict on the server, and never a pass:
   * a probe that cannot execute must not be reported as conformance.
   */
  | "probe-failed"
  /** -32601: the method does not exist here, so the rule cannot be probed. */
  | "unsupported";

export interface UndeclaredProbe {
  method: string;
  outcome: UndeclaredProbeOutcome;
  code?: number;
  message?: string;
  /**
   * `error.data.requiredCapabilities` off a `-32021` rejection, when the server
   * named them. Absent for every other outcome.
   */
  requiredCapabilities?: unknown;
  /**
   * Whether an outbound JSON-RPC request for this method was observed on the
   * connection's rpc log. This is what separates "the server misbehaved" from
   * "the probe never got onto the wire".
   */
  reachedWire?: boolean;
}

/** One line of per-method detail for the check's failure message. */
export function describeUndeclaredProbe(probe: UndeclaredProbe): string {
  switch (probe.outcome) {
    case "answered":
      return `${probe.method} was answered instead of rejected`;
    case "wrong-code":
      return probe.code === OBSOLETE_MISSING_REQUIRED_CLIENT_CAPABILITY
        ? `${probe.method} was rejected with -32003, the code the tasks extension carried before it was corrected to -32021; the server is running against a pre-final draft`
        : `${probe.method} was rejected with ${probe.code} rather than -32021`;
    case "no-response":
      return `${probe.method} produced no JSON-RPC rejection (${
        probe.message ?? "no answer"
      }); a conforming server refuses it immediately with -32021`;
    case "probe-failed":
      return `${probe.method} never reached the server (${
        probe.message ?? "no answer"
      }), so the undeclared-request requirement was NOT tested`;
    case "unsupported":
      return `${probe.method} is not implemented (-32601)`;
    case "rejected":
      return `${probe.method} was rejected with -32021`;
  }
}

/** A flat task payload seen on the wire, before any client-side decoding. */
export interface RawTaskResponse {
  taskId: string;
  /** Exactly as it arrived: `undefined` means the key was absent. */
  resultType: unknown;
  /** Whether the required `resultType: "task"` discriminator was present. */
  discriminated: boolean;
}

/**
 * Finds a flat task payload in raw inbound JSON-RPC, IGNORING `resultType`.
 *
 * This is the only way to see the violation that matters most here. Task
 * detection is keyed on `resultType === "task"` end to end — the transport
 * seam's `rewriteTaskResultMessage`, then `isCreateTaskExtResult` — so a
 * `CreateTaskResult` that omits the discriminator never reaches the runner AS
 * a task. It arrives looking like an ordinary `CallToolResult`, and every
 * check that reads the DECODED result therefore scores the server green on the
 * exact interop break it exists to catch: the client cannot discriminate the
 * response, so the task is never tracked and the work runs to completion
 * server-side with no handle to poll, cancel, or read.
 *
 * Identification is by shape (`taskId`) rather than by discriminator, which is
 * the point; callers pass a window of messages received during ONE request so
 * a later `tasks/get` response cannot be mistaken for a creation.
 */
/**
 * The `result` object of the first JSON-RPC response in a window, verbatim.
 *
 * Unlike {@link findRawTaskResponse} this does not require a `taskId`: an
 * acknowledgement is legitimately empty apart from its envelope members, and
 * those members are exactly what the caller needs to see.
 */
export function findRawResult(
  messages: unknown[]
): Record<string, unknown> | undefined {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (isRecord(message.result)) return message.result;
  }
  return undefined;
}

export function findRawTaskResponse(
  messages: unknown[]
): RawTaskResponse | undefined {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const result = isRecord(message.result) ? message.result : undefined;
    if (!result) continue;
    if (typeof result.taskId !== "string" || result.taskId.length === 0) {
      continue;
    }
    return {
      taskId: result.taskId,
      resultType: result.resultType,
      discriminated: result.resultType === "task",
    };
  }
  return undefined;
}

/**
 * EVERY raw `tasks/get` task payload for `taskId`, in wire order, read off the
 * inbound bytes rather than off the decoded task.
 *
 * Raw, and unavoidably so — the same reason `findRawTaskResponse` above is.
 * The SDK's `taskExtSchema` rejects a `failed` task that carries no `error`
 * before it ever reaches a check, so a check reading the decoded task can only
 * ever observe payloads the client already accepted, and would score a server
 * green on precisely the malformed states it exists to catch. The wire is the
 * only place those states exist.
 *
 * ALL of them, not just the last: a run that answers an `input_required` gate
 * observes several statuses, and grading only the state the task ended in would
 * let a malformed `input_required` or `failed` frame pass unexamined behind a
 * well-formed `completed` one. That became reachable the moment this runner
 * learned to drive the update leg.
 *
 * Identified by BOTH shape (`taskId` + `status`) and request-id membership in
 * `getRequestIds`: every poll's answer is evidence, but only `tasks/get`
 * answers are — see the parameter's own note for what shape-only matching
 * wrongly swept in.
 */
export function findRawTaskStates(
  messages: unknown[],
  taskId: string,
  /**
   * JSON-RPC ids of the `tasks/get` requests this run sent. REQUIRED for
   * correctness, not an optimization: a `CreateTaskResult` from `tools/call` is
   * a bare `Task` carrying `taskId` and `status` and — entirely correctly — no
   * `result`, `error` or `inputRequests`. Matching on shape alone would sweep
   * it in, so a server that creates an already-`completed` (or `failed`, or
   * `input_required`) task would fail the status-payload check even when every
   * `tasks/get` it later answers is perfectly formed.
   *
   * The status payload rules are stated for `tasks/get` responses; grading a
   * creation frame against them invents a requirement.
   */
  getRequestIds: ReadonlySet<string>
): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const result = isRecord(message.result) ? message.result : undefined;
    if (!result) continue;
    if (result.taskId !== taskId) continue;
    // Deliberately NOT filtered on `status`. A missing or non-string status is
    // a VIOLATION of the extension's `Task` (where `status` is required and a
    // closed enum), and dropping such a frame here turned that violation into a
    // non-observation: the check then reported `could-not-run` — "we never saw
    // a task state" — about a server that answered with a malformed one.
    //
    // Identification is safe without it: membership in `getRequestIds` below
    // already establishes that this is a `tasks/get` response, and a
    // `tasks/get` response IS a Task.
    const id = message.id;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      !getRequestIds.has(String(id))
    ) {
      continue;
    }
    found.push(result);
  }
  return found;
}

/** JSON-RPC ids of the outbound requests for `method`, as strings. */
export function sentRequestIds(
  sent: unknown[],
  method: string
): Set<string> {
  const ids = new Set<string>();
  for (const message of sent) {
    if (!isRecord(message)) continue;
    if (message.method !== method) continue;
    const id = message.id;
    if (typeof id === "string" || typeof id === "number") {
      ids.add(String(id));
    }
  }
  return ids;
}

/** The failure a missing/wrong `resultType: "task"` actually causes. */
function describeUndiscriminatedTask(raw: RawTaskResponse): string {
  return `the server answered a tools/call with a flat task payload (taskId ${JSON.stringify(
    raw.taskId
  )}) that does not carry resultType "task"${
    raw.resultType === undefined
      ? ""
      : ` (got ${JSON.stringify(raw.resultType)})`
  }; tasks.md:102 makes that discriminator a MUST because it is the ONLY signal separating a CreateTaskResult from a standard result. This client decoded the response as an ordinary tool result, so the task is UNREACHABLE: it is never tracked, and the work runs to completion server-side with no handle to poll, cancel, or read`;
}

/**
 * The task id a server smuggled into an UNDECLARED `tools/call`, or
 * `undefined` if it produced an ordinary result.
 *
 * Two places have to be read, and the second is the one that matters. Without
 * `allowTaskResult`, `MCPClientManager` does not hand a `CreateTaskResult`
 * back at the top level at all: the transport wrapper rewrites the response
 * into a minimal valid `CallToolResult` and parks the original payload under
 * `_meta[TASK_CREATED_META_KEY]` (`transport-utils.ts:300`). A detector that
 * only read `result.taskId` would therefore see a plain tool result from EVERY
 * server — conformant or not — and the check would pass vacuously against the
 * exact violation it exists to catch.
 */
export function extractUndeclaredCreationTaskId(
  result: unknown
): string | undefined {
  if (!isRecord(result)) return undefined;
  if (typeof result.taskId === "string" && result.taskId.length > 0) {
    return result.taskId;
  }
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const stashed = meta?.[TASK_CREATED_META_KEY];
  if (!isRecord(stashed)) return undefined;
  // A `taskId`-less stash is still a task the server created; name it rather
  // than let the absent id downgrade the failure to a pass.
  return typeof stashed.taskId === "string" && stashed.taskId.length > 0
    ? stashed.taskId
    : "(CreateTaskResult with no taskId)";
}

/**
 * A raw JSON-RPC request seam: the manager's public tasks APIs always attach
 * the extension declaration, which is exactly what these probes must omit.
 *
 * The seam MUST carry an explicit result schema. `Protocol.request`'s
 * schema-less overload resolves its validator from the negotiated era's method
 * registry, and no `tasks/*` method has an entry there on the 2026 wire — so a
 * schema-less call dies LOCALLY ("pass a result schema as the second
 * argument") and the probe tests nothing. Same reasoning, same fix as
 * `tasks-ext.ts` / `tasks.ts`, which is why the schema below is the same
 * deliberately-loose `z.looseObject({})`: this probe asserts on the JSON-RPC
 * *envelope* (rejected vs answered), never on a payload's shape.
 */
type RawRequest = (
  payload: { method: string; params: Record<string, unknown> },
  options?: { timeout?: number }
) => Promise<unknown>;

/** See {@link RawRequest} — loose on purpose. */
const RAW_PROBE_RESULT_SCHEMA = z.looseObject({});

/** Outbound requests for `method` seen on the connection's rpc log. */
function countSentRequests(sent: unknown[], method: string): number {
  return sent.filter(
    (message) => isRecord(message) && message.method === method
  ).length;
}

/**
 * Sends one request WITHOUT the extension declaration and classifies what
 * came back. `listenProbe` marks the sub-probe whose absence is a skip rather
 * than a violation: `subscriptions/listen` is a core method the tasks
 * extension only borrows, so a server that lacks it cannot be judged on it.
 *
 * `sent` is the run's captured outbound rpc log; the probe reads it before and
 * after so a failure can say whether the request ever left the process.
 *
 * In `@modelcontextprotocol/client` v2 a NUMERIC `code` on the thrown error is
 * itself the discriminator: `ProtocolError` (numeric code) is minted only from
 * a server's JSON-RPC error response (`src-*.mjs:5873`), while every local and
 * transport fault — the era gate, timeouts, a closed connection — is an
 * `SdkError` whose `code` is a STRING. So "no numeric code" means "no server
 * verdict", and it is reported as `probe-failed`, not as a pass.
 */
async function runUndeclaredProbe(
  request: RawRequest,
  sent: unknown[],
  method: string,
  params: Record<string, unknown>,
  options?: { timeout?: number; listenProbe?: boolean }
): Promise<UndeclaredProbe> {
  const sentBefore = countSentRequests(sent, method);
  const reachedWire = () => countSentRequests(sent, method) > sentBefore;
  try {
    await request(
      { method, params },
      options?.timeout === undefined ? undefined : { timeout: options.timeout }
    );
    return { method, outcome: "answered", reachedWire: reachedWire() };
  } catch (error) {
    const code = errorCode(error);
    const message = errorMessage(error);
    if (code === MISSING_REQUIRED_CLIENT_CAPABILITY) {
      return {
        method,
        outcome: "rejected",
        code,
        reachedWire: true,
        // Kept for the sibling check that asks whether the rejection NAMES the
        // capability. The core schema requires `error.data.requiredCapabilities`
        // on this error, our own protocol check already asserts it, and nothing
        // in the tasks suite looked at it.
        requiredCapabilities: readRequiredCapabilities(error),
      };
    }
    if (code === METHOD_NOT_FOUND && options?.listenProbe) {
      return {
        method,
        outcome: "unsupported",
        code,
        message,
        reachedWire: true,
      };
    }
    if (code === undefined) {
      // No JSON-RPC response exists, so there is no server verdict. The rpc log
      // decides which kind of nothing this is: a request that DID leave the
      // process and was never answered (a stream the server held open past the
      // probe deadline) is a server-side `no-response`; one that never left is
      // the probe's own failure and must not be graded as conformance.
      return reachedWire()
        ? { method, outcome: "no-response", message, reachedWire: true }
        : { method, outcome: "probe-failed", message, reachedWire: false };
    }
    if (code === REQUEST_TIMEOUT) {
      // A server-sent -32001: the request reached it and it declined to answer
      // within the deadline — a verdict, just not the required one.
      return {
        method,
        outcome: "no-response",
        code,
        message,
        reachedWire: true,
      };
    }
    return { method, outcome: "wrong-code", code, message, reachedWire: true };
  }
}

/** What {@link MCPTasksConformanceTest.runInputRequiredLeg} observed. */
interface InputRequiredLeg {
  outcome: "no-responses-configured" | "update-rejected" | "updated";
  /** Keys the task asked the client to answer. */
  requested: string[];
  /** Keys the operator supplied. */
  answered?: string[];
  message?: string;
  code?: number;
  /** Result members beyond the envelope; a conforming ack has none. */
  ackVerdict?: ShapeVerdict;
  polled?: { task?: Record<string, unknown>; error?: unknown };
  finalStatus?: string;
}

export class MCPTasksConformanceTest {
  private readonly config: NormalizedMCPTasksConformanceConfig;

  constructor(config: MCPTasksConformanceConfig) {
    this.config = normalizeMCPTasksConformanceConfig(config);
  }

  async run(): Promise<MCPTasksConformanceResult> {
    const startedAt = Date.now();
    const selected = new Set<MCPTasksCheckId>(
      this.config.checkIds ?? MCP_TASKS_CHECK_IDS
    );
    const checks: MCPTasksCheckResult[] = [];
    const sent: unknown[] = [];
    // The RAW inbound bytes. Every task check that has to judge the
    // discriminator reads this, because by the time a result reaches the
    // manager the decoder has already made up its mind — see
    // {@link findRawTaskResponse}. Captured once, used by both creation checks.
    const received: unknown[] = [];

    const captureRpc = (event: RpcLogEvent) => {
      if (event.direction === "send") sent.push(event.message);
      else received.push(event.message);
      this.config.serverConfig.rpcLogger?.(event);
    };

    // Hoisted above the `try` so the connection-failure path can stamp it too.
    // A report that omits its profile is unusable for the one thing the stamp
    // exists for: a reader comparing two runs must be able to tell whether they
    // asked the same questions, and "failed to connect" is still a run.
    const profile = conformanceProfile("mcp-tasks");

    try {
      return await withEphemeralClient(
        this.config.serverConfig,
        async (manager, serverId) => {
          const support = manager.getTasksSupport(serverId);
          const wire = support.wire;
          const protocolVersion =
            manager.getNegotiatedProtocolVersion(serverId);
          const capabilities = manager.getServerCapabilities(serverId);

          if (selected.has("tasks-wire-resolvable")) {
            const stepStartedAt = Date.now();
            const warnings: string[] = [];
            const extensions = (capabilities as { extensions?: unknown })
              ?.extensions;
            const advertisesExtension =
              isRecord(extensions) && MCP_TASKS_EXTENSION_ID in extensions;

            if (advertisesExtension && protocolVersion === "2025-11-25") {
              // SEP-2663: on 2025-11-25 the extension capability MUST be
              // treated as absent. Advertising it is a server-side smell, not
              // a client failure, so it surfaces as a warning.
              warnings.push(
                `server advertises ${MCP_TASKS_EXTENSION_ID} on 2025-11-25, where it must be treated as absent`
              );
            }

            checks.push(
              protocolVersion
                ? passed(
                    "tasks-wire-resolvable",
                    Date.now() - stepStartedAt,
                    { protocolVersion, wire, support },
                    warnings
                  )
                : failed(
                    "tasks-wire-resolvable",
                    Date.now() - stepStartedAt,
                    'server did not expose a negotiated protocol version; tasks dispatch fails closed to "none"'
                  )
            );
          }

          const tools = (await manager.listTools(serverId)).tools ?? [];
          const taskCapableTools = tools.filter(
            (tool) => toolTaskSupport(tool) !== undefined
          );
          const probe = resolveProbeTool(wire, tools, this.config.toolName);
          const probeTool = probe.tool;
          /** The check verdict for "there is no probe tool", per resolution. */
          const missingProbeTool = (id: MCPTasksCheckId) =>
            (probe.blocking ? couldNotRun : notApplicable)(
              id,
              probe.reason ?? "no probe tool resolved"
            );

          let createdTaskId: string | undefined;
          let creationResult: unknown;
          /** The creation response as it arrived, before decoding. */
          let rawCreation: RawTaskResponse | undefined;

          if (wire !== "none" && probeTool) {
            const receivedBefore = received.length;
            try {
              creationResult =
                wire === "extension"
                  ? await manager.executeTool(
                      serverId,
                      probeTool.name,
                      this.config.toolArguments ?? {},
                      { allowTaskResult: true }
                    )
                  : await manager.executeTool(
                      serverId,
                      probeTool.name,
                      this.config.toolArguments ?? {},
                      undefined,
                      {}
                    );
              createdTaskId = this.extractTaskId(wire, creationResult);
            } catch (error) {
              creationResult = error;
            }
            // Read the wire regardless of how decoding went: an
            // undiscriminated task both LOOKS like a plain result and can make
            // result decoding fail, and neither may be scored as conformance.
            rawCreation = findRawTaskResponse(received.slice(receivedBefore));
          }

          if (selected.has("tasks-result-type-discipline")) {
            const stepStartedAt = Date.now();
            if (!probeTool) {
              checks.push(missingProbeTool("tasks-result-type-discipline"));
            } else if (
              wire === "extension" &&
              rawCreation &&
              !rawCreation.discriminated
            ) {
              // BEFORE the decoded-result branches, and deliberately so: this
              // is the one violation the decoded result cannot show, because
              // an undiscriminated task arrives as an ordinary result (or
              // fails decoding). Judged on the wire, it is unambiguous.
              checks.push(
                failed(
                  "tasks-result-type-discipline",
                  Date.now() - stepStartedAt,
                  describeUndiscriminatedTask(rawCreation),
                  {
                    tool: probeTool.name,
                    taskId: rawCreation.taskId,
                    resultType: rawCreation.resultType ?? null,
                  }
                )
              );
            } else if (creationResult instanceof Error) {
              checks.push(
                failed(
                  "tasks-result-type-discipline",
                  Date.now() - stepStartedAt,
                  `task-eligible tools/call failed: ${errorMessage(
                    creationResult
                  )}`,
                  { tool: probeTool.name },
                  creationResult
                )
              );
            } else if (createdTaskId === undefined) {
              // Server-decided: declining to produce a task is conformant, as
              // long as what comes back is a normal tool result.
              //
              // This branch used to be a blind spot: a `CreateTaskResult` with
              // no `resultType` lands here too, since task detection is keyed
              // on `resultType === "task"` at the transport seam
              // (`rewriteTaskResultMessage`), so it arrives as an ordinary
              // result. It no longer reaches this branch — the raw-wire check
              // above judges the discriminator on the bytes, so "the server
              // declined a task" now means the wire carried no task at all.
              checks.push(
                isRecord(creationResult)
                  ? passed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      {
                        tool: probeTool.name,
                        outcome: "non-task result (server declined the task)",
                      }
                    )
                  : failed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      "tools/call returned neither a tool result object nor a task"
                    )
              );
            } else {
              const verdict =
                wire === "extension"
                  ? validateCreateTaskShape(creationResult)
                  : { violations: [], warnings: [] };
              checks.push(
                verdict.violations.length === 0
                  ? passed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      { tool: probeTool.name, taskId: createdTaskId },
                      verdict.warnings
                    )
                  : failed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      `${verdict.violations.length} task creation shape violation(s)`,
                      { violations: verdict.violations }
                    )
              );
            }
          }

          if (selected.has("tasks-undeclared-creation-refused")) {
            const stepStartedAt = Date.now();
            if (wire !== "extension") {
              checks.push(
                notApplicable(
                  "tasks-undeclared-creation-refused",
                  "check applies to the extension wire only"
                )
              );
            } else if (!probeTool) {
              checks.push(missingProbeTool("tasks-undeclared-creation-refused"));
            } else {
              // tasks.md:61 — a server MUST NOT return `CreateTaskResult` to a
              // client that did not include the extension capability ON THAT
              // REQUEST, regardless of prior declarations.
              const creation = await this.probeUndeclaredCreation(
                manager,
                serverId,
                probeTool.name,
                received
              );
              const stepDurationMs = Date.now() - stepStartedAt;
              if (creation.outcome === "created") {
                checks.push(
                  failed(
                    "tasks-undeclared-creation-refused",
                    stepDurationMs,
                    `an undeclared tools/call returned a CreateTaskResult; a server must not create a task for a client that never declared the tasks capability (it must answer normally or reject with -32021)${
                      creation.discriminated
                        ? ""
                        : '. The payload also carries no resultType "task" discriminator, so it was only visible on the raw wire — a client cannot discriminate it and the task is unreachable (tasks.md:102)'
                    }`,
                    {
                      tool: probeTool.name,
                      taskId: creation.taskId,
                      discriminated: creation.discriminated,
                    }
                  )
                );
              } else if (creation.outcome === "errored") {
                // Not a pass: the probe never obtained a server response, so
                // tasks.md:61 was not exercised at all.
                checks.push(
                  failed(
                    "tasks-undeclared-creation-refused",
                    stepDurationMs,
                    `the undeclared tools/call produced no JSON-RPC response (${creation.message}), so the server was never tested; re-run against a reachable server`,
                    { tool: probeTool.name, outcome: creation.outcome }
                  )
                );
              } else {
                checks.push(
                  passed(
                    "tasks-undeclared-creation-refused",
                    stepDurationMs,
                    {
                      tool: probeTool.name,
                      outcome: creation.outcome,
                      ...(creation.outcome === "refused"
                        ? { undeclaredCreationCode: creation.code }
                        : {}),
                    },
                    creation.outcome === "refused" &&
                      creation.code !== MISSING_REQUIRED_CLIENT_CAPABILITY
                      ? [
                          creation.code ===
                          OBSOLETE_MISSING_REQUIRED_CLIENT_CAPABILITY
                            ? `the undeclared tools/call was rejected with -32003, the code the tasks extension carried before it was corrected to -32021; no task was created (which is what tasks.md:61 requires) but the server is running against a pre-final draft`
                            : `the undeclared tools/call was rejected with ${creation.code} rather than -32021; no task was created (which is what tasks.md:61 requires) but the refusal is not the one the extension names`,
                        ]
                      : undefined
                  )
                );
              }
            }
          }

          // FIRST poll stops at `input_required` as well as at a terminal
          // status: an input-gated task cannot advance without a client answer,
          // so continuing would only spend `pollTimeoutMs` to reach the state
          // already in hand. `pollToTerminal` requires the gate to be OBSERVED
          // as parked before it stops — see the note there on why one frame is
          // not enough.
          let polled = createdTaskId
            ? await this.pollToTerminal(manager, serverId, wire, createdTaskId, {
                stopOnInputRequired: true,
              })
            : {};

          // The `input_required → tasks/update → completion` leg. Opt-in on
          // `inputResponses` for the same reason the protocol suite's fixtures
          // are: what a task asks for is server-defined, and inventing an
          // answer submits arbitrary content into somebody's workflow.
          const inputRequiredTask = polled.inputRequired ? polled.task : undefined;
          let inputLeg: InputRequiredLeg | undefined;
          if (inputRequiredTask && createdTaskId && wire === "extension") {
            inputLeg = await this.runInputRequiredLeg(
              manager,
              serverId,
              createdTaskId,
              inputRequiredTask,
              received
            );
            if (inputLeg.polled) {
              // The task moved on, so every downstream check reads the state it
              // reached rather than the gate it was stuck behind.
              polled = inputLeg.polled;
            }
          }

          const finalTask = polled.task;
          // Distinguishes "there was never a task" from "polling the task
          // failed", so no dependent check skips under a message that hides a
          // broken read. Every branch here leaves the check UNEXERCISED, so the
          // verdict is `could-not-run` — except when no probe tool resolved at
          // all, where the resolution already decided whether that is a gap or
          // an inapplicability (no tasks wire).
          const noTask = (id: MCPTasksCheckId): MCPTasksCheckResult => {
            if (!probeTool) return missingProbeTool(id);
            if (!createdTaskId) {
              return couldNotRun(
                id,
                `the probed tool ${JSON.stringify(
                  probeTool.name
                )} returned a normal result, so no task existed to inspect; name a task-creating tool with --tool-name (SDK: toolName) or supply --tool-args (SDK: toolArguments) that provoke one`
              );
            }
            return couldNotRun(
              id,
              polled.error === undefined
                ? `task ${createdTaskId} was never readable within ${this.config.pollTimeoutMs}ms`
                : `polling task ${createdTaskId} failed: ${errorMessage(
                    polled.error
                  )}`
            );
          };

          if (selected.has("tasks-ttl-shape")) {
            const stepStartedAt = Date.now();
            if (!finalTask) {
              checks.push(noTask("tasks-ttl-shape"));
            } else {
              const verdict = validateTaskTtlShape(wire, finalTask);
              checks.push(
                verdict.violations.length === 0
                  ? passed(
                      "tasks-ttl-shape",
                      Date.now() - stepStartedAt,
                      undefined,
                      verdict.warnings
                    )
                  : failed(
                      "tasks-ttl-shape",
                      Date.now() - stepStartedAt,
                      `${verdict.violations.length} TTL shape violation(s)`,
                      { violations: verdict.violations }
                    )
              );
            }
          }

          if (selected.has("tasks-inline-result")) {
            const stepStartedAt = Date.now();
            if (!finalTask || !createdTaskId) {
              checks.push(noTask("tasks-inline-result"));
            } else if (!TERMINAL_STATUSES.has(String(finalTask.status))) {
              checks.push(
                couldNotRun(
                  "tasks-inline-result",
                  `task did not reach a terminal status within ${
                    this.config.pollTimeoutMs
                  }ms (last status: ${String(
                    finalTask.status
                  )}); raise --poll-timeout (SDK: pollTimeoutMs) or probe a shorter-lived task`
                )
              );
            } else if (wire === "extension") {
              const hasInline =
                finalTask.status !== "completed" ||
                finalTask.result !== undefined;
              const failedCarriesError =
                finalTask.status !== "failed" || isRecord(finalTask.error);
              checks.push(
                hasInline && failedCarriesError
                  ? passed("tasks-inline-result", Date.now() - stepStartedAt, {
                      status: finalTask.status,
                    })
                  : failed(
                      "tasks-inline-result",
                      Date.now() - stepStartedAt,
                      hasInline
                        ? "a failed task must carry a JSON-RPC error object"
                        : "a completed task must carry its result INLINE on tasks/get (the extension has no tasks/result)",
                      { status: finalTask.status }
                    )
              );
            } else {
              try {
                const result = await manager.getTaskResult(
                  serverId,
                  createdTaskId
                );
                checks.push(
                  isRecord(result)
                    ? passed(
                        "tasks-inline-result",
                        Date.now() - stepStartedAt,
                        {
                          status: finalTask.status,
                        }
                      )
                    : failed(
                        "tasks-inline-result",
                        Date.now() - stepStartedAt,
                        "legacy tasks/result must return the original request's result"
                      )
                );
              } catch (error) {
                checks.push(
                  failed(
                    "tasks-inline-result",
                    Date.now() - stepStartedAt,
                    `legacy tasks/result failed: ${errorMessage(error)}`,
                    undefined,
                    error
                  )
                );
              }
            }
          }

          if (selected.has("tasks-input-required-update-completes")) {
            const stepStartedAt = Date.now();
            if (wire !== "extension") {
              checks.push(
                notApplicable(
                  "tasks-input-required-update-completes",
                  "the input_required round trip is an extension-wire flow"
                )
              );
            } else if (!createdTaskId) {
              // NO TASK is a gap, not an inapplicability: the obligation went
              // untested because the run could not provoke a task at all.
              // `noTask` already draws that distinction (and reports the
              // no-probe-tool case the way resolution decided).
              checks.push(noTask("tasks-input-required-update-completes"));
            } else if (!inputRequiredTask) {
              // A task that completes without ever asking for anything is the
              // normal case, and there is genuinely no round trip to grade —
              // so this one IS an inapplicability.
              checks.push(
                notApplicable(
                  "tasks-input-required-update-completes",
                  `task ${createdTaskId} never reported input_required, so there was no round trip to complete`
                )
              );
            } else if (!inputLeg || inputLeg.outcome === "no-responses-configured") {
              checks.push(
                couldNotRun(
                  "tasks-input-required-update-completes",
                  `task requested input for ${JSON.stringify(
                    inputLeg?.requested ?? []
                  )} but no inputResponses were configured; supply inputResponses so the tasks/update leg can be exercised`,
                  { requested: inputLeg?.requested ?? [] }
                )
              );
            } else if (inputLeg.outcome === "update-rejected") {
              checks.push(
                failed(
                  "tasks-input-required-update-completes",
                  Date.now() - stepStartedAt,
                  `tasks/update was rejected for a task that reported input_required (${
                    inputLeg.code ?? "no code"
                  }: ${inputLeg.message ?? "no message"})`,
                  { requested: inputLeg.requested, answered: inputLeg.answered }
                )
              );
            } else {
              const problems: string[] = [
                ...(inputLeg.ackVerdict?.violations ?? []),
              ];
              const ackWarnings = inputLeg.ackVerdict?.warnings ?? [];
              if (
                inputLeg.finalStatus === undefined ||
                !TERMINAL_STATUSES.has(inputLeg.finalStatus)
              ) {
                problems.push(
                  `the task did not reach a terminal status after the update (last observed ${JSON.stringify(
                    inputLeg.finalStatus ?? null
                  )} within ${this.config.pollTimeoutMs}ms)`
                );
              }
              checks.push(
                problems.length === 0
                  ? passed(
                      "tasks-input-required-update-completes",
                      Date.now() - stepStartedAt,
                      {
                        requested: inputLeg.requested,
                        answered: inputLeg.answered,
                        finalStatus: inputLeg.finalStatus,
                      },
                      ackWarnings
                    )
                  : failed(
                      "tasks-input-required-update-completes",
                      Date.now() - stepStartedAt,
                      `the input_required round trip did not complete: ${problems.join(
                        "; "
                      )}`,
                      {
                        requested: inputLeg.requested,
                        answered: inputLeg.answered,
                        finalStatus: inputLeg.finalStatus,
                      }
                    )
              );
            }
          }

          if (selected.has("tasks-status-payload-shape")) {
            const stepStartedAt = Date.now();
            // The payload rules below are the EXTENSION's (`result` inline on
            // `completed`, `error` on `failed`, `inputRequests` on
            // `input_required`). The legacy 2025-11-25 wire delivers a
            // completed task's result through a separate `tasks/result` call,
            // so grading a legacy payload against them reports a violation the
            // server never committed. Every sibling check gates on this; this
            // one did not.
            //
            // RAW, not the decoded task: the SDK's own payload schema rejects a
            // `failed` task with no `error` before any check sees it, so
            // reading the decoded task would score a server green on exactly
            // the malformed states this check exists to catch.
            //
            // EVERY observed payload, not just the final one. A run that
            // answers an `input_required` gate sees several statuses, and
            // grading only the state the task ended in would let a malformed
            // `input_required` frame pass behind a well-formed `completed` one.
            const rawStates =
              createdTaskId && wire === "extension"
                ? findRawTaskStates(
                    received,
                    createdTaskId,
                    sentRequestIds(sent, "tasks/get")
                  )
                : [];
            if (wire !== "extension") {
              checks.push(
                notApplicable(
                  "tasks-status-payload-shape",
                  "check applies to the extension wire only"
                )
              );
            } else if (rawStates.length === 0) {
              checks.push(
                createdTaskId
                  ? couldNotRun(
                      "tasks-status-payload-shape",
                      `no raw tasks/get payload for task ${createdTaskId} was observed, so no status payload could be inspected`
                    )
                  : noTask("tasks-status-payload-shape")
              );
            } else {
              // Deduped by status + text: a server re-sends the same snapshot on
              // every poll while a gate is open, and reporting one violation
              // per poll would bury the finding in repeats of itself.
              const violations = new Set<string>();
              const warnings = new Set<string>();
              for (const state of rawStates) {
                const verdict = validateTaskStatusPayload(state);
                for (const violation of verdict.violations) {
                  violations.add(`${String(state.status)}: ${violation}`);
                }
                for (const warning of verdict.warnings) {
                  warnings.add(`${String(state.status)}: ${warning}`);
                }
              }
              const observedStatuses = [
                ...new Set(rawStates.map((state) => String(state.status))),
              ];
              const details = {
                observedStatuses,
                inspectedPayloads: rawStates.length,
              };
              checks.push(
                violations.size === 0
                  ? passed(
                      "tasks-status-payload-shape",
                      Date.now() - stepStartedAt,
                      details,
                      warnings.size > 0 ? [...warnings] : undefined
                    )
                  : failed(
                      "tasks-status-payload-shape",
                      Date.now() - stepStartedAt,
                      `task status payload is incomplete: ${[...violations].join(
                        "; "
                      )}`,
                      details
                    )
              );
            }
          }

          if (selected.has("tasks-ttl-integer-shape")) {
            const stepStartedAt = Date.now();
            if (wire !== "extension") {
              // "integer milliseconds" is the EXTENSION's `Task` interface
              // talking. The legacy wire's `ttl`/`pollInterval` carry no such
              // statement, so grading them here would fail a legacy server
              // against a requirement its revision never made.
              checks.push(
                notApplicable(
                  "tasks-ttl-integer-shape",
                  "the integer-milliseconds statement belongs to the tasks extension; the legacy wire states no such bound"
                )
              );
            } else if (!finalTask) {
              checks.push(noTask("tasks-ttl-integer-shape"));
            } else {
              const verdict = validateTaskTtlIntegerShape(wire, finalTask);
              checks.push(
                verdict.violations.length === 0
                  ? passed(
                      "tasks-ttl-integer-shape",
                      Date.now() - stepStartedAt,
                      undefined,
                      verdict.warnings
                    )
                  : failed(
                      "tasks-ttl-integer-shape",
                      Date.now() - stepStartedAt,
                      `task TTL/poll interval are not integer milliseconds: ${verdict.violations.join(
                        "; "
                      )}`,
                      undefined,
                      undefined
                    )
              );
            }
          }

          if (selected.has("tasks-invalid-task-id-rejected")) {
            const stepStartedAt = Date.now();
            if (wire !== "extension") {
              checks.push(
                notApplicable(
                  "tasks-invalid-task-id-rejected",
                  "check applies to the extension wire only"
                )
              );
            } else {
              const probe = await this.probeUnknownTaskId(manager, serverId);
              const warnings: string[] = [];
              // tasks.md:795 — `-32602` is a MUST for `tasks/get` and only a
              // SHOULD for the two mutating methods, so the same wrong answer
              // is a failure on one and advice on the others.
              for (const entry of probe.mutations) {
                if (entry.outcome === "local-failure") continue;
                if (entry.code !== INVALID_PARAMS) {
                  warnings.push(
                    `${entry.method} answered an unknown task id with ${
                      entry.outcome === "answered"
                        ? "a normal result"
                        : String(entry.code)
                    } rather than -32602; the extension states that as a SHOULD`
                  );
                }
              }
              const detail = { probedTaskId: probe.taskId, ...probe.detail };
              checks.push(
                probe.get.outcome === "local-failure"
                  ? couldNotRun(
                      "tasks-invalid-task-id-rejected",
                      `tasks/get for an unknown task id produced no JSON-RPC response (${
                        probe.get.message ?? "no message"
                      }), so the rejection requirement was not put to the server`,
                      detail
                    )
                  : probe.get.code === INVALID_PARAMS
                    ? passed(
                        "tasks-invalid-task-id-rejected",
                        Date.now() - stepStartedAt,
                        detail,
                        warnings
                      )
                    : failed(
                        "tasks-invalid-task-id-rejected",
                        Date.now() - stepStartedAt,
                        probe.get.outcome === "answered"
                          ? `tasks/get for the unknown task id ${JSON.stringify(
                              probe.taskId
                            )} was answered instead of rejected; the extension requires -32602 (Invalid params)`
                          : `tasks/get for an unknown task id was rejected with ${probe.get.code} rather than -32602 (Invalid params)`,
                        detail
                      )
              );
            }
          }

          if (selected.has("tasks-mcp-name-routing")) {
            const stepStartedAt = Date.now();
            const isHttp = "url" in this.config.serverConfig;
            if (!isHttp) {
              checks.push(
                notApplicable(
                  "tasks-mcp-name-routing",
                  "Mcp-Name routing applies to HTTP transports only"
                )
              );
            } else if (wire !== "extension") {
              checks.push(
                notApplicable(
                  "tasks-mcp-name-routing",
                  "Mcp-Name task routing applies to the extension wire only"
                )
              );
            } else if (!createdTaskId) {
              checks.push(noTask("tasks-mcp-name-routing"));
            } else {
              // The requirement is about the OUTBOUND request, so the header
              // is captured off the fetch seam rather than inferred from a
              // successful read (a server that ignores the header would make a
              // read-only assertion pass vacuously).
              const observed = await captureTaskRequestHeaders(() =>
                manager.getTaskExt(serverId, createdTaskId)
              );
              const mcpName = observed.headers?.["mcp-name"];
              const mcpMethod = observed.headers?.["mcp-method"];
              checks.push(
                observed.error !== undefined
                  ? failed(
                      "tasks-mcp-name-routing",
                      Date.now() - stepStartedAt,
                      `tasks/get routed with Mcp-Name was rejected: ${errorMessage(
                        observed.error
                      )}`,
                      { taskId: createdTaskId, mcpName, mcpMethod },
                      observed.error
                    )
                  : mcpName === createdTaskId
                    ? passed(
                        "tasks-mcp-name-routing",
                        Date.now() - stepStartedAt,
                        { taskId: createdTaskId, mcpName, mcpMethod }
                      )
                    : failed(
                        "tasks-mcp-name-routing",
                        Date.now() - stepStartedAt,
                        observed.headers === undefined
                          ? "the routed poll succeeded but no HTTP request carrying Mcp-Name was observed, so the required routing header could not be verified"
                          : `tasks/get was routed with Mcp-Name ${JSON.stringify(
                              mcpName
                            )}; the extension requires the task id`,
                        { taskId: createdTaskId, mcpName, mcpMethod }
                      )
              );
            }
          }

          // ORDERING: the undeclared probes run LAST of the task-touching
          // checks, and deliberately so. `tasks/update` and `tasks/cancel`
          // MUTATE a task, and this check exists precisely because a server
          // may wrongly accept them — so they must not be able to corrupt any
          // other check's subject. By this point the task has already been
          // polled to a terminal status and read by tasks-ttl-shape,
          // tasks-inline-result and tasks-mcp-name-routing, so nothing left in
          // the run depends on its state. Only tasks-declaration-hygiene
          // follows, and it inspects captured outbound traffic (where an
          // undeclared probe is, correctly, no violation at all).
          // ONE undeclared probe round, shared by the two checks that read it:
          // whether the rejection HAPPENED, and whether it NAMED the missing
          // capability. Probing twice would send four more mutating requests to
          // say the same thing, and let the two checks disagree about what the
          // server answered.
          let undeclaredProbes: UndeclaredProbe[] | undefined;
          const needsUndeclaredProbes =
            selected.has("tasks-undeclared-capability-rejected") ||
            selected.has("tasks-undeclared-capability-names-requirements");
          if (needsUndeclaredProbes && wire === "extension" && createdTaskId) {
            undeclaredProbes = await this.probeUndeclaredTaskMethods(
              manager,
              serverId,
              createdTaskId,
              sent
            );
          }

          if (selected.has("tasks-undeclared-capability-rejected")) {
            const stepStartedAt = Date.now();
            if (wire !== "extension") {
              checks.push(
                notApplicable(
                  "tasks-undeclared-capability-rejected",
                  "check applies to the extension wire only"
                )
              );
            } else if (!createdTaskId) {
              checks.push(noTask("tasks-undeclared-capability-rejected"));
            } else {
              const probes = undeclaredProbes;
              if (probes === undefined) {
                checks.push(
                  couldNotRun(
                    "tasks-undeclared-capability-rejected",
                    "the connection exposes no raw request seam, so an undeclared call could not be sent and the -32021 requirement was not tested"
                  )
                );
              } else {
                // tasks.md:797-799 — the server MUST answer -32021 for a
                // non-declaring client on tasks/get, tasks/update,
                // tasks/cancel and on task notifications requested through
                // subscriptions/listen. This is UNCONDITIONAL; anything else
                // (an answer, or another error code) is a violation.
                const offenders = probes.filter(
                  (probe) =>
                    probe.outcome !== "rejected" &&
                    probe.outcome !== "unsupported"
                );
                const warnings = probes
                  .filter((probe) => probe.outcome === "unsupported")
                  .map(
                    (probe) =>
                      `${probe.method} is not implemented by this server (-32601), so its undeclared-request requirement was not probed`
                  );
                checks.push(
                  offenders.length === 0
                    ? passed(
                        "tasks-undeclared-capability-rejected",
                        Date.now() - stepStartedAt,
                        { taskId: createdTaskId, probes },
                        warnings
                      )
                    : failed(
                        "tasks-undeclared-capability-rejected",
                        Date.now() - stepStartedAt,
                        `${
                          offenders.length
                        } undeclared request(s) were not rejected with -32021 (Missing Required Client Capability): ${offenders
                          .map(describeUndeclaredProbe)
                          .join("; ")}`,
                        { taskId: createdTaskId, probes }
                      )
                );
              }
            }
          }

          if (selected.has("tasks-undeclared-capability-names-requirements")) {
            const stepStartedAt = Date.now();
            if (wire !== "extension") {
              checks.push(
                notApplicable(
                  "tasks-undeclared-capability-names-requirements",
                  "check applies to the extension wire only"
                )
              );
            } else if (!createdTaskId) {
              // Distinct from the seam case below, and the distinction is the
              // whole product of a `could-not-run`: "no task existed to probe
              // with" and "the connection cannot send an undeclared request"
              // point the operator at different fixes.
              checks.push(
                noTask("tasks-undeclared-capability-names-requirements")
              );
            } else if (undeclaredProbes === undefined) {
              checks.push(
                couldNotRun(
                  "tasks-undeclared-capability-names-requirements",
                  "the connection exposes no raw request seam, so no undeclared request could be sent and no -32021 payload could be inspected"
                )
              );
            } else {
              const rejections = undeclaredProbes.filter(
                (probe) => probe.outcome === "rejected"
              );
              // The core schema types this member as `ClientCapabilities` and
              // marks it REQUIRED on the error, so anything that is not an
              // object — absent, null, an array, a string — violates it.
              const unnamed = rejections.filter(
                (probe) => !isRecord(probe.requiredCapabilities)
              );
              // Naming the tasks extension specifically is what the extension's
              // own examples show, and it is what makes the error actionable —
              // but the SCHEMA only says `ClientCapabilities`, so demanding the
              // exact key would promote an example to a requirement. Advice.
              const unspecific = rejections.filter((probe) => {
                const capabilities = probe.requiredCapabilities;
                if (!isRecord(capabilities)) return false;
                const extensions = capabilities.extensions;
                return (
                  !isRecord(extensions) ||
                  !(MCP_TASKS_EXTENSION_ID in extensions)
                );
              });
              checks.push(
                rejections.length === 0
                  ? couldNotRun(
                      "tasks-undeclared-capability-names-requirements",
                      "no request was rejected with -32021, so no error payload named a required capability"
                    )
                  : unnamed.length === 0
                    ? passed(
                        "tasks-undeclared-capability-names-requirements",
                        Date.now() - stepStartedAt,
                        {
                          rejections: rejections.map((probe) => ({
                            method: probe.method,
                            requiredCapabilities: probe.requiredCapabilities,
                          })),
                        },
                        unspecific.length > 0
                          ? [
                              `${unspecific.length} -32021 rejection(s) carry a requiredCapabilities object that does not name ${MCP_TASKS_EXTENSION_ID} under \`extensions\`: ${unspecific
                                .map((probe) => probe.method)
                                .join(", ")}. The extension's own examples do, and a client cannot act on a requirement it cannot identify`,
                            ]
                          : undefined
                      )
                    : failed(
                        "tasks-undeclared-capability-names-requirements",
                        Date.now() - stepStartedAt,
                        `${unnamed.length} -32021 rejection(s) carried no error.data.requiredCapabilities OBJECT: ${unnamed
                          .map((probe) => probe.method)
                          .join(", ")}. The core schema types it as ClientCapabilities and requires it; a client told it is missing a capability, but not which one, cannot act on the error`,
                        {
                          unnamed: unnamed.map((probe) => probe.method),
                        }
                      )
              );
            }
          }

          // ORDERING: cancellation MUTATES the task, so it runs AFTER the
          // undeclared probes, not before them. It used to sit above, and that
          // let a PENDING check move a SCORED one: a server is allowed to
          // forget a task once it is cancelled (`probeCancelAck` documents and
          // tolerates exactly that class), and the undeclared probes reuse the
          // same task id. Cancel first and those probes are answered `-32602`
          // "unknown task" instead of `-32021`, which
          // `tasks-undeclared-capability-rejected` — frozen into `mcp-tasks` —
          // scores as a wrong-code FAILURE. A conforming server would fail on
          // probe order alone.
          //
          // The reverse exposure is strictly smaller: a server that wrongly
          // ACCEPTS an undeclared mutation may leave the task altered before
          // this check reads it, but such a server is already failing the
          // scored check, and the check it degrades here is pending. Cancelling
          // a task that already reached a terminal status is a weaker probe
          // than cancelling one mid-flight, but the assertion holds either way:
          // the spec requires an EMPTY ack and explicitly allows the status to
          // stay non-`cancelled` afterwards.
          if (selected.has("tasks-cancel-ack-shape")) {
            const stepStartedAt = Date.now();
            if (wire !== "extension") {
              checks.push(
                notApplicable(
                  "tasks-cancel-ack-shape",
                  "check applies to the extension wire only"
                )
              );
            } else if (!createdTaskId) {
              checks.push(noTask("tasks-cancel-ack-shape"));
            } else {
              const cancel = await this.probeCancelAck(
                manager,
                serverId,
                createdTaskId,
                received
              );
              checks.push(
                cancel.unavailable !== undefined
                  ? couldNotRun("tasks-cancel-ack-shape", cancel.unavailable)
                  : cancel.problems.length === 0
                  ? passed(
                      "tasks-cancel-ack-shape",
                      Date.now() - stepStartedAt,
                      cancel.detail,
                      cancel.warnings
                    )
                  : failed(
                      "tasks-cancel-ack-shape",
                      Date.now() - stepStartedAt,
                      `tasks/cancel was not acknowledged as the extension requires: ${cancel.problems.join(
                        "; "
                      )}`,
                      cancel.detail
                    )
              );
            }
          }

          if (selected.has("tasks-declaration-hygiene")) {
            const stepStartedAt = Date.now();
            const violations = findDeclarationViolations(wire, sent);
            checks.push(
              violations.length === 0
                ? passed(
                    "tasks-declaration-hygiene",
                    Date.now() - stepStartedAt,
                    { inspectedRequests: sent.length, wire }
                  )
                : failed(
                    "tasks-declaration-hygiene",
                    Date.now() - stepStartedAt,
                    `${violations.length} declaration hygiene violation(s)`,
                    { violations }
                  )
            );
          }

          // Which of these the `mcp-tasks` profile scores. A check outside the
          // frozen manifest still ran and still shows its verdict in `checks`,
          // but it is excluded from the verdict and the score — a scenario
          // added this week must not retroactively fail a server that was green
          // last week. Same mechanism as the protocol suite, separate manifest.
          const { scored, pending } = partitionByProfile(checks, profile);
          // An empty SCORED set is not the same fact as an empty CHECK set.
          // `decideOutcome([])` says "no checks were selected", which is the
          // exact opposite of what happened when every selected check ran and
          // all of them are pending (`--check-id tasks-cancel-ack-shape`).
          // Same reasoning, and same shape, as the protocol runner.
          const verdict =
            scored.length === 0 && pending.length > 0
              ? {
                  outcome: "incomplete" as const,
                  incompleteReason: `all ${pending.length} selected check(s) ran but are unscored by profile ${profile.id}@${profile.version}, so this run establishes no conformance verdict`,
                }
              : decideOutcome(scored);

          return {
            passed: verdict.outcome === "passed",
            outcome: verdict.outcome,
            ...(verdict.incompleteReason
              ? { incompleteReason: verdict.incompleteReason }
              : {}),
            target: this.config.target,
            checks,
            summary:
              pending.length > 0
                ? `${buildSummary(scored)}, ${pending.length} pending (unscored by profile ${profile.id}@${profile.version})`
                : buildSummary(scored),
            durationMs: Date.now() - startedAt,
            // The tally reports EVERYTHING that ran, pending included: a report
            // that hid them would misstate what the run did.
            categorySummary: summarizeChecks(checks),
            profile: buildConformanceProfileStamp({
              profile,
              checks,
              ...(protocolVersion ? { protocolVersion } : {}),
            }),
            discovery: {
              protocolVersion,
              wire,
              toolCount: tools.length,
              taskCapableToolCount: taskCapableTools.length,
              ...(probeTool ? { probedTool: probeTool.name } : {}),
              ...(createdTaskId ? { createdTaskId } : {}),
            },
          };
        },
        {
          serverId: "__tasks_conformance__",
          clientName: "mcpjam-sdk-tasks-conformance",
          timeout: this.config.timeout,
          rpcLogger: captureRpc,
        }
      );
    } catch (error) {
      const failure = failed(
        "tasks-wire-resolvable",
        Date.now() - startedAt,
        `Failed to connect to ${this.config.target}: ${errorMessage(error)}`,
        undefined,
        error
      );
      return {
        passed: false,
        outcome: "failed",
        target: this.config.target,
        checks: [failure],
        summary: buildSummary([failure]),
        durationMs: Date.now() - startedAt,
        categorySummary: summarizeChecks([failure]),
        profile: buildConformanceProfileStamp({ profile, checks: [failure] }),
        discovery: {
          wire: "none",
          toolCount: 0,
          taskCapableToolCount: 0,
        },
      };
    }
  }

  /**
   * Task id out of a creation result. Shape-based (`taskId`), but it reads a
   * result the manager has ALREADY discriminated on `resultType === "task"`,
   * so it identifies the task rather than detecting one.
   */
  private extractTaskId(wire: TasksWire, result: unknown): string | undefined {
    if (!isRecord(result)) return undefined;
    if (wire === "extension") {
      return typeof result.taskId === "string" ? result.taskId : undefined;
    }
    const task = isRecord(result.task) ? result.task : undefined;
    return typeof task?.taskId === "string" ? task.taskId : undefined;
  }

  /**
   * Runs a `tools/call` WITHOUT the extension declaration (`allowTaskResult`
   * omitted, so the manager sends no capability envelope) and reports what the
   * server did.
   *
   * The outcome is deliberately four-valued rather than a boolean. A boolean
   * `taskCreated: false` collapses "the server honoured tasks.md:61" with "the
   * probe blew up before it proved anything", and the check counted BOTH as a
   * pass. Only an actual server response can pass here:
   *
   *   - `created`  — a `CreateTaskResult` came back: the violation.
   *   - `answered` — a normal tool result: conformant.
   *   - `refused`  — a JSON-RPC error response: also conformant (no task was
   *     handed to a non-declaring client), with `-32021` being the refusal the
   *     spec names and any other code carried through as a warning.
   *   - `errored`  — no JSON-RPC response exists at all. Same v2 discriminator
   *     as {@link runUndeclaredProbe}: `ProtocolError` carries a NUMERIC code
   *     and is minted only from a server error response, while local and
   *     transport faults are `SdkError`s with STRING codes. This is a check
   *     FAILURE, because nothing about the server was observed.
   *
   * THREE places have to be read, and the wire is the last word. Beyond the
   * decoded result and the manager's `_meta` stash, the RAW response decides:
   * a task payload with no `resultType: "task"` is invisible to both of the
   * others (see {@link findRawTaskResponse}), so a server that violates
   * tasks.md:61 AND tasks.md:102 at once would otherwise score a pass on the
   * strength of its second violation.
   */
  private async probeUndeclaredCreation(
    manager: MCPClientManager,
    serverId: string,
    toolName: string,
    received: unknown[]
  ): Promise<
    | { outcome: "created"; taskId: string; discriminated: boolean }
    | { outcome: "answered" }
    | { outcome: "refused"; code: number; message: string }
    | { outcome: "errored"; message: string }
  > {
    const receivedBefore = received.length;
    const rawTask = () => findRawTaskResponse(received.slice(receivedBefore));
    try {
      const result = await manager.executeTool(
        serverId,
        toolName,
        this.config.toolArguments ?? {}
      );
      const raw = rawTask();
      const taskId = extractUndeclaredCreationTaskId(result) ?? raw?.taskId;
      return taskId === undefined
        ? { outcome: "answered" }
        : {
            outcome: "created",
            taskId,
            discriminated: raw?.discriminated ?? true,
          };
    } catch (error) {
      // An undiscriminated task can also blow up result decoding; the wire
      // still says a task was created, and that is the violation.
      const raw = rawTask();
      if (raw) {
        return {
          outcome: "created",
          taskId: raw.taskId,
          discriminated: raw.discriminated,
        };
      }
      const code = errorCode(error);
      const message = errorMessage(error);
      return code === undefined
        ? { outcome: "errored", message }
        : { outcome: "refused", code, message };
    }
  }

  /**
   * Sends every request the extension requires a server to refuse from a
   * non-declaring client, WITHOUT the declaration, and reports each outcome.
   * The manager's task APIs always attach the declaration, so these go through
   * the connection's raw request seam; `undefined` means there is no such seam.
   *
   * Probe order is least- to most-invasive against the (already terminal)
   * task: read, then a no-op update, then the listen subscription, and
   * `tasks/cancel` last — a server that wrongly accepts one of these must not
   * change what the next one observes.
   *
   * ERA GATE: on a 2026-07-28 connection, upstream refuses to SEND `tasks/get`
   * and `tasks/cancel` (they are 2025-registry members the modern registry
   * dropped); `tasks-ext-era-gate.ts` shadows that gate, and installs the shadow
   * LAZILY on the first extension tasks operation. These probes bypass the
   * manager's tasks APIs, so they must ask for the shadow themselves rather
   * than lean on an earlier `getTaskExt` having triggered it — `ensure…` is
   * idempotent and a no-op for a client the factory never registered.
   * Belt and braces: if the gate ever did fire, it throws an `SdkError` with a
   * STRING code, so the probe reports `probe-failed` (an offender), never a pass.
   */
  private async probeUndeclaredTaskMethods(
    manager: MCPClientManager,
    serverId: string,
    taskId: string,
    sent: unknown[]
  ): Promise<UndeclaredProbe[] | undefined> {
    // `getManagedClient()`, not `getClient()`: the raw upstream `Client`'s
    // `request()` has no explicit-schema form on this SDK's surface, and its
    // schema-less form cannot carry a `tasks/*` method (see {@link RawRequest}).
    // The managed client's `requestWithSchema` is the same seam `tasks-ext.ts`
    // uses for the DECLARING calls, minus the declaration — which is precisely
    // the probe. Nothing in the wrapper chain adds the tasks capability: the
    // only `_meta` a wrapper injects is `LogLevelMetaClient`'s log level.
    const client = manager.getManagedClient(serverId);
    if (typeof client?.requestWithSchema !== "function") return undefined;
    // See the ERA GATE note above: the declaring path installs this on its own
    // first send, the probes must ask.
    ensureTasksExtensionEraGateShadow(client);

    const request: RawRequest = (payload, options) =>
      client.requestWithSchema(
        payload as never,
        RAW_PROBE_RESULT_SCHEMA,
        options as never
      );

    const probes: UndeclaredProbe[] = [];
    probes.push(
      await runUndeclaredProbe(request, sent, "tasks/get", { taskId })
    );
    // An EMPTY `inputResponses` map submits nothing, so even a server that
    // wrongly accepts this update cannot advance the task with it.
    probes.push(
      await runUndeclaredProbe(request, sent, "tasks/update", {
        taskId,
        inputResponses: {},
      })
    );
    probes.push(
      await runUndeclaredProbe(
        request,
        sent,
        "subscriptions/listen",
        { notifications: { taskIds: [taskId] } },
        { timeout: LISTEN_PROBE_TIMEOUT_MS, listenProbe: true }
      )
    );
    probes.push(
      await runUndeclaredProbe(request, sent, "tasks/cancel", { taskId })
    );
    return probes;
  }

  /**
   * Polls until terminal, the deadline, or the first poll error.
   *
   * The poll error is RETURNED rather than swallowed: a `tasks/get` that throws
   * is the difference between "the server never produced a task to inspect"
   * (a genuine skip) and "the task exists but reading it failed" (which the
   * dependent checks must name, not silently skip past).
   */
  /**
   * Drive `input_required → tasks/update → completion`, the one leg of the
   * task lifecycle a poll-only runner can never reach.
   *
   * Returns what happened rather than a verdict, so the check below can tell
   * "the operator supplied no answers" (a skip) from "the update was rejected"
   * and from "the update was acknowledged but the task never moved" (both
   * failures). The ack shape is asserted here because the spec is specific
   * about it: "On success, the server MUST acknowledge the request with an
   * empty result."
   */
  private async runInputRequiredLeg(
    manager: MCPClientManager,
    serverId: string,
    taskId: string,
    task: Record<string, unknown>,
    /** Live rpc-log window, so the ack can be judged as it arrived. */
    received: unknown[]
  ): Promise<InputRequiredLeg> {
    const requested = isRecord(task.inputRequests)
      ? Object.keys(task.inputRequests)
      : [];
    const responses = this.config.inputResponses;

    if (!responses || Object.keys(responses).length === 0) {
      return { outcome: "no-responses-configured", requested };
    }

    const answered = Object.keys(responses);
    const receivedBefore = received.length;
    let ack: unknown;
    try {
      ack = await manager.updateTask(
        serverId,
        taskId,
        responses as never
      );
    } catch (error) {
      return {
        outcome: "update-rejected",
        requested,
        answered,
        message: errorMessage(error),
        code: errorCode(error),
      };
    }

    // "the server MUST acknowledge the request with an empty result". The
    // envelope member `resultType` and the `_meta` container are part of every
    // result, so they are not "content" — anything else is the server answering
    // with state the client is told to re-poll for.
    const ackVerdict = validateCompletionAck(
      ack,
      "tasks/update",
      findRawResult(received.slice(receivedBefore))
    );

    const polled = await this.pollToTerminal(manager, serverId, "extension", taskId);
    return {
      outcome: "updated",
      requested,
      answered,
      ackVerdict,
      polled,
      finalStatus: polled.task ? String(polled.task.status) : undefined,
    };
  }

  /**
   * Ask for a task the server never issued.
   *
   * The id is deliberately fabricated rather than derived from a real one: a
   * mutated real id could collide with a live task on a busy server, and this
   * probe must never touch one.
   *
   * All three methods are probed, but they are NOT graded alike — the extension
   * makes `-32602` a MUST for `tasks/get` and only a SHOULD for `tasks/update`
   * and `tasks/cancel`, so the caller fails on the first and advises on the
   * others. `tasks/update` carries an EMPTY `inputResponses`, so even a server
   * that wrongly accepts it cannot advance anything.
   */
  private async probeUnknownTaskId(
    manager: MCPClientManager,
    serverId: string
  ): Promise<{
    taskId: string;
    get: {
      outcome: "answered" | "rejected" | "local-failure";
      code?: number;
      message?: string;
    };
    mutations: Array<{
      method: string;
      outcome: "answered" | "rejected" | "local-failure";
      code?: number;
      message?: string;
    }>;
    detail: Record<string, unknown>;
  }> {
    const taskId = `mcpjam-conformance-unknown-task-${Date.now()}`;

    /**
     * `answered` and `local-failure` are NOT the same nothing. A numeric code is
     * minted only from a server error response, so its absence means the probe
     * never got a verdict — grading that as "the server answered an unknown id"
     * would report a defect we never observed. Same distinction
     * `runUndeclaredProbe` draws through `reachedWire`.
     */
    const observe = async (
      call: () => Promise<unknown>
    ): Promise<{
      outcome: "answered" | "rejected" | "local-failure";
      code?: number;
      message?: string;
    }> => {
      try {
        await call();
        return { outcome: "answered" };
      } catch (error) {
        const code = errorCode(error);
        return code === undefined
          ? { outcome: "local-failure", message: errorMessage(error) }
          : { outcome: "rejected", code, message: errorMessage(error) };
      }
    };

    const get = await observe(() => manager.getTaskExt(serverId, taskId));
    const update = await observe(() =>
      manager.updateTask(serverId, taskId, {} as never)
    );
    const cancel = await observe(() => manager.cancelTaskExt(serverId, taskId));

    return {
      taskId,
      get,
      mutations: [
        { method: "tasks/update", ...update },
        { method: "tasks/cancel", ...cancel },
      ],
      detail: { get, update, cancel },
    };
  }

  /**
   * `tasks/cancel` on a real task.
   *
   * Asserts ONLY what the extension states: "On success, the server MUST
   * acknowledge the request with an empty result." It deliberately does NOT
   * require the task to become `cancelled` — the spec says cancellation is
   * eventually consistent, that the status "MAY remain working (or some other
   * non-terminal status) after the ack", and "MAY ultimately reach a terminal
   * status other than cancelled if the work finished before cancellation could
   * take effect". A check that demanded `cancelled` would fail servers for
   * behavior the spec explicitly permits.
   */
  private async probeCancelAck(
    manager: MCPClientManager,
    serverId: string,
    taskId: string,
    /** Live rpc-log window, so the ack can be judged as it arrived. */
    received: unknown[]
  ): Promise<{
    problems: string[];
    warnings: string[];
    detail: Record<string, unknown>;
    /** Set when the probe never produced a server verdict to grade. */
    unavailable?: string;
  }> {
    const problems: string[] = [];
    const warnings: string[] = [];

    const receivedBefore = received.length;
    let ack: unknown;
    try {
      ack = await manager.cancelTaskExt(serverId, taskId);
    } catch (error) {
      const code = errorCode(error);
      // The same "is this a server verdict?" test `runUndeclaredProbe` makes:
      // a numeric code is minted only from a server error response, while a
      // local or transport fault carries none. Grading the latter as a
      // conformance failure would report a defect we never observed.
      if (code === undefined) {
        return {
          problems: [],
          warnings: [],
          detail: { taskId },
          unavailable: `tasks/cancel produced no JSON-RPC response (${errorMessage(
            error
          )}), so the acknowledgement requirement was not put to the server`,
        };
      }
      // A server that has already finished and forgotten the task answers the
      // unknown-id error, which is a legitimate outcome for a probe that runs
      // after the task reached a terminal status. Reported, not failed.
      if (code === INVALID_PARAMS) {
        return {
          problems: [],
          warnings: [
            `tasks/cancel for the already-terminal task ${taskId} was answered with -32602; the server no longer knows the task, which the extension permits`,
          ],
          detail: { taskId, cancelCode: code },
        };
      }
      problems.push(
        `tasks/cancel raised ${code ?? "no JSON-RPC code"}: ${errorMessage(error)}`
      );
      return { problems, warnings, detail: { taskId, cancelCode: code } };
    }

    const ackVerdict = validateCompletionAck(
      ack,
      "tasks/cancel",
      findRawResult(received.slice(receivedBefore))
    );
    problems.push(...ackVerdict.violations);
    warnings.push(...ackVerdict.warnings);

    return {
      problems,
      warnings,
      detail: {
        taskId,
        ackKeys: isRecord(ack) ? Object.keys(ack) : undefined,
        ...(isRecord(ack) ? {} : { ack }),
      },
    };
  }

  private async pollToTerminal(
    manager: MCPClientManager,
    serverId: string,
    wire: TasksWire,
    taskId: string,
    options?: { stopOnInputRequired?: boolean }
  ): Promise<{
    task?: Record<string, unknown>;
    error?: unknown;
    /** Set when polling stopped because the task parked on `input_required`. */
    inputRequired?: boolean;
  }> {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    let last: Record<string, unknown> | undefined;
    let consecutiveInputRequired = 0;

    while (Date.now() < deadline) {
      try {
        const task =
          wire === "extension"
            ? ((await manager.getTaskExt(serverId, taskId)) as unknown)
            : ((await manager.getTask(serverId, taskId)) as unknown);
        last = isRecord(task) ? task : undefined;
      } catch (error) {
        return { task: last, error };
      }

      // A task PARKED on `input_required` cannot advance until the CLIENT
      // answers, so polling it to the deadline burns `pollTimeoutMs` to arrive
      // at the state it was already in — and every dependent check then reports
      // `could-not-run` many seconds later than it had to. Stopping returns the
      // same task, sooner.
      //
      // But "parked" has to be OBSERVED, not assumed from one frame.
      // `input_required` is also a state a task can pass THROUGH: a server may
      // time its own gate out, fail the task, or have the request answered by
      // something outside this run. Returning on first sight would freeze such
      // a task mid-flight and report `tasks-inline-result` — a check the
      // `mcp-tasks` profile SCORES — as could-not-run for a server whose task
      // would have completed well inside the budget. That is a scored verdict
      // moving on our polling strategy rather than on the server.
      //
      // Requiring consecutive observations distinguishes the two: a genuinely
      // parked task still stops after a handful of polls, and a transiting one
      // is allowed to advance.
      if (
        options?.stopOnInputRequired === true &&
        last &&
        String(last.status) === "input_required"
      ) {
        consecutiveInputRequired += 1;
        if (consecutiveInputRequired >= PARKED_INPUT_REQUIRED_POLLS) {
          return { task: last, inputRequired: true };
        }
      } else {
        consecutiveInputRequired = 0;
      }

      if (last && TERMINAL_STATUSES.has(String(last.status)))
        return { task: last };

      const suggested = last
        ? Number(last.pollIntervalMs ?? last.pollInterval)
        : NaN;
      const waitMs =
        Number.isFinite(suggested) && suggested > 0 ? suggested : 250;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    return { task: last };
  }
}
