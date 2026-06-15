// Tier B — the `WidgetHost` dependency-inversion contract.
//
// See ./widget-host.design.md for the rationale and the phased plan.
//
// `WidgetHost` is the seam the interactive MCP-Apps widget renderer
// (mcp-apps-renderer) reads from instead of reaching into inspector
// stores/contexts/resolvers directly. The inspector-side adapter `useWidgetHost`
// (./use-widget-host.ts) implements it; `mcp-apps-renderer.tsx` consumes it and,
// as of Phase 1b, imports zero `@/stores`/`@/contexts`/`@/lib/client-*` modules
// (enforced by check-renderer-tier-b-imports.mjs).
//
// Scope note: this boundary makes the RENDERER app-state-import-clean. It does
// NOT yet make the whole widget runtime package-clean — e.g. the
// `MCPAppsRenderer` wrapper still reads `usePersistentWidgetSurfaceHost`
// directly, and sibling files (modal/chrome) still touch inspector state. Those
// relocate in Phases 2-3.
//
// The contract is anchored to the real inspector signatures via
// `typeof import(...)` / named result types, so it fails typecheck loudly if an
// underlying shape drifts.

import type { ComponentType, ReactNode } from "react";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  OpenAiAppsCapabilities,
  ResolvedMcpAppsCapabilities,
  ResolvedOpenAiAppsCapabilities,
} from "@/lib/client-styles";
import type {
  CspMode,
  DeviceCapabilities,
  DeviceType,
  PlaygroundGlobals,
  SafeAreaInsets,
} from "@/stores/ui-playground-store";
import type { PreferencesState } from "@/stores/preferences/preferences-store";
import type { ProjectHostContextDraft } from "@/lib/client-config";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";
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

// --- Environment (Phase 1b: raw ambient inputs) ------------------------------

/**
 * Raw ambient ENV inputs the renderer reads directly today (preferences,
 * chatbox style/theme/capability overrides, the active mcpProfile, the draft
 * host context, and the playground globals). Phase 1b routes these through the
 * host so the renderer keeps ALL of its existing derivation in place
 * (memoization, ternaries, dependency arrays) but stops importing `@/stores`
 * and `@/contexts`. The adapter (`useWidgetHost`) subscribes to the same
 * fine-grained selectors/hooks the renderer used, so reactivity is unchanged.
 *
 * Every field is pinned to its real source type so a source-shape drift fails
 * typecheck loudly before this contract goes stale. Phase 3 replaces these raw
 * inputs with `WidgetHost.resolveEnvironment` (see below).
 */
export interface WidgetHostEnvironmentInputs {
  /** usePreferencesStore((s) => s.themeMode). */
  themeMode: PreferencesState["themeMode"];
  /** usePreferencesStore((s) => s.hostStyle) — the "shared" host style. */
  sharedHostStyle: PreferencesState["hostStyle"];
  /** useChatboxHostStyle(). */
  chatboxHostStyle: ReturnType<
    typeof import("@/contexts/chatbox-client-style-context").useChatboxHostStyle
  >;
  /** useChatboxHostTheme(). */
  chatboxHostTheme: ReturnType<
    typeof import("@/contexts/chatbox-client-style-context").useChatboxHostTheme
  >;
  /** useChatboxHostCapabilitiesOverride(). */
  hostCapabilitiesOverride: ReturnType<
    typeof import("@/contexts/chatbox-client-capabilities-override-context").useChatboxHostCapabilitiesOverride
  >;
  /**
   * useActiveMcpProfile(). Drives the capability / compat / sandbox resolvers
   * AND the renderer's `apps.sandbox.*` reads (csp, permissions, sandboxAttrs,
   * allowFeatures, cspDirectives) + `apps.uiInitialize.hostInfo`.
   */
  activeMcpProfile: HostConfigMcpProfileV1 | undefined;
  /** useHostContextStore((s) => s.draftHostContext). */
  draftHostContext: ProjectHostContextDraft;
  /** useUIPlaygroundStore((s) => s.isPlaygroundActive). */
  isPlaygroundActive: boolean;
  /** useUIPlaygroundStore((s) => s.globals.locale). */
  playgroundLocale: PlaygroundGlobals["locale"];
  /** useUIPlaygroundStore((s) => s.globals.timeZone). */
  playgroundTimeZone: PlaygroundGlobals["timeZone"];
  /** useUIPlaygroundStore((s) => s.displayMode). */
  playgroundDisplayMode: DisplayMode;
  /** useUIPlaygroundStore((s) => s.capabilities). */
  playgroundCapabilities: DeviceCapabilities;
  /** useUIPlaygroundStore((s) => s.safeAreaInsets). */
  playgroundSafeAreaInsets: SafeAreaInsets;
  /** useUIPlaygroundStore((s) => s.deviceType). */
  playgroundDeviceType: DeviceType;
}

// --- Resolvers (Phase 1b: bound util/resolver fns) ---------------------------

/**
 * Resolver / projection functions the renderer imports from the inspector
 * config layer today (`client-config-v2`, `client-styles`, `client-config`).
 * Phase 1b binds them here so the renderer keeps its call sites verbatim
 * (`host.resolvers.x(...)`) while dropping the `@/lib/client-*` imports.
 *
 * Each member is pinned to the live exported function via `typeof import(...)`
 * so the bound surface can't silently drift from the source signatures.
 * `DEFAULT_HOST_STYLE` is the one non-function member — the renderer reads it
 * once to pin the SEP style-variable allowlist.
 */
