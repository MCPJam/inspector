import { cn } from "@/lib/utils";

/**
 * Secondary toggle for the eval Test Cases list: switch the same case rows
 * between the flat "By case" list (one collapsed Last-run status per case) and
 * the "By host" matrix (one column per attached MCP host).
 *
 * This is purely presentational. Call sites own the state: the standalone Cases
 * view drives it from the `view=cross-host` route param so deep-links stay
 * honest; the Playground dashboard drives it from local component state because
 * its layout differs (dashboard chrome stays, only the case section swaps).
 *
 * Gating (>=2 host attachments) lives at the call site — a one-host matrix is
 * pointless — so this control assumes it should render when mounted.
 */
export type CaseListHostMode = "by-case" | "by-host";

/** Default when the suite has ≥2 host attachments. */
export const DEFAULT_CASE_LIST_HOST_MODE: CaseListHostMode = "by-host";

interface CaseListHostToggleProps {
  value: CaseListHostMode;
  onChange: (value: CaseListHostMode) => void;
  className?: string;
}

const OPTIONS: { value: CaseListHostMode; label: string }[] = [
  { value: "by-case", label: "By case" },
  { value: "by-host", label: "By host" },
];

export function CaseListHostToggle({
  value,
  onChange,
  className,
}: CaseListHostToggleProps) {
  return (
    <div
      role="group"
      aria-label="Test case list layout"
      className={cn(
        "flex items-center rounded-lg border border-border/70 bg-muted/30 p-0.5 gap-0.5 shadow-sm",
        className,
      )}
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            value === option.value
              ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/60"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
