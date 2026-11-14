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

export function describeListedTools(tools: MCPListedTool[]): string {
  if (tools.length === 0) return "the server lists no tools at all";
  const named = tools.slice(0, NAMED_TOOLS_LIMIT).map((tool) => tool.name);
  const rest = tools.length - named.length;
  return `listed tools: ${named.join(", ")}${
    rest > 0 ? `, +${rest} more` : ""
  }`;
}

export interface ProbeToolResolution {
  tool?: MCPListedTool;
  /** Why no tool resolved, in terms the caller can act on. */
  reason?: string;
  /** True when the missing tool leaves applicable checks unexercised. */
  blocking?: boolean;
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
