import { useState } from "react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import { ChatGPTAppRenderer } from "./chatgpt-app-renderer";
import { MCPAppsRenderer } from "./mcp-apps/mcp-apps-renderer";
import type { ToolState } from "./mcp-apps/useToolInputStreaming";
import type { ToolRenderOverride } from "./tool-render-overrides";
import {
  detectUIType,
  getUIResourceUri,
  UIType,
} from "@/lib/mcp-ui/mcp-apps-utils";
import { getToolServerId, type ToolServerMap } from "@/lib/apis/mcp-tools-api";
import {
  readToolResultMeta,
  readToolResultServerId,
} from "@/lib/tool-result-utils";
import { useChatboxHostStyle } from "@/contexts/chatbox-host-style-context";
import { getChatboxProtocolOverride } from "@/lib/chatbox-host-style";
import type { DisplayMode } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";
import { resolveOpenAiCompatEnabled } from "@/lib/host-config-v2";

export interface WidgetReplayProps {
  toolName: string;
  toolCallId?: string;
  toolState?: ToolState;
  toolInput?: Record<string, unknown> | null;
  toolOutput?: unknown;
  rawOutput?: unknown;
  toolErrorText?: string;
  toolMetadata?: Record<string, unknown>;
  toolsMetadata?: Record<string, Record<string, any>>;
  toolServerMap?: ToolServerMap;
  renderOverride?: ToolRenderOverride;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    },
  ) => void;
  pipWidgetId?: string | null;
  fullscreenWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
  onRequestFullscreen?: (toolCallId: string) => void;
  onExitFullscreen?: (toolCallId: string) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onAppSupportedDisplayModesChange?: (modes: DisplayMode[] | undefined) => void;
  selectedProtocolOverrideIfBothExists?: UIType;
  minimalMode?: boolean;
  /**
   * Stage 2 advisory-banner action. Invoked when the user clicks
   * "Enable on this profile" on an OpenAI-SDK widget rendered with
   * `enabled === false`. The handler is expected to patch the active
   * hostConfig (`mcpProfile.apps.compat.openai.enabled = true`) — the
   * widget keeps rendering either way (banner is non-blocking per Stage
   * 2 hard constraint #7). When omitted the banner still shows but the
   * button is disabled.
   *
   * Different scopes wire this differently: hosted bootstrap patches a
   * session-scoped override; in-inspector flows patch the project
   * default through the host config editor mutation. The dispatcher
   * doesn't know which scope owns the active profile.
   */
  onEnableOpenAiCompat?: () => void;
}

