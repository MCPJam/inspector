import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SettingSummary } from "./suite-settings-summary";

export function SettingSummaryCell({
  model,
  extra,
}: {
  model: SettingSummary;
  extra?: ReactNode;
}) {
  const toneClass =
    model.tone === "attention"
      ? "text-destructive"
      : model.tone === "empty" || model.tone === "gap"
        ? "text-muted-foreground"
        : "text-foreground";
  return (
    <div className="space-y-0.5">
      <div className={cn("text-sm", toneClass)}>
        {model.text}
        {model.cta ? (
          <span className="ml-1 text-muted-foreground">{model.cta}</span>
        ) : null}
      </div>
      {model.detail ? (
        <div className="text-[11px] text-muted-foreground">{model.detail}</div>
      ) : null}
      {model.chips && model.chips.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {model.chips.map((chip) => (
            <span
              key={chip.label}
              className={cn(
                "rounded-md border px-1.5 py-px text-[11px]",
                chip.tone === "attention"
                  ? "border-destructive/40 text-destructive"
                  : "border-border text-muted-foreground",
              )}
            >
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
      {extra}
    </div>
  );
}
