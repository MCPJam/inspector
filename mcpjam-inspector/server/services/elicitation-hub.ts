import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { MCPClientManager } from "@mcpjam/sdk";
import { logger } from "../utils/logger";

type ElicitationEvent =
  | {
      type: "elicitation_request";
      requestId: string;
      message: unknown;
      schema: unknown;
      timestamp: string;
      relatedTaskId?: string;
    }
  | {
      type: "elicitation_complete";
      requestId: string;
    };

type ElicitationSubscriber = {
  send: (event: ElicitationEvent) => void;
  close: () => void;
};

class ElicitationHub {
  private readonly subscribers = new Set<ElicitationSubscriber>();

  subscribe(subscriber: ElicitationSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  broadcast(event: ElicitationEvent): void {
    for (const subscriber of Array.from(this.subscribers)) {
      try {
        subscriber.send(event);
      } catch (error) {
        logger.warn("Failed to send elicitation event", {
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          subscriber.close();
        } catch {}
        this.subscribers.delete(subscriber);
      }
    }
  }
}

const hubByManager = new WeakMap<MCPClientManager, ElicitationHub>();
const registeredManagers = new WeakSet<MCPClientManager>();

export function getElicitationHub(manager: MCPClientManager): ElicitationHub {
  const existing = hubByManager.get(manager);
  if (existing) return existing;
  const hub = new ElicitationHub();
  hubByManager.set(manager, hub);
  return hub;
}

export function ensureElicitationCallback(manager: MCPClientManager): void {
  if (registeredManagers.has(manager)) return;

  manager.setElicitationCallback(
    ({ requestId, message, schema, relatedTaskId }) => {
      const hub = getElicitationHub(manager);

      return new Promise<ElicitResult>((resolve, reject) => {
        try {
          manager.getPendingElicitations().set(requestId, { resolve, reject });
        } catch (error) {
          logger.error("Failed to store pending elicitation", error);
        }

        hub.broadcast({
          type: "elicitation_request",
          requestId,
          message,
          schema,
          timestamp: new Date().toISOString(),
          relatedTaskId,
        });
      });
    },
  );

  registeredManagers.add(manager);
}

export function broadcastElicitationComplete(
  manager: MCPClientManager,
  requestId: string,
): void {
  const hub = getElicitationHub(manager);
  hub.broadcast({
    type: "elicitation_complete",
    requestId,
  });
}
