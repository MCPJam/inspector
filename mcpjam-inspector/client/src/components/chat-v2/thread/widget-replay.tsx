import type { ContentBlock } from "@modelcontextprotocol/client";
import { MCPAppsRenderer } from "./mcp-apps/mcp-apps-renderer";
import type { ToolState } from "./mcp-apps/useToolInputStreaming";
import type { ToolRenderOverride } from "./tool-render-overrides";
import {
  detectUIType,
  getUIResourceUri,
  UIType,
} from "@/lib/mcp-ui/mcp-apps-utils";
import { getToolServerId, type ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { useActiveHostCapsResolver } from "@/contexts/active-host-client-capabilities-context";
import { hostSupportsWidgetRendering } from "@/lib/host-capabilities";
import {
  readToolResultMeta,
  readToolResultServerId,
} from "@/lib/tool-result-utils";
import type { DisplayMode } from "@/stores/ui-playground-store";
import type { AppToolInvocationUpdate } from "./app-tool-invocations";

export interface WidgetReplayProps {
  chatSessionId?: string;
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
    params: Record<string, unknown>
  ) => Promise<unknown>;
  onAppToolInvocationChange?: (invocation: AppToolInvocationUpdate) => void;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    }
  ) => void;
  pipWidgetId?: string | null;
  fullscreenWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
  onRequestFullscreen?: (toolCallId: string) => void;
  onExitFullscreen?: (toolCallId: string) => void;
  onRequestTeardown?: (toolCallId: string, displayWidgetId?: string) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onAppSupportedDisplayModesChange?: (modes: DisplayMode[] | undefined) => void;
  minimalMode?: boolean;
}

export function WidgetReplay({
  chatSessionId,
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
  onAppToolInvocationChange,
  onWidgetStateChange,
  onModelContextUpdate,
  pipWidgetId,
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  onRequestFullscreen,
  onExitFullscreen,
  onRequestTeardown,
  displayMode,
  onDisplayModeChange,
  onAppSupportedDisplayModesChange,
  minimalMode = false,
}: WidgetReplayProps) {
  const resolveHostCaps = useActiveHostCapsResolver();
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

  // Single-path routing: every UI-bearing tool (Apps SDK, MCP Apps, or
  // dual-metadata) renders through MCPAppsRenderer. Whether the OpenAI
  // compatibility runtime is injected is controlled by the selected
  // client/host profile so host simulation stays honest.
  //
  // Defense-in-depth host gate: the primary check lives in PartSwitch
  // (which decides between ToolPart and WidgetReplay). Re-checking here
  // means a host that strips the MCP UI extension never renders a widget
  // even on code paths that mount WidgetReplay directly (transcript
  // thread, trace viewer adapters, future callers). `serverId` (computed
  // above) is passed through so any per-server `clientCapabilities`
  // override is honored, matching `initialize`.
  const hasUi =
    hostSupportsWidgetRendering(resolveHostCaps(serverId ?? undefined)) &&
    (uiType === UIType.MCP_APPS ||
      uiType === UIType.OPENAI_SDK ||
      uiType === UIType.OPENAI_SDK_AND_MCP_APPS);
  if (!hasUi) return null;

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

  // Tool response `_meta` for window.openai.toolResponseMetadata.
  // Computed from `rawOutput` so the `{ value, _meta }` wrapper case
  // (where `toolOutput` is the unwrapped value and lacks `_meta`)
  // resolves correctly via readToolResultMeta's two-level check.
  const toolResponseMetadata = (readToolResultMeta(rawOutput) ??
    readToolResultMeta(toolOutput)) as Record<string, unknown> | undefined;

  return (
    <MCPAppsRenderer
      chatSessionId={chatSessionId}
      serverId={serverId ?? "offline-view"}
      serverName={serverId ?? "offline-view"}
      toolCallId={toolCallId}
      toolName={toolName}
      toolState={toolState}
      toolInput={toolInput ?? undefined}
      toolOutput={resolvedToolOutput}
      toolResponseMetadata={toolResponseMetadata ?? null}
      toolErrorText={toolErrorText}
      resourceUri={uiResourceUri ?? "mcp://offline/view"}
      toolMetadata={effectiveToolMeta}
      toolsMetadata={toolsMetadata}
      onSendFollowUp={onSendFollowUp}
      onCallTool={onCallTool}
      onAppToolInvocationChange={onAppToolInvocationChange}
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
      onRequestTeardown={onRequestTeardown}
      isOffline={renderOverride?.isOffline}
      cachedWidgetHtmlUrl={renderOverride?.cachedWidgetHtmlUrl}
      liveFetchPreferred={renderOverride?.liveFetchPreferred}
      widgetCsp={renderOverride?.widgetCsp}
      widgetPermissions={renderOverride?.widgetPermissions}
      widgetPermissive={renderOverride?.widgetPermissive}
      prefersBorder={renderOverride?.prefersBorder}
      injectedOpenAiCompat={renderOverride?.injectedOpenAiCompat}
      injectedOpenAiCompatCapabilities={
        renderOverride?.injectedOpenAiCompatCapabilities
      }
      initialWidgetState={renderOverride?.initialWidgetState}
      minimalMode={minimalMode}
    />
  );
}
