import { MessageCircle } from "lucide-react";

import { ModelDefinition } from "@/shared/types";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getProviderLogoFromModel } from "./chat-helpers";

export function ThinkingIndicator({ model }: { model: ModelDefinition }) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const logoSrc = getProviderLogoFromModel(model, themeMode);

  return (
    <article
      className="flex w-full gap-4 text-sm leading-6 text-muted-foreground"
      aria-live="polite"
      aria-busy="true"
    >
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

      <div className="flex-1 min-w-0">
        <div className="inline-flex items-center gap-2 text-muted-foreground/80">
          <span className="text-sm italic">
            Thinking
            <span className="inline-flex">
              <span className="animate-[blink_1.4s_ease-in-out_infinite]">
                .
              </span>
              <span className="animate-[blink_1.4s_ease-in-out_0.2s_infinite]">
                .
              </span>
              <span className="animate-[blink_1.4s_ease-in-out_0.4s_infinite]">
                .
              </span>
            </span>
          </span>
        </div>
      </div>
    </article>
  );
}
