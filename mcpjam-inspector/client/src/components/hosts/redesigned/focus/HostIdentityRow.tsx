import { useMemo } from "react";
import { Input } from "@mcpjam/design-system/input";
import { cn } from "@/lib/utils";
import { listHostStyles, type HostStyleId } from "@/lib/host-styles";

/**
 * Identity row rendered in the sticky chrome above the focus-overlay tabs.
 * Hosts the editable host name and the vendor style picker. Both fields
 * apply to every tab, so they live in chrome rather than inside any tab.
 *
 * Style switch only patches `hostStyle` — `hostCapabilitiesOverride` and
 * `mcpProfile` are intentionally left alone. The Apps tab surfaces the
 * resulting "Override active" pip if the user wants to drop the override.
 */
export interface HostIdentityRowProps {
  hostDisplayName: string;
  onHostDisplayNameChange: (next: string) => void;
  hostStyle: HostStyleId;
  onHostStyleChange: (next: HostStyleId) => void;
  hasNameIssue: boolean;
  className?: string;
}

export function HostIdentityRow({
  hostDisplayName,
  onHostDisplayNameChange,
  hostStyle,
  onHostStyleChange,
  hasNameIssue,
  className,
}: HostIdentityRowProps) {
  const styles = useMemo(() => listHostStyles(), []);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3",
        className,
      )}
    >
      <Input
        value={hostDisplayName}
        onChange={(event) => onHostDisplayNameChange(event.target.value)}
        placeholder="Host name"
        aria-label="Host name"
        className={cn(
          "h-8 min-w-0 flex-1 text-[13px]",
          hasNameIssue && "border-amber-500",
        )}
      />
      <div
        role="radiogroup"
        aria-label="Host style"
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted/40 p-0.5"
      >
        {styles.map((opt) => {
          const selected = opt.id === hostStyle;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onHostStyleChange(opt.id)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12px] font-medium",
                "motion-safe:transition-transform motion-safe:duration-150 motion-safe:active:scale-[0.96]",
                selected
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <img
                src={opt.chatUi.logoSrc}
                alt=""
                className="size-3.5 object-contain"
              />
              {opt.chatUi.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
