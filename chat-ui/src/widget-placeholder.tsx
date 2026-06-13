import { LayoutTemplate } from "lucide-react";
import { cn } from "./internal/cn";

/**
 * Deterministic Tier A placeholder for widget-bearing tool calls. The package
 * never mounts a widget surface (that is Tier B / inspector `WidgetReplay`); it
 * shows this static notice instead so transcript review is unblocked.
 */
export function WidgetPlaceholder({
  toolName,
  className,
}: {
  toolName?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mcpjam-chat-widget-placeholder flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground",
        className,
      )}
      data-widget-placeholder="true"
      data-tool-name={toolName}
    >
      <LayoutTemplate className="h-4 w-4 shrink-0" />
      <span>
        Interactive widget{toolName ? ` for ${toolName}` : ""} is not shown in
        this read-only view.
      </span>
    </div>
  );
}
