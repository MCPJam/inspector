import type { ReactNode } from "react";
import { STARTER_PROMPTS } from "@/components/chat-v2/shared/chat-helpers";

export interface MultiModelStartersEmptyLayoutProps {
  isAuthLoading: boolean;
  /** When false, hides starter chips (e.g. auth upsell active). */
  showStarterPrompts: boolean;
  /** Loading spinner, upsell panel, or null — rendered above the starter row. */
  authPrimarySlot: ReactNode;
  onStarterPrompt: (text: string) => void;
  chatInputSlot: ReactNode;
  /** Defaults to the non-minimal Chat tab chip styling. */
  chipClassName?: string;
}

/**
 * Centered multi-model empty state: optional auth slot, starter prompts, composer.
 * Matches ChatTabV2 non-minimal `!effectiveHasMessages` layout.
 */
export function MultiModelStartersEmptyLayout({
  isAuthLoading,
  showStarterPrompts,
  authPrimarySlot,
  onStarterPrompt,
  chatInputSlot,
  chipClassName = "rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground transition hover:border-foreground hover:bg-accent cursor-pointer font-light",
}: MultiModelStartersEmptyLayoutProps) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto px-4">
      <div className="w-full max-w-3xl space-y-6 py-8">
        {authPrimarySlot}
        <div className="space-y-4">
          {showStarterPrompts ? (
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-3">
                Try one of these to get started
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt.text}
                    type="button"
                    onClick={() => onStarterPrompt(prompt.text)}
                    className={chipClassName}
                  >
                    {prompt.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {!isAuthLoading ? chatInputSlot : null}
        </div>
      </div>
    </div>
  );
}
