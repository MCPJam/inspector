import { AlignLeft, Code2, MessageSquare, Monitor, Wrench } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { cn } from "@/lib/utils";
import { standardEventProps } from "@/lib/PosthogUtils";

export type TraceViewMode = "timeline" | "chat" | "raw" | "tools";

/**
 * Mode switcher for {@link TraceViewer} — shared with compare playground so Runs / CI / compare
 * use identical controls.
 *
 * The eval-only "Browser" tab (PR 7) is intentionally NOT part of `TraceViewMode`:
 * the chat / playground / compare surfaces that reuse this switcher never show it,
 * so it rides its own `browserActive` / `onSelectBrowser` props instead of widening
 * the shared union (which every consumer's narrower state would then have to guard).
 */
export function TraceViewModeTabs({
  mode,
  onModeChange,
  showToolsTab,
  showBrowserTab = false,
  browserActive = false,
  onSelectBrowser,
  layout = "default",
  className,
}: {
  mode: TraceViewMode;
  onModeChange: (mode: TraceViewMode) => void;
  showToolsTab: boolean;
  /** PR 7: show the "Browser" tab when the iteration has browser-rendered
   *  MCP App artifacts (render observations / Computer Use steps). */
  showBrowserTab?: boolean;
  /** PR 7: highlight the Browser tab (the active mode lives outside the shared
   *  `TraceViewMode` union, in the trace viewer's local state). */
  browserActive?: boolean;
  /** PR 7: fired when the Browser tab is selected. */
  onSelectBrowser?: () => void;
  /** `fullWidth`: equal-width segments across the container (e.g. chat trace header). */
  layout?: "default" | "fullWidth";
  className?: string;
}) {
  const fullWidth = layout === "fullWidth";
  const posthog = usePostHog();
  // When the Browser tab is active no standard tab is highlighted.
  const standardActive = (m: TraceViewMode) => !browserActive && mode === m;

  const handleModeChange = (nextMode: TraceViewMode) => {
    posthog.capture("trace_view_mode_changed", {
      ...standardEventProps("trace_view_mode_tabs"),
      mode: nextMode,
    });
    onModeChange(nextMode);
  };

  const tabClass = (active: boolean) =>
    cn(
      "inline-flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
      fullWidth && "min-h-8 flex-1 basis-0 justify-center",
      active
        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
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
      {showToolsTab ? (
        <button
          type="button"
          onClick={() => handleModeChange("tools")}
          className={tabClass(standardActive("tools"))}
          title="Expected vs actual tool calls"
          data-testid="trace-viewer-tools-tab"
        >
          <Wrench className="h-3 w-3 shrink-0" />
          <span className="truncate">Results</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => handleModeChange("timeline")}
        className={tabClass(standardActive("timeline"))}
        title="Trace"
      >
        <AlignLeft className="h-3 w-3 shrink-0" />
        <span className="truncate">Trace</span>
      </button>
      <button
        type="button"
        onClick={() => handleModeChange("chat")}
        className={tabClass(standardActive("chat"))}
        title="Chat view"
      >
        <MessageSquare className="h-3 w-3 shrink-0" />
        <span className="truncate">Chat</span>
      </button>
      {showBrowserTab ? (
        <button
          type="button"
          onClick={() => {
            posthog.capture("trace_view_mode_changed", {
              ...standardEventProps("trace_view_mode_tabs"),
              mode: "browser",
            });
            onSelectBrowser?.();
          }}
          className={tabClass(browserActive)}
          title="Browser-rendered widgets & Computer Use"
          data-testid="trace-viewer-browser-tab"
        >
          <Monitor className="h-3 w-3 shrink-0" />
          <span className="truncate">Browser</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => handleModeChange("raw")}
        className={tabClass(standardActive("raw"))}
        title="Raw JSON"
      >
        <Code2 className="h-3 w-3 shrink-0" />
        <span className="truncate">Raw</span>
      </button>
    </div>
  );
}

/**
 * Full-width Trace / Chat / Raw strip used in {@link ChatTabV2} and compare cards —
 * matches `bg-background/80 … border-b` + `px-4 py-2.5` + {@link TraceViewModeTabs} `layout="fullWidth"`.
 *
 * The optional Browser tab rides the same out-of-union props as
 * {@link TraceViewModeTabs} (see the module doc): the Sessions viewer shows it
 * when a session carries browser-rendered MCP App artifacts; chat / compare
 * surfaces omit it.
 */
export function ChatTraceViewModeHeaderBar({
  mode,
  onModeChange,
  className,
  showBrowserTab = false,
  browserActive = false,
  onSelectBrowser,
}: {
  mode: TraceViewMode;
  onModeChange: (mode: TraceViewMode) => void;
  className?: string;
  showBrowserTab?: boolean;
  browserActive?: boolean;
  onSelectBrowser?: () => void;
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
          showBrowserTab={showBrowserTab}
          browserActive={browserActive}
          onSelectBrowser={onSelectBrowser}
        />
      </div>
    </div>
  );
}
