import {
  AlignLeft,
  Code2,
  Hammer,
  ListChecks,
  MessageSquare,
  Monitor,
} from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { cn } from "@/lib/utils";
import { standardEventProps } from "@/lib/PosthogUtils";

export type TraceViewMode = "timeline" | "chat" | "raw" | "tools";

/**
 * Mode switcher for {@link TraceViewer} — shared with compare playground so Runs / CI / compare
 * use identical controls.
 *
 * The eval-only "App" tab (PR 7) and "Steps" tab (step-aligned replay) are
 * intentionally NOT part of `TraceViewMode`: the chat / playground / compare
 * surfaces that reuse this switcher never show them, so each rides its own
 * `*Active` / `onSelect*` props instead of widening the shared union (which
 * every consumer's narrower state would then have to guard).
 */
export function TraceViewModeTabs({
  mode,
  onModeChange,
  showToolsTab,
  showStepsTab = false,
  stepsActive = false,
  onSelectSteps,
  showBrowserTab = false,
  browserActive = false,
  onSelectBrowser,
  layout = "default",
  appearance = "default",
  className,
}: {
  mode: TraceViewMode;
  onModeChange: (mode: TraceViewMode) => void;
  showToolsTab: boolean;
  /** Show the step-aligned "Steps" tab when the case is authored as steps
   *  (interact/assert) — the replay mirror of the left-pane step list. */
  showStepsTab?: boolean;
  /** Highlight the Steps tab (its active mode lives outside the shared
   *  `TraceViewMode` union, in the trace viewer's local state). */
  stepsActive?: boolean;
  /** Fired when the Steps tab is selected. */
  onSelectSteps?: () => void;
  /** PR 7: show the "App" tab when the iteration has browser-rendered
   *  MCP App artifacts (render observations / Computer Use steps). */
  showBrowserTab?: boolean;
  /** PR 7: highlight the App tab (the active mode lives outside the shared
   *  `TraceViewMode` union, in the trace viewer's local state). */
  browserActive?: boolean;
  /** PR 7: fired when the App tab is selected. */
  onSelectBrowser?: () => void;
  /** `fullWidth`: equal-width segments across the container (e.g. chat trace header). */
  layout?: "default" | "fullWidth";
  /** `segment`: softer raised-pill active state for dense preview headers. */
  appearance?: "default" | "segment";
  className?: string;
}) {
  const fullWidth = layout === "fullWidth";
  const segment = appearance === "segment";
  const posthog = usePostHog();
  // When the App or Steps tab is active no standard tab is highlighted.
  const standardActive = (m: TraceViewMode) =>
    !browserActive && !stepsActive && mode === m;

  const handleModeChange = (nextMode: TraceViewMode) => {
    posthog.capture("trace_view_mode_changed", {
      ...standardEventProps("trace_view_mode_tabs"),
      mode: nextMode,
    });
    onModeChange(nextMode);
  };

  const tabClass = (active: boolean) =>
    cn(
      "inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
      fullWidth && "min-h-8 flex-1 basis-0 justify-center",
      segment
        ? active
          ? "bg-background font-medium text-foreground ring-1 ring-inset ring-border/60"
          : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
        : active
        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
        : "text-muted-foreground hover:text-foreground"
    );

  const stepsTab = showStepsTab ? (
    <button
      key="steps"
      type="button"
      onClick={() => {
        posthog.capture("trace_view_mode_changed", {
          ...standardEventProps("trace_view_mode_tabs"),
          mode: "steps",
        });
        onSelectSteps?.();
      }}
      className={tabClass(stepsActive)}
      title="Step-by-step replay (mirrors the authored steps)"
      data-testid="trace-viewer-steps-tab"
    >
      <ListChecks className="h-3 w-3 shrink-0" />
      <span className="truncate">Steps</span>
    </button>
  ) : null;
  const chatTab = (
    <button
      key="chat"
      type="button"
      onClick={() => handleModeChange("chat")}
      className={tabClass(standardActive("chat"))}
      title="Chat view"
    >
      <MessageSquare className="h-3 w-3 shrink-0" />
      <span className="truncate">Chat</span>
    </button>
  );
  const toolsTab = showToolsTab ? (
    <button
      key="tools"
      type="button"
      onClick={() => handleModeChange("tools")}
      className={tabClass(standardActive("tools"))}
      title="Expected vs actual tool calls"
      data-testid="trace-viewer-tools-tab"
    >
      <Hammer className="h-3 w-3 shrink-0" />
      <span className="truncate">Tool Calls</span>
    </button>
  ) : null;
  const timelineTab = (
    <button
      key="timeline"
      type="button"
      onClick={() => handleModeChange("timeline")}
      className={tabClass(standardActive("timeline"))}
      title="Trace"
    >
      <AlignLeft className="h-3 w-3 shrink-0" />
      <span className="truncate">Trace</span>
    </button>
  );
  const browserTab = showBrowserTab ? (
    <button
      key="browser"
      type="button"
      onClick={() => {
        posthog.capture("trace_view_mode_changed", {
          ...standardEventProps("trace_view_mode_tabs"),
          mode: "browser",
        });
        onSelectBrowser?.();
      }}
      className={tabClass(browserActive)}
      title="MCP App replay, render checks & Computer Use"
      data-testid="trace-viewer-browser-tab"
    >
      <Monitor className="h-3 w-3 shrink-0" />
      <span className="truncate">App</span>
    </button>
  ) : null;
  const rawTab = (
    <button
      key="raw"
      type="button"
      onClick={() => handleModeChange("raw")}
      className={tabClass(standardActive("raw"))}
      title="Raw JSON"
    >
      <Code2 className="h-3 w-3 shrink-0" />
      <span className="truncate">Raw</span>
    </button>
  );

  // Evals (default layout) lead with Steps (when present) then Chat — Steps is
  // the step-aligned replay default for authored-step cases. Chat / playground /
  // compare surfaces (fullWidth) never show Steps and keep Trace-first ordering.
  const tabs = fullWidth
    ? [toolsTab, timelineTab, chatTab, browserTab, rawTab]
    : [stepsTab, chatTab, toolsTab, timelineTab, browserTab, rawTab];

  return (
    <div
      className={cn(
        "flex items-center p-0.5",
        segment
          ? "rounded-lg border border-border/50 bg-muted/30"
          : "rounded-md border border-border/40 bg-background",
        fullWidth ? "w-full min-w-0 gap-0.5" : "shrink-0 gap-0.5",
        className
      )}
    >
      {tabs}
    </div>
  );
}

/**
 * Full-width Trace / Chat / Raw strip used in {@link ChatTabV2} and compare cards —
 * matches `bg-background/80 … border-b` + `px-4 py-2.5` + {@link TraceViewModeTabs} `layout="fullWidth"`.
 *
 * The optional App tab rides the same out-of-union props as
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
        className
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
