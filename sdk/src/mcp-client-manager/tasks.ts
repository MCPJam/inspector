/**
 * MCP Tasks support (experimental feature - spec 2025-11-25)
 */

import type { ServerCapabilities } from "@modelcontextprotocol/client";
import type {
  MCPTask,
  MCPListTasksResult,
  ClientRequestOptions,
} from "./types.js";
import type { ManagedMcpClient } from "./managed-mcp-client.js";
import { z } from "zod";

/**
 * The 2025-11-25 in-core `tasks/*` methods are not spec methods in beta.4's
 * method-dispatch map, so the generic `request()` refuses them ("not a spec
 * method"). They must ride the explicit-schema seam; the payloads are then
 * shape-checked by the callers/routes.
 */
const LEGACY_TASKS_RESULT_SCHEMA = z.looseObject({});

export const TaskStatusNotificationMethod =
  "notifications/tasks/status" as const;

// ============================================================================
// Task Operations
// ============================================================================

/**
 * Lists tasks from an MCP server.
 *
 * @param client - The MCP client
 * @param cursor - Optional pagination cursor
 * @param options - Request options
 * @returns List of tasks
 */
export async function listTasks(
  client: ManagedMcpClient,
  cursor?: string,
  options?: ClientRequestOptions
): Promise<MCPListTasksResult> {
  return client.requestWithSchema(
    {
      method: "tasks/list",
      // Presence, not truthiness: `""` is a valid continuation cursor. MCP
      // 2026-07-28 `server/utilities/pagination` states that a client "MUST
      // NOT" decide anything from a cursor's value beyond whether a non-null
      // one was provided, and that "an empty string is a valid cursor and thus
      // MUST NOT be treated as the end of results". A truthiness test here
      // dropped a `""` handed back by the previous page, which does not end a
      // caller's walk so much as silently restart it at page one.
      params: cursor !== undefined ? { cursor } : {},
    },
    LEGACY_TASKS_RESULT_SCHEMA,
    options
  ) as Promise<MCPListTasksResult>;
}

/**
 * Gets a specific task by ID.
 *
 * @param client - The MCP client
 * @param taskId - The task ID
 * @param options - Request options
 * @returns The task object
 */
export async function getTask(
  client: ManagedMcpClient,
  taskId: string,
  options?: ClientRequestOptions
): Promise<MCPTask> {
  return client.requestWithSchema(
    {
      method: "tasks/get",
      params: { taskId },
    },
    LEGACY_TASKS_RESULT_SCHEMA,
    options
  ) as Promise<MCPTask>;
}

/**
 * Gets the result of a completed task.
 * Per MCP Tasks spec, returns exactly what the underlying request would have returned.
 *
 * @param client - The MCP client
 * @param taskId - The task ID
 * @param options - Request options
 * @returns The task result (type depends on original request)
 */
export async function getTaskResult(
  client: ManagedMcpClient,
  taskId: string,
  options?: ClientRequestOptions
): Promise<unknown> {
  return client.requestWithSchema(
    {
      method: "tasks/result",
      params: { taskId },
    },
    LEGACY_TASKS_RESULT_SCHEMA,
    options
  ) as Promise<unknown>;
}

/**
 * Cancels a task.
 *
 * @param client - The MCP client
 * @param taskId - The task ID to cancel
 * @param options - Request options
 * @returns The updated task object
 */
export async function cancelTask(
  client: ManagedMcpClient,
  taskId: string,
  options?: ClientRequestOptions
): Promise<MCPTask> {
  return client.requestWithSchema(
    {
      method: "tasks/cancel",
      params: { taskId },
    },
    LEGACY_TASKS_RESULT_SCHEMA,
    options
  ) as Promise<MCPTask>;
}

// ============================================================================
// Capability Checks
// ============================================================================

/**
 * Checks if server supports task-augmented tool calls.
 * Checks both top-level tasks and experimental.tasks namespaces.
 *
 * @param capabilities - The server capabilities
 * @returns True if server supports task-augmented tool calls
 */
export function supportsTasksForToolCalls(
  capabilities: ServerCapabilities | undefined
): boolean {
  const caps = capabilities as any;
  return Boolean(
    caps?.tasks?.requests?.tools?.call ||
    caps?.experimental?.tasks?.requests?.tools?.call
  );
}

/**
 * Checks if server supports tasks/list operation.
 *
 * @param capabilities - The server capabilities
 * @returns True if server supports listing tasks
 */
export function supportsTasksList(
  capabilities: ServerCapabilities | undefined
): boolean {
  const caps = capabilities as any;
  return Boolean(caps?.tasks?.list || caps?.experimental?.tasks?.list);
}

/**
 * Checks if server supports tasks/cancel operation.
 *
 * @param capabilities - The server capabilities
 * @returns True if server supports canceling tasks
 */
export function supportsTasksCancel(
  capabilities: ServerCapabilities | undefined
): boolean {
  const caps = capabilities as any;
  return Boolean(caps?.tasks?.cancel || caps?.experimental?.tasks?.cancel);
}
