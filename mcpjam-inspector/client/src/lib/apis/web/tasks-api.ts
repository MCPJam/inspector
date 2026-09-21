import { webPost } from "./base";
import { buildServerRequest } from "./context";

/**
 * Hosted task reads. Every call is a fresh ephemeral connection server-side
 * (authorize → connect → request → disconnect), so there is no session to
 * keep and no ordering requirement between calls; the only cost control is
 * `/get-batch`, which reads every tracked task for one server over a single
 * connection per poll tick.
 */

export async function getHostedTask(request: {
  serverNameOrId: string;
  taskId: string;
}): Promise<any> {
  return webPost("/api/web/tasks/get", {
    ...buildServerRequest(request.serverNameOrId),
    taskId: request.taskId,
  });
}

export async function getHostedTasksBatch(request: {
  serverNameOrId: string;
  taskIds: string[];
}): Promise<any> {
  return webPost("/api/web/tasks/get-batch", {
    ...buildServerRequest(request.serverNameOrId),
    taskIds: request.taskIds,
  });
}

export async function listHostedTasks(request: {
  serverNameOrId: string;
  cursor?: string;
}): Promise<any> {
  return webPost("/api/web/tasks/list", {
    ...buildServerRequest(request.serverNameOrId),
    // Presence, not truthiness: `""` is a valid continuation cursor (MCP
    // 2026-07-28 `server/utilities/pagination`), so it has to reach the route
    // verbatim rather than being dropped as if no cursor had been supplied.
    ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
  });
}

export async function getHostedTaskResult(request: {
  serverNameOrId: string;
  taskId: string;
}): Promise<any> {
  return webPost("/api/web/tasks/result", {
    ...buildServerRequest(request.serverNameOrId),
    taskId: request.taskId,
  });
}

export async function updateHostedTask(request: {
  serverNameOrId: string;
  taskId: string;
  inputResponses: Record<string, unknown>;
}): Promise<any> {
  return webPost("/api/web/tasks/update", {
    ...buildServerRequest(request.serverNameOrId),
    taskId: request.taskId,
    inputResponses: request.inputResponses,
  });
}

export async function cancelHostedTask(request: {
  serverNameOrId: string;
  taskId: string;
}): Promise<any> {
  return webPost("/api/web/tasks/cancel", {
    ...buildServerRequest(request.serverNameOrId),
    taskId: request.taskId,
  });
}

export async function getHostedTaskCapabilities(request: {
  serverNameOrId: string;
}): Promise<any> {
  return webPost(
    "/api/web/tasks/capabilities",
    buildServerRequest(request.serverNameOrId),
  );
}
