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

/**
 * Resolved sandbox payload — the same object MCP-Apps renderer posts to the
 * sandbox proxy iframe at runtime. Populated only for MCP Apps tool calls;
 * absent for OpenAI Apps (which doesn't go through `resolveSandboxCsp` /
 * `resolveSandboxPermissions`).
 *
 * Naming follows the runtime envelope on purpose: `sandboxAttrs` /
 * `allowFeatures` are inputs to <SandboxedIframe>; the literal emitted
 * `sandbox=` / `allow=` attribute strings are computed inside that
 * component and not currently surfaced here (see follow-up in
 * sandbox-debug-panel.tsx).
 */
export interface WidgetSandboxApplied {
  /**
   * Tokens passed as the additional outer/inner iframe `sandbox=` attribute
   * beyond the spec-required `allow-scripts allow-same-origin`. Absent
   * when the host hasn't configured `mcpProfile.apps.sandbox.sandboxAttrs`.
   */
  sandboxAttrs?: string[];
  /** Permissions Policy entries for the iframe `allow=` attribute. */
  allowFeatures?: Record<string, string>;
  /**
   * Per-directive CSP source-expression overrides (inspector-only —
   * `cspDirectives` knob). Merged into the proxy CSP after the resolver's
   * allowlist directives.
   */
  cspDirectives?: Record<string, string[]>;
  /**
   * `true` when the surface bypassed the host CSP resolver entirely
   * (permissive surface with no hardening signals). Drives the
   * "permissive" badge in the debug panel.
   */
  permissive: boolean;
  /**
   * `true` when a non-trivial host policy was applied (resolvedCsp or
   * resolvedPermissions or pure-relaxed). Lets the panel distinguish
   * "default everything" from "host actively shaped this".
   */
  hostPolicyApplied: boolean;
  /**
   * Echoed from the original host profile (the resolver intersects but
   * doesn't return these verbatim). Lets the matrix-shared grid show the
   * narrowing knobs even when the resolver collapsed them into an
   * intersection.
   */
  restrictTo?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  cspMode?: "host-default" | "declared" | "relaxed";
  /**
   * Granted permissions after the resolver intersected widget-requested
   * permissions against host policy. Same shape as the widget-requested
   * `permissions` field above; the panel renders this as the matrix's
   * "Permissions" row (vs widget-requested which appears in the declared-
   * CSP section). Absent when no permissions were granted.
   */
  permissions?: {
    camera?: {};
    microphone?: {};
    geolocation?: {};
    clipboardWrite?: {};
  };
}

/**
 * One iframe-load attempt for a widget. The renderer records a mount
 * each time its fetch-source key flips (toolCallId, resourceUri,
 * cachedWidgetHtmlUrl, cspMode, liveFetchPreferred) — i.e. every time
 * the iframe is torn down and re-mounted with new HTML. `reason`
 * names the segments that changed so devs can spot self-induced
 * reloads ("rendered then disappeared" usually = an unexpected
 * second mount triggered by a snapshot landing or a prop flip).
 */
export interface WidgetMount {
  /** 1-based index. */
  index: number;
  /** Human reason this mount fired. "initial" for the first one. */
  reason: string;
  /** Mount start timestamp. */
  at: number;
}

/**
 * One lifecycle event from the widget's load/connect sequence. Recorded
 * by `mcp-apps-renderer` from the same `logWidgetDebug` callsites that
 * already feed the traffic log, so this never invents events — it just
 * captures what already happened.
 */
export interface WidgetLifecycleEvent {
  kind:
    | "sandbox-proxy-ready"
    | "widget-content-requested"
    | "widget-content-ready"
    | "widget-content-error"
    | "widget-content-invalid-mimetype"
    | "bridge-connect-start"
    | "bridge-connect-ready"
    | "bridge-connect-error"
    | "bridge-connect-skipped"
    | "app-initialized";
  status: "ok" | "error" | "pending";
  message?: string;
  timestamp: number;
}

