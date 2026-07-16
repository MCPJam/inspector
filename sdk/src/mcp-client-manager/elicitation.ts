/**
 * Elicitation handler management for MCPClientManager
 */

import type { ElicitResult } from "@modelcontextprotocol/client";
import {
  getSupportedElicitationModes,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/client";
import type {
  ElicitationHandler,
  ElicitationCallback,
  ElicitationMode,
} from "./types.js";
import type { ManagedMcpClient } from "./managed-mcp-client.js";

export const ElicitRequestMethod = "elicitation/create" as const;

/**
 * The `elicitation` client capability actually advertised on the wire for a
 * server, exactly as it appeared in `initialize`. `undefined` means we have no
 * record of one (legacy call sites; capability negotiation not tracked).
 */
export type DeclaredElicitationCapability = Record<string, unknown> | undefined;

/**
 * Reads the requested mode off an inbound `elicitation/create`.
 *
 * Absent ⇒ `"form"`: `mode` is optional in the form-params schema and every
 * pre-2025-11-25 elicitation is a form. An unrecognized string is returned
 * verbatim so the caller can reject it as undeclared.
 */
function readElicitationMode(params: unknown): string {
  const mode = (params as { mode?: unknown } | undefined)?.mode;
  return typeof mode === "string" ? mode : "form";
}

/**
 * Enforces the spec MUST: a client rejects an elicitation whose mode it did
 * not declare, with JSON-RPC `-32602` (InvalidParams).
 *
 * Thrown from inside a request handler, `ProtocolError` surfaces to the server
 * as a JSON-RPC error response carrying `error.code` verbatim (upstream maps
 * `error.code` whenever it is a safe integer).
 *
 * Mode-vs-declaration semantics come from upstream's own
 * `getSupportedElicitationModes`, so this cannot drift from the shape the
 * upstream `Client` enforces: bare `{}` ≡ form-only, `{form:{}}` form-only,
 * `{form:{},url:{}}` both, `{url:{}}` url-only.
 *
 * This duplicates a check the upstream `Client` already performs for real
 * connections — deliberately. It is the ONLY enforcement on the stateless
 * preview client (which stores raw handlers), and it keeps the rejection
 * identical across both client adapters.
 */
function assertElicitationModeDeclared(
  serverId: string,
  mode: string,
  declaredCapability: DeclaredElicitationCapability
): asserts mode is ElicitationMode {
  if (declaredCapability === undefined) {
    // No declaration on record. Form is the legacy default and stays allowed
    // for back-compat; url mode requires an explicit declaration.
    if (mode === "form") return;
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Client did not declare support for "${mode}"-mode elicitation (server "${serverId}").`
    );
  }

  const { supportsFormMode, supportsUrlMode } = getSupportedElicitationModes(
    declaredCapability as Parameters<typeof getSupportedElicitationModes>[0]
  );

  if (mode === "form" && supportsFormMode) return;
  if (mode === "url" && supportsUrlMode) return;

  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Client did not declare support for "${mode}"-mode elicitation (server "${serverId}").`
  );
}

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
   * In-flight elicitation handler invocations. Drives
   * {@link hasPendingForServer}, which the elicitation-aware tool timeout uses
   * to decide whether the clock is running.
   *
   * Entries, not a bare count, for two reasons a counter cannot express:
   *
   * - **A handler that never settles must not poison the server forever.** The
   *   tool watchdog can abort a `tools/call` while its elicitation callback is
   *   still awaiting; that callback's `finally` never runs, so a count would sit
   *   at 1 permanently and every LATER call on that server would have its clock
   *   paused — silently unbounded timeouts. `startedAt` lets us ignore an entry
   *   older than the asking call's own budget.
   * - **A late completion must not decrement a NEW connection.** Reconnect
   *   reuses the serverId, and a counter is anonymous: the old handler's
   *   decrement landed on the new connection's tally and could zero out a
   *   genuinely pending elicitation. A token only ever removes its own entry.
   */
  private pendingElicitationEntries = new Map<
    symbol,
    { serverId: string; startedAt: number }
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
   * Returns whether this server will have an elicitation handler installed.
   */
  hasHandler(serverId: string): boolean {
    return this.handlers.has(serverId) || this.globalCallback !== undefined;
  }

  /**
   * Whether an elicitation handler invocation is currently in flight for a
   * server — i.e. whether we are waiting on a human rather than on the server.
   *
   * Per-server, not per-call: see the note in `elicitation-timeout.ts`.
   *
   * @param serverId - The server ID
   */
  hasPendingForServer(serverId: string, maxAgeMs?: number): boolean {
    const now = Date.now();
    for (const entry of this.pendingElicitationEntries.values()) {
      if (entry.serverId !== serverId) continue;
      // Older than the asking call's entire elicitation budget: that call would
      // have aborted on its own budget by now, so this entry cannot honestly
      // keep pausing anyone's clock. Bounds a stuck handler's blast radius to
      // one budget window instead of the process lifetime.
      if (maxAgeMs !== undefined && now - entry.startedAt > maxAgeMs) continue;
      return true;
    }
    return false;
  }

  private beginPending(serverId: string): symbol {
    const token = Symbol("elicitation-pending");
    this.pendingElicitationEntries.set(token, {
      serverId,
      startedAt: Date.now(),
    });
    return token;
  }

  private endPending(token: symbol): void {
    this.pendingElicitationEntries.delete(token);
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
   * @param declaredCapability - The `elicitation` client capability actually
   *   advertised to this server on the wire. Used to reject undeclared modes
   *   with `-32602`. Omit only when no declaration is on record — form mode is
   *   then allowed for back-compat and url mode rejected.
   */
  applyToClient(
    serverId: string,
    client: ManagedMcpClient,
    declaredCapability?: DeclaredElicitationCapability
  ): void {
    const serverSpecific = this.handlers.get(serverId);

    if (serverSpecific) {
      client.setRequestHandler(ElicitRequestMethod, async (request) => {
        // The widened `ManagedMcpClient.setRequestHandler` signature
        // collapses RequestTypeMap to a union, so `request.params` here
        // is the wide `params?: ... | undefined`. The runtime payload
        // is always elicit-shaped because we register only for
        // `elicitation/create`; cast to the narrowed shape.
        const params = (request as { params?: unknown }).params as
          | Parameters<ElicitationHandler>[0]
          | undefined;

        assertElicitationModeDeclared(
          serverId,
          readElicitationMode(params),
          declaredCapability
        );

        const pendingToken = this.beginPending(serverId);
        try {
          return await serverSpecific(
            params ?? ({} as Parameters<ElicitationHandler>[0])
          );
        } finally {
          this.endPending(pendingToken);
        }
      });
      return;
    }

    if (this.globalCallback) {
      client.setRequestHandler(ElicitRequestMethod, async (request) => {
        const params = (request as { params?: unknown }).params as
          | Record<string, any>
          | undefined;

        const mode = readElicitationMode(params);
        assertElicitationModeDeclared(serverId, mode, declaredCapability);

        const reqId = `elicit_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 9)}`;

        // Extract related task ID from _meta per MCP Tasks spec (2025-11-25)
        const meta = params?._meta;
        const relatedTask = meta?.["io.modelcontextprotocol/related-task"];
        const relatedTaskId = relatedTask?.taskId as string | undefined;

        const pendingToken = this.beginPending(serverId);
        try {
          return await this.globalCallback!({
            requestId: reqId,
            serverId,
            mode,
            message: params?.message,
            // Form mode only. `schema` is the legacy alias some servers
            // still send; url-mode params carry neither.
            schema: params?.requestedSchema ?? params?.schema,
            // URL mode only — absent for form requests.
            url: typeof params?.url === "string" ? params.url : undefined,
            elicitationId:
              typeof params?.elicitationId === "string"
                ? params.elicitationId
                : undefined,
            relatedTaskId,
          });
        } finally {
          this.endPending(pendingToken);
        }
      });
    }
  }

  /**
   * Removes elicitation handler from a client.
   *
   * @param client - The MCP client
   */
  removeFromClient(client: ManagedMcpClient): void {
    client.removeRequestHandler(ElicitRequestMethod);
  }

  /**
   * Clears all data for a server.
   *
   * @param serverId - The server ID
   */
  clearServer(serverId: string): void {
    this.handlers.delete(serverId);
    // Drop this server's in-flight entries: it's gone, so a handler that never
    // settles must not pin `hasPendingForServer` true forever.
    for (const [token, entry] of this.pendingElicitationEntries) {
      if (entry.serverId === serverId) this.pendingElicitationEntries.delete(token);
    }
    // A handler still in flight from the OLD connection can't corrupt a
    // reconnected one carrying the same id: its `endPending` removes only its
    // own token, which this purge already dropped.
  }
}
