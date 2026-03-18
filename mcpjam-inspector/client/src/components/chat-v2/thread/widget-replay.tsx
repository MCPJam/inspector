import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
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
import { useSandboxHostStyle } from "@/contexts/sandbox-host-style-context";
import { getSandboxProtocolOverride } from "@/lib/sandbox-host-style";
import type { DisplayMode } from "@/stores/ui-playground-store";

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
}: WidgetReplayProps) {
  const sandboxHostStyle = useSandboxHostStyle();
  const protocolOverride =
    selectedProtocolOverrideIfBothExists ??
    getSandboxProtocolOverride(sandboxHostStyle) ??
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

  if (
    uiType === UIType.OPENAI_SDK ||
    (uiType === UIType.OPENAI_SDK_AND_MCP_APPS &&
      protocolOverride === UIType.OPENAI_SDK)
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
      protocolOverride === UIType.MCP_APPS)
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

    return (
      <MCPAppsRenderer
        serverId={serverId ?? "offline-view"}
        toolCallId={toolCallId}
        toolName={toolName}
        toolState={toolState}
        toolInput={toolInput ?? undefined}
        toolOutput={resolvedToolOutput}
        toolErrorText={toolErrorText}
        resourceUri={uiResourceUri ?? "mcp://offline/view"}
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
      />
    );
  }

  return null;
}
