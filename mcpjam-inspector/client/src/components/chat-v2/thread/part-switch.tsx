import { ToolUIPart, DynamicToolUIPart, UITools } from "ai";
import { UIMessage } from "@ai-sdk/react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

import { ChatGPTAppRenderer } from "./chatgpt-app-renderer";
import { MCPAppsRenderer } from "./mcp-apps-renderer";
import { ToolPart } from "./parts/tool-part";
import { ReasoningPart } from "./parts/reasoning-part";
import { FilePart } from "./parts/file-part";
import { SourceUrlPart } from "./parts/source-url-part";
import { SourceDocumentPart } from "./parts/source-document-part";
import { JsonPart } from "./parts/json-part";
import { TextPart } from "./parts/text-part";
import { MCPUIResourcePart } from "./parts/mcp-ui-resource-part";
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
}) {
  if (isToolPart(part) || isDynamicTool(part)) {
    const toolPart = part as ToolUIPart<UITools> | DynamicToolUIPart;
    const toolInfo = getToolInfo(toolPart);
    const partToolMeta = toolsMetadata[toolInfo.toolName];
    const uiType = detectUIType(partToolMeta, toolInfo.rawOutput);
    const uiResourceUri = getUIResourceUri(uiType, partToolMeta);
    const uiResource =
      uiType === UIType.MCP_UI ? extractUIResource(toolInfo.rawOutput) : null;
    const serverId = getToolServerId(toolInfo.toolName, toolServerMap);

    if (uiResource) {
      return (
        <>
          <ToolPart part={toolPart} uiType={uiType} />
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
      if (toolInfo.toolState !== "output-available") {
        return (
          <>
            <ToolPart part={toolPart} uiType={uiType} />
            <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
              Waiting for tool to finish executing...
            </div>
          </>
        );
      }

      if (!serverId) {
        return (
          <>
            <ToolPart part={toolPart} uiType={uiType} />
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
            <ToolPart part={toolPart} uiType={uiType} />
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
          />
        </>
      );
    }
    return <ToolPart part={toolPart} uiType={uiType} />;
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
