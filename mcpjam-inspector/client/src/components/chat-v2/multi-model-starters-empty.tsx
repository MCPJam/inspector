import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { STARTER_PROMPTS } from "@/components/chat-v2/shared/chat-helpers";

export interface MultiModelStarterPromptsBlockProps {
  onStarterPrompt: (text: string) => void;
  chipClassName?: string;
  className?: string;
  /** Default matches ChatTabV2 non-minimal starter row spacing. */
  headingClassName?: string;
}

/** Shared starter title + chips (used by Chat tab layout and App Builder multi-model). */
export function MultiModelStarterPromptsBlock({
  onStarterPrompt,
  chipClassName = "rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground transition hover:border-foreground hover:bg-accent cursor-pointer font-light",
  className,
  headingClassName = "mb-3 text-sm text-muted-foreground",
}: MultiModelStarterPromptsBlockProps) {
  return (
    <div className={cn("text-center", className)}>
      <p className={headingClassName}>Try one of these to get started</p>
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
  );
}

export interface MultiModelStarterChipsStripProps {
  onStarterPrompt: (text: string) => void;
  chipClassName?: string;
}

/** Compact starter block with bottom margin for placement above compare grids. */
export function MultiModelStarterChipsStrip({
  onStarterPrompt,
  chipClassName,
}: MultiModelStarterChipsStripProps) {
  return (
    <div className="mb-4 w-full shrink-0">
      <MultiModelStarterPromptsBlock
        onStarterPrompt={onStarterPrompt}
        chipClassName={chipClassName}
        headingClassName="mb-2 text-sm text-muted-foreground"
      />
    </div>
  );
}

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
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4">
      <div className="w-full max-w-4xl space-y-6 py-8">
        {authPrimarySlot}
        <div className="space-y-4">
          {showStarterPrompts ? (
            <MultiModelStarterPromptsBlock
              onStarterPrompt={onStarterPrompt}
              chipClassName={chipClassName}
            />
          ) : null}
          {!isAuthLoading ? chatInputSlot : null}
        </div>
      </div>
    </div>
  );
}
