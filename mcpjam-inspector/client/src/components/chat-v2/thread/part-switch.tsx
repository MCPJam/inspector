import { useState, useCallback, useMemo } from "react";
import { type ToolUIPart, type DynamicToolUIPart, type UITools } from "ai";
import { UIMessage } from "@ai-sdk/react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";

import { ChatGPTAppRenderer } from "./chatgpt-app-renderer";
import { MCPAppsRenderer } from "./mcp-apps/mcp-apps-renderer";
import { ToolPart } from "./parts/tool-part";
import { ReasoningPart } from "./parts/reasoning-part";
import { FilePart } from "./parts/file-part";
import { SourceUrlPart } from "./parts/source-url-part";
import { SourceDocumentPart } from "./parts/source-document-part";
import { JsonPart } from "./parts/json-part";
import { TextPart } from "./parts/text-part";
import { MCPUIResourcePart } from "./parts/mcp-ui-resource-part";
import { useViewQueries } from "@/hooks/useViews";
import { useSaveView, type ToolDataForSave } from "@/hooks/useSaveView";
import { type DisplayMode } from "@/stores/ui-playground-store";
import {
  callTool,
  getToolServerId,
  ToolServerMap,
} from "@/lib/apis/mcp-tools-api";
import {
  detectUIType,
  getUIResourceUri,
  UIType,
} from "@/lib/mcp-ui/mcp-apps-utils";
import {
  AnyPart,
  extractUIResource,
  getDataLabel,
  getToolInfo,
  isDataPart,
  isDynamicTool,
  isToolPart,
} from "./thread-helpers";
import { useSharedAppState } from "@/state/app-state-context";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";

function readToolResultObject(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  return result as Record<string, unknown>;
}

function readToolResultMeta(
  result: unknown,
): Record<string, unknown> | undefined {
  const direct = readToolResultObject(result);
  if (
    direct?._meta &&
    typeof direct._meta === "object" &&
    direct._meta !== null
  ) {
    return direct._meta as Record<string, unknown>;
  }

  const nested = readToolResultObject(direct?.value);
  if (
    nested?._meta &&
    typeof nested._meta === "object" &&
    nested._meta !== null
  ) {
    return nested._meta as Record<string, unknown>;
  }

  return undefined;
}

function readToolResultServerId(result: unknown): string | undefined {
  const direct = readToolResultObject(result);
  if (typeof direct?._serverId === "string") {
    return direct._serverId;
  }

  const nested = readToolResultObject(direct?.value);
  if (typeof nested?._serverId === "string") {
    return nested._serverId;
  }

  const meta = readToolResultMeta(result);
  if (typeof meta?._serverId === "string") {
    return meta._serverId;
  }

  return undefined;
}

