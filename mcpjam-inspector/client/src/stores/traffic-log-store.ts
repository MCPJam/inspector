/**
 * Traffic Log Store - Captures all MCP traffic for debugging
 *
 * Includes:
 * - MCP Apps / OpenAI Apps SDK traffic (iframe ↔ host messages)
 * - MCP Server RPC traffic (client ↔ server messages)
 *
 * This is a singleton store - no provider required.
 * The SSE subscription is also a singleton to prevent duplicate connections.
 */

import { create } from "zustand";

export type UiProtocol = "mcp-apps" | "openai-apps";

export interface UiLogEvent {
  id: string;
  widgetId: string; // toolCallId
  serverId: string;
  direction: "host-to-ui" | "ui-to-host";
  protocol: UiProtocol;
  method: string;
  timestamp: string;
  message: unknown;
}

export interface McpServerRpcItem {
  id: string;
  serverId: string;
  direction: string;
  method: string;
  timestamp: string;
  payload: unknown;
}

interface TrafficLogState {
  items: UiLogEvent[];
  mcpServerItems: McpServerRpcItem[];
  addLog: (event: Omit<UiLogEvent, "id" | "timestamp">) => void;
  addMcpServerLog: (item: Omit<McpServerRpcItem, "id">) => void;
  clear: () => void;
}

const MAX_ITEMS = 1000;

export const useTrafficLogStore = create<TrafficLogState>((set) => ({
  items: [],
  mcpServerItems: [],
  addLog: (event) => {
    const newItem: UiLogEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
    };
    set((state) => ({
      items: [newItem, ...state.items].slice(0, MAX_ITEMS),
    }));
  },
  addMcpServerLog: (item) => {
    const newItem: McpServerRpcItem = {
      ...item,
      id: `${item.timestamp}-${Math.random().toString(36).slice(2)}`,
    };
    set((state) => ({
      mcpServerItems: [newItem, ...state.mcpServerItems].slice(0, MAX_ITEMS),
    }));
  },
  clear: () => set({ items: [], mcpServerItems: [] }),
}));

/**
 * Singleton SSE subscription for MCP server RPC traffic.
 * This ensures only one EventSource connection exists regardless of
 * how many LoggerView components are mounted.
 */
let sseConnection: EventSource | null = null;
let sseSubscriberCount = 0;

export function subscribeToRpcStream(): () => void {
  sseSubscriberCount++;

  if (!sseConnection) {
    const params = new URLSearchParams();
    params.set("replay", "3");
    params.set("_t", Date.now().toString());

    sseConnection = new EventSource(
      `/api/mcp/servers/rpc/stream?${params.toString()}`,
    );

    sseConnection.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as {
          type?: string;
          serverId?: string;
          direction?: string;
          message?: unknown;
          timestamp?: string;
        };
        if (!data || data.type !== "rpc") return;

        const { serverId, direction, message, timestamp } = data;
        const msg = message as {
          method?: string;
          result?: unknown;
          error?: unknown;
        };
        const method: string =
          typeof msg?.method === "string"
            ? msg.method
            : msg?.result !== undefined
              ? "result"
              : msg?.error !== undefined
                ? "error"
                : "unknown";

        useTrafficLogStore.getState().addMcpServerLog({
          serverId: typeof serverId === "string" ? serverId : "unknown",
          direction:
            typeof direction === "string" ? direction.toUpperCase() : "",
          method,
          timestamp: timestamp ?? new Date().toISOString(),
          payload: message,
        });
      } catch {
        // Ignore parse errors
      }
    };

    sseConnection.onerror = () => {
      sseConnection?.close();
      sseConnection = null;
      sseSubscriberCount = 0; // Reset - old subscribers are effectively orphaned
    };
  }

  // Return unsubscribe function
  return () => {
    sseSubscriberCount--;
    if (sseSubscriberCount <= 0 && sseConnection) {
      sseConnection.close();
      sseConnection = null;
      sseSubscriberCount = 0;
    }
  };
}

/**
 * Helper to extract method name from message based on protocol
 */
export function extractMethod(message: unknown, protocol?: UiProtocol): string {
  // OpenAI Apps: extract from "type" field (e.g., "openai:callTool" → "callTool")
  if (protocol === "openai-apps") {
    const msg = message as { type?: string };
    if (typeof msg?.type === "string") {
      return msg.type.replace("openai:", "");
    }
    return "unknown";
  }

  // MCP Apps (JSON-RPC): extract from method/result/error
  const msg = message as {
    method?: string;
    result?: unknown;
    error?: unknown;
  };
  if (typeof msg?.method === "string") return msg.method;
  if (msg?.result !== undefined) return "result";
  if (msg?.error !== undefined) return "error";
  return "unknown";
}
