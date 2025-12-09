/**
 * UI Log Store - Client-side logging for MCP Apps (SEP-1865) and OpenAI Apps SDK traffic
 *
 * Captures all messages between Host and App UIs (iframes).
 * This is a singleton store - no provider required.
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

interface UiLogState {
  items: UiLogEvent[];
  addLog: (event: Omit<UiLogEvent, "id" | "timestamp">) => void;
  clear: () => void;
}

const MAX_ITEMS = 1000;

export const useUiLogStore = create<UiLogState>((set) => ({
  items: [],
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
  clear: () => set({ items: [] }),
}));

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
