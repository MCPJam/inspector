/**
 * MCP Tasks support (experimental feature - spec 2025-11-25)
 */

import type {
  Client,
  ServerCapabilities,
} from "@modelcontextprotocol/client";
import type {
  MCPTask,
  MCPListTasksResult,
  ClientRequestOptions,
} from "./types.js";

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
  client: Client,
  cursor?: string,
  options?: ClientRequestOptions
): Promise<MCPListTasksResult> {
  return client.request(
    {
      method: "tasks/list",
      params: cursor ? { cursor } : {},
    },
    options
  );
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
  client: Client,
  taskId: string,
  options?: ClientRequestOptions
): Promise<MCPTask> {
  return client.request(
    {
      method: "tasks/get",
      params: { taskId },
    },
    options
  );
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
  client: Client,
  taskId: string,
  options?: ClientRequestOptions
): Promise<unknown> {
  return client.request(
    {
      method: "tasks/result",
      params: { taskId },
    },
    options
  );
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
  client: Client,
  taskId: string,
  options?: ClientRequestOptions
): Promise<MCPTask> {
  return client.request(
    {
      method: "tasks/cancel",
      params: { taskId },
    },
    options
  );
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