export interface WidgetHostResolvers {
  resolveEffectiveCompatRuntime: typeof import("@/lib/client-config-v2").resolveEffectiveCompatRuntime;
  resolveEffectiveMcpAppsCapabilities: typeof import("@/lib/client-config-v2").resolveEffectiveMcpAppsCapabilities;
  resolveEffectiveHostCapabilities: typeof import("@/lib/client-config-v2").resolveEffectiveHostCapabilities;
  resolveHostInfo: typeof import("@/lib/client-config-v2").resolveHostInfo;
  getHostStyleOrDefault: typeof import("@/lib/client-styles").getHostStyleOrDefault;
  DEFAULT_HOST_STYLE: typeof import("@/lib/client-styles").DEFAULT_HOST_STYLE;
  extractHostTheme: typeof import("@/lib/client-config").extractHostTheme;
  extractHostDisplayMode: typeof import("@/lib/client-config").extractHostDisplayMode;
  extractHostDisplayModes: typeof import("@/lib/client-config").extractHostDisplayModes;
  clampDisplayModeToAvailableModes: typeof import("@/lib/client-config").clampDisplayModeToAvailableModes;
  stableStringifyJson: typeof import("@/lib/client-config").stableStringifyJson;
}

// --- Type re-exports for the renderer ----------------------------------------
//
// The Tier-B import guard forbids the renderer from importing `@/stores/*` and
// `@/lib/client-styles` even for `import type`. Re-export the type-only symbols
// the renderer still needs here so it can import them from the host boundary.

export type {
  OpenAiAppsCapabilities,
  ResolvedMcpAppsCapabilities,
} from "@/lib/client-styles";
export type { CspMode } from "@/stores/ui-playground-store";
export type { WidgetLifecycleEvent } from "@/stores/widget-debug-store";
export type { UiProtocol } from "@/stores/traffic-log-store";

// `extractMethod` is a pure JSON-RPC message parser (no store state, no React)
// the renderer uses for traffic-log wiring. Re-exported through the boundary —
// alongside the `UiProtocol` type and the `WidgetDebugSink.addTrafficLog`
// sink — so the renderer's call sites stay verbatim while it stops importing
// `@/stores/*` (Tier-B guard). The function relocates with the traffic-log
// utilities in a later phase.
export { extractMethod } from "@/stores/traffic-log-store";

// `stableStringifyJson` is exposed for components via `WidgetHostResolvers`
// (read off `host.resolvers`), but `mcp-apps-renderer.tsx` also calls it from
// MODULE scope (`getPersistentSurfaceId`, used by the `MCPAppsRenderer`
// wrapper's persistent path) where no host instance exists. Re-export the pure
// canonicalizer here so that module-level call site can import it from the
// boundary instead of `@/lib/client-config` (Tier-B guard). Same underlying fn
// as `resolvers.stableStringifyJson`, so the two paths can't diverge.
export { stableStringifyJson } from "@/lib/client-config";

/**
 * Widget display-mode union. Mirrors the inspector playground store's
 * `DisplayMode` (and the SEP `HostDisplayMode`); re-declared here (rather than
 * re-exported from `@/stores`) so the renderer can import it from the host
 * boundary and satisfy the Tier-B guard.
 */
export type DisplayMode = "inline" | "pip" | "fullscreen";

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
  /**
   * `resources/templates/list` for the MCP-Apps bridge
   * (host-app-bridge `onListResourceTemplates`). HOST-OWNED — NOT the raw api
   * fn. The provider MUST apply the same guard the renderer does today: throw
   * when `HOSTED_MODE || surface.webManagedServers` is true
   * (mcp-apps-renderer.tsx:2861-2868). The underlying
   * `mcp-resource-templates-api.listResourceTemplates` only enforces
   * `HOSTED_MODE` (via `ensureLocalMode`), NOT web-managed, so binding it
   * directly in Phase 1 would let web-managed chatbox/widget surfaces drift.
   * Typed structurally (return shape still pinned to the api) to signal the
   * provider owns the implementation rather than forwarding the raw fn.
   */
  listResourceTemplates: (
    serverId: string,
  ) => Promise<
    Awaited<
      ReturnType<
        typeof import("@/lib/apis/mcp-resource-templates-api").listResourceTemplates
      >
    >
  >;
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
  /**
   * Resolved per-server host environment (see WidgetHostEnvironment) — the
   * documented Phase-3 target: the inspector resolves the full per-server
   * environment once and the renderer drops its derivation logic.
   *
   * OPTIONAL in the contract because Phase 1b deliberately does NOT implement
   * it. Phase 1b is a behavior-preserving IN-PLACE inversion: it keeps the
   * renderer's derivation byte-for-byte and only routes the renderer's raw
   * ambient reads (see `environment`) and imported resolver fns (see
   * `resolvers`) through the host. Pre-resolving the environment is a separate,
   * higher-risk change saved for Phase 3; leaving this required would force
   * `useWidgetHost` to implement the security-sensitive sandbox/profile
   * resolution before its tests exist.
   */
  resolveEnvironment?: (serverId: string | undefined) => WidgetHostEnvironment;
  /**
   * Raw ambient ENV inputs (Phase 1b). The renderer keeps its existing
   * derivation; this just relocates the store/context read sites behind the
   * host so the renderer imports zero `@/stores`/`@/contexts`. Folded into
   * `resolveEnvironment` in Phase 3.
   */
  environment: WidgetHostEnvironmentInputs;
  /**
   * Bound resolver/projection fns (Phase 1b) the renderer used to import from
   * `@/lib/client-*` directly. Call sites stay verbatim as `resolvers.x(...)`.
   */
  resolvers: WidgetHostResolvers;
  services: WidgetHostServices;
  surface: WidgetSurfaceInfo;
  debug?: WidgetDebugSink;
  components?: WidgetHostComponents;
}
