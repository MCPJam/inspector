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
  "tasks-undeclared-capability-rejected": {
    id: "tasks-undeclared-capability-rejected",
    category: "creation",
    title: "Undeclared Capability Rejected",
    description:
      "On the extension wire, a tasks/get sent without the client capability declaration is rejected with -32003.",
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
      "Over HTTP, tasks/get is accepted when routed with the Mcp-Name task id header the extension requires.",
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

/** Validates a `CreateTaskResult`-shaped payload (flat, `resultType: "task"`). */
export function validateCreateTaskShape(result: unknown): string[] {
  const violations: string[] = [];
  if (!isRecord(result)) {
    return ["task creation result must be an object"];
  }
  if (result.resultType !== "task") {
    violations.push(
      `task creation result must carry resultType "task" (got ${JSON.stringify(
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
    violations.push(
      "extension task creation result must be FLAT: the task fields belong at the top level, not nested under `task`"
    );
  }
  return violations;
}

/** Validates the era-native TTL / poll-interval shapes on a task payload. */
export function validateTaskTtlShape(wire: TasksWire, task: unknown): string[] {
  if (!isRecord(task)) return ["task payload must be an object"];
  const violations: string[] = [];

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
      violations.push(
        "extension task must use ttlMs, not the legacy ttl field"
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
      violations.push(
        "legacy task must use ttl, not the extension ttlMs field"
      );
    }
  }

  return violations;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
]);

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
              const violations =
                wire === "extension"
                  ? validateCreateTaskShape(creationResult)
                  : [];
              checks.push(
                violations.length === 0
                  ? passed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      { tool: probeTool.name, taskId: createdTaskId }
                    )
                  : failed(
                      "tasks-result-type-discipline",
                      Date.now() - stepStartedAt,
                      `${violations.length} task creation shape violation(s)`,
                      { violations }
                    )
              );
            }
          }

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
              const outcome = await this.probeUndeclaredGet(
                manager,
                serverId,
                createdTaskId
              );
              checks.push(
                outcome.rejected
                  ? passed(
                      "tasks-undeclared-capability-rejected",
                      Date.now() - stepStartedAt,
                      { code: outcome.code }
                    )
                  : failed(
                      "tasks-undeclared-capability-rejected",
                      Date.now() - stepStartedAt,
                      outcome.code === undefined
                        ? "tasks/get without the capability declaration succeeded; the server must reject it with -32003"
                        : `tasks/get without the capability declaration failed with ${outcome.code}; expected -32003`,
                      { code: outcome.code }
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
              const violations = validateTaskTtlShape(wire, finalTask);
              checks.push(
                violations.length === 0
                  ? passed("tasks-ttl-shape", Date.now() - stepStartedAt)
                  : failed(
                      "tasks-ttl-shape",
                      Date.now() - stepStartedAt,
                      `${violations.length} TTL shape violation(s)`,
                      { violations }
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
              // The transport injects `Mcp-Name: <taskId>` for tasks/*; a
              // successful read is the observable proof the server accepted
              // the routed request.
              try {
                await manager.getTaskExt(serverId, createdTaskId);
                checks.push(
                  passed("tasks-mcp-name-routing", Date.now() - stepStartedAt, {
                    taskId: createdTaskId,
                  })
                );
              } catch (error) {
                checks.push(
                  failed(
                    "tasks-mcp-name-routing",
                    Date.now() - stepStartedAt,
                    `tasks/get routed with Mcp-Name was rejected: ${errorMessage(
                      error
                    )}`,
                    undefined,
                    error
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

  private extractTaskId(wire: TasksWire, result: unknown): string | undefined {
    if (!isRecord(result)) return undefined;
    if (wire === "extension") {
      return typeof result.taskId === "string" ? result.taskId : undefined;
    }
    const task = isRecord(result.task) ? result.task : undefined;
    return typeof task?.taskId === "string" ? task.taskId : undefined;
  }

  /**
   * Sends a raw `tasks/get` WITHOUT the extension declaration. The manager
   * always declares, so this goes through the connection's client directly.
   */
  private async probeUndeclaredGet(
    manager: MCPClientManager,
    serverId: string,
    taskId: string
  ): Promise<{ rejected: boolean; code?: number }> {
    // The public task APIs always attach the extension declaration, so the
    // undeclared probe goes through the raw client.
    const client = manager.getClient(serverId) as
      | { request?: (payload: unknown, schema?: unknown) => Promise<unknown> }
      | undefined;
    const request = client?.request;

    if (!request) return { rejected: false };

    try {
      await request.call(client, { method: "tasks/get", params: { taskId } });
      return { rejected: false };
    } catch (error) {
      const code = errorCode(error);
      return {
        rejected: code === -32003,
        ...(code === undefined ? {} : { code }),
      };
    }
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
