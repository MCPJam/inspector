import { memo, type ReactNode } from "react";
import { MessageCircle } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";

import { PartSwitch } from "./part-switch";
import {
  type AnyPart,
  groupAssistantPartsIntoSteps,
  isHiddenInternalMessage,
} from "./internal/thread-helpers";
import type {
  ChatUiModel,
  ReasoningDisplayMode,
  ToolRenderContext,
  ToolRenderOverride,
  ToolServerMap,
  WidgetPolicy,
  WidgetRenderInput,
} from "./types";

export interface MessageViewProps {
  message: UIMessage;
  model?: ChatUiModel;
  toolsMetadata?: Record<string, Record<string, unknown>>;
  toolServerMap?: ToolServerMap;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  reasoningDisplayMode?: ReasoningDisplayMode;
  widgetPolicy?: WidgetPolicy;
  renderTool?: (ctx: ToolRenderContext) => ReactNode;
  renderWidget?: (input: WidgetRenderInput) => ReactNode;
  /** Show a generic assistant avatar to the left of assistant messages. */
  showAssistantAvatar?: boolean;
  /** Host override for the assistant avatar (e.g. provider logos). */
  renderAvatar?: (model: ChatUiModel | undefined) => ReactNode;
}

function getPartKey(part: AnyPart, stepIndex: number, partIndex: number) {
  const candidate = part as { type?: string; toolCallId?: unknown; id?: unknown };
  if (typeof candidate.toolCallId === "string" && candidate.toolCallId.length > 0) {
    return `tool-${candidate.toolCallId}`;
  }
  if (typeof candidate.id === "string" && candidate.id.length > 0) {
    return `${candidate.type ?? "part"}-${candidate.id}`;
  }
  return `${stepIndex}-${partIndex}`;
}

function MessageViewImpl({
  message,
  model,
  toolsMetadata,
  toolServerMap,
  toolRenderOverrides,
  reasoningDisplayMode = "inline",
  widgetPolicy = "placeholder",
  renderTool,
  renderWidget,
  showAssistantAvatar = true,
  renderAvatar,
}: MessageViewProps) {
  if (isHiddenInternalMessage(message)) return null;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;

  const partProps = {
    role,
    toolsMetadata,
    toolServerMap,
    toolRenderOverrides,
    reasoningDisplayMode,
    widgetPolicy,
    renderTool,
    renderWidget,
  };

  if (role === "user") {
    const parts = message.parts ?? [];
    const fileParts = parts.filter((part) => part.type === "file");
    const otherParts = parts.filter((part) => part.type !== "file");

    return (
      <div className="mcpjam-chat-message mcpjam-chat-message-user flex w-full min-w-0 flex-col items-end gap-2">
        {fileParts.length > 0 ? (
          <div className="flex max-w-[min(100%,48rem)] flex-wrap justify-end gap-2">
            {fileParts.map((part, i) => (
              <PartSwitch key={`file-${i}`} part={part} {...partProps} />
            ))}
          </div>
        ) : null}
        {otherParts.length > 0 || fileParts.length === 0 ? (
          <div className="max-w-[min(100%,48rem)] rounded-2xl bg-muted px-4 py-2.5 text-foreground">
            {otherParts.map((part, i) => (
              <PartSwitch key={i} part={part} {...partProps} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const steps = groupAssistantPartsIntoSteps(message.parts ?? []);

  const avatar = renderAvatar ? (
    renderAvatar(model)
  ) : (
    <div
      className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border"
      aria-label={model?.name ?? "Assistant"}
    >
      <MessageCircle className="h-4 w-4 text-muted-foreground" aria-hidden />
    </div>
  );

  return (
    <article
      className={
        showAssistantAvatar
          ? "mcpjam-chat-message mcpjam-chat-message-assistant flex w-full min-w-0 gap-4"
          : "mcpjam-chat-message mcpjam-chat-message-assistant w-full min-w-0"
      }
    >
      {showAssistantAvatar ? avatar : null}
      <div className="min-w-0 flex-1">
        <div className="space-y-6 text-sm leading-6">
          {steps.map((stepParts, sIdx) => (
            <div key={sIdx} className="space-y-3">
              {stepParts.map((part, pIdx) => (
                <PartSwitch
                  key={getPartKey(part, sIdx, pIdx)}
                  part={part}
                  {...partProps}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export const MessageView = memo(MessageViewImpl);
MessageView.displayName = "MessageView";
