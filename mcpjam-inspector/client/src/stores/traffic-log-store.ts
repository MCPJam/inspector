/**
 * Traffic Log Store - Captures all MCP traffic for debugging
 *
 * Includes:
 * - MCP Apps / OpenAI Apps SDK traffic (iframe ↔ host messages)
 * - MCP Server RPC traffic (client ↔ server messages)
 * - X-Ray AI request traffic (messages sent to AI models)
 *
 * This is a singleton store - no provider required.
 * The SSE subscriptions are also singletons to prevent duplicate connections.
 */

import { create } from "zustand";
import { addTokenToUrl } from "@/lib/session-token";
import type { XRayLogEvent } from "@shared/xray-types";

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
  xrayItems: XRayLogEvent[];
  addLog: (event: Omit<UiLogEvent, "id" | "timestamp">) => void;
  addMcpServerLog: (item: Omit<McpServerRpcItem, "id">) => void;
  addXRayLog: (event: XRayLogEvent) => void;
  clear: () => void;
  clearXRay: () => void;
}

const MAX_ITEMS = 1000;

export const useTrafficLogStore = create<TrafficLogState>((set) => ({
  items: [],
  mcpServerItems: [],
  xrayItems: [],
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
  addXRayLog: (event) => {
    console.log("[traffic-log-store] Adding X-Ray event:", event.id);
    set((state) => {
      const newItems = [event, ...state.xrayItems].slice(0, MAX_ITEMS);
      console.log("[traffic-log-store] X-Ray items count:", newItems.length);
      return { xrayItems: newItems };
    });
  },
  clear: () => set({ items: [], mcpServerItems: [], xrayItems: [] }),
  clearXRay: () => set({ xrayItems: [] }),
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
      addTokenToUrl(`/api/mcp/servers/rpc/stream?${params.toString()}`),
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
 * Singleton SSE subscription for X-Ray AI request traffic.
 * This ensures only one EventSource connection exists regardless of
 * how many components subscribe to X-Ray events.
 */
let xraySseConnection: EventSource | null = null;
let xraySseSubscriberCount = 0;

export function subscribeToXRayStream(): () => void {
  xraySseSubscriberCount++;
  console.log("[xray-client] Subscribe called, count:", xraySseSubscriberCount);

  if (!xraySseConnection) {
    const params = new URLSearchParams();
    params.set("replay", "10");
    params.set("_t", Date.now().toString());

    const url = addTokenToUrl(`/api/mcp/xray/stream?${params.toString()}`);
    console.log("[xray-client] Creating SSE connection to:", url);
    xraySseConnection = new EventSource(url);

    xraySseConnection.onopen = () => {
      console.log("[xray-client] SSE connection opened");
    };

    xraySseConnection.onmessage = (evt) => {
      console.log("[xray-client] Received message:", evt.data.substring(0, 100));
      try {
        const data = JSON.parse(evt.data) as {
          eventType?: string;
          type?: string;
          id?: string;
          timestamp?: string;
          model?: { id: string; provider: string };
          messages?: unknown[];
          systemPrompt?: string;
          tools?: unknown[];
          temperature?: number;
          selectedServers?: string[];
          path?: string;
        };
        // Check eventType (wrapper) not type (which is the event's own type: "ai-request")
        if (!data || data.eventType !== "xray") return;

        const xrayEvent: XRayLogEvent = {
          id: data.id ?? `xray_${Date.now()}`,
          timestamp: data.timestamp ?? new Date().toISOString(),
          type: "ai-request",
          model: data.model ?? { id: "unknown", provider: "unknown" },
          messages: (data.messages ?? []) as XRayLogEvent["messages"],
          systemPrompt: data.systemPrompt,
          tools: (data.tools ?? []) as XRayLogEvent["tools"],
          temperature: data.temperature,
          selectedServers: data.selectedServers ?? [],
          path: (data.path as "streamText" | "mcpjam-backend") ?? "streamText",
        };

        console.log("[xray-client] Adding event to store:", xrayEvent.id);
        useTrafficLogStore.getState().addXRayLog(xrayEvent);
      } catch (e) {
        console.error("[xray-client] Parse error:", e);
      }
    };

    xraySseConnection.onerror = (err) => {
      console.error("[xray-client] SSE error:", err);
      xraySseConnection?.close();
      xraySseConnection = null;
      xraySseSubscriberCount = 0; // Reset - old subscribers are effectively orphaned
    };
  }

  // Return unsubscribe function
  return () => {
    xraySseSubscriberCount--;
    if (xraySseSubscriberCount <= 0 && xraySseConnection) {
      xraySseConnection.close();
      xraySseConnection = null;
      xraySseSubscriberCount = 0;
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
