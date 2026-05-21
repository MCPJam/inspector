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
import { X } from "lucide-react";
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
import {
  DEFAULT_HOST_STYLE,
  getHostStyleOrDefault,
} from "@/lib/client-styles";
import type { ResolvedOpenAiAppsCapabilities } from "@/lib/client-styles";
import { isVisibleToModelOnly } from "@/lib/mcp-ui/mcp-apps-utils";
import { LoggingTransport } from "./mcp-apps-logging-transport";
import { McpAppsModal } from "./mcp-apps-modal";
import {
  handleGetFileDownloadUrlMessage,
  handleUploadFileMessage,
} from "./widget-file-messages";
import { CheckoutDialogV2 } from "./checkout-dialog-v2";
import { fetchMcpAppsWidgetContent } from "./fetch-widget-content";
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
  resolveHostInfo,
} from "@/lib/client-config-v2";

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
  variables: unknown,
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
    params: Record<string, unknown>,
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
    },
  ) => void;
  /** Callback when app declares its supported display modes during ui/initialize */
  onAppSupportedDisplayModesChange?: (modes: DisplayMode[] | undefined) => void;
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
  details: Record<string, unknown>,
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
  isOffline,
  cachedWidgetHtmlUrl,
  liveFetchPreferred,
  widgetCsp: initialWidgetCsp,
  widgetPermissions: initialWidgetPermissions,
  widgetPermissive: initialWidgetPermissive,
  prefersBorder: initialPrefersBorder,
  injectedOpenAiCompat: initialInjectedOpenAiCompat,
  initialWidgetState,
  minimalMode = false,
}: MCPAppsRendererProps) {
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
    [draftHostContext],
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
    [draftHostContext],
  );
  const configuredAvailableDisplayModes = useMemo(
    () => extractHostDisplayModes(draftHostContext),
    [draftHostContext],
  );

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
    (s) => s.safeAreaInsets,
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
      configuredAvailableDisplayModes,
    ),
  );
  const displayMode = isControlled ? displayModeProp : internalDisplayMode;
  const requestedDisplayMode = useMemo<DisplayMode>(() => {
    if (!isControlled) return displayMode;
    if (displayMode === "fullscreen" && fullscreenWidgetId === toolCallId)
      return "fullscreen";
    if (displayMode === "pip" && pipWidgetId === toolCallId) return "pip";
    return "inline";
  }, [displayMode, fullscreenWidgetId, isControlled, pipWidgetId, toolCallId]);
  const effectiveDisplayMode = useMemo<DisplayMode>(
    () =>
      clampDisplayModeToAvailableModes(
        requestedDisplayMode,
        configuredAvailableDisplayModes,
      ),
    [configuredAvailableDisplayModes, requestedDisplayMode],
  );
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
    ],
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
  // Cached replays use `null` so legacy snapshots without persisted
  // capability provenance don't constantly mismatch the live state.
  const widgetCompatCapabilitiesReloadKey =
    isCachedReplay || !effectiveInjectOpenAiCompat
      ? null
      : stableStringifyJson(liveOpenAiCompatCapabilities ?? null);
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
    isCachedReplay ? undefined : (initialWidgetCsp ?? undefined),
  );
  const [widgetPermissions, setWidgetPermissions] = useState<
    McpUiResourcePermissions | undefined
  >(isCachedReplay ? undefined : (initialWidgetPermissions ?? undefined));
  const [widgetPermissive, setWidgetPermissive] = useState<boolean>(
    isCachedReplay ? true : (initialWidgetPermissive ?? false),
  );
  const [prefersBorder, setPrefersBorder] = useState<boolean>(
    initialPrefersBorder ?? true,
  );
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
  const [
    loadedCompatCapabilitiesHash,
    setLoadedCompatCapabilitiesHash,
  ] = useState<string | null>(null);
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
    setWidgetCsp(isCachedReplay ? undefined : (initialWidgetCsp ?? undefined));
    setWidgetPermissions(
      isCachedReplay ? undefined : (initialWidgetPermissions ?? undefined),
    );
    setWidgetPermissive(
      isCachedReplay ? true : (initialWidgetPermissive ?? false),
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

  const onSendFollowUpRef = useRef(onSendFollowUp);
  const onCallToolRef = useRef(onCallTool);
  const onRequestPipRef = useRef(onRequestPip);
  const onExitPipRef = useRef(onExitPip);
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
    onAppSupportedDisplayModesChange,
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
      loadedCompatCapabilitiesHash === widgetCompatCapabilitiesReloadKey
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
        prev === null ? "initial" : describeFetchSourceKeyDiff(prev, fetchSourceKey);
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
          `Failed to fetch cached widget HTML: ${cachedResponse.statusText}`,
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
      // No persisted capability provenance on the cached blob yet —
      // mark the surface unknown. Pair with the cached boolean reload
      // key (`null` for legacy replays) so live-host per-method changes
      // don't trigger spurious refetches against byte-frozen HTML.
      // Phase 3 will pull a persisted `injectedOpenAiCompatCapabilities`
      // from the saved-view metadata when present.
      setLoadedCompatCapabilitiesHash(
        isCachedReplay ? null : widgetCompatCapabilitiesReloadKey,
      );
      setWidgetHtmlStore(
        toolCallId,
        html,
        loadedCachedCompatKey ?? undefined,
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

      // Stale fetch: source key moved on (e.g. session swap, CSP toggle,
      // tool call change) while this request was in flight. Drop the
      // result so it can't overwrite the newer commit's state.
      if (!isStillCurrent()) return true;

      if (!valid) {
        const errorMessage =
          warning ||
          `Invalid mimetype - SEP-1865 requires "text/html;profile=mcp-app"`;
        setLoadError(errorMessage);
        logWidgetDebug(
          "host-to-ui",
          "debug/widget-content-invalid-mimetype",
          { cspMode, error: errorMessage },
        );
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

      // Store widget HTML in debug store for save view feature. Stamp the
      // resolved flag alongside it so saved views can persist what was
      // actually injected at fetch time.
      setWidgetHtmlStore(toolCallId, html, resolvedInjectedOpenAiCompat);

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
            logWidgetDebug(
              "host-to-ui",
              "debug/widget-content-live-fallback",
              {
                error:
                  liveErr instanceof Error
                    ? liveErr.message
                    : String(liveErr),
              },
            );
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
    [addUiLog, minimalMode],
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
      details: Record<string, unknown>,
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
    [],
  );

  // Widget debug store
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);
  const setWidgetStateStore = useWidgetDebugStore((s) => s.setWidgetState);
  const setWidgetCspStore = useWidgetDebugStore((s) => s.setWidgetCsp);
  const addCspViolation = useWidgetDebugStore((s) => s.addCspViolation);
  const clearCspViolations = useWidgetDebugStore((s) => s.clearCspViolations);
  const setWidgetModelContext = useWidgetDebugStore(
    (s) => s.setWidgetModelContext,
  );
  const setWidgetHtmlStore = useWidgetDebugStore((s) => s.setWidgetHtml);
  const setSandboxAppliedStore = useWidgetDebugStore(
    (s) => s.setSandboxApplied,
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
      loadedCompatCapabilitiesHash !== null &&
      loadedCompatCapabilitiesHash !== widgetCompatCapabilitiesReloadKey;
    if (injectionChanged || capabilitiesChanged) {
      clearCspViolations(toolCallId);
    }
  }, [
    widgetInjectOpenAiCompatReloadKey,
    loadedInjectOpenAiCompat,
    widgetCompatCapabilitiesReloadKey,
    loadedCompatCapabilitiesHash,
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
      loadedCompatCapabilitiesHash !== null &&
      loadedCompatCapabilitiesHash !== widgetCompatCapabilitiesReloadKey;
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
    resetStreamingState,
  ]);

  // Sync displayMode from playground store when it changes (SEP-1865)
  // Only sync when not in controlled mode (parent controls displayMode via props)
  useEffect(() => {
    if (isPlaygroundActive && !isControlled) {
      setInternalDisplayMode(
        clampDisplayModeToAvailableModes(
          configuredDisplayMode ?? playgroundDisplayMode,
          configuredAvailableDisplayModes,
        ),
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
  // Ref-route the live `window.openai` capability surface so
  // `registerBridgeHandlers` can read the current value without
  // forcing the entire callback to rebuild on every host swap. The
  // bridge is registered once per iframe mount; downstream code reads
  // through this ref for defense-in-depth gates that mirror the shim
  // surface onto bridge handlers. Null when the shim isn't injected.
  const liveOpenAiCompatCapabilitiesRef = useRef<
    ResolvedOpenAiAppsCapabilities | null
  >(liveOpenAiCompatCapabilities);
  liveOpenAiCompatCapabilitiesRef.current = liveOpenAiCompatCapabilities;

  const effectiveHostCapabilities = useMemo(
    () =>
      resolveEffectiveHostCapabilities({
        hostStyle: effectiveHostStyle,
        hostCapabilitiesOverride,
      }),
    [effectiveHostStyle, hostCapabilitiesOverride],
  );
  themeModeRef.current = resolvedTheme;
  const styleVariables = useMemo(
    () => hostStyleDefinition.mcp.resolveStyleVariables(resolvedTheme),
    [resolvedTheme, hostStyleDefinition],
  );
  const hostChatBackground = useMemo(
    () => hostStyleDefinition.chatUi.resolveChatBackground(resolvedTheme),
    [hostStyleDefinition, resolvedTheme],
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
    [configuredStyles?.variables],
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
    [configuredStyles, defaultFontCss, mergedStyleVariables],
  );

  // containerDimensions (maxWidth/maxHeight) was previously sent here but
  // removed — width is now fully host-controlled.
  const hostContext = useMemo<McpUiHostContext>(
    () => ({
      ...baseHostContext,
      theme: resolvedTheme,
      displayMode: effectiveDisplayMode,
      availableDisplayModes: configuredAvailableDisplayModes,
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
      toolInfo: {
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
      },
    }),
    [
      baseHostContext,
      resolvedTheme,
      effectiveDisplayMode,
      configuredAvailableDisplayModes,
      locale,
      timeZone,
      deviceCapabilities,
      safeAreaInsets,
      mergedStyles,
      hostStyleDefinition,
      toolCallId,
      toolName,
      toolMetadata,
    ],
  );

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
  const sandboxPermissionsPolicy =
    activeMcpProfile?.apps?.sandbox?.permissions;
  // Inspector-only emission knobs sourced directly from the profile. They
  // bypass the SEP-1865 resolver because they model browser-emission state
  // that has no spec slot (raw `sandbox=`/`allow=` tokens, CSP source
  // expressions). Passed through unchanged to <SandboxedIframe>.
  const sandboxAttrsPolicy =
    activeMcpProfile?.apps?.sandbox?.sandboxAttrs;
  const allowFeaturesPolicy =
    activeMcpProfile?.apps?.sandbox?.allowFeatures;
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
        (list) => Array.isArray(list) && list.length > 0,
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
          }),
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
        if (widgetPermissions && typeof widgetPermissions === "object") {
          for (const [k, v] of Object.entries(
            widgetPermissions as Record<string, unknown>,
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
        permissions: resolvedPermissions ?? widgetPermissions,
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
        resourceCsp: widgetCsp,
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
        hostDefaultBaseline: widgetCsp,
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
      if (widgetPermissions && typeof widgetPermissions === "object") {
        for (const [k, v] of Object.entries(
          widgetPermissions as Record<string, unknown>,
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
      csp: isPureRelaxedCsp
        ? undefined
        : (resolvedCsp ?? (widgetPermissive ? undefined : widgetCsp)),
      permissions: resolvedPermissions ?? widgetPermissions,
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
    widgetCsp,
    widgetPermissions,
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
  const sandboxHostInfo = useMemo<
    { name: string; version: string } | null
  >(() => {
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
      sandboxHostInfo,
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
  //                                  — gated by a separate `downloadFile`
  //                                    cap that no template advertises and
  //                                    no chip surfaces today
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
        onAppSupportedDisplayModesChangeRef.current?.(
          appCaps?.availableDisplayModes as DisplayMode[] | undefined,
        );
        // If the guest re-initialized (e.g. an SDK-based app completing its
        // own handshake after the openai-compat shim already initialized),
        // bump reinitCount so the delivery effects re-send tool data.
        if (wasReady) {
          setReinitCount((c) => c + 1);
        }
      };

      // Defense-in-depth: when the `window.openai` shim IS injected,
      // also gate the bridge handlers by the per-method capability
      // matrix. SEP-1865 widgets bridge `app.*` calls through this
      // path; widgets that use both surfaces would otherwise see a
      // capability advertised as "off" succeed via the bridge while
      // failing via `window.openai`. When the shim is OFF (Claude /
      // Cursor / Codex), `compatCaps` is null and gates are unchanged
      // (preserves today's behavior). See plan §6 + the
      // feedback_feature_detection_over_rejection memory.
      const compatCaps = liveOpenAiCompatCapabilitiesRef.current;
      const shimMessageAllowed =
        compatCaps === null ? true : compatCaps.sendFollowUpMessage;
      const shimOpenExternalAllowed =
        compatCaps === null ? true : compatCaps.openExternal;
      const shimCallToolAllowed =
        compatCaps === null ? true : compatCaps.callTool;

      if (effectiveHostCapabilities.message && shimMessageAllowed) {
        bridge.onmessage = async ({ content }) => {
          const textContent = content.find(
            (item) => item.type === "text",
          )?.text;
          if (textContent) {
            onSendFollowUpRef.current?.(textContent);
          }
          return {};
        };
      }

      if (effectiveHostCapabilities.openLinks && shimOpenExternalAllowed) {
        bridge.onopenlink = async ({ url }) => {
          if (url) {
            window.open(url, "_blank", "noopener,noreferrer");
          }
          return {};
        };
      }

      if (effectiveHostCapabilities.serverTools && shimCallToolAllowed) {
        bridge.oncalltool = async ({ name, arguments: args }, _extra) => {
          // Check if tool is model-only (not callable by apps) per SEP-1865
          const calledToolMeta = toolsMetadataRef.current?.[name];
          if (isVisibleToModelOnly(calledToolMeta)) {
            const error = new Error(
              `Tool "${name}" is not callable by apps (visibility: model-only)`,
            );
            bridge.sendToolCancelled({ reason: error.message });
            throw error;
          }

          if (!onCallToolRef.current) {
            const error = new Error("Tool calls not supported");
            bridge.sendToolCancelled({ reason: error.message });
            throw error;
          }

          try {
            const result = await onCallToolRef.current(
              name,
              (args ?? {}) as Record<string, unknown>,
            );
            return result as CallToolResult;
          } catch (error) {
            // SEP-1865: Send tool-cancelled for failed app-initiated tool calls
            bridge.sendToolCancelled({
              reason: error instanceof Error ? error.message : String(error),
            });
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
            (params as { cursor?: string } | undefined)?.cursor,
          );
        };

        bridge.onlistresourcetemplates = async (_params) => {
          if (HOSTED_MODE) {
            throw new Error(
              "Resource templates are not supported in hosted mode",
            );
          }

          const response = await authFetch(
            `/api/mcp/resource-templates/list`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                serverId: serverIdRef.current,
              }),
            },
          );
          if (!response.ok) {
            throw new Error(
              `Resource template list failed: ${response.statusText}`,
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

      // Width resize handling was removed here — previously this destructured
      // `width` and applied it to the iframe via `min(${width}px, 100%)`.
      // Only height-based auto-resize is applied; width is host-controlled.
      bridge.onsizechange = ({ height }) => {
        if (effectiveDisplayModeRef.current !== "inline") return;
        const iframe = sandboxRef.current?.getIframeElement();
        if (!iframe || height === undefined) return;

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

        iframe.animate([from, to], { duration: 300, easing: "ease-out" });
        // size-changed fires on every resize/animation tick — chatty widgets
        // can flood the traffic log. The corresponding ui/notifications/
        // size-changed transport message is already suppressed above; rely on
        // that for diagnostics rather than a host-side debug log here.
      };

      bridge.onrequestdisplaymode = async ({ mode }) => {
        const requestedMode = mode ?? "inline";
        const hostAvailableModes = extractHostDisplayModes(
          hostContextRef.current as Record<string, unknown> | undefined,
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
          hostAvailableModes,
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
    },
    [
      setIsReady,
      toolCallId,
      setWidgetModelContext,
      logWidgetDebug,
      effectiveHostCapabilities,
    ],
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
      { hostContext: hostContextRef.current ?? {} },
    );

    registerBridgeHandlers(bridge);
    bridgeRef.current = bridge;

    const transport = new LoggingTransport(
      new PostMessageTransport(iframe.contentWindow, iframe.contentWindow),
      {
        onSend: (message) => {
          const method = extractMethod(message, "mcp-apps");
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
          const method = extractMethod(message, "mcp-apps");
          if (method === "ui/notifications/size-changed") {
            signalStreamingRender();
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
      },
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
          sourceFile ? `at ${sourceFile}:${lineNumber}:${columnNumber}` : "",
        );
      }
    },
    [addCspViolation, logUiEvent, minimalMode, serverId, toolCallId],
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
    const liveCaps = liveOpenAiCompatCapabilitiesRef.current;
    const policyError = (
      callId: number,
      method: "openai:uploadFile" | "openai:getFileDownloadUrl",
    ) => {
      sandboxRef.current?.postMessage({
        type: `${method}:response`,
        callId,
        error: `${method} denied by host capability policy`,
      });
    };

    // Handle file upload messages (non-JSON-RPC, same protocol as ChatGPT widget)
    if (data.type === "openai:uploadFile") {
      if (liveCaps !== null && !liveCaps.uploadFile) {
        policyError(data.callId, "openai:uploadFile");
        return;
      }
      void handleUploadFileMessage(data, (message) => {
        sandboxRef.current?.postMessage(message);
      });
      return;
    }

    if (data.type === "openai:getFileDownloadUrl") {
      if (liveCaps !== null && !liveCaps.getFileDownloadUrl) {
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
      if (liveCaps !== null && !liveCaps.setWidgetState) return;
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
        if (liveCaps !== null && !liveCaps.requestModal) return;
        const params = data.params ?? {};
        setModalTitle(params.title || "Modal");
        setModalParams(params.params || {});
        setModalTemplate(params.template || null);
        setModalOpen(true);
      } else if (data.method === "openai/requestClose") {
        if (liveCaps !== null && !liveCaps.requestClose) return;
        setModalOpen(false);
      } else if (data.method === "openai/requestCheckout") {
        const params = data.params ?? {};
        const { callId: cId, ...sessionData } = params;
        if (liveCaps !== null && !liveCaps.requestCheckout) {
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
  }, [
    bridgeTransportReady,
    widgetHtml,
    effectiveSandbox,
    logWidgetDebug,
  ]);

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
    [checkoutCallId],
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

  const canTransitionHeight =
    !isFullscreen &&
    effectiveDisplayModeRef.current === effectiveDisplayMode;
  const iframeStyle: CSSProperties = {
    height: isFullscreen
      ? "100%"
      : isPip
        ? PIP_MAX_HEIGHT
        : lastInlineHeightRef.current,
    width: "100%",
    maxWidth: "100%",
    backgroundColor:
      !isFullscreen && prefersBorder
        ? mergedStyleVariables["--color-background-primary"]
        : (hostChatBackground ?? "transparent"),
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
  const showHostChrome = !isFullscreen && prefersBorder;
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
          : `rounded-md ${prefersBorder ? "border border-border/40" : ""}`
      }`}
      style={iframeStyle}
    />
  );

  return (
    <div className={containerClassName}>

      {((isFullscreen && isContainedFullscreenMode) ||
        (isPip && isMobilePlaygroundMode)) && (
        <button
          onClick={() => {
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

      <McpAppsModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title={modalTitle}
        template={modalTemplate}
        params={modalParams}
        registerBridgeHandlers={registerBridgeHandlers}
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
