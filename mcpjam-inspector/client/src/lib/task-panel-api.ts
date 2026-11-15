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
  const recoveredSources = new Map<string, string>();
  const requestFor = (ids: string[]) => {
    const sources = ids.flatMap((id) => {
      const source =
        tracker.getTrackedTaskById(id, serverId, selection)
          ?.sourceExecutionId ?? recoveredSources.get(id);
      return source ? [[id, source]] : [];
    });
    return {
      ...request,
      ...(sources.length
        ? { sourceExecutions: Object.fromEntries(sources) }
        : {}),
    };
  };
  return {
    listTasks: (_server: string, cursor?: string) =>
      api.listTasks(serverId, cursor, request).then((result) => {
        for (const row of result.registryTasks ?? [])
          if (row.sourceExecutionId)
            recoveredSources.set(row.taskId, row.sourceExecutionId);
        return result;
      }),
    getTask: (_server: string, id: string) =>
      api.getTask(serverId, id, requestFor([id])),
    getTaskResult: (_server: string, id: string) =>
      api.getTaskResult(serverId, id, requestFor([id])),
    getTasksBatch: async (_server: string, ids: string[]) => {
      // Different creating calls may have different host policies on the same account.
      const groups = new Map<string, string[]>();
      for (const id of ids) {
        const source = requestFor([id]).sourceExecutions?.[id] ?? "";
        groups.set(source, [...(groups.get(source) ?? []), id]);
      }
      const entries = [...groups.values()];
      const batches = await Promise.allSettled(
        entries.map((group) =>
          api.getTasksBatch(serverId, group, requestFor(group)),
        ),
      );
      const first = batches.find((batch) => batch.status === "fulfilled");
      return {
        wire:
          first?.status === "fulfilled"
            ? first.value.wire
            : (expectedWire ?? "none"),
        tasks: batches.flatMap((batch, index) =>
          batch.status === "fulfilled"
            ? batch.value.tasks
            : entries[index].map((taskId) => ({
                taskId,
                error: batch.reason instanceof Error ? batch.reason.message : "This Task could not be read. Try again.",
              })),
        ),
      };
    },
    updateTask: (
      _server: string,
      id: string,
      responses: Record<string, unknown>,
    ) => api.updateTask(serverId, id, responses, requestFor([id])),
    cancelTask: (_server: string, id: string) =>
      api.cancelTask(serverId, id, requestFor([id])),
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
