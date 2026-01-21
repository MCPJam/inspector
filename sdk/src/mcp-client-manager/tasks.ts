/**
 * MCP Tasks support (experimental feature - spec 2025-11-25)
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  MCPTask,
  MCPListTasksResult,
  ClientRequestOptions,
} from "./types.js";

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Task object schema
 */
export const TaskSchema = z.object({
  taskId: z.string(),
  status: z.enum([
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled",
  ]),
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttl: z.number().nullable(),
  pollInterval: z.number().optional(),
});

/**
 * List tasks result schema
 */
export const ListTasksResultSchema = z.object({
  tasks: z.array(TaskSchema),
  nextCursor: z.string().optional(),
});

/**
 * Task status notification schema
 * Per spec, notification includes the full Task object
 */
export const TaskStatusNotificationSchema = z.object({
  method: z.literal("notifications/tasks/status"),
  params: z
    .object({
      taskId: z.string(),
      status: z.enum([
        "working",
        "input_required",
        "completed",
        "failed",
        "cancelled",
      ]),
      statusMessage: z.string().optional(),
      createdAt: z.string(),
      lastUpdatedAt: z.string(),
      ttl: z.number().nullable(),
      pollInterval: z.number().optional(),
    })
    .optional(),
});

/**
 * Generic result schema for tasks/result
 * Per MCP spec: "tasks/result returns exactly what the underlying request would have returned"
 */
export const TaskResultSchema = z.unknown();

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
    ListTasksResultSchema,
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
    TaskSchema,
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
    TaskResultSchema,
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
    TaskSchema,
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
