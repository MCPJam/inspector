/**
 * MCPAppsRenderer - SEP-1865 MCP Apps Renderer
 *
 * Renders MCP Apps widgets using the SEP-1865 protocol:
 * - JSON-RPC 2.0 over postMessage
 * - Double-iframe sandbox architecture
 * - tools/call, resources/read, ui/message, ui/open-link support
 *
 * Uses SandboxedIframe for DRY double-iframe setup.
 */

import {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  type CSSProperties,
} from "react";
import { useToolInputStreaming, type ToolState } from "./useToolInputStreaming";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useUIPlaygroundStore,
  type CspMode,
} from "@/stores/ui-playground-store";
import { Loader2, X } from "lucide-react";
import {
  SandboxedIframe,
  SandboxedIframeHandle,
} from "@/components/ui/sandboxed-iframe";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";
import { useIsChatboxSurface } from "@/contexts/chatbox-surface-context";
import { useWidgetSurface } from "@/contexts/widget-surface-context";
import {
  resolveSandboxCsp,
  resolveSandboxPermissions,
} from "@mcpjam/sdk/browser";
import {
  useTrafficLogStore,
  extractMethod,
  UiProtocol,
} from "@/stores/traffic-log-store";
import {
  useWidgetDebugStore,
  type WidgetLifecycleEvent,
} from "@/stores/widget-debug-store";
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/client";
import { DEFAULT_HOST_STYLE, getHostStyleOrDefault } from "@/lib/client-styles";
import type { OpenAiAppsCapabilities } from "@/lib/client-styles";
import { isVisibleToModelOnly } from "@/lib/mcp-ui/mcp-apps-utils";
import { LoggingTransport } from "./mcp-apps-logging-transport";
import { McpAppsModal } from "./mcp-apps-modal";
import {
  handleGetFileDownloadUrlMessage,
  handleUploadFileMessage,
} from "./widget-file-messages";
import { CheckoutDialogV2 } from "./checkout-dialog-v2";
import { fetchMcpAppsWidgetContent } from "./fetch-widget-content";
import {
  useAppToolsRegistry,
  type AppToolDescriptor,
} from "./app-tools-registry";
import { readToolResultMeta } from "@/lib/tool-result-utils";
import type { CheckoutSession } from "@/shared/acp-types";
import { listResources, readResource } from "@/lib/apis/mcp-resources-api";
import { listPrompts } from "@/lib/apis/mcp-prompts-api";
import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-client-style-context";
import { useChatboxHostCapabilitiesOverride } from "@/contexts/chatbox-client-capabilities-override-context";
import { useHostContextStore } from "@/stores/client-context-store";
import {
  clampDisplayModeToAvailableModes,
  extractHostDisplayMode,
  extractHostDisplayModes,
  extractHostTheme,
  stableStringifyJson,
} from "@/lib/client-config";
import {
  resolveEffectiveCompatRuntime,
  resolveEffectiveHostCapabilities,
  resolveEffectiveMcpAppsCapabilities,
  resolveHostInfo,
} from "@/lib/client-config-v2";
import type { ResolvedMcpAppsCapabilities } from "@/lib/client-styles";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

// Default input schema for tools without metadata
const DEFAULT_INPUT_SCHEMA = { type: "object" } as const;

const SUPPRESSED_UI_LOG_METHODS = new Set(["ui/notifications/size-changed"]);
const PIP_MAX_HEIGHT = "min(40vh, 600px)";

/**
 * Origins the hosted-mode sandbox clamp must strip from any widget-
 * declared CSP. A hosted widget could otherwise declare an MCPJam
 * origin in `connectDomains` and use the user's authenticated session
 * to exfiltrate data through the iframe. Forwarded into the SDK via
 * `resolveSandboxCsp`'s `hostedClampExtraDeny` — an SDK-internal API
 * for hosted-mode origin stripping, distinct from anything the user can
 * configure (SEP-1865 host policies are allowlist-only).
 *
 * Wildcards cover all subdomains (api, staging, www, etc.) without
 * having to enumerate them. The bare-host entry catches widgets that
 * declare the apex domain directly.
 */
const MCPJAM_HOSTED_CLAMP_ORIGINS: ReadonlyArray<string> = [
  "https://*.mcpjam.com",
  "https://mcpjam.com",
];

type DisplayMode = "inline" | "pip" | "fullscreen";
type HostStyleVariables = NonNullable<
  NonNullable<McpUiHostContext["styles"]>["variables"]
>;

// SEP-1865 fixes the set of style variable keys ui/initialize accepts. Every
// HostStyleDefinition returns McpUiStyles from resolveStyleVariables, so a
// legitimate built-in's key set is exactly the SEP enum; pinning the allowlist
// to it both honors the protocol and strips any extra keys a runtime-registered
// host might smuggle in via `as any`, which the SDK would reject downstream.
const SEP_HOST_STYLE_VARIABLE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_HOST_STYLE.mcp.resolveStyleVariables("light")),
  ...Object.keys(DEFAULT_HOST_STYLE.mcp.resolveStyleVariables("dark")),
]);

function sanitizeHostStyleVariables(
  variables: unknown
): HostStyleVariables | undefined {
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return undefined;
  }

  const sanitized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (!SEP_HOST_STYLE_VARIABLE_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string" || value === undefined) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0
    ? (sanitized as HostStyleVariables)
    : undefined;
}

// CSP and permissions metadata types are now imported from SDK

interface MCPAppsRendererProps {
  chatSessionId?: string;
  serverId: string;
  toolCallId: string;
  toolName: string;
  toolState?: ToolState;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  /**
   * Tool response `_meta`, pre-extracted by the caller from the raw
   * (still-wrapped) tool result. Required because `toolOutput` is
   * typically the *unwrapped* value (e.g. `result.value`), at which
   * point `_meta` from the wrapper is no longer reachable from the
   * value alone. Passing this explicitly preserves Apps SDK's
   * `window.openai.toolResponseMetadata` surface for widgets relying
   * on it (timestamps, source IDs, etc.).
   */
  toolResponseMetadata?: Record<string, unknown> | null;
  toolErrorText?: string;
  resourceUri: string;
  toolMetadata?: Record<string, unknown>;
  /** All tools metadata for visibility checking when widget calls tools */
  toolsMetadata?: Record<string, Record<string, unknown>>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (
    toolName: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  pipWidgetId?: string | null;
  fullscreenWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
  /** Controlled display mode - when provided, component uses this instead of internal state */
  displayMode?: DisplayMode;
  /** Callback when display mode changes - required when displayMode is controlled */
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onRequestFullscreen?: (toolCallId: string) => void;
  onExitFullscreen?: (toolCallId: string) => void;
  /** Callback when widget updates model context (SEP-1865 ui/update-model-context) */
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    }
  ) => void;
  /** Callback when app declares its supported display modes during ui/initialize */
  onAppSupportedDisplayModesChange?: (modes: DisplayMode[] | undefined) => void;
  /**
   * Called when the widget sends `ui/notifications/request-teardown`
   * and the host has agreed to honor it (matrix `requestTeardown !==
   * false`). The renderer has already attempted a graceful
   * `ui/resource-teardown` round-trip; the parent is now expected to
   * unmount this tool call's MCP app surface (e.g. dismiss the modal,
   * collapse the inline view).
   */
  onRequestTeardown?: (toolCallId: string) => void;
  /** Whether the server is offline (for using cached content) */
  isOffline?: boolean;
  /** URL to cached widget HTML for offline rendering */
  cachedWidgetHtmlUrl?: string;
  /**
   * If true, attempt the live MCP Apps fetch first and only fall back to
   * `cachedWidgetHtmlUrl` if the live fetch fails (e.g. the server is no
   * longer connected). Used by in-flow session revisit; persisted offline
   * replay (Views tab, eval traces) leaves this unset so the cached path
   * stays primary.
   */
  liveFetchPreferred?: boolean;
  /** Persisted CSP metadata for cached/offline replay */
  widgetCsp?: McpUiResourceCsp | null;
  /** Persisted permissions metadata for cached/offline replay */
  widgetPermissions?: McpUiResourcePermissions | null;
  /** Persisted permissive flag for cached/offline replay */
  widgetPermissive?: boolean;
  /** Persisted prefersBorder value for cached/offline replay */
  prefersBorder?: boolean;
  /**
   * Persisted compat-runtime flag from a saved view or eval snapshot.
   * When set, the renderer trusts the cached blob as the source of
   * truth for whether `window.openai` was injected at capture time —
   * the live profile's flag is ignored for cached replay because the
   * HTML is byte-frozen. When undefined (no snapshot metadata), the
   * renderer falls back to the resolved live flag for fresh fetches.
   */
  injectedOpenAiCompat?: boolean;
  /**
   * Persisted per-method `window.openai.*` surface that was injected
   * into the cached HTML blob. Threads through the saved-view replay
   * path so the SDK runtime reproduces the same set of methods on
   * `window.openai` that the original capture had, even after the
   * active host config has flipped. Absent for pre-feature snapshots
   * — those replay against the runtime's full ChatGPT surface
   * default (matches behavior at capture time).
   */
  injectedOpenAiCompatCapabilities?: OpenAiAppsCapabilities;
  /**
   * Persisted widget state from a saved view or fork. When set, the
   * compat runtime seeds `window.openai.widgetState` with this value so
   * the widget boots in the same state it was when the view was saved
   * (Apps SDK parity — the legacy ChatGPTAppRenderer wired this the same
   * way).
   */
  initialWidgetState?: unknown;
  /** Minimal mode hides diagnostics and metadata surfaces */
  minimalMode?: boolean;
}

/**
 * Map a `logWidgetDebug` emission to a `WidgetLifecycleEvent` for the
 * Sandbox debug panel, or return `null` for methods we don't track.
 *
 * Constraints:
 *  - We only fan out methods that already exist in the renderer. No
 *    invented events; no synthetic `pending` placeholders. Absence is
 *    semantic — a stage that hasn't fired stays absent from the array.
 *  - Status comes from the method itself (e.g. `*-error` → "error",
 *    `*-ready` / `*-initialized` → "ok", `*-start` / `*-requested` →
 *    "pending").
 *  - The store's `appendLifecycle` setter dedupes consecutive same-
 *    kind same-status entries, so a retry loop doesn't smear the panel.
 */
function mapLogToLifecycle(
  method: string,
  details: Record<string, unknown>
): WidgetLifecycleEvent | null {
  const kindByMethod: Record<string, WidgetLifecycleEvent["kind"]> = {
    "debug/sandbox-proxy-ready": "sandbox-proxy-ready",
    "debug/widget-content-requested": "widget-content-requested",
    "debug/widget-content-ready": "widget-content-ready",
    "debug/widget-content-error": "widget-content-error",
    "debug/widget-content-invalid-mimetype": "widget-content-invalid-mimetype",
    "debug/bridge-connect-start": "bridge-connect-start",
    "debug/bridge-connect-ready": "bridge-connect-ready",
    "debug/bridge-connect-error": "bridge-connect-error",
    "debug/bridge-connect-skipped": "bridge-connect-skipped",
    "debug/app-initialized": "app-initialized",
  };
  const kind = kindByMethod[method];
  if (!kind) return null;
  let status: WidgetLifecycleEvent["status"];
  if (
    method.endsWith("-error") ||
    method === "debug/widget-content-invalid-mimetype"
  ) {
    status = "error";
  } else if (
    method.endsWith("-ready") ||
    method === "debug/app-initialized" ||
    method === "debug/bridge-connect-skipped"
  ) {
    status = "ok";
  } else {
    status = "pending";
  }
  const message =
    typeof details.error === "string"
      ? details.error
      : typeof details.reason === "string"
      ? details.reason
      : undefined;
  return { kind, status, message, timestamp: Date.now() };
}

/**
 * Segments of the fetch-source key, in the same order as the renderer
 * builds it below. Used to describe re-mount reasons for the Sandbox
 * debug panel — e.g. "cachedWidgetHtmlUrl, liveFetchPreferred" when a
 * Convex history snapshot lands.
 */
const FETCH_SOURCE_KEY_SEGMENTS = [
  "toolCallId",
  "resourceUri",
  "cachedWidgetHtmlUrl",
  "cspMode",
  "liveFetchPreferred",
  // `injectOpenAiCompat` boolean and the per-method capability hash
  // are part of the rendering recipe: a host swap from ChatGPT-full
  // to Copilot-subset (or a master-toggle flip) changes the bytes
  // baked into the iframe, so a fetch issued under the old recipe
  // is stale by the time it resolves and must NOT overwrite the
  // newer commit's state. See plan §5.5 +
  // feedback_capability_in_render_recipe memory.
  "injectOpenAiCompat",
  "compatCapabilitiesHash",
  "mcpAppsCapabilitiesHash",
] as const;

function describeFetchSourceKeyDiff(prev: string, next: string): string {
  const prevSegs = prev.split("|");
  const nextSegs = next.split("|");
  const changes: string[] = [];
  for (let i = 0; i < FETCH_SOURCE_KEY_SEGMENTS.length; i += 1) {
    if (prevSegs[i] !== nextSegs[i]) changes.push(FETCH_SOURCE_KEY_SEGMENTS[i]);
  }
  return changes.length === 0 ? "remount" : changes.join(", ");
}

