import { z } from "zod";

import type { ListToolsResult } from "../mcp-client-manager/index.js";
import { isInvalidTaskExtPayloadError } from "../mcp-client-manager/tasks-ext-guards.js";

import { MCP_TASKS_EXTENSION_ID } from "../mcp-client-manager/tasks-dispatch.js";
import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";
import { CLIENT_CAPABILITIES_META_KEY } from "../mcp-client-manager/tasks-ext.js";

import { deepJsonSafe } from "../json-safe.js";

import {
  buildOutcomeSummary,
  decideConformanceOutcome,
  isUnrunCheck,
} from "../conformance-outcome.js";

import {
  type MCPTasksCheckId,
  type MCPTasksCheckResult,
  type MCPTasksRunOutcome,
} from "./types.js";

export { CHECK_METADATA } from "./check-metadata.js";
import { CHECK_METADATA } from "./check-metadata.js";
export type MCPListedTool = NonNullable<ListToolsResult["tools"]>[number];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readRequiredCapabilities(error: unknown): unknown {
  const data = (error as { data?: unknown } | null)?.data;
  return isRecord(data) ? data.requiredCapabilities : undefined;
}

export function isMalformedResponseError(error: unknown): boolean {
  return (
    isInvalidTaskExtPayloadError(error) ||
    error instanceof z.ZodError ||
    (error instanceof Error && error.name === "ZodError")
  );
}

export function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

export function passed(
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

export function failed(
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

export function notApplicable(
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

export function couldNotRun(
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

export const isUnrun = isUnrunCheck;

export { summarizeChecks } from "./check-summary.js";

export const buildSummary = buildOutcomeSummary;

export function decideOutcome(checks: MCPTasksCheckResult[]): {
  outcome: MCPTasksRunOutcome;
  incompleteReason?: string;
} {
  return decideConformanceOutcome(checks);
}

export function toolTaskSupport(tool: MCPListedTool): string | undefined {
  const execution = (tool as { execution?: unknown }).execution;
  if (!isRecord(execution)) return undefined;
  return typeof execution.taskSupport === "string"
    ? execution.taskSupport
    : undefined;
}

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

export const NAMED_TOOLS_LIMIT = 10;

function toolNames(tools: MCPListedTool[]): string {
  const named = tools.slice(0, NAMED_TOOLS_LIMIT).map((tool) => tool.name);
  const rest = tools.length - named.length;
  return `${named.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

export function describeListedTools(tools: MCPListedTool[]): string {
  if (tools.length === 0) return "the server lists no tools at all";
  return `listed tools: ${toolNames(tools)}`;
}

/** 2025-11-25: only `required` and `optional` let a client call a tool as a task. */
function acceptsTaskCalls(tool: MCPListedTool): boolean {
  const support = toolTaskSupport(tool);
  return support === "required" || support === "optional";
}

export interface ProbeToolResolution {
  tool?: MCPListedTool;
  /** Why no tool resolved, in terms the caller can act on. */
  reason?: string;
  /** True when the missing tool leaves applicable checks unexercised. */
  blocking?: boolean;
  /**
   * The setup line the app shows in place of the runner's default ("this
   * server doesn't list the tool"), for a case where that default is wrong.
   */
  setupMessage?: string;
}

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
  // A tool whose `taskSupport` is missing or "forbidden" MUST NOT be called as
  // a task (2025-11-25 tasks.mdx:115). Auto-selection already skips such
  // tools, so only a NAMED one gets here, and picking another is the caller's
  // setup to fix. Legacy only: the 2026-07-28 ToolSchema strips
  // `taskSupport`, and on the extension wire the server decides.
  if (tool && requestedName && wire === "legacy" && !acceptsTaskCalls(tool)) {
    const able = tools.filter(acceptsTaskCalls);
    const support = toolTaskSupport(tool);
    const name = JSON.stringify(tool.name);
    const has =
      support === undefined
        ? "has no taskSupport"
        : `has taskSupport ${JSON.stringify(support)}`;
    return {
      reason: `the requested probe tool ${name} ${
        support === undefined
          ? "has no `execution.taskSupport`"
          : `has \`execution.taskSupport\` ${JSON.stringify(support)}`
      }, so it must not be called as a task (2025-11-25 tasks.mdx:115); ${
        able.length > 0
          ? `tools that can: ${toolNames(able)}; pass --tool-name (SDK: toolName) with one of them`
          : "no listed tool has `execution.taskSupport` required or optional"
      }`,
      blocking: true,
      setupMessage:
        able.length > 0
          ? `${name} ${has}, so it can't run as a task. Select a tool that can in setup (${toolNames(able)}), then run again.`
          : `${name} ${has}, so it can't run as a task, and no tool on this server can. Add taskSupport to a tool, then run again.`,
    };
  }
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

export function namesTasksExtension(requiredCapabilities: unknown): boolean {
  return (
    isRecord(requiredCapabilities) &&
    isRecord(requiredCapabilities.extensions) &&
    MCP_TASKS_EXTENSION_ID in requiredCapabilities.extensions
  );
}
