import { useState, useCallback, useMemo } from "react";
import { type ToolUIPart, type DynamicToolUIPart, type UITools } from "ai";
import { UIMessage } from "@ai-sdk/react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { detectPlatform, detectEnvironment } from "@/lib/PosthogUtils";

import { ToolPart } from "./parts/tool-part";
import {
  ReasoningPart,
  type ReasoningDisplayMode,
} from "./parts/reasoning-part";
import { FilePart } from "./parts/file-part";
import { SourceUrlPart } from "./parts/source-url-part";
import { SourceDocumentPart } from "./parts/source-document-part";
import { JsonPart } from "./parts/json-part";
import { TextPart } from "./parts/text-part";
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
  getDataLabel,
  getToolInfo,
  isDataPart,
  isDynamicTool,
  isToolPart,
} from "./thread-helpers";
import { useSharedAppState } from "@/state/app-state-context";
import { useActiveHostCapsResolver } from "@/contexts/active-host-client-capabilities-context";
import { useChatboxHostStyle } from "@/contexts/chatbox-client-style-context";
import { hostSupportsWidgetRendering } from "@/lib/host-capabilities";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { WidgetReplay } from "./widget-replay";

import {
  readToolResultMeta,
  readToolResultServerId,
} from "@/lib/tool-result-utils";
import type { AppToolInvocationUpdate } from "./app-tool-invocations";