export function MCPAppsRenderer({
  chatSessionId,
  serverId,
  toolCallId,
  toolName,
  toolState,
  toolInput,
  toolOutput,
  toolResponseMetadata,
  toolErrorText,
  resourceUri,
  toolMetadata,
  toolsMetadata,
  onSendFollowUp,
  onCallTool,
  onWidgetStateChange,
  pipWidgetId,
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  displayMode: displayModeProp,
  onDisplayModeChange,
  onRequestFullscreen,
  onExitFullscreen,
  onModelContextUpdate,
  onAppSupportedDisplayModesChange,
  onRequestTeardown,
  isOffline,
  cachedWidgetHtmlUrl,
  liveFetchPreferred,
  widgetCsp: initialWidgetCsp,
  widgetPermissions: initialWidgetPermissions,
  widgetPermissive: initialWidgetPermissive,
  prefersBorder: initialPrefersBorder,
  injectedOpenAiCompat: initialInjectedOpenAiCompat,
  injectedOpenAiCompatCapabilities: initialInjectedOpenAiCompatCapabilities,
  initialWidgetState,
  minimalMode = false,
}: MCPAppsRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sandboxRef = useRef<SandboxedIframeHandle>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const sharedHostStyle = usePreferencesStore((s) => s.hostStyle);
  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const hostCapabilitiesOverride = useChatboxHostCapabilitiesOverride();
  // Active hostConfig.mcpProfile from the surrounding scope (chatbox
  // session, project default, eval suite). Drives the resolver below
  // when set; undefined preserves widget-derived sandbox behavior.
  const activeMcpProfile = useActiveMcpProfile();
  // Resolved compat-runtime flag for the active host. Claude/Cursor/
  // Codex-style hosts leave it off; ChatGPT/Copilot and MCPJam's dev
  // surface enable it. User override on the profile wins. The resolved
  // boolean travels into the widget-content request body and into the
  // renderer's reload-key so toggling the flag forces a refetch instead
  // of silently reusing the old HTML.
  const liveEffectiveCompatRuntime = resolveEffectiveCompatRuntime({
    profile: activeMcpProfile,
    hostStyle: chatboxHostStyle ?? sharedHostStyle,
  });
  const liveInjectOpenAiCompat = liveEffectiveCompatRuntime.injected;
  // Capability surface accompanying `liveInjectOpenAiCompat`. Travels
  // into the widget-content request alongside the boolean so the SDK
  // runtime omits methods that the active host's resolved matrix has
  // disabled (feature-detection truthfulness — see plan §4).
  // Null when injection is off (no surface to advertise).
  const liveOpenAiCompatCapabilities = liveEffectiveCompatRuntime.injected
    ? liveEffectiveCompatRuntime.capabilities
    : null;
  // Cached replay: when a saved view / eval snapshot persisted the
  // flag, trust it (HTML is byte-frozen at capture time). Fall back
  // to the live flag for fresh fetches.
  const effectiveInjectOpenAiCompat =
    typeof initialInjectedOpenAiCompat === "boolean"
      ? initialInjectedOpenAiCompat
      : liveInjectOpenAiCompat;
  const draftHostContext = useHostContextStore((s) => s.draftHostContext);
  const baseHostContext = useMemo(
    () =>
      draftHostContext &&
      typeof draftHostContext === "object" &&
      !Array.isArray(draftHostContext)
        ? draftHostContext
        : {},
    [draftHostContext]
  );

  // Get CSP mode and host style from playground store when in playground
  const isPlaygroundActive = useUIPlaygroundStore((s) => s.isPlaygroundActive);
  const configuredHostTheme = extractHostTheme(baseHostContext);
  const resolvedTheme = isPlaygroundActive
    ? configuredHostTheme ?? chatboxHostTheme ?? themeMode
    : chatboxHostTheme ?? themeMode;
  const playgroundCspMode = useUIPlaygroundStore((s) => s.mcpAppsCspMode);
  // Chatbox surfaces (published runtime, Chatboxes → Preview, Chatboxes →
  // Sessions transcript) default to `permissive`. They are end-user-facing
  // demo surfaces where an incomplete `_meta.ui.csp` declaration on the MCP
  // server would manifest as a blank widget; the friction outweighs the
  // loss of host-side CSP enforcement. Hosts that need strict enforcement
  // can still pin it via the host config's `apps.sandbox.csp` policy,
  // applied per-resource below by `resolveSandboxCsp` regardless of this
  // default.
  //
  // Why isChatboxSurface wins over isPlaygroundActive: the Playground store
  // is persisted to localStorage and shared across browsing contexts on the
  // same origin, including the chatbox runtime iframe rendered inside the
  // Preview tab. If the user has Playground active in the inspector with
  // `mcpAppsCspMode: "widget-declared"`, that selection would otherwise
  // leak into the chatbox preview iframe and render the published runtime
  // under strict CSP — surprising and inconsistent with the published
  // chatbox runtime when opened in a top-level window.
  const isChatboxSurface = useIsChatboxSurface();
  // Surface-derived cspMode: read from the WidgetSurfaceContext set by
  // PlaygroundMain, NOT from `isPlaygroundActive` in the store. The
  // store flag was set in a passive `useEffect`, so descendants
  // observed `false` on the first render and resolved cspMode to
  // "widget-declared"; the effect then flipped it to true, cspMode
  // flipped to playgroundCspMode, the fetch-source key changed, and
  // the iframe was torn down and rebuilt — losing View state. Context
  // propagates synchronously on first render, so cspMode is stable
  // from mount #1. Other readers of `isPlaygroundActive` below keep
  // the store source — those don't gate the iframe-creation-time
  // policy, so the same race is benign for them.
  const widgetSurface = useWidgetSurface();
  const cspMode: CspMode =
    isChatboxSurface || minimalMode
      ? "permissive"
      : widgetSurface === "playground"
      ? playgroundCspMode
      : "widget-declared";

  // Get locale and timeZone from playground store when active, fallback to browser defaults
  const playgroundLocale = useUIPlaygroundStore((s) => s.globals.locale);
  const playgroundTimeZone = useUIPlaygroundStore((s) => s.globals.timeZone);
  const fallbackLocale = isPlaygroundActive
    ? playgroundLocale
    : navigator.language || "en-US";
  const fallbackTimeZone = isPlaygroundActive
    ? playgroundTimeZone
    : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const locale =
    typeof draftHostContext?.locale === "string"
      ? draftHostContext.locale
      : fallbackLocale;
  const timeZone =
    typeof draftHostContext?.timeZone === "string"
      ? draftHostContext.timeZone
      : fallbackTimeZone;

  // Get displayMode from playground store when active (SEP-1865)
  const playgroundDisplayMode = useUIPlaygroundStore((s) => s.displayMode);
  const configuredDisplayMode = useMemo(
    () => extractHostDisplayMode(draftHostContext),
    [draftHostContext]
  );
  const configuredAvailableDisplayModes = useMemo(
    () => extractHostDisplayModes(draftHostContext),
    [draftHostContext]
  );
  // Resolve `effectiveHostStyle` early (it's a 3-way ternary on values
  // already available above) so the SEP-1865 matrix can be computed
  // before the display-mode clamp at `effectiveDisplayMode` below. The
  // duplicate-looking `effectiveHostStyle = ...` further down (around
  // the original `hostStyleDefinition`) reads the same value; both
  // assignments produce identical strings because the dependencies are
  // identical, so the bridge handshake / sandbox composition see the
  // same host style id.
  //
  // Matrix-resolved `availableDisplayModes` is what we advertise in
  // `HostContext.availableDisplayModes` AND what we clamp the
  // current/initial `effectiveDisplayMode` against. Without this
  // earlier clamp, a Copilot-preset host could initialize in (or
  // remain in) `pip` because the parent's `displayMode === "pip"`,
  // while advertising `availableDisplayModes: ["fullscreen"]` —
  // the View would see inconsistent HostContext.
  const earlyEffectiveHostStyle = isPlaygroundActive
    ? sharedHostStyle
    : chatboxHostStyle;
  const earlyEffectiveMcpAppsCapabilities = useMemo(
    () =>
      resolveEffectiveMcpAppsCapabilities({
        profile: activeMcpProfile,
        hostStyle: earlyEffectiveHostStyle,
      }),
    [activeMcpProfile, earlyEffectiveHostStyle]
  );

  // Intersection of the matrix's allowed modes with the playground /
  // draft host context's configured modes — single source of truth for
  // both the runtime clamp at `effectiveDisplayMode` below AND the
  // value advertised in `HostContext.availableDisplayModes`. Computed
  // here (early) so the clamp can use it.
  //
  // Without sharing the intersection between the two consumers, the
  // matrix-only clamp inside `effectiveDisplayMode` could land on
  // `matrix[0]` while `HostContext.availableDisplayModes` advertised a
  // strict subset (the intersection). E.g. matrix=["pip","fullscreen"],
  // configured=["inline","fullscreen"], requested="inline" →
  // matrix-only clamp produced "pip" (matrix[0]) while advertised list
  // was ["fullscreen"]. Fix: clamp against the intersection itself.
  //
  // Fallback to matrix alone when the intersection would be empty —
  // matches the matrix invariant (`length >= 1`) and avoids advertising
  // an unrenderable empty array. `configuredAvailableDisplayModes` is
  // always a non-empty array (see `extractHostDisplayModes` fallbacks)
  // so the only way intersection is empty is when the playground asks
  // for modes the simulated host doesn't advertise.
  // SEP-1865: after `ui/initialize` the view declares
  // `appCapabilities.availableDisplayModes` — the modes it can render in.
  // The host uses this to narrow what it ADVERTISES to the view in
  // `HostContext.availableDisplayModes`, NOT to coerce the current
  // display mode. A widget that only renders in fullscreen (e.g. a
  // canvas-heavy app) is expected to call `ui/request-display-mode`
  // itself after init — the host won't auto-switch the user out of the
  // mode they (or the parent) picked. Coercing here was a real
  // regression: every tool call snapped to fullscreen the moment the
  // widget initialized.
  const [appSupportedDisplayModes, setAppSupportedDisplayModes] = useState<
    DisplayMode[] | undefined
  >(undefined);

  // Host-supported modes only. Drives the current-mode clamp and the
  // `ui/request-display-mode` handler — both of which must stay
  // independent of the app's declaration so the user-visible mode is
  // never auto-coerced.
  const effectiveAvailableDisplayModes = useMemo(() => {
    const matrixModes = earlyEffectiveMcpAppsCapabilities.availableDisplayModes;
    const hostIntersection = matrixModes.filter((m) =>
      configuredAvailableDisplayModes.includes(m as DisplayMode)
    );
    const baseHostModes =
      hostIntersection.length > 0 ? hostIntersection : matrixModes;
    if (!appSupportedDisplayModes || appSupportedDisplayModes.length === 0) {
      return baseHostModes;
    }
    const appIntersection = baseHostModes.filter((m) =>
      appSupportedDisplayModes.includes(m as DisplayMode)
    );
    // SEP-1865: when the intersection is empty (the app advertises modes
    // the host doesn't support at all) we fall back to host-supported
    // rather than advertising nothing — the renderer will still clamp
    // the actual mode to the host's set, and the empty case is a
    // misconfigured app the host can't render anyway.
    return appIntersection.length > 0 ? appIntersection : baseHostModes;
  }, [
    earlyEffectiveMcpAppsCapabilities.availableDisplayModes,
    configuredAvailableDisplayModes,
    appSupportedDisplayModes,
  ]);

  // Advertised intersection — published in `HostContext.availableDisplayModes`
  // so the view knows which modes the host will honor on
  // `requestDisplayMode`. Falls back to host modes when the app
  // declaration is absent or the intersection would be empty
  // (a misconfigured app that doesn't overlap the host shouldn't
  // make the host advertise nothing).
  const advertisedAvailableDisplayModes = useMemo(() => {
    if (!appSupportedDisplayModes || appSupportedDisplayModes.length === 0) {
      return effectiveAvailableDisplayModes;
    }
    const intersection = effectiveAvailableDisplayModes.filter((m) =>
      appSupportedDisplayModes.includes(m as DisplayMode)
    );
    return intersection.length > 0
      ? intersection
      : effectiveAvailableDisplayModes;
  }, [effectiveAvailableDisplayModes, appSupportedDisplayModes]);

  // Get device capabilities from playground store (SEP-1865)
  const playgroundCapabilities = useUIPlaygroundStore((s) => s.capabilities);
  const deviceCapabilities = useMemo(() => {
    const configuredCapabilities =
      draftHostContext?.deviceCapabilities &&
      typeof draftHostContext.deviceCapabilities === "object" &&
      !Array.isArray(draftHostContext.deviceCapabilities)
        ? (draftHostContext.deviceCapabilities as {
            hover?: boolean;
            touch?: boolean;
          })
        : undefined;

    if (configuredCapabilities) {
      return {
        hover: configuredCapabilities.hover ?? true,
        touch: configuredCapabilities.touch ?? false,
      };
    }

    return isPlaygroundActive
      ? playgroundCapabilities
      : { hover: true, touch: false };
  }, [draftHostContext, isPlaygroundActive, playgroundCapabilities]);

  // Get safe area insets from playground store (SEP-1865)
  const playgroundSafeAreaInsets = useUIPlaygroundStore(
    (s) => s.safeAreaInsets
  );
  const safeAreaInsets = useMemo(() => {
    const configuredSafeAreaInsets =
      draftHostContext?.safeAreaInsets &&
      typeof draftHostContext.safeAreaInsets === "object" &&
      !Array.isArray(draftHostContext.safeAreaInsets)
        ? (draftHostContext.safeAreaInsets as {
            top?: number;
            right?: number;
            bottom?: number;
            left?: number;
          })
        : undefined;

    if (configuredSafeAreaInsets) {
      return {
        top: configuredSafeAreaInsets.top ?? 0,
        right: configuredSafeAreaInsets.right ?? 0,
        bottom: configuredSafeAreaInsets.bottom ?? 0,
        left: configuredSafeAreaInsets.left ?? 0,
      };
    }

    return isPlaygroundActive
      ? playgroundSafeAreaInsets
      : { top: 0, right: 0, bottom: 0, left: 0 };
  }, [draftHostContext, isPlaygroundActive, playgroundSafeAreaInsets]);

  // Get device type from playground store for platform derivation (SEP-1865)
  const playgroundDeviceType = useUIPlaygroundStore((s) => s.deviceType);

  // Display mode: controlled (via props) or uncontrolled (internal state)
  const isControlled = displayModeProp !== undefined;
  const [internalDisplayMode, setInternalDisplayMode] = useState<DisplayMode>(
    clampDisplayModeToAvailableModes(
      configuredDisplayMode ??
        (isPlaygroundActive ? playgroundDisplayMode : "inline"),
      configuredAvailableDisplayModes
    )
  );
  const displayMode = isControlled ? displayModeProp : internalDisplayMode;
  const requestedDisplayMode = useMemo<DisplayMode>(() => {
    if (!isControlled) return displayMode;
    if (displayMode === "fullscreen" && fullscreenWidgetId === toolCallId)
      return "fullscreen";
    if (displayMode === "pip" && pipWidgetId === toolCallId) return "pip";
    return "inline";
  }, [displayMode, fullscreenWidgetId, isControlled, pipWidgetId, toolCallId]);
  // Clamp the requested display mode against the same intersection
  // that gets advertised in `HostContext.availableDisplayModes` so
  // the runtime mode is always a member of the advertised set. A
  // Copilot host initializing in `pip` (parent's `displayMode` is
  // sticky from a previous widget) coerces down to `fullscreen`
  // because the intersection resolves to `["fullscreen"]`.
  const effectiveDisplayMode = useMemo<DisplayMode>(
    () =>
      clampDisplayModeToAvailableModes(
        requestedDisplayMode,
        effectiveAvailableDisplayModes
      ),
    [requestedDisplayMode, effectiveAvailableDisplayModes]
  );

  // Clear the sticky inline-preference flag the moment the effective
  // mode moves off "inline" — that transition can only come from the
  // user (close-button paths set the flag true and switch to inline;
  // the widget's `request-display-mode` is gated by the flag). So a
  // non-inline mode means the user has re-opted into fullscreen / PIP
  // via the host's display-mode picker, and the widget should be free
  // to keep its preferred mode again.
  useEffect(() => {
    if (effectiveDisplayMode !== "inline") {
      userPreferInlineRef.current = false;
    }
  }, [effectiveDisplayMode]);
  const setDisplayMode = useCallback(
    (mode: DisplayMode) => {
      if (isControlled) {
        onDisplayModeChange?.(mode);
      } else {
        setInternalDisplayMode(mode);
      }

      // Notify parent about fullscreen state changes regardless of controlled mode
      if (mode === "fullscreen") {
        onRequestFullscreen?.(toolCallId);
      } else if (displayMode === "fullscreen") {
        onExitFullscreen?.(toolCallId);
      }
    },
    [
      isControlled,
      onDisplayModeChange,
      toolCallId,
      onRequestFullscreen,
      onExitFullscreen,
      displayMode,
    ]
  );
  const lastForcedDisplayModeRef = useRef<DisplayMode | null>(null);

  useEffect(() => {
    if (requestedDisplayMode === effectiveDisplayMode) {
      lastForcedDisplayModeRef.current = null;
      return;
    }

    if (lastForcedDisplayModeRef.current === effectiveDisplayMode) {
      return;
    }

    lastForcedDisplayModeRef.current = effectiveDisplayMode;
    setDisplayMode(effectiveDisplayMode);
  }, [effectiveDisplayMode, requestedDisplayMode, setDisplayMode]);

  const [isReady, setIsReady] = useState(false);
  const [reinitCount, setReinitCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [sandboxProxyReady, setSandboxProxyReady] = useState(false);
  const [bridgeTransportReady, setBridgeTransportReady] = useState(false);
  // A cached URL can exist during an in-flow revisit while the renderer still
  // prefers live HTML. Treat only cached-only renders as replay; live compat
  // fetches still need completed tool output baked into window.openai at boot.
  const isCachedReplay = !!cachedWidgetHtmlUrl && !liveFetchPreferred;
  const cachedReplayInjectOpenAiCompat =
    typeof initialInjectedOpenAiCompat === "boolean"
      ? initialInjectedOpenAiCompat
      : null;
  const widgetInjectOpenAiCompatReloadKey = isCachedReplay
    ? cachedReplayInjectOpenAiCompat
    : effectiveInjectOpenAiCompat;
  // Companion reload key carrying the per-method capability surface.
  // The boolean reload key above only catches injection on/off changes;
  // a user flipping the active host from ChatGPT-full to Copilot-subset
  // (or toggling a single method in the matrix) leaves the boolean at
  // `true` but changes the surface the runtime should expose. Folding
  // a stable hash of the capability record into the reload key forces
  // the iframe to refetch on per-method changes too. See
  // feedback_capability_in_render_recipe memory.
  // Cached replays read the hash from PERSISTED capabilities (what the
  // byte-frozen HTML was built against). Critical: this MUST match
  // what `loadFromCachedUrl` later stamps into
  // `loadedCompatCapabilitiesHash` — if the two diverge, the
  // "already loaded" guard at the top of the fetch effect fails on
  // every render, fires a second cached fetch, and that fetch's
  // `setBridgeTransportReady(false)` blanks the iframe out from
  // under an already-connected bridge.
  //
  // Legacy snapshots (no persisted caps) use `null` on both sides so
  // live host per-method changes don't trigger spurious refetches
  // against byte-frozen HTML.
  const widgetCompatCapabilitiesReloadKey = isCachedReplay
    ? initialInjectedOpenAiCompatCapabilities
      ? stableStringifyJson(initialInjectedOpenAiCompatCapabilities)
      : null
    : effectiveInjectOpenAiCompat
    ? stableStringifyJson(liveOpenAiCompatCapabilities ?? null)
    : null;
  // Sibling reload key for the MCP Apps spec-bridge matrix. The OpenAI
  // shim caps above bake into the iframe HTML at fetch time; MCP Apps
  // caps don't, but they drive the `HostCapabilities` blob in
  // `ui/initialize` and gate runtime bridge behavior (e.g. the
  // `widgetDisplayModeRequests` policy and the `userPreferInlineRef`
  // seed). Hashing the resolved record into the reload key forces a
  // remount when the user toggles a row in the matrix, so the new
  // policy takes effect on the live widget without a manual reload.
  // Cached replays use `null` for the same reason the OpenAI sibling
  // does — byte-frozen snapshots shouldn't churn on live host edits.
  const widgetMcpAppsCapabilitiesReloadKey = isCachedReplay
    ? null
    : stableStringifyJson(earlyEffectiveMcpAppsCapabilities);
  // The OpenAI Apps SDK compatibility runtime bakes toolInput/toolOutput into
  // `window.openai` during HTML injection. Pure SEP-1865 views can boot while
  // input is still streaming and receive the final result via
  // ui/notifications/tool-result. Legacy Apps SDK templates declared through
  // `openai/outputTemplate` are different: many read window.openai.toolOutput
  // once on mount, so they still need the completed output before boot.
  const requiresCompatOutputAtBoot =
    effectiveInjectOpenAiCompat &&
    typeof toolMetadata?.["openai/outputTemplate"] === "string";
  const shouldWaitForCompatToolOutput =
    !isCachedReplay &&
    requiresCompatOutputAtBoot &&
    toolState !== "output-available";
  const [widgetCsp, setWidgetCsp] = useState<McpUiResourceCsp | undefined>(
    isCachedReplay ? undefined : initialWidgetCsp ?? undefined
  );
  const [widgetPermissions, setWidgetPermissions] = useState<
    McpUiResourcePermissions | undefined
  >(isCachedReplay ? undefined : initialWidgetPermissions ?? undefined);
  const [widgetPermissive, setWidgetPermissive] = useState<boolean>(
    isCachedReplay ? true : initialWidgetPermissive ?? false
  );
  const [prefersBorder, setPrefersBorder] = useState<boolean>(
    initialPrefersBorder ?? true
  );
  // PR D matrix-gated resource-meta interpretation. The matrix
  // dimensions `cspFrameDomains`, `cspBaseUriDomains`,
  // `sandboxPermissions`, and `resourcePrefersBorder` model whether
  // the simulated host HONORS the corresponding resource `_meta.ui`
  // fields. Microsoft 365 Copilot's published Component-bridge table
  // marks all four as ❌; on a simulated Copilot host these fields
  // are silently ignored even when a widget declares them.
  //
  // We post-process the resource's `widgetCsp` / `widgetPermissions`
  // / `prefersBorder` after fetch — the SDK's `resolveSandboxCsp` /
  // `resolveSandboxPermissions` and the renderer's iframe-chrome
  // logic all read these gated values transparently. Per the
  // foundation plan's D3 decision, no SDK API change.
  const matrixGatedWidgetCsp = useMemo<McpUiResourceCsp | undefined>(() => {
    if (!widgetCsp) return widgetCsp;
    const m = earlyEffectiveMcpAppsCapabilities;
    if (m.cspFrameDomains && m.cspBaseUriDomains) return widgetCsp;
    // Spread + selectively strip the gated sub-fields. Connect /
    // resource domains are NOT matrix-gated today (no host's
    // published table tracks them at this granularity); only frame
    // and baseUri are.
    const next: McpUiResourceCsp = { ...widgetCsp };
    if (!m.cspFrameDomains) delete next.frameDomains;
    if (!m.cspBaseUriDomains) delete next.baseUriDomains;
    return next;
  }, [widgetCsp, earlyEffectiveMcpAppsCapabilities]);
  const matrixGatedWidgetPermissions = useMemo<
    McpUiResourcePermissions | undefined
  >(() => {
    // `sandboxPermissions: false` means the simulated host doesn't
    // honor the resource's permissions declarations AT ALL — return
    // undefined so the downstream resolver behaves as if the widget
    // declared no permissions. Spec-compliant simulation: the
    // widget asked for the camera, the host doesn't grant it.
    if (!earlyEffectiveMcpAppsCapabilities.sandboxPermissions) return undefined;
    return widgetPermissions;
  }, [widgetPermissions, earlyEffectiveMcpAppsCapabilities.sandboxPermissions]);
  const matrixGatedPrefersBorder = useMemo(() => {
    // `resourcePrefersBorder: false` means the simulated host
    // ignores the resource's `_meta.ui.prefersBorder` hint. Iframe
    // chrome falls back to host-default rendering (no border) for
    // every widget on that host.
    if (!earlyEffectiveMcpAppsCapabilities.resourcePrefersBorder) return false;
    return prefersBorder;
  }, [prefersBorder, earlyEffectiveMcpAppsCapabilities.resourcePrefersBorder]);
  const [loadedCspMode, setLoadedCspMode] = useState<CspMode | null>(null);
  // Reload-key sibling to `loadedCspMode`: tracks the compat-runtime
  // flag the currently-loaded HTML was fetched with. Toggling the live
  // flag must force a refetch, otherwise the short-circuit at the top
  // of the fetch effect would silently reuse already-shimmed (or
  // already-non-shimmed) HTML. Set to the effective flag in both the
  // cached and the live branches. Cached replays use the persisted
  // provenance flag as the reload key; legacy cached blobs without that
  // metadata use `null` so live host toggles don't rewrite byte-frozen
  // HTML provenance.
  const [loadedInjectOpenAiCompat, setLoadedInjectOpenAiCompat] = useState<
    boolean | null
  >(null);
  // Sibling of `loadedInjectOpenAiCompat`: tracks the stable hash of
  // the per-method capability surface the currently-loaded HTML was
  // fetched with. Set to `null` for legacy cached replays (no persisted
  // capability provenance) so live host toggles don't churn the iframe
  // on byte-frozen snapshots. Compared against
  // `widgetCompatCapabilitiesReloadKey` to detect per-method surface
  // changes that the boolean key would miss.
  const [loadedCompatCapabilitiesHash, setLoadedCompatCapabilitiesHash] =
    useState<string | null>(null);
  // Sibling of `loadedCompatCapabilitiesHash` for the MCP Apps
  // spec-bridge matrix. Tracks the resolved-caps hash the iframe was
  // last initialized against so a matrix toggle (e.g.
  // `widgetDisplayModeRequests`) forces a remount on the next render.
  const [loadedMcpAppsCapabilitiesHash, setLoadedMcpAppsCapabilitiesHash] =
    useState<string | null>(null);
  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalParams, setModalParams] = useState<Record<string, unknown>>({});
  const [modalTitle, setModalTitle] = useState("");
  const [modalTemplate, setModalTemplate] = useState<string | null>(null);

  // Checkout state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutSession, setCheckoutSession] =
    useState<CheckoutSession | null>(null);
  const [checkoutCallId, setCheckoutCallId] = useState<number | null>(null);

  // Reset widget HTML when cachedWidgetHtmlUrl changes (e.g., different view selected)
  useEffect(() => {
    setWidgetHtml(null);
    setBridgeTransportReady(false);
    setLoadedCspMode(null);
    setLoadedInjectOpenAiCompat(null);
    setLoadedCompatCapabilitiesHash(null);
    setLoadError(null);
    setWidgetCsp(isCachedReplay ? undefined : initialWidgetCsp ?? undefined);
    setWidgetPermissions(
      isCachedReplay ? undefined : initialWidgetPermissions ?? undefined
    );
    setWidgetPermissive(
      isCachedReplay ? true : initialWidgetPermissive ?? false
    );
    setPrefersBorder(initialPrefersBorder ?? true);
  }, [
    cachedWidgetHtmlUrl,
    isCachedReplay,
    initialWidgetCsp,
    initialWidgetPermissions,
    initialWidgetPermissive,
    initialPrefersBorder,
  ]);

  const bridgeRef = useRef<AppBridge | null>(null);
  const hostContextRef = useRef<McpUiHostContext | null>(null);
  const isReadyRef = useRef(false);
  const lastInlineHeightRef = useRef<string>("400px");
  // Sticky flag set when the user explicitly returned to inline (X
  // click in fullscreen / PIP). While set, widget-driven
  // `ui/request-display-mode` requests for non-inline modes are
  // declined. Cleared whenever the user explicitly picks a non-inline
  // mode again (display-mode picker). Without this, widgets that
  // re-request their preferred mode on every `host-context-changed`
  // can trap the user in a mode they just dismissed.
  //
  // Seeded from the `widgetDisplayModeRequests` host policy so the
  // `"user-initiated-only"` mode kicks in from the first mount: a widget
  // that requests fullscreen on init is treated the same as one
  // re-requesting it after the user dismissed once.
  const userPreferInlineRef = useRef(
    earlyEffectiveMcpAppsCapabilities.widgetDisplayModeRequests ===
      "user-initiated-only"
  );
  // SEP-1865 host UX: one-shot guard for the app-tools auto-promote to
  // `displayMode = "fullscreen"`. When the inline bridge reports
  // `appCapabilities.tools` in `ui/initialize`, the renderer flips the
  // widget to fullscreen so the existing fullscreen overlay (composer
  // pinned + chevron-toggle chat history) mounts — the dev gets a
  // chat-with-app surface without manual mode switching. Gated by
  // `userPreferInlineRef` (auto-promote is treated as host-initiated
  // and respects the same dismissal + `user-initiated-only` policy
  // that blocks widget-initiated `ui/request-display-mode`). One-shot
  // so a shim re-init or a widget's own re-handshake doesn't fire
  // again. Refs reset across renderer instances, so teardown + a new
  // tool-call mount re-arms the promote — a fresh chat with the same
  // app gets the same affordance.
  const hasAutoPromotedForAppToolsRef = useRef(false);
  // SEP-1865: width is honored only when the host's outer container is
  // unbounded (no `width` from `containerDimensions`). The chatbox bubble
  // is the bounding box today, so this stays null until the app sends a
  // width request. The renderer applies the value to the visible inline
  // container and caps it with max-width: 100%.
  const lastInlineWidthRef = useRef<string | null>(null);

  // SEP-1865 App-Provided Tools: per-bridge identity used to register and
  // unregister this iframe's tools in `useAppToolsRegistry`.
  const appToolsBridgeIdRef = useRef<string | null>(null);
  const appToolsListedBridgeIdsRef = useRef<Set<string>>(new Set());
  const appToolsListInFlightBridgeIdsRef = useRef<Set<string>>(new Set());
  const appToolsListRefreshPendingBridgeIdsRef = useRef<Set<string>>(
    new Set()
  );
  // Reactive mirror of `appToolsBridgeIdRef` so the in-flight busy
  // indicator can subscribe to `useAppToolsRegistry.pendingControllers`
  // by bridge id. Refs alone don't trigger re-renders.
  const [appToolsBridgeIdState, setAppToolsBridgeIdState] = useState<
    string | null
  >(null);
  const pendingAppToolCalls = useAppToolsRegistry((s) =>
    appToolsBridgeIdState
      ? (s.pendingControllers.get(appToolsBridgeIdState)?.size ?? 0)
      : 0
  );

  // Reset widget-identity-scoped state when the renderer is reused for a
  // different tool call / resource / widget bundle. Without this the next
  // widget inherits the previous widget's intersected display modes, its
  // narrowed inline width, and (if the user had dismissed to inline) its
  // sticky inline preference. Also re-seeds the sticky flag from the
  // current `widgetDisplayModeRequests` policy so flipping the Apps tab
  // tri-state on an already-mounted renderer takes effect on the next
  // identity change instead of waiting for an unmount.
  useEffect(() => {
    setAppSupportedDisplayModes(undefined);
    lastInlineWidthRef.current = null;
    userPreferInlineRef.current =
      earlyEffectiveMcpAppsCapabilities.widgetDisplayModeRequests ===
      "user-initiated-only";
  }, [
    toolCallId,
    resourceUri,
    cachedWidgetHtmlUrl,
    earlyEffectiveMcpAppsCapabilities.widgetDisplayModeRequests,
  ]);

  const onSendFollowUpRef = useRef(onSendFollowUp);
  const onCallToolRef = useRef(onCallTool);
  const onRequestPipRef = useRef(onRequestPip);
  const onExitPipRef = useRef(onExitPip);
  const onRequestTeardownRef = useRef(onRequestTeardown);
  const setDisplayModeRef = useRef(setDisplayMode);
  const isPlaygroundActiveRef = useRef(isPlaygroundActive);
  const playgroundDeviceTypeRef = useRef(playgroundDeviceType);
  const effectiveDisplayModeRef = useRef(effectiveDisplayMode);
  const serverIdRef = useRef(serverId);
  const toolCallIdRef = useRef(toolCallId);
  const pipWidgetIdRef = useRef(pipWidgetId);
  const toolsMetadataRef = useRef(toolsMetadata);
  const onModelContextUpdateRef = useRef(onModelContextUpdate);
  const onAppSupportedDisplayModesChangeRef = useRef(
    onAppSupportedDisplayModesChange
  );

  // Refs for values consumed inside the async fetchWidgetHtml function.
  // These change reference on every streaming chunk (AI SDK recreates part objects),
  // but we don't want to re-trigger the fetch effect for reference-only changes.
  const toolInputRef = useRef(toolInput);
  toolInputRef.current = toolInput;
  const toolOutputRef = useRef(toolOutput);
  toolOutputRef.current = toolOutput;
  const themeModeRef = useRef(themeMode);

  // Source-identity guard for the async fetch effect. The renderer can be
  // reused across session swaps and prop changes, so an older fetch can
  // resolve after `{ toolCallId, resourceUri, cachedWidgetHtmlUrl, cspMode,
  // liveFetchPreferred }` has moved on. Each effect run sets this ref to
  // its own key; the helpers below drop any state writes that don't still
  // match the latest key.
  const latestFetchSourceKeyRef = useRef<string>("");
  /**
   * Previous fetch-source key, kept for the debug-panel mount log. We
   * can't reuse `latestFetchSourceKeyRef` because it's bumped before the
   * fetch starts; this one only advances after the mount has been
   * recorded so the diff is always prev→current.
   */
  const prevLoggedFetchSourceKeyRef = useRef<string | null>(null);
  // Bound before the fetch effect below references it in its deps array —
  // the other widget-debug-store bindings live further down because they
  // only fire from async callbacks, but `recordMountStore` is called
  // synchronously inside the effect body, so it has to be in scope here.
  const recordMountStore = useWidgetDebugStore((s) => s.recordMount);

  // SEP-1865 MCP Apps spec-bridge matrix ref. Populated further down
  // in the render (after `effectiveHostStyle` / `activeMcpProfile`
  // resolve), but declared here so `useToolInputStreaming` below can
  // read it without forward-reference issues. Null reads as "default
  // on" — matches pre-matrix behavior during the brief initial-mount
  // window before the matrix resolver runs.
  const mcpAppsCapabilitiesRef = useRef<ResolvedMcpAppsCapabilities | null>(
    null
  );

  const {
    canRenderStreamingInput,
    signalStreamingRender,
    resetStreamingState,
  } = useToolInputStreaming({
    bridgeRef,
    isReady,
    isReadyRef,
    toolState,
    toolInput,
    toolOutput,
    toolErrorText,
    toolCallId,
    reinitCount,
    mcpAppsCapabilitiesRef,
  });
  const hasWidgetHtml = widgetHtml !== null;
  const widgetHtmlLength = widgetHtml?.length ?? 0;

  // Fetch widget HTML when tool is active (streaming, input ready, or output available) or CSP mode changes
  useEffect(() => {
    const isActiveToolState =
      toolState === "input-streaming" ||
      toolState === "input-available" ||
      toolState === "output-available";
    if (!isActiveToolState) return;
    if (shouldWaitForCompatToolOutput) return;
    // Re-fetch if CSP mode changed (widget needs to reload with new CSP
    // policy) OR if the compat-runtime flag changed (HTML needs to be
    // rebuilt with/without the `window.openai` shim). Both belong in
    // the reload key — silently keeping HTML across a flag flip would
    // leave the wrong shape baked into the bytes.
    if (
      widgetHtml &&
      loadedCspMode === cspMode &&
      loadedInjectOpenAiCompat === widgetInjectOpenAiCompatReloadKey &&
      loadedCompatCapabilitiesHash === widgetCompatCapabilitiesReloadKey &&
      loadedMcpAppsCapabilitiesHash === widgetMcpAppsCapabilitiesReloadKey
    )
      return;

    // Source-identity key for this run. Any in-flight fetch whose key no
    // longer matches `latestFetchSourceKeyRef.current` when it resolves is
    // stale and MUST NOT mutate state.
    const fetchSourceKey = [
      toolCallId,
      resourceUri ?? "",
      cachedWidgetHtmlUrl ?? "",
      cspMode,
      liveFetchPreferred ? "live-pref" : "",
      // String() so `null` (cached-replay sentinel), `true`, and
      // `false` all serialize distinctly into the pipe-joined key.
      String(widgetInjectOpenAiCompatReloadKey),
      widgetCompatCapabilitiesReloadKey ?? "",
      widgetMcpAppsCapabilitiesReloadKey ?? "",
    ].join("|");
    latestFetchSourceKeyRef.current = fetchSourceKey;
    // Mount log for the Sandbox debug panel. Record one entry per real
    // key change (not per effect re-run) so devs can spot self-induced
    // reloads — e.g. a Convex history snapshot landing and flipping
    // `cachedWidgetHtmlUrl`/`liveFetchPreferred` mid-session, which
    // remounts the iframe and visually wipes the previous render.
    if (prevLoggedFetchSourceKeyRef.current !== fetchSourceKey) {
      const prev = prevLoggedFetchSourceKeyRef.current;
      const reason =
        prev === null
          ? "initial"
          : describeFetchSourceKeyDiff(prev, fetchSourceKey);
      prevLoggedFetchSourceKeyRef.current = fetchSourceKey;
      recordMountStore(toolCallId, reason);
    }
    const isStillCurrent = () =>
      latestFetchSourceKeyRef.current === fetchSourceKey;

    // Throws on failure. Caller is responsible for surfacing the error.
    const loadFromCachedUrl = async (cachedUrl: string) => {
      const cachedResponse = await fetch(cachedUrl);
      if (!cachedResponse.ok) {
        throw new Error(
          `Failed to fetch cached widget HTML: ${cachedResponse.statusText}`
        );
      }
      const html = await cachedResponse.text();
      if (!isStillCurrent()) return;
      // Reset readiness so the previous bridge's transport doesn't
      // get reused with the new HTML before its connect resolves.
      setBridgeTransportReady(false);
      setWidgetHtml(html);
      setWidgetCsp(undefined);
      setWidgetPermissions(undefined);
      setWidgetPermissive(true);
      setPrefersBorder(initialPrefersBorder ?? true);
      setLoadedCspMode(cspMode);
      // Cached replay: HTML is byte-frozen at capture time. Trust persisted
      // provenance when available; otherwise keep it unknown instead of
      // inferring from the current live host. When this is the fallback path
      // after a preferred live fetch failed, mark the loaded fallback as
      // satisfying the current reload key so the effect doesn't immediately
      // retry live and overwrite the cached render.
      const loadedCachedCompatKey = isCachedReplay
        ? cachedReplayInjectOpenAiCompat
        : widgetInjectOpenAiCompatReloadKey;
      setLoadedInjectOpenAiCompat(loadedCachedCompatKey);
      // `widgetCompatCapabilitiesReloadKey` already encodes the right
      // value for both branches: cached replays compute it from the
      // persisted `initialInjectedOpenAiCompatCapabilities` (matches
      // the byte-frozen HTML), live fetches compute it from the
      // resolver. Stamp it verbatim so the fetch effect's
      // "already loaded" guard passes — earlier divergence between
      // this stamp and the reload key triggered a second cached
      // fetch that called `setBridgeTransportReady(false)` after the
      // bridge had already connected.
      setLoadedCompatCapabilitiesHash(widgetCompatCapabilitiesReloadKey);
      // MCP Apps caps don't bake into byte-frozen HTML; cached replays
      // stamp `null` (matching the reload key's cached-replay sentinel)
      // so live host edits don't churn the snapshot.
      setLoadedMcpAppsCapabilitiesHash(widgetMcpAppsCapabilitiesReloadKey);
      setWidgetHtmlStore(
        toolCallId,
        html,
        loadedCachedCompatKey ?? undefined,
        // Persisted capabilities flow into the debug store so a
        // "save view" round-trip from a cached replay (e.g. user
        // duplicates an old view) carries the original surface
        // forward instead of stamping the current live matrix.
        isCachedReplay
          ? initialInjectedOpenAiCompatCapabilities
          : liveOpenAiCompatCapabilities ?? undefined
      );
      logWidgetDebug("host-to-ui", "debug/widget-content-ready", {
        cached: true,
        cspMode,
        htmlLength: html.length,
        injectOpenAiCompat: loadedCachedCompatKey,
        permissive: true,
      });
    };

    // Throws on failure. Returns true on success, false if the server
    // returned an invalid mimetype (which is a content error — caller
    // should surface it and NOT fall back to a cached blob).
    const loadFromLiveFetch = async (): Promise<boolean> => {
      const {
        html,
        csp,
        permissions,
        permissive,
        mimeTypeWarning: warning,
        mimeTypeValid: valid,
        prefersBorder,
        injectedOpenAiCompat: serverInjectedOpenAiCompat,
        injectedOpenAiCompatCapabilities:
          serverInjectedOpenAiCompatCapabilities,
      } = await fetchMcpAppsWidgetContent({
        serverId,
        resourceUri,
        toolInput: toolInputRef.current,
        toolOutput: toolOutputRef.current,
        // Surface `_meta` from the tool response so the compat runtime
        // can expose it as `window.openai.toolResponseMetadata`. Prefer
        // the explicit `toolResponseMetadata` prop (which the caller
        // computes from rawOutput where the `{ value, _meta }` wrapper
        // is still intact); fall back to deriving from the resolved
        // output for callers that don't pass it.
        toolResponseMetadata:
          toolResponseMetadata ??
          readToolResultMeta(toolOutputRef.current) ??
          null,
        initialWidgetState,
        toolId: toolCallId,
        toolName,
        theme: themeModeRef.current,
        cspMode,
        injectOpenAiCompat: effectiveInjectOpenAiCompat,
        // Per-method capability surface forwarded to the SDK runtime.
        // Sending this alongside `injectOpenAiCompat: true` is what
        // makes disabled methods omitted from `window.openai` in the
        // widget — without it, the runtime falls back to its full
        // surface default and feature detection lies. Send only when
        // we're actually injecting (capabilities are meaningless
        // without the shim).
        openAiCompatCapabilities:
          effectiveInjectOpenAiCompat && liveOpenAiCompatCapabilities
            ? liveOpenAiCompatCapabilities
            : undefined,
      });
      const resolvedInjectedOpenAiCompat =
        typeof serverInjectedOpenAiCompat === "boolean"
          ? serverInjectedOpenAiCompat
          : effectiveInjectOpenAiCompat;
      // Server echoes the resolved capability surface (per plan §6.5)
      // so the renderer doesn't need to re-resolve to know exactly
      // what was baked into the HTML. Falls back to the live caps the
      // request sent — covers older servers that don't echo yet.
      const resolvedInjectedOpenAiCompatCapabilities =
        serverInjectedOpenAiCompatCapabilities ??
        (resolvedInjectedOpenAiCompat
          ? liveOpenAiCompatCapabilities ?? undefined
          : undefined);

      // Stale fetch: source key moved on (e.g. session swap, CSP toggle,
      // tool call change) while this request was in flight. Drop the
      // result so it can't overwrite the newer commit's state.
      if (!isStillCurrent()) return true;

      if (!valid) {
        const errorMessage =
          warning ||
          `Invalid mimetype - SEP-1865 requires "text/html;profile=mcp-app"`;
        setLoadError(errorMessage);
        logWidgetDebug("host-to-ui", "debug/widget-content-invalid-mimetype", {
          cspMode,
          error: errorMessage,
        });
        return false;
      }

      // Reset readiness so the previous bridge's transport doesn't get
      // reused with the new HTML before its connect resolves.
      setBridgeTransportReady(false);
      setWidgetHtml(html);
      setWidgetCsp(csp);
      setWidgetPermissions(permissions);
      setWidgetPermissive(permissive ?? false);
      setPrefersBorder(prefersBorder ?? true);
      setLoadedCspMode(cspMode);
      setLoadedInjectOpenAiCompat(resolvedInjectedOpenAiCompat);
      // Capability hash for the fetched HTML — pair with the boolean
      // so future per-method changes detect this snapshot as stale and
      // force a refetch.
      setLoadedCompatCapabilitiesHash(widgetCompatCapabilitiesReloadKey);
      // Sibling stamp for the MCP Apps spec-bridge matrix.
      setLoadedMcpAppsCapabilitiesHash(widgetMcpAppsCapabilitiesReloadKey);

      // Store widget HTML in debug store for save view feature. Stamp the
      // resolved flag + per-method capability surface alongside it so
      // saved views and eval snapshots can persist what was actually
      // injected at fetch time. Replay reads both back when reproducing
      // the original render.
      setWidgetHtmlStore(
        toolCallId,
        html,
        resolvedInjectedOpenAiCompat,
        resolvedInjectedOpenAiCompatCapabilities
      );

      // Update the widget debug store with CSP and permissions info
      if (csp || permissions || !permissive) {
        setWidgetCspStore(toolCallId, {
          mode: permissive ? "permissive" : "widget-declared",
          connectDomains: csp?.connectDomains || [],
          resourceDomains: csp?.resourceDomains || [],
          frameDomains: csp?.frameDomains || [],
          baseUriDomains: csp?.baseUriDomains || [],
          permissions: permissions,
          widgetDeclared: csp
            ? {
                connectDomains: csp.connectDomains,
                resourceDomains: csp.resourceDomains,
                frameDomains: csp.frameDomains,
                baseUriDomains: csp.baseUriDomains,
              }
            : null,
        });
      }
      logWidgetDebug("host-to-ui", "debug/widget-content-ready", {
        cached: false,
        cspMode,
        hasCsp: !!csp,
        hasPermissions: !!permissions,
        htmlLength: html.length,
        injectOpenAiCompat: resolvedInjectedOpenAiCompat,
        permissive: permissive ?? false,
        prefersBorder: prefersBorder ?? true,
      });
      return true;
    };

    const fetchWidgetHtml = async () => {
      try {
        logWidgetDebug("host-to-ui", "debug/widget-content-requested", {
          cachedWidgetHtmlUrl: cachedWidgetHtmlUrl ?? null,
          cspMode,
          isOffline: !!isOffline,
          liveFetchPreferred: !!liveFetchPreferred,
          resourceUri,
          toolState: toolState ?? null,
        });

        // In-flow session revisit: try the live MCP Apps fetch first so the
        // widget re-renders against the active host's current CSP / bridge
        // state. If the server is no longer connected (or live fetch fails
        // for any reason), fall back to the cached snapshot HTML.
        if (liveFetchPreferred && cachedWidgetHtmlUrl) {
          try {
            await loadFromLiveFetch();
            return;
          } catch (liveErr) {
            logWidgetDebug("host-to-ui", "debug/widget-content-live-fallback", {
              error:
                liveErr instanceof Error ? liveErr.message : String(liveErr),
            });
            await loadFromCachedUrl(cachedWidgetHtmlUrl);
            return;
          }
        }

        // Persisted offline replay (Views tab, eval traces, openai-apps
        // revisit): cached HTML is the only source.
        if (cachedWidgetHtmlUrl) {
          await loadFromCachedUrl(cachedWidgetHtmlUrl);
          return;
        }

        // If server is offline and no cached HTML, show helpful error
        if (isOffline) {
          const errorMessage =
            "Server is offline and this view was saved without cached HTML. " +
            "Connect the server and re-save the view to enable offline rendering.";
          setLoadError(errorMessage);
          logWidgetDebug("host-to-ui", "debug/widget-content-error", {
            error: errorMessage,
          });
          return;
        }

        await loadFromLiveFetch();
      } catch (err) {
        if (!isStillCurrent()) return;
        const errorMessage =
          err instanceof Error ? err.message : "Failed to prepare widget";
        setLoadError(errorMessage);
        logWidgetDebug("host-to-ui", "debug/widget-content-error", {
          error: errorMessage,
        });
      }
    };

    fetchWidgetHtml();
    // logWidgetDebug is intentionally omitted: it has stable identity (reads
    // serverId/toolCallId via refs) and is declared after this effect.
  }, [
    toolState,
    toolCallId,
    widgetHtml,
    loadedCspMode,
    loadedInjectOpenAiCompat,
    widgetInjectOpenAiCompatReloadKey,
    loadedCompatCapabilitiesHash,
    widgetCompatCapabilitiesReloadKey,
    loadedMcpAppsCapabilitiesHash,
    widgetMcpAppsCapabilitiesReloadKey,
    effectiveInjectOpenAiCompat,
    liveOpenAiCompatCapabilities,
    serverId,
    resourceUri,
    toolName,
    cspMode,
    isOffline,
    cachedWidgetHtmlUrl,
    liveFetchPreferred,
    initialPrefersBorder,
    cachedReplayInjectOpenAiCompat,
    initialInjectedOpenAiCompatCapabilities,
    shouldWaitForCompatToolOutput,
    recordMountStore,
  ]);

  // UI logging
  const addUiLog = useTrafficLogStore((s) => s.addLog);
  const logUiEvent = useCallback(
    (payload: Parameters<typeof addUiLog>[0]) => {
      if (minimalMode) return;
      addUiLog(payload);
    },
    [addUiLog, minimalMode]
  );
  const logUiEventRef = useRef(logUiEvent);
  logUiEventRef.current = logUiEvent;
  // Stable identity so this can be safely included in any effect deps without
  // causing reruns. Reads serverId/toolCallId from refs that are kept current
  // by the ref-sync effect below.
  const logWidgetDebug = useCallback(
    (
      direction: "host-to-ui" | "ui-to-host",
      method: string,
      details: Record<string, unknown>
    ) => {
      logUiEventRef.current({
        widgetId: toolCallIdRef.current,
        serverId: serverIdRef.current,
        direction,
        protocol: "mcp-apps",
        method,
        message: details,
      });
      // Also mirror this event into the widget-debug-store's lifecycle
      // array when the method matches one of our tracked stages. This is
      // the Sandbox debug panel's source of truth for "how far did the
      // widget get before something went wrong" — driven by the renderer's
      // existing log emissions so we never invent events.
      const mapped = mapLogToLifecycle(method, details);
      if (mapped !== null) {
        const toolCallId = toolCallIdRef.current;
        if (toolCallId) appendLifecycleRef.current(toolCallId, mapped);
      }
    },
    []
  );

  const refreshAppProvidedTools = useCallback(
    async (
      bridge: AppBridge,
      bridgeId: string,
      options: {
        force?: boolean;
        // SEP-1865 App-Provided Tools: the modal mounts a second
        // AppBridge against its own iframe, so callers (mcp-apps-modal)
        // pass `surface: "modal"`, their own `getIframeElement`, and an
        // `isLive` predicate tied to their own bridge-id ref. Inline
        // callers omit them and get the historical inline behavior.
        surface?: "inline" | "modal";
        getIframeElement?: () => HTMLIFrameElement | null;
        isLive?: () => boolean;
      } = {}
    ) => {
      const surface = options.surface ?? "inline";
      const getIframeElement =
        options.getIframeElement ??
        (() => sandboxRef.current?.getIframeElement() ?? null);
      const isLive =
        options.isLive ?? (() => appToolsBridgeIdRef.current === bridgeId);

      const alreadyListed = appToolsListedBridgeIdsRef.current.has(bridgeId);
      const inFlight = appToolsListInFlightBridgeIdsRef.current.has(bridgeId);
      if (inFlight) {
        if (options.force) {
          appToolsListRefreshPendingBridgeIdsRef.current.add(bridgeId);
        }
        return;
      }
      if (!options.force && alreadyListed) return;

      appToolsListInFlightBridgeIdsRef.current.add(bridgeId);
      try {
        let needsRefresh = true;
        while (needsRefresh) {
          appToolsListRefreshPendingBridgeIdsRef.current.delete(bridgeId);
          const tools: AppToolDescriptor[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 8; page += 1) {
            const result = await bridge.listTools(
              cursor === undefined ? {} : { cursor }
            );
            tools.push(
              ...(result.tools ?? []).filter(
                (t): t is AppToolDescriptor =>
                  Boolean(
                    t && typeof t.name === "string" && t.name.length > 0
                  )
              )
            );
            cursor = result.nextCursor;
            if (!cursor) break;
          }

          appToolsListedBridgeIdsRef.current.add(bridgeId);
          // `listTools()` crosses the iframe boundary. If the caller
          // unmounted or rebuilt while it was pending, the live ref has
          // been cleared and any late registration would leak stale
          // aliases.
          if (!isLive()) return;

          const appVersion = bridge.getAppVersion();
          await useAppToolsRegistry.getState().registerInstance({
            bridgeId,
            chatSessionId,
            parentToolCallId: toolCallIdRef.current,
            serverId: serverIdRef.current,
            appName: appVersion?.name ?? serverIdRef.current,
            appVersion: appVersion?.version,
            surface,
            bridge,
            tools,
            registeredAtMs: Date.now(),
            // Stable closure: the inline default reads `sandboxRef.current`
            // which is React-managed and tracks the live SandboxedIframe
            // across re-renders. The modal passes its own accessor against
            // `modalSandboxRef`.
            getIframeElement,
          });
          if (!isLive()) {
            useAppToolsRegistry.getState().unregisterInstance(bridgeId);
            return;
          }
          needsRefresh =
            appToolsListRefreshPendingBridgeIdsRef.current.has(bridgeId);
        }
      } catch (err) {
        appToolsListedBridgeIdsRef.current.delete(bridgeId);
        logWidgetDebug("ui-to-host", "debug/app-tools-list-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        appToolsListInFlightBridgeIdsRef.current.delete(bridgeId);
      }
    },
    [chatSessionId, logWidgetDebug]
  );

  // Widget debug store
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);
  const setWidgetStateStore = useWidgetDebugStore((s) => s.setWidgetState);
  const setWidgetCspStore = useWidgetDebugStore((s) => s.setWidgetCsp);
  const addCspViolation = useWidgetDebugStore((s) => s.addCspViolation);
  const clearCspViolations = useWidgetDebugStore((s) => s.clearCspViolations);
  const setWidgetModelContext = useWidgetDebugStore(
    (s) => s.setWidgetModelContext
  );
  const setWidgetHtmlStore = useWidgetDebugStore((s) => s.setWidgetHtml);
  const setSandboxAppliedStore = useWidgetDebugStore(
    (s) => s.setSandboxApplied
  );
  const appendLifecycleStore = useWidgetDebugStore((s) => s.appendLifecycle);
  // Ref-route the lifecycle setter so logWidgetDebug stays stable-identity
  // without listing the store setter in its deps (matches the logUiEvent
  // pattern above).
  const appendLifecycleRef = useRef(appendLifecycleStore);
  appendLifecycleRef.current = appendLifecycleStore;

  // Clear CSP violations when CSP mode OR compat flag changes (stale
  // data from previous load — both reload-key axes trigger a refetch
  // so violation history from the prior bytes is no longer relevant).
  useEffect(() => {
    if (loadedCspMode !== null && loadedCspMode !== cspMode) {
      clearCspViolations(toolCallId);
    }
  }, [cspMode, loadedCspMode, toolCallId, clearCspViolations]);
  useEffect(() => {
    const injectionChanged =
      loadedInjectOpenAiCompat !== null &&
      loadedInjectOpenAiCompat !== widgetInjectOpenAiCompatReloadKey;
    const capabilitiesChanged =
      (loadedCompatCapabilitiesHash !== null &&
        loadedCompatCapabilitiesHash !== widgetCompatCapabilitiesReloadKey) ||
      (loadedMcpAppsCapabilitiesHash !== null &&
        loadedMcpAppsCapabilitiesHash !== widgetMcpAppsCapabilitiesReloadKey);
    if (injectionChanged || capabilitiesChanged) {
      clearCspViolations(toolCallId);
    }
  }, [
    widgetInjectOpenAiCompatReloadKey,
    loadedInjectOpenAiCompat,
    widgetCompatCapabilitiesReloadKey,
    loadedCompatCapabilitiesHash,
    widgetMcpAppsCapabilitiesReloadKey,
    loadedMcpAppsCapabilitiesHash,
    toolCallId,
    clearCspViolations,
  ]);

  // Reset ready state and refs when CSP mode OR compat flag changes
  // (widget will reinitialize — tool input/output must be re-sent).
  useEffect(() => {
    if (loadedCspMode !== null && loadedCspMode !== cspMode) {
      setIsReady(false);
      isReadyRef.current = false;
      resetStreamingState();
    }
  }, [cspMode, loadedCspMode, resetStreamingState]);
  useEffect(() => {
    const injectionChanged =
      loadedInjectOpenAiCompat !== null &&
      loadedInjectOpenAiCompat !== widgetInjectOpenAiCompatReloadKey;
    const capabilitiesChanged =
      (loadedCompatCapabilitiesHash !== null &&
        loadedCompatCapabilitiesHash !== widgetCompatCapabilitiesReloadKey) ||
      (loadedMcpAppsCapabilitiesHash !== null &&
        loadedMcpAppsCapabilitiesHash !== widgetMcpAppsCapabilitiesReloadKey);
    if (injectionChanged || capabilitiesChanged) {
      setIsReady(false);
      isReadyRef.current = false;
      resetStreamingState();
    }
  }, [
    widgetInjectOpenAiCompatReloadKey,
    loadedInjectOpenAiCompat,
    widgetCompatCapabilitiesReloadKey,
    loadedCompatCapabilitiesHash,
    widgetMcpAppsCapabilitiesReloadKey,
    loadedMcpAppsCapabilitiesHash,
    resetStreamingState,
  ]);

  // Sync displayMode from playground store when it changes (SEP-1865)
  // Only sync when not in controlled mode (parent controls displayMode via props)
  useEffect(() => {
    if (isPlaygroundActive && !isControlled) {
      setInternalDisplayMode(
        clampDisplayModeToAvailableModes(
          configuredDisplayMode ?? playgroundDisplayMode,
          configuredAvailableDisplayModes
        )
      );
    }
  }, [
    configuredAvailableDisplayModes,
    configuredDisplayMode,
    isPlaygroundActive,
    playgroundDisplayMode,
    isControlled,
  ]);

  // Initialize widget debug info
  useEffect(() => {
    setWidgetDebugInfo(toolCallId, {
      toolName,
      protocol: "mcp-apps",
      // Seed from persisted state when a saved view / fork supplied one,
      // so the Debug "Widget State" tab shows the restored value on
      // first render instead of `null`. Apps SDK widgets that call
      // window.openai.setWidgetState() later will overwrite this via
      // setWidgetStateStore in the openai:setWidgetState handler below.
      widgetState: initialWidgetState ?? null,
      prefersBorder,
      globals: {
        theme: resolvedTheme,
        displayMode: effectiveDisplayMode,
        locale,
        timeZone,
        deviceCapabilities,
        safeAreaInsets,
      },
    });
  }, [
    toolCallId,
    toolName,
    setWidgetDebugInfo,
    resolvedTheme,
    effectiveDisplayMode,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
    prefersBorder,
    initialWidgetState,
  ]);

  // Update globals in debug store when they change
  useEffect(() => {
    setWidgetGlobals(toolCallId, {
      theme: resolvedTheme,
      displayMode: effectiveDisplayMode,
      locale,
      timeZone,
      deviceCapabilities,
      safeAreaInsets,
    });
  }, [
    toolCallId,
    resolvedTheme,
    effectiveDisplayMode,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
    setWidgetGlobals,
  ]);

  // CSS Variables for theming (SEP-1865 styles.variables)
  // These are sent via hostContext.styles.variables - the SDK should pass them through
  const effectiveHostStyle = isPlaygroundActive
    ? sharedHostStyle
    : chatboxHostStyle;
  const hostStyleDefinition = getHostStyleOrDefault(effectiveHostStyle);
  // Single source of truth for what `hostCapabilities` this view will
  // advertise. The bridge-creation effect (`new AppBridge(...)`) spreads this
  // value into the handshake, and `registerBridgeHandlers` gates each
  // chip-bound handler on the matching field — same blob drives both
  // advertise and enforce, no drift.
  //
  // Stability matters: this memo is a dep of both the bridge-construction
  // useEffect and the registerBridgeHandlers useCallback, so a fresh
  // reference per render would tear down + re-attach the bridge on every
  // commit. Both inputs are stable — `effectiveHostStyle` resolves to a
  // string|null derived from Zustand+context selectors, and
  // `hostCapabilitiesOverride` comes from a context whose Providers (see
  // ClientStyledChatTabV2 / PlaygroundTab / ChatboxChatPage) read from
  // Zustand selectors that return stable refs until the underlying field
  // mutates.
  // Ref-route the active `window.openai` shim capability surface so
  // the host-side `openai:*` postMessage handlers (uploadFile,
  // getFileDownloadUrl, setWidgetState, requestModal, requestClose,
  // requestCheckout) can read the current value without forcing
  // their closures to rebuild on every host swap. These gates are
  // defense-in-depth for the shim surface — the SDK runtime already
  // omits the corresponding methods on `window.openai`, but a widget
  // that captured a method reference before a host swap, or a
  // hand-crafted postMessage, would still arrive here.
  //
  // Cached replays use the PERSISTED capabilities (what was baked
  // into the HTML bytes) instead of the live profile's matrix — the
  // byte-frozen runtime config inside the iframe is the source of
  // truth for which methods the widget can call.
  //
  // SCOPED TO THE SHIM ONLY. The SEP-1865 `bridge.on*` handlers are
  // a distinct surface and follow `effectiveHostCapabilities`
  // exclusively — see the comment in `registerBridgeHandlers`. Null
  // when the shim isn't injected.
  // Sparse `OpenAiAppsCapabilities` (not Required) because the
  // cached-replay branch reads a persisted value that may be missing
  // fields added after capture time. Consumers of this ref
  // (postMessage gates) read each field with `caps[key] === false` /
  // `caps[key] !== true`, so missing → treated as "default on", which
  // matches the SDK runtime's FULL_SURFACE_DEFAULT fallback baked
  // into the original capture.
  const activeShimCapabilities: OpenAiAppsCapabilities | null = isCachedReplay
    ? initialInjectedOpenAiCompatCapabilities ?? null
    : liveOpenAiCompatCapabilities;
  const liveOpenAiCompatCapabilitiesRef = useRef<OpenAiAppsCapabilities | null>(
    activeShimCapabilities
  );
  liveOpenAiCompatCapabilitiesRef.current = activeShimCapabilities;

  const effectiveHostCapabilities = useMemo(
    () =>
      resolveEffectiveHostCapabilities({
        hostStyle: effectiveHostStyle,
        profile: activeMcpProfile,
        hostCapabilitiesOverride,
      }),
    [effectiveHostStyle, activeMcpProfile, hostCapabilitiesOverride]
  );
  // SEP-1865 spec-bridge matrix resolved from the live profile +
  // host style. Gates notification emissions (`tool-input-partial`,
  // `tool-cancelled`, `host-context-changed`) so simulated hosts
  // like Microsoft 365 Copilot match their published Component-
  // bridge table. Sibling to `effectiveHostCapabilities` — the wire
  // shape advertised in `ui/initialize` is derived from this matrix
  // via `buildHostCapabilities`, but the matrix itself is what
  // runtime notification gates read.
  //
  // INDEPENDENT from the OpenAI shim's `activeShimCapabilities`
  // ref. Two-matrix architecture (see
  // feedback_two_matrix_architecture memory): toggling a row on one
  // matrix never reads the other.
  //
  // The ref is declared above (with initial `null`) so it's visible
  // to `useToolInputStreaming` earlier in the render. We populate
  // `.current` here — same one-step-behind-during-mount caveat the
  // `liveOpenAiCompatCapabilitiesRef` pattern has, and the gate
  // contract reads `null` as "default on" so the brief window emits
  // notifications (matches pre-matrix behavior).
  //
  // The matrix itself is computed earlier in the render
  // (`earlyEffectiveMcpAppsCapabilities` near the display-mode
  // resolution) so the `effectiveDisplayMode` clamp can use it. We
  // alias the same value here for downstream consumers.
  const effectiveMcpAppsCapabilities = earlyEffectiveMcpAppsCapabilities;
  mcpAppsCapabilitiesRef.current = effectiveMcpAppsCapabilities;
  themeModeRef.current = resolvedTheme;
  const styleVariables = useMemo(
    () => hostStyleDefinition.mcp.resolveStyleVariables(resolvedTheme),
    [resolvedTheme, hostStyleDefinition]
  );
  const hostChatBackground = useMemo(
    () => hostStyleDefinition.chatUi.resolveChatBackground(resolvedTheme),
    [hostStyleDefinition, resolvedTheme]
  );
  const defaultFontCss = hostStyleDefinition.mcp.fontCss;
  const configuredStyles =
    baseHostContext.styles &&
    typeof baseHostContext.styles === "object" &&
    !Array.isArray(baseHostContext.styles)
      ? (baseHostContext.styles as McpUiHostContext["styles"])
      : undefined;
  // The SDK validates styles.variables against the SEP key enum, so strip
  // host-specific custom properties before they enter ui/initialize. The
  // allowlist is fixed to the SEP enum (see SEP_HOST_STYLE_VARIABLE_KEYS),
  // so this memo only depends on the inbound configured variables.
  const configuredStyleVariables = useMemo(
    () => sanitizeHostStyleVariables(configuredStyles?.variables),
    [configuredStyles?.variables]
  );
  const mergedStyleVariables = useMemo(() => {
    return {
      ...styleVariables,
      ...(configuredStyleVariables &&
      Object.keys(configuredStyleVariables).length > 0
        ? configuredStyleVariables
        : {}),
    };
  }, [configuredStyleVariables, styleVariables]);
  const mergedStyles = useMemo<McpUiHostContext["styles"]>(
    () => ({
      ...configuredStyles,
      variables: mergedStyleVariables,
      css: {
        ...configuredStyles?.css,
        fonts: configuredStyles?.css?.fonts ?? defaultFontCss,
      },
    }),
    [configuredStyles, defaultFontCss, mergedStyleVariables]
  );

  // containerDimensions (maxWidth/maxHeight) was previously sent here but
  // removed — width is now fully host-controlled.
  //
  // Matrix-gated HostContext fields (PR C of the foundation series):
  //
  // - `availableDisplayModes`: intersection of the matrix's allowed
  //   modes with playground / draft configured modes, computed earlier
  //   as `effectiveAvailableDisplayModes` so the runtime
  //   `effectiveDisplayMode` clamp and the advertised list agree.
  //
  // - `toolInfo`: omitted entirely when `matrix.toolInfo === false`
  //   (Microsoft 365 Copilot doesn't deliver this HostContext field
  //   per its published Component-bridge table). A widget that
  //   probes `app.getHostContext()?.toolInfo` on a simulated Copilot
  //   host now correctly sees undefined — same as real Copilot. The
  //   gate strips any inherited `toolInfo` from `baseHostContext`
  //   too: a draft host context that pre-populates `toolInfo` would
  //   otherwise leak through the spread and defeat the gate.
  const hostContext = useMemo<McpUiHostContext>(() => {
    // Strip toolInfo from the spread source so the matrix gate is
    // authoritative — if the matrix says off, no upstream value
    // (drafts, playground state) can reintroduce it via inheritance.
    const { toolInfo: _toolInfoFromBase, ...baseWithoutToolInfo } =
      baseHostContext as McpUiHostContext & { toolInfo?: unknown };
    const base: McpUiHostContext = {
      ...baseWithoutToolInfo,
      theme: resolvedTheme,
      displayMode: effectiveDisplayMode,
      // Publish the (host ∩ app) intersection here so the view sees the
      // narrowed set it can `requestDisplayMode` against. The current
      // `displayMode` above stays clamped to host-supported only.
      availableDisplayModes: advertisedAvailableDisplayModes,
      locale,
      timeZone,
      platform:
        baseHostContext.platform === "web" ||
        baseHostContext.platform === "desktop" ||
        baseHostContext.platform === "mobile"
          ? baseHostContext.platform
          : hostStyleDefinition.mcp.platform,
      userAgent: navigator.userAgent,
      deviceCapabilities,
      safeAreaInsets,
      styles: mergedStyles,
    };
    if (effectiveMcpAppsCapabilities.toolInfo) {
      base.toolInfo = {
        id: toolCallId,
        tool: {
          name: toolName,
          inputSchema:
            (toolMetadata?.inputSchema as {
              type: "object";
              properties?: Record<string, object>;
              required?: string[];
            }) ?? DEFAULT_INPUT_SCHEMA,
          description: toolMetadata?.description as string | undefined,
        },
      };
    }
    return base;
  }, [
    baseHostContext,
    resolvedTheme,
    effectiveDisplayMode,
    advertisedAvailableDisplayModes,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
    mergedStyles,
    hostStyleDefinition,
    toolCallId,
    toolName,
    toolMetadata,
    effectiveMcpAppsCapabilities.toolInfo,
  ]);

  useEffect(() => {
    hostContextRef.current = hostContext;
  }, [hostContext]);

  // Resolve the effective sandbox policy ONCE, at component scope, so the
  // same value reaches three independent consumers without drift:
  //   - the AppBridge constructor below (capability handshake)
  //   - the <SandboxedIframe> below (browser-enforced CSP / Permission-Policy)
  //   - the <McpAppsModal> below (its own sandboxed iframe for view_mode=modal)
  //
  // Computing this inside the bridge useEffect (the old shape) leaked the
  // policy into ONE consumer only — the iframe got the raw resource
  // declaration and the browser ignored the host clamp, which is exactly the
  // failure the shared resolver was supposed to prevent. The resolver is the
  // single source of truth; everything that mounts untrusted UI reads from
  // here.
  //
  // `effectivePermissive` collapses to `false` whenever a host policy applies
  // — SandboxedIframe treats `permissive: true` as "skip CSP injection
  // entirely", which would silently neuter the resolver output.
  const sandboxCspPolicy = activeMcpProfile?.apps?.sandbox?.csp;
  const sandboxPermissionsPolicy = activeMcpProfile?.apps?.sandbox?.permissions;
  // Inspector-only emission knobs sourced directly from the profile. They
  // bypass the SEP-1865 resolver because they model browser-emission state
  // that has no spec slot (raw `sandbox=`/`allow=` tokens, CSP source
  // expressions). Passed through unchanged to <SandboxedIframe>.
  const sandboxAttrsPolicy = activeMcpProfile?.apps?.sandbox?.sandboxAttrs;
  const allowFeaturesPolicy = activeMcpProfile?.apps?.sandbox?.allowFeatures;
  const cspDirectivesPolicy =
    activeMcpProfile?.apps?.sandbox?.csp?.cspDirectives;
  // Hosted-mode clamp for cspDirectives. The resolver's
  // `hostedClampExtraDeny` strips MCPJam app/API origins from the
  // widget-declared CSP (`restrictTo` + resource declaration), but
  // cspDirectives is inspector-only — it bypasses the resolver and the
  // proxy merges its tokens AFTER the resolver output, so without a
  // mirrored clamp here a hosted profile with e.g.
  // `cspDirectives: { "connect-src": ["https://app.mcpjam.com"] }`
  // re-adds the same-origin access the clamp is meant to make
  // non-bypassable. Strip any host-bearing token that resolves to the
  // mcpjam.com namespace AND scheme-wide tokens that would otherwise
  // cover MCPJam endpoints (`*`, `https:`, `http:`, `wss:`, `ws:`); CSP
  // keyword tokens (`'unsafe-eval'`, hashes, nonces — quoted with `'…'`)
  // and safe scheme-only tokens (`data:`, `blob:`, `about:`,
  // `filesystem:`, `mediastream:`) pass through unchanged.
  const cspDirectivesEffective = useMemo(() => {
    if (!cspDirectivesPolicy) return cspDirectivesPolicy;
    if (!HOSTED_MODE) return cspDirectivesPolicy;
    const isClampBypass = (token: string) => {
      // `'self'` is a clamp bypass in hosted mode. The proxy is served
      // from the MCPJam origin and the inner srcdoc iframe carries
      // `allow-same-origin` (so its document origin = parent's =
      // MCPJam). `'self'` in the inner doc's CSP therefore resolves
      // to the MCPJam app origin, which lets an untrusted widget
      // fetch authenticated MCPJam endpoints — exactly what the clamp
      // is meant to make unreachable. Templates that need actual
      // same-origin access in production hosts (e.g. real Claude
      // where `'self'` resolves to claude.ai) should list the host
      // explicitly so the modeling is faithful in hosted mode too.
      if (token === "'self'") return true;
      if (token.startsWith("'")) return false; // other CSP keywords
      // Scheme-wide tokens that cover MCPJam-namespace origins. The
      // clamp's purpose is to keep MCPJam app/API endpoints unreachable
      // from the iframe; `https:` (and friends) covers them just as
      // effectively as naming `https://app.mcpjam.com` directly.
      // Templates that need broad access should list specific origins
      // (e.g. Claude lists `https://esm.sh`, `https://assets.claude.ai`).
      if (token === "*") return true;
      if (/^(https?|wss?):$/i.test(token)) return true;
      // Other scheme-only tokens (data:, blob:, about:, filesystem:,
      // mediastream:) don't reach MCPJam origins — let through.
      if (/^[a-z]+:$/.test(token)) return false;
      // Host-bearing token: match mcpjam.com as a host component,
      // covering MCPJAM_HOSTED_CLAMP_ORIGINS (`https://*.mcpjam.com`
      // and `https://mcpjam.com`).
      return /(?:^|[/.@])mcpjam\.com(?:[:/]|$)/i.test(token);
    };
    const out: Record<string, string[]> = {};
    for (const [k, tokens] of Object.entries(cspDirectivesPolicy)) {
      // Trim BEFORE the bypass check: an imported/saved profile can
      // carry " https:" or " https://app.mcpjam.com" with leading
      // whitespace, and the proxy's mergeDirective trims tokens before
      // emitting them — so the untrimmed string sneaks past
      // isClampBypass while the trimmed version still lands in the
      // output CSP, reintroducing the access the clamp is supposed to
      // remove. Normalize here so the filter and the proxy see the same
      // token shape.
      const clamped = tokens
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && !isClampBypass(t));
      if (clamped.length > 0) out[k] = clamped;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, [cspDirectivesPolicy]);
  const effectiveSandbox = useMemo<{
    csp: McpUiResourceCsp | undefined;
    permissions: McpUiResourcePermissions | undefined;
    permissive: boolean;
    hostPolicyApplied: boolean;
    sandboxAttrs: string[] | undefined;
    allowFeatures: Record<string, string> | undefined;
    cspDirectives: Record<string, string[]> | undefined;
  }>(() => {
    // Detect whether the host explicitly configured CSP hardening signals.
    // Hoisted above the permissive short-circuit so the permissive branch
    // can honor host-explicit `restrictTo` instead of silently dropping it;
    // the relaxed branch below reuses the same calculation. SEP-1865 host
    // policies are allowlist-only, so `restrictTo` and the hosted clamp are
    // the only hardening levers.
    const restrictToConfigured =
      sandboxCspPolicy?.restrictTo !== undefined &&
      Object.values(sandboxCspPolicy.restrictTo).some(
        (list) => Array.isArray(list) && list.length > 0
      );
    // cspDirectives is an inspector-only emission knob, but a populated
    // value is still an explicit "I want this CSP shape" signal. The
    // permissive shortcut below bypasses the proxy's `buildCSP(csp,
    // cspDirectives)` path (it builds its own fixed permissive CSP), so
    // without treating cspDirectives as hardening the configured
    // directives get silently dropped on the chatbox/preview surfaces
    // where host profiles are most meant to apply.
    //
    // Only count entries that contribute at least one token that would
    // survive the proxy's mergeDirective filter (trim, plus `;,\n\r"<>`
    // rejection — kept in lockstep with the predicate in
    // sandbox-proxy.html). An entry like `{ "frame-src": [] }` or
    // `{ "frame-src": [" "] }` is a semantic no-op and must not flip
    // a permissive surface into the resolver path (which would then
    // enforce the widget-declared CSP even though the named directive
    // contributes nothing).
    const cspDirectivesConfigured =
      sandboxCspPolicy?.cspDirectives !== undefined &&
      Object.values(sandboxCspPolicy.cspDirectives).some(
        (tokens) =>
          Array.isArray(tokens) &&
          tokens.some((t) => {
            if (typeof t !== "string") return false;
            const trimmed = t.trim();
            if (trimmed.length === 0) return false;
            if (/[;,\n\r"<>]/.test(trimmed)) return false;
            return true;
          })
      );
    // Permissive means permissive — when the user explicitly toggles it in
    // the playground toolbar — ignore the saved profile's CSP hardening
    // (restrictTo, cspDirectives) and skip CSP injection entirely. Strict
    // applies the host profile.
    //
    // Chatbox / minimal-mode surfaces also hardcode `cspMode = "permissive"`
    // (line 405) as a UX-friendliness default for end-user demos, NOT as a
    // user choice. The host's `restrictTo` / `cspDirectives` MUST still apply
    // there — otherwise a developer who configures `restrictTo: { connectDomains: ["https://api.acme"] }`
    // on their chatbox host would have it honored on Connect → Chat but
    // silently dropped on the public chatbox runtime / Sessions transcript.
    //
    // We can't gate on `isPlaygroundActive` alone: the Playground store is
    // localStorage and leaks across browsing contexts on the same origin
    // (see line 396), so a chatbox preview iframe can read
    // `isPlaygroundActive = true` from the parent inspector tab even though
    // it's a chatbox surface. Require `!isChatboxSurface && !minimalMode` so
    // the short-circuit is gated on the actual rendering surface, not just
    // the (leakable) playground flag.
    //
    // No HOSTED_MODE carve-out: PR #2164 moves the sandbox proxy to a separate
    // origin so the iframe is no longer same-origin with mcpjam.com, and a
    // permissive CSP can't be used to fetch /api/* with the user's session
    // cookies.
    //
    // Permissions policy still resolves below — it's orthogonal to CSP.
    const userTogglePermissive =
      cspMode === "permissive" &&
      isPlaygroundActive &&
      !isChatboxSurface &&
      !minimalMode;
    if (userTogglePermissive) {
      let resolvedPermissions: McpUiResourcePermissions | undefined;
      if (sandboxPermissionsPolicy) {
        const resourcePermsMap: Record<string, boolean> = {};
        // Matrix-gated: `sandboxPermissions: false` means the
        // simulated host doesn't honor `_meta.ui.permissions`. Use
        // the gated value here too — the playground's permissive
        // CSP escape hatch is NOT a license to bypass host-level
        // permission gating. Three bots converged on this miss in
        // review of PR #2242.
        if (
          matrixGatedWidgetPermissions &&
          typeof matrixGatedWidgetPermissions === "object"
        ) {
          for (const [k, v] of Object.entries(
            matrixGatedWidgetPermissions as Record<string, unknown>
          )) {
            if (v) resourcePermsMap[k] = true;
          }
        }
        const resolved = resolveSandboxPermissions({
          resourcePermissions: resourcePermsMap,
          policy: sandboxPermissionsPolicy,
          hostedMode: HOSTED_MODE,
        });
        const out: Record<string, Record<string, never>> = {};
        for (const name of Object.keys(resolved.granted)) {
          out[name] = {};
        }
        resolvedPermissions = out as McpUiResourcePermissions;
      }
      return {
        csp: undefined,
        // Same gate on the pass-through fallback: when no sandbox
        // policy applies, the playground's permissive surface MUST
        // NOT propagate widget-declared permissions that the host
        // matrix says to ignore.
        permissions: resolvedPermissions ?? matrixGatedWidgetPermissions,
        permissive: true,
        hostPolicyApplied: !!resolvedPermissions,
        sandboxAttrs: sandboxAttrsPolicy,
        allowFeatures: allowFeaturesPolicy,
        cspDirectives: cspDirectivesEffective,
      };
    }

    // "relaxed" CSP mode is an explicit dev escape hatch. The resolver
    // can't represent "no restrictions" as a domain list (CSP allow-
    // lists can't carry `*` without inviting the hosted clamp to strip
    // it), so PURE relaxed (no restrictTo, not hosted) short-circuits
    // the resolver and emits no CSP — preserves the dev experience.
    //
    // Any tightening signal — restrictTo or hostedMode — falls through
    // INTO the resolver so the documented guarantees hold:
    //   * "restrictTo applies in every mode" — intersects in every mode
    //   * "hosted clamp is non-bypassable" — the MCPJam-origin SDK-
    //     internal strip must run in hosted mode regardless of saved profile
    //
    // The previous shape (`if (sandboxCspPolicy && !isRelaxedCsp)`)
    // skipped the resolver entirely on mode==="relaxed". A hosted user
    // could save a relaxed profile and silently opt out of the hosted
    // clamp's MCPJam-origin strip — P1 in production.
    const isPureRelaxedCsp =
      sandboxCspPolicy?.mode === "relaxed" &&
      !restrictToConfigured &&
      !cspDirectivesConfigured &&
      !HOSTED_MODE;

    let resolvedCsp: McpUiResourceCsp | undefined;
    if (sandboxCspPolicy && !isPureRelaxedCsp) {
      const resolved = resolveSandboxCsp({
        // Matrix-gated: `cspFrameDomains` / `cspBaseUriDomains` off
        // strips those sub-fields from the widget-declared CSP before
        // the resolver sees them, simulating hosts (Microsoft 365
        // Copilot) that don't honor those `_meta.ui.csp.*` fields.
        resourceCsp: matrixGatedWidgetCsp,
        policy: sandboxCspPolicy,
        // "host-default" mode falls back to an EMPTY allowlist inside
        // the resolver when `hostDefaultBaseline` is omitted (per
        // SEP-1865 secure-default). For the inspector, the only sensible
        // default baseline we have is the resource's own declaration —
        // passing it here means "host-default" is restrictive only as
        // much as the resource itself asked for (never more, possibly
        // less if restrictTo narrows it). Without this, picking
        // "host-default" would silently emit `connect-src 'none'` and
        // break any widget that fetches external assets.
        hostDefaultBaseline: matrixGatedWidgetCsp,
        hostedMode: HOSTED_MODE,
        // Defense in depth: in hosted mode strip any widget-declared
        // domain matching MCPJam's own app/API origins. A hosted widget
        // that declares `https://app.mcpjam.com/api/...` in
        // connectDomains could otherwise use the iframe as an
        // exfiltration channel via the user's authenticated session.
        // The list is hardcoded here (and not in the SDK) because
        // "which origins count as MCPJam" is an inspector concern, not
        // a shared SDK concern; the SDK just enforces what we pass.
        // Wildcard pattern strips all subdomains incl. staging/api.
        hostedClampExtraDeny: HOSTED_MODE
          ? {
              // Spread the readonly constant into mutable arrays — the
              // SDK's `SandboxCspDomainSet` shape declares them as
              // `string[]`. Spreading per directive avoids accidental
              // aliasing if the SDK ever mutates internally.
              connectDomains: [...MCPJAM_HOSTED_CLAMP_ORIGINS],
              resourceDomains: [...MCPJAM_HOSTED_CLAMP_ORIGINS],
              frameDomains: [...MCPJAM_HOSTED_CLAMP_ORIGINS],
              baseUriDomains: [...MCPJAM_HOSTED_CLAMP_ORIGINS],
            }
          : undefined,
      });
      resolvedCsp = {
        connectDomains: resolved.connectDomains,
        resourceDomains: resolved.resourceDomains,
        frameDomains: resolved.frameDomains,
        baseUriDomains: resolved.baseUriDomains,
      };
    }
    let resolvedPermissions: McpUiResourcePermissions | undefined;
    if (sandboxPermissionsPolicy) {
      const resourcePermsMap: Record<string, boolean> = {};
      // Matrix-gated: `sandboxPermissions: false` means the simulated
      // host doesn't honor resource permissions at all. The gated
      // value is `undefined`, so the loop never runs and the
      // resolver's policy alone decides what's granted (typically
      // nothing, matching real Copilot which doesn't pipe widget-
      // declared permissions to the iframe).
      if (
        matrixGatedWidgetPermissions &&
        typeof matrixGatedWidgetPermissions === "object"
      ) {
        for (const [k, v] of Object.entries(
          matrixGatedWidgetPermissions as Record<string, unknown>
        )) {
          // SEP-1865 declares each permission as an empty object (`{}`)
          // when requested — i.e. a truthy value. Older shape gated on
          // `v !== undefined && v !== null` which would also accept
          // `false` / `0` / `""` and silently coerce them to GRANTED.
          // Tighten to a truthiness check so a malformed widget that
          // declares `{ camera: false }` doesn't end up with camera
          // granted in the resolved permission set.
          if (v) resourcePermsMap[k] = true;
        }
      }
      const resolved = resolveSandboxPermissions({
        resourcePermissions: resourcePermsMap,
        policy: sandboxPermissionsPolicy,
        hostedMode: HOSTED_MODE,
      });
      const out: Record<string, Record<string, never>> = {};
      for (const name of Object.keys(resolved.granted)) {
        out[name] = {};
      }
      resolvedPermissions = out as McpUiResourcePermissions;
    }
    const hostPolicyApplied =
      !!resolvedCsp || !!resolvedPermissions || isPureRelaxedCsp;
    return {
      // Pure relaxed → no CSP at all (caller's `permissive: true` below
      // tells SandboxedIframe to skip CSP injection). Otherwise pass
      // the resolver output through, falling back to the widget's own
      // derivation when no host CSP policy is in force.
      // Use matrix-gated CSP / permissions as the fallback too, so a
      // Copilot host whose matrix turns frameDomains off doesn't
      // accidentally pass the un-gated value to the iframe via the
      // `?? widgetCsp` branch.
      csp: isPureRelaxedCsp
        ? undefined
        : resolvedCsp ?? (widgetPermissive ? undefined : matrixGatedWidgetCsp),
      permissions: resolvedPermissions ?? matrixGatedWidgetPermissions,
      // A host-applied CSP MUST be honored at the browser layer. When
      // a restrictive host policy is in force, force `permissive: false`
      // so the SandboxedIframe injects the meta-CSP. In pure-relaxed
      // mode the host policy is "permissive on purpose" → force
      // `permissive: true` so the iframe doesn't inject any meta-CSP
      // at all. Without host-side CSP policy, pass the widget-derived
      // flag through.
      //
      // Gate ONLY on `resolvedCsp` (not `resolvedPermissions`): a
      // permissions-only profile (e.g. `mode: "deny-all"` for camera/
      // mic) used to flip `permissive: false` while `csp` stayed
      // undefined, which the sandbox proxy interprets as the SEP-1865
      // secure-default CSP (`default-src 'none'`, `connect-src 'none'`)
      // — silently breaking network access for permissive widgets.
      // Permissions and CSP are orthogonal user-facing knobs; tweaking
      // one must not reshape the other.
      permissive: isPureRelaxedCsp
        ? true
        : resolvedCsp
        ? false
        : widgetPermissive,
      hostPolicyApplied,
      sandboxAttrs: sandboxAttrsPolicy,
      allowFeatures: allowFeaturesPolicy,
      cspDirectives: cspDirectivesEffective,
    };
  }, [
    cspMode,
    isPlaygroundActive,
    isChatboxSurface,
    minimalMode,
    sandboxCspPolicy,
    sandboxPermissionsPolicy,
    matrixGatedWidgetCsp,
    matrixGatedWidgetPermissions,
    widgetPermissive,
    sandboxAttrsPolicy,
    allowFeaturesPolicy,
    cspDirectivesEffective,
  ]);

  // Publish the resolved sandbox payload into the widget-debug store so the
  // Sandbox debug panel can render it. `restrictTo` and `cspMode` come from
  // the source profile because the resolver intersects them in but doesn't
  // echo them back verbatim — surfacing both lets the matrix-shared grid show
  // the narrowing knobs even when they collapsed into an intersection.
  //
  // Follow-up: `sandboxAttrs` / `allowFeatures` are policy inputs to
  // `SandboxedIframe`; the literal emitted `sandbox=` / `allow=` strings are
  // joined and filtered inside that component and are NOT exposed here.
  // Exposing the final emitted attributes (via a ref or callback on
  // SandboxedIframe) is left as a follow-up; the resolved policy is enough
  // for "why isn't this view rendering" in the vast majority of cases.
  // hostInfo advertised in `ui/initialize` per SEP-1865. Sourced from the
  // active host profile's `mcpProfile.apps.uiInitialize.hostInfo` so the
  // panel's "View iframe" sub-card shows what a view actually receives.
  // Null when the host hasn't customized it — same fallback contract as
  // the matrix (canvasBuilder.ts:708).
  const sandboxHostInfo = useMemo<{
    name: string;
    version: string;
  } | null>(() => {
    const raw = activeMcpProfile?.apps?.uiInitialize?.hostInfo;
    if (!raw || typeof raw !== "object") return null;
    const name = (raw as { name?: unknown }).name;
    const version = (raw as { version?: unknown }).version;
    if (typeof name !== "string" || typeof version !== "string") return null;
    if (name.trim() === "" || version.trim() === "") return null;
    return { name, version };
  }, [activeMcpProfile]);

  useEffect(() => {
    if (!toolCallId) return;
    setSandboxAppliedStore(
      toolCallId,
      {
        sandboxAttrs: effectiveSandbox.sandboxAttrs,
        allowFeatures: effectiveSandbox.allowFeatures,
        cspDirectives: effectiveSandbox.cspDirectives,
        permissive: effectiveSandbox.permissive,
        hostPolicyApplied: effectiveSandbox.hostPolicyApplied,
        restrictTo: sandboxCspPolicy?.restrictTo,
        cspMode: sandboxCspPolicy?.mode,
        permissions: effectiveSandbox.permissions,
      },
      undefined,
      sandboxHostInfo
    );
  }, [
    toolCallId,
    effectiveSandbox,
    sandboxCspPolicy,
    sandboxHostInfo,
    setSandboxAppliedStore,
  ]);

  // Keep bridge callbacks in sync before ResizeObserver/rAF-driven widget
  // messages can fire after a display-mode commit.
  useLayoutEffect(() => {
    onSendFollowUpRef.current = onSendFollowUp;
    onCallToolRef.current = onCallTool;
    onRequestPipRef.current = onRequestPip;
    onExitPipRef.current = onExitPip;
    setDisplayModeRef.current = setDisplayMode;
    isPlaygroundActiveRef.current = isPlaygroundActive;
    playgroundDeviceTypeRef.current = playgroundDeviceType;
    effectiveDisplayModeRef.current = effectiveDisplayMode;
    serverIdRef.current = serverId;
    toolCallIdRef.current = toolCallId;
    pipWidgetIdRef.current = pipWidgetId;
    toolsMetadataRef.current = toolsMetadata;
    onModelContextUpdateRef.current = onModelContextUpdate;
    onAppSupportedDisplayModesChangeRef.current =
      onAppSupportedDisplayModesChange;
    onRequestTeardownRef.current = onRequestTeardown;
  }, [
    onSendFollowUp,
    onCallTool,
    onRequestPip,
    onExitPip,
    setDisplayMode,
    isPlaygroundActive,
    playgroundDeviceType,
    effectiveDisplayMode,
    serverId,
    toolCallId,
    pipWidgetId,
    toolsMetadata,
    onModelContextUpdate,
    onAppSupportedDisplayModesChange,
    onRequestTeardown,
  ]);

  // ENFORCEMENT (live):
  // `effectiveHostCapabilities` (above) is the contract advertised in
  // ui/initialize, and the six chip-bound handlers below are only assigned
  // when their cap is present — so advertise and enforce stay in lockstep.
  // An unassigned `bridge.on*` slot causes the SDK to auto-respond to the
  // widget's RPC with a "method not supported" envelope, matching strict
  // host behavior.
  //   • bridge.onopenlink            ← effectiveHostCapabilities.openLinks
  //   • bridge.onmessage             ← effectiveHostCapabilities.message
  //   • bridge.onupdatemodelcontext  ← effectiveHostCapabilities.updateModelContext
  //   • bridge.oncalltool            ← effectiveHostCapabilities.serverTools
  //   • bridge.onreadresource /
  //     onlistresources /
  //     onlistresourcetemplates      ← effectiveHostCapabilities.serverResources
  //   • bridge.onloggingmessage      ← effectiveHostCapabilities.logging
  //   • bridge.ondownloadfile        ← effectiveHostCapabilities.downloadFile
  //   • bridge.onrequestteardown     ← matrix.requestTeardown (behavior
  //                                    gate; not wire-advertised — the
  //                                    notification is always delivered
  //                                    by the SDK, but the host can
  //                                    decline to act on it)
  //
  // Intentionally unconditional (no chip / not capability-negotiated in
  // SEP-1865):
  //   • bridge.oninitialized         — handshake plumbing
  //   • bridge.onsizechange          — iframe resize is host-shell infra
  //   • bridge.onrequestdisplaymode  — request acceptance is always OK;
  //                                    the spec governs which modes are
  //                                    granted, not whether requests reply
  //   • bridge.onlistprompts         — no serverPrompts cap exists yet
  //   • handleUploadFile / GetFileDownloadUrl
  //                                  — legacy postMessage paths kept for
  //                                    Apps SDK widgets; SEP-1865 hosts
  //                                    use the matrix-gated
  //                                    bridge.ondownloadfile above
  const registerBridgeHandlers = useCallback(
    (bridge: AppBridge) => {
      bridge.oninitialized = () => {
        const wasReady = isReadyRef.current;
        setIsReady(true);
        isReadyRef.current = true;
        const appCaps = bridge.getAppCapabilities();
        logWidgetDebug("ui-to-host", "debug/app-initialized", {
          availableDisplayModes:
            (appCaps?.availableDisplayModes as DisplayMode[] | undefined) ??
            null,
          wasReady,
        });
        const declaredAppModes = appCaps?.availableDisplayModes as
          | DisplayMode[]
          | undefined;
        onAppSupportedDisplayModesChangeRef.current?.(declaredAppModes);
        // SEP-1865: clamp the advertised + runtime mode set against the
        // app's declaration. The next render of `hostContext` will pick
        // up the new intersection and the post-init `setHostContext`
        // effect will publish `host-context-changed` with the updated
        // `availableDisplayModes` (matrix-gated by hostContextChanged).
        setAppSupportedDisplayModes(declaredAppModes);
        // If the guest re-initialized (e.g. an SDK-based app completing its
        // own handshake after the openai-compat shim already initialized),
        // bump reinitCount so the delivery effects re-send tool data.
        if (wasReady) {
          setReinitCount((c) => c + 1);
        }

        // SEP-1865 App-Provided Tools: when the app advertises `tools`
        // capability, fetch its tool list with the SDK bridge and register
        // it so the next chat POST can advertise no-execute AI SDK tools.
        // Feature-detect the capability; do not install rejecting stubs.
        if (appCaps?.tools && effectiveMcpAppsCapabilities.appTools) {
          const bridgeId = appToolsBridgeIdRef.current ?? crypto.randomUUID();
          appToolsBridgeIdRef.current = bridgeId;
          setAppToolsBridgeIdState(bridgeId);
          void refreshAppProvidedTools(bridge, bridgeId);

          // SEP-1865 host UX: app-tools widgets are interactive — the
          // dev will want to chat with them. Auto-promote to fullscreen
          // so the existing fullscreen overlay (composer + chevron-
          // toggle chat history) becomes the chat surface, with the
          // widget filling the space behind it. Gates:
          //  • `declaredAppModes` includes "fullscreen" — the app
          //    actually renders in that mode (advertise=enforce)
          //  • `!userPreferInlineRef.current` — user hasn't dismissed
          //    fullscreen, and the host's `user-initiated-only` policy
          //    isn't blocking host-initiated mode switches
          //  • `!hasAutoPromotedForAppToolsRef.current` — one-shot so
          //    shim re-init or a widget's own re-handshake doesn't
          //    re-fire and overwrite a user-chosen mode
          // `setDisplayModeRef.current` is used (not the closure-
          // captured `setDisplayMode`) so this handler stays out of the
          // useCallback dep array and doesn't churn the bridge wiring.
          if (
            !hasAutoPromotedForAppToolsRef.current &&
            !userPreferInlineRef.current &&
            declaredAppModes?.includes("fullscreen")
          ) {
            hasAutoPromotedForAppToolsRef.current = true;
            setDisplayModeRef.current?.("fullscreen");
          }
        }
      };

      // SEP-1865 bridge handlers are gated by `effectiveHostCapabilities`
      // alone. They are a SEPARATE surface from the `window.openai`
      // shim — `ui/initialize` advertises `serverTools`, `openLinks`,
      // `message`, etc. via that blob, and the advertise/enforce
      // contract requires the handlers to honor whatever is
      // advertised. Folding the shim matrix in here would break it:
      // a Copilot-preset host advertises `serverTools` (the SEP
      // contract) but disables `window.openai.callTool` (the shim
      // surface), and gating the bridge by the shim would silently
      // drop bridge tool calls while still claiming support. The
      // shim caps stay scoped to the shim, enforced inside the
      // runtime + the host-side `openai:*` postMessage handlers.
      if (effectiveHostCapabilities.message) {
        bridge.onmessage = async ({ content }) => {
          const textContent = content.find(
            (item) => item.type === "text"
          )?.text;
          if (textContent) {
            onSendFollowUpRef.current?.(textContent);
          }
          return {};
        };
      }

      if (effectiveHostCapabilities.openLinks) {
        bridge.onopenlink = async ({ url }) => {
          if (url) {
            window.open(url, "_blank", "noopener,noreferrer");
          }
          return {};
        };
      }

      if (effectiveHostCapabilities.serverTools) {
        // Matrix-gated `sendToolCancelled` for app-initiated tool
        // calls failing in this handler. Microsoft 365 Copilot does
        // not deliver `ui/notifications/tool-cancelled` per its
        // published Component-bridge table; simulated Copilot hosts
        // must not see the cancelled callback even when the
        // underlying tool throws. The handler still THROWS so the
        // AppBridge's request/response path reports an error to the
        // calling widget — only the side-channel notification is
        // suppressed.
        const sendToolCancelledIfAllowed = (reason: string) => {
          const matrix = mcpAppsCapabilitiesRef.current;
          if (matrix !== null && matrix.toolCancelled === false) return;
          bridge.sendToolCancelled({ reason });
        };
        bridge.oncalltool = async ({ name, arguments: args }, _extra) => {
          // Check if tool is model-only (not callable by apps) per SEP-1865
          const calledToolMeta = toolsMetadataRef.current?.[name];
          if (isVisibleToModelOnly(calledToolMeta)) {
            const error = new Error(
              `Tool "${name}" is not callable by apps (visibility: model-only)`
            );
            sendToolCancelledIfAllowed(error.message);
            throw error;
          }

          if (!onCallToolRef.current) {
            const error = new Error("Tool calls not supported");
            sendToolCancelledIfAllowed(error.message);
            throw error;
          }

          try {
            const result = await onCallToolRef.current(
              name,
              (args ?? {}) as Record<string, unknown>
            );
            return result as CallToolResult;
          } catch (error) {
            // SEP-1865: Send tool-cancelled for failed app-initiated tool calls
            sendToolCancelledIfAllowed(
              error instanceof Error ? error.message : String(error)
            );
            throw error;
          }
        };
      }

      if (effectiveHostCapabilities.serverResources) {
        bridge.onreadresource = async ({ uri }) => {
          const result = await readResource(serverIdRef.current, uri);
          return result.content;
        };

        bridge.onlistresources = async (params) => {
          return listResources(
            serverIdRef.current,
            (params as { cursor?: string } | undefined)?.cursor
          );
        };

        bridge.onlistresourcetemplates = async (_params) => {
          if (HOSTED_MODE) {
            throw new Error(
              "Resource templates are not supported in hosted mode"
            );
          }

          const response = await authFetch(`/api/mcp/resource-templates/list`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              serverId: serverIdRef.current,
            }),
          });
          if (!response.ok) {
            throw new Error(
              `Resource template list failed: ${response.statusText}`
            );
          }
          return response.json();
        };
      }

      // onlistprompts: unconditional — no serverPrompts cap in SEP-1865 or
      // the chip set. Revisit if/when a serverPrompts chip is added.
      bridge.onlistprompts = async (params) => {
        void params;
        const prompts = await listPrompts(serverIdRef.current);
        return { prompts };
      };

      if (effectiveHostCapabilities.logging) {
        bridge.onloggingmessage = ({ level, data, logger }) => {
          if (minimalMode) return;
          const prefix = logger ? `[${logger}]` : "[MCP Apps]";
          const message = `${prefix} ${level.toUpperCase()}:`;
          if (level === "error" || level === "critical" || level === "alert") {
            console.error(message, data);
            return;
          }
          if (level === "warning") {
            console.warn(message, data);
            return;
          }
          console.info(message, data);
        };
      }

      // SEP-1865: apply both height AND width when the host outer
      // container is flexible (no fixed `width` published via
      // `containerDimensions`). The renderer caps the requested width
      // to 100% of the parent via `max-width: 100%` so a misbehaving
      // widget can't overflow the chatbox bubble. Fixed-
      // width contexts (PIP/fullscreen, or future hosts that publish
      // `containerDimensions.width`) ignore the width request — the
      // height-only path remains.
      bridge.onsizechange = ({ height, width }) => {
        if (effectiveDisplayModeRef.current !== "inline") return;
        const iframe = sandboxRef.current?.getIframeElement();
        const container = containerRef.current;
        if (!iframe || !container) return;
        if (height === undefined && width === undefined) return;
        const hostCtx = hostContextRef.current as
          | (McpUiHostContext & {
              containerDimensions?: { width?: number };
            })
          | null;
        const hostHasFixedWidth =
          typeof hostCtx?.containerDimensions?.width === "number";

        // The MCP App has requested a `height`, but if
        // `box-sizing: border-box` is applied to the outer iframe element, then we
        // must add border thickness to `height` to compute the actual
        // necessary height (in order to prevent a resize feedback loop).
        const style = getComputedStyle(iframe);
        const isBorderBox = style.boxSizing === "border-box";

        // Animate the change for a smooth transition.
        const from: Keyframe = {};
        const to: Keyframe = {};

        let adjustedHeight = height;

        if (adjustedHeight !== undefined) {
          if (isBorderBox) {
            adjustedHeight +=
              parseFloat(style.borderTopWidth) +
              parseFloat(style.borderBottomWidth);
          }
          from.height = `${iframe.offsetHeight}px`;
          iframe.style.height = to.height = `${adjustedHeight}px`;
          lastInlineHeightRef.current = `${adjustedHeight}px`;
        }

        if (width !== undefined && !hostHasFixedWidth) {
          let adjustedWidth = width;
          if (isBorderBox) {
            adjustedWidth +=
              parseFloat(style.borderLeftWidth) +
              parseFloat(style.borderRightWidth);
          }
          // Cap to parent so an over-eager widget can't escape the
          // bounding bubble. Keep `width` as a plain px value and rely on
          // `max-width: 100%` for the cap; this is equivalent to
          // `min(width, 100%)` in browsers and easier for tests/DevTools.
          const widthCss = `${adjustedWidth}px`;
          from.width = `${container.offsetWidth}px`;
          container.style.width = to.width = widthCss;
          iframe.style.width = "100%";
          lastInlineWidthRef.current = widthCss;
        }

        iframe.animate([from, to], { duration: 300, easing: "ease-out" });
        if (to.width !== undefined) {
          container.animate?.([{ width: from.width }, { width: to.width }], {
            duration: 300,
            easing: "ease-out",
          });
        }
        // size-changed fires on every resize/animation tick — chatty widgets
        // can flood the traffic log. The corresponding ui/notifications/
        // size-changed transport message is already suppressed above; rely on
        // that for diagnostics rather than a host-side debug log here.
      };

      bridge.onrequestdisplaymode = async ({ mode }) => {
        const requestedMode = mode ?? "inline";
        // Host policy gate: SEP-1865 allows the host to decline
        // widget-initiated `ui/request-display-mode`. The
        // `widgetDisplayModeRequests` matrix row (Apps tab) decides:
        //   - "accept": pass through to the existing sticky / clamp path
        //   - "decline": always return the current mode
        //   - "user-initiated-only": handled via the sticky-inline
        //     ref check below — the ref is seeded `true` at mount so
        //     the first widget request is gated until the user picks
        //     a non-inline mode via the host display-mode picker.
        const policy =
          mcpAppsCapabilitiesRef.current?.widgetDisplayModeRequests ?? "accept";
        if (requestedMode !== "inline" && policy === "decline") {
          const granted = effectiveDisplayModeRef.current;
          logWidgetDebug("ui-to-host", "ui/request-display-mode", {
            requested: requestedMode,
            granted,
            reason: "policy-decline",
          });
          return { mode: granted };
        }
        // Sticky inline-preference override: if the user explicitly
        // returned to inline (X click), or the policy seeded the flag
        // at mount, decline widget non-inline requests by returning
        // inline. Spec allows the host to return a different mode than
        // requested. Cleared when the user explicitly re-enters
        // fullscreen / PIP from the host display-mode picker.
        if (requestedMode !== "inline" && userPreferInlineRef.current) {
          logWidgetDebug("ui-to-host", "ui/request-display-mode", {
            requested: requestedMode,
            granted: "inline",
            reason: "user-prefers-inline",
          });
          return { mode: "inline" };
        }
        const hostAvailableModes = extractHostDisplayModes(
          hostContextRef.current as Record<string, unknown> | undefined
        );
        // Use device type for mobile detection (defaults to mobile-like behavior when not in playground)
        const isMobile = isPlaygroundActiveRef.current
          ? playgroundDeviceTypeRef.current === "mobile" ||
            playgroundDeviceTypeRef.current === "tablet"
          : true;
        const mobileAdjustedMode: DisplayMode =
          isMobile && requestedMode === "pip" ? "fullscreen" : requestedMode;
        const actualMode = clampDisplayModeToAvailableModes(
          mobileAdjustedMode,
          hostAvailableModes
        );

        setDisplayModeRef.current(actualMode);

        if (actualMode === "pip") {
          onRequestPipRef.current?.(toolCallIdRef.current);
        } else if (
          (actualMode === "inline" || actualMode === "fullscreen") &&
          pipWidgetIdRef.current === toolCallIdRef.current
        ) {
          onExitPipRef.current?.(toolCallIdRef.current);
        }

        return { mode: actualMode };
      };

      if (effectiveHostCapabilities.updateModelContext) {
        bridge.onupdatemodelcontext = async ({
          content,
          structuredContent,
        }) => {
          // Store in debug store for UI display
          setWidgetModelContext(toolCallId, {
            content,
            structuredContent,
          });

          // Notify parent component to queue for next model turn
          onModelContextUpdateRef.current?.(toolCallId, {
            content,
            structuredContent,
          });

          return {};
        };
      }

      // SEP-1865 `ui/download-file`: the view passes embedded resource
      // contents (`text` or `blob`) and/or resource links. The host
      // mediates the actual download since the iframe sandbox blocks
      // direct anchor-clicks. We use a Blob + object-URL anchor (no
      // confirmation prompt yet — opt-in confirmation is a follow-up).
      if (effectiveHostCapabilities.downloadFile) {
        bridge.ondownloadfile = async ({ contents }) => {
          try {
            for (const item of contents) {
              if (item.type === "resource" && item.resource) {
                const res = item.resource as {
                  uri: string;
                  text?: string;
                  blob?: string;
                  mimeType?: string;
                };
                const mimeType = res.mimeType ?? "application/octet-stream";
                let blob: Blob;
                if (typeof res.blob === "string") {
                  const binary = atob(res.blob);
                  const bytes = new Uint8Array(binary.length);
                  for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                  }
                  blob = new Blob([bytes], { type: mimeType });
                } else {
                  blob = new Blob([res.text ?? ""], { type: mimeType });
                }
                const url = URL.createObjectURL(blob);
                try {
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = res.uri.split("/").pop() ?? "download";
                  anchor.rel = "noopener";
                  document.body.appendChild(anchor);
                  anchor.click();
                  anchor.remove();
                } finally {
                  // Defer revocation so the browser has a chance to
                  // start the download before the object URL goes away.
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }
              } else if (item.type === "resource_link") {
                const link = item as { uri: string };
                // Refuse navigations that aren't a browser-fetchable scheme.
                // `javascript:`/`data:` here would execute in the host origin,
                // and MCP-style schemes (`ui://`, `file://`, server-defined)
                // need host-side resolution that this path doesn't do yet —
                // fail loud rather than silently opening an unusable tab.
                const parsed = new URL(link.uri, window.location.href);
                if (!["http:", "https:"].includes(parsed.protocol)) {
                  throw new Error(
                    `Unsupported download URI protocol: ${parsed.protocol}`
                  );
                }
                window.open(parsed.href, "_blank", "noopener,noreferrer");
              }
            }
            return {};
          } catch (err) {
            logWidgetDebug("ui-to-host", "ui/download-file", {
              error: err instanceof Error ? err.message : String(err),
            });
            return { isError: true };
          }
        };
      }

      // SEP-1865 `ui/notifications/request-teardown`: the view asks the
      // host to tear it down. Best-effort graceful close — fire
      // `teardownResource` so the view can persist state, then bubble
      // the request to the parent so it can actually unmount the
      // iframe. `requestTeardown` is a behavior gate on the matrix
      // (not a wire-advertised host capability); presets that set it
      // false simulate hosts that ignore view-initiated teardown
      // requests by leaving the handler unassigned, in which case the
      // SDK logs the notification but does nothing.
      if (mcpAppsCapabilitiesRef.current?.requestTeardown !== false) {
        bridge.onrequestteardown = async () => {
          logWidgetDebug("ui-to-host", "ui/notifications/request-teardown", {});
          try {
            await bridge.teardownResource({});
          } catch (err) {
            // Teardown best-effort; if the view never acks the
            // resource-teardown request we still proceed to unmount so
            // a misbehaving widget can't block its own removal.
            logWidgetDebug("host-to-ui", "ui/resource-teardown", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          onRequestTeardownRef.current?.(toolCallIdRef.current);
        };
      }
    },
    [
      setIsReady,
      toolCallId,
      setWidgetModelContext,
      logWidgetDebug,
      refreshAppProvidedTools,
      effectiveHostCapabilities,
    ]
  );

  useEffect(() => {
    if (!widgetHtml) return;
    if (!sandboxProxyReady) {
      logWidgetDebug("host-to-ui", "debug/bridge-connect-skipped", {
        reason: "sandbox-proxy-not-ready",
      });
      return;
    }
    const iframe = sandboxRef.current?.getIframeElement();
    if (!iframe?.contentWindow) {
      logWidgetDebug("host-to-ui", "debug/bridge-connect-skipped", {
        reason: "missing-iframe-content-window",
      });
      return;
    }

    setBridgeTransportReady(false);
    setIsReady(false);
    isReadyRef.current = false;
    logWidgetDebug("host-to-ui", "debug/bridge-connect-start", {
      cspMode,
      // Reflect the resolved (host-policy-applied) sandbox so the debug
      // panel matches what the iframe and bridge will actually see.
      hasCsp: !!effectiveSandbox.csp,
      hasPermissions: !!effectiveSandbox.permissions,
      htmlLength: widgetHtml.length,
      permissive: effectiveSandbox.permissive,
      hostPolicyApplied: effectiveSandbox.hostPolicyApplied,
      toolState: toolState ?? null,
    });

    // Sandbox policy is resolved once at component scope (see
    // `effectiveSandbox` above) and reused here so the AppBridge handshake
    // and the rendered <SandboxedIframe> stay in lockstep. Computing this
    // inline used to be the canonical correctness bug: the bridge got the
    // resolved policy while the iframe still got the raw resource
    // declaration, so the browser-enforced CSP didn't honor the host clamp.
    // Host identity advertised in ui/initialize. Templates that emulate
    // another host (e.g. ChatGPT) override this via
    // `mcpProfile.apps.uiInitialize.hostInfo`; backend soft-validates
    // name+version when set so the cast below is safe.
    const resolvedHostInfo = (resolveHostInfo(activeMcpProfile) ?? {
      name: "mcpjam-inspector",
      version: __APP_VERSION__,
    }) as { name: string; version: string };
    const bridge = new AppBridge(
      null,
      resolvedHostInfo,
      {
        ...effectiveHostCapabilities,
        sandbox: {
          csp: effectiveSandbox.csp,
          permissions: effectiveSandbox.permissions,
        },
      },
      { hostContext: hostContextRef.current ?? {} }
    );

    registerBridgeHandlers(bridge);
    bridgeRef.current = bridge;
    const pendingRpcMethods = new Map<string | number, string>();

    const transport = new LoggingTransport(
      new PostMessageTransport(iframe.contentWindow, iframe.contentWindow),
      {
        onSend: (message) => {
          const method = extractMethod(message, "mcp-apps");
          const request = message as { id?: string | number; method?: string };
          if (
            typeof request.method === "string" &&
            (typeof request.id === "string" || typeof request.id === "number")
          ) {
            pendingRpcMethods.set(request.id, request.method);
          }
          if (SUPPRESSED_UI_LOG_METHODS.has(method)) return;
          logUiEvent({
            widgetId: toolCallId,
            serverId,
            direction: "host-to-ui",
            protocol: "mcp-apps",
            method,
            message,
          });
        },
        onReceive: (message) => {
          const response = message as {
            id?: string | number;
            result?: unknown;
            error?: unknown;
          };
          const correlatedMethod =
            (response.result !== undefined || response.error !== undefined) &&
            (typeof response.id === "string" || typeof response.id === "number")
              ? pendingRpcMethods.get(response.id)
              : undefined;
          if (correlatedMethod && response.id !== undefined) {
            pendingRpcMethods.delete(response.id);
          }
          const method = correlatedMethod ?? extractMethod(message, "mcp-apps");
          if (method === "ui/notifications/size-changed") {
            signalStreamingRender();
          }
          if (method === "notifications/tools/list_changed") {
            const bridgeId = appToolsBridgeIdRef.current;
            if (bridgeId) {
              void refreshAppProvidedTools(bridge, bridgeId, { force: true });
            }
          }
          if (SUPPRESSED_UI_LOG_METHODS.has(method)) return;
          logUiEvent({
            widgetId: toolCallId,
            serverId,
            direction: "ui-to-host",
            protocol: "mcp-apps",
            method,
            message,
          });
        },
      }
    );

    let isActive = true;
    bridge
      .connect(transport)
      .then(() => {
        if (!isActive) return;
        setBridgeTransportReady(true);
        logWidgetDebug("host-to-ui", "debug/bridge-connect-ready", {
          htmlLength: widgetHtml.length,
        });
      })
      .catch((error) => {
        if (!isActive) return;
        const errorMessage =
          error instanceof Error ? error.message : "Failed to connect MCP App";
        setLoadError(errorMessage);
        logWidgetDebug("host-to-ui", "debug/bridge-connect-error", {
          error: errorMessage,
        });
      });

    return () => {
      isActive = false;
      logWidgetDebug("host-to-ui", "debug/bridge-connect-cleanup", {
        wasReady: isReadyRef.current,
      });
      bridgeRef.current = null;
      // SEP-1865 App-Provided Tools: drop this bridge's registration so
      // the next chat POST snapshot omits its aliases. Per spec: "Calling
      // a tool from a closed app MUST return an error" — once the bridge
      // is closed, any in-flight `useChat.onToolCall` dispatch resolves
      // to null in `useAppToolsRegistry.resolve()`.
      if (appToolsBridgeIdRef.current) {
        useAppToolsRegistry
          .getState()
          .unregisterInstance(appToolsBridgeIdRef.current);
        appToolsListedBridgeIdsRef.current.delete(appToolsBridgeIdRef.current);
        appToolsListInFlightBridgeIdsRef.current.delete(
          appToolsBridgeIdRef.current
        );
        appToolsListRefreshPendingBridgeIdsRef.current.delete(
          appToolsBridgeIdRef.current
        );
        appToolsBridgeIdRef.current = null;
        setAppToolsBridgeIdState(null);
      }
      if (isReadyRef.current) {
        bridge.teardownResource({}).catch(() => {});
      }
      bridge.close().catch(() => {});
      // Clear model context on widget teardown
      setWidgetModelContext(toolCallId, null);
    };
  }, [
    logUiEvent,
    minimalMode,
    serverId,
    toolCallId,
    widgetHtml,
    sandboxProxyReady,
    registerBridgeHandlers,
    refreshAppProvidedTools,
    setWidgetModelContext,
    cspMode,
    // Bridge must rebuild when the resolved sandbox policy changes — a host
    // toggling sandbox policy at runtime needs the new handshake. The memo
    // identity captures `widgetCsp`/`widgetPermissions`/`widgetPermissive`
    // and the sandbox slice of mcpProfile transitively.
    effectiveSandbox,
    logWidgetDebug,
    // Bridge must rebuild when the advertised host capabilities change
    // (host style switch or override edit) so the new handshake reflects
    // the new contract.
    effectiveHostCapabilities,
    // Bridge must rebuild when the host identity advertised in
    // ui/initialize changes — switching to a template that overrides
    // hostInfo (e.g. ChatGPT) is observable to the View.
    activeMcpProfile,
  ]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge || !isReady) return;
    // `bridge.setHostContext` updates the AppBridge's cached
    // `_hostContext` AND emits `ui/notifications/host-context-changed`
    // to the View. Matrix gate: Microsoft 365 Copilot does not
    // deliver this notification per its published Component-bridge
    // table (theme / displayMode updates are one-shot at
    // `ui/initialize` time on that host). Null matrix → default on.
    //
    // We still skip the call entirely when gated rather than only
    // suppressing the wire notification — the bridge's internal
    // cache also tracks `_hostContext`, but on Copilot-style hosts
    // the spec says it doesn't update mid-session, so keeping the
    // cache frozen matches the simulated host's behavior. (If a
    // future host wants the cache to update without emitting the
    // notification, we'll split this gate.)
    const matrix = mcpAppsCapabilitiesRef.current;
    if (matrix !== null && matrix.hostContextChanged === false) return;
    bridge.setHostContext(hostContext);
  }, [hostContext, isReady]);

  const handleCspViolation = useCallback(
    (event: MessageEvent) => {
      const data = event.data;
      if (!data) return;

      const {
        directive,
        blockedUri,
        sourceFile,
        lineNumber,
        columnNumber,
        effectiveDirective,
        timestamp,
      } = data;

      logUiEvent({
        widgetId: toolCallId,
        serverId,
        direction: "ui-to-host",
        protocol: "mcp-apps",
        method: "csp-violation",
        message: data,
      });

      addCspViolation(toolCallId, {
        directive,
        effectiveDirective,
        blockedUri,
        sourceFile,
        lineNumber,
        columnNumber,
        timestamp: timestamp || Date.now(),
      });

      if (!minimalMode) {
        console.warn(
          `[MCP Apps CSP Violation] ${directive}: Blocked ${blockedUri}`,
          sourceFile ? `at ${sourceFile}:${lineNumber}:${columnNumber}` : ""
        );
      }
    },
    [addCspViolation, logUiEvent, minimalMode, serverId, toolCallId]
  );

  const handleSandboxMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data) return;

    // Handle CSP violation messages (custom type)
    if (data.type === "mcp-apps:csp-violation") {
      handleCspViolation(event);
      return;
    }

    // Defense-in-depth: if the live capability matrix has the file ops
    // disabled, drop incoming `openai:uploadFile` / `getFileDownloadUrl`
    // messages from the iframe. The SDK runtime should already be
    // omitting these methods (so widgets that feature-detect take the
    // fallback path), but a widget that captured a method reference
    // before a host swap, or hand-crafted the postMessage, would still
    // reach here. Send a clear policy error back so the widget's
    // pending-call resolver rejects rather than hanging.
    //
    // STRICT `=== false` semantics: the persisted/sparse
    // `OpenAiAppsCapabilities` shape omits fields added after capture
    // time, and the SDK runtime treats missing as "default on"
    // (FULL_SURFACE_DEFAULT). Mirroring that here means an absent
    // field is allowed, not denied — only an explicit `false` triggers
    // the gate. `!liveCaps.foo` would lock out forward-compatible
    // legacy snapshots; `liveCaps.foo === false` matches the runtime.
    const liveCaps = liveOpenAiCompatCapabilitiesRef.current;
    const policyError = (
      callId: number,
      method: "openai:uploadFile" | "openai:getFileDownloadUrl"
    ) => {
      sandboxRef.current?.postMessage({
        type: `${method}:response`,
        callId,
        error: `${method} denied by host capability policy`,
      });
    };

    // Handle file upload messages (non-JSON-RPC, same protocol as ChatGPT widget)
    if (data.type === "openai:uploadFile") {
      if (liveCaps !== null && liveCaps.uploadFile === false) {
        policyError(data.callId, "openai:uploadFile");
        return;
      }
      void handleUploadFileMessage(data, (message) => {
        sandboxRef.current?.postMessage(message);
      });
      return;
    }

    if (data.type === "openai:getFileDownloadUrl") {
      if (liveCaps !== null && liveCaps.getFileDownloadUrl === false) {
        policyError(data.callId, "openai:getFileDownloadUrl");
        return;
      }
      handleGetFileDownloadUrlMessage(data, (message) => {
        sandboxRef.current?.postMessage(message);
      });
      return;
    }

    // Apps SDK widget-state persistence (forwarded from the compat
    // runtime in the inner iframe). Two destinations:
    //   1) onWidgetStateChange — propagates upward for saved-view /
    //      replay / fork persistence (matches the legacy
    //      ChatGPTAppRenderer contract).
    //   2) setWidgetStateStore — keeps the Debug "Widget State" panel
    //      live; without it, Apps SDK setWidgetState updates silently
    //      bypass the diagnostics surface that reads from
    //      widgetDebugInfo.widgetState.
    if (data.type === "openai:setWidgetState") {
      // Defense-in-depth: drop persistence + propagation when the
      // matrix has setWidgetState disabled. Silent drop (no response
      // message) — setWidgetState is fire-and-forget in the spec, so
      // there's nothing to reject. Mirrors the runtime-level omission.
      if (liveCaps !== null && liveCaps.setWidgetState === false) return;
      if (onWidgetStateChange) {
        onWidgetStateChange(toolCallId, data.state);
      }
      setWidgetStateStore(toolCallId, data.state);
      return;
    }

    // Handle openai/* JSON-RPC notifications from the compat layer
    if (
      data.jsonrpc === "2.0" &&
      typeof data.method === "string" &&
      data.method.startsWith("openai/")
    ) {
      logUiEvent({
        widgetId: toolCallId,
        serverId,
        direction: "ui-to-host",
        protocol: "mcp-apps",
        method: data.method,
        message: data,
      });

      // Defense-in-depth for the openai/* JSON-RPC notification family.
      // Same rationale as the file-op branch above: SDK runtime should
      // omit these methods, but a stale closure or hand-crafted
      // postMessage would still arrive. Silent drop on notifications;
      // requestCheckout uses a callId pattern so we respond with an
      // error so the widget's pending resolver doesn't hang.
      if (data.method === "openai/requestModal") {
        if (liveCaps !== null && liveCaps.requestModal === false) return;
        const params = data.params ?? {};
        setModalTitle(params.title || "Modal");
        setModalParams(params.params || {});
        setModalTemplate(params.template || null);
        setModalOpen(true);
      } else if (data.method === "openai/requestClose") {
        if (liveCaps !== null && liveCaps.requestClose === false) return;
        setModalOpen(false);
      } else if (data.method === "openai/requestCheckout") {
        const params = data.params ?? {};
        const { callId: cId, ...sessionData } = params;
        if (liveCaps !== null && liveCaps.requestCheckout === false) {
          sandboxRef.current?.postMessage({
            jsonrpc: "2.0",
            method: "openai/requestCheckout:response",
            params: {
              callId: cId,
              error: "openai/requestCheckout denied by host capability policy",
            },
          });
          return;
        }
        setCheckoutCallId(cId as number);
        setCheckoutSession(sessionData as unknown as CheckoutSession);
        setCheckoutOpen(true);
      }
    }
  };
  const showWidget = isReady && canRenderStreamingInput;

  useEffect(() => {
    logWidgetDebug("host-to-ui", "debug/widget-visibility", {
      bridgeTransportReady,
      canRenderStreamingInput,
      hasWidgetHtml,
      isReady,
      loadError,
      showWidget,
      toolState: toolState ?? null,
      widgetHtmlLength,
    });
  }, [
    bridgeTransportReady,
    canRenderStreamingInput,
    hasWidgetHtml,
    isReady,
    loadError,
    showWidget,
    toolState,
    widgetHtmlLength,
    logWidgetDebug,
  ]);

  useEffect(() => {
    if (!bridgeTransportReady || !widgetHtml) return;
    logWidgetDebug("host-to-ui", "debug/sandbox-html-ready", {
      hasCsp: !!effectiveSandbox.csp,
      hasPermissions: !!effectiveSandbox.permissions,
      htmlLength: widgetHtml.length,
      permissive: effectiveSandbox.permissive,
      hostPolicyApplied: effectiveSandbox.hostPolicyApplied,
    });
  }, [bridgeTransportReady, widgetHtml, effectiveSandbox, logWidgetDebug]);

  const respondToCheckout = useCallback(
    (result: unknown, error?: string) => {
      if (checkoutCallId == null) return;
      const params: Record<string, unknown> = { callId: checkoutCallId };
      if (error) {
        params.error = error;
      } else {
        params.result = result;
      }
      sandboxRef.current?.postMessage({
        jsonrpc: "2.0",
        method: "openai/requestCheckout:response",
        params,
      });
      setCheckoutOpen(false);
      setCheckoutSession(null);
      setCheckoutCallId(null);
    },
    [checkoutCallId]
  );

  // Denied state
  if (toolState === "output-denied") {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Tool execution was denied.
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
        Failed to load MCP App: {loadError}
      </div>
    );
  }

  if (!widgetHtml) {
    return null;
  }

  const isPip = effectiveDisplayMode === "pip";
  const isFullscreen = effectiveDisplayMode === "fullscreen";
  const isMobilePlaygroundMode =
    isPlaygroundActive && playgroundDeviceType === "mobile";
  const isContainedFullscreenMode =
    isPlaygroundActive &&
    (playgroundDeviceType === "mobile" || playgroundDeviceType === "tablet");

  const containerClassName = (() => {
    if (isFullscreen) {
      if (isContainedFullscreenMode) {
        return "absolute inset-0 z-10 w-full h-full bg-background flex flex-col";
      }
      return "fixed inset-0 z-40 w-full h-full bg-background flex flex-col";
    }

    if (isPip) {
      if (isMobilePlaygroundMode) {
        return "absolute inset-0 z-10 w-full h-full bg-background flex flex-col";
      }
      if (isPlaygroundActive) {
        return [
          "absolute top-4 left-1/2 -translate-x-1/2 z-40 w-full min-w-[300px] max-w-[min(90vw,1200px)] space-y-2",
          "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
          "shadow-xl border border-border/60 rounded-xl p-3",
        ].join(" ");
      }
      return [
        "fixed top-4 left-1/2 -translate-x-1/2 z-40 w-full min-w-[300px] max-w-[min(90vw,1200px)] space-y-2",
        "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        "shadow-xl border border-border/60 rounded-xl p-3",
      ].join(" ");
    }

    return "mt-3 space-y-2 relative group";
  })();
  const containerStyle: CSSProperties | undefined =
    !isFullscreen && !isPip && lastInlineWidthRef.current
      ? { width: lastInlineWidthRef.current, maxWidth: "100%" }
      : undefined;

  const canTransitionHeight =
    !isFullscreen && effectiveDisplayModeRef.current === effectiveDisplayMode;
  const iframeStyle: CSSProperties = {
    height: isFullscreen
      ? "100%"
      : isPip
      ? PIP_MAX_HEIGHT
      : lastInlineHeightRef.current,
    width: "100%",
    maxWidth: "100%",
    backgroundColor:
      !isFullscreen && matrixGatedPrefersBorder
        ? mergedStyleVariables["--color-background-primary"]
        : hostChatBackground ?? "transparent",
    opacity: showWidget ? 1 : 0,
    transition: [
      "opacity 150ms ease-in",
      canTransitionHeight ? "height 300ms ease-out" : "",
    ]
      .filter(Boolean)
      .join(", "),
    // Keep iframe in the layout but invisible while not ready
    ...(!showWidget
      ? { position: "absolute" as const, pointerEvents: "none" as const }
      : {}),
  };
  const showHostChrome = !isFullscreen && matrixGatedPrefersBorder;
  const hostChromeStyle: CSSProperties | undefined = showHostChrome
    ? {
        backgroundColor: mergedStyleVariables["--color-background-primary"],
      }
    : undefined;
  const iframe = (
    <SandboxedIframe
      ref={sandboxRef}
      html={bridgeTransportReady ? widgetHtml : null}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      // Browser-enforced CSP / Permission Policy MUST receive the resolved
      // values, not the raw resource declaration. `effectiveSandbox` runs the
      // shared resolver (mode → restrictTo intersect → hosted-mode clamp);
      // when a host policy applies it forces
      // `permissive: false` so SandboxedIframe injects the meta-CSP rather
      // than skipping it. Passing `widgetCsp` here directly is the canonical
      // regression — keep the resolver path.
      csp={effectiveSandbox.csp}
      permissions={effectiveSandbox.permissions}
      permissive={effectiveSandbox.permissive}
      sandboxAttrs={effectiveSandbox.sandboxAttrs}
      allowFeatures={effectiveSandbox.allowFeatures}
      cspDirectives={effectiveSandbox.cspDirectives}
      colorScheme={resolvedTheme}
      onProxyReady={() => {
        setSandboxProxyReady(true);
        logWidgetDebug("ui-to-host", "debug/sandbox-proxy-ready", {
          bridgeTransportReady,
          hasWidgetHtml,
        });
      }}
      onMessage={handleSandboxMessage}
      title={`MCP App: ${toolName}`}
      className={`bg-transparent overflow-hidden ${
        isFullscreen
          ? "flex-1 border-0 rounded-none"
          : `rounded-md ${
              matrixGatedPrefersBorder ? "border border-border/40" : ""
            }`
      }`}
      style={iframeStyle}
    />
  );

  return (
    <div
      ref={containerRef}
      className={containerClassName}
      style={containerStyle}
    >
      {((isFullscreen && isContainedFullscreenMode) ||
        (isPip && isMobilePlaygroundMode)) && (
        <button
          onClick={() => {
            userPreferInlineRef.current = true;
            setDisplayMode("inline");
            if (isPip) {
              onExitPip?.(toolCallId);
            }
            // onExitFullscreen is called within setDisplayMode when leaving fullscreen
          }}
          className="absolute left-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-black/20 hover:bg-black/40 text-white transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      )}

      {isFullscreen && !isContainedFullscreenMode && (
        <div className="flex items-center justify-between px-4 h-14 border-b border-border/40 bg-background/95 backdrop-blur z-40 shrink-0">
          <div />
          <div className="font-medium text-sm text-muted-foreground">
            {toolName}
          </div>
          <button
            onClick={() => {
              userPreferInlineRef.current = true;
              setDisplayMode("inline");
              if (pipWidgetId === toolCallId) {
                onExitPip?.(toolCallId);
              }
            }}
            className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Exit fullscreen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {isPip && !isMobilePlaygroundMode && (
        <button
          onClick={() => {
            userPreferInlineRef.current = true;
            setDisplayMode("inline");
            onExitPip?.(toolCallId);
          }}
          className="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label="Close PiP mode"
          title="Close PiP mode"
        >
          <X className="w-4 h-4" />
        </button>
      )}
      {/* Keep this wrapper mounted so display-mode changes don't remount the
       * sandbox iframe and strand the bridge on the old contentWindow. */}
      <div
        data-testid={showHostChrome ? "mcp-app-host-chrome" : undefined}
        className={showHostChrome ? "rounded-md" : "contents"}
        style={hostChromeStyle}
      >
        {iframe}
      </div>
      {/* SEP-1865 App-Provided Tools: per-iframe busy indicator. Surfaces
       * when the host is dispatching `tools/call` into this iframe (the
       * count comes from `useAppToolsRegistry.pendingControllers`). Sits
       * in the top-right of the inline container; suppressed in
       * fullscreen because the fullscreen header already names the tool
       * and would crowd this overlay. */}
      {pendingAppToolCalls > 0 && !isFullscreen && (
        <div
          className="pointer-events-none absolute right-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 border border-border/50 text-muted-foreground shadow-sm"
          aria-label="App tool call in progress"
          title="App tool call in progress"
          data-testid="mcp-app-busy-indicator"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        </div>
      )}

      <McpAppsModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title={modalTitle}
        template={modalTemplate}
        params={modalParams}
        registerBridgeHandlers={registerBridgeHandlers}
        // SEP-1865 App-Provided Tools: the modal bridge replaces
        // `oninitialized` to suppress inline-state side effects, which
        // also drops the inline registration call. The modal owns its
        // own bridge-id and `surface: "modal"` registration; pass the
        // shared refresh helper down so the modal can advertise/refresh
        // its iframe's tools without re-implementing the listTools loop.
        refreshAppProvidedTools={refreshAppProvidedTools}
        // The modal mounts its own SandboxedIframe via `fetchMcpAppsWidgetContent`.
        // Pass the resolved values so the modal's CSP enforcement matches the
        // inline iframe — otherwise a host restrictTo intersection applies to
        // inline but not to a modal-mode widget reading the same resource.
        widgetCsp={effectiveSandbox.csp}
        widgetPermissions={effectiveSandbox.permissions}
        widgetPermissive={effectiveSandbox.permissive}
        widgetSandboxAttrs={effectiveSandbox.sandboxAttrs}
        widgetAllowFeatures={effectiveSandbox.allowFeatures}
        widgetCspDirectives={effectiveSandbox.cspDirectives}
        hostContextRef={hostContextRef}
        serverId={serverId}
        resourceUri={resourceUri}
        toolCallId={toolCallId}
        toolName={toolName}
        cspMode={cspMode}
        injectOpenAiCompat={effectiveInjectOpenAiCompat}
        // Same resolved blob the inline AppBridge advertises. Inline +
        // modal must speak an identical surface to the widget so
        // app.getHostCapabilities() returns the same record regardless
        // of which iframe the widget is mounted in.
        effectiveHostCapabilities={effectiveHostCapabilities}
        toolInputRef={toolInputRef}
        toolOutputRef={toolOutputRef}
        themeModeRef={themeModeRef}
        addUiLog={(log) =>
          logUiEvent({
            ...log,
            protocol: "mcp-apps" as UiProtocol,
          })
        }
        onCspViolation={handleCspViolation}
      />

      {checkoutSession && (
        <CheckoutDialogV2
          session={checkoutSession}
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          onComplete={(result) => respondToCheckout(result)}
          onError={(error) => respondToCheckout(null, error)}
          onCancel={() => respondToCheckout(null, "User cancelled checkout")}
          onCallTool={async (toolName, params) => {
            if (!onCallTool) {
              throw new Error("Tool calls not supported");
            }
            return onCallTool(toolName, params);
          }}
        />
      )}
    </div>
  );
}
