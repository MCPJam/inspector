import { UIMessage } from "@ai-sdk/react";
import { MessageCircle } from "lucide-react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

import { UserMessageBubble } from "./user-message-bubble";
import { PartSwitch } from "./part-switch";
import { ModelDefinition } from "@/shared/types";
import { type DisplayMode } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getProviderLogoFromModel } from "@/components/chat-v2/shared/chat-helpers";
import { groupAssistantPartsIntoSteps } from "./thread-helpers";
import { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";

export function MessageView({
  message,
  model,
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
  selectedProtocolOverrideIfBothExists,
  onToolApprovalResponse,
}: {
  message: UIMessage;
  model: ModelDefinition;
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
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogoFromModel(model, themeMode);
  // Hide widget state messages (these are internal and sent to the model)
  if (message.id?.startsWith("widget-state-")) return null;
  // Hide model context messages (these are internal and sent to the model)
  if (message.id?.startsWith("model-context-")) return null;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;

  if (role === "user") {
    // Separate file parts from other parts - files render above the bubble
    const fileParts =
      message.parts?.filter((part) => part.type === "file") ?? [];
    const otherParts =
      message.parts?.filter((part) => part.type !== "file") ?? [];

    return (
      <div className="flex flex-col items-end gap-2">
        {/* File attachments above the bubble */}
        {fileParts.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2 max-w-3xl">
            {fileParts.map((part, i) => (
              <PartSwitch
                key={`file-${i}`}
                part={part}
                role={role}
                onSendFollowUp={onSendFollowUp}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={onWidgetStateChange}
                onModelContextUpdate={onModelContextUpdate}
                pipWidgetId={pipWidgetId}
                fullscreenWidgetId={fullscreenWidgetId}
                onRequestPip={onRequestPip}
                onExitPip={onExitPip}
                onRequestFullscreen={onRequestFullscreen}
                onExitFullscreen={onExitFullscreen}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
                selectedProtocolOverrideIfBothExists={
                  selectedProtocolOverrideIfBothExists
                }
              />
            ))}
          </div>
        )}
        {/* Text and other parts inside the bubble */}
        {(otherParts.length > 0 || fileParts.length === 0) && (
          <UserMessageBubble>
            {otherParts.map((part, i) => (
              <PartSwitch
                key={i}
                part={part}
                role={role}
                onSendFollowUp={onSendFollowUp}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={onWidgetStateChange}
                onModelContextUpdate={onModelContextUpdate}
                pipWidgetId={pipWidgetId}
                fullscreenWidgetId={fullscreenWidgetId}
                onRequestPip={onRequestPip}
                onExitPip={onExitPip}
                onRequestFullscreen={onRequestFullscreen}
                onExitFullscreen={onExitFullscreen}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
                selectedProtocolOverrideIfBothExists={
                  selectedProtocolOverrideIfBothExists
                }
              />
            ))}
          </UserMessageBubble>
        )}
      </div>
    );
  }

  const steps = groupAssistantPartsIntoSteps(message.parts ?? []);
  return (
    <article className="flex gap-4 w-full">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/40">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={`${model.id} logo`}
            className="h-4 w-4 object-contain"
          />
        ) : (
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-6 text-sm leading-6">
        {steps.map((stepParts, sIdx) => (
          <div key={sIdx} className="space-y-3">
            {stepParts.map((part, pIdx) => (
              <PartSwitch
                key={`${sIdx}-${pIdx}`}
                part={part}
                role={role}
                onSendFollowUp={onSendFollowUp}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={onWidgetStateChange}
                onModelContextUpdate={onModelContextUpdate}
                pipWidgetId={pipWidgetId}
                fullscreenWidgetId={fullscreenWidgetId}
                onRequestPip={onRequestPip}
                onExitPip={onExitPip}
                onRequestFullscreen={onRequestFullscreen}
                onExitFullscreen={onExitFullscreen}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
                selectedProtocolOverrideIfBothExists={
                  selectedProtocolOverrideIfBothExists
                }
                onToolApprovalResponse={onToolApprovalResponse}
                messageParts={message.parts}
              />
            ))}
          </div>
        ))}
      </div>
    </article>
  );
}
