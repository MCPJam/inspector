import type { ReactNode } from "react";
import {
  AlignLeft,
  ArrowLeft,
  Code2,
  MessageSquare,
  Monitor,
} from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { cn } from "@/lib/utils";
import { standardEventProps } from "@/lib/PosthogUtils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { ClientContextHeader } from "@/components/shared/ClientContextHeader";
import type { TraceViewMode } from "@/components/evals/trace-view-mode-tabs";
import type { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import type { ProjectHostContextDraft } from "@/lib/client-config";

/**
 * Single-strip playground center header. Replaces the two stacked strips
 * (`ClientContextHeader` + `ChatTraceViewModeHeaderBar`) with a four-pill row
 * `[ Host ] [ Chat ] [ Trace ] [ Raw ]`. Clicking `Host` swaps the strip to
 * the `ClientContextHeader` controls plus a back pill; the other three switch
 * the trace view mode as before. In multi-model mode (when trace tabs are
 * suppressed), the strip falls back to `ClientContextHeader` directly, matching
 * the prior behavior — there's nothing to swap to.
 *
 * The pill styling mirrors `TraceViewModeTabs` so the row reads as one
 * segmented control, but we render the buttons inline here so we can add a
 * non-trace `Host` pill without leaking `"host"` into the shared
 * `TraceViewMode` enum (which is also consumed by Runs / CI / compare).
 */
interface Props {
  showTraceTabs: boolean;
  mode: TraceViewMode;
  onModeChange: (m: TraceViewMode) => void;
  headerView: "tabs" | "host";
  onHeaderViewChange: (v: "tabs" | "host") => void;
  activeProjectId: string | null;
  onSaveHostContext?: (
    projectId: string,
    ctx: ProjectHostContextDraft,
  ) => Promise<void>;
  protocol: UIType | null;
  isMultiModelLayoutMode: boolean;
  trailing?: ReactNode;
}

const PILL_BASE =
  "inline-flex min-w-0 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors min-h-8 flex-1 basis-0";

function pillClass(active: boolean) {
  return cn(
    PILL_BASE,
    active
      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
      : "text-muted-foreground hover:text-foreground",
  );
}

export function PlaygroundCenterHeaderBar({
  showTraceTabs,
  mode,
  onModeChange,
  headerView,
  onHeaderViewChange,
  activeProjectId,
  onSaveHostContext,
  protocol,
  isMultiModelLayoutMode,
  trailing,
}: Props) {
  const posthog = usePostHog();

  const handleTraceMode = (next: TraceViewMode) => {
    if (next === "tools") return;
    posthog.capture("trace_view_mode_changed", {
      ...standardEventProps("playground_center_header"),
      mode: next,
    });
    onModeChange(next);
  };

  const inHostView = showTraceTabs && headerView === "host";
  const showHostInline = !showTraceTabs || inHostView;

  return (
    <div
      className={cn(
        "@container/playground-header flex h-11 min-w-0 w-full shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground",
        isMultiModelLayoutMode ? "bg-background" : "bg-background/50",
      )}
      data-testid="playground-main-header"
    >
      {inHostView ? (
        <div className="shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onHeaderViewChange("tabs")}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border/40 bg-background px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                data-testid="playground-header-host-back"
              >
                <ArrowLeft className="h-3 w-3" />
                <span>Back</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Back to chat tabs</p>
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      {showHostInline ? (
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden">
          <ClientContextHeader
            activeProjectId={activeProjectId}
            onSaveHostContext={onSaveHostContext}
            protocol={protocol}
            showThemeToggle
          />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <div className="flex w-full min-w-0 items-center gap-0.5 rounded-md border border-border/40 bg-background p-0.5">
            <button
              type="button"
              onClick={() => onHeaderViewChange("host")}
              className={pillClass(false)}
              title="Client context"
              data-testid="playground-header-host-tab"
            >
              <Monitor className="h-3 w-3 shrink-0" />
              <span className="truncate">Client</span>
            </button>
            <button
              type="button"
              onClick={() => handleTraceMode("chat")}
              className={pillClass(mode === "chat")}
              title="Chat view"
            >
              <MessageSquare className="h-3 w-3 shrink-0" />
              <span className="truncate">Chat</span>
            </button>
            <button
              type="button"
              onClick={() => handleTraceMode("timeline")}
              className={pillClass(mode === "timeline")}
              title="Trace"
            >
              <AlignLeft className="h-3 w-3 shrink-0" />
              <span className="truncate">Trace</span>
            </button>
            <button
              type="button"
              onClick={() => handleTraceMode("raw")}
              className={pillClass(mode === "raw")}
              title="Raw JSON"
            >
              <Code2 className="h-3 w-3 shrink-0" />
              <span className="truncate">Raw</span>
            </button>
          </div>
        </div>
      )}

      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}
