import { MessageCircle } from "lucide-react";

import { ModelDefinition } from "@/shared/types";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useSandboxHostStyle,
  useSandboxHostTheme,
} from "@/contexts/sandbox-host-style-context";
import {
  LoadingIndicatorContent,
  type LoadingIndicatorVariant,
} from "./loading-indicator-content";
import { getAssistantAvatarDescriptor } from "./assistant-avatar";

export function ThinkingIndicator({
  model,
  variant = "default",
}: {
  model: ModelDefinition;
  variant?: LoadingIndicatorVariant;
}) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const sandboxHostStyle = useSandboxHostStyle();
  const sandboxHostTheme = useSandboxHostTheme();
  const assistantAvatar = getAssistantAvatarDescriptor({
    model,
    themeMode: sandboxHostTheme ?? themeMode,
    sandboxHostStyle,
  });
  const shouldRenderAssistantAvatar = sandboxHostStyle === null;

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
        <LoadingIndicatorContent variant={variant} />
      </div>
    </article>
  );
}
