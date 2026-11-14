import type { TaskCreatedPayload } from "@/shared/hosted-task-created";
import type { TaskOwnerRequests } from "./task-owner-requests";
import { trackTask } from "./task-tracker";

/** Bound replies require both their submitted scope and the authenticated owner. */
export function trackCreatedTask(
  payload: TaskCreatedPayload,
  legacyScope: string | undefined,
  requests: TaskOwnerRequests,
): void {
  const bound =
    payload.connectionId !== undefined ||
    payload.sourceExecutionId !== undefined;
  const scope = bound ? requests.resolve(payload.ownerRequestId) : legacyScope;
  if (bound && (scope === undefined || payload.ownerScope !== scope)) return;
  trackTask({
    taskId: payload.taskId,
    serverId: bound
      ? payload.serverId
      : (payload.serverName ?? payload.serverId),
    wire: payload.wire,
    createdAt: payload.createdAt ?? new Date().toISOString(),
    ...(bound
      ? {
          connectionId: payload.connectionId,
          sourceExecutionId: payload.sourceExecutionId,
          serverName: payload.serverName,
        }
      : {}),
    ...(payload.toolName ? { toolName: payload.toolName } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.ttlMs !== undefined ? { ttlMs: payload.ttlMs } : {}),
    ...(payload.pollIntervalMs !== undefined
      ? { pollIntervalMs: payload.pollIntervalMs }
      : {}),
    ...(scope !== undefined ? { scope } : {}),
  });
}
