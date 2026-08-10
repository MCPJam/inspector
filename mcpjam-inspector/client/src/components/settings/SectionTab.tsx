import { cn } from "@/lib/utils";

interface SectionTabProps {
  label: string;
  isActive: boolean;
  onSelect: () => void;
}

/**
 * One tab in a Settings tab strip. Shared by the top-level section nav and the
 * organization's sub-sections so both strips keep the same height and rhythm —
 * two nav rows stacked at different metrics read as two unrelated widgets.
 */
export function SectionTab({ label, isActive, onSelect }: SectionTabProps) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!isActive) onSelect();
      }}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "-mb-px shrink-0 rounded-t-sm border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
        isActive
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}
