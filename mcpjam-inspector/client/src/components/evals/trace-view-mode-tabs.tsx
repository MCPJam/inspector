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
  layout = "default",
  className,
}: {
  mode: TraceViewMode;
  onModeChange: (mode: TraceViewMode) => void;
  showToolsTab: boolean;
  /** `fullWidth`: equal-width segments across the container (e.g. chat trace header). */
  layout?: "default" | "fullWidth";
  className?: string;
}) {
  const fullWidth = layout === "fullWidth";

  const tabClass = (active: boolean) =>
    cn(
      "inline-flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
      fullWidth && "min-h-8 flex-1 basis-0 justify-center",
      active
        ? "bg-primary/10 font-medium text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div
      className={cn(
        "flex items-center rounded-md border border-border/40 bg-background p-0.5",
        fullWidth ? "w-full min-w-0 gap-0.5" : "shrink-0 gap-1",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onModeChange("timeline")}
        className={tabClass(mode === "timeline")}
        title="Trace"
      >
        <AlignLeft className="h-3 w-3 shrink-0" />
        <span className="truncate">Trace</span>
      </button>
      <button
        type="button"
        onClick={() => onModeChange("chat")}
        className={tabClass(mode === "chat")}
        title="Chat view"
      >
        <MessageSquare className="h-3 w-3 shrink-0" />
        <span className="truncate">Chat</span>
      </button>
      <button
        type="button"
        onClick={() => onModeChange("raw")}
        className={tabClass(mode === "raw")}
        title="Raw JSON"
      >
        <Code2 className="h-3 w-3 shrink-0" />
        <span className="truncate">Raw</span>
      </button>
      {showToolsTab ? (
        <button
          type="button"
          onClick={() => onModeChange("tools")}
          className={tabClass(mode === "tools")}
          title="Expected vs actual tool calls"
          data-testid="trace-viewer-tools-tab"
        >
          <GitCompare className="h-3 w-3 shrink-0" />
          <span className="truncate">Tools</span>
        </button>
      ) : null}
    </div>
  );
}

/**
 * Full-width Trace / Chat / Raw strip used in {@link ChatTabV2} and compare cards —
 * matches `bg-background/80 … border-b` + `px-4 py-2.5` + {@link TraceViewModeTabs} `layout="fullWidth"`.
 */
export function ChatTraceViewModeHeaderBar({
  mode,
  onModeChange,
  className,
}: {
  mode: TraceViewMode;
  onModeChange: (mode: TraceViewMode) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-background/80 backdrop-blur-sm border-b border-border shrink-0",
        className,
      )}
    >
      <div className="px-4 py-2.5">
        <TraceViewModeTabs
          layout="fullWidth"
          mode={mode}
          onModeChange={onModeChange}
          showToolsTab={false}
        />
      </div>
    </div>
  );
}
