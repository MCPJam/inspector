import type { ReactNode } from "react";
import type { UIMessage } from "@ai-sdk/react";
import type { DynamicToolUIPart, ToolUIPart, UITools } from "ai";

import {
  type AnyPart,
  getDataLabel,
  getToolInfo,
  isDataPart,
  isDynamicTool,
  isToolPart,
} from "./internal/thread-helpers";
import { readToolResultMeta, readToolResultServerId } from "./internal/tool-result-utils";
import {
  detectUIType,
  getUIResourceUri,
  isWidgetUiType,
} from "./internal/widget-detection";
import { TextPart } from "./parts/text-part";
import { ReasoningPart } from "./parts/reasoning-part";
import { FilePart } from "./parts/file-part";
import { SourceUrlPart } from "./parts/source-url-part";
import { SourceDocumentPart } from "./parts/source-document-part";
import { JsonPart } from "./parts/json-part";
import { ToolCallPart } from "./tool-call-part";
import { WidgetPlaceholder } from "./widget-placeholder";
import type {
  ReasoningDisplayMode,
  ToolRenderContext,
  ToolRenderOverride,
  ToolServerMap,
  WidgetPolicy,
  WidgetRenderInput,
} from "./types";

function getToolServerId(
  toolName: string,
  toolServerMap: ToolServerMap,
): string | undefined {
  return toolServerMap[toolName];
}

export interface PartSwitchProps {
  part: AnyPart;
  role: UIMessage["role"];
  toolsMetadata?: Record<string, Record<string, unknown>>;
  toolServerMap?: ToolServerMap;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  reasoningDisplayMode?: ReasoningDisplayMode;
  widgetPolicy?: WidgetPolicy;
  /**
   * Host override for tool rendering. When provided, the package delegates the
   * entire tool block to the host (the inspector returns its interactive
   * `ToolPart`). When omitted, the static `ToolCallPart` is rendered.
   */
  renderTool?: (ctx: ToolRenderContext) => ReactNode;
  /**
   * Host override for widget rendering. When omitted, widget-bearing tools
   * render `WidgetPlaceholder` (per `widgetPolicy`) — the package never mounts
   * a widget itself.
   */
  renderWidget?: (input: WidgetRenderInput) => ReactNode;
}

export function PartSwitch({
  part,
  role,
  toolsMetadata = {},
  toolServerMap = {},
  toolRenderOverrides,
  reasoningDisplayMode = "inline",
  widgetPolicy = "placeholder",
  renderTool,
  renderWidget,
}: PartSwitchProps) {
  if (isToolPart(part) || isDynamicTool(part)) {
    const toolPart = part as ToolUIPart<UITools> | DynamicToolUIPart;
    const info = getToolInfo(toolPart);

    const renderOverride = info.toolCallId
      ? toolRenderOverrides?.[info.toolCallId]
      : undefined;
    const partToolMeta = toolsMetadata[info.toolName];
    const streamedToolMeta = readToolResultMeta(info.rawOutput);
    const effectiveToolMeta =
      renderOverride?.toolMetadata ?? partToolMeta ?? streamedToolMeta;
    const uiType = detectUIType(effectiveToolMeta, info.rawOutput);
    const isWidget = isWidgetUiType(uiType);
    const serverId =
      renderOverride?.serverId ??
      getToolServerId(info.toolName, toolServerMap) ??
      readToolResultServerId(info.rawOutput);

    const hasOverrideOutput =
      renderOverride !== undefined &&
      Object.prototype.hasOwnProperty.call(renderOverride, "toolOutput");
    const resolvedOutput = hasOverrideOutput
      ? renderOverride?.toolOutput
      : info.output ?? info.rawOutput;

    const ctx: ToolRenderContext = {
      toolName: info.toolName,
      toolCallId: info.toolCallId,
      toolState: info.toolState,
      input: info.input,
      output: resolvedOutput,
      rawOutput: info.rawOutput,
      errorText: info.errorText,
      uiType,
      isWidget,
      serverId: serverId ?? undefined,
      toolMetadata: effectiveToolMeta,
      renderOverride,
    };

    // `renderTool` replaces only the tool block; widget handling still runs
    // afterward so a host can supply an interactive tool block AND mount a real
    // widget (the inspector renders its ToolPart + WidgetReplay as siblings).
    const toolBlock = renderTool ? (
      renderTool(ctx)
    ) : (
      <ToolCallPart
        toolName={info.toolName}
        toolState={info.toolState}
        input={info.input}
        output={resolvedOutput}
        errorText={info.errorText}
      />
    );

    if (!isWidget) return <>{toolBlock}</>;

    let widgetNode: ReactNode = null;
    if (renderWidget) {
      widgetNode = renderWidget({
        ...ctx,
        resourceUri:
          renderOverride?.resourceUri ??
          getUIResourceUri(uiType, effectiveToolMeta) ??
          undefined,
        toolsMetadata,
        toolServerMap,
      });
    } else if (widgetPolicy === "placeholder") {
      widgetNode = <WidgetPlaceholder toolName={info.toolName} />;
    }

    return (
      <>
        {toolBlock}
        {widgetNode}
      </>
    );
  }

  if (isDataPart(part)) {
    return (
      <JsonPart
        label={getDataLabel(part.type)}
        value={(part as { data?: unknown }).data}
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