export function PartSwitch({
  part,
  role,
  onSendFollowUp,
  toolsMetadata,
  toolServerMap,
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
  selectedProtocolOverrideIfBothExists = UIType.OPENAI_SDK,
  onToolApprovalResponse,
  messageParts,
  toolRenderOverrides,
  showSaveViewButton = true,
  minimalMode = false,
}: {
  part: AnyPart;
  role: UIMessage["role"];
  onSendFollowUp: (text: string) => void;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    },
  ) => void;
  pipWidgetId: string | null;
  fullscreenWidgetId: string | null;
  onRequestPip: (toolCallId: string) => void;
  onExitPip: (toolCallId: string) => void;
  onRequestFullscreen: (toolCallId: string) => void;
  onExitFullscreen: (toolCallId: string) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  selectedProtocolOverrideIfBothExists?: UIType;
  onToolApprovalResponse?: (options: { id: string; approved: boolean }) => void;
  messageParts?: AnyPart[];
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  showSaveViewButton?: boolean;
  minimalMode?: boolean;
}) {
  const [appSupportedDisplayModes, setAppSupportedDisplayModes] = useState<
    DisplayMode[] | undefined
  >();
  void messageParts;

  // Get auth and app state for saving views
  const { isAuthenticated } = useConvexAuth();
  const posthog = usePostHog();
  const appState = useSharedAppState();
  const savingEnabled = isAuthenticated && !minimalMode;

  // Get the Convex workspace ID (sharedWorkspaceId) from the active workspace
  const activeWorkspace = appState.workspaces[appState.activeWorkspaceId];
  const convexWorkspaceId = activeWorkspace?.sharedWorkspaceId ?? null;

  const toolInfoFromPart =
    isToolPart(part) || isDynamicTool(part)
      ? getToolInfo(part as ToolUIPart<UITools> | DynamicToolUIPart)
      : null;

  // Prefer the tool's server when saving views to avoid cross-server mismatch
  const currentServerName =
    (toolInfoFromPart
      ? getToolServerId(toolInfoFromPart.toolName, toolServerMap)
      : undefined) ??
    appState.selectedServer ??
    "unknown";

  // Get existing view names for duplicate handling
  const { sortedViews } = useViewQueries({
    isAuthenticated: savingEnabled,
    workspaceId: convexWorkspaceId,
  });
  const existingViewNames = useMemo(
    () => new Set(sortedViews.map((v) => v.name)),
    [sortedViews],
  );

  // Instant save hook
  const { saveViewInstant, isSaving } = useSaveView({
    isAuthenticated: savingEnabled,
    workspaceId: convexWorkspaceId,
    serverName: currentServerName,
    existingViewNames,
  });

  // Get widget debug info for the current tool
  const toolCallId =
    isToolPart(part) || isDynamicTool(part)
      ? ((part as any).toolCallId as string | undefined)
      : undefined;
  const widgetDebugInfo = useWidgetDebugStore((s) =>
    toolCallId ? s.widgets.get(toolCallId) : undefined,
  );

  // Create save view handler for a specific tool (instant save)
  const createSaveViewHandler = useCallback(
    (
      toolName: string,
      input: unknown,
      output: unknown,
      errorText: string | undefined,
      toolState: "output-available" | "output-error",
      uiType: UIType,
      resourceUri?: string,
      outputTemplate?: string,
      toolMetadata?: Record<string, unknown>,
    ) => {
      return async () => {
        posthog.capture("save_as_view_clicked", {
          location: "chat_tool_result",
          platform: detectPlatform(),
          environment: detectEnvironment(),
        });

        const data: ToolDataForSave = {
          uiType,
          toolName,
          toolCallId,
          input,
          output,
          errorText,
          state: toolState,
          widgetDebugInfo: widgetDebugInfo
            ? {
                csp: widgetDebugInfo.csp,
                protocol: widgetDebugInfo.protocol,
                modelContext: widgetDebugInfo.modelContext,
              }
            : undefined,
          resourceUri,
          outputTemplate,
          toolMetadata,
          // Include cached widget HTML for offline rendering (MCP Apps only)
          widgetHtml: widgetDebugInfo?.widgetHtml,
        };

        await saveViewInstant(data);
      };
    },
    [toolCallId, widgetDebugInfo, saveViewInstant, posthog],
  );

  if (isToolPart(part) || isDynamicTool(part)) {
    const toolPart = part as ToolUIPart<UITools> | DynamicToolUIPart;
    const toolInfo = toolInfoFromPart ?? getToolInfo(toolPart);
    const approvalId = toolPart.approval?.id;
    const approvalProps = approvalId
      ? {
          approvalId,
          onApprove: (id: string) =>
            onToolApprovalResponse?.({ id, approved: true }),
          onDeny: (id: string) =>
            onToolApprovalResponse?.({ id, approved: false }),
        }
      : {};
    const renderOverride = toolInfo.toolCallId
      ? toolRenderOverrides?.[toolInfo.toolCallId]
      : undefined;
    const partToolMeta = toolsMetadata[toolInfo.toolName];
    const streamedToolMeta = readToolResultMeta(toolInfo.rawOutput);
    const effectiveToolMeta =
      renderOverride?.toolMetadata ?? partToolMeta ?? streamedToolMeta;
    const uiType = detectUIType(effectiveToolMeta, toolInfo.rawOutput);
    const uiResourceUri =
      renderOverride?.resourceUri ??
      getUIResourceUri(uiType, effectiveToolMeta);
    const uiResource =
      uiType === UIType.MCP_UI ? extractUIResource(toolInfo.rawOutput) : null;
    const serverId =
      renderOverride?.serverId ??
      getToolServerId(toolInfo.toolName, toolServerMap) ??
      readToolResultServerId(toolInfo.rawOutput);
    const resolvedToolOutput = toolInfo.output ?? toolInfo.rawOutput;

    // Determine why save might be disabled
    const hasOutput =
      resolvedToolOutput !== undefined ||
      toolInfo.rawOutput !== undefined ||
      toolInfo.toolState === "output-available" ||
      toolInfo.toolState === "output-error";

    // Can save if we have output (or output-available state) or error
    const canSaveView =
      !minimalMode && isAuthenticated && !!convexWorkspaceId && hasOutput;
    const allowSaveView = showSaveViewButton && !minimalMode;

    // Compute reason for disabled state
    let saveDisabledReason: string | undefined;
    if (!isAuthenticated) {
      saveDisabledReason = "Sign in to save views";
    } else if (!convexWorkspaceId) {
      saveDisabledReason = "Select a shared workspace to save views";
    } else if (!hasOutput) {
      saveDisabledReason = "No output to save";
    }

    // Create handler for this specific tool
    // Use rawOutput as fallback if output is undefined
    const outputToSave = resolvedToolOutput;
    // OpenAI outputTemplate is stored under "openai/outputTemplate" key
    const outputTemplate = effectiveToolMeta?.["openai/outputTemplate"] as
      | string
      | undefined;
    const handleSaveView = createSaveViewHandler(
      toolInfo.toolName,
      toolInfo.input,
      outputToSave,
      toolInfo.errorText,
      toolInfo.toolState === "output-error"
        ? "output-error"
        : "output-available",
      uiType || UIType.MCP_APPS,
      uiResourceUri ?? undefined,
      outputTemplate,
      effectiveToolMeta as Record<string, unknown> | undefined,
    );

    if (uiResource) {
      return (
        <>
          <ToolPart
            part={toolPart}
            uiType={uiType}
            onSaveView={allowSaveView ? handleSaveView : undefined}
            canSaveView={allowSaveView ? canSaveView : undefined}
            saveDisabledReason={allowSaveView ? saveDisabledReason : undefined}
            isSaving={isSaving}
            minimalMode={minimalMode}
            {...approvalProps}
          />
          <MCPUIResourcePart
            resource={uiResource.resource}
            onSendFollowUp={onSendFollowUp}
          />
        </>
      );
    }
    const hasCachedHtmlForOffline = !!renderOverride?.cachedWidgetHtmlUrl;

    if (
      uiType === UIType.OPENAI_SDK ||
      (uiType === UIType.OPENAI_SDK_AND_MCP_APPS &&
        selectedProtocolOverrideIfBothExists === UIType.OPENAI_SDK)
    ) {
      if (
        toolInfo.toolState !== "output-available" &&
        toolInfo.toolState !== "approval-requested" &&
        toolInfo.toolState !== "output-denied"
      ) {
        return (
          <>
            <ToolPart
              part={toolPart}
              uiType={uiType}
              onSaveView={allowSaveView ? handleSaveView : undefined}
              canSaveView={false}
              isSaving={isSaving}
              minimalMode={minimalMode}
              {...approvalProps}
            />
            <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
              Waiting for tool to finish executing...
            </div>
          </>
        );
      }

      if (!serverId && !hasCachedHtmlForOffline) {
        return (
          <>
            <ToolPart
              part={toolPart}
              uiType={uiType}
              onSaveView={allowSaveView ? handleSaveView : undefined}
              canSaveView={allowSaveView ? canSaveView : undefined}
              saveDisabledReason={
                allowSaveView ? saveDisabledReason : undefined
              }
              isSaving={isSaving}
              minimalMode={minimalMode}
              {...approvalProps}
            />
            <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
              Failed to load tool server id.
            </div>
          </>
        );
      }

      return (
        <>
          <ToolPart
            part={toolPart}
            uiType={uiType}
            displayMode={displayMode}
            pipWidgetId={pipWidgetId}
            fullscreenWidgetId={fullscreenWidgetId}
            onDisplayModeChange={onDisplayModeChange}
            onRequestFullscreen={onRequestFullscreen}
            onExitFullscreen={onExitFullscreen}
            onRequestPip={onRequestPip}
            onExitPip={onExitPip}
            onSaveView={allowSaveView ? handleSaveView : undefined}
            canSaveView={allowSaveView ? canSaveView : undefined}
            saveDisabledReason={allowSaveView ? saveDisabledReason : undefined}
            isSaving={isSaving}
            minimalMode={minimalMode}
            {...approvalProps}
          />
          <ChatGPTAppRenderer
            serverId={serverId ?? "offline-view"}
            toolCallId={toolInfo.toolCallId}
            toolName={toolInfo.toolName}
            toolState={toolInfo.toolState}
            toolInput={toolInfo.input ?? null}
            toolOutput={resolvedToolOutput ?? null}
            toolMetadata={effectiveToolMeta ?? undefined}
            onSendFollowUp={onSendFollowUp}
            onCallTool={(toolName, params) =>
              callTool(serverId ?? "offline-view", toolName, params)
            }
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
        </>
      );
    }

    if (
      uiType === UIType.MCP_APPS ||
      (uiType === UIType.OPENAI_SDK_AND_MCP_APPS &&
        selectedProtocolOverrideIfBothExists === UIType.MCP_APPS)
    ) {
      if (
        (!serverId && !hasCachedHtmlForOffline) ||
        (!uiResourceUri && !hasCachedHtmlForOffline) ||
        !toolInfo.toolCallId
      ) {
        return (
          <>
            <ToolPart
              part={toolPart}
              uiType={uiType}
              onSaveView={allowSaveView ? handleSaveView : undefined}
              canSaveView={allowSaveView ? canSaveView : undefined}
              saveDisabledReason={
                allowSaveView ? saveDisabledReason : undefined
              }
              isSaving={isSaving}
              minimalMode={minimalMode}
              {...approvalProps}
            />
            <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
              Failed to load server id or resource uri for MCP App.
            </div>
          </>
        );
      }

      return (
        <>
          <ToolPart
            part={toolPart}
            uiType={uiType}
            displayMode={displayMode}
            pipWidgetId={pipWidgetId}
            fullscreenWidgetId={fullscreenWidgetId}
            onDisplayModeChange={onDisplayModeChange}
            onRequestFullscreen={onRequestFullscreen}
            onExitFullscreen={onExitFullscreen}
            onRequestPip={onRequestPip}
            onExitPip={onExitPip}
            appSupportedDisplayModes={appSupportedDisplayModes}
            onSaveView={allowSaveView ? handleSaveView : undefined}
            canSaveView={allowSaveView ? canSaveView : undefined}
            saveDisabledReason={allowSaveView ? saveDisabledReason : undefined}
            isSaving={isSaving}
            minimalMode={minimalMode}
            {...approvalProps}
          />
          <MCPAppsRenderer
            serverId={serverId ?? "offline-view"}
            toolCallId={toolInfo.toolCallId}
            toolName={toolInfo.toolName}
            toolState={toolInfo.toolState}
            toolInput={toolInfo.input}
            toolOutput={resolvedToolOutput}
            toolErrorText={toolInfo.errorText}
            resourceUri={uiResourceUri ?? "mcp://offline/view"}
            toolMetadata={effectiveToolMeta}
            toolsMetadata={toolsMetadata}
            onSendFollowUp={onSendFollowUp}
            onCallTool={(toolName, params) =>
              callTool(serverId ?? "offline-view", toolName, params)
            }
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
            onAppSupportedDisplayModesChange={setAppSupportedDisplayModes}
            isOffline={renderOverride?.isOffline}
            cachedWidgetHtmlUrl={renderOverride?.cachedWidgetHtmlUrl}
            minimalMode={minimalMode}
          />
        </>
      );
    }
    return (
      <ToolPart
        part={toolPart}
        uiType={uiType}
        onSaveView={allowSaveView ? handleSaveView : undefined}
        canSaveView={allowSaveView ? canSaveView : undefined}
        saveDisabledReason={allowSaveView ? saveDisabledReason : undefined}
        isSaving={isSaving}
        minimalMode={minimalMode}
        {...approvalProps}
      />
    );
  }

  if (isDataPart(part)) {
    return (
      <JsonPart label={getDataLabel(part.type)} value={(part as any).data} />
    );
  }

  switch (part.type) {
    case "text":
      return <TextPart text={part.text} role={role} />;
    case "reasoning":
      return <ReasoningPart text={part.text} state={part.state} />;
    case "file":
      return <FilePart part={part} />;
    case "source-url":
      return <SourceUrlPart part={part} />;
    case "source-document":
      return <SourceDocumentPart part={part} />;
    case "step-start":
      return null;
    default:
      return <JsonPart label="Unknown part" value={part} />;
  }
}
