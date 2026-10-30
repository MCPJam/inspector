import * as api from "./apis/mcp-tasks-api";
import * as tracker from "./task-tracker";

export interface TaskPanelTarget {
  serverId: string;
  scope: string;
  connectionId?: string;
  wire?: "legacy" | "extension";
}

const legacy = {
  listTasks: api.listTasks,
  getTask: api.getTask,
  getTaskResult: api.getTaskResult,
  getTasksBatch: api.getTasksBatch,
  updateTask: api.updateTask,
  cancelTask: api.cancelTask,
  getTaskCapabilities: api.getTaskCapabilities,
  getLatestProgress: api.getLatestProgress,
  getTrackedTasksForServer: tracker.getTrackedTasksForServer,
  getTrackedTaskById: tracker.getTrackedTaskById,
  markTaskExpired: tracker.markTaskExpired,
  clearTrackedTasksForServer: tracker.clearTrackedTasksForServer,
  getDismissedTaskIds: tracker.getDismissedTaskIds,
  dismissTasksForServer: tracker.dismissTasksForServer,
  dismissRegistryTasks: tracker.dismissRegistryTasks,
};

/** Bind one existing panel to a captured owner/account; legacy calls stay intact. */
export function taskPanelApi(
  target: TaskPanelTarget | undefined,
  wire: api.TasksWire,
) {
  if (!target) return legacy;
  const { serverId, scope, connectionId, wire: targetWire } = target;
  const expectedWire = targetWire ?? (wire === "none" ? undefined : wire);
  const selection = {
    scope,
    connectionId,
    wire: expectedWire,
  };
  const request = {
    ownerScope: scope,
    connectionId,
    wire: expectedWire,
  };
  return {
    listTasks: (_server: string, cursor?: string) =>
      api.listTasks(serverId, cursor, request),
    getTask: (_server: string, id: string) =>
      api.getTask(serverId, id, request),
    getTaskResult: (_server: string, id: string) =>
      api.getTaskResult(serverId, id, request),
    getTasksBatch: (_server: string, ids: string[]) =>
      api.getTasksBatch(serverId, ids, request),
    updateTask: (
      _server: string,
      id: string,
      responses: Record<string, unknown>,
    ) => api.updateTask(serverId, id, responses, request),
    cancelTask: (_server: string, id: string) =>
      api.cancelTask(serverId, id, request),
    getTaskCapabilities: (_server: string) =>
      api.getTaskCapabilities(serverId, { ...request, wire: undefined }),
    getLatestProgress: (_server: string) =>
      api.getLatestProgress(serverId, request),
    getTrackedTasksForServer: (_server: string) =>
      tracker.getTrackedTasksForServer(
        serverId,
        expectedWire,
        connectionId,
        scope,
      ),
    getTrackedTaskById: (id: string, _server?: string) =>
      tracker.getTrackedTaskById(id, serverId, selection),
    markTaskExpired: (id: string, _server: string) =>
      tracker.markTaskExpired(id, serverId, selection),
    clearTrackedTasksForServer: (_server: string) =>
      tracker.clearTrackedTasksForServer(serverId, selection),
    getDismissedTaskIds: (_server: string) =>
      tracker.getDismissedTaskIds(serverId, selection),
    dismissTasksForServer: (_server: string, ids: string[]) =>
      tracker.dismissTasksForServer(serverId, ids, selection),
    dismissRegistryTasks: (_server: string, ids: string[]) =>
      tracker.dismissRegistryTasks(serverId, ids, selection),
  };
}
