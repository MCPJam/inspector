import type { TaskRequestTarget } from "@/shared/hosted-tasks";
import { webPost } from "./base";
import { buildServerRequest } from "./context";

function taskRequest(request: TaskRequestTarget & { serverNameOrId: string }) {
  return {
    ...buildServerRequest(request.serverNameOrId),
    ...(request.connectionId !== undefined
      ? { connectionId: request.connectionId }
      : {}),
    ...(request.wire !== undefined ? { wire: request.wire } : {}),
  };
}

/**
 * Hosted task reads. Every call is a fresh ephemeral connection server-side
 * (authorize → connect → request → disconnect), so there is no session to
 * keep and no ordering requirement between calls; the only cost control is
 * `/get-batch`, which reads every tracked task for one server over a single
 * connection per poll tick.
 */

export async function getHostedTask(
  request: TaskRequestTarget & {
    serverNameOrId: string;
    taskId: string;
  },
): Promise<any> {
  return webPost("/api/web/tasks/get", {
    ...taskRequest(request),
    taskId: request.taskId,
  });
}

export async function getHostedTasksBatch(
  request: TaskRequestTarget & {
    serverNameOrId: string;
    taskIds: string[];
  },
): Promise<any> {
  return webPost("/api/web/tasks/get-batch", {
    ...taskRequest(request),
    taskIds: request.taskIds,
  });
}

export async function listHostedTasks(
  request: TaskRequestTarget & {
    serverNameOrId: string;
    cursor?: string;
  },
): Promise<any> {
  return webPost("/api/web/tasks/list", {
    ...taskRequest(request),
    // Presence, not truthiness: `""` is a valid continuation cursor (MCP
    // 2026-07-28 `server/utilities/pagination`), so it has to reach the route
    // verbatim rather than being dropped as if no cursor had been supplied.
    ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
  });
}

export async function getHostedTaskResult(
  request: TaskRequestTarget & {
    serverNameOrId: string;
    taskId: string;
  },
): Promise<any> {
  return webPost("/api/web/tasks/result", {
    ...taskRequest(request),
    taskId: request.taskId,
  });
}

export async function updateHostedTask(
  request: TaskRequestTarget & {
    serverNameOrId: string;
    taskId: string;
    inputResponses: Record<string, unknown>;
  },
): Promise<any> {
  return webPost("/api/web/tasks/update", {
    ...taskRequest(request),
    taskId: request.taskId,
    inputResponses: request.inputResponses,
  });
}

export async function cancelHostedTask(
  request: TaskRequestTarget & {
    serverNameOrId: string;
    taskId: string;
  },
): Promise<any> {
  return webPost("/api/web/tasks/cancel", {
    ...taskRequest(request),
    taskId: request.taskId,
  });
}

export async function getHostedTaskCapabilities(
  request: TaskRequestTarget & {
    serverNameOrId: string;
  },
): Promise<any> {
  return webPost("/api/web/tasks/capabilities", taskRequest(request));
}
