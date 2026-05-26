import { MessageCircle } from "lucide-react";

import { ModelDefinition } from "@/shared/types";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-client-style-context";
import { LoadingIndicatorContent } from "./loading-indicator-content";
import { getAssistantAvatarDescriptor } from "./assistant-avatar";
import { CopilotMessageHeader } from "@/components/chat-v2/thread/copilot-message-header";

export function ThinkingIndicator({
  model,
}: {
  model: ModelDefinition;
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const assistantAvatar = getAssistantAvatarDescriptor({
    model,
    themeMode: chatboxHostTheme ?? themeMode,
    chatboxHostStyle,
  });
  const shouldRenderAssistantAvatar = chatboxHostStyle === null;
  // Copilot's UI keeps the "Copilot + mascot" row visible during the
  // thinking state too — the dot sits BELOW it. Matches MessageView's
  // own conditional render so the header is identical in both phases.
  const shouldRenderCopilotHeader = chatboxHostStyle === "copilot";

  if (shouldRenderCopilotHeader) {
    return (
      <article
        className="w-full text-sm leading-6 text-muted-foreground"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="mb-2">
          <CopilotMessageHeader />
        </div>
        <div className="inline-flex items-center gap-2 text-muted-foreground/80">
          <LoadingIndicatorContent modelProvider={model?.provider ?? null} />
        </div>
      </article>
    );
  }

  return (
    <article
      className={`w-full text-sm leading-6 text-muted-foreground ${
        shouldRenderAssistantAvatar ? "flex gap-4" : ""
      }`}
      aria-live="polite"
      aria-busy="true"
    >
      {shouldRenderAssistantAvatar ? (
        <div
          className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${assistantAvatar.avatarClasses}`}
          aria-label={assistantAvatar.ariaLabel}
        >
          {assistantAvatar.logoSrc ? (
            <img
              src={assistantAvatar.logoSrc}
              alt={assistantAvatar.logoAlt ?? ""}
              className="h-4 w-4 object-contain"
            />
          ) : (
            <MessageCircle
              className="h-4 w-4 text-muted-foreground"
              aria-hidden
            />
          )}
        </div>
      ) : null}

      <div className="inline-flex items-center gap-2 text-muted-foreground/80">
        <LoadingIndicatorContent modelProvider={model?.provider ?? null} />
      </div>
    </article>
  );
}
