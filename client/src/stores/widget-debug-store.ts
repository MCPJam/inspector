/**
 * Widget Debug Store
 *
 * Tracks widget state and globals for OpenAI Apps and MCP Apps
 * so they can be displayed in the ToolPart debug tabs.
 */

import { create } from "zustand";

export interface WidgetGlobals {
  theme: "light" | "dark";
  displayMode: "inline" | "pip" | "fullscreen";
  maxHeight?: number;
  locale?: string;
  safeArea?: {
    insets: { top: number; bottom: number; left: number; right: number };
  };
  userAgent?: {
    device: { type: string };
    capabilities: { hover: boolean; touch: boolean };
  };
}

export interface WidgetDebugInfo {
  toolCallId: string;
  toolName: string;
  protocol: "openai-apps" | "mcp-apps";
  widgetState: unknown;
  globals: WidgetGlobals;
  updatedAt: number;
}

interface WidgetDebugStore {
  widgets: Map<string, WidgetDebugInfo>;

  // Update widget debug info
  setWidgetDebugInfo: (
    toolCallId: string,
    info: Partial<Omit<WidgetDebugInfo, "toolCallId" | "updatedAt">>,
  ) => void;

  // Update just the widget state
  setWidgetState: (toolCallId: string, state: unknown) => void;

  // Update just the globals
  setWidgetGlobals: (
    toolCallId: string,
    globals: Partial<WidgetGlobals>,
  ) => void;

  // Get debug info for a specific widget
  getWidgetDebugInfo: (toolCallId: string) => WidgetDebugInfo | undefined;

  // Remove widget debug info (cleanup)
  removeWidgetDebugInfo: (toolCallId: string) => void;

  // Clear all widgets
  clear: () => void;
}

export const useWidgetDebugStore = create<WidgetDebugStore>((set, get) => ({
  widgets: new Map(),

  setWidgetDebugInfo: (toolCallId, info) => {
    set((state) => {
      const widgets = new Map(state.widgets);
      const existing = widgets.get(toolCallId);
      widgets.set(toolCallId, {
        toolCallId,
        toolName: info.toolName ?? existing?.toolName ?? "unknown",
        protocol: info.protocol ?? existing?.protocol ?? "openai-apps",
        widgetState:
          info.widgetState !== undefined
            ? info.widgetState
            : (existing?.widgetState ?? null),
        globals: info.globals ??
          existing?.globals ?? {
            theme: "dark",
            displayMode: "inline",
          },
        updatedAt: Date.now(),
      });
      return { widgets };
    });
  },

  setWidgetState: (toolCallId, widgetState) => {
    set((state) => {
      const widgets = new Map(state.widgets);
      const existing = widgets.get(toolCallId);
      if (existing) {
        widgets.set(toolCallId, {
          ...existing,
          widgetState,
          updatedAt: Date.now(),
        });
      }
      return { widgets };
    });
  },

  setWidgetGlobals: (toolCallId, globals) => {
    set((state) => {
      const widgets = new Map(state.widgets);
      const existing = widgets.get(toolCallId);
      if (existing) {
        widgets.set(toolCallId, {
          ...existing,
          globals: { ...existing.globals, ...globals },
          updatedAt: Date.now(),
        });
      }
      return { widgets };
    });
  },

  getWidgetDebugInfo: (toolCallId) => {
    return get().widgets.get(toolCallId);
  },

  removeWidgetDebugInfo: (toolCallId) => {
    set((state) => {
      const widgets = new Map(state.widgets);
      widgets.delete(toolCallId);
      return { widgets };
    });
  },

  clear: () => {
    set({ widgets: new Map() });
  },
}));
