import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { Layers, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export type HostSectionValue = "host" | "compare";

const TABS: ReadonlyArray<{
  value: HostSectionValue;
  label: string;
  Icon: typeof Layers;
}> = [
  { value: "host", label: "Host", Icon: SlidersHorizontal },
  { value: "compare", label: "Compare", Icon: Layers },
];

/**
 * Secondary nav for the Host section: switches between a single host's
 * canvas ("Host") and the multi-host comparison ("Compare"). A refined
 * segmented control — the active pill glides between tabs (shared layout),
 * distinct from the primary underline nav.
 *
 * Renders as a bare inline-flex element so callers can drop it into a header
 * row (e.g. beside the Save button) rather than stacking it as its own bar;
 * pass `className` to control placement.
 */
export function HostSectionTabs({
  value,
  hostEnabled,
  onSelect,
  className,
}: {
  value: HostSectionValue;
  /** "Host" needs a previewed host to land on; disabled otherwise. */
  hostEnabled: boolean;
  onSelect: (next: HostSectionValue) => void;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div className={cn("inline-flex", className)}>
      <LayoutGroup id="host-section-tabs">
        <div
          role="tablist"
          aria-label="Host section"
          className="inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/40 p-1 shadow-[inset_0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-sm"
        >
          {TABS.map(({ value: v, label, Icon }) => {
            const active = v === value;
            const disabled = v === "host" && !hostEnabled;
            return (
              <button
                key={v}
                role="tab"
                type="button"
                aria-selected={active}
                disabled={disabled}
                onClick={() => !active && !disabled && onSelect(v)}
                className={cn(
                  "relative inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium",
                  "transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="host-section-active-pill"
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full bg-card shadow-sm ring-1 ring-border/70"
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 560, damping: 40, mass: 0.7 }
                    }
                  />
                )}
                <Icon
                  className={cn(
                    "relative z-10 size-3.5 transition-colors",
                    active ? "text-primary" : "",
                  )}
                />
                <span className="relative z-10">{label}</span>
              </button>
            );
          })}
        </div>
      </LayoutGroup>
    </div>
  );
}
