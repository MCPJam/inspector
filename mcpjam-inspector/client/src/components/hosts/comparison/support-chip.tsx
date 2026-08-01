import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { cn } from "@/lib/utils";
import type { SupportLevel } from "./support-level";

/**
 * caniuse-style support pill: a colored dot + label. Tinted surface (`/40–/50`)
 * with a full-token dot and `text-foreground`, per the surface-vs-foreground
 * opacity convention. When `caveats` are present the chip grows a superscript
 * count and a popover footnote ("yes, with caveats").
 */

const LEVEL_SURFACE: Record<SupportLevel, string> = {
  supported: "bg-success/50 text-foreground",
  partial: "bg-warning/50 text-foreground",
  neutral: "bg-muted/40 text-muted-foreground",
  unsupported: "bg-destructive/50 text-foreground",
};

const LEVEL_DOT: Record<SupportLevel, string> = {
  supported: "bg-success",
  partial: "bg-warning",
  neutral: "bg-muted-foreground/50",
  unsupported: "bg-destructive",
};

export function SupportChip({
  level,
  label,
  caveats,
  className,
}: {
  level: SupportLevel;
  label: string;
  caveats?: ReadonlyArray<string>;
  className?: string;
}) {
  const hasCaveats = !!caveats && caveats.length > 0;

  const chip = (
    <span
      data-support-level={level}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
        "text-[11px] font-medium leading-none whitespace-nowrap",
        LEVEL_SURFACE[level],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", LEVEL_DOT[level])} />
      {label}
      {hasCaveats && (
        <sup className="ml-0.5 text-[9px] font-semibold tabular-nums">
          {caveats!.length}
        </sup>
      )}
    </span>
  );

  if (!hasCaveats) return chip;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label} — ${caveats!.length} caveat${caveats!.length === 1 ? "" : "s"}`}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {chip}
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-w-[280px] p-3 text-[11.5px] leading-snug">
        <ul className="space-y-1.5">
          {caveats!.map((c, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {i + 1}.
              </span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
