/**
 * Notification handler management for MCPClientManager
 */

import {
  type Client,
  type NotificationMethod,
} from "@modelcontextprotocol/client";
import type { ProgressHandler } from "./types.js";
import type { ManagedMcpClient } from "./managed-mcp-client.js";

export const ResourceListChangedNotificationMethod =
  "notifications/resources/list_changed" as const;
export const ResourceUpdatedNotificationMethod =
  "notifications/resources/updated" as const;
export const PromptListChangedNotificationMethod =
  "notifications/prompts/list_changed" as const;
export const ProgressNotificationMethod = "notifications/progress" as const;

// Type aliases for notification handling
type NotificationMethodName = Parameters<Client["setNotificationHandler"]>[0];
type NotificationHandler = Parameters<Client["setNotificationHandler"]>[1];

export type { NotificationMethodName, NotificationHandler };

/**
 * Manages notification handlers for multiple MCP servers.
 * Allows registering multiple handlers per server and schema.
 */
export class NotificationManager {
  private handlers = new Map<
    string,
    Map<NotificationMethodName, Set<NotificationHandler>>
  >();

  /**
   * Adds a notification handler for a specific server and method.
   *
   * @param serverId - The server ID
   * @param method - The notification method to handle
   * @param handler - The handler function
   */
  addHandler(
    serverId: string,
    method: NotificationMethodName,
    handler: NotificationHandler
  ): void {
    const serverHandlers = this.handlers.get(serverId) ?? new Map();
    const handlersForMethod =
      serverHandlers.get(method) ?? new Set<NotificationHandler>();
    handlersForMethod.add(handler);
    serverHandlers.set(method, handlersForMethod);
    this.handlers.set(serverId, serverHandlers);
  }

  /**
   * Creates a dispatcher function that invokes all handlers for a method.
   *
   * @param serverId - The server ID
   * @param method - The notification method
   * @returns A handler that dispatches to all registered handlers
   */
  createDispatcher(
    serverId: string,
    method: NotificationMethodName
  ): NotificationHandler {
    return (notification) => {
      const serverHandlers = this.handlers.get(serverId);
      const handlersForMethod = serverHandlers?.get(method);
      if (!handlersForMethod || handlersForMethod.size === 0) {
        return;
      }

      for (const handler of handlersForMethod) {
        try {
          handler(notification);
        } catch {
          // Swallow individual handler errors to avoid breaking other listeners
        }
      }
    };
  }

  /**
   * Applies all registered handlers to a client.
   *
   * @param serverId - The server ID
   * @param client - The MCP client to configure
   */
  applyToClient(serverId: string, client: ManagedMcpClient): void {
    const serverHandlers = this.handlers.get(serverId);
    if (!serverHandlers) {
      return;
    }

    for (const [method] of serverHandlers) {
      client.setNotificationHandler(
        method,
        this.createDispatcher(serverId, method)
      );
    }
  }

  /**
   * Clears all handlers for a server.
   *
   * @param serverId - The server ID to clear
   */
  clearServer(serverId: string): void {
    this.handlers.delete(serverId);
  }

  /**
   * Gets handler methods registered for a server.
   *
   * @param serverId - The server ID
   * @returns Array of registered notification methods
   */
  getMethods(serverId: string): NotificationMethod[] {
    const serverHandlers = this.handlers.get(serverId);
    return serverHandlers ? Array.from(serverHandlers.keys()) : [];
  }
}

/**
 * Sets up progress notification handler on a client.
 *
 * @param serverId - The server ID for context
 * @param client - The MCP client
 * @param progressHandler - The progress handler function
 */
export function applyProgressHandler(
  serverId: string,
  client: ManagedMcpClient,
  progressHandler: ProgressHandler
): void {
  client.setNotificationHandler(ProgressNotificationMethod, (notification) => {
    // The `ManagedMcpClient` interface widens setNotificationHandler to
    // accept any NotificationMethod, so the per-method param narrowing
    // is lost at this call site. The runtime payload is always a
    // ProgressNotificationParams here because the method literal is
    // pinned at registration; cast to recover the shape rather than
    // ramify the interface with generic narrowing.
    const params =
      ((notification as { params?: unknown }).params as
        | {
            progressToken: string | number;
            progress: number;
            total?: number;
            message?: string;
          }
        | undefined) ?? { progressToken: 0, progress: 0 };
    progressHandler({
      serverId,
      progressToken: params.progressToken,
      progress: params.progress,
      total: params.total,
      message: params.message,
    });
  });
}
