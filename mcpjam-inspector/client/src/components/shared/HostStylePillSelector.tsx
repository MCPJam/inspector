import { ToggleGroup, ToggleGroupItem } from "@mcpjam/design-system/toggle-group";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";
import { listHostStyles } from "@/lib/host-styles";
import { cn } from "@/lib/utils";

interface HostStylePillSelectorProps {
  value: ChatboxHostStyle;
  onValueChange: (hostStyle: ChatboxHostStyle) => void;
  className?: string;
}

export function HostStylePillSelector({
  value,
  onValueChange,
  className,
}: HostStylePillSelectorProps) {
  return (
    <div
      className={cn(
        "relative isolate w-full overflow-hidden rounded-full bg-muted/30 p-[1.5px] ring-1 ring-border/45",
        className,
      )}
      data-selected-host-style={value}
    >
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue) {
            onValueChange(nextValue);
          }
        }}
        aria-label="Host style"
        className="relative flex w-full rounded-full bg-transparent p-0"
      >
        {listHostStyles().map((host) => (
          <ToggleGroupItem
            key={host.id}
            value={host.id}
            size="sm"
            className="h-[22px] min-w-0 flex-1 rounded-full border-0 bg-transparent px-2 text-[10px] font-medium text-muted-foreground/90 first:rounded-full last:rounded-full hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)] dark:data-[state=on]:shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]"
            aria-label={host.label}
          >
            <span className="inline-flex min-w-0 items-center gap-1">
              <img
                src={host.logoSrc}
                alt=""
                aria-hidden="true"
                className="h-3 w-3 shrink-0 object-contain"
              />
              <span className="truncate">{host.label}</span>
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
