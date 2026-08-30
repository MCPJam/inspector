import { cn } from "@/lib/utils";
import type { SupportLevel } from "./support-level";

type SupportChipLevel = SupportLevel | "unknown";

/**
 * caniuse-style support pill: a colored dot + label. Tinted surface (`/40–/50`)
 * with a full-token dot and `text-foreground`, per the surface-vs-foreground
 * opacity convention.
 */

const LEVEL_SURFACE: Record<SupportChipLevel, string> = {
  supported: "bg-success/50 text-foreground",
  partial: "bg-warning/50 text-foreground",
  neutral: "bg-muted/40 text-muted-foreground",
  unsupported: "bg-destructive/50 text-foreground",
  unknown: "bg-muted/40 text-muted-foreground",
};

const LEVEL_DOT: Record<SupportChipLevel, string> = {
  supported: "bg-success",
  partial: "bg-warning",
  neutral: "bg-muted-foreground/50",
  unsupported: "bg-destructive",
  unknown: "bg-muted-foreground/50",
};

export function SupportChip({
  level,
  label,
  className,
  truncateLabel = false,
}: {
  level: SupportChipLevel;
  label: string;
  className?: string;
  truncateLabel?: boolean;
}) {
  return (
    <span
      data-support-level={level}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
        truncateLabel && "max-w-full",
        "text-[11px] font-medium leading-none whitespace-nowrap",
        LEVEL_SURFACE[level],
        className
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", LEVEL_DOT[level])}
      />
      {truncateLabel ? (
        <span className="min-w-0 truncate">{label}</span>
      ) : (
        label
      )}
    </span>
  );
}
