import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { SandboxHostStyle } from "@/lib/sandbox-host-style";
import { cn } from "@/lib/utils";

interface HostStylePillSelectorProps {
  value: SandboxHostStyle;
  onValueChange: (hostStyle: SandboxHostStyle) => void;
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
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-[1.5px] top-[1.5px] bottom-[1.5px] w-[calc(50%-1.5px)] rounded-full bg-background shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)] transition-transform duration-200 ease-out motion-reduce:transition-none dark:shadow-[0_1px_2px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]",
          value === "claude" && "translate-x-full",
        )}
      />
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue === "chatgpt" || nextValue === "claude") {
            onValueChange(nextValue);
          }
        }}
        aria-label="Host style"
        className="relative w-full rounded-full bg-transparent p-0"
      >
        <ToggleGroupItem
          value="chatgpt"
          size="sm"
          className="z-10 h-[22px] min-w-0 flex-1 rounded-full border-0 bg-transparent px-2 text-[10px] font-medium tracking-[-0.01em] text-muted-foreground/90 first:rounded-full last:rounded-full hover:bg-transparent hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-none"
          aria-label="ChatGPT"
        >
          ChatGPT
        </ToggleGroupItem>
        <ToggleGroupItem
          value="claude"
          size="sm"
          className="z-10 h-[22px] min-w-0 flex-1 rounded-full border-0 bg-transparent px-2 text-[10px] font-medium tracking-[-0.01em] text-muted-foreground/90 first:rounded-full last:rounded-full hover:bg-transparent hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-none"
          aria-label="Claude"
        >
          Claude
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
