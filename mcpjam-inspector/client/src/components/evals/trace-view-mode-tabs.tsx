import { AlignLeft, Code2, GitCompare, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

export type TraceViewMode = "timeline" | "chat" | "raw" | "tools";

/**
 * Mode switcher for {@link TraceViewer} — shared with compare playground so Runs / CI / compare
 * use identical controls.
 */
export function TraceViewModeTabs({
  mode,
  onModeChange,
  showToolsTab,
  className,
}: {
  mode: TraceViewMode;
  onModeChange: (mode: TraceViewMode) => void;
  showToolsTab: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md border border-border/40 bg-background p-0.5",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onModeChange("timeline")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
          mode === "timeline"
            ? "bg-primary/10 font-medium text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Timeline"
      >
        <AlignLeft className="h-3 w-3" />
        Timeline
      </button>
      <button
        type="button"
        onClick={() => onModeChange("chat")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
          mode === "chat"
            ? "bg-primary/10 font-medium text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Chat view"
      >
        <MessageSquare className="h-3 w-3" />
        Chat
      </button>
      <button
        type="button"
        onClick={() => onModeChange("raw")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
          mode === "raw"
            ? "bg-primary/10 font-medium text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Raw JSON"
      >
        <Code2 className="h-3 w-3" />
        Raw
      </button>
      {showToolsTab ? (
        <button
          type="button"
          onClick={() => onModeChange("tools")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
            mode === "tools"
              ? "bg-primary/10 font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          title="Expected vs actual tool calls"
          data-testid="trace-viewer-tools-tab"
        >
          <GitCompare className="h-3 w-3" />
          Tools
        </button>
      ) : null}
    </div>
  );
}