export interface WidgetSandboxInfo {
  /** Current CSP enforcement mode */
  mode: CspMode;
  /** Allowed domains for fetch/XHR (connect-src) - effective values */
  connectDomains: string[];
  /** Allowed domains for scripts/styles/fonts - effective values */
  resourceDomains: string[];
  /** Allowed domains for nested iframes (frame-src) - effective values */
  frameDomains?: string[];
  /** Allowed base URIs (base-uri) - effective values */
  baseUriDomains?: string[];
  /** Permissions requested by the widget */
  permissions?: {
    camera?: {};
    microphone?: {};
    geolocation?: {};
    clipboardWrite?: {};
  };
  /** Full CSP header string (for advanced users) */
  headerString?: string;
  /** List of CSP violations for this widget */
  violations: CspViolation[];
  /** Widget's actual CSP declaration (null if not declared) */
  widgetDeclared?: {
    // ChatGPT Apps format (snake_case)
    connect_domains?: string[];
    resource_domains?: string[];
    // MCP Apps format (camelCase)
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  } | null;
}

export interface WidgetGlobals {
  theme: "light" | "dark";
  displayMode: "inline" | "pip" | "fullscreen";
  maxHeight?: number;
  maxWidth?: number;
  locale?: string;
  safeArea?: {
    insets: { top: number; bottom: number; left: number; right: number };
  };
  timeZone?: string;
  deviceCapabilities?: { hover: boolean; touch: boolean };
  safeAreaInsets?: { top: number; bottom: number; left: number; right: number };
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
  prefersBorder?: boolean;
  updatedAt: number;
  /**
   * Renderer-known server identity. Set by the renderer's init effect from
   * the tool-call provenance; lets the snapshot capture hook persist saves
   * even when the tool-result envelope omits `_meta._serverId`.
   */
  serverId?: string;
  /**
   * MCP Apps resource URI, or OpenAI Apps `openai/outputTemplate`. Same
   * fallback role as `serverId` above.
   */
  resourceUri?: string;
  /**
   * CSP configuration and violation tracking. Historical field name —
   * keeps the existing `setWidgetCsp` / `addCspViolation` /
   * `clearCspViolations` API surface unchanged. The Sandbox debug panel
   * also reads from sibling fields below (`applied`, `lifecycle`) when the
   * MCP-Apps renderer publishes them.
   */
  csp?: WidgetSandboxInfo;
  /**
   * Resolved sandbox payload from the MCP-Apps runtime resolver. Absent
   * for OpenAI Apps (which doesn't share that code path) and for any
   * widget that hasn't yet reached the resolver step.
   */
  applied?: WidgetSandboxApplied;
  /**
   * Active host profile id when available — drives the panel's deep-link
   * row clicks into the host-config Apps tab. Optional because the
   * runtime context isn't always anchored to a saved host (e.g. evals,
   * one-shot tool calls).
   */
  hostProfileId?: string;
  /**
   * hostInfo advertised in `ui/initialize` per SEP-1865
   * §McpUiInitializeResult. Surfaced in the Sandbox debug panel's
   * "View iframe" sub-card so the runtime view matches what a view
   * actually receives over the wire. `null` when the host hasn't
   * customized it (the inspector falls back to its own identity).
   */
  hostInfo?: { name: string; version: string } | null;
  /**
   * Lifecycle event sequence captured from the renderer's `logWidgetDebug`
   * callsites. Always an array (never undefined); empty when no events
   * have fired yet. Consecutive same-kind same-status events are deduped
   * to a single entry whose timestamp/message reflect the latest.
   */
  lifecycle: WidgetLifecycleEvent[];
  /**
   * Iframe re-mount log. Each entry = one new fetch-source key. A
   * healthy widget has exactly one entry; more than one signals the
   * iframe was torn down and rebuilt mid-session.
   */
  mounts: WidgetMount[];
  /** Model context set by the widget (SEP-1865 ui/update-model-context) */
  modelContext?: {
    content?: unknown[];
    structuredContent?: Record<string, unknown>;
    updatedAt: number;
  } | null;
  /** Cached widget HTML for offline rendering */
  widgetHtml?: string;
  /**
   * Whether `widgetHtml` was captured with the OpenAI Apps SDK
   * `window.openai` shim injected. Mirrors the renderer's resolved
   * compat flag at fetch time and travels into saved views so replay
   * agrees with the bytes.
   */
  injectedOpenAiCompat?: boolean;
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
    csp: Omit<WidgetSandboxInfo, "violations">,
  ) => void;

  // Add a CSP violation for a widget
  addCspViolation: (toolCallId: string, violation: CspViolation) => void;

  // Clear CSP violations for a widget (e.g., when CSP mode changes)
  clearCspViolations: (toolCallId: string) => void;

  // Set model context for a widget (SEP-1865 ui/update-model-context)
  setWidgetModelContext: (
    toolCallId: string,
    context: {
      content?: unknown[];
      structuredContent?: Record<string, unknown>;
    } | null,
  ) => void;

  // Set widget HTML for offline rendering cache. Optional
  // injectedOpenAiCompat carries the compat-runtime flag that was
  // resolved when the HTML was fetched, so consumers (e.g. ViewsTab
  // save path) can persist it alongside the blob.
  setWidgetHtml: (
    toolCallId: string,
    html: string,
    injectedOpenAiCompat?: boolean,
  ) => void;

  /**
   * Publish the resolved sandbox payload from the MCP-Apps renderer.
   * Create-if-missing (patterned after setWidgetHtml): the first lifecycle
   * event can fire before setWidgetDebugInfo's init effect, so early-
   * returning when no record exists would silently drop the most important
   * sequence.
   */
  setSandboxApplied: (
    toolCallId: string,
    applied: WidgetSandboxApplied,
    hostProfileId?: string,
    hostInfo?: { name: string; version: string } | null,
  ) => void;

  /**
   * Append one lifecycle event. Dedupes when the previous entry has the
   * same `kind` AND `status` — replaces timestamp/message instead of
   * pushing — so a flaky network doesn't smear the panel with 12 duplicate
   * "bridge-connect-error" rows. Create-if-missing for the same reason as
   * setSandboxApplied (the renderer's first widget-content-requested event
   * fires before the init effect).
   */
  appendLifecycle: (
    toolCallId: string,
    event: WidgetLifecycleEvent,
  ) => void;

  /**
   * Append one mount entry. Create-if-missing for the same reason as
   * `appendLifecycle` — the renderer's first mount is recorded before
   * `setWidgetDebugInfo`'s init effect settles.
   */
  recordMount: (toolCallId: string, reason: string) => void;
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
        prefersBorder:
          info.prefersBorder !== undefined
            ? info.prefersBorder
            : existing?.prefersBorder,
        serverId: info.serverId ?? existing?.serverId,
        resourceUri: info.resourceUri ?? existing?.resourceUri,
        csp: existing?.csp, // Preserve CSP violations across updates
        // Preserve runtime-only fields populated by the renderer's
        // create-if-missing setters (setSandboxApplied / appendLifecycle).
        applied: existing?.applied,
        hostProfileId: existing?.hostProfileId,
        hostInfo: existing?.hostInfo,
        lifecycle: existing?.lifecycle ?? [],
        mounts: existing?.mounts ?? [],
        widgetHtml: existing?.widgetHtml, // Preserve cached HTML for save view feature
        // Preserve the cached compat-runtime flag across debug-info
        // merges so the save path keeps seeing the value the renderer
        // stamped at fetch time.
        injectedOpenAiCompat: existing?.injectedOpenAiCompat,
        modelContext: existing?.modelContext, // Preserve model context across updates
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

  setWidgetModelContext: (toolCallId, context) => {
    set((state) => {
      const existing = state.widgets.get(toolCallId);
      if (!existing) return state;

      const widgets = new Map(state.widgets);
      widgets.set(toolCallId, {
        ...existing,
        modelContext: context
          ? {
              content: context.content,
              structuredContent: context.structuredContent,
              updatedAt: Date.now(),
            }
          : null,
        updatedAt: Date.now(),
      });
      return { widgets };
    });
  },

  setWidgetHtml: (toolCallId, html, injectedOpenAiCompat) => {
    set((state) => {
      const widgets = new Map(state.widgets);
      const existing = widgets.get(toolCallId);
      // Create a default entry if one doesn't exist (fixes race condition where
      // setWidgetHtml is called before setWidgetDebugInfo initializes the entry)
      widgets.set(toolCallId, {
        toolCallId,
        toolName: existing?.toolName ?? "unknown",
        protocol: existing?.protocol ?? "mcp-apps",
        widgetState: existing?.widgetState ?? null,
        globals: existing?.globals ?? { theme: "dark", displayMode: "inline" },
        prefersBorder: existing?.prefersBorder,
        serverId: existing?.serverId,
        resourceUri: existing?.resourceUri,
        csp: existing?.csp,
        applied: existing?.applied,
        hostProfileId: existing?.hostProfileId,
        hostInfo: existing?.hostInfo,
        lifecycle: existing?.lifecycle ?? [],
        mounts: existing?.mounts ?? [],
        modelContext: existing?.modelContext,
        widgetHtml: html,
        injectedOpenAiCompat:
          injectedOpenAiCompat ?? existing?.injectedOpenAiCompat,
        updatedAt: Date.now(),
      });
      return { widgets };
    });
  },

  setSandboxApplied: (toolCallId, applied, hostProfileId, hostInfo) => {
    set((state) => {
      const widgets = new Map(state.widgets);
      const existing = widgets.get(toolCallId);
      // Create-if-missing patterned after setWidgetHtml — see the
      // store-level dock comment on setSandboxApplied. Without this the
      // first call (which can fire before setWidgetDebugInfo's init effect
      // settles) would early-return and the panel would never see the
      // resolved policy.
      widgets.set(toolCallId, {
        toolCallId,
        toolName: existing?.toolName ?? "unknown",
        protocol: existing?.protocol ?? "mcp-apps",
        widgetState: existing?.widgetState ?? null,
        globals: existing?.globals ?? { theme: "dark", displayMode: "inline" },
        prefersBorder: existing?.prefersBorder,
        serverId: existing?.serverId,
        resourceUri: existing?.resourceUri,
        csp: existing?.csp,
        applied,
        hostProfileId: hostProfileId ?? existing?.hostProfileId,
        hostInfo: hostInfo !== undefined ? hostInfo : existing?.hostInfo,
        lifecycle: existing?.lifecycle ?? [],
        mounts: existing?.mounts ?? [],
        modelContext: existing?.modelContext,
        widgetHtml: existing?.widgetHtml,
        updatedAt: Date.now(),
      });
      return { widgets };
    });
  },

  appendLifecycle: (toolCallId, event) => {
    set((state) => {
      const widgets = new Map(state.widgets);
      const existing = widgets.get(toolCallId);
      const existingLifecycle = existing?.lifecycle ?? [];
      // Dedupe consecutive same-kind same-status entries — replace
      // timestamp + message rather than push, so a retry storm doesn't
      // smear the panel with 12 duplicate dots.
      const last = existingLifecycle[existingLifecycle.length - 1];
      let nextLifecycle: WidgetLifecycleEvent[];
      if (last && last.kind === event.kind && last.status === event.status) {
        nextLifecycle = [
          ...existingLifecycle.slice(0, -1),
          { ...last, timestamp: event.timestamp, message: event.message },
        ];
      } else {
        nextLifecycle = [...existingLifecycle, event];
      }
      widgets.set(toolCallId, {
        toolCallId,
        toolName: existing?.toolName ?? "unknown",
        protocol: existing?.protocol ?? "mcp-apps",
        widgetState: existing?.widgetState ?? null,
        globals: existing?.globals ?? { theme: "dark", displayMode: "inline" },
        prefersBorder: existing?.prefersBorder,
        serverId: existing?.serverId,
        resourceUri: existing?.resourceUri,
        csp: existing?.csp,
        applied: existing?.applied,
        hostProfileId: existing?.hostProfileId,
        hostInfo: existing?.hostInfo,
        lifecycle: nextLifecycle,
        mounts: existing?.mounts ?? [],
        modelContext: existing?.modelContext,
        widgetHtml: existing?.widgetHtml,
        updatedAt: Date.now(),
      });
      return { widgets };
    });
  },

  recordMount: (toolCallId, reason) => {
    set((state) => {
      const widgets = new Map(state.widgets);
      const existing = widgets.get(toolCallId);
      const existingMounts = existing?.mounts ?? [];
      const nextMounts: WidgetMount[] = [
        ...existingMounts,
        { index: existingMounts.length + 1, reason, at: Date.now() },
      ];
      widgets.set(toolCallId, {
        toolCallId,
        toolName: existing?.toolName ?? "unknown",
        protocol: existing?.protocol ?? "mcp-apps",
        widgetState: existing?.widgetState ?? null,
        globals: existing?.globals ?? { theme: "dark", displayMode: "inline" },
        prefersBorder: existing?.prefersBorder,
        serverId: existing?.serverId,
        resourceUri: existing?.resourceUri,
        csp: existing?.csp,
        applied: existing?.applied,
        hostProfileId: existing?.hostProfileId,
        hostInfo: existing?.hostInfo,
        lifecycle: existing?.lifecycle ?? [],
        mounts: nextMounts,
        modelContext: existing?.modelContext,
        widgetHtml: existing?.widgetHtml,
        updatedAt: Date.now(),
      });
      return { widgets };
    });
  },
}));
