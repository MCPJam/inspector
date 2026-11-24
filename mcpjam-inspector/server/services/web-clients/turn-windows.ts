/**
 * The turn gate. The vendor's MCP client may list tools at any time, but it
 * may only call one while an MCPJam turn is running on that connector. The
 * runtime opens a window when it sends the prompt and closes it when the reply
 * has finished; the forwarding endpoint consults the window for every call and
 * asks the window's approval hook before anything reaches the upstream server.
 *
 * This store lives in one process. A hosted deployment with more than one
 * replica needs the durable store, so a call that lands on another replica
 * still finds its turn.
 */
import { randomUUID } from "node:crypto";

export type ToolCallRequest = {
  connectorId: string;
  turnId: string;
  jsonrpcId: string | number | null;
  toolName: string;
  arguments: unknown;
  /** claude.ai's `_meta["claudecode/toolUseId"]`, when the client sends one. */
  toolUseId?: string;
  /**
   * The MCPJam user (WorkOS user id) whose OAuth token made the call, who
   * need not be the user whose run opened the turn. A capability connector's
   * calls name no user.
   */
  userId?: string;
};

export type ApprovalDecision =
  { allow: true } | { allow: false; reason: string };

export type TurnWindowInit = {
  connectorId: string;
  runId: string;
  turnId?: string;
  /** MCPJam's approval gate for this turn. */
  approve: (call: ToolCallRequest) => Promise<ApprovalDecision>;
};

export type TurnWindow = Required<Omit<TurnWindowInit, "approve">> & {
  approve: TurnWindowInit["approve"];
  openedAt: string;
};

export interface TurnWindowStore {
  /** Opens the window for a connector. One turn per connector at a time. */
  open(init: TurnWindowInit): TurnWindow;
  active(connectorId: string): TurnWindow | undefined;
  /** Closing a window that is no longer the connector's current one is a no-op. */
  close(turnId: string): void;
}

export class TurnWindowConflictError extends Error {
  constructor(connectorId: string) {
    super(
      `Another turn is already running on connector ${connectorId}. Wait for it to finish, then send again.`,
    );
    this.name = "TurnWindowConflictError";
  }
}

export function createInMemoryTurnWindowStore(): TurnWindowStore {
  const byConnector = new Map<string, TurnWindow>();
  return {
    open(init) {
      const current = byConnector.get(init.connectorId);
      if (current) throw new TurnWindowConflictError(init.connectorId);
      const window: TurnWindow = {
        connectorId: init.connectorId,
        runId: init.runId,
        turnId: init.turnId ?? randomUUID(),
        approve: init.approve,
        openedAt: new Date().toISOString(),
      };
      byConnector.set(init.connectorId, window);
      return window;
    },
    active(connectorId) {
      return byConnector.get(connectorId);
    },
    close(turnId) {
      for (const [connectorId, window] of byConnector) {
        if (window.turnId === turnId) byConnector.delete(connectorId);
      }
    },
  };
}

/** The process-wide store the endpoint and the runtime share. */
export const webClientTurnWindows: TurnWindowStore =
  createInMemoryTurnWindowStore();
