/**
 * Elicitation handler management for MCPClientManager
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitationHandler, ElicitationCallback } from "./types.js";

// Re-export the schema for convenience
export { ElicitRequestSchema };

/**
 * Manages elicitation handlers and callbacks for MCP servers.
 * Supports both server-specific handlers and a global callback.
 */
export class ElicitationManager {
  private handlers = new Map<string, ElicitationHandler>();
  private globalCallback?: ElicitationCallback;
  private pendingElicitations = new Map<
    string,
    {
      resolve: (value: ElicitResult) => void;
      reject: (error: unknown) => void;
    }
  >();

  /**
   * Sets a server-specific elicitation handler.
   *
   * @param serverId - The server ID
   * @param handler - The elicitation handler
   */
  setHandler(serverId: string, handler: ElicitationHandler): void {
    this.handlers.set(serverId, handler);
  }

  /**
   * Clears a server-specific handler.
   *
   * @param serverId - The server ID
   */
  clearHandler(serverId: string): void {
    this.handlers.delete(serverId);
  }

  /**
   * Gets a server-specific handler.
   *
   * @param serverId - The server ID
   * @returns The handler if set, undefined otherwise
   */
  getHandler(serverId: string): ElicitationHandler | undefined {
    return this.handlers.get(serverId);
  }

  /**
   * Sets the global elicitation callback.
   *
   * @param callback - The callback function
   */
  setGlobalCallback(callback: ElicitationCallback): void {
    this.globalCallback = callback;
  }

  /**
   * Clears the global callback.
   */
  clearGlobalCallback(): void {
    this.globalCallback = undefined;
  }

  /**
   * Gets the global callback.
   *
   * @returns The callback if set, undefined otherwise
   */
  getGlobalCallback(): ElicitationCallback | undefined {
    return this.globalCallback;
  }

  /**
   * Gets the pending elicitations map.
   * Useful for external code that needs to add resolvers.
   *
   * @returns The pending elicitations map
   */
  getPendingElicitations(): Map<
    string,
    {
      resolve: (value: ElicitResult) => void;
      reject: (error: unknown) => void;
    }
  > {
    return this.pendingElicitations;
  }

  /**
   * Resolves a pending elicitation by requestId.
   *
   * @param requestId - The request ID to resolve
   * @param response - The elicitation response
   * @returns True if the elicitation was found and resolved
   */
  respond(requestId: string, response: ElicitResult): boolean {
    const pending = this.pendingElicitations.get(requestId);
    if (!pending) {
      return false;
    }
    try {
      pending.resolve(response);
      return true;
    } finally {
      this.pendingElicitations.delete(requestId);
    }
  }

  /**
   * Applies the appropriate elicitation handler to a client.
   * Server-specific handlers take precedence over the global callback.
   *
   * @param serverId - The server ID
   * @param client - The MCP client
   */
  applyToClient(serverId: string, client: Client): void {
    const serverSpecific = this.handlers.get(serverId);

    if (serverSpecific) {
      client.setRequestHandler(ElicitRequestSchema, async (request) =>
        serverSpecific(request.params)
      );
      return;
    }

    if (this.globalCallback) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        const reqId = `elicit_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 9)}`;

        // Extract related task ID from _meta per MCP Tasks spec (2025-11-25)
        const meta = (request.params as any)?._meta;
        const relatedTask = meta?.["io.modelcontextprotocol/related-task"];
        const relatedTaskId = relatedTask?.taskId as string | undefined;

        return await this.globalCallback!({
          requestId: reqId,
          message: (request.params as any)?.message,
          schema:
            (request.params as any)?.requestedSchema ??
            (request.params as any)?.schema,
          relatedTaskId,
        });
      });
    }
  }

  /**
   * Removes elicitation handler from a client.
   *
   * @param client - The MCP client
   */
  removeFromClient(client: Client): void {
    client.removeRequestHandler("elicitation/create");
  }

  /**
   * Clears all data for a server.
   *
   * @param serverId - The server ID
   */
  clearServer(serverId: string): void {
    this.handlers.delete(serverId);
  }
}
