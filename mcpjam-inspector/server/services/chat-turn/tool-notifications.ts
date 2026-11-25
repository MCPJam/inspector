/**
 * Carries what a server sends during a tool call (progress and log records)
 * to the tool call's card. The manager delivers both to handlers that know the
 * server but not the call, so the call's own async chain says which call they
 * belong to: the connection calls back from inside the request that started it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  logDataText,
  type ToolNotification,
} from "../../../shared/tool-notification.js";

interface ToolRun {
  toolCallId: string;
  serverId?: string;
  emit: (notification: ToolNotification) => void;
}

const runScope = new AsyncLocalStorage<ToolRun>();

/** Runs one tool call so the progress and logs its server sends reach `run.emit`. */
export function withToolNotifications<T>(run: ToolRun, body: () => T): T {
  return runScope.run(run, body);
}

/**
 * The manager's progress handler. Returns whether a running call took it, so
 * a caller with a store of its own keeps what no call owns.
 */
export function reportToolProgress(event: {
  serverId: string;
  progress: number;
  total?: number;
  message?: string;
}): boolean {
  const run = runScope.getStore();
  if (!run) return false;
  run.emit({
    toolCallId: run.toolCallId,
    kind: "progress",
    progress: event.progress,
    ...(event.total !== undefined ? { total: event.total } : {}),
    ...(event.message ? { message: event.message } : {}),
  });
  return true;
}

const forwarded = new WeakMap<object, Map<string, true>>();

/**
 * Has the manager hand this server's `notifications/message` records to the
 * running call, and asks the server for them on the modern era (the legacy
 * era's level is set when it connects). Safe to call every turn: it acts once
 * per manager and server.
 */
export function forwardToolLogs(
  manager: Pick<MCPClientManager, "onLogMessage" | "setPerRequestLogLevel">,
  serverIds: readonly string[],
): void {
  const seen = forwarded.get(manager) ?? new Map<string, true>();
  forwarded.set(manager, seen);
  for (const serverId of serverIds) {
    if (seen.has(serverId)) continue;
    seen.set(serverId, true);
    manager.setPerRequestLogLevel(serverId, "debug");
    manager.onLogMessage(serverId, (notification) => {
      const run = runScope.getStore();
      if (!run) return;
      const params = (notification as { params?: unknown }).params as
        | { level?: unknown; logger?: unknown; data?: unknown }
        | undefined;
      run.emit({
        toolCallId: run.toolCallId,
        kind: "log",
        level: typeof params?.level === "string" ? params.level : "info",
        ...(typeof params?.logger === "string" ? { logger: params.logger } : {}),
        text: logDataText(params?.data),
      });
    });
  }
}
