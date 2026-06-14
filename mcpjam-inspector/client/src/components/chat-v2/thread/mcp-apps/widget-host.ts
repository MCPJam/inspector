// Tier B widget-runtime extraction — Phase 0 boundary (design only).
//
// See ./widget-host.design.md for the rationale and the phased plan.
//
// `WidgetHost` is the dependency-inversion seam the interactive MCP-Apps widget
// renderer (mcp-apps-renderer / widget-replay) will read from, instead of
// reaching into ~14 inspector stores/contexts/resolvers directly. Today those
// reads are scattered across mcp-apps-renderer.tsx (lines 22-103, 570-942,
// 1364-2101). The inversion: the renderer reads ONE `WidgetHost`; the inspector
// populates it from those sources at a single provider site.
//
// This file is the CONTRACT ONLY — nothing imports it yet, and no behavior
// changes. The in-place refactor that routes the renderer through it lands in
// Phase 1. The contract is anchored to the real inspector signatures via
// `typeof import(...)` / named result types, so it fails typecheck loudly if an
// underlying shape drifts before the migration catches up.

import type { ComponentType, ReactNode } from "react";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  OpenAiAppsCapabilities,
  ResolvedMcpAppsCapabilities,
  ResolvedOpenAiAppsCapabilities,
} from "@/lib/client-styles";
import type { CspMode } from "@/stores/ui-playground-store";
import type {
  CspViolation,
  WidgetDebugInfo,
  WidgetGlobals,
  WidgetLifecycleEvent,
  WidgetSandboxApplied,
  WidgetSandboxInfo,
} from "@/stores/widget-debug-store";
import type { UiLogEvent } from "@/stores/traffic-log-store";
import type {
  FetchMcpAppsWidgetContentRequest,
  FetchMcpAppsWidgetContentResponse,
} from "./fetch-widget-content";

// --- Result shapes pinned to their current resolvers (source of truth) -------

/** Return of `resolveEffectiveHostCapabilities` (client-config-v2). */
export type ResolvedHostCapabilities = ReturnType<
  typeof import("@/lib/client-config-v2").resolveEffectiveHostCapabilities
>;

/** Return of `resolveHostInfo` (client-config-v2). */
export type ResolvedHostInfo = ReturnType<
  typeof import("@/lib/client-config-v2").resolveHostInfo
>;

/** Return of `getHostStyleOrDefault` (client-styles). */
export type ResolvedHostStyle = ReturnType<
  typeof import("@/lib/client-styles").getHostStyleOrDefault
>;

// --- Environment -------------------------------------------------------------

/**
 * Per-`serverId` host environment the renderer needs. Today this is assembled
 * inline from `resolveEffective*` (client-config-v2), preferences + chatbox
 * theme/style, the playground CSP mode, and the draft host context. The
 * inspector computes it in `WidgetHost.resolveEnvironment`; a package renderer
 * never sees the profile system.
 *
 * Resolution is a function of `serverId` (capabilities / CSP vary by the
 * per-server profile), so this is returned by a method, not a static field.
 */
export interface WidgetHostEnvironment {
  hostInfo: ResolvedHostInfo;
  hostCapabilities: ResolvedHostCapabilities;
  mcpAppsCapabilities: ResolvedMcpAppsCapabilities;
  /** Resolved compat-runtime flag (resolveEffectiveCompatRuntime). */
  injectOpenAiCompat: boolean;
  /** Per-method `window.openai.*` surface to inject; omit when shim is off. */
  openAiCompatCapabilities?: ResolvedOpenAiAppsCapabilities;
  /** hostSupportsWidgetRendering(resolveHostCaps(serverId)). */
  supportsWidgetRendering: boolean;
  theme: string;
  hostStyle: ResolvedHostStyle;
  // NOTE: the effective sandbox CSP mode is intentionally NOT here. It depends
  // on the per-widget `minimalMode` prop (per-instance, not per-server), so it
  // cannot be resolved by `resolveEnvironment(serverId)`. The input lives on
  // `WidgetSurfaceInfo.playgroundCspMode`; the renderer derives the effective
  // mode (see that field's doc + mcp-apps-renderer.tsx:741-746).
  /**
   * Base `McpUiHostContext`: draftHostContext + extract*() projections +
   * playground globals (locale, timeZone, safeArea, deviceType, displayMode).
   * The renderer layers per-call fields (controlled display mode, etc.) on top.
   */
  baseHostContext: McpUiHostContext;
}

// --- Services ----------------------------------------------------------------

export type FetchWidgetContentRequest = FetchMcpAppsWidgetContentRequest;
export type FetchWidgetContentResponse = FetchMcpAppsWidgetContentResponse;

/**
 * Widget content fetch + MCP transport. The inspector binds these to
 * `fetchMcpAppsWidgetContent` (authFetch + endpoint resolution + HOSTED_MODE)
 * and the MCP resource/prompt apis. The renderer sees only these calls — never
 * `authFetch`, Convex, or the `/api/*` endpoint layout.
 */
