/**
 * Widget Debug Store
 *
 * Tracks widget state and globals for OpenAI Apps and MCP Apps
 * so they can be displayed in the ToolPart debug tabs.
 */

import { create } from "zustand";
import type { CspMode } from "./ui-playground-store";

export interface CspViolation {
  /** The CSP directive that was violated (e.g., "script-src") */
  directive: string;
  /** The effective directive that was violated */
  effectiveDirective?: string;
  /** The URI that was blocked */
  blockedUri: string;
  /** Source file where the violation occurred */
  sourceFile?: string | null;
  /** Line number in source file */
  lineNumber?: number | null;
  /** Column number in source file */
  columnNumber?: number | null;
  /** Timestamp of the violation */
  timestamp: number;
}

export interface WidgetCspInfo {
  /** Current CSP enforcement mode */
  mode: CspMode;
  /** Allowed domains for fetch/XHR (connect-src) - effective values */
  connectDomains: string[];
  /** Allowed domains for scripts/styles/fonts - effective values */
  resourceDomains: string[];
  /** Full CSP header string (for advanced users) */
  headerString?: string;
  /** List of CSP violations for this widget */
  violations: CspViolation[];
  /** Widget's actual openai/widgetCSP declaration (null if not declared) */
  widgetDeclared?: {
    connect_domains?: string[];
    resource_domains?: string[];
  } | null;
}

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
  /** CSP configuration and violation tracking */
  csp?: WidgetCspInfo;
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

  // Set CSP info for a widget
  setWidgetCsp: (
    toolCallId: string,
    csp: Omit<WidgetCspInfo, "violations">,
  ) => void;

  // Add a CSP violation for a widget
  addCspViolation: (toolCallId: string, violation: CspViolation) => void;

  // Clear CSP violations for a widget (e.g., when CSP mode changes)
  clearCspViolations: (toolCallId: string) => void;
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
        csp: existing?.csp, // Preserve CSP violations across updates
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

  setWidgetCsp: (toolCallId, csp) => {
    set((state) => {
      const existing = state.widgets.get(toolCallId);
      if (!existing) return state;

      const widgets = new Map(state.widgets);
      widgets.set(toolCallId, {
        ...existing,
        csp: {
          ...csp,
          violations: existing.csp?.violations ?? [],
        },
        updatedAt: Date.now(),
      });
      return { widgets };
    });
  },

  addCspViolation: (toolCallId, violation) => {
    set((state) => {
      const existing = state.widgets.get(toolCallId);
      if (!existing) return state;

      const widgets = new Map(state.widgets);
      const currentCsp = existing.csp ?? {
        mode: "permissive" as CspMode,
        connectDomains: [],
        resourceDomains: [],
        violations: [],
      };

      widgets.set(toolCallId, {
        ...existing,
        csp: {
          ...currentCsp,
          violations: [...currentCsp.violations, violation],
        },
        updatedAt: Date.now(),
      });
      return { widgets };
    });
  },

  clearCspViolations: (toolCallId) => {
    set((state) => {
      const existing = state.widgets.get(toolCallId);
      if (!existing?.csp) return state;

      const widgets = new Map(state.widgets);
      widgets.set(toolCallId, {
        ...existing,
        csp: {
          ...existing.csp,
          violations: [],
        },
        updatedAt: Date.now(),
      });
      return { widgets };
    });
  },
}));
