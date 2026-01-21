/**
 * Notification handler management for MCPClientManager
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
  ProgressNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ProgressHandler } from "./types.js";

// Type aliases for notification handling
type NotificationSchema = Parameters<Client["setNotificationHandler"]>[0];
type NotificationHandler = Parameters<Client["setNotificationHandler"]>[1];

// Re-export notification schemas for convenience
export {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
  ProgressNotificationSchema,
};

export type { NotificationSchema, NotificationHandler };

/**
 * Manages notification handlers for multiple MCP servers.
 * Allows registering multiple handlers per server and schema.
 */
export class NotificationManager {
  private handlers = new Map<
    string,
    Map<NotificationSchema, Set<NotificationHandler>>
  >();

  /**
   * Adds a notification handler for a specific server and schema.
   *
   * @param serverId - The server ID
   * @param schema - The notification schema to handle
   * @param handler - The handler function
   */
  addHandler(
    serverId: string,
    schema: NotificationSchema,
    handler: NotificationHandler
  ): void {
    const serverHandlers = this.handlers.get(serverId) ?? new Map();
    const handlersForSchema =
      serverHandlers.get(schema) ?? new Set<NotificationHandler>();
    handlersForSchema.add(handler);
    serverHandlers.set(schema, handlersForSchema);
    this.handlers.set(serverId, serverHandlers);
  }

  /**
   * Creates a dispatcher function that invokes all handlers for a schema.
   *
   * @param serverId - The server ID
   * @param schema - The notification schema
   * @returns A handler that dispatches to all registered handlers
   */
  createDispatcher(
    serverId: string,
    schema: NotificationSchema
  ): NotificationHandler {
    return (notification) => {
      const serverHandlers = this.handlers.get(serverId);
      const handlersForSchema = serverHandlers?.get(schema);
      if (!handlersForSchema || handlersForSchema.size === 0) {
        return;
      }

      for (const handler of handlersForSchema) {
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
  applyToClient(serverId: string, client: Client): void {
    const serverHandlers = this.handlers.get(serverId);
    if (!serverHandlers) {
      return;
    }

    for (const [schema] of serverHandlers) {
      client.setNotificationHandler(
        schema,
        this.createDispatcher(serverId, schema)
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
   * Gets handler schemas registered for a server.
   *
   * @param serverId - The server ID
   * @returns Array of registered notification schemas
   */
  getSchemas(serverId: string): NotificationSchema[] {
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
  client: Client,
  progressHandler: ProgressHandler
): void {
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    const params = notification.params;
    progressHandler({
      serverId,
      progressToken: params.progressToken,
      progress: params.progress,
      total: params.total,
      message: params.message,
    });
  });
}