export interface WidgetHostServices {
  fetchWidgetContent: (
    req: FetchWidgetContentRequest,
  ) => Promise<FetchWidgetContentResponse>;
  readResource: typeof import("@/lib/apis/mcp-resources-api").readResource;
  listResources: typeof import("@/lib/apis/mcp-resources-api").listResources;
  listPrompts: typeof import("@/lib/apis/mcp-prompts-api").listPrompts;
  // Phase 1: OpenAI Apps file bridges (uploadFile / getFileDownloadUrl) bind to
  // widget-file-messages here once their host-facing signatures are firmed up.
}

// --- Surface -----------------------------------------------------------------

export type WidgetSurfaceKind =
  | "chat"
  | "playground"
  | "chatbox"
  | "standalone";

export interface WidgetSurfaceInfo {
  /**
   * useWidgetSurface + useIsChatboxSurface collapsed to one descriptor.
   * Phase 1 must confirm chatbox / playground / chat are mutually exclusive
   * (today they are two separate context signals); if they can overlap, `kind`
   * must keep both bits rather than collapse to one enum.
   */
  kind: WidgetSurfaceKind;
  /** usePersistentWidgetSurfaceHost — persistent resource-scoped surfaces. */
  persistentSurfaceHost: boolean;
  /** useWebManagedServers — route widget-content through /api/web. */
  webManagedServers: boolean;
  /** SANDBOX_ORIGIN (VITE_MCPJAM_SANDBOX_ORIGIN); "" when unset. */
  sandboxOrigin: string;
  /**
   * Playground CSP-mode selection (useUIPlaygroundStore.mcpAppsCspMode) — an
   * INPUT, not the effective mode. The renderer derives the effective sandbox
   * CSP mode from `kind` + this + the per-widget `minimalMode` prop, mirroring
   * mcp-apps-renderer.tsx:741-746:
   *
   *   kind === "chatbox" || minimalMode ? "permissive"
   *     : kind === "playground"         ? playgroundCspMode
   *     :                                 "widget-declared"
   *
   * Kept as an input (not pre-resolved in `resolveEnvironment`) because
   * `minimalMode` is per-instance. Source it from the WidgetSurfaceContext —
   * NOT `isPlaygroundActive` — to preserve the first-render iframe-rebuild fix
   * documented at mcp-apps-renderer.tsx:729-739.
   */
  playgroundCspMode: CspMode;
}

// --- Instrumentation (optional) ----------------------------------------------

/**
 * Diagnostics sink. Intentionally 1:1 with `useWidgetDebugStore` +
 * `useTrafficLogStore.addLog` (source of truth) so the Phase 1 migration is a
 * pure refactor — no consolidation. The inspector forwards each call to its
 * zustand stores; a non-inspector host can omit `debug` entirely and lose only
 * the Sandbox/Network debug panels. (Folding these into a single event stream
 * is a deliberately separate, later change.)
 */
export interface WidgetDebugSink {
  recordMount: (toolCallId: string, reason: string) => void;
  setWidgetDebugInfo: (
    toolCallId: string,
    info: Partial<Omit<WidgetDebugInfo, "toolCallId" | "updatedAt">>,
  ) => void;
  setWidgetState: (toolCallId: string, state: unknown) => void;
  setWidgetGlobals: (
    toolCallId: string,
    globals: Partial<WidgetGlobals>,
  ) => void;
  setWidgetCsp: (
    toolCallId: string,
    csp: Omit<WidgetSandboxInfo, "violations">,
  ) => void;
  addCspViolation: (toolCallId: string, violation: CspViolation) => void;
  clearCspViolations: (toolCallId: string) => void;
  setWidgetModelContext: (
    toolCallId: string,
    context: {
      content?: unknown[];
      structuredContent?: Record<string, unknown>;
    } | null,
  ) => void;
  setWidgetHtml: (
    toolCallId: string,
    html: string,
    injectedOpenAiCompat?: boolean,
    injectedOpenAiCompatCapabilities?: OpenAiAppsCapabilities,
  ) => void;
  setSandboxApplied: (
    toolCallId: string,
    applied: WidgetSandboxApplied,
    hostProfileId?: string,
    hostInfo?: { name: string; version: string } | null,
  ) => void;
  appendLifecycle: (
    toolCallId: string,
    event: WidgetLifecycleEvent,
  ) => void;
  /** useTrafficLogStore.addLog */
  addTrafficLog: (event: Omit<UiLogEvent, "id" | "timestamp">) => void;
}

// --- Chrome injection (optional) ---------------------------------------------

/**
 * Provisional — props firm up when mcp-apps-modal is extracted (Phase 3). The
 * design-system <Dialog> chrome becomes an injected component so the renderer
 * stays free of @mcpjam/design-system.
 */
export interface WidgetModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export interface WidgetHostComponents {
  Modal?: ComponentType<WidgetModalProps>;
}

// --- The seam ----------------------------------------------------------------

export interface WidgetHost {
  /** Resolved per-server host environment (see WidgetHostEnvironment). */
  resolveEnvironment: (serverId: string | undefined) => WidgetHostEnvironment;
  services: WidgetHostServices;
  surface: WidgetSurfaceInfo;
  debug?: WidgetDebugSink;
  components?: WidgetHostComponents;
}
