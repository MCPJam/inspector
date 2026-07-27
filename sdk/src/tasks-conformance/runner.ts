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

import type { MCPClientManager } from "../mcp-client-manager/MCPClientManager.js";
import type {
  ListToolsResult,
  RpcLogEvent,
} from "../mcp-client-manager/index.js";
import { MCP_TASKS_EXTENSION_ID } from "../mcp-client-manager/tasks-dispatch.js";
import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";
import { CLIENT_CAPABILITIES_META_KEY } from "../mcp-client-manager/tasks-ext.js";
import { withEphemeralClient } from "../operations.js";
import {
  MCP_TASKS_CHECK_IDS,
  MCP_TASKS_CHECK_CATEGORIES,
  type MCPTasksCheckId,
  type MCPTasksCheckResult,
  type MCPTasksConformanceConfig,
  type MCPTasksConformanceResult,
  type NormalizedMCPTasksConformanceConfig,
} from "./types.js";
import { normalizeMCPTasksConformanceConfig } from "./validation.js";

const CHECK_METADATA: Record<
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

function skipped(
  id: MCPTasksCheckId,
  message: string,
  details?: Record<string, unknown>
): MCPTasksCheckResult {
  return {
    ...CHECK_METADATA[id],
    status: "skipped",
    durationMs: 0,
    error: { message },
    ...(details ? { details } : {}),
  };
}

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
        },
      ];
    })
  ) as MCPTasksConformanceResult["categorySummary"];
}

function buildSummary(checks: MCPTasksCheckResult[]): string {
  const passedCount = checks.filter((c) => c.status === "passed").length;
  const failedCount = checks.filter((c) => c.status === "failed").length;
  const skippedCount = checks.filter((c) => c.status === "skipped").length;
  return `${passedCount}/${checks.length} checks passed, ${failedCount} failed, ${skippedCount} skipped`;
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
  /** -32601: the method does not exist here, so the rule cannot be probed. */
  | "unsupported";

export interface UndeclaredProbe {
  method: string;
  outcome: UndeclaredProbeOutcome;
  code?: number;
  message?: string;
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
    case "unsupported":
      return `${probe.method} is not implemented (-32601)`;
    case "rejected":
      return `${probe.method} was rejected with -32003`;
  }
}

/** A raw JSON-RPC request seam: the manager's public APIs always declare. */
type RawRequest = (
  payload: { method: string; params: Record<string, unknown> },
  options?: { timeout?: number }
) => Promise<unknown>;

/**
 * Sends one request WITHOUT the extension declaration and classifies what
 * came back. `listenProbe` marks the sub-probe whose absence is a skip rather
 * than a violation: `subscriptions/listen` is a core method the tasks
 * extension only borrows, so a server that lacks it cannot be judged on it.
 */
