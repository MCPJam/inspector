import type { KeyboardEvent, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One expandable log line. Shared by the MCP JSON-RPC logger and the WebMCP
 * activity rail so both click, hover, and expand the same way.
 *
 * Data stays in each product's store. This is only the chrome.
 */
export function LogRow({
  expanded,
  onToggle,
  isError,
  borderClass,
  badge,
  title,
  titleTooltip,
  meta,
  timestamp,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  isError?: boolean;
  borderClass?: string;
  badge: ReactNode;
  title: ReactNode;
  titleTooltip?: string;
  meta?: ReactNode;
  timestamp: string;
  children?: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <div
      className={cn(
        "group border-b border-border border-l-2",
        borderClass ?? "border-l-transparent",
        isError && "bg-destructive/5",
        expanded && "bg-muted/20",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        className="flex h-7 cursor-pointer select-none items-center gap-1.5 px-2 transition-colors hover:bg-muted/30"
        onClick={onToggle}
        onKeyDown={onKeyDown}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        {badge}
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs",
            isError ? "text-destructive" : "text-foreground",
          )}
          title={titleTooltip}
        >
          {title}
        </span>
        {meta}
        <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
          {timestamp}
        </span>
      </div>
      {expanded && children ? (
        <div className="border-t border-border bg-muted/10 p-2">{children}</div>
      ) : null}
    </div>
  );
}
