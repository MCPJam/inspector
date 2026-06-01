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
      className={cn(
        "flex items-center rounded-md border bg-muted/40 p-0.5 gap-0.5",
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
            "px-2 py-0.5 text-xs rounded transition-colors",
            value === option.value
              ? "bg-background text-foreground shadow-sm font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
