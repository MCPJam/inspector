/**
 * Model slot of the environment composer — opt-in via `slots`.
 *
 * Same dashed-pill-plus-popover language as clients / servers. Single-select:
 * picking replaces the current model and closes. Surfaces that omit this slot
 * (New Swarm today) keep using each client's own model.
 */
import { useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { useAvailableModels } from "@/hooks/use-available-models";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { cn } from "@/lib/utils";

export function ModelsPill({
  projectId,
  value,
  onChange,
  disabled,
  testId,
  inModal = false,
  emptyLabel = "Choose a model",
}: {
  projectId: string;
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  testId?: string;
  /**
   * Render the popover INLINE rather than portalled, for callers inside a Radix
   * Dialog — a portalled popover lands outside the dialog, where the modal
   * overlay swallows every click. Same escape hatch as the other slots.
   */
  inModal?: boolean;
  emptyLabel?: string;
}) {
  const { availableModels } = useAvailableModels({ projectId });
  const [open, setOpen] = useState(false);

  const selected = value
    ? (availableModels.find((model) => String(model.id) === value) ?? null)
    : null;
  const triggerLabel = selected
    ? compactModelLabel(selected.name) || selected.name
    : value
      ? value
      : emptyLabel;

  const pick = (modelId: string | null) => {
    onChange(modelId);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next || !disabled) setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={testId}
          aria-label="Model"
          className={cn(
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            value
              ? "border-border/60 bg-muted/40 hover:bg-muted/60"
              : "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          <Bot className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-1"
        align="start"
        sideOffset={4}
        portalled={!inModal}
      >
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Model
        </div>
        {availableModels.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No models configured. Add API keys in Settings.
          </p>
        ) : (
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {availableModels.map((model) => {
              const modelId = String(model.id);
              const checked = value === modelId;
              return (
                <button
                  key={modelId}
                  type="button"
                  disabled={disabled || model.disabled}
                  aria-pressed={checked}
                  aria-label={model.name}
                  onClick={() => pick(checked ? null : modelId)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/30",
                    (disabled || model.disabled) &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      checked ? "bg-primary" : "bg-muted-foreground/30"
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {model.name}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