async function runUndeclaredProbe(
  request: RawRequest,
  method: string,
  params: Record<string, unknown>,
  options?: { timeout?: number; listenProbe?: boolean }
): Promise<UndeclaredProbe> {
  try {
    await request(
      { method, params },
      options?.timeout === undefined ? undefined : { timeout: options.timeout }
    );
    return { method, outcome: "answered" };
  } catch (error) {
    const code = errorCode(error);
    const message = errorMessage(error);
    if (code === MISSING_REQUIRED_CLIENT_CAPABILITY) {
      return { method, outcome: "rejected", code };
    }
    if (code === METHOD_NOT_FOUND && options?.listenProbe) {
      return { method, outcome: "unsupported", code, message };
    }
    if (code === undefined || code === REQUEST_TIMEOUT) {
      // No refusal reached us: a transport failure, or a stream the server
      // held open past the probe deadline. Either way it is not a rejection.
      return {
        method,
        outcome: "no-response",
        ...(code === undefined ? {} : { code }),
        message,
      };
    }
    return { method, outcome: "wrong-code", code, message };
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

    const captureRpc = (event: RpcLogEvent) => {
      if (event.direction === "send") sent.push(event.message);
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
          const probeTool = pickProbeTool(tools, this.config.toolName);

          let createdTaskId: string | undefined;
          let creationResult: unknown;

          if (wire !== "none" && probeTool) {
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
          }

          if (selected.has("tasks-result-type-discipline")) {
            const stepStartedAt = Date.now();
            if (wire === "none") {
              checks.push(
                skipped(
                  "tasks-result-type-discipline",
                  "connection resolves to no tasks wire"
                )
              );
            } else if (!probeTool) {
              checks.push(
                skipped(
                  "tasks-result-type-discipline",
                  "no task-capable tool to probe (pass toolName to choose one)"
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
              // KNOWN BLIND SPOT: a CreateTaskResult that omits `resultType`
              // also lands here. Task detection is keyed on
              // `resultType === "task"` at the transport seam
              // (`rewriteTaskResultMessage`), so a discriminator-less creation
              // never reaches this runner AS a task — it arrives as an
              // ordinary result (or fails result decoding upstream and lands
              // in the branch above). Catching that omission needs the RAW
              // response, which this runner does not observe; the assertion
              // lives in `validateCreateTaskShape` for the payloads that do
              // reach it and for direct callers of the exported validator.
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
            if (wire !== "extension" || !probeTool) {
              checks.push(
                skipped(
                  "tasks-undeclared-creation-refused",
                  wire === "extension"
                    ? "no task-capable tool to probe (pass toolName to choose one)"
                    : "check applies to the extension wire only"
                )
              );
            } else {
              // tasks.md:61 — a server MUST NOT return `CreateTaskResult` to a
              // client that did not include the extension capability ON THAT
              // REQUEST, regardless of prior declarations.
              const creation = await this.probeUndeclaredCreation(
                manager,
                serverId,
                probeTool.name
              );
              checks.push(
                creation.taskCreated
                  ? failed(
                      "tasks-undeclared-creation-refused",
                      Date.now() - stepStartedAt,
                      "an undeclared tools/call returned a CreateTaskResult; a server must not create a task for a client that never declared the tasks capability (it must answer normally or reject with -32003)",
                      { tool: probeTool.name, taskId: creation.taskId }
                    )
                  : passed(
                      "tasks-undeclared-creation-refused",
                      Date.now() - stepStartedAt,
                      {
                        tool: probeTool.name,
                        undeclaredCreationCode: creation.code,
                      }
                    )
              );
            }
          }

          const finalTask = createdTaskId
            ? await this.pollToTerminal(manager, serverId, wire, createdTaskId)
            : undefined;

          if (selected.has("tasks-ttl-shape")) {
            const stepStartedAt = Date.now();
            if (!finalTask) {
              checks.push(
                skipped("tasks-ttl-shape", "no task was created to inspect")
              );
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
              checks.push(
                skipped("tasks-inline-result", "no task was created to inspect")
              );
            } else if (!TERMINAL_STATUSES.has(String(finalTask.status))) {
              checks.push(
                skipped(
                  "tasks-inline-result",
                  `task did not reach a terminal status within ${
                    this.config.pollTimeoutMs
                  }ms (last status: ${String(finalTask.status)})`
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
                skipped(
                  "tasks-mcp-name-routing",
                  "Mcp-Name routing applies to HTTP transports only"
                )
              );
            } else if (!createdTaskId || wire !== "extension") {
              checks.push(
                skipped(
                  "tasks-mcp-name-routing",
                  "no extension task was created to route"
                )
              );
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
            if (wire !== "extension" || !createdTaskId) {
              checks.push(
                skipped(
                  "tasks-undeclared-capability-rejected",
                  wire === "extension"
                    ? "no task was created to probe with"
                    : "check applies to the extension wire only"
                )
              );
            } else {
              const probes = await this.probeUndeclaredTaskMethods(
                manager,
                serverId,
                createdTaskId
              );
              if (probes === undefined) {
                checks.push(
                  skipped(
                    "tasks-undeclared-capability-rejected",
                    "the connection exposes no raw request seam, so an undeclared call cannot be sent"
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

          return {
            passed: checks.every((check) => check.status !== "failed"),
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
   * omitted, so the manager sends no capability envelope) and reports whether
   * the server nonetheless created a task.
   */
  private async probeUndeclaredCreation(
    manager: MCPClientManager,
    serverId: string,
    toolName: string
  ): Promise<{ taskCreated: boolean; taskId?: string; code?: number }> {
    try {
      const result = await manager.executeTool(
        serverId,
        toolName,
        this.config.toolArguments ?? {}
      );
      const taskId = this.extractTaskId("extension", result);
      return taskId === undefined
        ? { taskCreated: false }
        : { taskCreated: true, taskId };
    } catch (error) {
      const code = errorCode(error);
      return { taskCreated: false, ...(code === undefined ? {} : { code }) };
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
   */
  private async probeUndeclaredTaskMethods(
    manager: MCPClientManager,
    serverId: string,
    taskId: string
  ): Promise<UndeclaredProbe[] | undefined> {
    const client = manager.getClient(serverId) as
      | { request?: (payload: unknown, options?: unknown) => Promise<unknown> }
      | undefined;
    const clientRequest = client?.request;
    if (!clientRequest) return undefined;

    const request: RawRequest = (payload, options) =>
      options === undefined
        ? clientRequest.call(client, payload)
        : clientRequest.call(client, payload, options);

    const probes: UndeclaredProbe[] = [];
    probes.push(await runUndeclaredProbe(request, "tasks/get", { taskId }));
    // An EMPTY `inputResponses` map submits nothing, so even a server that
    // wrongly accepts this update cannot advance the task with it.
    probes.push(
      await runUndeclaredProbe(request, "tasks/update", {
        taskId,
        inputResponses: {},
      })
    );
    probes.push(
      await runUndeclaredProbe(
        request,
        "subscriptions/listen",
        { notifications: { taskIds: [taskId] } },
        { timeout: LISTEN_PROBE_TIMEOUT_MS, listenProbe: true }
      )
    );
    probes.push(await runUndeclaredProbe(request, "tasks/cancel", { taskId }));
    return probes;
  }

  private async pollToTerminal(
    manager: MCPClientManager,
    serverId: string,
    wire: TasksWire,
    taskId: string
  ): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    let last: Record<string, unknown> | undefined;

    while (Date.now() < deadline) {
      try {
        const task =
          wire === "extension"
            ? ((await manager.getTaskExt(serverId, taskId)) as unknown)
            : ((await manager.getTask(serverId, taskId)) as unknown);
        last = isRecord(task) ? task : undefined;
      } catch {
        return last;
      }

      if (last && TERMINAL_STATUSES.has(String(last.status))) return last;

      const suggested = last
        ? Number(last.pollIntervalMs ?? last.pollInterval)
        : NaN;
      const waitMs =
        Number.isFinite(suggested) && suggested > 0 ? suggested : 250;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    return last;
  }
}
