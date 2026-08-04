/**
 * MCP Tasks conformance runner.
 *
 * Mirrors `apps-conformance/` in shape, but the subject is the *wire*: which
 * tasks wire the connection resolves to, whether the client-side declaration
 * hygiene holds for that wire, and whether the server honours the parts of the
 * contract a debugger can observe from the outside (result-type discipline,
 * `-32003` on an undeclared capability, inline results, TTL shapes, and
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
import { MCP_TASKS_EXTENSION_ID } from "../mcp-client-manager/tasks-dispatch.js";
import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";
import { CLIENT_CAPABILITIES_META_KEY } from "../mcp-client-manager/tasks-ext.js";
import { ensureTasksExtensionEraGateShadow } from "../mcp-client-manager/tasks-ext-era-gate.js";
import { TASK_CREATED_META_KEY } from "../mcp-client-manager/transport-utils.js";
import { withEphemeralClient } from "../operations.js";
import {
  buildOutcomeSummary,
  decideConformanceOutcome,
  isUnrunCheck,
} from "../conformance-outcome.js";
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
      "On the extension wire, a tools/call that did not carry the extension declaration must not come back as a CreateTaskResult: the server either answers normally or rejects with -32003.",
  },
  "tasks-undeclared-capability-rejected": {
    id: "tasks-undeclared-capability-rejected",
    category: "lifecycle",
    title: "Undeclared Capability Rejected",
    description:
      "tasks/get, tasks/update, tasks/cancel and a task-filtered subscriptions/listen sent WITHOUT the extension declaration must each be rejected with -32003 (Missing Required Client Capability).",
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
};

type MCPListedTool = NonNullable<ListToolsResult["tools"]>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      ...(rawError === undefined ? {} : { details: rawError }),
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

/** Missing Required Client Capability — the only conformant answer here. */
const MISSING_REQUIRED_CLIENT_CAPABILITY = -32003;
/** Method not found: the server does not implement the method at all. */
const METHOD_NOT_FOUND = -32601;
/** The client gave up waiting — the server never refused the request. */
const REQUEST_TIMEOUT = -32001;

/**
 * Cap on the undeclared `subscriptions/listen` probe. A conforming server
 * refuses it immediately with `-32003`; one that wrongly accepts opens a
 * long-lived stream, so the probe — not the server — decides when to stop.
 */
const LISTEN_PROBE_TIMEOUT_MS = 5_000;

/** What a server did with a request that carried no extension declaration. */
export type UndeclaredProbeOutcome =
  /** Rejected with -32003: the required behavior. */
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
      return `${probe.method} was rejected with ${probe.code} rather than -32003`;
    case "no-response":
      return `${probe.method} produced no JSON-RPC rejection (${
        probe.message ?? "no answer"
      }); a conforming server refuses it immediately with -32003`;
    case "probe-failed":
      return `${probe.method} never reached the server (${
        probe.message ?? "no answer"
      }), so the undeclared-request requirement was NOT tested`;
    case "unsupported":
      return `${probe.method} is not implemented (-32601)`;
    case "rejected":
      return `${probe.method} was rejected with -32003`;
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
      return { method, outcome: "rejected", code, reachedWire: true };
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
                    `an undeclared tools/call returned a CreateTaskResult; a server must not create a task for a client that never declared the tasks capability (it must answer normally or reject with -32003)${
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
                          `the undeclared tools/call was rejected with ${creation.code} rather than -32003; no task was created (which is what tasks.md:61 requires) but the refusal is not the one the extension names`,
                        ]
                      : undefined
                  )
                );
              }
            }
          }

          const polled = createdTaskId
            ? await this.pollToTerminal(manager, serverId, wire, createdTaskId)
            : {};
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
              const probes = await this.probeUndeclaredTaskMethods(
                manager,
                serverId,
                createdTaskId,
                sent
              );
              if (probes === undefined) {
                checks.push(
                  couldNotRun(
                    "tasks-undeclared-capability-rejected",
                    "the connection exposes no raw request seam, so an undeclared call could not be sent and the -32003 requirement was not tested"
                  )
                );
              } else {
                // tasks.md:797-799 — the server MUST answer -32003 for a
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
                        } undeclared request(s) were not rejected with -32003 (Missing Required Client Capability): ${offenders
                          .map(describeUndeclaredProbe)
                          .join("; ")}`,
                        { taskId: createdTaskId, probes }
                      )
                );
              }
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

          const verdict = decideOutcome(checks);

          return {
            passed: verdict.outcome === "passed",
            outcome: verdict.outcome,
            ...(verdict.incompleteReason
              ? { incompleteReason: verdict.incompleteReason }
              : {}),
            target: this.config.target,
            checks,
            summary: buildSummary(checks),
            durationMs: Date.now() - startedAt,
            categorySummary: summarizeChecks(checks),
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
   *     handed to a non-declaring client), with `-32003` being the refusal the
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
  private async pollToTerminal(
    manager: MCPClientManager,
    serverId: string,
    wire: TasksWire,
    taskId: string
  ): Promise<{ task?: Record<string, unknown>; error?: unknown }> {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    let last: Record<string, unknown> | undefined;

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
