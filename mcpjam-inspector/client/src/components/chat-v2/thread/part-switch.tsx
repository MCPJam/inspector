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
}) {
  const [appSupportedDisplayModes, setAppSupportedDisplayModes] = useState<
    DisplayMode[] | undefined
  >();

  // Get auth and app state for saving views
  const { isAuthenticated } = useConvexAuth();
  const posthog = usePostHog();
  const appState = useSharedAppState();

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
    isAuthenticated,
    workspaceId: convexWorkspaceId,
  });
  const existingViewNames = useMemo(
    () => new Set(sortedViews.map((v) => v.name)),
    [sortedViews],
  );

  // Instant save hook
  const { saveViewInstant, isSaving } = useSaveView({
    isAuthenticated,
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
    const partToolMeta = toolsMetadata[toolInfo.toolName];
    const uiType = detectUIType(partToolMeta, toolInfo.rawOutput);
    const uiResourceUri = getUIResourceUri(uiType, partToolMeta);
    const uiResource =
      uiType === UIType.MCP_UI ? extractUIResource(toolInfo.rawOutput) : null;
    const serverId = getToolServerId(toolInfo.toolName, toolServerMap);

    // Determine why save might be disabled
    const hasOutput =
      toolInfo.output !== undefined ||
      toolInfo.rawOutput !== undefined ||
      toolInfo.toolState === "output-available" ||
      toolInfo.toolState === "output-error";

    // Can save if we have output (or output-available state) or error
    const canSaveView = isAuthenticated && !!convexWorkspaceId && hasOutput;

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
    const outputToSave = toolInfo.output ?? toolInfo.rawOutput;
    // OpenAI outputTemplate is stored under "openai/outputTemplate" key
    const outputTemplate = partToolMeta?.["openai/outputTemplate"] as
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
      partToolMeta as Record<string, unknown> | undefined,
    );

    if (uiResource) {
      return (
        <>
          <ToolPart
            part={toolPart}
            uiType={uiType}
            onSaveView={handleSaveView}
            canSaveView={canSaveView}
            saveDisabledReason={saveDisabledReason}
            isSaving={isSaving}
            {...approvalProps}
          />
          <MCPUIResourcePart
            resource={uiResource.resource}
            onSendFollowUp={onSendFollowUp}
          />
        </>
      );
    }
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
              onSaveView={handleSaveView}
              canSaveView={false}
              isSaving={isSaving}
              {...approvalProps}
            />
            <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
              Waiting for tool to finish executing...
            </div>
          </>
        );
      }

      if (!serverId) {
        return (
          <>
            <ToolPart
              part={toolPart}
              uiType={uiType}
              onSaveView={handleSaveView}
              canSaveView={canSaveView}
              saveDisabledReason={saveDisabledReason}
              isSaving={isSaving}
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
            onSaveView={handleSaveView}
            canSaveView={canSaveView}
            saveDisabledReason={saveDisabledReason}
            isSaving={isSaving}
            {...approvalProps}
          />
          <ChatGPTAppRenderer
            serverId={serverId}
            toolCallId={toolInfo.toolCallId}
            toolName={toolInfo.toolName}
            toolState={toolInfo.toolState}
            toolInput={toolInfo.input ?? null}
            toolOutput={toolInfo.output ?? null}
            toolMetadata={toolsMetadata[toolInfo.toolName] ?? undefined}
            onSendFollowUp={onSendFollowUp}
            onCallTool={(toolName, params) =>
              callTool(serverId, toolName, params)
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
          />
        </>
      );
    }

    if (
      uiType === UIType.MCP_APPS ||
      (uiType === UIType.OPENAI_SDK_AND_MCP_APPS &&
        selectedProtocolOverrideIfBothExists === UIType.MCP_APPS)
    ) {
      if (!serverId || !uiResourceUri || !toolInfo.toolCallId) {
        return (
          <>
            <ToolPart
              part={toolPart}
              uiType={uiType}
              onSaveView={handleSaveView}
              canSaveView={canSaveView}
              saveDisabledReason={saveDisabledReason}
              isSaving={isSaving}
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
            onSaveView={handleSaveView}
            canSaveView={canSaveView}
            saveDisabledReason={saveDisabledReason}
            isSaving={isSaving}
            {...approvalProps}
          />
          <MCPAppsRenderer
            serverId={serverId}
            toolCallId={toolInfo.toolCallId}
            toolName={toolInfo.toolName}
            toolState={toolInfo.toolState}
            toolInput={toolInfo.input}
            toolOutput={toolInfo.output}
            toolErrorText={toolInfo.errorText}
            resourceUri={uiResourceUri}
            toolMetadata={partToolMeta}
            toolsMetadata={toolsMetadata}
            onSendFollowUp={onSendFollowUp}
            onCallTool={(toolName, params) =>
              callTool(serverId, toolName, params)
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
          />
        </>
      );
    }
    return (
      <ToolPart
        part={toolPart}
        uiType={uiType}
        onSaveView={handleSaveView}
        canSaveView={canSaveView}
        saveDisabledReason={saveDisabledReason}
        isSaving={isSaving}
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
