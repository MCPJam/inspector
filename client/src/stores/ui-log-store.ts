/**
 * UI Log Store - Client-side logging for MCP Apps (SEP-1865) traffic
 *
 * Captures all JSON-RPC messages between Host and MCP App UIs (iframes).
 * This is a singleton store - no provider required.
 */

import { create } from "zustand";

export interface UiLogEvent {
  id: string;
  widgetId: string; // toolCallId
  serverId: string;
  direction: "host-to-ui" | "ui-to-host";
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
 * Helper to extract method name from JSON-RPC message
 */
export function extractMethod(message: unknown): string {
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