export function WidgetReplay({
  toolName,
  toolCallId,
  toolState,
  toolInput,
  toolOutput,
  rawOutput,
  toolErrorText,
  toolMetadata,
  toolsMetadata = {},
  toolServerMap = {},
  renderOverride,
  onSendFollowUp,
  onCallTool,
  onWidgetStateChange,
  onModelContextUpdate,
  pipWidgetId,
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  onRequestFullscreen,
  onExitFullscreen,
  displayMode,
  onDisplayModeChange,
  onAppSupportedDisplayModesChange,
  selectedProtocolOverrideIfBothExists,
  minimalMode = false,
  onEnableOpenAiCompat,
}: WidgetReplayProps) {
  // Stage 2.6: dismissed flag for the advisory banner. Per-session only
  // (not persisted) so the next mount re-evaluates against the live
  // hostConfig — if the user enabled compat through the editor in the
  // meantime, the banner is gone and the widget renders normally
  // without window.openai gating noise.
  const [openAiCompatBannerDismissed, setOpenAiCompatBannerDismissed] =
    useState(false);
  const chatboxHostStyle = useChatboxHostStyle();
  const protocolOverride =
    selectedProtocolOverrideIfBothExists ??
    getChatboxProtocolOverride(chatboxHostStyle) ??
    UIType.OPENAI_SDK;
  const effectiveToolMeta =
    renderOverride?.toolMetadata ??
    toolMetadata ??
    readToolResultMeta(rawOutput);
  const resolvedToolOutput = toolOutput ?? rawOutput;
  const uiType = detectUIType(effectiveToolMeta, rawOutput ?? toolOutput);
  const uiResourceUri =
    renderOverride?.resourceUri ?? getUIResourceUri(uiType, effectiveToolMeta);
  const serverId =
    renderOverride?.serverId ??
    getToolServerId(toolName, toolServerMap) ??
    readToolResultServerId(rawOutput);
  const hasCachedHtmlForOffline = !!renderOverride?.cachedWidgetHtmlUrl;

  // Stage 2 dispatcher routing. Default off — when the flag flips ON,
  // OpenAI Apps SDK widgets are rendered through `MCPAppsRenderer` (the
  // canonical Stage 4 renderer) instead of `ChatGPTAppRenderer`. The
  // legacy renderer stays in the tree (default route) so a soak failure
  // can be rolled back by flipping the flag off — no code revert needed.
  // Stage 4 deletes the legacy branch entirely.
  const preferUnifiedWidgetRenderer = usePreferencesStore(
    (s) => s.preferUnifiedWidgetRenderer,
  );
  const activeMcpProfile = useActiveMcpProfile();
  // `openAiCompatEnabled` is the single value four consumers read: server
  // `injectOpenAICompat` (via the fetcher), in-iframe advertisement
  // (Stage 3), the advisory banner (2.6 below), and per-handler
  // enforcement (Stage 3). When `chatboxHostStyle` is null (no hosted
  // context yet) the resolver isn't safe to call — fall back to false
  // so we don't claim window.openai is on before the bootstrap envelope
  // settles. See `resolveOpenAiCompatEnabled` docstring for why the
  // resolver takes a non-optional hostStyle.
  const openAiCompatEnabled = chatboxHostStyle
    ? resolveOpenAiCompatEnabled({
        mcpProfile: activeMcpProfile,
        hostStyle: chatboxHostStyle,
      })
    : false;

  const shouldRouteOpenAiThroughUnifiedRenderer =
    preferUnifiedWidgetRenderer &&
    (uiType === UIType.OPENAI_SDK ||
      (uiType === UIType.OPENAI_SDK_AND_MCP_APPS &&
        protocolOverride === UIType.OPENAI_SDK));

  if (
    !shouldRouteOpenAiThroughUnifiedRenderer &&
    (uiType === UIType.OPENAI_SDK ||
      (uiType === UIType.OPENAI_SDK_AND_MCP_APPS &&
        protocolOverride === UIType.OPENAI_SDK))
  ) {
    if (
      toolState !== "output-available" &&
      toolState !== "approval-requested" &&
      toolState !== "output-denied"
    ) {
      return (
        <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
          Waiting for tool to finish executing...
        </div>
      );
    }

    if (!serverId && !hasCachedHtmlForOffline) {
      return (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
          Failed to load tool server id.
        </div>
      );
    }

    return (
      <ChatGPTAppRenderer
        serverId={serverId ?? "offline-view"}
        toolCallId={toolCallId}
        toolName={toolName}
        toolState={toolState}
        toolInput={toolInput ?? null}
        toolOutput={resolvedToolOutput ?? null}
        toolMetadata={effectiveToolMeta ?? undefined}
        onSendFollowUp={onSendFollowUp}
        onCallTool={onCallTool}
        onWidgetStateChange={onWidgetStateChange}
        pipWidgetId={pipWidgetId}
        fullscreenWidgetId={fullscreenWidgetId}
        onRequestPip={onRequestPip}
        onExitPip={onExitPip}
        onRequestFullscreen={onRequestFullscreen}
        onExitFullscreen={onExitFullscreen}
        displayMode={displayMode}
        onDisplayModeChange={onDisplayModeChange}
        initialWidgetState={renderOverride?.initialWidgetState}
        isOffline={renderOverride?.isOffline}
        cachedWidgetHtmlUrl={renderOverride?.cachedWidgetHtmlUrl}
        minimalMode={minimalMode}
      />
    );
  }

  if (
    uiType === UIType.MCP_APPS ||
    (uiType === UIType.OPENAI_SDK_AND_MCP_APPS &&
      protocolOverride === UIType.MCP_APPS) ||
    // Stage 2: unified renderer also picks up OpenAI-SDK widgets when the
    // prefs flag is on. The OpenAI-only branch above was skipped for
    // these; route them here instead so they render through
    // MCPAppsRenderer with `window.openai` injection gated on
    // `openAiCompatEnabled`. The advisory banner (2.6) lives in the
    // renderer's container so it stays adjacent to the widget regardless
    // of dispatch path.
    shouldRouteOpenAiThroughUnifiedRenderer
  ) {
    if (
      toolState !== "output-available" &&
      toolState !== "approval-requested" &&
      toolState !== "output-denied" &&
      toolState !== "input-streaming" &&
      toolState !== "input-available"
    ) {
      return null;
    }

    if (
      (!serverId && !hasCachedHtmlForOffline) ||
      (!uiResourceUri && !hasCachedHtmlForOffline) ||
      !toolCallId
    ) {
      return (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
          Failed to load server id or resource uri for MCP App.
        </div>
      );
    }

    // Stage 2: pick discovery channel. For pure OpenAI-SDK widgets routed
    // through the unified renderer, use the `openai/outputTemplate` URL.
    // For pure MCP Apps widgets, use the `ui://` resource URI. For
    // dual-metadata widgets routed through unified with protocol override
    // === OPENAI_SDK, prefer the openai template (per hard constraint #6,
    // protocolOverride chooses the _meta block when both exist).
    const isOpenAiDiscovery = shouldRouteOpenAiThroughUnifiedRenderer;
    // Fidelity-field extraction for OpenAI-SDK widgets routed through the
    // unified renderer. Mirrors the legacy `ChatGPTAppRenderer` derivation
    // (chatgpt-app-renderer.tsx:193 for `toolResponseMetadata`,
    // chatgpt-app-renderer.tsx:229 `getDeviceType()` for viewport-based
    // device classification). MCP Apps widgets in the unified renderer
    // continue to get these through the renderer's existing
    // host-context flow, so we only feed the dispatcher-derived values
    // for the OpenAI path.
    let dispatchToolResponseMetadata: Record<string, unknown> | null = null;
    if (isOpenAiDiscovery) {
      const out = resolvedToolOutput;
      if (out && typeof out === "object" && !Array.isArray(out)) {
        const record = out as Record<string, unknown>;
        const meta =
          (record._meta as Record<string, unknown> | undefined) ??
          (record.meta as Record<string, unknown> | undefined);
        if (meta && typeof meta === "object" && !Array.isArray(meta)) {
          dispatchToolResponseMetadata = meta;
        }
      }
    }
    let dispatchDeviceType: "mobile" | "tablet" | "desktop" | undefined;
    if (isOpenAiDiscovery && typeof window !== "undefined") {
      const width = window.innerWidth;
      dispatchDeviceType =
        width < 768 ? "mobile" : width < 1024 ? "tablet" : "desktop";
    }
    const dispatchResourceUri = isOpenAiDiscovery
      ? // Always pull the OpenAI template here, even for dual-metadata
        // widgets — the renderer hands this verbatim to the server as
        // `openaiOutputTemplate`. Falls back to `uiResourceUri` for the
        // single-metadata case where the helper already returned the
        // OpenAI URL.
        getUIResourceUri(UIType.OPENAI_SDK, effectiveToolMeta) ??
        uiResourceUri
      : uiResourceUri;
    // Stage 2.6: advisory banner. Non-blocking per hard constraint #7 —
    // the widget renders regardless. Only shown when the widget came in
    // through the OpenAI discovery channel AND the resolver returned
    // false (host style default disabled + no explicit opt-in). MCP Apps
    // widgets never see the banner; widgets with `enabled: true` never
    // see it either.
    const showOpenAiCompatBanner =
      isOpenAiDiscovery &&
      !openAiCompatEnabled &&
      !openAiCompatBannerDismissed;
    return (
      <>
        {showOpenAiCompatBanner ? (
          <div
            role="status"
            className="mb-2 flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <div className="flex-1 leading-snug">
              <strong className="font-semibold">
                OpenAI compatibility is off for this profile.
              </strong>{" "}
              The widget will load, but{" "}
              <code className="font-mono">window.openai</code> is{" "}
              <code className="font-mono">undefined</code> — calls into it will
              throw inside the iframe.
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onEnableOpenAiCompat}
                disabled={!onEnableOpenAiCompat}
                className="rounded border border-amber-600/50 bg-amber-100/80 px-2 py-1 text-xs font-medium hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-400/40 dark:bg-amber-900/60 dark:text-amber-100 dark:hover:bg-amber-900/80"
              >
                Enable on this profile
              </button>
              <button
                type="button"
                onClick={() => setOpenAiCompatBannerDismissed(true)}
                className="rounded px-2 py-1 text-xs font-medium text-amber-900/80 hover:text-amber-900 dark:text-amber-200/80 dark:hover:text-amber-200"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
        <MCPAppsRenderer
        serverId={serverId ?? "offline-view"}
        toolCallId={toolCallId}
        toolName={toolName}
        toolState={toolState}
        toolInput={toolInput ?? undefined}
        toolOutput={resolvedToolOutput}
        toolErrorText={toolErrorText}
        resourceUri={dispatchResourceUri ?? "mcp://offline/view"}
        toolMetadata={effectiveToolMeta}
        toolsMetadata={toolsMetadata}
        onSendFollowUp={onSendFollowUp}
        onCallTool={onCallTool}
        onWidgetStateChange={onWidgetStateChange}
        onModelContextUpdate={onModelContextUpdate}
        pipWidgetId={pipWidgetId}
        fullscreenWidgetId={fullscreenWidgetId}
        onRequestPip={onRequestPip}
        onExitPip={onExitPip}
        displayMode={displayMode}
        onDisplayModeChange={onDisplayModeChange}
        onRequestFullscreen={onRequestFullscreen}
        onExitFullscreen={onExitFullscreen}
        onAppSupportedDisplayModesChange={onAppSupportedDisplayModesChange}
        isOffline={renderOverride?.isOffline}
        cachedWidgetHtmlUrl={renderOverride?.cachedWidgetHtmlUrl}
        widgetCsp={renderOverride?.widgetCsp}
        widgetPermissions={renderOverride?.widgetPermissions}
        widgetPermissive={renderOverride?.widgetPermissive}
        prefersBorder={renderOverride?.prefersBorder}
        minimalMode={minimalMode}
          discoveryChannel={isOpenAiDiscovery ? "openai" : "mcp-apps"}
          openAiCompatEnabled={openAiCompatEnabled}
          // Fidelity props derived from the tool result + viewport for
          // OpenAI-SDK widgets so `window.openai.toolResponseMetadata`
          // and `window.openai.deviceType` keep parity with the legacy
          // ChatGPT path. MCP Apps widgets stay on the renderer's
          // existing host-context flow (locale, deviceCapabilities,
          // safe area, etc.) and get `null` / `undefined` here without
          // any user-visible regression.
          toolResponseMetadata={dispatchToolResponseMetadata}
          deviceType={dispatchDeviceType}
        />
      </>
    );
  }

  return null;
}