export function PartSwitch({
  part,
  role,
  chatSessionId,
  onSendFollowUp,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  onModelContextUpdate,
  onAppToolInvocationChange,
  pipWidgetId,
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  onRequestFullscreen,
  onExitFullscreen,
  onRequestTeardown,
  tornDownWidgetIds,
  displayMode,
  onDisplayModeChange,
  onToolApprovalResponse,
  messageParts,
  toolRenderOverrides,
  showSaveViewButton = true,
  minimalMode = false,
  interactive = true,
  reasoningDisplayMode = "inline",
}: {
  part: AnyPart;
  role: UIMessage["role"];
  chatSessionId?: string;
  onSendFollowUp: (text: string) => void;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    }
  ) => void;
  onAppToolInvocationChange?: (invocation: AppToolInvocationUpdate) => void;
  pipWidgetId: string | null;
  fullscreenWidgetId: string | null;
  onRequestPip: (toolCallId: string) => void;
  onExitPip: (toolCallId: string) => void;
  onRequestFullscreen: (toolCallId: string) => void;
  onExitFullscreen: (toolCallId: string) => void;
  onRequestTeardown?: (toolCallId: string, displayWidgetId?: string) => void;
  tornDownWidgetIds?: ReadonlySet<string>;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onToolApprovalResponse?: (options: { id: string; approved: boolean }) => void;
  messageParts?: AnyPart[];
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  showSaveViewButton?: boolean;
  minimalMode?: boolean;
  interactive?: boolean;
  reasoningDisplayMode?: ReasoningDisplayMode;
}) {
  const [appSupportedDisplayModes, setAppSupportedDisplayModes] = useState<
    DisplayMode[] | undefined
  >();
  void messageParts;

  // Get auth and app state for saving views
  const { isAuthenticated } = useConvexAuth();
  const posthog = usePostHog();
  const appState = useSharedAppState();
  const resolveHostCaps = useActiveHostCapsResolver();
  const hostStyle = useChatboxHostStyle();
  const savingEnabled = isAuthenticated && !minimalMode && interactive;

  // Get the Convex project ID (sharedProjectId) from the active project
  const activeProject = appState.projects[appState.activeProjectId];
  const convexProjectId = activeProject?.sharedProjectId ?? null;

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
    projectId: convexProjectId,
  });
  const existingViewNames = useMemo(
    () => new Set(sortedViews.map((v) => v.name)),
    [sortedViews]
  );

  // Instant save hook
  const { saveViewInstant, isSaving } = useSaveView({
    isAuthenticated: savingEnabled,
    projectId: convexProjectId,
    serverName: currentServerName,
    existingViewNames,
  });

  // Get widget debug info for the current tool
  const toolCallId =
    isToolPart(part) || isDynamicTool(part)
      ? ((part as any).toolCallId as string | undefined)
      : undefined;
  const widgetDebugInfo = useWidgetDebugStore((s) =>
    toolCallId ? s.widgets.get(toolCallId) : undefined
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
      toolMetadata?: Record<string, unknown>
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
          // Compat provenance — the renderer stamps these onto the
          // debug-store entry at fetch time. Persisting them with
          // the saved view lets replay reproduce the original
          // `window.openai` API surface even when the live host
          // config has since changed.
          injectedOpenAiCompat: widgetDebugInfo?.injectedOpenAiCompat,
          injectedOpenAiCompatCapabilities:
            widgetDebugInfo?.injectedOpenAiCompatCapabilities,
        };

        await saveViewInstant(data);
      };
    },
    [toolCallId, widgetDebugInfo, saveViewInstant, posthog]
  );

  if (isToolPart(part) || isDynamicTool(part)) {
    const toolPart = part as ToolUIPart<UITools> | DynamicToolUIPart;
    const toolInfo = toolInfoFromPart ?? getToolInfo(toolPart);
    const approvalId = toolPart.approval?.id;
    const approvalProps =
      interactive && approvalId
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
    // MCP-UI legacy (inline ui:// resources via @mcp-ui/client) was
    // removed during the renderer consolidation. Inline resources are no
    // longer rendered; tools that want a widget must declare it via
    // `_meta.ui.resourceUri` or `openai/outputTemplate`.
    const serverId =
      renderOverride?.serverId ??
      getToolServerId(toolInfo.toolName, toolServerMap) ??
      readToolResultServerId(toolInfo.rawOutput);
    const hasRenderOverrideToolOutput =
      renderOverride !== undefined &&
      Object.prototype.hasOwnProperty.call(renderOverride, "toolOutput");
    const resolvedToolOutput = hasRenderOverrideToolOutput
      ? renderOverride.toolOutput
      : toolInfo.output ?? toolInfo.rawOutput;

    // Determine why save might be disabled
    const hasOutput =
      resolvedToolOutput !== undefined ||
      toolInfo.rawOutput !== undefined ||
      toolInfo.toolState === "output-available" ||
      toolInfo.toolState === "output-error";

    // Can save if we have output (or output-available state) or error
    const canSaveView =
      interactive &&
      !minimalMode &&
      isAuthenticated &&
      !!convexProjectId &&
      hasOutput;
    const allowSaveView = interactive && showSaveViewButton && !minimalMode;

    // Compute reason for disabled state
    let saveDisabledReason: string | undefined;
    if (!isAuthenticated) {
      saveDisabledReason = "Sign in to save views";
    } else if (!convexProjectId) {
      saveDisabledReason = "Select a shared project to save views";
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
      effectiveToolMeta as Record<string, unknown> | undefined
    );

    // Gate widget render on the active host's advertised capabilities for
    // this tool's server. Hosts that don't advertise the MCP UI extension
    // (Codex — elicitation-only client) fall through to the plain
    // ToolPart result row, even when the tool itself declares
    // `_meta.ui.resourceUri` / `openai/outputTemplate`. This mirrors what
    // real CLI clients do: tool runs, JSON result is shown, no iframe.
    //
    // `serverId` (computed above for save-view routing) is passed through
    // so the resolver picks up any per-server `clientCapabilities`
    // override — keeping the renderer in lockstep with `initialize`,
    // which uses the same `resolveEffectiveClientCapabilities` function.
    //
    // Note on Apps SDK hosts (ChatGPT, Copilot): their templates KEEP the
    // SDK-default MCP UI extension in `clientCapabilities`, so they pass
    // this gate today. A future explicit "window.openai" flag on
    // HostConfigInputV2 will be OR-ed here to cover Apps-SDK hosts that
    // choose to strip the MCP UI extension.
    const isWidgetTornDown =
      typeof toolInfo.toolCallId === "string" &&
      tornDownWidgetIds?.has(toolInfo.toolCallId);
    const shouldRenderWidget =
      !isWidgetTornDown &&
      hostSupportsWidgetRendering(resolveHostCaps(serverId ?? undefined), {
        hostStyle,
      }) &&
      (uiType === UIType.OPENAI_SDK ||
        uiType === UIType.MCP_APPS ||
        uiType === UIType.OPENAI_SDK_AND_MCP_APPS);

    if (shouldRenderWidget) {
      return (
        <>
          <ToolPart
            part={toolPart}
            chatSessionId={chatSessionId}
            uiType={uiType}
            displayMode={interactive ? displayMode : undefined}
            pipWidgetId={pipWidgetId}
            fullscreenWidgetId={fullscreenWidgetId}
            onDisplayModeChange={interactive ? onDisplayModeChange : undefined}
            onRequestFullscreen={interactive ? onRequestFullscreen : undefined}
            onExitFullscreen={interactive ? onExitFullscreen : undefined}
            onRequestPip={interactive ? onRequestPip : undefined}
            onExitPip={interactive ? onExitPip : undefined}
            appSupportedDisplayModes={
              interactive ? appSupportedDisplayModes : undefined
            }
            onSaveView={allowSaveView ? handleSaveView : undefined}
            canSaveView={allowSaveView ? canSaveView : undefined}
            saveDisabledReason={allowSaveView ? saveDisabledReason : undefined}
            isSaving={isSaving}
            minimalMode={minimalMode}
            {...approvalProps}
          />
          <WidgetReplay
            chatSessionId={chatSessionId}
            toolName={toolInfo.toolName}
            toolCallId={toolInfo.toolCallId}
            toolState={toolInfo.toolState}
            toolInput={toolInfo.input ?? null}
            toolOutput={resolvedToolOutput}
            rawOutput={toolInfo.rawOutput}
            toolErrorText={toolInfo.errorText}
            toolMetadata={effectiveToolMeta}
            toolsMetadata={toolsMetadata}
            toolServerMap={toolServerMap}
            renderOverride={renderOverride}
            onSendFollowUp={interactive ? onSendFollowUp : undefined}
            onCallTool={
              interactive
                ? (toolName, params) =>
                    callTool(serverId ?? "offline-view", toolName, params)
                : undefined
            }
            onAppToolInvocationChange={onAppToolInvocationChange}
            onWidgetStateChange={interactive ? onWidgetStateChange : undefined}
            onModelContextUpdate={
              interactive ? onModelContextUpdate : undefined
            }
            pipWidgetId={pipWidgetId}
            fullscreenWidgetId={fullscreenWidgetId}
            onRequestPip={interactive ? onRequestPip : undefined}
            onExitPip={interactive ? onExitPip : undefined}
            onRequestFullscreen={interactive ? onRequestFullscreen : undefined}
            onExitFullscreen={interactive ? onExitFullscreen : undefined}
            onRequestTeardown={interactive ? onRequestTeardown : undefined}
            displayMode={interactive ? displayMode : undefined}
            onDisplayModeChange={interactive ? onDisplayModeChange : undefined}
            onAppSupportedDisplayModesChange={
              interactive ? setAppSupportedDisplayModes : undefined
            }
            minimalMode={minimalMode}
          />
        </>
      );
    }

    return (
      <ToolPart
        part={toolPart}
        chatSessionId={chatSessionId}
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
      <JsonPart
        label={getDataLabel(part.type)}
        value={(part as any).data}
        autoHeight={Boolean((part as any).autoHeight)}
      />
    );
  }

  switch (part.type) {
    case "text":
      return <TextPart text={part.text} role={role} />;
    case "reasoning":
      return (
        <ReasoningPart
          text={part.text}
          state={part.state}
          displayMode={reasoningDisplayMode}
        />
      );
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
